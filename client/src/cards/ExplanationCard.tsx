import { useEffect, useRef, useState } from 'react'
import type { Card } from '../types'
import { useStore } from '../store'
import { CardBody } from './CardBody'
import { useLibrary } from '../knowledge/library'
import { animateBranchClose } from './animateBranchClose'

const resizeHandles = [
  ['left', -1, 0], ['right', 1, 0], ['top', 0, -1], ['bottom', 0, 1],
  ['top left corner', -1, -1], ['top right corner', 1, -1],
  ['bottom left corner', -1, 1], ['bottom right corner', 1, 1],
] as const

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
  const bumpEdges = useStore(s => s.bumpEdges)
  const [q, setQ] = useState('')
  const active = useStore(s => s.activeCardId === card.id)
  const menuOpen = cardMenuFor === card.id

  const onHeadDown = (e: React.PointerEvent) => {
    if (e.button !== 0) return
    if ((e.target as HTMLElement).closest('button') || e.currentTarget.closest('.space-pan')) return
    e.stopPropagation()
    document.getSelection()?.removeAllRanges()
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
      window.removeEventListener('pointercancel', up)
    }
    window.addEventListener('pointermove', move)
    window.addEventListener('pointerup', up)
    window.addEventListener('pointercancel', up)
  }

  const onResizeDown = (e: React.PointerEvent<HTMLDivElement>, horizontal: number, vertical: number) => {
    const root = rootRef.current
    if (!root || e.button !== 0) return
    e.preventDefault()
    e.stopPropagation()
    document.getSelection()?.removeAllRanges()
    useStore.getState().setSelectionToolbar(null)

    const handle = e.currentTarget
    const { clientX, clientY, pointerId } = e
    const { scale } = useStore.getState().viewport
    const initialHeight = root.getBoundingClientRect().height / scale
    handle.setPointerCapture(pointerId)
    const move = (event: PointerEvent) => {
      if (event.pointerId !== pointerId) return
      resizeCard(card.id, {
        width: horizontal ? card.width + horizontal * (event.clientX - clientX) / scale : undefined,
        height: vertical ? initialHeight + vertical * (event.clientY - clientY) / scale : undefined,
        fixedRight: horizontal < 0 ? card.x + card.width : undefined,
        fixedBottom: vertical < 0 ? card.y + initialHeight : undefined,
      })
    }
    const stop = () => {
      handle.removeEventListener('pointermove', move)
      handle.removeEventListener('lostpointercapture', stop)
    }
    handle.addEventListener('pointermove', move)
    handle.addEventListener('lostpointercapture', stop)
  }

  /* 卡片独立缩放：原生捕获监听（React 合成滚轮在 root 委托，晚于 stage 的原生监听，
     无法拦截；捕获阶段 stopPropagation 才能只缩卡片不缩画布） */
  const rootRef = useRef<HTMLDivElement>(null)
  useEffect(() => {
    const el = rootRef.current
    if (!el) return
    const ro = new ResizeObserver(bumpEdges)
    ro.observe(el)
    const onWheel = (e: WheelEvent) => {
      if (!(e.ctrlKey || e.metaKey || e.altKey)) {
        if (e.target instanceof Element && e.target.closest('.card-body-wrap')) e.stopPropagation()
        return
      }
      e.preventDefault()
      e.stopPropagation()
      setCardFontScale(card.id, e.deltaY < 0 ? 0.1 : -0.1)
    }
    el.addEventListener('wheel', onWheel, { capture: true, passive: false })
    return () => {
      el.removeEventListener('wheel', onWheel, { capture: true })
      ro.disconnect()
    }
  }, [card.id, setCardFontScale, bumpEdges])

  const sendFollowup = () => {
    const question = q.trim()
    if (!question || card.status !== 'done') return
    setQ('')
    followup(card.id, question)
  }

  const close = () => {
    const restoreFocus = rootRef.current?.contains(document.activeElement)
    const stage = rootRef.current?.closest('#stage')
    deleteCard(card.id, branch => {
      if (stage) animateBranchClose(stage, branch)
    })
    if (!restoreFocus) return
    requestAnimationFrame(() => {
      if (document.activeElement !== document.body) return
      const parent = card.parentId && stage?.querySelector<HTMLElement>(`[data-card-root="${card.parentId}"] .card-title`)
      const fallback = document.querySelector<HTMLElement>('.question-form input') ?? document.querySelector<HTMLElement>('.brand')
      const next = parent || fallback
      next?.focus({ preventScroll: true })
    })
  }

  const depth = Math.min(card.depth, 5)
  const title = card.title || card.sourceText || '讲解'

  return (
    <div
      ref={rootRef}
      className={`card d${depth}${dragging ? ' dragging' : ''}${active ? ' card-active' : ''}${menuOpen ? ' menu-open' : ''}`}
      data-card-root={card.id}
      style={{ left: card.x, top: card.y, width: card.width, height: card.height }}
      onPointerDownCapture={() => useStore.setState({ activeCardId: card.id })}
      onPointerEnter={() => setHover({ cardId: card.id })}
      onPointerLeave={() => setHover(null)}
    >
      <div className="card-head" onPointerDown={onHeadDown}>
        <span className={`card-dot d${depth}`} />
        <span className="card-title" tabIndex={-1} title={title}>{title}</span>
        <div className="card-actions">
          <button className="icon-btn more" title="更多" aria-label="更多选项" aria-expanded={menuOpen}
            onClick={() => setCardMenuFor(menuOpen ? null : card.id)}>
            <svg aria-hidden="true" viewBox="0 0 20 20"><circle cx="4.5" cy="10" r="1" /><circle cx="10" cy="10" r="1" /><circle cx="15.5" cy="10" r="1" /></svg>
          </button>
          <button className="icon-btn card-close" title="关闭小窗及其派生小窗" aria-label="关闭小窗"
            onClick={close}>
            <svg aria-hidden="true" viewBox="0 0 20 20" fill="none"><path d="m5.5 5.5 9 9m0-9-9 9" /></svg>
          </button>
        </div>
      </div>

      {menuOpen && (
        <div className="card-menu" onMouseDown={e => e.stopPropagation()}>
          {card.sourceMarkId && (
            <button onClick={() => { locateMark(card.sourceMarkId!); setCardMenuFor(null) }}>⌖ 定位原文标注</button>
          )}
          <details className="card-collect">
            <summary>加入知识库</summary>
            <button disabled={card.status !== 'done'} onClick={() => {
              setCardMenuFor(null)
              useLibrary.getState().collect(card.id, false)
            }}>仅收藏当前卡片</button>
            <button disabled={card.status !== 'done'} onClick={() => {
              setCardMenuFor(null)
              useLibrary.getState().collect(card.id, true)
            }}>收藏整条分支</button>
          </details>
          <button onClick={() => reExplain(card.id)} disabled={card.status === 'streaming'}>重新讲解</button>
          <button onClick={() => setCardFontScale(card.id, -0.1)}>缩小文字</button>
          <button onClick={() => setCardFontScale(card.id, 0.1)}>放大文字</button>
        </div>
      )}

      <div className={`card-body-wrap${card.height !== undefined ? ' fixed-height' : ''}`} onScroll={() => {
        useStore.getState().setSelectionToolbar(null)
        bumpEdges()
      }}>
        <CardBody card={card} />
      </div>

      {card.status === 'done' && (
        <div className="card-foot">
          <input
            value={q}
            aria-label="追问"
            placeholder="继续追问…"
            onChange={e => setQ(e.target.value)}
            onKeyDown={e => {
              if (e.key === 'Enter') { e.stopPropagation(); sendFollowup() }
              e.stopPropagation()
            }}
          />
          <button className="send-btn" onClick={sendFollowup} disabled={!q.trim()}>发送</button>
        </div>
      )}

      {resizeHandles.map(([position, horizontal, vertical]) => (
        <div key={position} className={`card-resize ${position}`}
          title={horizontal && vertical ? '调整宽度和高度' : horizontal ? '调整宽度' : '调整高度'}
          onPointerDown={event => onResizeDown(event, horizontal, vertical)} />
      ))}
    </div>
  )
}
