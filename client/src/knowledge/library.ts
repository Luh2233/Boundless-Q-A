import { create } from 'zustand'
import { useStore } from '../store'
import type { Card, FollowUp } from '../types'
import { getConfig, summarizeKnowledge, type ModelMode } from '../api'

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
  saveError: string | null
  setOpen: (open: boolean) => void
  select: (id: string | null) => void
  collect: (cardId: string, branch: boolean) => void
  update: (id: string, change: (topic: Topic) => Topic) => boolean
  remove: (id: string) => void
}

function save(topics: Topic[]) {
  try {
    localStorage.setItem(storageKey, JSON.stringify(topics))
    useLibrary.setState({ topics, saveError: null })
    return true
  } catch {
    const message = '知识库保存失败，请检查浏览器存储空间。'
    if (useLibrary.getState().open) useLibrary.setState({ saveError: message })
    else useStore.getState().setToast(message, 'error')
    return false
  }
}

export const useLibrary = create<Library>((set, get) => ({
  topics: readTopics(),
  open: false,
  current: null,
  saveError: null,
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
    if (cards.some(card => card.status === 'streaming' || card.status === 'loading' || card.followups.some(entry => entry.pending))) {
      state.setToast('请等讲解和追问生成完毕后再收藏。')
      return
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
    void generateTopic(topic, { automatic: true, expectedMode: 'api' }, cards.filter(card => card.status === 'done').map(card => card.id))
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
  queued: string[]
  pending: Record<string, 'question' | 'points'>
  errors: Record<string, string>
}
export const useGeneration = create<Generation>(() => ({ queued: [], pending: {}, errors: {} }))

interface GenerationRequest { automatic?: boolean; expectedMode?: ModelMode }

export async function generateTopic(topic: Topic, request: GenerationRequest, ids?: string[]) {
  const eligible = ids && new Set(ids)
  const state = useGeneration.getState()
  const nodes = topic.nodes.filter(node => {
    const key = generationKey(topic.id, node.id)
    return (!eligible || eligible.has(node.id)) && node.content.trim() && !node.points.trim() &&
      !state.queued.includes(key) && !state.pending[key]
  })
  const keys = new Set(nodes.map(node => generationKey(topic.id, node.id)))
  useGeneration.setState(state => ({ queued: [...state.queued, ...keys] }))
  try {
    if (request.automatic && (await getConfig().catch(() => null))?.mode !== 'api') return
    for (const node of nodes) {
      const current = useLibrary.getState().topics.find(item => item.id === topic.id)
      if (!current) return
      const entry = current.nodes.find(item => item.id === node.id)
      if (entry && !entry.points.trim()) {
        const status = await generatePoints(current, entry, false, request)
        if (status === 401 || status === 403 || status === 409 || status === 429 ||
            (request.expectedMode === 'chatgpt' && (status === 502 || status === 503 || status === 504))) return
      }
      const key = generationKey(topic.id, node.id)
      useGeneration.setState(state => ({ queued: state.queued.filter(item => item !== key) }))
    }
  } finally {
    useGeneration.setState(state => ({ queued: state.queued.filter(key => !keys.has(key)) }))
  }
}

export function generationKey(topicId: string, nodeId: string) {
  return topicId + ':' + nodeId
}

const plainQuestion = (question: string) => question.trim().replace(/^#{1,6}\s+/, '').trim()

function completeOriginQuestion(node: KnowledgeNode, parent?: KnowledgeNode) {
  const question = plainQuestion(node.question)
  if (!/^(?:起源|由来)是什么[？?。]?$/.test(question)) return
  const parentQuestion = node.parentTitle || parent?.question || node.source?.match(/^卡片「(.+)」$/)?.[1] || ''
  const subject = plainQuestion(parentQuestion).match(/^([\p{L}\p{N}]{1,24})(?:有几种|有哪些种类|分为哪几类)[？?。]?$/u)?.[1]
  if (!subject) return
  return `${subject}的${question.replace(/[？?。]$/, '')}？`
}

export function needsQuestionContext(node: KnowledgeNode, parent?: KnowledgeNode) {
  if (node.reviewQuestion || completeOriginQuestion(node, parent)) return false
  const question = plainQuestion(node.question)
  const missingSubject = /^(?:起源|来源|由来|含义|定义|原理|原因|目的|作用|区别|影响|条件|过程|特点)(?:是什么|有哪些|有哪些呢|在哪(?:里)?)[？?。]?$/.test(question)
  return missingSubject || /^(?:(?:请问|那么)[，,\s]*)?(?:这(?:个|里|段(?:话|文字)?|句话|些)?|那(?:个|段|句话)?|它|其)[\s，,]*(?:是|指|有什么|怎么|如何|为什么|为何|啥|什么意思|又)/.test(question)
}

export function knowledgeQuestion(node: KnowledgeNode, parent?: KnowledgeNode) {
  return node.reviewQuestion || completeOriginQuestion(node, parent) || plainQuestion(node.question)
}

export function knowledgeTopicTitle(topic: Topic) {
  const root = topic.nodes[0]
  return root && topic.title === root.question ? knowledgeQuestion(root) : topic.title
}

export async function generatePoints(topic: Topic, node: KnowledgeNode, questionOnly = false, request?: GenerationRequest) {
  const key = generationKey(topic.id, node.id)
  if (useGeneration.getState().pending[key]) return
  useGeneration.setState(s => ({ pending: { ...s.pending, [key]: questionOnly ? 'question' : 'points' }, errors: { ...s.errors, [key]: '' } }))
  try {
    const parent = topic.nodes.find(item => item.id === node.parentId)
    const { points, reviewQuestion } = await summarizeKnowledge({
      ...node,
      question: knowledgeQuestion(node, parent),
      parentTitle: node.parentTitle || parent?.question,
      parentContent: node.parentContent || parent?.content,
      rewriteQuestion: needsQuestionContext(node, parent),
      questionOnly,
      ...request,
    })
    useLibrary.getState().update(topic.id, item => ({
      ...item, nodes: item.nodes.map(current => current.id === node.id ? {
        ...current,
        points: !questionOnly && current.points === node.points ? points.join('\n') : current.points,
        reviewQuestion: current.reviewQuestion || reviewQuestion,
      } : current),
    }))
  } catch (error) {
    useGeneration.setState(s => ({ errors: { ...s.errors, [key]: (error as Error).message } }))
    return (error as Error & { status?: number }).status
  } finally {
    useGeneration.setState(s => {
      const pending = { ...s.pending }
      delete pending[key]
      return { pending }
    })
  }
}
