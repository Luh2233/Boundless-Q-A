import { create } from 'zustand'
import { useStore } from '../store'
import type { Card, FollowUp } from '../types'
import { summarizeKnowledge } from '../api'

export interface KnowledgeNode {
  id: string
  parentId: string | null
  question: string
  parentTitle?: string
  parentContent?: string
  reviewQuestion?: string
  excerpt: string
  content: string
  followups: FollowUp[]
  source: string
  markId: string | null
  ownerCardId: string | null
  points: string
}

interface Topic {
  id: string
  title: string
  docId: string | null
  conversationId: string
  nodes: KnowledgeNode[]
}

const storageKey = 'wujie-wenda:knowledge'
const readTopics = (): Topic[] => {
  try { return JSON.parse(localStorage.getItem(storageKey) || '[]') } catch { return [] }
}

interface Library {
  topics: Topic[]
  open: boolean
  current: string | null
  setOpen: (open: boolean) => void
  select: (id: string | null) => void
  collect: (cardId: string, branch: boolean) => void
  update: (id: string, change: (topic: Topic) => Topic) => boolean
  remove: (id: string) => void
}

function save(topics: Topic[]) {
  try {
    localStorage.setItem(storageKey, JSON.stringify(topics))
    useLibrary.setState({ topics })
    return true
  } catch {
    useStore.getState().setToast('知识库保存失败，请检查浏览器存储空间。', 'error')
    return false
  }
}

export const useLibrary = create<Library>((set, get) => ({
  topics: readTopics(),
  open: false,
  current: null,
  setOpen: open => set({ open }),
  select: current => set({ current }),
  collect: (cardId, branch) => {
    const state = useStore.getState()
    const root = state.cards[cardId]
    if (root?.status !== 'done') return
    const children = new Map<string, Card[]>()
    for (const card of Object.values(state.cards)) {
      if (!card.parentId) continue
      const siblings = children.get(card.parentId) ?? []
      siblings.push(card)
      children.set(card.parentId, siblings)
    }
    const cards = [root]
    const seen = new Set([root.id])
    if (branch) for (const card of cards) {
      for (const child of children.get(card.id) ?? []) {
        if (seen.has(child.id)) continue
        seen.add(child.id)
        cards.push(child)
      }
    }
    const nodes = cards.map(card => {
      const mark = card.sourceMarkId ? state.marks[card.sourceMarkId] : undefined
      const pages = mark?.pages?.map(page => page.page).join('、')
      const parent = card.parentId ? state.cards[card.parentId] : undefined
      return {
        id: card.id,
        parentId: card.id === root.id ? null : card.parentId,
        question: card.question || (!mark ? card.sourceText : '这段文字是什么意思？') || card.title,
        parentTitle: parent?.title,
        parentContent: parent?.content.slice(0, 4500),
        excerpt: mark?.text ?? '',
        content: card.content,
        followups: card.followups.map(({ q, a }) => ({ q, a })),
        source: pages ? `${state.doc?.title ?? 'PDF'} · 第 ${pages} 页`
          : parent ? `卡片「${parent.title}」` : state.doc?.title ?? '问答画布',
        markId: mark?.id ?? null,
        ownerCardId: mark?.ownerCardId ?? null,
        points: '',
      }
    })
    const topic = { id: crypto.randomUUID(), title: nodes[0].question || root.title || root.sourceText, docId: state.doc?.id ?? null, conversationId: state.conversationId, nodes }
    if (!save([topic, ...get().topics])) return
    set({ open: true, current: topic.id })
    void generateTopic(topic, cards.filter(card => card.status === 'done').map(card => card.id))
  },
  update: (id, change) => {
    const topics = get().topics
    return topics.some(topic => topic.id === id) && save(topics.map(topic => topic.id === id ? change(topic) : topic))
  },
  remove: id => {
    if (save(get().topics.filter(topic => topic.id !== id))) set({ current: null })
  },
}))

interface Generation {
  pending: string[]
  errors: Record<string, string>
}
export const useGeneration = create<Generation>(() => ({ pending: [], errors: {} }))

async function generateTopic(topic: Topic, ids: string[]) {
  for (const node of topic.nodes) {
    if (!ids.includes(node.id) || !node.content.trim()) continue
    if (!useLibrary.getState().topics.some(item => item.id === topic.id)) return
    // Stop the batch on a service failure. Nodes can be retried individually.
    if (!await generatePoints(topic, node)) return
  }
}

