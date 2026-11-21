import { create } from 'zustand'
import type { Card, Mark, Viewport, DocMeta, SavedState } from './types'
import * as api from './api'
import { clamp, screenToWorld } from './geom'
import { unwrapMark, wrapRangeWithMark } from './marks/wrapRange'
import { buildPdfMarkFromRange } from './marks/pdfSelection'
import type { AnchorRect } from './marks/pdfSelection'
import { contextAround } from './lib/text'

/* pdf.js 的文档代理放在模块级（不可序列化，不入 store） */
export const pdfRef: { pdf: any } = { pdf: null }

export const DOC_WORLD_WIDTH = 820
const PDF_TOOLBAR_HEIGHT = 54
export const PDF_MIN_HEIGHT = 240
export const PDF_MAX_HEIGHT = 4000
export const pdfViewerHeight = (node: SavedState['pdfNode'], ratio: number, gutter = 24) =>
  node.height ?? PDF_TOOLBAR_HEIGHT + (node.width - gutter) * ratio + 24
const PDF_VIEWER_WIDTH = DOC_WORLD_WIDTH + 24
const CARD_DEFAULT_WIDTH = 420

let uidCounter = 0
const nid = () => `m${Date.now().toString(36)}${(uidCounter++).toString(36)}`

export type SelectionOwner =
  | { type: 'pdf'; page: number }
  | { type: 'card'; cardId: string }

export interface SelectionPayload {
  text: string
  owner: SelectionOwner
  range: Range
  screen: { x: number; y: number }
}

interface Store {
  loading: boolean
  loadMsg: string
  doc: DocMeta | null
  viewport: Viewport
  pdfNode: SavedState['pdfNode']
  pdfPageRatio: number
  conversationId: string
  conversations: Conversation[]
  cards: Record<string, Card>
  marks: Record<string, Mark>
  cardSeq: number
  edgesVersion: number
  hover: { cardId?: string; markId?: string } | null
  selectionToolbar: SelectionPayload | null
  toast: { msg: string; kind: 'info' | 'error' } | null
  settingsOpen: boolean
  helpOpen: boolean
  cardMenuFor: string | null
  activeCardId: string | null

  setLoading: (v: boolean, msg?: string) => void
  setToast: (msg: string, kind?: 'info' | 'error') => void
  setViewport: (v: Viewport) => void
  zoomAt: (clientX: number, clientY: number, factor: number) => void
  zoomTo: (scale: number) => void
  panBy: (dx: number, dy: number) => void
  fitDoc: () => void
  locateCard: (cardId: string) => void
  locateMark: (markId: string) => void

  importFile: (file: File) => Promise<void>
  openDoc: (id: string, titleOverride?: string) => Promise<void>
  closeDoc: (save?: boolean) => void

  switchConversation: (id?: string) => void
  deleteConversation: (id: string) => void
  resizePdf: (width: number) => void
  resizePdfHeight: (height: number, fixedBottom?: number) => void
  savePdfScroll: (scrollTop: number) => void
  movePdfNode: (x: number, y: number) => void
  moveCard: (id: string, x: number, y: number) => void
  resizeCard: (id: string, size: { width?: number; height?: number; fixedRight?: number; fixedBottom?: number }) => void
  setCardFontScale: (id: string, delta: number) => void
  setHover: (h: { cardId?: string; markId?: string } | null) => void
  setCardMenuFor: (id: string | null) => void
  bumpEdges: () => void

  ask: (question: string) => Promise<void>
  explainFromSelection: (question: string) => Promise<void>
  followup: (cardId: string, question: string) => Promise<void>
  deleteCard: (id: string, onClose?: (branch: ReadonlyMap<string, number>) => void) => void

  setSelectionToolbar: (p: SelectionPayload | null) => void
  setSettingsOpen: (v: boolean) => void
  setHelpOpen: (v: boolean) => void
}

/* ---------- 流式增量缓冲（rAF 批量写入，避免每 token 一次渲染） ---------- */
const pendingContent: Record<string, string> = {}
const pendingFollowup: Record<string, string> = {}
let flushRaf = 0

