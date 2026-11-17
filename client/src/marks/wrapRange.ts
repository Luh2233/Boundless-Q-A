// DOM 文本范围 → <mark> 标注 的封装与按文本重定位（刷新后恢复）

/** 在拆分节点之前记录偏移，避免 DOM 变动改变选区边界。 */
export function wrapRangeWithMark(range: Range, markId: string, depth: number): HTMLElement | null {
  const ancestor = range.commonAncestorContainer
  const walker = document.createTreeWalker(ancestor, NodeFilter.SHOW_TEXT)
  const nodes: Text[] = []
  if (ancestor instanceof Text) nodes.push(ancestor)
  else {
    let node: Node | null
    while ((node = walker.nextNode())) {
      if (range.intersectsNode(node)) nodes.push(node as Text)
    }
  }
  const slices = nodes.map(node => ({
    node,
    start: node === range.startContainer ? range.startOffset : 0,
    end: node === range.endContainer ? range.endOffset : node.length,
  }))
  let anchor: HTMLElement | null = null
  for (const { node, start, end } of slices) {
    if (!node.data.slice(start, end).trim()) continue
    if (end < node.length) node.splitText(end)
    const selected = start ? node.splitText(start) : node
    const mark = document.createElement('mark')
    mark.className = `cmark d${Math.min(depth, 5)}`
    mark.dataset.markId = markId
    selected.before(mark)
    mark.append(selected)
    anchor ??= mark
  }
  if (anchor) anchor.dataset.markAnchor = markId
  return anchor
}

export function unwrapMark(markId: string) {
  for (const mark of document.querySelectorAll(`[data-mark-id="${markId}"]`)) {
    mark.replaceWith(...mark.childNodes)
  }
}

const norm = (s: string) => s.replace(/\s+/g, '')

/** 在 root 内按纯文本查找 target（忽略空白差异），返回覆盖它的 Range；找不到返回 null */
export function findRangeByText(root: HTMLElement, target: string): Range | null {
  const t = norm(target)
  if (!t) return null
  const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT)
  const nodes: Text[] = []
  let n: Node | null
  while ((n = walker.nextNode())) {
    if ((n as Text).length) nodes.push(n as Text)
  }
  // 拼接所有文本并记录归一化偏移 → 节点的映射
  let acc = ''
  const map: { node: Text; normStart: number; normEnd: number }[] = []
  for (const node of nodes) {
    const s = norm(node.textContent || '')
    map.push({ node, normStart: acc.length, normEnd: acc.length + s.length })
    acc += s
  }
  const idx = acc.indexOf(t)
  if (idx < 0) return null
  const end = idx + t.length
  const range = document.createRange()
  let started = false
  for (const m of map) {
    if (m.normEnd <= idx || m.normStart >= end) continue
    // 计算该节点内的归一化起止
    const s0 = Math.max(0, idx - m.normStart)
    const s1 = Math.min(m.normEnd, end) - m.normStart
    // 归一化偏移 → 原始偏移（跳过空白字符）
    const raw = m.node.textContent || ''
    let ci = 0
    let rawStart = -1
    let rawEnd = raw.length
    for (let i = 0; i <= raw.length; i++) {
      if (i === raw.length || /\s/.test(raw[i])) continue
      if (ci === s0) rawStart = i
      if (ci === s1 - 1) {
        rawEnd = i + 1
        break
      }
      ci++
    }
    if (rawStart < 0) rawStart = 0
    if (!started) {
      range.setStart(m.node, rawStart)
      started = true
    }
    range.setEnd(m.node, rawEnd)
  }
  return started ? range : null
}
