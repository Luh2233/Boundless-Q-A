import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash, generateKeyPairSync, sign } from 'node:crypto';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

test('ChatGPT PKCE 登录、模型强度、流式完成、串行续期及撤销', async context => {
  const dir = await mkdtemp(join(tmpdir(), 'wujie-chatgpt-test-'));
  process.env.WUJIE_DATA_DIR = dir;
  context.after(() => rm(dir, { recursive: true, force: true }));
  const { readChatGPTSession, writeChatGPTSession } = await import('../src/store.js');
  const chatgpt = await import('../src/chatgpt.js');
  const { privateKey, publicKey } = generateKeyPairSync('rsa', { modulusLength: 2048 });
  const clientId = 'issued-client_example';
  const scope = 'openid offline_access resource.invoke chatgpt.tokens.use.direct';
  let authorize;
  let renewals = 0;
  let revoked = false;
  let responseBody;
  let completed = true;
  let nonceMatches = true;
  let grantScope = scope;
  let responseFailure;
  let rejectAccess = false;
  let finalOnly = false;
  let temporaryConnectFailure = false;

  const token = () => {
    const encode = value => Buffer.from(JSON.stringify(value)).toString('base64url');
    const unsigned = encode({ alg: 'RS256', kid: 'test' }) + '.' + encode({
      iss: 'https://auth.openai.com', aud: clientId, sub: 'example-user',
      exp: Math.floor(Date.now() / 1000) + 3600,
      nonce: nonceMatches ? authorize.searchParams.get('nonce') : 'wrong',
      email: 'sample@example.test',
    });
    return unsigned + '.' + sign('RSA-SHA256', Buffer.from(unsigned), privateKey).toString('base64url');
  };

  context.mock.method(globalThis, 'fetch', async (url, options) => {
    switch (url) {
      case 'https://auth.openai.com/api/accounts/oauth/token': {
        const data = options.body;
        assert.equal(data.get('resource'), 'https://api.openai.com/v1');
        assert.equal(data.get('client_id'), clientId);
        if (data.get('grant_type') === 'refresh_token') {
          assert.equal(data.get('refresh_token'), renewals ? 'refresh-renewed' : 'refresh-first');
          renewals++;
          return Response.json({ access_token: renewals === 1 ? 'access-renewed' : 'access-final', refresh_token: 'refresh-renewed', expires_in: 3600 });
        }
        assert.equal(data.get('code'), 'example-code');
        assert.equal(data.get('redirect_uri'), 'http://127.0.0.1:8787/auth/callback');
        assert.equal(createHash('sha256').update(data.get('code_verifier')).digest('base64url'), authorize.searchParams.get('code_challenge'));
        return Response.json({ access_token: 'access-first', refresh_token: 'refresh-first', expires_in: 3600, scope: grantScope, id_token: token() });
      }
      case 'https://auth.openai.com/.well-known/jwks.json':
        return Response.json({ keys: [{ ...publicKey.export({ format: 'jwk' }), kid: 'test' }] });
      case 'https://api.openai.com/v1/models':
        return Response.json({ models: [
          { slug: 'gpt-visible', display_name: 'GPT Visible', visibility: 'list', supported_reasoning_levels: [{ effort: 'high' }, { effort: 'ultra' }] },
          { slug: 'hidden', display_name: 'Hidden', visibility: 'hide' },
        ] });
      case 'https://api.openai.com/v1/responses':
        if (temporaryConnectFailure) {
          temporaryConnectFailure = false;
          throw new TypeError('fetch failed', { cause: { code: 'UND_ERR_CONNECT_TIMEOUT' } });
        }
        if (rejectAccess && options.headers.Authorization === 'Bearer access-renewed') {
          return Response.json({error: {code: 'invalid_token'}}, {status: 401});
        }
        assert.equal(options.headers.Authorization, renewals === 1 ? 'Bearer access-renewed' : 'Bearer access-final');
        responseBody = JSON.parse(options.body);
        if (responseFailure) return Response.json({ error: responseFailure }, { status: 400 });
        if (finalOnly) return new Response('data: {"type":"response.completed","response":{"output":[{"type":"message","content":[{"type":"output_text","text":"完整要点"}]}]}}');
        return new Response('data: {"type":"response.output_text.delta","delta":"讲解"}\n\n' +
          (completed ? 'data: {"type":"response.completed"}\n\n' : ''));
      case 'https://auth.openai.com/api/accounts/oauth/revoke':
        assert.equal(options.body.get('token'), 'refresh-renewed');
        revoked = true;
        return new Response('');
      default:
        assert.fail(`Unexpected upstream request: ${url}`);
    }
  });
  const login = async options => {
    const { id } = await chatgpt.startChatGPTLogin(8787, options);
    authorize = new URL(await chatgpt.loginUrl(id));
    return { id, query: { state: authorize.searchParams.get('state'), client_id: clientId, code: 'example-code' } };
  };
  let attempt = await login();
  const hostId = authorize.searchParams.get('ext_agent_host_id');
  assert.equal(authorize.searchParams.get('client_id'), 'dynamic_agent_client');
  assert.equal(authorize.searchParams.get('code_challenge_method'), 'S256');
  await assert.rejects(chatgpt.finishChatGPTLogin({ ...attempt.query, state: 'wrong' }), { status: 400 });
  nonceMatches = false;
  await assert.rejects(chatgpt.finishChatGPTLogin(attempt.query), /无法验证/);
  assert.equal((await chatgpt.chatgptStatus()).connected, false);
  nonceMatches = true;
  grantScope = 'openid';
  attempt = await login();
  await assert.rejects(chatgpt.finishChatGPTLogin(attempt.query), { status: 403 });
  assert.equal((await chatgpt.chatgptStatus()).needsConsent, true);
  grantScope = scope;
  attempt = await login({ consent: true });
  assert.equal(authorize.searchParams.get('prompt'), 'consent');
  assert.equal(authorize.searchParams.get('client_id'), clientId);
  await chatgpt.finishChatGPTLogin(attempt.query);
  assert.equal((await chatgpt.loginStatus(attempt.id)).status, 'connected');
  await chatgpt.finishChatGPTLogin(attempt.query);
  assert.equal((await chatgpt.chatgptStatus()).account, 'sample@example.test');
  assert.ok(!(await readFile(join(dir, 'chatgpt.session'), 'utf8')).includes('refresh-first'));
  await writeChatGPTSession({ ...await readChatGPTSession(), expiresAt: 0 });
  const [models] = await Promise.all([chatgpt.chatgptModels(), chatgpt.chatgptModels()]);
  assert.equal(renewals, 1);
  assert.deepEqual(models, [{ id: 'gpt-visible', name: 'GPT Visible', efforts: ['high'] }]);
  await assert.rejects(chatgpt.validateChatGPTModel('gpt-visible', 'low'), { status: 400 });
  await assert.rejects(chatgpt.validateChatGPTModel('gpt-visible', 'ultra'), { status: 400 });
  const config = {
    chatgptModel: 'gpt-visible', chatgptEffort: 'high', temperature: 0, maxTokens: 20,
    messages: [{ role: 'system', content: '指令' }, { role: 'user', content: '问题' }],
  };
  const generate = async () => {
    let text = '';
    for await (const chunk of chatgpt.chatgptStream(config)) text += chunk;
    return text;
  };
  assert.equal(await generate(), '讲解');
  assert.deepEqual(responseBody, {
    model: 'gpt-visible', stream: true, store: false, reasoning: { effort: 'high' },
    input: [{ role: 'developer', content: '指令' }, { role: 'user', content: '问题' }],
  });
  responseFailure = { code: 'invalid_value', param: 'reasoning.effort' };
  await assert.rejects(generate(), { status: 400, message: /不支持所选推理强度/ });
  responseFailure = undefined;
  completed = false;
  await assert.rejects(generate(), /流式回答提前断开/);
  rejectAccess = true;
  finalOnly = true;
  temporaryConnectFailure = true;
  assert.equal(await generate(), '完整要点');
  assert.equal(renewals, 2);
  assert.equal((await chatgpt.chatgptStatus()).connected, true);
  assert.deepEqual(await chatgpt.disconnectChatGPT(), { revoked: true });
  assert.equal(revoked, true);
  assert.equal((await chatgpt.chatgptStatus()).connected, false);
  await login();
  assert.equal(authorize.searchParams.get('client_id'), clientId);
  assert.equal(authorize.searchParams.get('ext_agent_host_id'), hostId);
});
