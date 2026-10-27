import { useEffect, useState } from 'react'
import { useStore } from '../store'
import * as api from '../api'

/** 模型服务设置（任意 OpenAI 兼容接口） */
export function SettingsDialog() {
  const open = useStore(s => s.settingsOpen)
  const setSettingsOpen = useStore(s => s.setSettingsOpen)
  const setToast = useStore(s => s.setToast)
  const [baseUrl, setBaseUrl] = useState('')
  const [model, setModel] = useState('')
  const [apiKey, setApiKey] = useState('')
  const [hasKey, setHasKey] = useState(false)
  const [testing, setTesting] = useState(false)

  useEffect(() => {
    if (open) {
      api.getConfig().then(c => {
        setBaseUrl(c.baseUrl)
        setModel(c.model)
        setHasKey(c.hasKey)
      })
    }
  }, [open])

  if (!open) return null

  const save = async () => {
    try {
      await api.saveConfig({ baseUrl, model, apiKey: apiKey || undefined })
      setToast('设置已保存')
      setSettingsOpen(false)
    } catch (e) {
      setToast(`保存失败：${(e as Error).message}`, 'error')
    }
  }

  const test = async () => {
    setTesting(true)
    try {
      // 用表单当前值测试，不落盘
      const r = await api.testConfig({ baseUrl, model, apiKey: apiKey || undefined })
      setToast(r.ok ? `连接成功：${r.message}` : `连接失败：${r.message}`, r.ok ? 'info' : 'error')
    } catch (e) {
      setToast(`测试失败：${(e as Error).message}`, 'error')
    } finally {
      setTesting(false)
    }
  }

  const clearKey = async () => {
    try {
      await api.saveConfig({ clearKey: true })
      setApiKey('')
      setHasKey(false)
      setToast('已清除 API Key，回到演示模式')
    } catch (e) {
      setToast(`清除失败：${(e as Error).message}`, 'error')
    }
  }

  return (
    <div className="modal-mask" onMouseDown={e => { if (e.target === e.currentTarget) setSettingsOpen(false) }}>
      <div className="modal">
        <h2>模型设置</h2>
        <p className="modal-desc">
          支持任意 <b>OpenAI 兼容</b>对话接口：智谱 GLM、DeepSeek、OpenAI、Moonshot、本地 Ollama 等。
          不填 API Key 时将以<b>演示模式</b>运行（界面全流程可用，讲解为占位内容）。
        </p>

        <label>API Base URL</label>
        <input value={baseUrl} onChange={e => setBaseUrl(e.target.value)} placeholder="https://open.bigmodel.cn/api/paas/v4" />
        <label>模型名称</label>
        <input value={model} onChange={e => setModel(e.target.value)} placeholder="glm-4.6 / deepseek-chat / gpt-4o" />
        <label>API Key {hasKey && <em className="key-state">（已配置，留空则不修改）</em>}</label>
        <input type="password" value={apiKey} onChange={e => setApiKey(e.target.value)} placeholder="sk-…" />

        <div className="modal-actions">
          <button className="ghost-btn" onClick={test} disabled={testing}>
            {testing ? '测试中…' : '测试连接'}
          </button>
          {hasKey && (
            <button className="ghost-btn danger" onClick={clearKey} title="清除已保存的 API Key，回到演示模式">
              清除 Key
            </button>
          )}
          <div className="spacer" />
          <button className="ghost-btn" onClick={() => setSettingsOpen(false)}>取消</button>
          <button className="primary-btn" onClick={save}>保存</button>
        </div>
      </div>
    </div>
  )
}
