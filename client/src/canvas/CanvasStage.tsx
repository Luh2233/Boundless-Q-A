import { useEffect, useRef } from 'react'
import { useStore } from '../store'
import { GridBackground } from './GridBackground'
import { EdgeLayer } from './EdgeLayer'
import { PdfNode } from '../pdf/PdfNode'
import { ExplanationCard } from '../cards/ExplanationCard'

/** 无限画布：世界容器 + 平移缩放手势 */
export function CanvasStage() {
  const stageRef = useRef<HTMLDivElement>(null)
  const viewport = useStore(s => s.viewport)
  const cards = useStore(s => s.cards)
  const doc = useStore(s => s.doc)

  const zoomAt = useStore(s => s.zoomAt)
  const panBy = useStore(s => s.panBy)

  /* 滚轮：平移；Ctrl/⌘/Alt + 滚轮：缩放（卡片内的交给卡片自身的捕获监听） */
  useEffect(() => {
    const el = stageRef.current
    if (!el) return
    const onWheel = (e: WheelEvent) => {
      e.preventDefault()
      if (e.ctrlKey || e.metaKey || e.altKey) {
        zoomAt(e.clientX, e.clientY, Math.exp(-e.deltaY * 0.0016))
      } else {
        const mul = e.deltaMode === 1 ? 16 : 1
        panBy(-e.deltaX, -e.deltaY * mul)
      }
    }
    el.addEventListener('wheel', onWheel, { passive: false })
    return () => el.removeEventListener('wheel', onWheel)
  }, [zoomAt, panBy])

  /* 全局兜底：任何位置的 Ctrl/⌘/Alt+滚轮都不触发浏览器整页缩放 */
  useEffect(() => {
    const guard = (e: WheelEvent) => {
      if (e.ctrlKey || e.metaKey || e.altKey) e.preventDefault()
    }
    document.addEventListener('wheel', guard, { capture: true, passive: false })
    return () => document.removeEventListener('wheel', guard, { capture: true })
  }, [])

  /* 防御：stage 元素一旦被程序性滚动（历史遗留），随视口变化归零，避免变换基准漂移 */
  useEffect(() => {
    const el = stageRef.current
    if (el && (el.scrollTop !== 0 || el.scrollLeft !== 0)) {
      el.scrollTop = 0
      el.scrollLeft = 0
    }
  }, [viewport])

  /* 空格按住 → 任意位置拖拽平移 */
  useEffect(() => {
    const down = (e: KeyboardEvent) => {
      if (e.code !== 'Space' || isTyping(e.target)) return
      e.preventDefault()
      stageRef.current?.classList.add('space-pan')
    }
    const up = (e: KeyboardEvent) => {
      if (e.code === 'Space') stageRef.current?.classList.remove('space-pan')
    }
    window.addEventListener('keydown', down)
    window.addEventListener('keyup', up)
    return () => {
      window.removeEventListener('keydown', down)
      window.removeEventListener('keyup', up)
    }
  }, [])

  /* 空白处按下拖拽平移（左键空白 / 中键任意位置） */
  const onPointerDown = (e: React.PointerEvent) => {
    const el = stageRef.current
    if (!el) return
    const stage = el.classList.contains('space-pan')
    const target = e.target as HTMLElement
    // 点击落在 stage 本体（空白）或点阵背景上才算空白；卡片/文档/连线各归其交互
    const onEmpty = e.target === el || target.dataset?.stageBg === '1' || target.classList?.contains('world')
    if (!(onEmpty || e.button === 1 || stage)) return
    e.preventDefault()
    const sx = e.clientX
    const sy = e.clientY
    const v0 = { ...useStore.getState().viewport }
    const move = (ev: PointerEvent) => {
      useStore.getState().setViewport({ x: v0.x + (ev.clientX - sx), y: v0.y + (ev.clientY - sy), scale: v0.scale })
    }
    const up = () => {
      window.removeEventListener('pointermove', move)
      window.removeEventListener('pointerup', up)
    }
    window.addEventListener('pointermove', move)
    window.addEventListener('pointerup', up)
  }

  return (
    <div
      id="stage"
      ref={stageRef}
      className={`stage${doc ? '' : ' empty'}`}
      onPointerDown={onPointerDown}
    >
      <div
        className="world"
        style={{
          transform: `translate(${viewport.x}px, ${viewport.y}px) scale(${viewport.scale})`,
        }}
      >
        <GridBackground />
        <EdgeLayer />
        {doc && <PdfNode />}
        {Object.values(cards).map(c => (
          <ExplanationCard key={c.id} card={c} />
        ))}
      </div>
    </div>
  )
}

function isTyping(t: EventTarget | null) {
  const el = t as HTMLElement | null
  return !!el && (el.tagName === 'INPUT' || el.tagName === 'TEXTAREA' || el.isContentEditable)
}
