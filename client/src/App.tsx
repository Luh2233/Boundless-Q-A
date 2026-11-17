import { useEffect, useState } from 'react'
import { useStore } from './store'
import { CanvasStage } from './canvas/CanvasStage'
import { SelectionToolbar } from './ui/SelectionToolbar'
import { TopBar } from './ui/TopBar'
import { KnowledgeLibrary } from './knowledge/KnowledgeLibrary'
import { QuestionComposer } from './ui/QuestionComposer'
import { SettingsDialog } from './ui/SettingsDialog'
import { Controls, HelpOverlay, Toast } from './ui/Controls'

/** 全局划词监听：选区落在 PDF 文本层或某张已完成卡片的正文里 → 弹出「讲解」工具条 */
function useGlobalSelection() {
  useEffect(() => {
    let timer: ReturnType<typeof setTimeout>
    let pointerId: number | null = null
    const hide = () => {
      if (useStore.getState().selectionToolbar) useStore.setState({ selectionToolbar: null })
    }
    const check = () => {
      if (pointerId !== null || document.activeElement?.closest('.sel-toolbar')) return
      const sel = document.getSelection()
      const st = useStore.getState()
      if (!sel || sel.isCollapsed || sel.rangeCount === 0) return hide()
      const range = sel.getRangeAt(0)
      const elOf = (n: Node | null): HTMLElement | null => {
        const el = n?.nodeType === 3 ? (n as Text).parentElement : (n as HTMLElement)
        return el || null
      }
      const aEl = elOf(range.startContainer)
      const bEl = elOf(range.endContainer)
      if (!aEl || !bEl) return hide()

      const aPage = aEl.closest('[data-page-index]')
      const bPage = bEl.closest('[data-page-index]')
      const aCard = aEl.closest('[data-card-body]')
      const bCard = bEl.closest('[data-card-body]')

      let owner: { type: 'pdf'; page: number } | { type: 'card'; cardId: string } | null = null
      if (aPage && bPage && aPage.closest('[data-pdf-root]') === bPage.closest('[data-pdf-root]')) {
        owner = { type: 'pdf', page: +(aPage as HTMLElement).dataset.pageIndex! }
      } else if (aCard && bCard && aCard === bCard) {
        const cardId = (aCard as HTMLElement).dataset.cardBody!
        const card = st.cards[cardId]
        if (!card || card.status !== 'done') return hide()
        if (Array.from(aCard.querySelectorAll('[data-pending]')).some(el => range.intersectsNode(el))) return hide()
        owner = { type: 'card', cardId }
      }
      if (!owner) return hide()

      const text = sel.toString()
      if (!text.trim()) return hide()

      const rect = range.getBoundingClientRect()
      // 选区完全在视口外（平移后）不弹工具条
      if (rect.bottom < 0 || rect.top > window.innerHeight || rect.right < 0 || rect.left > window.innerWidth) {
        return hide()
      }
      const previous = st.selectionToolbar
      if (previous && previous.text === text && previous.range.commonAncestorContainer.isConnected &&
          previous.range.compareBoundaryPoints(Range.START_TO_START, range) === 0 &&
          previous.range.compareBoundaryPoints(Range.END_TO_END, range) === 0) return
      useStore.setState({
        selectionToolbar: {
          text,
          owner,
          range: range.cloneRange(),
          screen: { x: rect.right, y: rect.bottom },
        },
      })
    }
    const onSelChange = () => {
      if (pointerId !== null) return
      clearTimeout(timer)
      timer = setTimeout(check, 140)
    }
    const onPointerDown = (event: PointerEvent) => {
      if (!event.isPrimary || event.button !== 0) return
      if (event.target instanceof Element && event.target.closest('.sel-toolbar')) return
      pointerId = event.pointerId
      clearTimeout(timer)
      hide()
    }
    const onPointerUp = (event: PointerEvent) => {
      if (event.pointerId !== pointerId || event.button !== 0) return
      pointerId = null
      clearTimeout(timer)
      timer = setTimeout(check, 0)
    }
    const resetPointer = () => {
      pointerId = null
      clearTimeout(timer)
    }
    const onPointerCancel = (event: PointerEvent) => {
      if (event.pointerId === pointerId) resetPointer()
    }
    document.addEventListener('selectionchange', onSelChange)
    window.addEventListener('pointerdown', onPointerDown, true)
    window.addEventListener('pointerup', onPointerUp, true)
    window.addEventListener('pointercancel', onPointerCancel, true)
    window.addEventListener('blur', resetPointer)
    return () => {
      resetPointer()
      document.removeEventListener('selectionchange', onSelChange)
      window.removeEventListener('pointerdown', onPointerDown, true)
      window.removeEventListener('pointerup', onPointerUp, true)
      window.removeEventListener('pointercancel', onPointerCancel, true)
      window.removeEventListener('blur', resetPointer)
    }
  }, [])
}

export default function App() {
  const docId = useStore(s => s.doc?.id)
  const loading = useStore(s => s.loading)
  const loadMsg = useStore(s => s.loadMsg)
  useGlobalSelection()
  const [dropActive, setDropActive] = useState(false)
  const conversationId = useStore(s => s.conversationId)
  useEffect(() => {
    const over = (e: DragEvent) => {
      if (!e.dataTransfer?.types.includes('Files')) return
      e.preventDefault()
      setDropActive(true)
    }
    const leave = (e: DragEvent) => { if (!e.relatedTarget) setDropActive(false) }
    const drop = (e: DragEvent) => {
      if (!e.dataTransfer?.types.includes('Files')) return
      e.preventDefault()
      setDropActive(false)
      const file = e.dataTransfer.files[0]
      if (file) void useStore.getState().importFile(file)
    }
    window.addEventListener('dragover', over)
    window.addEventListener('dragleave', leave)
    window.addEventListener('drop', drop)
    return () => {
      window.removeEventListener('dragover', over)
      window.removeEventListener('dragleave', leave)
      window.removeEventListener('drop', drop)
    }
  }, [])

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const t = e.target as HTMLElement
      if (t.tagName === 'INPUT' || t.tagName === 'TEXTAREA') return
      if (e.key === 'Escape') {
        useStore.setState({ settingsOpen: false, helpOpen: false, cardMenuFor: null, selectionToolbar: null })
      }
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [])

  return (
    <div className="app">
      <CanvasStage />
      <TopBar />
      <KnowledgeLibrary />
      <SelectionToolbar />
      <Controls />
      {!docId && <QuestionComposer key={conversationId} />}
      {dropActive && <div className="pdf-drop-overlay">松开鼠标，导入 PDF</div>}
      <SettingsDialog />
      <HelpOverlay />
      <Toast />
      {loading && (
        <div className="loading-mask">
          <div className="loading-card">
            <div className="spinner" />
            <span>{loadMsg || '加载中…'}</span>
          </div>
        </div>
      )}
    </div>
  )
}
