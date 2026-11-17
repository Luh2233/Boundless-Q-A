import { useEffect, useRef, useState } from 'react'
import { useStore } from '../store'
import * as api from '../api'

/** 顶部浮动胶囊：文档名 / 文档切换 / 设置 / 帮助 */
export function TopBar() {
  const doc = useStore(s => s.doc)
  const conversations = useStore(s => s.conversations)
  const conversationId = useStore(s => s.conversationId)
  const switchConversation = useStore(s => s.switchConversation)
  const deleteConversation = useStore(s => s.deleteConversation)
  const [historyOpen, setHistoryOpen] = useState(false)
  const historyRef = useRef<HTMLDivElement>(null)
  useEffect(() => {
    if (!historyOpen) return
    const close = (event: PointerEvent) => {
      if (!historyRef.current?.contains(event.target as Node)) setHistoryOpen(false)
    }
    const escape = (event: KeyboardEvent) => { if (event.key === 'Escape') setHistoryOpen(false) }
    document.addEventListener('pointerdown', close)
    document.addEventListener('keydown', escape)
    return () => {
      document.removeEventListener('pointerdown', close)
      document.removeEventListener('keydown', escape)
    }
  }, [historyOpen])
  const setSettingsOpen = useStore(s => s.setSettingsOpen)
  const setHelpOpen = useStore(s => s.setHelpOpen)
  const openDoc = useStore(s => s.openDoc)
  const closeDoc = useStore(s => s.closeDoc)
  const importFile = useStore(s => s.importFile)
  const [docs, setDocs] = useState<{ id: string; title: string; numPages: number }[]>([])
  const [docHistory, setDocHistory] = useState<typeof docs>([])
  const hasDocCards = useStore(s => Object.keys(s.cards).length > 0)
  const visibleDocHistory = doc
    ? [
      ...(hasDocCards ? [{ id: doc.id, title: doc.title, numPages: doc.pages.length }] : []),
      ...docHistory.filter(item => item.id !== doc.id),
    ]
    : docHistory

  useEffect(() => {
    if (!historyOpen) return
    let cancelled = false
    api.listDocs(true).then(items => { if (!cancelled) setDocHistory(items) }).catch(() => {})
    return () => { cancelled = true }
  }, [historyOpen, doc?.id])

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

  const brand = (
    <>
      <svg className="logo" viewBox="0 0 20 20" fill="none" stroke="currentColor" strokeWidth="1.2" aria-hidden="true">
        <rect x="2.5" y="3" width="10" height="10" rx="1.5" />
        <rect x="7.5" y="7.5" width="10" height="10" rx="1.5" fill="var(--card-bg)" />
      </svg>
      无界问答
    </>
  )

  return (
    <div className="topbar">
      {doc
        ? <button className="brand brand-lockup" onClick={() => closeDoc()} title="返回问答画布">{brand}</button>
        : <span className="brand brand-lockup">{brand}</span>}
      {doc && <span className="topbar-sep" />}
      {doc && <span className="doc-name">{doc.title}</span>}

      <div className="topbar-right">
        <div className="dropdown" ref={historyRef}>
          <button className="pill-btn" aria-expanded={historyOpen} onClick={() => { setHistoryOpen(v => !v); setMenuOpen(false) }}>对话</button>
          {historyOpen && (
            <div className="dropdown-menu conversation-menu">
              <button className="dropdown-item primary" onClick={() => { switchConversation(); setHistoryOpen(false) }}>新建对话</button>
              <div className="dropdown-sep" />
              {!conversations.length && !visibleDocHistory.length && <div className="dropdown-empty">暂无历史对话</div>}
              {conversations.map(item => (
                <div key={item.id} className="dropdown-item row">
                  <button className={`doc-open${!doc && conversationId === item.id ? ' current' : ''}`}
                    title={item.title} onClick={() => { switchConversation(item.id); setHistoryOpen(false) }}>
                    <span className="doc-title">{item.title}</span>
                  </button>
                  <button className="doc-del" aria-label={`删除对话：${item.title}`} onClick={() => {
                    if (confirm(`删除对话「${item.title}」及其讲解小窗？`)) deleteConversation(item.id)
                  }}>×</button>
                </div>
              ))}
              {visibleDocHistory.length > 0 && (
                <>
                  <div className="dropdown-sep" />
                  <div className="dropdown-empty">文档讲解</div>
                  {visibleDocHistory.map(item => (
                    <button key={item.id} className={`doc-open${doc?.id === item.id ? ' current' : ''}`}
                      title={item.title} onClick={() => {
                        if (doc?.id !== item.id) void openDoc(item.id)
                        setHistoryOpen(false)
                      }}>
                      <span className="doc-title">{item.title}</span>
                      <span className="doc-pages">PDF</span>
                    </button>
                  ))}
                </>
              )}
            </div>
          )}
        </div>
        <div className="dropdown" ref={menuRef}>
          <button className="pill-btn" aria-expanded={menuOpen} onClick={() => setMenuOpen(v => !v)}>文档 ▾</button>
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
                    onClick={() => { if (d.id !== doc?.id) void openDoc(d.id); setMenuOpen(false) }}>
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
                      if (d.id === doc?.id) closeDoc(false)
                      setDocs(ds => ds.filter(x => x.id !== d.id))
                      setDocHistory(items => items.filter(x => x.id !== d.id))
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
        onChange={e => { pickFile(e.target.files?.[0]); e.target.value = '' }}
      />
    </div>
  )
}
