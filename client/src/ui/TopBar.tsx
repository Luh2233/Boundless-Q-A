import { useEffect, useRef, useState } from 'react'
import { useStore } from '../store'
import * as api from '../api'

/** 顶部浮动胶囊：文档名 / 文档切换 / 设置 / 帮助 */
export function TopBar() {
  const doc = useStore(s => s.doc)
  const setSettingsOpen = useStore(s => s.setSettingsOpen)
  const setHelpOpen = useStore(s => s.setHelpOpen)
  const openDoc = useStore(s => s.openDoc)
  const closeDoc = useStore(s => s.closeDoc)
  const importFile = useStore(s => s.importFile)
  const [docs, setDocs] = useState<{ id: string; title: string; numPages: number }[]>([])
  const [menuOpen, setMenuOpen] = useState(false)
  const fileRef = useRef<HTMLInputElement>(null)
  const menuRef = useRef<HTMLDivElement>(null)

  useEffect(() => {
    api.listDocs().then(setDocs).catch(() => {})
  }, [doc?.id])

  useEffect(() => {
    if (!menuOpen) return
    const close = (e: MouseEvent) => {
      if (!menuRef.current?.contains(e.target as Node)) setMenuOpen(false)
    }
    setTimeout(() => document.addEventListener('mousedown', close), 0)
    return () => document.removeEventListener('mousedown', close)
  }, [menuOpen])

  const pickFile = (f: File | undefined) => {
    if (!f) return
    if (!/\.pdf$/i.test(f.name)) { useStore.getState().setToast('请选择 PDF 文件', 'error'); return }
    importFile(f)
    setMenuOpen(false)
  }

  return (
    <div className="topbar">
      <span className="logo">⧉</span>
      <span className="brand">无界问答</span>
      {doc && <span className="topbar-sep" />}
      {doc && <span className="doc-name">{doc.title}</span>}

      <div className="topbar-right">
        <div className="dropdown" ref={menuRef}>
          <button className="pill-btn" onClick={() => setMenuOpen(v => !v)}>文档 ▾</button>
          {menuOpen && (
            <div className="dropdown-menu">
              <button className="dropdown-item primary" onClick={() => fileRef.current?.click()}>
                ＋ 导入 PDF…
              </button>
              <div className="dropdown-sep" />
              {docs.length === 0 && <div className="dropdown-empty">暂无文档</div>}
              {docs.map(d => (
                <div key={d.id} className="dropdown-item row">
                  <button className={`doc-open${d.id === doc?.id ? ' current' : ''}`}
                    onClick={() => { openDoc(d.id); setMenuOpen(false) }}>
                    <span className="doc-title">{d.title}</span>
                    <span className="doc-pages">{d.numPages} 页</span>
                  </button>
                  <button
                    className="doc-del"
                    title="删除文档"
                    onClick={async e => {
                      e.stopPropagation()
                      if (!confirm(`删除文档「${d.title}」及其全部讲解？`)) return
                      await api.deleteDoc(d.id)
                      if (d.id === doc?.id) closeDoc()
                      setDocs(ds => ds.filter(x => x.id !== d.id))
                    }}
                  >✕</button>
                </div>
              ))}
            </div>
          )}
        </div>
        <button className="pill-btn" onClick={() => setSettingsOpen(true)} title="模型设置">⚙ 设置</button>
        <button className="pill-btn" onClick={() => setHelpOpen(true)} title="帮助">?</button>
      </div>

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
