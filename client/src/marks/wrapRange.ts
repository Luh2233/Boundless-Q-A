// DOM 文本范围 → <mark> 标注 的封装与按文本重定位（刷新后恢复）

function covered(range: Range, node: Text): boolean {
  const r = document.createRange()
  r.selectNodeContents(node)
  return (
    range.compareBoundaryPoints(Range.START_TO_START, r) <= 0 &&
    range.compareBoundaryPoints(Range.END_TO_END, r) >= 0
  )
}

/**
 * 把 range 覆盖的文本节点包裹成 <mark class="cmark" data-mark-id>
 * 返回第一个（DOM 顺序）标注元素，供关联线锚定。
 */
export function wrapRangeWithMark(range: Range, markId: string, depth: number): HTMLElement | null {
  const cac = range.commonAncestorContainer
  const root = (cac.nodeType === 3 ? (cac as Text).parentNode : cac) as HTMLElement
  if (!root) return null
  const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT, {
    acceptNode: n => ((n as Text).length ? NodeFilter.FILTER_ACCEPT : NodeFilter.FILTER_REJECT),
  })
  const inside: Text[] = []
  let n: Node | null
  while ((n = walker.nextNode())) {
    const t = n as Text
    if (range.intersectsNode(t)) inside.push(t)
  }
  if (!inside.length) return null

  // 拆分首尾边界（splitText 会自动调整 range 的边界点）
  const sc = range.startContainer
  if (sc.nodeType === 3) {
    const i = inside.indexOf(sc as Text)
    if (i >= 0 && range.startOffset > 0) {
      const t = sc as Text
      const right = t.splitText(range.startOffset)
      inside[i] = right
    }
  }
  const ec = range.endContainer
  if (ec.nodeType === 3) {
    const i = inside.indexOf(ec as Text)
    if (i >= 0) {
      const t = ec as Text
      if (range.endOffset < t.length) t.splitText(range.endOffset)
    }
  }

  const wrapped: HTMLElement[] = []
  for (const t of inside) {
    if (!t.parentNode || !t.textContent || !t.textContent.trim()) continue
    if (!covered(range, t)) continue
    const mark = document.createElement('mark')
    mark.className = `cmark d${Math.min(depth, 5)}`
    mark.dataset.markId = markId
    t.parentNode.insertBefore(mark, t)
    mark.appendChild(t)
    wrapped.push(mark)
  }
  if (wrapped.length) wrapped[0].dataset.markAnchor = markId
  return wrapped[0] || null
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
