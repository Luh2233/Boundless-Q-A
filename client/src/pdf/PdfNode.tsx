import { PDF_MAX_HEIGHT, PDF_MIN_HEIGHT, pdfViewerHeight, useStore } from '../store'
import { PdfPage } from './PdfPage'
import { bindPdfSelection } from './pdfPointerSelection'
import { useEffect, useLayoutEffect, useRef, useState } from 'react'

/** 画布上的 PDF 文档节点：标题栏（拖拽柄）+ 逐页渲染 */
export function PdfNode() {
  const doc = useStore(s => s.doc)
  const pdfNode = useStore(s => s.pdfNode)
  const ratio = useStore(s => s.pdfPageRatio)
  const resizePdf = useStore(s => s.resizePdf)
  const resizePdfHeight = useStore(s => s.resizePdfHeight)
  const [gutter, setGutter] = useState(24)
  const pageWidth = pdfNode.width - gutter
  const viewHeight = pdfViewerHeight(pdfNode, ratio, gutter)
  const anchor = useRef<{ index: number; fraction: number } | null>(null)
  const movePdfNode = useStore(s => s.movePdfNode)
  const numPages = doc?.pages.length ?? 0
  const reader = useRef<HTMLDivElement>(null)
  const [currentPage, setCurrentPage] = useState(1)
  const [pageInput, setPageInput] = useState<string | null>(null)
  const savePdfScroll = useStore(s => s.savePdfScroll)
  const dismiss = useStore(s => s.setSelectionToolbar)
  useLayoutEffect(() => {
    if (reader.current) reader.current.scrollTop = useStore.getState().pdfNode.scrollTop ?? 0
  }, [doc?.id])
  useLayoutEffect(() => {
    const element = reader.current
    if (!element) return
    const measure = () => setGutter(element.offsetWidth - element.clientWidth + 18)
    measure()
    const observer = new ResizeObserver(measure)
    observer.observe(element)
    return () => observer.disconnect()
  }, [doc?.id])

  useLayoutEffect(() => {
    const element = reader.current
    const position = anchor.current
    const page = position && element?.children[position.index] as HTMLElement | undefined
    if (element && position && page) element.scrollTop = page.offsetTop - 12 + page.offsetHeight * position.fraction
  }, [pageWidth])

  const [dragging, setDragging] = useState(false)

  useEffect(() => {
    const element = reader.current
    if (!element) return
    const wheel = (event: WheelEvent) => {
      if (!event.ctrlKey && !event.altKey && !event.metaKey) event.stopPropagation()
    }
    element.addEventListener('wheel', wheel)
    const unbindSelection = bindPdfSelection(element)
    return () => {
      unbindSelection()
      element.removeEventListener('wheel', wheel)
    }
  }, [doc?.id])

  if (!doc) return null

  const zoom = (width: number) => {
    const element = reader.current
    const page = element?.children[currentPage - 1] as HTMLElement | undefined
    if (element && page) {
      anchor.current = { index: currentPage - 1, fraction: (element.scrollTop - page.offsetTop + 12) / page.offsetHeight }
    }
    resizePdf(width)
  }

  const dragResize = (event: React.PointerEvent<HTMLDivElement>, resize: (dx: number, dy: number) => void) => {
    if (event.button !== 0) return
    event.preventDefault()
    event.stopPropagation()
    const handle = event.currentTarget
    const { clientX, clientY, pointerId } = event
    const scale = useStore.getState().viewport.scale
    const move = (e: PointerEvent) => {
      if (e.pointerId !== pointerId) return
      resize((e.clientX - clientX) / scale, (e.clientY - clientY) / scale)
    }
    const end = () => {
      handle.removeEventListener('pointermove', move)
      handle.removeEventListener('lostpointercapture', end)
    }
    handle.setPointerCapture(pointerId)
    handle.addEventListener('pointermove', move)
    handle.addEventListener('lostpointercapture', end)
  }

  const resizeFromCorner = (event: React.PointerEvent<HTMLDivElement>) => {
    const windowRatio = pdfNode.height === undefined ? ratio : viewHeight / pdfNode.width
    dragResize(event, (dx, dy) => zoom(pdfNode.width + (dx + dy * windowRatio) / (1 + windowRatio * windowRatio)))
  }

  const jump = (raw: string) => {
    const value = Number(raw)
    const element = reader.current
    setPageInput(null)
    if (!element || !Number.isInteger(value) || !raw.trim()) return
    const target = Math.max(1, Math.min(numPages, value))
    const page = element.children[target - 1] as HTMLElement | undefined
    if (page) element.scrollTop = page.offsetTop - 12
    setCurrentPage(target)
  }

  const onScroll = () => {
    const element = reader.current
    if (!element) return
    const y = element.scrollTop + element.clientHeight * 0.35
    let first = 0
    let last = element.children.length - 1
    while (first < last) {
      const middle = Math.ceil((first + last) / 2)
      if ((element.children[middle] as HTMLElement).offsetTop <= y) first = middle
      else last = middle - 1
    }
    setCurrentPage(first + 1)
    dismiss(null)
    savePdfScroll(element.scrollTop)
  }

  const onHeaderDown = (e: React.PointerEvent) => {
    if (e.button !== 0 || (e.target as Element).closest('form, button')) return
    e.preventDefault()
    setDragging(true)
    const sx = e.clientX
    const sy = e.clientY
    const v0 = { ...useStore.getState().viewport }
    const p0 = { ...useStore.getState().pdfNode }
    const move = (ev: PointerEvent) => {
      movePdfNode(p0.x + (ev.clientX - sx) / v0.scale, p0.y + (ev.clientY - sy) / v0.scale)
    }
    const up = () => {
      setDragging(false)
      window.removeEventListener('pointermove', move)
      window.removeEventListener('pointerup', up)
    }
    window.addEventListener('pointermove', move)
    window.addEventListener('pointerup', up)
  }

  return (
    <div
      className="pdf-node"
      data-pdf-root="1"
      style={{ left: pdfNode.x, top: pdfNode.y, width: pdfNode.width, height: viewHeight }}
    >
      <div className={`pdf-head${dragging ? ' dragging' : ''}`} onPointerDown={onHeaderDown}>
        <span className="pdf-grip">⠿</span>
        <span className="pdf-title">{doc.title}</span>
        <form className="pdf-pagination" aria-label="PDF 页码跳转" onSubmit={e => { e.preventDefault(); jump(pageInput ?? String(currentPage)) }}>
          <button type="button" aria-label="上一页" disabled={currentPage <= 1} onClick={() => jump(String(currentPage - 1))}>‹</button>
          <input aria-label="跳转到页码" inputMode="numeric" value={pageInput ?? String(currentPage)}
            onFocus={e => e.currentTarget.select()} onBlur={() => setPageInput(null)}
            onChange={e => setPageInput(e.target.value.replace(/[^0-9]/g, ''))} />
          <span>/ {numPages}</span>
          <button type="button" aria-label="下一页" disabled={currentPage >= numPages} onClick={() => jump(String(currentPage + 1))}>›</button>
        </form>
        <div className="pdf-zoom">
          <button type="button" aria-label="缩小 PDF" disabled={pdfNode.width <= 360} onClick={() => zoom(pdfNode.width / 1.2)}>−</button>
          <button type="button" aria-label="放大 PDF" disabled={pdfNode.width >= 1800} onClick={() => zoom(pdfNode.width * 1.2)}>+</button>
        </div>
      </div>
      <div className="pdf-pages" ref={reader} onScroll={onScroll} tabIndex={0} aria-label="PDF 阅读区">
        {Array.from({ length: numPages }, (_, i) => (
          <PdfPage key={i} pageIndex={i} pageWidth={pageWidth} fallbackRatio={ratio} />
        ))}
      </div>
      <div className="pdf-resize" title="拖动缩放 PDF" onPointerDown={resizeFromCorner} />
      {(['top', 'bottom'] as const).map(edge => {
        const top = edge === 'top'
        const label = `${top ? '向上' : '向下'}拖动调整 PDF 高度`
        const resizeHeight = (dy: number) =>
          resizePdfHeight(viewHeight + (top ? -dy : dy), top ? pdfNode.y + viewHeight : undefined)
        return (
          <div key={edge} className={`pdf-height-resize ${edge}`} title={label} aria-label={label}
            role="separator" tabIndex={0} aria-valuemin={PDF_MIN_HEIGHT} aria-valuemax={PDF_MAX_HEIGHT}
            aria-valuenow={Math.round(viewHeight)} aria-orientation="horizontal"
            onPointerDown={event => dragResize(event, (_dx, dy) => resizeHeight(dy))}
            onKeyDown={event => {
              if (event.key !== 'ArrowUp' && event.key !== 'ArrowDown') return
              event.preventDefault()
              resizeHeight(event.key === 'ArrowUp' ? -48 : 48)
            }} />
        )
      })}
    </div>
  )
}
