import { useEffect, useRef, useState } from 'react'
import * as pdfjsLib from 'pdfjs-dist'
import workerUrl from 'pdfjs-dist/build/pdf.worker.min.js?url'
import { useStore, pdfRef, DOC_WORLD_WIDTH } from '../store'
import { clamp } from '../geom'

pdfjsLib.GlobalWorkerOptions.workerSrc = workerUrl

/* 用 canvas 实测字体度量，得到「span 顶边到文字基线」的精确距离（line-height:1 下）。
   这样透明文本层的基线能与 PDF 位图的字形基线对齐，标注框才能贴合可见文字。 */
const bftCache = new Map<string, number>()
const measureCtx = typeof document !== 'undefined' ? document.createElement('canvas').getContext('2d') : null
function baselineFromTop(fs: number, fontFamily: string): number {
  const key = `${Math.round(fs * 10)}|${fontFamily}`
  const hit = bftCache.get(key)
  if (hit !== undefined) return hit
  let bft = fs * 0.85
  if (measureCtx) {
    try {
      measureCtx.font = `${fs}px ${fontFamily}`
      const m = measureCtx.measureText('Hg中')
      const asc = m.fontBoundingBoxAscent || fs * 0.86
      const desc = m.fontBoundingBoxDescent || fs * 0.14
      const lineBox = Math.max(fs, asc + desc)
      bft = (lineBox - asc - desc) / 2 + asc
    } catch { /* 保留兜底 */ }
  }
  bftCache.set(key, bft)
  return bft
}

/** 单页：位图（随缩放清晰化重渲）+ 自建文本层（支持划选）+ 标注覆盖层 */
export function PdfPage({ pageIndex }: { pageIndex: number }) {
  const containerRef = useRef<HTMLDivElement>(null)
  const canvasRef = useRef<HTMLCanvasElement>(null)
  const textLayerRef = useRef<HTMLDivElement>(null)
  const [pageSize, setPageSize] = useState<{ w: number; h: number } | null>(null)
  const [textReady, setTextReady] = useState(false)
  const [visible, setVisible] = useState(false)
  const zoom = useStore(s => s.viewport.scale)
  const marks = useStore(s => s.marks)
  const bumpEdges = useStore(s => s.bumpEdges)
  const renderTaskRef = useRef<any>(null)

  /* 可见性（视口外 ±700px 才渲染） */
  useEffect(() => {
    const el = containerRef.current
    if (!el) return
    const io = new IntersectionObserver(([entry]) => setVisible(entry.isIntersecting), {
      root: null,
      rootMargin: '700px',
    })
    io.observe(el)
    return () => io.disconnect()
  }, [])

  /* 文本层：构建一次（世界坐标，不随缩放重建） */
  useEffect(() => {
    let cancelled = false
    ;(async () => {
      const pdf = pdfRef.pdf
      if (!pdf || !textLayerRef.current) return
      try {
        const page = await pdf.getPage(pageIndex + 1)
        if (cancelled) return
        const base = page.getViewport({ scale: 1 })
        const s = DOC_WORLD_WIDTH / base.width
        const vp = page.getViewport({ scale: s })
        setPageSize({ w: vp.width, h: vp.height })
        const tc = await page.getTextContent()
        if (cancelled) return
        const layer = textLayerRef.current
        layer.innerHTML = ''
        const layerFont = getComputedStyle(layer).fontFamily || 'sans-serif'
        for (const it of tc.items as any[]) {
          if (!it.str) continue
          const t = it.transform
          const fs = Math.hypot(t[2], t[3]) * s
          const baselineY = vp.height - t[5] * s // 页顶到基线的距离
          const bft = baselineFromTop(fs, layerFont)
          const span = document.createElement('span')
          span.textContent = it.str
          span.style.cssText = [
            'position:absolute',
            'white-space:pre',
            'color:transparent',
            'transform-origin:0 0',
            `left:${(t[4] * s).toFixed(2)}px`,
            `top:${(baselineY - bft).toFixed(2)}px`,
            `font-size:${fs.toFixed(2)}px`,
          ].join(';')
          // 供标注框贴合计算使用
          span.dataset.fs = fs.toFixed(2)
          span.dataset.bft = bft.toFixed(2)
          layer.appendChild(span)
        }
        // 与实际字形宽度对齐（保证划选位置准确）
        const spans = [...layer.children] as HTMLElement[]
        for (let i = 0; i < spans.length; i++) {
          const it = tc.items[i]
          if (!it || !it.str) continue
          const w = spans[i].offsetWidth
          if (w > 0 && it.width) {
            const target = it.width * s
            if (Math.abs(target - w) > 0.5) {
              spans[i].style.transform = `scaleX(${(target / w).toFixed(4)})`
            }
          }
        }
        setTextReady(true)
        bumpEdges()
      } catch { /* 页面加载失败 */ }
    })()
    return () => { cancelled = true }
  }, [pageIndex, bumpEdges])

  /* 位图：可见时渲染，缩放变化后防抖重渲（保持清晰） */
  useEffect(() => {
    if (!visible || !pageSize) return
    let cancelled = false
    const timer = setTimeout(async () => {
      const pdf = pdfRef.pdf
      const canvas = canvasRef.current
      if (!pdf || !canvas || cancelled) return
      try {
        const page = await pdf.getPage(pageIndex + 1)
        if (cancelled) return
        const base = page.getViewport({ scale: 1 })
        const s = DOC_WORLD_WIDTH / base.width
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
    return () => { cancelled = true; clearTimeout(timer) }
  }, [visible, pageSize, zoom, pageIndex])

  const pageMarks = Object.values(marks).filter(
    m => m.kind === 'pdf' && m.pages?.some(p => p.page === pageIndex + 1),
  )

  return (
    <div
      className="pdf-page"
      ref={containerRef}
      data-page-index={pageIndex + 1}
      data-page-h={pageSize?.h || undefined}
      style={{ width: pageSize?.w, height: pageSize?.h }}
    >
      <canvas ref={canvasRef} className="pdf-canvas" style={{ width: '100%', height: '100%' }} />
      <div className="pdf-textlayer" ref={textLayerRef} style={{ width: pageSize?.w, height: pageSize?.h }} />
      {/* 标注覆盖层（归一化矩形，随页面缩放） */}
      {pageSize &&
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
      {pageSize && (
        <div className="pdf-page-num">{pageIndex + 1}</div>
      )}
      {textReady ? null : <div className="pdf-page-ph" />}
    </div>
  )
}
