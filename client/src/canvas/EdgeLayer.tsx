import { useEffect, useState } from 'react'
import { useStore } from '../store'
import { elWorldRect, clamp } from '../geom'

interface EdgePath {
  id: string
  markId: string
  cardId: string
  d: string
  ax: number
  ay: number
  bx: number
  by: number
}

function computeEdges(): EdgePath[] {
  const { marks, cards, viewport } = useStore.getState()
  const out: EdgePath[] = []
  for (const m of Object.values(marks)) {
    if (!m.targetCardId) continue
    const card = cards[m.targetCardId]
    if (!card) continue
    const cardEl = document.querySelector(`[data-card-root="${card.id}"]`)
    if (!cardEl) continue

    let anchorEl = document.querySelector(`[data-mark-anchor="${m.id}"]`)
    // card 标注丢失（未重定位）→ 退化为从宿主卡片左缘出发
    if (!anchorEl && m.kind === 'card' && m.ownerCardId) {
      const owner = document.querySelector(`[data-card-root="${m.ownerCardId}"]`)
      if (owner) anchorEl = owner
    }
    if (!anchorEl) continue

    const a = elWorldRect(anchorEl, viewport)
    const c = elWorldRect(cardEl, viewport)
    const sourceCenter = a.x + a.w / 2
    const targetCenter = c.x + c.w / 2
    const direction = targetCenter >= sourceCenter ? 1 : -1
    const ax = direction === 1 ? a.x + a.w : a.x
    const clip = anchorEl.closest('.card-body-wrap, .pdf-pages')
    const visible = clip ? elWorldRect(clip, viewport) : null
    if (m.kind === 'pdf' && visible && (a.y + a.h <= visible.y || a.y >= visible.y + visible.h)) continue
    const ay = visible ? clamp(a.y + a.h + (m.kind === 'pdf' ? 0 : 3), visible.y, visible.y + visible.h) : a.y + a.h / 2
    const bx = direction === 1 ? c.x - 2 : c.x + c.w + 2
    const by = clamp(ay, c.y + 22, c.y + c.h - 16)
    const owner = visible ? anchorEl.closest('[data-card-root], [data-pdf-root]') : null
    const ownerRect = owner ? elWorldRect(owner, viewport) : null
    const exit = ownerRect ? (direction === 1 ? ownerRect.x + ownerRect.w : ownerRect.x) : ax
    const bend = direction * (bx - exit) > 12 ? exit : ax
    const cp = Math.max(18, Math.abs(bx - bend) * 0.42) * direction
    out.push({
      id: m.id,
      markId: m.id,
      cardId: card.id,
      d: `M ${ax.toFixed(1)} ${ay.toFixed(1)} H ${bend.toFixed(1)} C ${(bend + cp).toFixed(1)} ${ay.toFixed(1)}, ${(bx - cp).toFixed(1)} ${by.toFixed(1)}, ${bx.toFixed(1)} ${by.toFixed(1)}`,
      ax, ay, bx, by,
    })
  }
  return out
}

/** 标注 → 讲解卡片 的虚线关联层（世界坐标，随画布缩放） */
export function EdgeLayer() {
  const edgesVersion = useStore(s => s.edgesVersion)
  const hover = useStore(s => s.hover)
  const [paths, setPaths] = useState<EdgePath[]>([])

  useEffect(() => {
    const raf = requestAnimationFrame(() => setPaths(computeEdges()))
    return () => cancelAnimationFrame(raf)
  }, [edgesVersion])

  // 卡片尺寸变化（内容增长/加宽）也刷新
  useEffect(() => {
    const ro = new ResizeObserver(() => useStore.getState().bumpEdges())
    ro.observe(document.body)
    const t = setTimeout(() => useStore.getState().bumpEdges(), 600)
    return () => { ro.disconnect(); clearTimeout(t) }
  }, [])

  return (
    <svg aria-hidden="true" className="edge-layer" style={{ overflow: 'visible' }}>
      {paths.map(p => {
        const active = hover?.cardId === p.cardId || hover?.markId === p.markId
        return (
          <g key={p.id} data-edge-card={p.cardId} className={`edge${active ? ' active' : ''}`}>
            <path d={p.d} />
            <circle cx={p.ax} cy={p.ay} r={3.2} className="edge-dot" />
            <circle cx={p.bx} cy={p.by} r={2.4} className="edge-dot end" />
          </g>
        )
      })}
      <g className="closing-edges" />
    </svg>
  )
}
