/**
 * PDF 划选的几何换算：把浏览器选区矩形换算成「相对页面的归一化墨迹带」。
 *
 * 分两层：
 * - 纯函数（inkBand / toNormalizedRect）不碰 DOM，可单测；
 * - buildPdfMarkFromRange 负责读 DOM 上的字体度量与页面几何。
 *
 * 为什么要收紧到「墨迹带」：选区给出的是行盒（line box），其高度由字体
 * ascent/descent 决定，比字形实际占据的范围高。直接画框会在文字上下留白、
 * 并把 g/y/p 的下伸部裁掉。这里用 canvas 实测得到的基线偏移 bft，把矩形
 * 收到基线以上 0.79em（CJK 0.88em）、基线以下 0.235em（CJK 0.15em）。
 */
import type { PdfMarkPage, RectN } from '../types'

export const INK = {
  latinUp: 0.79,
  latinDown: 0.235,
  cjkUp: 0.88,
  cjkDown: 0.15,
} as const

const CJK_RE = /[\u4e00-\u9fff\u3040-\u30ff\u3000-\u303f]/

export interface Box {
  left: number
  top: number
  right: number
  bottom: number
}

/** 屏幕像素下的字体度量（已乘过缩放系数 k）。 */
export interface InkMetrics {
  /** 字号（屏幕 px） */
  fs: number
  /** 行盒顶 → 文字基线 的距离（屏幕 px） */
  bft: number
  cjk: boolean
}

export interface PageBox extends Box {
  /** 1-based 页码 */
  page: number
  /** PDF 世界坐标下的页面高度，用于求「屏幕 px / 世界 px」 */
  worldHeight: number
}

export interface AnchorRect {
  left: number
  top: number
  width: number
  height: number
}

export interface PdfMarkBuilt {
  pages: PdfMarkPage[]
  /** 选区首个矩形的屏幕位置，用于决定卡片落点 */
  anchor: AnchorRect
}

export function isCjk(text: string): boolean {
  return CJK_RE.test(text)
}

/** 选区矩形 → 字形墨迹带（屏幕坐标）。 */
export function inkBand(box: Box, m: InkMetrics): { top: number; height: number } {
  const up = m.cjk ? INK.cjkUp : INK.latinUp
  const down = m.cjk ? INK.cjkDown : INK.latinDown
  const baseline = box.top + m.bft
  return { top: baseline - up * m.fs, height: (up + down) * m.fs }
}

/** 单个选区矩形 → 相对页面的归一化矩形。metrics 为 null 时退化为行盒。 */
export function toNormalizedRect(box: Box, page: PageBox, metrics: InkMetrics | null): RectN {
  const width = page.right - page.left
  const height = page.bottom - page.top
  const band = metrics && metrics.fs > 0 && metrics.bft > 0
    ? inkBand(box, metrics)
    : { top: box.top, height: box.bottom - box.top }

  // 横向内收取两侧侧轴承留白
  const padX = metrics && page.worldHeight > 0 && metrics.fs > 0 ? Math.min(3, 0.07 * metrics.fs) : 0

  return {
    x: (box.left - page.left + padX) / width,
    y: (band.top - page.top) / height,
    w: Math.max(box.right - box.left - 2 * padX, 2) / width,
    h: band.height / height,
  }
}

function overlapArea(a: Box, b: Box): number {
  const ix = Math.max(0, Math.min(a.right, b.right) - Math.max(a.left, b.left))
  const iy = Math.max(0, Math.min(a.bottom, b.bottom) - Math.max(a.top, b.top))
  return ix * iy
}

function readPageBox(el: HTMLElement): PageBox {
  const r = el.getBoundingClientRect()
  return {
    page: Number(el.dataset.pageIndex) || 0,
    left: r.left,
    top: r.top,
    right: r.right,
    bottom: r.bottom,
    worldHeight: parseFloat(el.dataset.pageH || '') || 0,
  }
}

/**
 * 从浏览器选区构建 PDF 标注。选区完全落在页面外的部分会被丢弃；
 * 页码取自 [data-page-index]，字体度量取自 [data-bft]（PdfPage 写入）。
 */
export function buildPdfMarkFromRange(range: Range, text: string): PdfMarkBuilt | null {
  const rects = [...range.getClientRects()].filter(r => r.width > 1 && r.height > 1)
  if (!rects.length) return null

  const boxes = [...document.querySelectorAll<HTMLElement>('[data-page-index]')]
    .map(readPageBox)
    .filter(b => b.page > 0)
  if (!boxes.length) return null

  const startEl = range.startContainer.nodeType === 3
    ? range.startContainer.parentElement
    : (range.startContainer as HTMLElement | null)
  const span = startEl?.closest('[data-bft]') as HTMLElement | null
  const fsWorld = span ? parseFloat(span.dataset.fs || '') || 0 : 0
  const bftWorld = span ? parseFloat(span.dataset.bft || '') || 0 : 0
  const cjk = isCjk(text)

  const groups = new Map<number, RectN[]>()
  for (const r of rects) {
    let best: PageBox | null = null
    let bestArea = 0
    for (const p of boxes) {
      const area = overlapArea(r, p)
      if (area > bestArea) {
        bestArea = area
        best = p
      }
    }
    // 归属判据：与页面重叠面积至少占矩形 30%
    if (!best || bestArea < r.width * r.height * 0.3) continue

    const k = best.worldHeight ? (best.bottom - best.top) / best.worldHeight : 0
    const metrics: InkMetrics | null = k > 0 && fsWorld > 0 && bftWorld > 0
      ? { fs: fsWorld * k, bft: bftWorld * k, cjk }
      : null

    const arr = groups.get(best.page) ?? []
    arr.push(toNormalizedRect(r, best, metrics))
    groups.set(best.page, arr)
  }
  if (!groups.size) return null

  const pages = [...groups.entries()]
    .sort((a, b) => a[0] - b[0])
    .map(([page, rs]) => ({ page, rects: rs }))

  return { pages, anchor: rects[0] }
}
