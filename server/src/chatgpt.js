import { createHash, createPublicKey, randomBytes, randomUUID, verify } from 'node:crypto';
import { setTimeout as delay } from 'node:timers/promises';
import { readChatGPTLogin, readChatGPTSession, writeChatGPTLogin, writeChatGPTSession } from './store.js';

const ISSUER = 'https://auth.openai.com';
const RESOURCE = 'https://api.openai.com/v1';
const TOKEN_URL = ISSUER + '/api/accounts/oauth/token';
const SCOPES = 'openid profile email offline_access resource.invoke chatgpt.tokens.use.direct';
const EFFORTS = ['none', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max'];
const connectErrors = new Set(['UND_ERR_CONNECT_TIMEOUT', 'ECONNREFUSED', 'EAI_AGAIN', 'ENETUNREACH', 'EHOSTUNREACH']);
const random = () => randomBytes(32).toString('base64url');
const error = (message, status = 502) => Object.assign(new Error(message), { status });

let sessionWork = Promise.resolve();
let connection = new AbortController();
let catalog;

function serialize(work) {
  const next = sessionWork.then(work);
  sessionWork = next.catch(() => {});
  return next;
}

function resetConnection() {
  connection.abort(error('ChatGPT 连接已变更，请重新提问。', 401));
  connection = new AbortController();
  catalog = undefined;
}

async function request(url, options = {}) {
  const { signal, ...init } = options;
  return fetch(url, {
    ...init, redirect: 'error',
    signal: signal ? AbortSignal.any([signal, AbortSignal.timeout(12_000)]) : AbortSignal.timeout(12_000),
  });
}

async function exchange(fields) {
  let response;
  try {
    response = await request(TOKEN_URL, {
      method: 'POST', headers: { Accept: 'application/json' },
      body: new URLSearchParams({ ...fields, resource: RESOURCE }),
    });
  } catch {
    throw error('后端无法连接 OpenAI 授权服务。请检查网络后重新登录。');
  }
  const data = await response.json().catch(() => null);
  if (response.ok && data) return data;
  const code = typeof data?.error === 'string' ? data.error : data?.error?.code;
  if (['invalid_grant', 'invalid_refresh_token', 'token_expired', 'refresh_token_expired',
    'refresh_token_invalidated', 'refresh_token_reused'].includes(code)) {
    throw error('ChatGPT 授权已失效，请重新登录。', 401);
  }
  if (code === 'invalid_client') throw error('OpenAI 未接受此应用的客户端注册，请选择「使用其他账号」重新授权。', 403);
  throw error(`OpenAI 未能交换登录授权（HTTP ${response.status}），请重新登录。`);
}

function credentials(data, previous) {
  const scope = typeof data.scope === 'string' ? data.scope : previous?.scope;
  const scopes = scope?.split(/\s+/) ?? [];
  if (!scopes.includes('chatgpt.tokens.use.direct') || !scopes.includes('resource.invoke')) {
    throw error('尚未授权使用 ChatGPT 订阅额度，请重新登录并同意授权。', 403);
  }
  if (typeof data.access_token !== 'string' || !data.access_token ||
      typeof data.refresh_token !== 'string' || !data.refresh_token ||
      !Number.isFinite(data.expires_in) || data.expires_in <= 0) {
    throw error('ChatGPT 返回的授权凭据不完整，请重新登录。');
  }
  return {
    scope, accessToken: data.access_token, refreshToken: data.refresh_token,
    expiresAt: Date.now() + data.expires_in * 1000,
  };
}

async function identity(token, clientId, nonce) {
  let keys;
  try {
    const response = await request(ISSUER + '/.well-known/jwks.json', { headers: { Accept: 'application/json' } });
    if (!response.ok) throw new Error();
    ({ keys } = await response.json());
    if (!Array.isArray(keys)) throw new Error();
  } catch {
    throw error('无法从 OpenAI 获取账号验签公钥，请检查网络后重新登录。');
  }
  try {
    const parts = String(token).split('.');
    if (parts.length !== 3) throw new Error();
    const [head, body, signature] = parts;
    const header = JSON.parse(Buffer.from(head, 'base64url'));
    const claims = JSON.parse(Buffer.from(body, 'base64url'));
    if (header.alg !== 'RS256' || typeof header.kid !== 'string') throw new Error();
    const jwk = keys.find(key => key.kid === header.kid && key.kty === 'RSA' && (!key.alg || key.alg === 'RS256'));
    if (!jwk || !verify('RSA-SHA256', Buffer.from(head + '.' + body),
      createPublicKey({ key: jwk, format: 'jwk' }), Buffer.from(signature, 'base64url'))) throw new Error();
    const audiences = Array.isArray(claims.aud) ? claims.aud : [claims.aud];
    const now = Date.now() / 1000;
    if (claims.iss !== ISSUER || !audiences.includes(clientId) ||
        ((audiences.length > 1 || claims.azp !== undefined) && claims.azp !== clientId) ||
        !Number.isFinite(claims.exp) || claims.exp <= now - 5 || (claims.nbf ?? 0) > now + 5 ||
        (nonce !== undefined && claims.nonce !== nonce) ||
        typeof claims.sub !== 'string' || !claims.sub) throw new Error();
    const email = typeof claims.email === 'string' ? claims.email.slice(0, 200) : undefined;
    return { sub: claims.sub, label: String(email || claims.name || 'ChatGPT').slice(0, 200), email };
  } catch {
    throw error('无法验证 ChatGPT 账号，请重新登录。');
  }
}

export async function startChatGPTLogin(port, { consent = false, newAccount = false } = {}) {
  return serialize(async () => {
    let saved = await readChatGPTSession();
    if (!saved?.hostId) {
      saved = { hostId: 'urn:uuid:' + randomUUID() };
      await writeChatGPTSession(saved);
    }
    if (newAccount) {
      if (saved.accessToken) throw error('请先退出当前 ChatGPT 账号。', 409);
      saved = { hostId: saved.hostId };
    }
    const redirectUri = `http://127.0.0.1:${port}/auth/callback`;
    const state = random();
    const nonce = random();
    const verifier = random();
    const url = new URL(ISSUER + '/api/accounts/authorize');
    url.search = new URLSearchParams({
      client_id: saved.clientId || 'dynamic_agent_client',
      ...(saved.clientId ? {} : { agent_name_hint: '无界问答' }),
      ...(saved.clientId && saved.account?.email ? { login_hint: saved.account.email } : {}),
      ...(consent ? { prompt: 'consent' } : {}),
      ext_agent_host_id: saved.hostId, response_type: 'code', redirect_uri: redirectUri,
      scope: SCOPES, resource: RESOURCE, state, nonce, code_challenge_method: 'S256',
      code_challenge: createHash('sha256').update(verifier).digest('base64url'),
    }).toString();
    const id = random();
    await writeChatGPTLogin({
      id, state, nonce, verifier, redirectUri, hostId: saved.hostId,
      clientId: saved.clientId, subject: saved.account?.sub,
      url: url.href, status: 'pending', expires: Date.now() + 600_000,
    });
    return { id };
  });
}

export async function loginUrl(id) {
  const attempt = await readChatGPTLogin();
  if (attempt?.id === id && attempt.status === 'pending' && attempt.expires > Date.now()) return attempt.url;
  throw error('登录请求已过期，请重新发起。', 404);
}

export async function finishChatGPTLogin(query) {
  const current = await serialize(async () => {
    const pending = await readChatGPTLogin();
    if (!pending || pending.expires <= Date.now() || query.state !== pending.state) {
      throw error('这次授权已过期或已被新的登录替换，请回到无界问答重新发起。', 400);
    }
    if (pending.status !== 'pending') return pending;
    await writeChatGPTLogin({ id: pending.id, state: pending.state, expires: pending.expires, status: 'exchanging' });
    return pending;
  });
  if (current.status === 'connected') return;
  if (current.status === 'failed') throw error(current.message, 400);
  if (current.status !== 'pending') throw error('应用正在处理授权。若设置页一直没有更新，请重新发起登录。', 409);

  try {
    if (query.error === 'access_denied') throw error('OpenAI 未授予订阅权限。请确认选中了有资格的账号，并允许使用 ChatGPT 订阅额度。', 403);
    if (query.error) {
      const code = typeof query.error === 'string' && /^[a-z][a-z_]{1,48}$/.test(query.error) ? `（${query.error}）` : '';
      throw error(`OpenAI 中止了授权${code}，请重新登录。`, 403);
    }
    const clientId = current.clientId || query.client_id;
    if (typeof clientId !== 'string' || !/^[a-zA-Z0-9_-]{1,200}$/.test(clientId) || clientId === 'dynamic_agent_client' ||
        (query.client_id !== undefined && query.client_id !== clientId) ||
        typeof query.code !== 'string' || !query.code) {
      throw error('OpenAI 回调未提供有效的授权码或应用客户端 ID，请重新登录。', 400);
    }
    await serialize(async () => {
      const latest = await readChatGPTLogin();
      if (latest?.id !== current.id || latest.status !== 'exchanging') throw error('登录已取消。', 409);
      const saved = await readChatGPTSession();
      if (!saved?.clientId) await writeChatGPTSession({ hostId: current.hostId, clientId });
    });
    const data = await exchange({
      grant_type: 'authorization_code', client_id: clientId, code: query.code,
      code_verifier: current.verifier, redirect_uri: current.redirectUri,
    });
    const account = await identity(data.id_token, clientId, current.nonce);
    if (current.subject && current.subject !== account.sub) {
      throw error('登录的 ChatGPT 账号与已保存的账号不一致。', 403);
    }
    let tokens;
    let authorizationError;
    try { tokens = credentials(data); } catch (err) { authorizationError = err; }
    await serialize(async () => {
      const latest = await readChatGPTLogin();
      if (latest?.id !== current.id || latest.status !== 'exchanging') throw error('登录已取消。', 409);
      const saved = await readChatGPTSession();
      if (authorizationError && saved?.accessToken) throw authorizationError;
      await writeChatGPTSession({ hostId: current.hostId, clientId, account, idToken: data.id_token, ...tokens });
      resetConnection();
      if (!authorizationError) await writeChatGPTLogin({ ...latest, status: 'connected' });
    });
    if (authorizationError) throw authorizationError;
  } catch (err) {
    const message = err.status ? err.message : '无法完成 ChatGPT 登录或保存凭据，请重试。';
    await serialize(async () => {
      const latest = await readChatGPTLogin();
      if (latest?.id === current.id && latest.status === 'exchanging') {
        await writeChatGPTLogin({ ...latest, status: 'failed', message });
      }
    });
    throw error(message, err.status);
  }
}

export async function loginStatus(id) {
  const attempt = await readChatGPTLogin();
  if (attempt?.id !== id || attempt.expires <= Date.now()) {
    return { status: 'failed', message: '登录请求已过期，请重新发起。' };
  }
  return { status: attempt.status, message: attempt.message };
}

export async function chatgptStatus() {
  const saved = await readChatGPTSession();
  return {
    connected: !!saved?.accessToken, account: saved?.account?.label,
    needsConsent: !!saved?.idToken && !saved?.accessToken,
    registered: !!saved?.clientId,
  };
}

export async function disconnectChatGPT() {
  return serialize(async () => {
    await writeChatGPTLogin(null);
    resetConnection();
    const saved = await readChatGPTSession();
    if (!saved) return { revoked: true };
    let revoked = !saved.refreshToken;
    for (let retry = 0; !revoked && retry < 2; retry++) {
      if (retry) await new Promise(resolve => setTimeout(resolve, 350));
      try {
        const response = await request(ISSUER + '/api/accounts/oauth/revoke', {
          method: 'POST', body: new URLSearchParams({
            client_id: saved.clientId, token: saved.refreshToken, token_type_hint: 'refresh_token',
          }),
        });
        revoked = response.ok;
        if (!revoked && response.status < 500) break;
      } catch {}
    }
    await writeChatGPTSession({ hostId: saved.hostId, clientId: saved.clientId, account: saved.account });
    return { revoked };
  });
}

async function access(signal, rejectedToken) {
  return serialize(async () => {
    signal?.throwIfAborted();
    const saved = await readChatGPTSession();
    if (!saved?.accessToken) throw error('请在模型设置中登录 ChatGPT 并授权使用订阅。', 401);
    if (saved.accessToken !== rejectedToken && saved.expiresAt > Date.now() + 60_000) return saved.accessToken;
    try {
      const current = await exchange({
        grant_type: 'refresh_token', client_id: saved.clientId, refresh_token: saved.refreshToken,
      });
      const next = credentials(current, saved);
      if (current.id_token) {
        const account = await identity(current.id_token, saved.clientId);
        if (account.sub !== saved.account.sub) throw error('ChatGPT 账号发生变更，请重新登录。', 401);
      }
      await writeChatGPTSession({ ...saved, ...next, idToken: current.id_token || saved.idToken });
      return next.accessToken;
    } catch (err) {
      if (err.status === 401 || err.status === 403) {
        await writeChatGPTSession({ hostId: saved.hostId, clientId: saved.clientId, account: saved.account });
        resetConnection();
      }
      throw err;
    }
  });
}

function inferenceError(issue, status) {
  const code = issue?.code;
  if (code === 'subscription_sharing_usage_unavailable') {
    return error('暂时无法查询 ChatGPT 订阅额度，请稍后重试。', 503);
  }
  if (status === 429 || code === 'subscription_sharing_usage_limit_exceeded') {
    return error('已达到 ChatGPT 订阅或应用额度上限，请在 ChatGPT 设置中查看用量。', 429);
  }
  if (status === 401 || code === 'invalid_token') return error('OpenAI 未接受当前 ChatGPT 授权。若重试仍失败，请在设置中重新登录。', 401);
  if (code === 'subscription_sharing_unsupported_capability' || code === 'model_not_found' ||
      issue?.param === 'model' || issue?.param === 'reasoning.effort') {
    if (issue?.param === 'reasoning.effort') return error('此模型不支持所选推理强度，请在设置中选择模型默认或其他强度。', 400);
    return error('此账号当前无法用所选模型完成请求，请在设置中更换模型。', 400);
  }
  if (status === 403 || code === 'subscription_sharing_user_not_eligible') {
    return error('此 ChatGPT 账号或工作区无法使用该订阅功能。', 403);
  }
  if (status === 400) {
    return error('ChatGPT 不支持当前请求，请在设置中检查模型和推理强度。', 400);
  }
  if (status >= 500) return error(`OpenAI 推理服务暂时不可用（HTTP ${status}），请稍后重试。`, status);
  return error('ChatGPT 暂时无法完成请求，请稍后重试。');
}

const fallbackEfforts = ['low', 'medium', 'high', 'xhigh', 'max'];

export async function chatgptModels({ refresh = false, signal } = {}) {
  const active = connection.signal;
  signal = signal ? AbortSignal.any([signal, active]) : active;
  let token = await access(signal);
  if (!refresh && catalog?.token === token && catalog.expires > Date.now()) return catalog.models;
  const fetchModels = async () => {
    try {
      return await request(RESOURCE + '/models', { headers: { Authorization: 'Bearer ' + token }, signal });
    } catch {
      signal.throwIfAborted();
      throw error('无法连接 OpenAI 模型列表，请检查网络后重试。', 503);
    }
  };
  let response;
  try {
    response = await fetchModels();
  } catch (err) {
    if (!refresh && err.status === 503 && catalog?.token === token) return catalog.models;
    throw err;
  }
  if (response.status === 401) {
    await response.body?.cancel().catch(() => {});
    token = await access(signal, token);
    response = await fetchModels();
  }
  const data = await response.json().catch(() => null);
  if (!response.ok) {
    if (!refresh && response.status >= 500 && catalog?.token === token) return catalog.models;
    throw inferenceError(data?.error, response.status);
  }
  if (!Array.isArray(data?.models)) throw error('ChatGPT 返回的模型列表格式有误，请重试。');
  const models = data.models.filter(model => model?.visibility === 'list' &&
    typeof model.slug === 'string' && model.slug && typeof model.display_name === 'string').map(model => {
    const known = /^gpt-(?:6(?:\.\d+)?|5\.6)(?:-|$)/.test(model.slug);
    const supported = model.supported_reasoning_levels ?? model.supported_reasoning_efforts;
    const values = Array.isArray(supported) ? supported.map(item => item?.effort ?? item) : known ? fallbackEfforts : [];
    return { id: model.slug, name: model.display_name, efforts: EFFORTS.filter(effort => values.includes(effort)) };
  });
  signal.throwIfAborted();
  catalog = { token, models, expires: Date.now() + 300_000 };
  return models;
}

export async function validateChatGPTModel(model, effort, signal) {
  const models = await chatgptModels({ signal });
  const selected = model ? models.find(item => item.id === model) : models[0];
  if (!selected) throw error('此账号当前无法使用所选模型，请重新选择。', 400);
  if (effort && !selected.efforts.includes(effort)) throw error('所选模型不支持此推理强度。', 400);
  return selected.id;
}

export async function* chatgptStream({ messages, chatgptModel, chatgptEffort, signal }) {
  const active = connection.signal;
  signal = signal ? AbortSignal.any([signal, active]) : active;
  const model = await validateChatGPTModel(chatgptModel, chatgptEffort, signal);
  let token = await access(signal);
  const requestBody = JSON.stringify({
    model, store: false, stream: true,
    input: messages.map(({ role, content }) => ({ role: role === 'system' ? 'developer' : role, content })),
    ...(chatgptEffort ? { reasoning: { effort: chatgptEffort } } : {}),
  });
  let retriedConnection = false;
  const reply = async () => {
    for (;;) {
      signal.throwIfAborted();
      try {
        return await fetch(RESOURCE + '/responses', {
          method: 'POST', redirect: 'error', signal,
          headers: { 'Content-Type': 'application/json', Accept: 'text/event-stream', Authorization: 'Bearer ' + token },
          body: requestBody,
        });
      } catch (err) {
        signal.throwIfAborted();
        if (retriedConnection || !connectErrors.has(err.cause?.code)) {
          throw error('后端无法连接 OpenAI 推理服务，请检查网络后重试。', 503);
        }
        retriedConnection = true;
        await delay(400, undefined, { signal }).catch(() => signal.throwIfAborted());
      }
    }
  };
  let res = await reply();
  if (res.status === 401) {
    await res.body?.cancel().catch(() => {});
    token = await access(signal, token);
    signal.throwIfAborted();
    res = await reply();
  }
  if (!res.ok) {
    const data = await res.json().catch(() => null);
    throw inferenceError(data?.error, res.status);
  }
  if (!res.body) throw error('ChatGPT 未返回流式响应。');
  const reader = res.body.getReader();
  const decode = new TextDecoder();
  let buffer = '';
  let emitted = false;
  try {
    while (true) {
      const { done, value } = await reader.read();
      buffer += done ? decode.decode() + '\n' : decode.decode(value, { stream: true });
      let end;
      while ((end = buffer.indexOf('\n')) !== -1) {
        const line = buffer.slice(0, end).trim();
        buffer = buffer.slice(end + 1);
        if (!line.startsWith('data:')) continue;
        let event;
        try { event = JSON.parse(line.slice(5)); } catch { continue; }
        if (!event || typeof event !== 'object') continue;
        if (event.type === 'response.output_text.delta' && typeof event.delta === 'string' && event.delta) {
          emitted = true;
          yield event.delta;
        }
        if (event.type === 'response.completed') {
          if (!emitted) {
            for (const item of event.response?.output ?? []) {
              if (item.type !== 'message') continue;
              for (const part of item.content ?? []) {
                if (part.type === 'output_text' && typeof part.text === 'string' && part.text) yield part.text;
              }
            }
          }
          return;
        }
        if (event.type === 'response.failed' || event.type === 'error') {
          throw inferenceError(event.response?.error ?? event);
        }
        if (event.type === 'response.incomplete') throw error('ChatGPT 回答未完整生成，请重试。');
      }
      if (done) break;
    }
    throw error('ChatGPT 流式回答提前断开，请重试。');
  } catch (err) {
    if (err.status) throw err;
    signal.throwIfAborted();
    throw error('ChatGPT 流式回答连接中断，请检查网络后重试。');
  } finally {
    await reader.cancel().catch(() => {});
    reader.releaseLock();
  }
}
