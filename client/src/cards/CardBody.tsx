import { useEffect, useRef } from 'react'
import type { Card } from '../types'
import { useStore } from '../store'
import { Markdown } from './Markdown'
import { findRangeByText, wrapRangeWithMark } from '../marks/wrapRange'

/** 卡片正文：主讲解 + 追问记录；DOM 稳定以保住内联标注 */
export function CardBody({ card }: { card: Card }) {
  const bodyRef = useRef<HTMLDivElement>(null)
  const followEndRef = useRef<HTMLDivElement>(null)
  const done = card.status === 'done'

  /* 主讲解渲染完成后：恢复（重载后的）本卡片内容上的标注 */
  useEffect(() => {
    if (card.status !== 'done' || !bodyRef.current) return
    const st = useStore.getState()
    const todo = Object.values(st.marks).filter(
      m => m.kind === 'card' && m.ownerCardId === card.id && !m.applied,
    )
    if (!todo.length) return
    const updates: Record<string, Partial<typeof todo[number]>> = {}
    for (const m of todo) {
      const range = findRangeByText(bodyRef.current, m.text)
      if (range) {
        const el = wrapRangeWithMark(range, m.id, m.depth)
        updates[m.id] = { applied: true, dangling: !el }
      } else {
        updates[m.id] = { applied: true, dangling: true }
      }
    }
    useStore.setState(s => {
      const marks = { ...s.marks }
      for (const [id, patch] of Object.entries(updates)) marks[id] = { ...marks[id], ...patch } as any
      return { marks, edgesVersion: s.edgesVersion + 1 }
    })
  }, [card.status, card.id])

  /* 追问进行中时保持其可见：立即对齐一次 + ResizeObserver 跟随正文增长
     （快速完成时多次 setState 可能合并，单靠 effect 会漏触发） */
  const hasPendingFollowup = card.followups.some(f => f.pending)
  useEffect(() => {
    if (!hasPendingFollowup) return
    if (followEndRef.current) useStore.getState().keepElementVisible(followEndRef.current)
    const body = bodyRef.current
    if (!body || typeof ResizeObserver === 'undefined') return
    const ro = new ResizeObserver(() => {
      if (followEndRef.current) useStore.getState().keepElementVisible(followEndRef.current)
    })
    ro.observe(body)
    return () => ro.disconnect()
  }, [hasPendingFollowup])

  return (
    <div
      className={`card-body selectable${done ? '' : ' streaming'}`}
      data-card-body={card.id}
      ref={bodyRef}
      style={{ fontSize: `${15 * card.fontScale}px` }}
    >
      <Markdown source={card.content} />
      {card.status === 'streaming' && !card.content && (
        <div className="card-loading">
          <span className="dot" /><span className="dot" /><span className="dot" />
          <em>正在组织讲解…</em>
        </div>
      )}
      {card.status === 'error' && (
        <div className="card-error">⚠️ {card.error || '生成失败，可从卡片菜单选择「重新讲解」'}</div>
      )}
      {card.followups.length > 0 && (
        <div className="followups">
          {card.followups.map((f, i) => (
            <div className="followup" key={i}>
              <div className="fu-q">问 · {f.q}</div>
              <div className="fu-a">
                <Markdown source={f.a} />
                {f.pending && !f.a && <div className="card-loading small"><span className="dot" /><span className="dot" /><span className="dot" /></div>}
              </div>
            </div>
          ))}
          <div ref={followEndRef} />
        </div>
      )}
      {card.memo?.related?.length ? (
        <div className="card-related">
          {card.memo.related.map(rid => (
            <button
              key={rid}
              className="related-chip"
              onClick={() => useStore.getState().locateCard(String(rid))}
            >
              ↗ 卡片#{rid}
            </button>
          ))}
        </div>
      ) : null}
    </div>
  )
}
