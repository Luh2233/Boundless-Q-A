import type { PdfMarkPage, RectN } from '../types'

export interface AnchorRect {
  left: number
  top: number
  width: number
  height: number
}

export interface PdfMarkBuilt {
  pages: PdfMarkPage[]
  anchor: AnchorRect
}

export function buildPdfMarkFromRange(range: Range): PdfMarkBuilt | null {
  const root = (range.startContainer instanceof Element
    ? range.startContainer : range.startContainer.parentElement)?.closest('[data-pdf-root]')
  if (!root) return null

  const pages: PdfMarkPage[] = []
  let anchor: AnchorRect | undefined
  for (const layer of root.querySelectorAll('.pdf-textlayer')) {
    if (!range.intersectsNode(layer)) continue
    const page = Number(layer.closest<HTMLElement>('[data-page-index]')?.dataset.pageIndex)
    const bounds = layer.getBoundingClientRect()
    if (!page || !bounds.width || !bounds.height) continue

    const rects: RectN[] = []
    const walker = document.createTreeWalker(layer, NodeFilter.SHOW_TEXT)
    for (let node = walker.nextNode(); node; node = walker.nextNode()) {
      if (!node.textContent?.trim() || !range.intersectsNode(node)) continue
      const fragment = document.createRange()
      fragment.selectNodeContents(node)
      if (node === range.startContainer) fragment.setStart(node, range.startOffset)
      if (node === range.endContainer) fragment.setEnd(node, range.endOffset)
      if (!fragment.toString().trim()) continue
      for (const box of fragment.getClientRects()) {
        const left = Math.max(bounds.left, box.left)
        const top = Math.max(bounds.top, box.top)
        const width = Math.min(bounds.right, box.right) - left
        const height = Math.min(bounds.bottom, box.bottom) - top
        if (width <= 0 || height <= 0) continue
        rects.push({
          x: (left - bounds.left) / bounds.width,
          y: (top - bounds.top) / bounds.height,
          w: width / bounds.width,
          h: height / bounds.height,
        })
        anchor ??= { left, top, width, height }
      }
    }
    if (rects.length) pages.push({ page, rects })
  }
  return anchor ? { pages, anchor } : null
}
