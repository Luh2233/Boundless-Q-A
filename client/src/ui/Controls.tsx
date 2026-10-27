import { useStore } from '../store'

/** 右下角控制簇：缩放 / 适应文档 / 帮助 */
export function Controls() {
  const viewport = useStore(s => s.viewport)
  const zoomTo = useStore(s => s.zoomTo)
  const zoomAt = useStore(s => s.zoomAt)
  const fitDoc = useStore(s => s.fitDoc)
  const setHelpOpen = useStore(s => s.setHelpOpen)

  return (
    <div className="controls">
      <button className="ctrl-btn" title="缩小（Ctrl+滚轮）"
        onClick={() => zoomTo(viewport.scale / 1.25)}>－</button>
      <button className="ctrl-zoom" title="重置缩放"
        onClick={() => zoomTo(1)}>{Math.round(viewport.scale * 100)}%</button>
      <button className="ctrl-btn" title="放大（Ctrl+滚轮）"
        onClick={() => zoomAt(window.innerWidth - 90, window.innerHeight - 90, 1.25)}>＋</button>
      <span className="ctrl-sep" />
      <button className="ctrl-btn wide" title="回到论文" onClick={fitDoc}>⤢ 论文</button>
      <button className="ctrl-btn" title="帮助" onClick={() => setHelpOpen(true)}>?</button>
    </div>
  )
}

/** 操作指引 */
export function HelpOverlay() {
  const open = useStore(s => s.helpOpen)
  const setHelpOpen = useStore(s => s.setHelpOpen)
  if (!open) return null
  return (
    <div className="modal-mask" onMouseDown={e => { if (e.target === e.currentTarget) setHelpOpen(false) }}>
      <div className="modal help">
        <h2>怎么用</h2>
        <table className="help-table">
          <tbody>
            <tr><td>划选文字</td><td>论文或任何讲解卡片中，划选后点「✦ 讲解」生成讲解卡片</td></tr>
            <tr><td>讲解的讲解</td><td>讲解卡片里的文字同样可以划选，一层层拆下去（颜色区分层级）</td></tr>
            <tr><td>关联虚线</td><td>标注与讲解卡片之间自动连线；悬停卡片或连线可互相高亮</td></tr>
            <tr><td>追问</td><td>卡片底部输入框回车，可带全文上下文继续提问</td></tr>
            <tr><td>平移画布</td><td>拖拽空白处 / 按住空格拖拽任意位置 / 滚轮</td></tr>
            <tr><td>缩放画布</td><td>Ctrl（或 ⌘ / Alt）+ 滚轮；右下角按钮</td></tr>
            <tr><td>卡片独立缩放</td><td>在卡片上 Ctrl+滚轮，或卡片标题栏的 ＋/－</td></tr>
            <tr><td>移动卡片</td><td>拖拽卡片标题栏（正文留给划词，不会误拖）</td></tr>
            <tr><td>加宽卡片</td><td>拖拽卡片右缘</td></tr>
            <tr><td>卡片菜单</td><td>标题栏「⋯」：定位标注 / 重新讲解 / 删除</td></tr>
          </tbody>
        </table>
        <div className="modal-actions">
          <div className="spacer" />
          <button className="primary-btn" onClick={() => setHelpOpen(false)}>知道了</button>
        </div>
      </div>
    </div>
  )
}

/** 底部提示条 */
export function Toast() {
  const toast = useStore(s => s.toast)
  if (!toast) return null
  return <div className={`toast ${toast.kind}`}>{toast.msg}</div>
}

/** 首次进入的引导提示 */
export function HintBar() {
  const doc = useStore(s => s.doc)
  const cardCount = useStore(s => Object.keys(s.cards).length)
  if (!doc || cardCount > 0) return null
  return (
    <div className="hint-bar">
      💡 划选论文中的文字，点「✦ 讲解」；讲解里的词句也可以继续划选，层层深入。
    </div>
  )
}