function scheduleFlush() {
  if (flushRaf) return
  flushRaf = requestAnimationFrame(() => {
    flushRaf = 0
    const st = useStore.getState()
    const cards = { ...st.cards }
    let changed = false
    for (const [cardId, add] of Object.entries(pendingContent)) {
      delete pendingContent[cardId]
      if (!add) continue
      const c = cards[cardId]
      if (!c) continue
      // 只追加内容，不触碰 status：晚于「done」落定的 rAF 不能把完成态改回流式
      cards[cardId] = { ...c, content: c.content + add }
      changed = true
    }
    for (const [key, add] of Object.entries(pendingFollowup)) {
      delete pendingFollowup[key]
      if (!add) continue
      const [cardId, idxStr] = key.split('::')
      const c = cards[cardId]
      if (!c) continue
      const idx = +idxStr
      const followups = c.followups.slice()
      const f = followups[idx]
      if (f) followups[idx] = { ...f, a: f.a + add }
      cards[cardId] = { ...c, followups }
      changed = true
    }
    if (changed) useStore.setState({ cards, edgesVersion: st.edgesVersion + 1 })
  })
}

/* ---------- 持久化（防抖 + 页面隐藏/关闭时立即冲刷） ---------- */
const workspaceKey = 'wujie-wenda:question-canvas'
const conversationsKey = 'wujie-wenda:conversations'
const activeConversationKey = 'wujie-wenda:active-conversation'
interface Conversation { id: string; title: string }
const conversationKey = (id: string) => id === 'original' ? workspaceKey : `${workspaceKey}:${id}`

function loadConversations(): Conversation[] {
  try {
    const saved = localStorage.getItem(conversationsKey)
    if (saved) return JSON.parse(saved)
    const first: Card | undefined = JSON.parse(localStorage.getItem(workspaceKey) || '{}').cards?.[0]
    return first ? [{ id: 'original', title: first.sourceText }] : []
  } catch { return [] }
}

function initialConversationId() {
  try { return localStorage.getItem(activeConversationKey) || 'original' } catch { return 'original' }
}

const activeRequests = new Map<string, AbortController>()

function cancelRequests(ids?: Set<string>) {
  for (const [key, request] of activeRequests) {
    if (ids && !ids.has(key.split('::')[0])) continue
    request.abort()
    activeRequests.delete(key)
    delete pendingContent[key]
    delete pendingFollowup[key]
  }
}

function restoreCard(card: Card): Card {
  return {
    ...card,
    ...((card.status === 'streaming' || card.status === 'loading' || card.error === '生成已中断，请重新讲解。')
      ? { status: 'error' as const, error: '生成已中断。' }
      : {}),
    followups: card.followups.map(f => f.pending
      ? { ...f, pending: false, a: f.a || '生成已中断。' }
      : f),
  }
}

function restoreWorkspace(id: string) {
  const fallback = { cards: {}, marks: {}, cardSeq: 0, viewport: { x: 0, y: 0, scale: 1 } }
  try {
    const raw = localStorage.getItem(conversationKey(id))
    if (!raw) return fallback
    const saved: SavedState = JSON.parse(raw)
    return {
      cards: Object.fromEntries(saved.cards.map(c => [c.id, restoreCard(c)])),
      marks: Object.fromEntries(saved.marks.map(m => [m.id, { ...m, applied: false }])),
      cardSeq: saved.cardSeq,
      viewport: saved.viewport,
    }
  } catch {
    return fallback
  }
}

let persistTimer: ReturnType<typeof setTimeout> | null = null
function persistNow(keepalive = false) {
  if (persistTimer) { clearTimeout(persistTimer); persistTimer = null }
  const s = useStore.getState()
  const state = {
    viewport: s.viewport,
    pdfNode: s.pdfNode,
    cards: Object.values(s.cards),
    marks: Object.values(s.marks),
    cardSeq: s.cardSeq,
  }
  if (s.doc) {
    const id = s.doc.id
    api.putDocState(id, state, keepalive).catch(() => {
      const current = useStore.getState()
      if (!keepalive && current.doc?.id === id) current.setToast('文档讲解保存失败，请检查服务连接。', 'error')
    })
  } else {
    try { localStorage.setItem(conversationKey(s.conversationId), JSON.stringify(state)) } catch { /* 存储不可用 */ }
  }
}
function touchPersist() {
  if (persistTimer) clearTimeout(persistTimer)
  persistTimer = setTimeout(() => persistNow(false), 900)
}
// 刷新/关窗瞬间把挂起的持久化立即落盘（否则 <900ms 内的删除等操作会丢失）
if (typeof window !== 'undefined') {
  window.addEventListener('pagehide', () => persistNow(true))
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'hidden') persistNow(true)
  })
}

