import { useLayoutEffect, useState } from 'react'
import { useStore } from '../store'
import type { SelectionPayload } from '../store'

export function SelectionToolbar() {
  const selection = useStore(s => s.selectionToolbar)
  return selection && <SelectionQuestion key={selection.text + ':' + selection.screen.x + ':' + selection.screen.y} selection={selection} />
}

function SelectionQuestion({ selection }: { selection: SelectionPayload }) {
  const [question, setQuestion] = useState('')
  useLayoutEffect(() => {
    if (typeof Highlight === 'undefined' || !CSS.highlights) return
    CSS.highlights.set('pending-selection', new Highlight(selection.range))
    return () => { CSS.highlights.delete('pending-selection') }
  }, [selection.range])
  const explain = useStore(s => s.explainFromSelection)
  const dismiss = useStore(s => s.setSelectionToolbar)
  const setToast = useStore(s => s.setToast)
  const width = Math.min(424, window.innerWidth - 24)
  const rect = selection.range.getBoundingClientRect()
  const height = 86
  const y = rect.bottom + 10 + height <= window.innerHeight - 12 ? rect.bottom + 10 : rect.top - height - 10
  const left = Math.max(12, Math.min(rect.left, window.innerWidth - width - 12))
  const top = Math.max(12, Math.min(y, window.innerHeight - height - 12))

  return (
    <form className="sel-toolbar" style={{ left, top, width }} aria-label="针对选段提问"
      onKeyDown={event => {
        if (event.key !== 'Escape' || event.nativeEvent.isComposing) return
        event.stopPropagation()
        document.getSelection()?.removeAllRanges()
        dismiss(null)
      }}
      onSubmit={event => {
        event.preventDefault()
        if (question.trim()) void explain(question)
      }}>
      <div className="sel-quote" title={selection.text}>{selection.text}</div>
      <div className="sel-form-row">
        <input aria-label="关于这段文字的问题" placeholder="这段里，你想弄懂什么？"
          value={question} maxLength={2000} onChange={event => setQuestion(event.target.value)}
          onKeyDown={event => {
            if (event.key === 'Enter' && event.nativeEvent.isComposing) event.preventDefault()
          }} />
        <button type="submit" className="sel-primary" disabled={!question.trim()}>提问</button>
        <button type="button" className="sel-copy"
          onClick={async () => {
            try {
              await navigator.clipboard.writeText(selection.text)
              setToast('已复制选中文本')
            } catch {
              setToast('复制失败', 'error')
            }
          }}>
          复制
        </button>
      </div>
    </form>
  )
}
