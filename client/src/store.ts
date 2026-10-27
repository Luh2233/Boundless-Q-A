import { create } from 'zustand'
import type { Card, Mark, Viewport, DocMeta } from './types'
import * as api from './api'
import { clamp, screenToWorld } from './geom'
import { wrapRangeWithMark } from './marks/wrapRange'
import { buildPdfMarkFromRange } from './marks/pdfSelection'
import type { AnchorRect } from './marks/pdfSelection'
import { contextAround } from './lib/text'

/* pdf.js 的文档代理放在模块级（不可序列化，不入 store） */
export const pdfRef: { pdf: any } = { pdf: null }

export const DOC_WORLD_WIDTH = 820
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
  pdfNode: { x: number; y: number; width: number }
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
  closeDoc: () => void

  movePdfNode: (x: number, y: number) => void
  moveCard: (id: string, x: number, y: number) => void
  resizeCard: (id: string, width: number) => void
  setCardFontScale: (id: string, delta: number) => void
  setHover: (h: { cardId?: string; markId?: string } | null) => void
  setCardMenuFor: (id: string | null) => void
  bumpEdges: () => void
  /** 元素底部超出视口时平移画布（替代 scrollIntoView——后者会滚动 .stage 破坏变换） */
  keepElementVisible: (el: HTMLElement) => void

  explainFromSelection: () => Promise<void>
  followup: (cardId: string, question: string) => Promise<void>
  reExplain: (cardId: string) => Promise<void>
  deleteCard: (id: string) => void

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
let persistTimer: ReturnType<typeof setTimeout> | null = null
function persistNow(keepalive = false) {
  if (persistTimer) { clearTimeout(persistTimer); persistTimer = null }
  const s = useStore.getState()
  if (!s.doc) return
  api.putDocState(s.doc.id, {
    viewport: s.viewport,
    pdfNode: s.pdfNode,
    cards: Object.values(s.cards),
    marks: Object.values(s.marks),
    cardSeq: s.cardSeq,
  }, keepalive).catch(() => {})
}
function touchPersist() {
  if (!useStore.getState().doc) return
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
  let y = anchorWorldY - 30
  let guard = 0
  while (guard++ < 40 && cards.some(c => Math.abs(c.x - x) < 100 && Math.abs(c.y - y) < 70)) {
    y += 76
  }
  return { x, y }
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
    else tweenRaf = 0
  }
  tweenRaf = requestAnimationFrame(step)
}

