import { useStore } from '../store'
import { pdfRef } from '../store'
import { PdfPage } from './PdfPage'
import { useEffect, useState } from 'react'

/** 画布上的 PDF 文档节点：标题栏（拖拽柄）+ 逐页渲染 */
export function PdfNode() {
  const doc = useStore(s => s.doc)
  const pdfNode = useStore(s => s.pdfNode)
  const movePdfNode = useStore(s => s.movePdfNode)
  const [numPages, setNumPages] = useState(0)
  const [dragging, setDragging] = useState(false)

  useEffect(() => {
    setNumPages(pdfRef.pdf?.numPages || 0)
  }, [doc?.id])

  if (!doc) return null

  const onHeaderDown = (e: React.PointerEvent) => {
    if (e.button !== 0) return
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
      style={{ left: pdfNode.x, top: pdfNode.y, width: pdfNode.width }}
    >
      <div className={`pdf-head${dragging ? ' dragging' : ''}`} onPointerDown={onHeaderDown}>
        <span className="pdf-grip">⠿</span>
        <span className="pdf-title">{doc.title}</span>
        <span className="pdf-meta">{numPages} 页 · 划选文字即可生成讲解</span>
      </div>
      <div className="pdf-pages">
        {Array.from({ length: numPages }, (_, i) => (
          <PdfPage key={i} pageIndex={i} />
        ))}
      </div>
    </div>
  )
}