function touch() {
  useStore.setState(s => ({ edgesVersion: s.edgesVersion + 1 }))
  touchPersist()
}

/* ---------- 卡片摆放 ---------- */
function placeCard(st: Store, anchorWorldY: number, x: number): { x: number; y: number } {
  const cards = Object.values(st.cards)
  let y = anchorWorldY
  for (const card of cards.sort((a, b) => a.y - b.y)) {
    if (card.x >= x + CARD_DEFAULT_WIDTH + 24 || card.x + card.width + 24 <= x) continue
    const height = document.querySelector<HTMLElement>(`[data-card-root="${card.id}"]`)?.offsetHeight || 250
    if (y < card.y + height + 24 && y + 450 > card.y) y = card.y + height + 24
  }
  return { x, y }
}

function newCard(st: Store, text: string, place: { x: number; y: number }, parentId: string | null, sourceMarkId: string | null): Card {
  return {
    ...place,
    id: String(st.cardSeq + 1),
    width: CARD_DEFAULT_WIDTH,
    fontScale: 1,
    depth: parentId ? st.cards[parentId].depth + 1 : 1,
    sourceMarkId,
    sourceText: text,
    content: '',
    title: text,
    status: 'streaming',
    memo: null,
    followups: [],
    parentId,
    createdAt: Date.now(),
  }
}

async function generateCard(cardId: string, payload: api.ExplainPayload) {
  const request = new AbortController()
  activeRequests.set(cardId, request)
  await api.streamExplain(payload, {
    onDelta: text => {
      if (request.signal.aborted) return
      pendingContent[cardId] = (pendingContent[cardId] || '') + text
      scheduleFlush()
    },
    onError: error => {
      if (request.signal.aborted) return
      useStore.setState(s => ({
        cards: { ...s.cards, [cardId]: { ...s.cards[cardId], status: 'error', error } },
      }))
    },
  }, memo => {
    if (request.signal.aborted) return
    useStore.setState(s => ({
      cards: { ...s.cards, [cardId]: { ...s.cards[cardId], memo } },
    }))
  }, request.signal)
  if (request.signal.aborted) return
  activeRequests.delete(cardId)
  const tail = pendingContent[cardId] || ''
  delete pendingContent[cardId]
  useStore.setState(s => {
    const card = s.cards[cardId]
    return {
      cards: { ...s.cards, [cardId]: {
        ...card,
        content: card.content + tail,
        status: card.status === 'error' ? 'error' : 'done',
        title: card.sourceMarkId && !card.question ? card.memo?.summary || card.title : card.title,
      } },
    }
  })
  touch()
}

function buildCardsIndex(st: Store) {
  return Object.values(st.cards)
    .filter(c => c.status === 'done' && c.content)
    .map(c => ({
      id: +c.id,
      depth: c.depth,
      summary: c.memo?.summary || c.title || '讲解',
      concepts: c.memo?.concepts || [],
    }))
}

function ancestorChain(st: Store, cardId: string): { id: string; content: string; sourceText: string }[] {
  const out: { id: string; content: string; sourceText: string }[] = []
  let cur: Card | undefined = st.cards[cardId]
  let guard = 0
  while (cur && guard++ < 4) {
    out.unshift({ id: cur.id, content: cur.content, sourceText: cur.sourceText })
    cur = cur.parentId ? st.cards[cur.parentId] : undefined
  }
  return out
}

/* ---------- 视口补间 ---------- */
let tweenRaf = 0
function tweenTo(target: Viewport) {
  if (tweenRaf) cancelAnimationFrame(tweenRaf)
  if (window.matchMedia('(prefers-reduced-motion: reduce)').matches) {
    useStore.setState({ viewport: target })
    touchPersist()
    return
  }
  const from = { ...useStore.getState().viewport }
  const t0 = performance.now()
  const dur = 280
  const step = () => {
    const k = Math.min(1, (performance.now() - t0) / dur)
    const e = 1 - Math.pow(1 - k, 3)
    useStore.setState({
      viewport: {
        x: from.x + (target.x - from.x) * e,
        y: from.y + (target.y - from.y) * e,
        scale: from.scale + (target.scale - from.scale) * e,
      },
    })
    if (k < 1) tweenRaf = requestAnimationFrame(step)
    else { tweenRaf = 0; touchPersist() }
  }
  tweenRaf = requestAnimationFrame(step)
}

