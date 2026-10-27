/**
 * 纯文本工具：无 DOM、无状态，便于单元测试。
 */

export interface Squeezed {
  text: string
  /** 归一化下标 → 原文下标；长度 = text.length + 1（末位是 src.length 哨兵） */
  map: number[]
}

/** 去掉全部空白，并记录每个字符在原文中的位置。 */
export function squeeze(src: string): Squeezed {
  let text = ''
  const map: number[] = []
  for (let i = 0; i < src.length; i += 1) {
    const ch = src[i]
    if (!/\s/.test(ch)) {
      text += ch
      map.push(i)
    }
  }
  map.push(src.length)
  return { text, map }
}

/**
 * 取选段在原文中的前后文。
 *
 * 检索时忽略空白（PDF 文本层里换行/断字位置与用户选区可能不一致），
 * 但**返回的是原文切片**——早期实现直接返回归一化后的字符串，会把英文单词
 * 之间的空格全部吃掉（"gradually reversing" → "graduallyreversing"），
 * 送给模型的上下文质量因此明显下降。
 */
export function contextAround(fullText: string, sel: string, radius = 420): string {
  if (!fullText) return ''
  const probe = squeeze(sel).text.slice(0, 36)
  if (!probe) return ''

  const { text: flat, map } = squeeze(fullText)
  const at = flat.indexOf(probe)
  if (at < 0) return fullText.slice(0, radius * 2)

  const from = map[Math.max(0, at - radius)]
  const to = map[Math.min(flat.length, at + probe.length + radius)]
  return fullText.slice(from, to)
}
