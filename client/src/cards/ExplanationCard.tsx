import { useEffect, useRef, useState } from 'react'
import type { Card } from '../types'
import { useStore } from '../store'
import { CardBody } from './CardBody'

/** 讲解卡片：头部=拖拽柄，正文=可选区（划词再讲解），Ctrl+滚轮=卡片自身缩放 */
export function ExplanationCard({ card }: { card: Card }) {
  const setHover = useStore(s => s.setHover)
  const moveCard = useStore(s => s.moveCard)
  const resizeCard = useStore(s => s.resizeCard)
  const setCardFontScale = useStore(s => s.setCardFontScale)
  const followup = useStore(s => s.followup)
  const deleteCard = useStore(s => s.deleteCard)
  const reExplain = useStore(s => s.reExplain)
  const locateMark = useStore(s => s.locateMark)
  const cardMenuFor = useStore(s => s.cardMenuFor)
  const setCardMenuFor = useStore(s => s.setCardMenuFor)
  const [dragging, setDragging] = useState(false)
  const inputRef = useRef<HTMLInputElement>(null)
  const [q, setQ] = useState('')
  const menuOpen = cardMenuFor === card.id

  const onHeadDown = (e: React.PointerEvent) => {
    if (e.button !== 0) return
    if ((e.target as HTMLElement).closest('button')) return
    e.preventDefault()
    setDragging(true)
    const sx = e.clientX
    const sy = e.clientY
    const v0 = { ...useStore.getState().viewport }
    const p0 = { x: card.x, y: card.y }
    const move = (ev: PointerEvent) => {
      moveCard(card.id, p0.x + (ev.clientX - sx) / v0.scale, p0.y + (ev.clientY - sy) / v0.scale)
    }
    const up = () => {
      setDragging(false)
      window.removeEventListener('pointermove', move)
      window.removeEventListener('pointerup', up)
    }
    window.addEventListener('pointermove', move)
    window.addEventListener('pointerup', up)
  }

  const onResizeDown = (e: React.PointerEvent) => {
    if (e.button !== 0) return
    e.preventDefault()
    e.stopPropagation()
    const sx = e.clientX
    const v0 = { ...useStore.getState().viewport }
    const w0 = card.width
    const move = (ev: PointerEvent) => resizeCard(card.id, w0 + (ev.clientX - sx) / v0.scale)
    const up = () => {
      window.removeEventListener('pointermove', move)
      window.removeEventListener('pointerup', up)
    }
    window.addEventListener('pointermove', move)
    window.addEventListener('pointerup', up)
  }

  /* 卡片独立缩放：原生捕获监听（React 合成滚轮在 root 委托，晚于 stage 的原生监听，
     无法拦截；捕获阶段 stopPropagation 才能只缩卡片不缩画布） */
  const rootRef = useRef<HTMLDivElement>(null)
  useEffect(() => {
    const el = rootRef.current
    if (!el) return
    const onWheel = (e: WheelEvent) => {
      if (!(e.ctrlKey || e.metaKey || e.altKey)) return
      e.preventDefault()
      e.stopPropagation()
      setCardFontScale(card.id, e.deltaY < 0 ? 0.1 : -0.1)
    }
    el.addEventListener('wheel', onWheel, { capture: true, passive: false })
    return () => el.removeEventListener('wheel', onWheel, { capture: true })
  }, [card.id, setCardFontScale])

  const sendFollowup = () => {
    const question = q.trim()
    if (!question || card.status !== 'done') return
    setQ('')
    followup(card.id, question)
  }

  const depth = Math.min(card.depth, 5)
  const title =
    card.status === 'streaming' ? '正在讲解…'
    : card.status === 'loading' ? '准备中…'
    : card.title || `讲解 #${card.id}`

  return (
    <div
      ref={rootRef}
      className={`card d${depth}${dragging ? ' dragging' : ''}${menuOpen ? ' menu-open' : ''}`}
      data-card-root={card.id}
      style={{ left: card.x, top: card.y, width: card.width }}
      onPointerEnter={() => setHover({ cardId: card.id })}
      onPointerLeave={() => setHover(null)}
    >
      <div className="card-head" onPointerDown={onHeadDown}>
        <span className={`card-dot d${depth}`} />
        <span className="card-title" title={title}>{title}</span>
        <div className="card-actions">
          <button className="icon-btn" title="缩小文字"
            onMouseDown={e => e.stopPropagation()}
            onClick={() => setCardFontScale(card.id, -0.1)}>－</button>
          <span className="card-zoom">{Math.round(card.fontScale * 100)}%</span>
          <button className="icon-btn" title="放大文字"
            onMouseDown={e => e.stopPropagation()}
            onClick={() => setCardFontScale(card.id, 0.1)}>＋</button>
          <button className="icon-btn more" title="更多"
            onMouseDown={e => e.stopPropagation()}
            onClick={() => setCardMenuFor(menuOpen ? null : card.id)}>⋯</button>
        </div>
      </div>

      {menuOpen && (
        <div className="card-menu" onMouseDown={e => e.stopPropagation()}>
          {card.sourceMarkId && (
            <button onClick={() => { locateMark(card.sourceMarkId!); setCardMenuFor(null) }}>⌖ 定位原文标注</button>
          )}
          <button onClick={() => reExplain(card.id)}>↻ 重新讲解</button>
          <button className="danger" onClick={() => deleteCard(card.id)}>✕ 删除卡片与标注</button>
        </div>
      )}

      <div className="card-body-wrap">
        <CardBody card={card} />
      </div>

      {card.status === 'done' && (
        <div className="card-foot">
          <input
            ref={inputRef}
            value={q}
            placeholder="向这张讲解追问…（回车发送）"
            onChange={e => setQ(e.target.value)}
            onKeyDown={e => {
              if (e.key === 'Enter') { e.stopPropagation(); sendFollowup() }
              e.stopPropagation()
            }}
          />
          <button className="send-btn" onClick={sendFollowup} disabled={!q.trim()}>发送</button>
        </div>
      )}

      <div className="card-resize" onPointerDown={onResizeDown} />
    </div>
  )
}
