import { useEffect, useRef, useState } from 'react'
import { useStore } from '../store'
import * as api from '../api'

/** 未打开文档时的首页：拖入 PDF / 选择文件 / 最近文档 */
export function EmptyState() {
  const importFile = useStore(s => s.importFile)
  const openDoc = useStore(s => s.openDoc)
  const fileRef = useRef<HTMLInputElement>(null)
  const [docs, setDocs] = useState<{ id: string; title: string; numPages: number; updatedAt: number }[]>([])
  const [dragOver, setDragOver] = useState(false)

  useEffect(() => {
    api.listDocs().then(setDocs).catch(() => {})
  }, [])

  const pickFile = (f: File | undefined) => {
    if (!f) return
    if (!/\.pdf$/i.test(f.name)) { useStore.getState().setToast('请选择 PDF 文件', 'error'); return }
    importFile(f)
  }

  return (
    <div
      className={`empty-state${dragOver ? ' dragover' : ''}`}
      onDragOver={e => { e.preventDefault(); setDragOver(true) }}
      onDragLeave={() => setDragOver(false)}
      onDrop={e => {
        e.preventDefault()
        setDragOver(false)
        pickFile(e.dataTransfer.files?.[0])
      }}
    >
      <div className="empty-hero">
        <div className="empty-logo">⧉</div>
        <h1>无界问答</h1>
        <p className="empty-tagline">把论文摊开在一张无限画布上 —— 划词即得讲解，讲解还能再讲解。</p>
        <button className="empty-cta" onClick={() => fileRef.current?.click()}>
          导入 PDF 论文
        </button>
        <p className="empty-hint">或直接把 .pdf 文件拖到这里</p>
      </div>

      {docs.length > 0 && (
        <div className="recent">
          <div className="recent-title">最近文档</div>
          {docs.map(d => (
            <button key={d.id} className="recent-item" onClick={() => openDoc(d.id)}>
              <span className="doc-title">{d.title}</span>
              <span className="doc-pages">{d.numPages} 页</span>
            </button>
          ))}
        </div>
      )}

      <input
        ref={fileRef}
        type="file"
        accept="application/pdf,.pdf"
        style={{ display: 'none' }}
        onChange={e => pickFile(e.target.files?.[0])}
      />
    </div>
  )
}
