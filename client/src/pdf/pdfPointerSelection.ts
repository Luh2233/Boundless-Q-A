interface TextRun {
  node: Text
  box: DOMRect
}

function textRuns(layer: HTMLElement): TextRun[] {
  return Array.from(layer.querySelectorAll('span')).flatMap(span => {
    const node = span.firstChild
    if (!(node instanceof Text) || !node.data.trim()) return []
    const range = document.createRange()
    range.selectNodeContents(node)
    const box = range.getBoundingClientRect()
    return box.width && box.height ? [{ node, box }] : []
  })
}

function hitText(runs: TextRun[], x: number, y: number, starting: boolean) {
  let nearest: TextRun | undefined
  let best = Infinity
  for (const run of runs) {
    const { box } = run
    const dx = Math.max(box.left - x, x - box.right, 0)
    const dy = Math.max(box.top - y, y - box.bottom, 0)
    if (starting && (dx > 6 || dy > 4)) continue
    // Prefer a run on the current line over a nearby run on another line.
    const score = Math.hypot(dx, dy * 8) + Math.abs(y - (box.top + box.bottom) / 2) * 0.05
    if (score < best) { best = score; nearest = run }
  }
  if (!nearest) return null

  const { node } = nearest
  const range = document.createRange()
  const caret = (offset: number) => {
    range.setStart(node, offset)
    range.collapse(true)
    return range.getBoundingClientRect()
  }
  const first = caret(0)
  const last = caret(node.length)
  const vertical = Math.abs(last.y - first.y) > Math.abs(last.x - first.x)
  const coord = (box: DOMRect) => vertical ? box.y : box.x
  const direction = coord(last) >= coord(first) ? 1 : -1
  const point = (vertical ? y : x) * direction
  let low = 0
  let high = node.length
  while (low < high) {
    const mid = Math.floor((low + high) / 2)
    if (coord(caret(mid)) * direction < point) low = mid + 1
    else high = mid
  }
  if (low && Math.abs(coord(caret(low - 1)) * direction - point) < Math.abs(coord(caret(low)) * direction - point)) low--
  return { node, offset: low }
}

/** Use PDF text geometry for drag endpoints, including when the pointer crosses whitespace. */
export function bindPdfSelection(reader: HTMLElement) {
  let stop: (() => void) | undefined
  const start = (event: PointerEvent) => {
    if (event.pointerType !== 'mouse' || event.button !== 0 || event.detail > 1 ||
        event.shiftKey || reader.closest('.space-pan') || !(event.target instanceof Element)) return
    const layer = event.target.closest<HTMLElement>('.pdf-textlayer')
    if (!layer) return
    const origin = hitText(textRuns(layer), event.clientX, event.clientY, true)
    if (!origin) {
      event.preventDefault()
      document.getSelection()?.removeAllRanges()
      return
    }
    const selection = document.getSelection()
    if (!selection) return
    stop?.()
    event.preventDefault()
    selection.collapse(origin.node, origin.offset)
    const pointerId = event.pointerId
    const move = (e: PointerEvent) => {
      if (e.pointerId !== pointerId || !origin.node.isConnected) return
      const target = document.elementFromPoint(e.clientX, e.clientY)
      const page = target?.closest('[data-page-index]')
      const targetLayer = page?.querySelector<HTMLElement>('.pdf-textlayer')
      if (!targetLayer || !reader.contains(targetLayer)) return
      const end = hitText(textRuns(targetLayer), e.clientX, e.clientY, false)
      if (end) selection.setBaseAndExtent(origin.node, origin.offset, end.node, end.offset)
    }
    const finish = (e: PointerEvent) => { if (e.pointerId === pointerId) stop?.() }
    stop = () => {
      window.removeEventListener('pointermove', move)
      window.removeEventListener('pointerup', finish)
      window.removeEventListener('pointercancel', finish)
      window.removeEventListener('blur', stop!)
      stop = undefined
    }
    window.addEventListener('pointermove', move)
    window.addEventListener('pointerup', finish)
    window.addEventListener('pointercancel', finish)
    window.addEventListener('blur', stop)
  }
  reader.addEventListener('pointerdown', start)
  return () => { stop?.(); reader.removeEventListener('pointerdown', start) }
}
