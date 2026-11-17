import { useStore } from '../store'

/** 右下角控制簇：缩放 / 适应文档 / 帮助 */
export function Controls() {
  const doc = useStore(s => s.doc)
  const firstCardId = useStore(s => Object.keys(s.cards)[0])
  const locateCard = useStore(s => s.locateCard)
  const viewport = useStore(s => s.viewport)
  const zoomTo = useStore(s => s.zoomTo)
  const fitDoc = useStore(s => s.fitDoc)

  return (
    <div className="controls">
      <button className="ctrl-btn" title="缩小（Ctrl+滚轮）"
        onClick={() => zoomTo(viewport.scale / 1.25)}>－</button>
      <button className="ctrl-zoom" title="重置缩放"
        onClick={() => zoomTo(1)}>{Math.round(viewport.scale * 100)}%</button>
      <button className="ctrl-btn" title="放大（Ctrl+滚轮）"
        onClick={() => zoomTo(viewport.scale * 1.25)}>＋</button>
      {(doc || firstCardId) && <span className="ctrl-sep" />}
      {doc ? <button className="ctrl-btn wide" onClick={fitDoc}>定位论文</button>
        : firstCardId && <button className="ctrl-btn wide" onClick={() => locateCard(firstCardId)}>定位起点</button>}
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
            <tr><td>直接提问</td><td>在问答画布输入问题，每个回答都会打开一个小窗。</td></tr>
            <tr><td>关闭小窗</td><td>点标题栏「×」，该小窗及由它派生的所有小窗会一起关闭。</td></tr>
            <tr><td>划选文字</td><td>在论文或讲解卡片中划选文字，输入你的问题，生成相连的讲解小窗</td></tr>
            <tr><td>讲解的讲解</td><td>讲解卡片里的文字同样可以划选，一层层拆下去</td></tr>
            <tr><td>关联虚线</td><td>标注与讲解卡片之间自动连线；悬停讲解小窗可突出显示连线</td></tr>
            <tr><td>追问</td><td>卡片底部输入框回车，可带全文上下文继续提问</td></tr>
            <tr><td>平移画布</td><td>拖拽空白处 / 按住空格拖拽任意位置 / 滚轮</td></tr>
            <tr><td>缩放画布</td><td>Ctrl（或 ⌘ / Alt）+ 滚轮；右下角按钮</td></tr>
            <tr><td>调整文字大小</td><td>在卡片上按住 Ctrl 滚动鼠标滚轮，或从标题栏「⋯」选择「缩小文字」或「放大文字」</td></tr>
            <tr><td>移动卡片</td><td>拖拽卡片标题栏（正文留给划词，不会误拖）</td></tr>
            <tr><td>调整小窗</td><td>拖左右边缘调整宽度，拖上下边缘调整高度，拖任一角同时调整宽高</td></tr>
            <tr><td>卡片菜单</td><td>点击标题栏「⋯」可选择「重新讲解」，生成期间该选项不可用。通过划词创建的卡片还可选择「定位原文标注」。</td></tr>
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
