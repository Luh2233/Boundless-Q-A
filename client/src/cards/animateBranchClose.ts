// Motion Prompt #049 · MIT License (c) 2026 Shohei Ohtaki · https://showheyohtaki.github.io/motion-prompt/#049
// The dialog's 280 ms, 1 → 0.9 fade-and-scale exit, adapted to canvas branches.
import { useStore } from '../store'

const exitDuration = 280
// Motion Prompt #049-072 · MIT License (c) 2026 Shohei Ohtaki · https://showheyohtaki.github.io/motion-prompt/#049
// Samples of the UI kit's easeInOutCubic at eighths of the exit duration.
const exitEasing = 'linear(0, 0.0078125, 0.0625, 0.2109375, 0.5, 0.7890625, 0.9375, 0.9921875, 1)'

/** Keep only inert visual copies while the store removes the branch immediately. */
export function animateBranchClose(stage: Element, branch: ReadonlyMap<string, number>) {
  const layer = stage.querySelector('.closing-cards')
  if (!layer || typeof layer.animate !== 'function') return
  const reduced = window.matchMedia('(prefers-reduced-motion: reduce)').matches
  const easing = reduced ? 'ease-out' : CSS.supports('animation-timing-function', exitEasing)
    ? exitEasing : 'cubic-bezier(0.65, 0, 0.35, 1)'
  const { cards, marks } = useStore.getState()
  const edgeLayer = stage.querySelector('.closing-edges')
  const bounds = stage.getBoundingClientRect()
  let deepest = 0
  for (const depth of branch.values()) deepest = Math.max(depth, deepest)
  const step = deepest ? Math.min(34, 96 / deepest) : 0

  const play = (copy: Element, frames: Keyframe[], delay: number) => {
    const animation = copy.animate(frames, {
      duration: reduced ? 100 : exitDuration,
      delay: reduced ? 0 : delay,
      easing,
      fill: 'both',
    })
    void animation.finished.then(() => copy.remove(), () => copy.remove())
  }

  for (const [id, depth] of branch) {
    const element = stage.querySelector<HTMLElement>(`[data-card-root="${id}"]`)
    if (!element) continue
    const box = element.getBoundingClientRect()
    if (box.right <= bounds.left || box.left >= bounds.right ||
        box.bottom <= bounds.top || box.top >= bounds.bottom) continue

    const delay = (deepest - depth) * step
    const copy = element.cloneNode(true) as HTMLElement
    copy.removeAttribute('data-card-root')
    copy.classList.remove('dragging', 'menu-open', 'card-active')
    copy.classList.add('closing-card')
    copy.querySelector('.card-menu')?.remove()
    for (const mark of copy.querySelectorAll('[data-mark-anchor], [data-mark-id]')) {
      mark.removeAttribute('data-mark-anchor')
      mark.removeAttribute('data-mark-id')
    }
    layer.append(copy)
    const originalBody = element.querySelector('.card-body-wrap')
    const body = copy.querySelector('.card-body-wrap')
    if (originalBody && body) {
      body.scrollTop = originalBody.scrollTop
      body.scrollLeft = originalBody.scrollLeft
    }

    const card = cards[id]
    const source = card.sourceMarkId && marks[card.sourceMarkId]
    const anchor = source && stage.querySelector(`[data-mark-anchor="${source.id}"]`)?.getBoundingClientRect()
    const dx = anchor ? anchor.left + anchor.width / 2 - (box.left + box.width / 2) : 0
    const dy = anchor ? anchor.top + anchor.height / 2 - (box.top + box.height / 2) : -1
    const distance = Math.hypot(dx, dy) || 1
    play(copy, [
      { opacity: 1, transform: 'none' },
      {
        opacity: 0,
        transform: reduced ? 'none' : `translate(${18 * dx / distance}px, ${18 * dy / distance}px) scale(0.9)`,
      },
    ], delay)
  }

  if (!edgeLayer) return
  for (const edge of stage.querySelectorAll('[data-edge-card]')) {
    const depth = branch.get(edge.getAttribute('data-edge-card') ?? '')
    if (depth === undefined) continue
    const box = edge.getBoundingClientRect()
    if (box.right < bounds.left || box.left > bounds.right ||
        box.bottom < bounds.top || box.top > bounds.bottom) continue
    const copy = edge.cloneNode(true) as Element
    copy.removeAttribute('data-edge-card')
    copy.classList.remove('active')
    edgeLayer.append(copy)
    // Remove the live stroke before the next geometry refresh so the copies never stack.
    edge.setAttribute('visibility', 'hidden')
    play(copy, [{ opacity: 1 }, { opacity: 0 }], (deepest - depth) * step)
  }
}
