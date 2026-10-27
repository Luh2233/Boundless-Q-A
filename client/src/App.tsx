import { useEffect } from 'react'
import { useStore } from './store'
import { CanvasStage } from './canvas/CanvasStage'
import { SelectionToolbar } from './ui/SelectionToolbar'
import { TopBar } from './ui/TopBar'
import { EmptyState } from './ui/EmptyState'
import { SettingsDialog } from './ui/SettingsDialog'
import { Controls, HelpOverlay, Toast, HintBar } from './ui/Controls'

/** 全局划词监听：选区落在 PDF 文本层或某张已完成卡片的正文里 → 弹出「讲解」工具条 */
function useGlobalSelection() {
  useEffect(() => {
    let timer: ReturnType<typeof setTimeout>
    const hide = () => {
      if (useStore.getState().selectionToolbar) useStore.setState({ selectionToolbar: null })
    }
    const check = () => {
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
        owner = { type: 'card', cardId }
      }
      if (!owner) return hide()

      const text = sel.toString()
      if (text.trim().length < 2) return hide()

      const rect = range.getBoundingClientRect()
      // 选区完全在视口外（平移后）不弹工具条
      if (rect.bottom < 0 || rect.top > window.innerHeight || rect.right < 0 || rect.left > window.innerWidth) {
        return hide()
      }
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
      clearTimeout(timer)
      timer = setTimeout(check, 140)
    }
    const onPointerUp = () => {
      clearTimeout(timer)
      timer = setTimeout(check, 10)
    }
    document.addEventListener('selectionchange', onSelChange)
    document.addEventListener('pointerup', onPointerUp)
    return () => {
      clearTimeout(timer)
      document.removeEventListener('selectionchange', onSelChange)
      document.removeEventListener('pointerup', onPointerUp)
    }
  }, [])
}

export default function App() {
  const doc = useStore(s => s.doc)
  const loading = useStore(s => s.loading)
  const loadMsg = useStore(s => s.loadMsg)
  useGlobalSelection()

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
      {doc ? (
        <>
          <CanvasStage />
          <TopBar />
          <SelectionToolbar />
          <Controls />
          <HintBar />
        </>
      ) : (
        <>
          <EmptyState />
          <TopBar />
        </>
      )}
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
