import type { DocMeta, Card, Mark, Viewport, CardMemo, FollowUp } from './types'

async function json<T>(url: string, init?: RequestInit): Promise<T> {
  const res = await fetch(url, {
    headers: { 'Content-Type': 'application/json' },
    ...init,
  })
  if (!res.ok) {
    const t = await res.text().catch(() => '')
    throw new Error(t.slice(0, 200) || `请求失败 ${res.status}`)
  }
  return res.json()
}

export const uploadPdf = (file: File) =>
  fetch('/api/upload', { method: 'POST', body: file }).then(async r => {
    if (!r.ok) throw new Error('上传失败')
    return (await r.json()) as { id: string; duplicate: boolean }
  })

export const saveDocMeta = (doc: DocMeta) => json('/api/documents', { method: 'POST', body: JSON.stringify(doc) })
export const listDocs = (history = false) => json<{ id: string; title: string; numPages: number; updatedAt: number }[]>(history ? '/api/documents?history=1' : '/api/documents')
export const getDoc = (id: string) => json<DocMeta>(`/api/documents/${id}`)
export const deleteDoc = (id: string) => json(`/api/documents/${id}`, { method: 'DELETE' })
export const getDocFileUrl = (id: string) => `/api/documents/${id}/file`

export const getDocState = (id: string) => json<{ state: SavedStateLite | null }>(`/api/documents/${id}/state`)
// keepalive：卸载期（pagehide/visibilitychange）触发的保存不会被导航取消
export const putDocState = (id: string, state: unknown, keepalive = false) =>
  fetch(`/api/documents/${id}/state`, {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(state),
    keepalive,
  }).then(async r => {
    if (!r.ok) throw new Error(`保存失败 ${r.status}`)
    return r.json()
  })

interface SavedStateLite {
  viewport: Viewport
  pdfNode: { x: number; y: number; width: number; scrollTop?: number; resized?: boolean }
  cards: Card[]
  marks: Mark[]
  cardSeq: number
}

export const getConfig = () => json<{ baseUrl: string; model: string; hasKey: boolean; demo: boolean }>('/api/config')
export const saveConfig = (cfg: { baseUrl?: string; apiKey?: string; model?: string; clearKey?: boolean }) =>
  json<{ baseUrl: string; model: string; hasKey: boolean; demo: boolean }>('/api/config', { method: 'PUT', body: JSON.stringify(cfg) })
export const testConfig = (overrides?: { baseUrl?: string; apiKey?: string; model?: string }) =>
  json<{ ok: boolean; message: string }>('/api/config/test', { method: 'POST', body: JSON.stringify(overrides || {}) })

/* ---------- SSE 流式 ---------- */

interface StreamCbs {
  onDelta: (t: string) => void
  onDone?: () => void
  onError?: (msg: string) => void
}

async function readSSE(url: string, body: unknown, cbs: StreamCbs, onMemo?: (m: CardMemo) => void, signal?: AbortSignal) {
  let finished = false
  const fail = (msg: string) => {
    if (!finished) {
      finished = true
      cbs.onError?.(msg)
    }
  }
  let res: Response
  try {
    res = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
      signal,
    })
  } catch (e) {
    fail(String((e as Error).message || e))
    return
  }
  if (!res.ok || !res.body) {
    const t = await res.text().catch(() => '')
    fail(t.slice(0, 200) || `请求失败 ${res.status}`)
    return
  }
  try {
    const reader = res.body.getReader()
    const dec = new TextDecoder()
    let buf = ''
    while (true) {
      const { done, value } = await reader.read()
      if (done) break
      buf += dec.decode(value, { stream: true })
      let i: number
      while ((i = buf.indexOf('\n')) >= 0) {
        const line = buf.slice(0, i).trim()
        buf = buf.slice(i + 1)
        if (!line.startsWith('data:')) continue
        const data = line.slice(5).trim()
        if (!data) continue
        try {
          const ev = JSON.parse(data)
          if (ev.type === 'delta' && ev.text && !finished) cbs.onDelta(ev.text)
          else if (ev.type === 'memo' && onMemo && !finished) onMemo(ev.memo as CardMemo)
          else if (ev.type === 'done') {
            if (!finished) { finished = true; cbs.onDone?.() }
          }
          else if (ev.type === 'error') fail(ev.message || '生成失败')
        } catch { /* 忽略坏帧 */ }
      }
    }
    if (!finished) {
      fail('连接中断，请重试。')
    }
  } catch (e) {
    fail(`连接中断：${String((e as Error).message || e)}`)
  }
}

export interface ExplainPayload {
  docId?: string
  selectionText?: string
  sourceDesc: string
  page?: number
  contextText?: string
  sourceCardId?: string
  question?: string
  cards: { id: number; depth: number; summary: string; concepts: string[] }[]
  ancestors: { id: string; content: string; sourceText: string }[]
}

export const streamExplain = (payload: ExplainPayload, cbs: StreamCbs, onMemo?: (m: CardMemo) => void, signal?: AbortSignal) =>
  readSSE('/api/explain', payload, cbs, onMemo, signal)

export interface FollowupPayload {
  docId?: string
  cardId: string
  question: string
  content: string
  sourceText: string
  memo?: string
  followups: { q: string; a: string }[]
  cards: { id: number; depth: number; summary: string; concepts: string[] }[]
}

export const streamFollowup = (payload: FollowupPayload, cbs: StreamCbs, signal?: AbortSignal) =>
  readSSE('/api/followup', payload, cbs, undefined, signal)

export type { FollowUp }
