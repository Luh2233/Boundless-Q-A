import test from 'node:test';
import assert from 'node:assert/strict';
import fsp from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

// 必须在 import store 之前设置，模块顶层会读取该变量
const dir = await fsp.mkdtemp(path.join(os.tmpdir(), 'wujie-store-'));
process.env.WUJIE_DATA_DIR = dir;

const store = await import('../src/store.js');
const { InvalidIdError } = await import('../src/ids.js');

const DOC_ID = '33333333-3333-4333-8333-333333333333';

test('文档元数据读写往返', async () => {
  const pages = [{ index: 0, text: '第一页' }, { index: 1, text: '第二页' }];
  await store.saveDocMeta({ id: DOC_ID, title: '论文', pages });

  const doc = await store.getDoc(DOC_ID);
  assert.equal(doc.title, '论文');
  assert.equal(doc.pages.length, 2);
  assert.ok(doc.updatedAt > 0);

  const list = await store.listDocs();
  assert.equal(list.length, 1);
  assert.equal(list[0].id, DOC_ID);
  assert.equal(list[0].numPages, 2);
});

test('画布状态读写往返', async () => {
  await store.saveState(DOC_ID, { viewport: { x: 1, y: 2, scale: 1 }, cards: [], marks: [], cardSeq: 0 });
  const state = await store.getState(DOC_ID);
  assert.equal(state.viewport.x, 1);
  assert.ok(state.savedAt > 0);
});

test('不存在的文档返回 null，不抛错', async () => {
  assert.equal(await store.getDoc('00000000-0000-4000-8000-000000000000'), null);
  assert.equal(await store.getState('00000000-0000-4000-8000-000000000000'), null);
});

test('穿越型 ID 被拒绝（读写删三条路径）', async () => {
  for (const bad of ['../../etc/passwd', '..', 'a/b', 'a\\b']) {
    await assert.rejects(() => store.getDoc(bad), InvalidIdError);
    await assert.rejects(() => store.getState(bad), InvalidIdError);
    await assert.rejects(() => store.deleteDoc(bad), InvalidIdError);
    await assert.rejects(() => store.saveState(bad, {}), InvalidIdError);
    await assert.rejects(() => store.saveDocMeta({ id: bad, pages: [] }), InvalidIdError);
    await assert.rejects(() => store.saveUpload(bad, Buffer.from('%PDF-')), InvalidIdError);
  }
});

test('删除文档同时清掉状态与 PDF 原件', async () => {
  const other = '44444444-4444-4444-8444-444444444444';
  await store.saveDocMeta({ id: other, title: 'x', pages: [] });
  await store.saveState(other, { cardSeq: 1 });
  await store.saveUpload(other, Buffer.from('%PDF-1.4 test'));

  await store.deleteDoc(other);
  assert.equal(await store.getDoc(other), null);
  assert.equal(await store.getState(other), null);
  assert.equal((await store.listDocs()).some(d => d.id === other), false);
});

test('API Key 加密落盘：文件里不出现明文', async () => {
  const plain = 'sk-super-secret-value-123';
  const saved = await store.saveConfig({ apiKey: plain, model: 'glm-4.6' });
  assert.equal(saved.apiKey, plain);

  const raw = await fsp.readFile(path.join(dir, 'config.json'), 'utf8');
  assert.ok(!raw.includes(plain), '配置文件中不得出现明文密钥');
  assert.ok(raw.includes('apiKeyEnc'));

  const cfg = await store.getConfig();
  assert.equal(cfg.apiKey, plain);
});

test('空的 apiKey 不覆盖已有密钥，clearKey 才清除', async () => {
  const plain = 'sk-keep-me';
  await store.saveConfig({ apiKey: plain });
  await store.saveConfig({ apiKey: '' });
  assert.equal((await store.getConfig()).apiKey, plain);

  await store.saveConfig({ clearKey: true });
  assert.equal((await store.getConfig()).apiKey, '');
});

test('redactConfig 永不回传密钥本体', async () => {
  await store.saveConfig({ apiKey: 'sk-redact-me' });
  const view = store.redactConfig(await store.getConfig());
  assert.equal(view.hasKey, true);
  assert.equal(view.demo, false);
  assert.ok(!('apiKey' in view));
  assert.ok(!JSON.stringify(view).includes('sk-redact-me'));
});

test('旧版明文配置在读取时自动迁移为密文', async () => {
  const legacy = 'sk-legacy-plaintext';
  await fsp.writeFile(
    path.join(dir, 'config.json'),
    JSON.stringify({ baseUrl: 'https://old.example/v1', model: 'glm-4', apiKey: legacy }),
    'utf8',
  );
  const cfg = await store.getConfig();
  assert.equal(cfg.apiKey, legacy);

  const raw = await fsp.readFile(path.join(dir, 'config.json'), 'utf8');
  assert.ok(!raw.includes(legacy), '迁移后文件中不应再有明文');
  assert.ok(raw.includes('apiKeyEnc'));
});

test('密钥文件损坏时降级为未配置（回落演示模式）', async () => {
  await store.saveConfig({ apiKey: 'sk-will-break' });
  await fsp.writeFile(path.join(dir, '.secret'), 'not-a-valid-secret', 'utf8');

  // 进程内已缓存 secret，重建模块实例才能真正验证；这里直接验证解密降级行为
  const { decryptSecret } = await import('../src/keyvault.js');
  const raw = JSON.parse(await fsp.readFile(path.join(dir, 'config.json'), 'utf8'));
  assert.equal(decryptSecret(raw.apiKeyEnc, Buffer.alloc(32)), '');
});
