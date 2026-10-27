// OpenAI 兼容的对话补全客户端（流式），通过全局 fetch 调用。
// 兼容：智谱 GLM / DeepSeek / OpenAI / Moonshot / 本地 Ollama (/v1) 等。

/**
 * 逐块产出 delta 文本。
 * signal 用于在客户端断开或超时时中止上游请求——否则下游已走、上游连接还会
 * 一直读到模型收敛，白白占用并发与额度。
 */
export async function* chatStream({
  baseUrl, apiKey, model, messages,
  temperature = 0.6, maxTokens = 4096, signal,
}) {
  const url = String(baseUrl || '').replace(/\/+$/, '') + '/chat/completions';
  const res = await fetch(url, {
    method: 'POST',
    signal,
    headers: {
      'Content-Type': 'application/json',
      'Authorization': `Bearer ${apiKey}`,
    },
    body: JSON.stringify({
      model,
      messages,
      temperature,
      max_tokens: maxTokens,
      stream: true,
    }),
  });
  if (!res.ok) {
    const t = await res.text().catch(() => '');
    throw new Error(`模型服务返回 ${res.status}：${t.slice(0, 400)}`);
  }
  if (!res.body) throw new Error('模型服务未返回流式响应体');

  const reader = res.body.getReader();
  const dec = new TextDecoder();
  let buf = '';
  let drained = false;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) { drained = true; break; }
      buf += dec.decode(value, { stream: true });
      let i;
      while ((i = buf.indexOf('\n')) >= 0) {
        const line = buf.slice(0, i).trim();
        buf = buf.slice(i + 1);
        if (!line.startsWith('data:')) continue;
        const data = line.slice(5).trim();
        if (data === '[DONE]') { drained = true; return; }
        try {
          const j = JSON.parse(data);
          const d = j.choices?.[0]?.delta?.content;
          if (d) yield d;
        } catch { /* 忽略心跳等非 JSON 行 */ }
      }
    }
  } finally {
    // 提前 return（[DONE] / 上层 break）或异常时释放底层连接
    if (!drained) { try { await reader.cancel(); } catch { /* 已关闭 */ } }
    try { reader.releaseLock(); } catch { /* 已释放 */ }
  }
}

export async function chatOnce(cfg, messages, maxTokens = 32) {
  let out = '';
  for await (const t of chatStream({ ...cfg, messages, maxTokens, temperature: 0 })) out += t;
  return out;
}
