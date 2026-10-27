import { useStore } from '../store'

/** 划词后出现的浮动工具条：讲解 / 复制 */
export function SelectionToolbar() {
  const tb = useStore(s => s.selectionToolbar)
  const explain = useStore(s => s.explainFromSelection)
  const setToast = useStore(s => s.setToast)
  if (!tb) return null

  // 双向钳制进视口（选区贴近边缘/部分在视口外时工具条仍可点击）
  const left = Math.min(Math.max(12, tb.screen.x + 10), window.innerWidth - 190)
  const top = Math.min(Math.max(12, tb.screen.y + 10), window.innerHeight - 56)

  return (
    <div className="sel-toolbar" style={{ left, top }} onPointerDown={e => e.preventDefault()}>
      <button
        className="sel-primary"
        onClick={() => explain()}
        title="生成 AI 讲解卡片"
      >
        ✦ 讲解
      </button>
      <span className="sel-divider" />
      <button
        className="sel-copy"
        onClick={() => {
          navigator.clipboard?.writeText(tb.text).then(
            () => setToast('已复制选中文本'),
            () => setToast('复制失败', 'error'),
          )
          useStore.setState({ selectionToolbar: null })
        }}
      >
        复制
      </button>
      <span className="sel-len">{tb.text.trim().length} 字</span>
    </div>
  )
}