export const useStore = create<Store>((set, get) => ({
  loading: false,
  loadMsg: '',
  doc: null,
  conversationId: initialConversationId(),
  conversations: loadConversations(),
  ...restoreWorkspace(initialConversationId()),
  pdfNode: { x: 0, y: 0, width: PDF_VIEWER_WIDTH },
  pdfPageRatio: 1.3,
  edgesVersion: 0,
  hover: null,
  selectionToolbar: null,
  toast: null,
  settingsOpen: false,
  helpOpen: false,
  cardMenuFor: null,
  activeCardId: null,

  setLoading: (v, msg = '') => set({ loading: v, loadMsg: msg }),
  setToast: (msg, kind = 'info') => {
    set({ toast: { msg, kind } })
    setTimeout(() => {
      if (useStore.getState().toast?.msg === msg) set({ toast: null })
    }, 3600)
  },

  setViewport: v => set({ viewport: v }),

  zoomAt: (clientX, clientY, factor) => {
    const st = get()
    const r = document.getElementById('stage')!.getBoundingClientRect()
    const px = clientX - r.left
    const py = clientY - r.top
    const v = st.viewport
    const ns = clamp(v.scale * factor, 0.15, 4)
    const k = ns / v.scale
    set({
      viewport: { x: px - (px - v.x) * k, y: py - (py - v.y) * k, scale: ns },
      selectionToolbar: null,
    })
  },

  zoomTo: scale => {
    const st = get()
    const r = document.getElementById('stage')!.getBoundingClientRect()
    const cx = r.width / 2
    const cy = r.height / 2
    const v = st.viewport
    const ns = clamp(scale, 0.15, 4)
    const k = ns / v.scale
    set({ viewport: { x: cx - (cx - v.x) * k, y: cy - (cy - v.y) * k, scale: ns } })
  },

  panBy: (dx, dy) => set(s => ({ viewport: { ...s.viewport, x: s.viewport.x + dx, y: s.viewport.y + dy }, selectionToolbar: null })),

  fitDoc: () => {
    const { pdfNode, pdfPageRatio } = get()
    const viewerHeight = pdfViewerHeight(pdfNode, pdfPageRatio)
    const r = document.getElementById('stage')!.getBoundingClientRect()
    const scale = clamp(Math.min((r.width - 40) / pdfNode.width, (r.height - 100) / viewerHeight), 0.15, 1.2)
    tweenTo({
      scale,
      x: r.width / 2 - (pdfNode.x + pdfNode.width / 2) * scale,
      y: (r.height + 56) / 2 - (pdfNode.y + viewerHeight / 2) * scale,
    })
  },

  locateCard: cardId => {
    const c = get().cards[cardId]
    if (!c) return
    const r = document.getElementById('stage')!.getBoundingClientRect()
    const scale = Math.min(clamp(get().viewport.scale, 0.4, 1.2), (r.width - 32) / c.width)
    const el = document.querySelector(`[data-card-root="${cardId}"]`)
    const h = el ? el.getBoundingClientRect().height / get().viewport.scale : 300
    tweenTo({
      scale,
      x: r.width / 2 - (c.x + c.width / 2) * scale,
      y: Math.max(76, (r.height - Math.min(h * scale, 450)) / 2 - 22) - c.y * scale,
    })
  },

  locateMark: markId => {
    const el = document.querySelector(`[data-mark-anchor="${markId}"]`)
    const vp = get().viewport
    const r = document.getElementById('stage')!.getBoundingClientRect()
    if (!el) return
    const reader = el.closest<HTMLElement>('.pdf-pages')
    if (reader) {
      const anchor = el.getBoundingClientRect()
      const view = reader.getBoundingClientRect()
      reader.scrollTop += (anchor.top + anchor.height / 2 - view.top - view.height / 2) / vp.scale
      get().fitDoc()
      return
    }
    const b = el.getBoundingClientRect()
    const w = screenToWorld(b.left + b.width / 2, b.top + b.height / 2, vp)
    const scale = clamp(vp.scale, 0.4, 1.4)
    tweenTo({ scale, x: r.width / 2 - w.x * scale, y: r.height / 2 - w.y * scale })
  },

  importFile: async file => {
    if (get().loading) return
    if (!/\.pdf$/i.test(file.name)) { get().setToast('请选择 PDF 文件', 'error'); return }
    const { setLoading, setToast, openDoc: _open } = get()
    try {
      setLoading(true, '正在上传 PDF…')
      const { id, duplicate } = await api.uploadPdf(file)
      if (duplicate) {
        if (get().doc?.id !== id) await _open(id, file.name.replace(/\.pdf$/i, ''))
        if (get().doc?.id === id) setToast('此 PDF 已导入，正在使用原文档和讲解记录。')
        return
      }
      setLoading(true, '正在解析论文…')
      await _open(id, file.name.replace(/\.pdf$/i, ''))
    } catch (e) {
      setToast(`导入失败：${(e as Error).message}`, 'error')
    } finally {
      setLoading(false)
    }
  },

  openDoc: async (id, titleOverride) => {
    const { setLoading, setToast } = get()
    try {
      setLoading(true, '正在加载论文…')
      const res = await fetch(api.getDocFileUrl(id))
      if (!res.ok) throw new Error('无法读取 PDF 文件')
      const buf = await res.arrayBuffer()
      const pdfjs: any = await import('pdfjs-dist')
      const pdf = await pdfjs.getDocument({ data: buf, isEvalSupported: false }).promise

      const firstPage = (await pdf.getPage(1)).getViewport({ scale: 1 })
      const pdfPageRatio = firstPage.height / firstPage.width
      let meta: DocMeta
      try {
        meta = await api.getDoc(id)
        if (!meta.pages?.length) throw new Error('no pages')
      } catch {
        // 服务端没有文本（或新建），前端自行提取
        const pages: { index: number; text: string }[] = []
        for (let i = 1; i <= pdf.numPages; i++) {
          const page = await pdf.getPage(i)
          const tc = await page.getTextContent()
          const text = tc.items.map((it: any) => it.str + (it.hasEOL ? '\n' : ' ')).join('')
          pages.push({ index: i - 1, text })
        }
        meta = { id, title: titleOverride || `文档 ${id.slice(0, 6)}`, pages }
        await api.saveDocMeta(meta)
      }

      // 恢复画布状态
      let cards: Record<string, Card> = {}
      let marks: Record<string, Mark> = {}
      let cardSeq = 0
      let viewport: Viewport | null = null
      let pdfNode: SavedState['pdfNode'] = { x: 0, y: 0, width: PDF_VIEWER_WIDTH }
      const { state } = await api.getDocState(id)
      if (state) {
        cardSeq = state.cardSeq || 0
        pdfNode = state.pdfNode ? { ...state.pdfNode, width: state.pdfNode.resized ? clamp(state.pdfNode.width, 360, 1800) : PDF_VIEWER_WIDTH } : pdfNode
        viewport = state.viewport
        for (const c of state.cards || []) {
          cards[c.id] = restoreCard(c)
        }
        for (const m of state.marks || []) {
          if (m.kind === 'card') m.applied = false // 待 DOM 重建后重新定位
          // 旧版 pdf 标注按行盒几何存储（雅黑行盒≈1.30em、基线≈盒顶+0.81h），
          // 迁移为贴字形的墨迹带：基线−0.79em 起、高 1.02em ⇒ y += 0.21h、h ×0.79
          if (m.kind === 'pdf' && !m.v2 && m.pages) {
            for (const g of m.pages) {
              g.rects = g.rects.map(r => ({ ...r, y: r.y + 0.21 * r.h, h: r.h * 0.79 }))
            }
            m.v2 = true
          }
          marks[m.id] = m
        }
      }

      persistNow()
      cancelRequests()
      if (tweenRaf) cancelAnimationFrame(tweenRaf)
      const stage = document.getElementById('stage')
      const width = stage?.clientWidth ?? window.innerWidth
      const height = stage?.clientHeight ?? window.innerHeight
      const viewerHeight = pdfViewerHeight(pdfNode, pdfPageRatio)
      const scale = clamp(Math.min((width - 40) / pdfNode.width, (height - 100) / viewerHeight), 0.15, 1)
      pdfRef.pdf = pdf
      set(s => ({
        doc: meta,
        cards, marks, cardSeq, pdfNode, pdfPageRatio,
        viewport: viewport || {
          x: (width - pdfNode.width * scale) / 2,
          y: (height + 56 - viewerHeight * scale) / 2,
          scale,
        },
        selectionToolbar: null,
        activeCardId: null,
        cardMenuFor: null,
        edgesVersion: s.edgesVersion + 1,
      }))
    } catch (e) {
      setToast(`打开失败：${(e as Error).message}`, 'error')
    } finally {
      setLoading(false)
    }
  },

  closeDoc: (save = true) => {
    if (save) persistNow()
    else if (persistTimer) { clearTimeout(persistTimer); persistTimer = null }
    cancelRequests()
    if (tweenRaf) cancelAnimationFrame(tweenRaf)
    pdfRef.pdf = null
    set(s => ({ ...restoreWorkspace(s.conversationId), doc: null, selectionToolbar: null, activeCardId: null, cardMenuFor: null, edgesVersion: s.edgesVersion + 1 }))
  },

  switchConversation: (id = crypto.randomUUID()) => {
    const st = get()
    if (!st.doc && st.conversationId === id) return
    persistNow()
    cancelRequests()
    if (tweenRaf) cancelAnimationFrame(tweenRaf)
    pdfRef.pdf = null
    document.getSelection()?.removeAllRanges()
    try { localStorage.setItem(activeConversationKey, id) } catch { /* 存储不可用 */ }
    set({
      ...restoreWorkspace(id), conversationId: id, doc: null,
      selectionToolbar: null, cardMenuFor: null, activeCardId: null, hover: null,
      edgesVersion: st.edgesVersion + 1,
    })
  },

  deleteConversation: id => {
    if (get().conversationId === id) get().switchConversation()
    const conversations = get().conversations.filter(item => item.id !== id)
    try {
      localStorage.removeItem(conversationKey(id))
      localStorage.setItem(conversationsKey, JSON.stringify(conversations))
    } catch { /* 存储不可用 */ }
    set({ conversations })
  },

  resizePdf: width => {
    const { pdfNode } = get()
    const next = clamp(width, 360, 1800)
    if (next === pdfNode.width) return
    const height = pdfNode.height === undefined ? undefined
      : clamp(pdfNode.height * next / pdfNode.width, PDF_MIN_HEIGHT, PDF_MAX_HEIGHT)
    set({ pdfNode: { ...pdfNode, width: next, height, resized: true }, selectionToolbar: null })
    touch()
  },

  resizePdfHeight: (height, fixedBottom) => {
    const { pdfNode } = get()
    const next = clamp(height, PDF_MIN_HEIGHT, PDF_MAX_HEIGHT)
    const y = fixedBottom === undefined ? pdfNode.y : fixedBottom - next
    if (next === pdfNode.height && y === pdfNode.y) return
    set({ pdfNode: { ...pdfNode, y, height: next }, selectionToolbar: null })
    touch()
  },

  savePdfScroll: scrollTop => {
    set(s => ({ pdfNode: { ...s.pdfNode, scrollTop } }))
    touch()
  },

  movePdfNode: (x, y) => {
    set(s => ({ pdfNode: { ...s.pdfNode, x, y } }))
    touch()
  },

  moveCard: (id, x, y) => {
    if (!get().cards[id]) return
    set(s => ({ cards: { ...s.cards, [id]: { ...s.cards[id], x, y } } }))
    touch()
  },

  resizeCard: (id, { width, height, fixedRight, fixedBottom }) => {
    const card = get().cards[id]
    if (!card) return
    const next = {
      ...card,
      width: width === undefined ? card.width : clamp(width, 300, 1000),
      height: height === undefined ? card.height : clamp(height, 160, 1200),
    }
    if (fixedRight !== undefined) next.x = fixedRight - next.width
    if (fixedBottom !== undefined && next.height !== undefined) next.y = fixedBottom - next.height
    if (next.width === card.width && next.height === card.height && next.x === card.x && next.y === card.y) return
    set(s => ({ cards: { ...s.cards, [id]: next } }))
    touch()
  },

  setCardFontScale: (id, delta) => {
    set(s => {
      const c = s.cards[id]
      if (!c) return {}
      const ns = clamp(Math.round((c.fontScale + delta) * 10) / 10, 0.8, 1.6)
      return { cards: { ...s.cards, [id]: { ...c, fontScale: ns } } }
    })
    touch()
  },

  setHover: h => set({ hover: h }),
  setCardMenuFor: id => set({ cardMenuFor: id }),
  bumpEdges: () => useStore.setState(s => ({ edgesVersion: s.edgesVersion + 1 })),

  ask: async raw => {
    const question = raw.trim().slice(0, 2000)
    const st = get()
    if (!question || st.doc) return
    const stage = document.getElementById('stage')
    if (!stage) return
    const r = stage.getBoundingClientRect()
    const point = screenToWorld(Math.max(16, (r.width - CARD_DEFAULT_WIDTH * st.viewport.scale) / 2), Math.max(78, r.height * 0.17), st.viewport)
    const card = newCard(st, question, placeCard(st, point.y, point.x), null, null)
    const conversations = st.conversations.some(item => item.id === st.conversationId)
      ? st.conversations : [{ id: st.conversationId, title: question }, ...st.conversations]
    if (conversations !== st.conversations) {
      try { localStorage.setItem(conversationsKey, JSON.stringify(conversations)) } catch { /* 存储不可用 */ }
    }
    set({ cards: { ...st.cards, [card.id]: card }, cardSeq: +card.id, conversations })
    touch()
    if (Object.keys(st.cards).length || CARD_DEFAULT_WIDTH * st.viewport.scale > r.width - 32) get().locateCard(card.id)
    await generateCard(card.id, { question, sourceDesc: '用户提问', cards: buildCardsIndex(st), ancestors: [] })
  },

  explainFromSelection: async raw => {
    const question = raw.trim().slice(0, 2000)
    const st = get()
    const tb = st.selectionToolbar
    if (!tb || !question || !tb.range.commonAncestorContainer.isConnected) return
    const { text, owner, range } = tb
    set({ selectionToolbar: null })
    document.getSelection()?.removeAllRanges()
    if (!text.trim()) return
    if (owner.type === 'pdf' && !st.doc) return
    if (owner.type === 'card' && !st.cards[owner.cardId]) return

    const depth = owner.type === 'pdf' ? 1 : (st.cards[owner.cardId]?.depth || 1) + 1
    const markId = nid()

    // 1) 创建标注
    let anchorScreenRect: AnchorRect
    if (owner.type === 'pdf') {
      const built = buildPdfMarkFromRange(range)
      if (!built) return
      set(s => ({
        marks: {
          ...s.marks,
          [markId]: { id: markId, kind: 'pdf', pages: built.pages, text, depth, targetCardId: null, createdAt: Date.now(), v2: true },
        },
      }))
      anchorScreenRect = built.anchor
    } else {
      const wrapped = wrapRangeWithMark(range, markId, depth)
      if (!wrapped) return
      set(s => ({
        marks: { ...s.marks, [markId]: { id: markId, kind: 'card', ownerCardId: owner.cardId, text, depth, targetCardId: null, createdAt: Date.now(), applied: true } },
      }))
      anchorScreenRect = wrapped.getBoundingClientRect()
    }

    // 2) 创建卡片（锚点右侧成列）
    const vp = st.viewport
    const anchorWorld = screenToWorld(anchorScreenRect.left + anchorScreenRect.width / 2, anchorScreenRect.top, vp)
    let placeX: number
    if (owner.type === 'pdf') placeX = st.pdfNode.x + st.pdfNode.width + 76
    else placeX = (st.cards[owner.cardId].x + st.cards[owner.cardId].width) + 60
    const place = placeCard(st, anchorWorld.y - 24, placeX)

    const parentId = owner.type === 'card' ? owner.cardId : null
    const card = { ...newCard(st, text.slice(0, 600), place, parentId, markId), question, title: question }
    set(s => ({
      cardSeq: +card.id,
      cards: { ...s.cards, [card.id]: card },
      marks: { ...s.marks, [markId]: { ...s.marks[markId], targetCardId: card.id } },
    }))
    touch()

    const stage = document.getElementById('stage')!.getBoundingClientRect()
    const right = vp.x + (card.x + card.width) * vp.scale
    const top = vp.y + card.y * vp.scale
    if (right > stage.width - 20 || top < 64 || top > stage.height - 130) {
      const parent = parentId ? st.cards[parentId] : null
      const left = parent ? Math.min(parent.x, card.x) : card.x
      const span = Math.max(card.x + card.width, parent ? parent.x + parent.width : 0) - left
      const scale = Math.min(vp.scale, (stage.width - 56) / span)
      if (parent && scale >= 0.72) {
        tweenTo({
          scale,
          x: (stage.width - span * scale) / 2 - left * scale,
          y: Math.min(vp.y + card.y * vp.scale, stage.height * 0.38) - card.y * scale + Math.max(0, 76 - top),
        })
      } else get().locateCard(card.id)
    }

    await generateCard(card.id, {
      docId: st.doc?.id,
      selectionText: text,
      question,
      sourceDesc: owner.type === 'pdf' ? `论文第${owner.page}页` : `卡片#${owner.cardId} 的讲解内容`,
      page: owner.type === 'pdf' ? owner.page : undefined,
      contextText: owner.type === 'pdf'
        ? contextAround(st.doc?.pages[owner.page - 1]?.text || '', text)
        : contextAround(st.cards[owner.cardId].content, text),
      sourceCardId: parentId ?? undefined,
      cards: buildCardsIndex(st),
      ancestors: parentId ? ancestorChain(st, parentId) : [],
    })
  },

  followup: async (cardId, question) => {
    const st = get()
    const card = st.cards[cardId]
    if (!card || !question.trim()) return
    const idx = card.followups.length
    set(s => ({
      cards: {
        ...s.cards,
        [cardId]: { ...s.cards[cardId], followups: [...card.followups, { q: question, a: '', pending: true }] },
      },
    }))
    touch()
    const key = `${cardId}::${idx}`
    const request = new AbortController()
    activeRequests.set(key, request)
    await api.streamFollowup(
      {
        docId: st.doc?.id,
        cardId,
        question,
        content: card.content,
        sourceText: card.sourceText,
        memo: card.memo?.summary,
        followups: card.followups.map(f => ({ q: f.q, a: f.a })),
        cards: buildCardsIndex(st),
      },
      {
        onDelta: t => {
          if (request.signal.aborted) return
          pendingFollowup[key] = (pendingFollowup[key] || '') + t
          scheduleFlush()
        },
        onError: msg => {
          if (request.signal.aborted) return
          delete pendingFollowup[key]
          useStore.setState(s => {
            const c = s.cards[cardId]
            const followups = c.followups.slice()
            followups[idx] = { ...followups[idx], a: `⚠️ ${msg}`, pending: false }
            return { cards: { ...s.cards, [cardId]: { ...c, followups } } }
          })
          get().setToast(`追问失败：${msg}`, 'error')
        },
      },
      request.signal,
    )
    if (request.signal.aborted) return
    activeRequests.delete(key)
    const fuLeftover = pendingFollowup[key] || ''
    delete pendingFollowup[key]
    useStore.setState(s => {
      const c = s.cards[cardId]
      if (!c) return {}
      const followups = c.followups.slice()
      const f = followups[idx]
      if (f) followups[idx] = { ...f, a: f.a + fuLeftover, pending: false }
      return { cards: { ...s.cards, [cardId]: { ...c, followups } }, edgesVersion: s.edgesVersion + 1 }
    })
    touch()
  },

  deleteCard: (id, onClose) => {
    const st = get()
    if (!st.cards[id]) return
    const children = new Map<string, string[]>()
    for (const card of Object.values(st.cards)) {
      if (!card.parentId) continue
      const siblings = children.get(card.parentId) ?? []
      siblings.push(card.id)
      children.set(card.parentId, siblings)
    }
    const branch = new Map([[id, 0]])
    for (const [parent, depth] of branch) {
      for (const child of children.get(parent) ?? []) {
        if (!branch.has(child)) branch.set(child, depth + 1)
      }
    }
    onClose?.(branch)
    cancelRequests(new Set(branch.keys()))
    const cards = { ...st.cards }
    for (const cardId of branch.keys()) delete cards[cardId]
    const marks = { ...st.marks }
    for (const mark of Object.values(marks)) {
      if (!branch.has(mark.targetCardId ?? '') && !branch.has(mark.ownerCardId ?? '')) continue
      if (mark.kind === 'card' && !branch.has(mark.ownerCardId ?? '')) unwrapMark(mark.id)
      delete marks[mark.id]
    }
    document.getSelection()?.removeAllRanges()
    set({ cards, marks, cardMenuFor: null, selectionToolbar: null, hover: null, activeCardId: null })
    touch()
  },

  setSelectionToolbar: p => set({ selectionToolbar: p }),
  setSettingsOpen: v => set({ settingsOpen: v }),
  setHelpOpen: v => set({ helpOpen: v }),
}))
