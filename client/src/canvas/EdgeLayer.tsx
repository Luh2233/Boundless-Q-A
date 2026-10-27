import { useEffect, useState } from 'react'
import { useStore } from '../store'
import { elWorldRect, clamp } from '../geom'

interface EdgePath {
  id: string
  markId: string
  cardId: string
  depth: number
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
    const ax = a.x + a.w / 2 < c.x ? a.x + a.w : a.x
    const ay = a.y + a.h / 2
    const bx = ax < c.x ? c.x - 5 : c.x + c.w + 5
    const by = clamp(ay, c.y + 26, c.y + Math.max(52, c.h - 26))
    const cp = Math.max(36, Math.abs(bx - ax) * 0.45)
    out.push({
      id: m.id,
      markId: m.id,
      cardId: card.id,
      depth: m.depth,
      d: `M ${ax.toFixed(1)} ${ay.toFixed(1)} C ${(ax + cp).toFixed(1)} ${ay.toFixed(1)}, ${(bx - cp).toFixed(1)} ${by.toFixed(1)}, ${bx.toFixed(1)} ${by.toFixed(1)}`,
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
    <svg className="edge-layer" style={{ overflow: 'visible' }}>
      {paths.map(p => {
        const active = hover?.cardId === p.cardId || hover?.markId === p.markId
        return (
          <g
            key={p.id}
            className={`edge d${Math.min(p.depth, 5)}${active ? ' active' : ''}`}
            onPointerEnter={() => useStore.getState().setHover({ markId: p.markId, cardId: p.cardId })}
            onPointerLeave={() => useStore.getState().setHover(null)}
          >
            <path d={p.d} />
            <circle cx={p.ax} cy={p.ay} r={3.2} className="edge-dot" />
            <circle cx={p.bx} cy={p.by} r={2.4} className="edge-dot end" />
          </g>
        )
      })}
    </svg>
  )
}
