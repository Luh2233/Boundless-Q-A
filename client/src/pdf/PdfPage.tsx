import { useEffect, useRef, useState } from 'react'
import * as pdfjsLib from 'pdfjs-dist'
import workerUrl from 'pdfjs-dist/build/pdf.worker.min.js?url'
import { useStore, pdfRef } from '../store'
import { clamp } from '../geom'

pdfjsLib.GlobalWorkerOptions.workerSrc = workerUrl

export function PdfPage({ pageIndex, pageWidth, fallbackRatio }: { pageIndex: number; pageWidth: number; fallbackRatio: number }) {
  const containerRef = useRef<HTMLDivElement>(null)
  const canvasRef = useRef<HTMLCanvasElement>(null)
  const textLayerRef = useRef<HTMLDivElement>(null)
  const [aspect, setAspect] = useState<number | null>(null)
  const pageHeight = pageWidth * (aspect ?? fallbackRatio)
  const [textReady, setTextReady] = useState(false)
  const [visible, setVisible] = useState(false)
  const [textRequested, setTextRequested] = useState(false)
  const zoom = useStore(s => s.viewport.scale)
  const marks = useStore(s => s.marks)
  const bumpEdges = useStore(s => s.bumpEdges)
  const renderTaskRef = useRef<any>(null)

  /* 可见性（视口外 ±700px 才渲染） */
  useEffect(() => {
    const el = containerRef.current
    if (!el) return
    const io = new IntersectionObserver(([entry]) => setVisible(entry.isIntersecting), {
      root: el.closest('.pdf-pages'),
      rootMargin: '700px',
    })
    io.observe(el)
    return () => io.disconnect()
  }, [])

  /* 页框先测量，文本层只在靠近阅读区时建立。 */
  useEffect(() => {
    if (visible) setTextRequested(true)
  }, [visible])

  useEffect(() => {
    let cancelled = false
    void pdfRef.pdf?.getPage(pageIndex + 1).then((page: any) => {
      if (cancelled) return
      const base = page.getViewport({ scale: 1 })
      setAspect(base.height / base.width)
    }).catch(() => {})
    return () => { cancelled = true }
  }, [pageIndex])

  useEffect(() => {
    const layer = textLayerRef.current
    if (!textRequested || !layer || !pdfRef.pdf) return
    const pdf = pdfRef.pdf
    let cancelled = false
    let task: ReturnType<typeof pdfjsLib.renderTextLayer> | undefined
    layer.replaceChildren()
    void (async () => {
      const page = await pdf.getPage(pageIndex + 1)
      if (cancelled) return
      const base = page.getViewport({ scale: 1 })
      const viewport = page.getViewport({ scale: pageWidth / base.width })
      layer.style.setProperty('--scale-factor', String(viewport.scale))
      task = pdfjsLib.renderTextLayer({
        container: layer,
        viewport,
        textContentSource: page.streamTextContent(),
      })
      await task.promise
      if (cancelled) return
      setTextReady(true)
      bumpEdges()
    })().catch(() => {})
    return () => { cancelled = true; task?.cancel() }
  }, [pageIndex, bumpEdges, textRequested, pageWidth])

  /* 位图：可见时渲染，缩放变化后防抖重渲（保持清晰） */
  useEffect(() => {
    if (!visible || aspect === null) return
    let cancelled = false
    const timer = setTimeout(async () => {
      const pdf = pdfRef.pdf
      const canvas = canvasRef.current
      if (!pdf || !canvas || cancelled) return
      try {
        const page = await pdf.getPage(pageIndex + 1)
        if (cancelled) return
        const base = page.getViewport({ scale: 1 })
        const s = pageWidth / base.width
        const vp = page.getViewport({ scale: s })
        const dpr = clamp(window.devicePixelRatio || 1, 1, 2)
        const res = clamp(dpr * zoom, 0.7, 3.2)
        canvas.width = Math.floor(vp.width * res)
        canvas.height = Math.floor(vp.height * res)
        renderTaskRef.current?.cancel?.()
        const task = page.render({
          canvasContext: canvas.getContext('2d')!,
          viewport: vp,
          transform: [res, 0, 0, res, 0, 0],
        })
        renderTaskRef.current = task
        await task.promise
      } catch { /* 渲染中断（缩放中被取消） */ }
    }, 220)
    return () => {
      cancelled = true
      clearTimeout(timer)
      renderTaskRef.current?.cancel?.()
    }
  }, [visible, aspect, zoom, pageIndex, pageWidth])

  const pageMarks = Object.values(marks).filter(
    m => m.kind === 'pdf' && m.pages?.some(p => p.page === pageIndex + 1),
  )

  return (
    <div
      className="pdf-page"
      ref={containerRef}
      data-page-index={pageIndex + 1}
      style={{ width: pageWidth, height: pageHeight }}
    >
      <canvas ref={canvasRef} className="pdf-canvas" style={{ width: '100%', height: '100%' }} />
      <div className="pdf-textlayer" ref={textLayerRef} />
      {/* 标注覆盖层（归一化矩形，随页面缩放） */}
      {aspect !== null &&
        pageMarks.map(m => {
          const group = m.pages!.find(p => p.page === pageIndex + 1)!
          const isFirstPage = m.pages![0].page === pageIndex + 1
          return group.rects.map((r, i) => (
            <div
              key={`${m.id}-${i}`}
              className={`mark-overlay d${Math.min(m.depth, 5)}`}
              data-mark-anchor={isFirstPage && i === 0 ? m.id : undefined}
              data-mark-id={m.id}
              style={{
                left: `${r.x * 100}%`,
                top: `${r.y * 100}%`,
                width: `${r.w * 100}%`,
                height: `${r.h * 100}%`,
              }}
            />
          ))
        })}
      {aspect !== null && (
        <div className="pdf-page-num">{pageIndex + 1}</div>
      )}
      {textReady ? null : <div className="pdf-page-ph" />}
    </div>
  )
}
