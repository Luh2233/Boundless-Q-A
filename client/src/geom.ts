import type { Viewport } from './types'

export function getStage(): HTMLElement {
  return document.getElementById('stage')!
}

/** 屏幕坐标（clientX/Y）→ 画布世界坐标 */
export function screenToWorld(px: number, py: number, vp: Viewport) {
  const r = getStage().getBoundingClientRect()
  return {
    x: (px - r.left - vp.x) / vp.scale,
    y: (py - r.top - vp.y) / vp.scale,
  }
}

/** 元素当前屏幕矩形 → 世界坐标矩形 */
export function elWorldRect(el: Element, vp: Viewport) {
  const r = el.getBoundingClientRect()
  const s = getStage().getBoundingClientRect()
  return {
    x: (r.left - s.left - vp.x) / vp.scale,
    y: (r.top - s.top - vp.y) / vp.scale,
    w: r.width / vp.scale,
    h: r.height / vp.scale,
  }
}

export const clamp = (v: number, min: number, max: number) => Math.min(max, Math.max(min, v))