export function generationKey(topicId: string, nodeId: string) {
  return topicId + ':' + nodeId
}

const plainQuestion = (question: string) => question.trim().replace(/^#{1,6}\s+/, '').trim()

export function needsQuestionContext(node: KnowledgeNode) {
  return !node.reviewQuestion &&
    /^(?:(?:请问|那么)[，,\s]*)?(?:这(?:个|里|段(?:话|文字)?|句话|些)?|那(?:个|段|句话)?|它|其)[\s，,]*(?:是|指|有什么|怎么|如何|为什么|为何|啥|什么意思|又)/.test(plainQuestion(node.question))
}

export function knowledgeQuestion(node: KnowledgeNode) {
  return node.reviewQuestion || plainQuestion(node.question)
}

export async function generatePoints(topic: Topic, node: KnowledgeNode, questionOnly = false) {
  const key = generationKey(topic.id, node.id)
  if (useGeneration.getState().pending.includes(key)) return false
  useGeneration.setState(s => ({ pending: [...s.pending, key], errors: { ...s.errors, [key]: '' } }))
  try {
    const parent = topic.nodes.find(item => item.id === node.parentId)
    const { points, reviewQuestion } = await summarizeKnowledge({
      ...node,
      question: plainQuestion(node.question),
      parentTitle: node.parentTitle || parent?.question,
      parentContent: node.parentContent || parent?.content,
      rewriteQuestion: needsQuestionContext(node),
      questionOnly,
    })
    return useLibrary.getState().update(topic.id, item => ({
      ...item, nodes: item.nodes.map(current => current.id === node.id ? {
        ...current,
        points: !questionOnly && current.points === node.points ? points.join('\n') : current.points,
        reviewQuestion: current.reviewQuestion || reviewQuestion,
      } : current),
    }))
  } catch (error) {
    useGeneration.setState(s => ({ errors: { ...s.errors, [key]: (error as Error).message } }))
    return false
  } finally {
    useGeneration.setState(s => ({ pending: s.pending.filter(item => item !== key) }))
  }
}

export async function openKnowledgeSource(topic: Topic, node: KnowledgeNode) {
  const state = useStore.getState()
  if (state.loading) return '正在打开文档，请稍候。'
  if (topic.docId && state.doc?.id !== topic.docId) await state.openDoc(topic.docId)
  if (!topic.docId && (state.doc || state.conversationId !== topic.conversationId)) {
    if (!state.conversations.some(item => item.id === topic.conversationId)) {
      return '原对话已删除，仍可查看知识快照。'
    }
    state.switchConversation(topic.conversationId)
  }
  const current = useStore.getState()
  if (current.doc?.id !== (topic.docId ?? undefined) || (!topic.docId && current.conversationId !== topic.conversationId)) return '无法打开原出处，仍可查看知识快照。'
  if (!current.cards[node.id] && !(node.ownerCardId && current.cards[node.ownerCardId])) {
    return '原卡片已删除，仍可查看知识快照。'
  }
  useLibrary.getState().setOpen(false)
  const mark = node.markId ? current.marks[node.markId] : undefined
  const pageNumber = mark?.pages?.[0]?.page
  const workspaceMatches = () => {
    const state = useStore.getState()
    return topic.docId ? state.doc?.id === topic.docId
      : !state.doc && state.conversationId === topic.conversationId
  }
  const locate = (attempts: number) => {
    if (!workspaceMatches()) return
    if (mark && document.querySelector(`[data-mark-anchor="${mark.id}"]`)) {
      current.locateMark(mark.id)
      return
    }
    if (attempts > 0 && mark) {
      window.setTimeout(() => locate(attempts - 1), 50)
      return
    }
    if (pageNumber) {
      const page = document.querySelector<HTMLElement>(`[data-page-index="${pageNumber}"]`)
      const reader = page?.closest<HTMLElement>('.pdf-pages')
      if (reader && page) {
        reader.scrollTop = page.offsetTop - 12
        current.fitDoc()
        return
      }
    }
    current.locateCard(current.cards[node.id] ? node.id : node.ownerCardId!)
  }
  requestAnimationFrame(() => requestAnimationFrame(() => locate(16)))
}
