import { useEffect, useRef, useState } from 'react'
import { Markdown } from '../cards/Markdown'
import { generatePoints, generateTopic, generationKey, knowledgeQuestion, knowledgeTopicTitle, needsQuestionContext, useGeneration, useLibrary } from './library'
import { getConfig, type ModelMode } from '../api'
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

function QuestionHeading({ title, save }: { title: string; save: (question: string) => boolean }) {
  const [editing, setEditing] = useState(false)
  return (
    <>
      <div className="knowledge-section-head">
        <h3>{title}</h3>
        {!editing && <button className="ghost-btn" onClick={() => setEditing(true)}>编辑问题</button>}
      </div>
      {editing && (
        <form onSubmit={event => {
          event.preventDefault()
          const question = String(new FormData(event.currentTarget).get('question') ?? '').trim()
          if (question && save(question)) setEditing(false)
        }}>
          <label htmlFor="knowledge-question">复习问题</label>
          <textarea id="knowledge-question" name="question" rows={2} defaultValue={title} required />
          <div className="knowledge-actions">
            <button type="submit" className="ghost-btn">保存问题</button>
            <button type="button" className="ghost-btn" onClick={() => setEditing(false)}>取消</button>
          </div>
        </form>
      )}
    </>
  )
}

export function KnowledgeLibrary() {
  const { topics, open, current, saveError, setOpen, select, update, remove } = useLibrary()
  const dialog = useRef<HTMLDialogElement>(null)
  const [selection, setSelection] = useState<{ topicId: string; nodeId: string } | null>(null)
  const [modelMode, setModelMode] = useState<ModelMode | null>(null)
  const selected = selection?.topicId === current ? selection?.nodeId : undefined
  const topic = topics.find(item => item.id === current)
  const node = topic?.nodes.find(item => item.id === selected) ?? topic?.nodes[0]
  const parent = topic?.nodes.find(item => item.id === node?.parentId)
  const title = node ? knowledgeQuestion(node, parent) : ''
  const topicTitle = topic ? knowledgeTopicTitle(topic) : ''
  const canComplete = !!node && needsQuestionContext(node, parent) && !!(node.excerpt || node.parentTitle || node.parentContent || parent)
  const key = topic && node ? generationKey(topic.id, node.id) : ''
  const pending = useGeneration(s => s.pending[key])
  const queued = useGeneration(s => s.queued.includes(key))
  const error = useGeneration(s => s.errors[key])
  const batchBusy = useGeneration(s => !!topic?.nodes.some(item => {
    const nodeKey = generationKey(topic.id, item.id)
    return s.queued.includes(nodeKey) || !!s.pending[nodeKey]
  }))
  const batchError = useGeneration(s => modelMode === 'chatgpt' && topic?.nodes
    .map(item => s.errors[generationKey(topic.id, item.id)]).find(Boolean))
  const canBatch = !!topic?.nodes.some(item => item.content.trim() && !item.points.trim())
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

  useEffect(() => {
    if (!open) return
    let cancelled = false
    getConfig().then(cfg => { if (!cancelled) setModelMode(cfg.mode) }).catch(() => {})
    return () => { cancelled = true }
  }, [open])

  useEffect(() => {
    if (open && modelMode === 'api' && topic && node && canComplete && !pending && !queued && error === undefined) {
      void generatePoints(topic, node, true, { automatic: true, expectedMode: 'api' })
    }
  }, [open, modelMode, topic, node, canComplete, pending, queued, error])

  return (
    <dialog ref={dialog} className="knowledge-dialog" aria-labelledby="knowledge-heading"
      onCancel={event => { event.preventDefault(); setOpen(false) }}>
      <header className="knowledge-header">
        <h2 id="knowledge-heading">知识库</h2>
        <button className="ghost-btn" onClick={() => setOpen(false)}>返回画布</button>
      </header>
      {saveError && <p className="knowledge-save-error" role="alert">{saveError}</p>}
      <div className="knowledge-layout">
        <nav className="knowledge-topics" aria-label="收藏主题">
          {topics.length === 0 && <p>从讲解卡片的「⋯」菜单加入知识库。</p>}
          {topics.map(item => (
            <button key={item.id} aria-current={current === item.id ? 'true' : undefined} onClick={() => {
              select(item.id)
              setSelection(null)
            }}>{knowledgeTopicTitle(item)}</button>
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
              {modelMode === 'chatgpt' && <>
                <button className="ghost-btn knowledge-batch" disabled={!canBatch || batchBusy}
                  onClick={() => void generateTopic(topic, { expectedMode: 'chatgpt' })}>
                  {batchBusy ? '提炼中…' : '提炼此分支'}
                </button>
                <p className="knowledge-source">正在使用 ChatGPT 订阅。 <a href="https://chatgpt.com/settings/usage" target="_blank" rel="noreferrer">管理用量</a></p>
                {batchError && batchError !== error && <p className="knowledge-source" role="status">{batchError}</p>}
              </>}
              <label className="knowledge-topic-title">
                主题名称
                <input key={topic.id} defaultValue={topicTitle} maxLength={160}
                  onBlur={event => {
                    const title = event.currentTarget.value.trim() || topicTitle
                    event.currentTarget.value = title
                    if (title !== topicTitle && !update(topic.id, item => ({ ...item, title }))) event.currentTarget.value = topicTitle
                  }}
                  onKeyDown={event => {
                    if (event.key === 'Enter' && !event.nativeEvent.isComposing) event.currentTarget.blur()
                  }} />
              </label>
              <ul className="knowledge-tree">{(childrenByParent.get(null) ?? []).map(root => (
                <Branch key={root.id} node={root} childrenByParent={childrenByParent} selected={node.id}
                  choose={nodeId => setSelection({ topicId: topic.id, nodeId })} />
              ))}</ul>
            </section>
            <section className="knowledge-detail" key={key}>
              <QuestionHeading title={title} save={reviewQuestion => update(topic.id, item => ({
                ...item, nodes: item.nodes.map(entry => entry.id === node.id ? { ...entry, reviewQuestion } : entry),
              }))} />
              <label htmlFor="knowledge-points">复习要点</label>
              <textarea id="knowledge-points" rows={5} value={node.points} placeholder="每行写一条复习要点"
                onChange={event => update(topic.id, item => ({
                  ...item, nodes: item.nodes.map(entry => entry.id === node.id ? { ...entry, points: event.target.value } : entry),
                }))} />
              <div className="knowledge-actions">
                {canComplete && (
                  <button className="ghost-btn" disabled={!!pending || queued} onClick={() => void generatePoints(topic, node, true, { expectedMode: modelMode ?? undefined })}>
                    {pending === 'question' ? '正在补全…' : '补全问题'}
                  </button>
                )}
                <button className="ghost-btn" disabled={!!pending || queued || !node.content.trim()} onClick={() => {
                  if (!node.points || confirm('重新提炼并替换现有复习要点？')) {
                    void generatePoints(topic, node, false, { expectedMode: modelMode ?? undefined })
                  }
                }}>{pending === 'points' ? '正在提炼…' : queued ? '等待提炼…' : node.points ? '重新提炼' : 'AI 提炼'}</button>
              </div>
              {error && <p className="knowledge-source" role="status">{error}</p>}
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
