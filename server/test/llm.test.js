import test from 'node:test';
import assert from 'node:assert/strict';
import { chatStream, chatOnce } from '../src/llm.js';

const enc = new TextEncoder();

function sseResponse(chunks, status = 200) {
  const body = new ReadableStream({
    start(controller) {
      for (const ch of chunks) controller.enqueue(enc.encode(ch));
      controller.close();
    },
  });
  return new Response(body, { status, headers: { 'content-type': 'text/event-stream' } });
}

async function withFetch(stub, fn) {
  const original = globalThis.fetch;
  globalThis.fetch = stub;
  try {
    return await fn();
  } finally {
    globalThis.fetch = original;
  }
}

async function collect(gen) {
  let out = '';
  for await (const t of gen) out += t;
  return out;
}

const base = { baseUrl: 'https://example.test/v1/', apiKey: 'k', model: 'm', messages: [] };

test('正常流：按行解析出 delta，[DONE] 后停止', async () => {
  const chunks = [
    'data: {"choices":[{"delta":{"content":"你好"}}]}\n\n',
    'data: {"choices":[{"delta":{"content":"世界"}}]}\n\n',
    'data: [DONE]\n\n',
    'data: {"choices":[{"delta":{"content":"不该出现"}}]}\n\n',
  ];
  const text = await withFetch(async () => sseResponse(chunks), () => collect(chatStream(base)));
  assert.equal(text, '你好世界');
});

test('SSE 行被切断在任意位置也能正确拼接', async () => {
  const chunks = [
    'data: {"choices":[{"delta":{"conten',
    't":"前半"}}]}\n\ndata: {"choices":[{"delta":{"content":"后半"',
    '}}]}\n\ndata: [DONE]\n\n',
  ];
  const text = await withFetch(async () => sseResponse(chunks), () => collect(chatStream(base)));
  assert.equal(text, '前半后半');
});

test('心跳与非 JSON 行被忽略，不影响正文', async () => {
  const chunks = [
    ': keep-alive\n\n',
    'data: not-json\n\n',
    'data: {"choices":[{"delta":{"content":"正文"}}]}\n\n',
    'data: [DONE]\n\n',
  ];
  const text = await withFetch(async () => sseResponse(chunks), () => collect(chatStream(base)));
  assert.equal(text, '正文');
});

test('请求体与鉴权头按 OpenAI 兼容格式发出', async () => {
  let captured = null;
  await withFetch(
    async (url, init) => { captured = { url, init }; return sseResponse(['data: [DONE]\n\n']); },
    () => collect(chatStream({ ...base, maxTokens: 128, temperature: 0.2 })),
  );
  assert.equal(captured.url, 'https://example.test/v1/chat/completions');
  assert.equal(captured.init.headers.Authorization, 'Bearer k');
  const payload = JSON.parse(captured.init.body);
  assert.equal(payload.model, 'm');
  assert.equal(payload.stream, true);
  assert.equal(payload.max_tokens, 128);
});

test('signal 被透传给 fetch（客户端断开时才能中止上游）', async () => {
  const ac = new AbortController();
  let seen = null;
  await withFetch(
    async (_url, init) => { seen = init.signal; return sseResponse(['data: [DONE]\n\n']); },
    () => collect(chatStream({ ...base, signal: ac.signal })),
  );
  assert.equal(seen, ac.signal);
});

test('中止后异常向上传播，由路由转成错误帧', async () => {
  const ac = new AbortController();
  ac.abort(new Error('客户端已断开'));
  await withFetch(
    async () => { throw ac.signal.reason; },
    async () => {
      await assert.rejects(() => collect(chatStream({ ...base, signal: ac.signal })), /客户端已断开/);
    },
  );
});

test('非 2xx 响应抛出可读错误并带响应片段', async () => {
  await withFetch(
    async () => new Response('{"error":"invalid api key"}', { status: 401 }),
    async () => {
      await assert.rejects(() => collect(chatStream(base)), /401.*invalid api key/);
    },
  );
});

test('chatOnce 聚合完整文本', async () => {
  const chunks = [
    'data: {"choices":[{"delta":{"content":"连接"}}]}\n\n',
    'data: {"choices":[{"delta":{"content":"成功"}}]}\n\n',
    'data: [DONE]\n\n',
  ];
  const text = await withFetch(async () => sseResponse(chunks), () => chatOnce(base, [], 16));
  assert.equal(text, '连接成功');
});
