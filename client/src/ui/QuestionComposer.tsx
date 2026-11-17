import { useState } from 'react'
import { useStore } from '../store'

export function QuestionComposer() {
  const [question, setQuestion] = useState('')
  const ask = useStore(s => s.ask)
  const empty = useStore(s => Object.keys(s.cards).length === 0)

  return (
    <section className={`composer${empty ? ' composer-empty' : ''}`} aria-label="画布提问">
      {empty && (
        <>
          <h1>你想弄懂什么？</h1>
          <p>输入问题，或将 PDF 拖到画布开始阅读。</p>
        </>
      )}
      <form className="question-form" onSubmit={e => {
        e.preventDefault()
        if (!question.trim()) return
        void ask(question)
        setQuestion('')
      }}>
        <input
          aria-label="输入你的问题"
          placeholder={empty ? '例如，为什么天空是蓝色的？' : '输入新问题…'}
          value={question}
          maxLength={2000}
          onChange={e => setQuestion(e.target.value)}
        />
        <button type="submit" disabled={!question.trim()} aria-label="提问">提问
          <svg aria-hidden="true" viewBox="0 0 20 20" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round">
            <path d="M10 15V5m-4 4 4-4 4 4" />
          </svg></button>
      </form>
    </section>
  )
}
