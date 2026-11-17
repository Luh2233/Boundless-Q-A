import { useEffect, useRef, useState } from 'react'
import { Markdown } from '../cards/Markdown'
import { generatePoints, generationKey, knowledgeQuestion, openKnowledgeSource, useGeneration, useLibrary } from './library'
import type { KnowledgeNode } from './library'

function Branch({ node, childrenByParent, selected, choose, parent }: {
  node: KnowledgeNode
  parent?: KnowledgeNode
  childrenByParent: Map<string | null, KnowledgeNode[]>
  selected: string
  choose: (id: string) => void
}) {
  const [expanded, setExpanded] = useState(node.parentId === null)
  const children = childrenByParent.get(node.id) ?? []
  return (
    <li>
      <div className="knowledge-branch-row">
        {children.length > 0 && (
          <button className="knowledge-expand" aria-expanded={expanded} aria-label={expanded ? '折叠分支' : '展开分支'}
            onClick={() => setExpanded(value => !value)}>{expanded ? '−' : '+'}</button>
        )}
        <button className="knowledge-node" aria-current={selected === node.id ? 'true' : undefined}
          onClick={() => choose(node.id)}>
          {knowledgeQuestion(node, parent)}
          {node.points && <span className="knowledge-preview">{node.points.split('\n').find(line => line.trim())}</span>}
        </button>
      </div>
      {expanded && children.length > 0 && (
        <ul>{children.map(child => <Branch key={child.id} node={child} parent={node} childrenByParent={childrenByParent} selected={selected} choose={choose} />)}</ul>
      )}
    </li>
  )
}

export function KnowledgeLibrary() {
  const { topics, open, current, setOpen, select, update, remove } = useLibrary()
  const dialog = useRef<HTMLDialogElement>(null)
  const [selected, setSelected] = useState('')
  const [sourceMessage, setSourceMessage] = useState('')
  const topic = topics.find(item => item.id === current)
  const node = topic?.nodes.find(item => item.id === selected) ?? topic?.nodes[0]
  const parent = topic?.nodes.find(item => item.id === node?.parentId)
  const title = node ? knowledgeQuestion(node, parent) : ''
  const key = topic && node ? generationKey(topic.id, node.id) : ''
  const pending = useGeneration(s => s.pending.includes(key))
  const error = useGeneration(s => s.errors[key])
  const childrenByParent = new Map<string | null, KnowledgeNode[]>()
  for (const item of topic?.nodes ?? []) {
    const children = childrenByParent.get(item.parentId) ?? []
    children.push(item)
    childrenByParent.set(item.parentId, children)
  }

  useEffect(() => {
    const element = dialog.current
    if (open && element && !element.open) element.showModal()
    if (!open && element?.open) element.close()
  }, [open])

  return (
    <dialog ref={dialog} className="knowledge-dialog" aria-labelledby="knowledge-heading"
      onCancel={event => { event.preventDefault(); setOpen(false) }}>
      <header className="knowledge-header">
        <h2 id="knowledge-heading">知识库</h2>
        <button className="ghost-btn" onClick={() => setOpen(false)}>返回画布</button>
      </header>
      <div className="knowledge-layout">
        <nav className="knowledge-topics" aria-label="收藏主题">
          {topics.length === 0 && <p>从讲解卡片的「⋯」菜单加入知识库。</p>}
          {topics.map(item => (
            <button key={item.id} aria-current={current === item.id ? 'true' : undefined} onClick={() => {
              select(item.id)
              setSelected('')
              setSourceMessage('')
            }}>{item.title}</button>
          ))}
        </nav>
        {topic && node ? (
          <>
            <section className="knowledge-map" aria-label="知识脉络" key={topic.id}>
              <div className="knowledge-section-head">
                <h3>知识脉络</h3>
                <button className="ghost-btn" onClick={() => {
                  if (confirm('删除此收藏？')) remove(topic.id)
                }}>删除收藏</button>
              </div>
              <label className="knowledge-topic-title">
                主题名称
                <input key={topic.id} defaultValue={topic.title} maxLength={160}
                  onBlur={event => {
                    const title = event.currentTarget.value.trim() || topic.title
                    event.currentTarget.value = title
                    if (title !== topic.title) update(topic.id, item => ({ ...item, title }))
                  }}
                  onKeyDown={event => {
                    if (event.key === 'Enter' && !event.nativeEvent.isComposing) event.currentTarget.blur()
                  }} />
              </label>
              <ul className="knowledge-tree">{(childrenByParent.get(null) ?? []).map(root => (
                <Branch key={root.id} node={root} childrenByParent={childrenByParent} selected={node.id}
                  choose={id => { setSelected(id); setSourceMessage('') }} />
              ))}</ul>
            </section>
            <section className="knowledge-detail" key={key}>
              <h3>{title}</h3>
              {title !== node.question && <p className="knowledge-source">原问题：{node.question}</p>}
              <p className="knowledge-source">{node.source}</p>
              {node.excerpt && <blockquote>{node.excerpt}</blockquote>}
              <label htmlFor="knowledge-points">复习要点</label>
              <textarea id="knowledge-points" rows={5} value={node.points} placeholder="每行写一条复习要点"
                onChange={event => update(topic.id, item => ({
                  ...item, nodes: item.nodes.map(entry => entry.id === node.id ? { ...entry, points: event.target.value } : entry),
                }))} />
              <div className="knowledge-actions">
                <button className="ghost-btn" disabled={pending || !node.content.trim()} onClick={() => {
                  if (!node.points || confirm('重新提炼并替换现有复习要点？')) void generatePoints(topic, node)
                }}>{pending ? '正在提炼…' : node.points ? '重新提炼' : 'AI 提炼'}</button>
                <button className="ghost-btn" onClick={async () => setSourceMessage(await openKnowledgeSource(topic, node) ?? '')}>回到原出处</button>
              </div>
              {(error || sourceMessage) && <p className="knowledge-source" role="status">{sourceMessage || error}</p>}
              <details className="knowledge-original">
                <summary>完整讲解与追问</summary>
                <Markdown source={node.content || '收藏时此卡片还没有讲解内容。'} />
                {node.followups.map((entry, index) => (
                  <div key={index}><h4>{entry.q}</h4><Markdown source={entry.a || '收藏时尚无回答。'} /></div>
                ))}
              </details>
            </section>
          </>
        ) : topics.length > 0 && <p className="knowledge-empty">选择一个收藏主题开始复习。</p>}
      </div>
    </dialog>
  )
}