export const useStore = create<Store>((set, get) => ({
  loading: false,
  loadMsg: '',
  doc: null,
  viewport: { x: 120, y: 60, scale: 0.9 },
  pdfNode: { x: 0, y: 0, width: DOC_WORLD_WIDTH },
  cards: {},
  marks: {},
  cardSeq: 0,
  edgesVersion: 0,
  hover: null,
  selectionToolbar: null,
  toast: null,
  settingsOpen: false,
  helpOpen: false,
  cardMenuFor: null,

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
    const { pdfNode } = get()
    const r = document.getElementById('stage')!.getBoundingClientRect()
    const scale = clamp(Math.min((r.width - 160) / pdfNode.width, (r.height - 180) / (pdfNode.width * 1.5)), 0.2, 1.2)
    tweenTo({
      scale,
      x: r.width / 2 - (pdfNode.x + pdfNode.width / 2) * scale,
      y: r.height / 2 - (pdfNode.y + 300) * scale,
    })
  },

  locateCard: cardId => {
    const c = get().cards[cardId]
    if (!c) return
    const r = document.getElementById('stage')!.getBoundingClientRect()
    const scale = clamp(get().viewport.scale, 0.4, 1.2)
    const el = document.querySelector(`[data-card-root="${cardId}"]`)
    const h = el ? el.getBoundingClientRect().height / get().viewport.scale : 300
    tweenTo({
      scale,
      x: r.width / 2 - (c.x + c.width / 2) * scale,
      y: r.height / 2 - (c.y + Math.min(h, 500) / 2) * scale,
    })
  },

  locateMark: markId => {
    const el = document.querySelector(`[data-mark-anchor="${markId}"]`)
    const vp = get().viewport
    const r = document.getElementById('stage')!.getBoundingClientRect()
    if (!el) return
    const b = el.getBoundingClientRect()
    const w = screenToWorld(b.left + b.width / 2, b.top + b.height / 2, vp)
    const scale = clamp(vp.scale, 0.4, 1.4)
    tweenTo({ scale, x: r.width / 2 - w.x * scale, y: r.height / 2 - w.y * scale })
  },

  importFile: async file => {
    const { setLoading, setToast, openDoc: _open } = get()
    try {
      setLoading(true, '正在上传 PDF…')
      const { id } = await api.uploadPdf(file)
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
      const buf = await res.arrayBuffer()
      const pdfjs: any = await import('pdfjs-dist')
      const pdf = await pdfjs.getDocument({ data: buf }).promise
      pdfRef.pdf = pdf

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
      let pdfNode = { x: 0, y: 0, width: DOC_WORLD_WIDTH }
      try {
        const { state } = await api.getDocState(id)
        if (state) {
          cardSeq = state.cardSeq || 0
          pdfNode = state.pdfNode || pdfNode
          viewport = state.viewport
          for (const c of state.cards || []) {
            // 恢复时错误态保留（便于看到失败原因），其余一律落定为 done
            cards[c.id] = { ...c, status: c.status === 'error' ? 'error' : 'done' }
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
      } catch { /* 无状态则全新画布 */ }

      set(s => ({
        doc: meta,
        cards, marks, cardSeq, pdfNode,
        viewport: viewport || { x: 140, y: 40, scale: 0.85 },
        selectionToolbar: null,
        edgesVersion: s.edgesVersion + 1,
      }))
    } catch (e) {
      setToast(`打开失败：${(e as Error).message}`, 'error')
    } finally {
      setLoading(false)
    }
  },

  closeDoc: () => set({ doc: null, cards: {}, marks: {}, cardSeq: 0, selectionToolbar: null }),

  movePdfNode: (x, y) => {
    set(s => ({ pdfNode: { ...s.pdfNode, x, y } }))
    touch()
  },

  moveCard: (id, x, y) => {
    set(s => ({ cards: { ...s.cards, [id]: { ...s.cards[id], x, y } } }))
    useStore.setState(st => ({ edgesVersion: st.edgesVersion + 1 }))
  },

  resizeCard: (id, width) => {
    set(s => ({ cards: { ...s.cards, [id]: { ...s.cards[id], width: clamp(width, 320, 760) } } }))
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

  keepElementVisible: el => {
    const stage = document.getElementById('stage')
    if (!stage) return
    const sr = stage.getBoundingClientRect()
    const r = el.getBoundingClientRect()
    const margin = 90
    if (r.bottom > sr.bottom - margin) {
      const dy = r.bottom - (sr.bottom - margin)
      set(s => ({ viewport: { ...s.viewport, y: s.viewport.y - dy } }))
    }
  },

  explainFromSelection: async () => {
    const st = get()
    const tb = st.selectionToolbar
    if (!tb || !st.doc) return
    const { text, owner, range } = tb
    set({ selectionToolbar: null })
    document.getSelection()?.removeAllRanges()
    if (text.trim().length < 2) return

    const depth = owner.type === 'pdf' ? 1 : (st.cards[owner.cardId]?.depth || 1) + 1
    const markId = nid()

    // 1) 创建标注
    let anchorScreenRect: AnchorRect
    if (owner.type === 'pdf') {
      const built = buildPdfMarkFromRange(range, text)
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
    const place = placeCard(st, anchorWorld.y, placeX)

    const cardSeq = st.cardSeq + 1
    const cardId = String(cardSeq)
    const card: Card = {
      id: cardId,
      x: place.x,
      y: place.y,
      width: CARD_DEFAULT_WIDTH,
      fontScale: 1,
      depth,
      sourceMarkId: markId,
      sourceText: text.slice(0, 600),
      content: '',
      title: '',
      status: 'streaming',
      memo: null,
      followups: [],
      parentId: owner.type === 'card' ? owner.cardId : null,
      createdAt: Date.now(),
    }
    set(s => ({
      cardSeq,
      cards: { ...s.cards, [cardId]: card },
      marks: { ...s.marks, [markId]: { ...s.marks[markId], targetCardId: cardId } },
    }))
    touch()

    // 3) 组装智能体上下文并请求讲解
    const contextText =
      owner.type === 'pdf'
        ? contextAround(st.doc.pages[owner.page - 1]?.text || '', text)
        : contextAround(st.cards[owner.cardId].content, text)
    const ancestors = owner.type === 'card' ? ancestorChain(st, owner.cardId) : []
    const sourceDesc =
      owner.type === 'pdf' ? `论文第${owner.page}页` : `卡片#${owner.cardId} 的讲解内容`

    await api.streamExplain(
      {
        docId: st.doc.id,
        selectionText: text,
        sourceDesc,
        page: owner.type === 'pdf' ? owner.page : undefined,
        contextText,
        sourceCardId: owner.type === 'card' ? owner.cardId : undefined,
        cards: buildCardsIndex(st),
        ancestors,
      },
      {
        onDelta: t => {
          pendingContent[cardId] = (pendingContent[cardId] || '') + t
          scheduleFlush()
        },
        onError: msg => {
          useStore.setState(s => ({
            cards: { ...s.cards, [cardId]: { ...s.cards[cardId], status: 'error', error: msg } },
          }))
          get().setToast(`讲解失败：${msg}`, 'error')
          touch()
        },
      },
      memo => {
        useStore.setState(s => ({
          cards: { ...s.cards, [cardId]: { ...s.cards[cardId], memo, title: memo.summary } },
        }))
      },
    )
    // 完成落定：合并尚未 flush 的尾部增量（防止 rAF 晚到造成内容/状态竞态），错误态不被覆盖
    const leftover = pendingContent[cardId] || ''
    delete pendingContent[cardId]
    useStore.setState(s => {
      const c = s.cards[cardId]
      if (!c || c.status === 'error') return {}
      return {
        cards: {
          ...s.cards,
          [cardId]: {
            ...c,
            content: c.content + leftover,
            status: 'done',
            title: c.memo?.summary || c.title || `讲解 #${cardId}`,
          },
        },
        edgesVersion: s.edgesVersion + 1,
      }
    })
    touch()
  },

  followup: async (cardId, question) => {
    const st = get()
    const card = st.cards[cardId]
    if (!card || !st.doc || !question.trim()) return
    const idx = card.followups.length
    set(s => ({
      cards: {
        ...s.cards,
        [cardId]: { ...s.cards[cardId], followups: [...card.followups, { q: question, a: '', pending: true }] },
      },
    }))
    touch()
    const key = `${cardId}::${idx}`
    await api.streamFollowup(
      {
        docId: st.doc.id,
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
          pendingFollowup[key] = (pendingFollowup[key] || '') + t
          scheduleFlush()
        },
        onError: msg => {
          useStore.setState(s => {
            const c = s.cards[cardId]
            const followups = c.followups.slice()
            followups[idx] = { ...followups[idx], a: `⚠️ ${msg}`, pending: false }
            return { cards: { ...s.cards, [cardId]: { ...c, followups } } }
          })
          get().setToast(`追问失败：${msg}`, 'error')
        },
      },
    )
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

  reExplain: async cardId => {
    const st = get()
    const card = st.cards[cardId]
    const mark = card?.sourceMarkId ? st.marks[card.sourceMarkId] : null
    if (!card || !mark || !st.doc) return
    set(s => {
      // 本卡片内容上的行内标注随内容重渲染消失，重置为待重定位（完成后由 CardBody 按文本恢复）
      const marks2 = { ...s.marks }
      for (const m of Object.values(marks2)) {
        if (m.kind === 'card' && m.ownerCardId === cardId) {
          marks2[m.id] = { ...m, applied: false, dangling: false }
        }
      }
      return {
        cards: { ...s.cards, [cardId]: { ...card, content: '', status: 'streaming', memo: null, title: '' } },
        marks: marks2,
        cardMenuFor: null,
      }
    })
    touch()

    const contextText =
      mark.kind === 'pdf'
        ? contextAround(st.doc.pages[mark.pages![0].page - 1]?.text || '', mark.text)
        : st.cards[mark.ownerCardId!]?.content || ''
    const sourceDesc = mark.kind === 'pdf' ? `论文第${mark.pages![0].page}页` : `卡片#${mark.ownerCardId} 的讲解内容`

    await api.streamExplain(
      {
        docId: st.doc.id,
        selectionText: mark.text,
        sourceDesc,
        page: mark.kind === 'pdf' ? mark.pages![0].page : undefined,
        contextText,
        cards: buildCardsIndex(st).filter(c => c.id !== +cardId),
        ancestors: mark.kind === 'card' ? ancestorChain(st, mark.ownerCardId!) : [],
      },
      {
        onDelta: t => {
          pendingContent[cardId] = (pendingContent[cardId] || '') + t
          scheduleFlush()
        },
        onError: msg => {
          useStore.setState(s => ({ cards: { ...s.cards, [cardId]: { ...s.cards[cardId], status: 'error', error: msg } } }))
          get().setToast(`讲解失败：${msg}`, 'error')
        },
      },
      memo => {
        useStore.setState(s => ({ cards: { ...s.cards, [cardId]: { ...s.cards[cardId], memo, title: memo.summary } } }))
      },
    )
    // 完成落定：合并残余增量；错误态（onError 已置 error）不被覆盖
    const leftover = pendingContent[cardId] || ''
    delete pendingContent[cardId]
    useStore.setState(s => {
      const c = s.cards[cardId]
      if (!c || c.status === 'error') return {}
      return {
        cards: {
          ...s.cards,
          [cardId]: {
            ...c,
            content: c.content + leftover,
            status: 'done',
            title: c.memo?.summary || c.title || `讲解 #${cardId}`,
          },
        },
        edgesVersion: s.edgesVersion + 1,
      }
    })
    touch()
  },

  deleteCard: id => {
    const st = get()
    const card = st.cards[id]
    if (!card) return
    const marks = { ...st.marks }
    // 删除入向标注（讲解被删，原文高亮一并移除）
    if (card.sourceMarkId && marks[card.sourceMarkId]) delete marks[card.sourceMarkId]
    // 卡片内容上的标注随卡片消失；其下游卡片保留但解除连线
    for (const m of Object.values(marks)) {
      if (m.kind === 'card' && m.ownerCardId === id) delete marks[m.id]
    }
    const cards = { ...st.cards }
    delete cards[id]
    set({ cards, marks, cardMenuFor: null })
    touch()
  },

  setSelectionToolbar: p => set({ selectionToolbar: p }),
  setSettingsOpen: v => set({ settingsOpen: v }),
  setHelpOpen: v => set({ helpOpen: v }),
}))
