import { useEffect, useState } from 'react'
import { useStore } from '../store'
import * as api from '../api'

export function SettingsDialog() {
  const open = useStore(s => s.settingsOpen)
  return open ? <ModelSettingsDialog /> : null
}

const effortLabels: Record<string, string> = {
  none: '关闭', minimal: '最低', low: '低', medium: '中', high: '高', xhigh: '很高', max: '最高',
}

function ModelSettingsDialog() {
  const setSettingsOpen = useStore(s => s.setSettingsOpen)
  const setToast = useStore(s => s.setToast)
  const [baseUrl, setBaseUrl] = useState('')
  const [model, setModel] = useState('')
  const [apiKey, setApiKey] = useState('')
  const [hasKey, setHasKey] = useState(false)
  const [mode, setMode] = useState<api.ModelMode>('api')
  const [chatgptModel, setChatgptModel] = useState('')
  const [chatgptEffort, setChatgptEffort] = useState('')
  const [account, setAccount] = useState<api.ChatGPTAccount | null>(null)
  const [models, setModels] = useState<api.ChatGPTModel[]>([])
  const [loginId, setLoginId] = useState('')
  const [busy, setBusy] = useState('')
  const [notice, setNotice] = useState('')
  const [failure, setFailure] = useState('')
  const [loaded, setLoaded] = useState(false)
  const [refresh, setRefresh] = useState(0)

  useEffect(() => {
    let cancelled = false
    api.getConfig().then(c => {
      if (cancelled) return
      setBaseUrl(c.baseUrl)
      setModel(c.model)
      setHasKey(c.hasKey)
      setMode(c.mode)
      setChatgptModel(c.chatgptModel)
      setChatgptEffort(c.chatgptEffort)
      setLoaded(true)
    }).catch(e => { if (!cancelled) setFailure(e.message) })
    return () => { cancelled = true }
  }, [])

  useEffect(() => {
    if (!loaded || mode !== 'chatgpt') return
    let cancelled = false
    async function load() {
      const status = await api.getChatGPTAccount()
      if (cancelled) return
      setAccount(status)
      const list = status.connected ? await api.listChatGPTModels(refresh > 0) : []
      if (!cancelled) setModels(list)
    }
    void load().catch(async e => {
      if (cancelled) return
      setFailure(e.message)
      const status = await api.getChatGPTAccount().catch(() => null)
      if (!cancelled && status) setAccount(status)
    })
    return () => { cancelled = true }
  }, [loaded, mode, refresh])

  useEffect(() => {
    if (!loginId) return
    const controller = new AbortController()
    let timer: ReturnType<typeof setTimeout>
    async function poll() {
      try {
        const result = await api.getChatGPTLogin(loginId, controller.signal)
        if (controller.signal.aborted) return
        if (result.status === 'pending' || result.status === 'exchanging') {
          timer = setTimeout(poll, 1000)
          return
        }
        if (result.status === 'connected') setNotice('ChatGPT 已连接。选好模型并保存后，AI 请求将使用你的订阅额度。')
        else setFailure(result.message || '登录未完成，请重试。')
        setLoginId('')
        setRefresh(value => value + 1)
      } catch (e) {
        if (controller.signal.aborted) return
        setFailure((e as Error).message)
        setLoginId('')
      }
    }
    void poll()
    return () => { controller.abort(); clearTimeout(timer) }
  }, [loginId])

  const selected = models.find(item => item.id === chatgptModel) ?? models[0]
  const effort = selected?.efforts.includes(chatgptEffort) ? chatgptEffort : ''
  const patch = mode === 'chatgpt'
    ? { mode, chatgptModel: selected?.id, chatgptEffort: effort }
    : { mode, baseUrl, model, apiKey: apiKey || undefined }
  const canSubmit = loaded && !busy && (mode === 'api' || (!!account?.connected && !!selected))

  const run = async (action: string, work: () => Promise<void>) => {
    if (busy) return
    setBusy(action)
    setFailure('')
    setNotice('')
    try {
      await work()
    } catch (e) {
      setFailure((e as Error).message)
    } finally {
      setBusy('')
    }
  }

  const signIn = (newAccount = false) => {
    const tab = window.open('about:blank', '_blank')
    if (tab) tab.opener = null
    void run('login', async () => {
      try {
        const { id } = await api.startChatGPTLogin(!!account?.needsConsent && !newAccount, newAccount)
        setLoginId(id)
        if (tab) tab.location.replace(`/api/chatgpt/login/${id}/authorize`)
      } catch (e) {
        tab?.close()
        throw e
      }
    })
  }

  const selectMode = (value: api.ModelMode) => {
    setMode(value)
    setFailure('')
    setNotice('')
    if (value !== 'chatgpt') {
      setAccount(null)
      setModels([])
    }
  }

  return (
    <div className="modal-mask" onMouseDown={e => { if (e.target === e.currentTarget) setSettingsOpen(false) }}>
      <div className="modal model-settings" role="dialog" aria-modal="true" aria-labelledby="model-settings-title">
        <h2 id="model-settings-title">模型设置</h2>
        <label htmlFor="model-mode">连接方式</label>
        <select id="model-mode" value={mode} disabled={!loaded || !!busy} onChange={e => selectMode(e.target.value as api.ModelMode)}>
          <option value="api">API Key</option>
          <option value="chatgpt">ChatGPT 订阅</option>
        </select>

        {mode === 'api' ? <>
          <p className="modal-desc">支持 OpenAI 兼容接口，例如智谱 GLM、DeepSeek、OpenAI、Moonshot 和本地 Ollama。未配置 Key 时使用演示模式。</p>
          <label htmlFor="model-url">API Base URL</label>
          <input id="model-url" value={baseUrl} onChange={e => setBaseUrl(e.target.value)} placeholder="https://open.bigmodel.cn/api/paas/v4" />
          <label htmlFor="api-model">模型名称</label>
          <input id="api-model" value={model} onChange={e => setModel(e.target.value)} placeholder="glm-4.6 / deepseek-chat / gpt-4o" />
          <label htmlFor="model-key">API Key {hasKey && <em className="key-state">（已配置，留空则不修改）</em>}</label>
          <input id="model-key" type="password" value={apiKey} onChange={e => setApiKey(e.target.value)} placeholder="sk-…" />
        </> : <>
          <p className="modal-desc">用自己的 ChatGPT 订阅生成讲解和复习要点。请求会计入订阅额度。 <a href="https://chatgpt.com/settings/usage" target="_blank" rel="noreferrer">管理用量</a></p>
          {account?.connected ? <>
            <div className="model-account">
              <span title={account.account}>{account.account || 'ChatGPT 已登录'}</span>
              <button className="ghost-btn" disabled={!!busy} onClick={() => void run('disconnect', async () => {
                const { revoked } = await api.disconnectChatGPT()
                setAccount(null)
                setModels([])
                setLoginId('')
                setRefresh(value => value + 1)
                setNotice(revoked ? '已退出 ChatGPT。' : '已退出本机。可在 ChatGPT 设置中确认取消授权。')
              })}>退出登录</button>
            </div>
            <label htmlFor="chatgpt-model">模型</label>
            <select id="chatgpt-model" value={selected?.id ?? ''} disabled={!selected || !!busy} onChange={e => {
              setChatgptModel(e.target.value)
              setChatgptEffort('')
            }}>
              {!selected && <option value="">暂无可选模型</option>}
              {models.map(item => <option key={item.id} value={item.id}>{item.name}</option>)}
            </select>
            <button className="ghost-btn model-refresh" disabled={!!busy} onClick={() => { setFailure(''); setRefresh(value => value + 1) }}>刷新模型列表</button>
            <label htmlFor="chatgpt-effort">推理强度</label>
            <select id="chatgpt-effort" value={effort} disabled={!selected?.efforts.length || !!busy} onChange={e => setChatgptEffort(e.target.value)}>
              <option value="">模型默认</option>
              {selected?.efforts.map(value => <option key={value} value={value}>{effortLabels[value]}</option>)}
            </select>
          </> : <div className="model-login">
            <button className="primary-btn" disabled={!loaded || !!busy} onClick={() => signIn()}>
              {busy === 'login' ? '正在打开…' : loginId ? '重新发起登录' : '使用 ChatGPT 继续'}
            </button>
            {loginId && <a href={`/api/chatgpt/login/${loginId}/authorize`} target="_blank" rel="noreferrer">打开授权页</a>}
            {account?.registered && !loginId && <button className="ghost-btn" disabled={!!busy} onClick={() => signIn(true)}>使用其他账号</button>}
          </div>}
          {loginId && <p className="modal-desc" role="status">在新标签页完成授权，然后返回这里。</p>}
        </>}
        {notice && <p className="model-notice" role="status">{notice}</p>}
        {failure && <p className="model-notice error" role="alert">{failure}</p>}
        <div className="modal-actions">
          <button className="ghost-btn" disabled={!canSubmit} onClick={() => void run('test', async () => {
            const result = await api.testConfig(patch)
            setNotice(result.message === '连接成功' ? '连接成功' : `连接成功：${result.message}`)
          })}>
            {busy === 'test' ? '测试中…' : '测试连接'}
          </button>
          {mode === 'api' && hasKey && (
            <button className="ghost-btn danger" disabled={!!busy} onClick={() => void run('clear', async () => {
              const cfg = await api.saveConfig({ clearKey: true })
              setApiKey('')
              setHasKey(cfg.hasKey)
              setNotice('已清除 API Key。')
            })}>
              清除 Key
            </button>
          )}
          <div className="spacer" />
          <button className="ghost-btn" onClick={() => setSettingsOpen(false)}>取消</button>
          <button className="primary-btn" disabled={!canSubmit} onClick={() => void run('save', async () => {
            await api.saveConfig(patch)
            setToast('设置已保存')
            setSettingsOpen(false)
          })}>保存</button>
        </div>
      </div>
    </div>
  )
}
