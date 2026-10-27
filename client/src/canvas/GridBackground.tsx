/** 画布点阵背景（世界坐标内，随缩放一起缩放，营造空间感） */
export function GridBackground() {
  return (
    <div
      className="grid-bg"
      data-stage-bg="1"
      style={{
        position: 'absolute',
        left: -20000,
        top: -20000,
        width: 40000,
        height: 40000,
      }}
    />
  )
}
