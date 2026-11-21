// 简单的文件持久化：配置 / 文档元数据（含全文）/ 画布状态 / 上传的 PDF。
//
// 安全约定：
// - 所有对外可见的 ID 先过 ids.js 的白名单再拼路径（防目录穿越）；
// - apiKey 以 AES-256-GCM 加密后落盘（见 keyvault.js），旧版明文配置在读取时自动迁移。
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { isValidId, safePath, InvalidIdError } from './ids.js';
import { loadOrCreateSecret, encryptSecret, decryptSecret } from './keyvault.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
// 测试用临时目录覆盖，避免污染真实数据
const DATA = process.env.WUJIE_DATA_DIR
  ? path.resolve(process.env.WUJIE_DATA_DIR)
  : path.resolve(__dirname, '../data');
const DOCS = path.join(DATA, 'docs');
const UPLOADS = path.join(DATA, 'uploads');
const CONFIG = path.join(DATA, 'config.json');
const SECRET = path.join(DATA, '.secret');
const CHATGPT_SESSION = path.join(DATA, 'chatgpt.session');
const CHATGPT_LOGIN = path.join(DATA, 'chatgpt.login');

const DEFAULT_CONFIG = {
  baseUrl: 'https://open.bigmodel.cn/api/paas/v4',
  apiKey: '',
  model: 'glm-4.6',
};

async function ensure() {
  for (const d of [DATA, DOCS, UPLOADS]) await fsp.mkdir(d, { recursive: true });
}

const docFile = id => safePath(DOCS, id, '.json');
const stateFile = id => safePath(DOCS, id, '.state.json');
const pdfFile = id => safePath(UPLOADS, id, '.pdf');

/* ---------------- 配置 ---------------- */

let secretPromise = null;
function secret() {
  if (!secretPromise) secretPromise = loadOrCreateSecret(SECRET);
  return secretPromise;
}

async function writeConfig({ baseUrl, model, apiKeyEnc, mode, chatgptModel, chatgptEffort }) {
  await ensure();
  const body = { baseUrl, model, apiKeyEnc: apiKeyEnc || '', mode, chatgptModel, chatgptEffort };
  await fsp.writeFile(CONFIG, JSON.stringify(body, null, 2), 'utf8');
}

export async function getConfig() {
  await ensure();
  let raw = {};
  try {
    raw = JSON.parse(await fsp.readFile(CONFIG, 'utf8')) || {};
  } catch { /* 无配置或损坏，用默认值 */ }

  const baseUrl = typeof raw.baseUrl === 'string' && raw.baseUrl ? raw.baseUrl : DEFAULT_CONFIG.baseUrl;
  const model = typeof raw.model === 'string' && raw.model ? raw.model : DEFAULT_CONFIG.model;
  const prefs = {
    mode: raw.mode === 'chatgpt' ? 'chatgpt' : 'api',
    chatgptModel: raw.chatgptModel || '',
    chatgptEffort: raw.chatgptEffort || '',
  };

  const s = await secret();
  let apiKey = decryptSecret(raw.apiKeyEnc, s);

  // 旧版明文 apiKey：读到就迁移为密文，并抹掉明文
  if (!apiKey && typeof raw.apiKey === 'string' && raw.apiKey) {
    apiKey = raw.apiKey;
    await writeConfig({ baseUrl, model, ...prefs, apiKeyEnc: encryptSecret(apiKey, s) });
  }

  return { baseUrl, model, apiKey, ...prefs };
}

/** 对外响应用的投影：永不回传密钥本体。 */
export function redactConfig(cfg) {
  return {
    baseUrl: cfg.baseUrl, model: cfg.model, hasKey: !!cfg.apiKey, demo: cfg.mode === 'api' && !cfg.apiKey,
    mode: cfg.mode, chatgptModel: cfg.chatgptModel, chatgptEffort: cfg.chatgptEffort,
  };
}

export async function saveConfig(patch = {}) {
  const cur = await getConfig();
  const baseUrl = typeof patch.baseUrl === 'string' && patch.baseUrl ? patch.baseUrl : cur.baseUrl;
  const model = typeof patch.model === 'string' && patch.model ? patch.model : cur.model;

  let apiKey = cur.apiKey;
  if (patch.clearKey) apiKey = '';
  // 空值不覆盖已有 key（与旧行为一致）
  else if (typeof patch.apiKey === 'string' && patch.apiKey.trim()) apiKey = patch.apiKey.trim();

  const next = {
    baseUrl, model, apiKey,
    mode: patch.mode ?? cur.mode,
    chatgptModel: patch.chatgptModel ?? cur.chatgptModel,
    chatgptEffort: patch.chatgptEffort ?? cur.chatgptEffort,
  };
  await writeConfig({ ...next, apiKeyEnc: encryptSecret(apiKey, await secret()) });
  return next;
}

async function readProtectedJson(file) {
  try {
    const stored = await fsp.readFile(file, 'utf8');
    return JSON.parse(decryptSecret(stored, await secret()));
  } catch {
    return null;
  }
}

async function writeProtectedJson(file, value) {
  const temp = `${file}.${randomUUID()}.tmp`;
  await ensure();
  try {
    await fsp.writeFile(temp, encryptSecret(JSON.stringify(value), await secret()), { mode: 0o600 });
    await fsp.rename(temp, file);
  } finally {
    await fsp.rm(temp, { force: true });
  }
}

export const readChatGPTSession = () => readProtectedJson(CHATGPT_SESSION);
export const writeChatGPTSession = session => writeProtectedJson(CHATGPT_SESSION, session);
export const readChatGPTLogin = () => readProtectedJson(CHATGPT_LOGIN);
export const writeChatGPTLogin = login => writeProtectedJson(CHATGPT_LOGIN, login);

/* ---------------- 文档 ---------------- */

export async function saveUpload(id, buf) {
  await ensure();
  await fsp.writeFile(pdfFile(id), buf);
}

export function uploadPath(id) {
  return pdfFile(id);
}

export async function saveDocMeta(doc) {
  await ensure();
  const file = docFile(doc?.id); // 非法 ID 直接抛，不写入任何位置
  await fsp.writeFile(file, JSON.stringify({ ...doc, updatedAt: Date.now() }, null, 2), 'utf8');
}

export async function getDoc(id) {
  const file = docFile(id); // 非法 ID 抛 InvalidIdError，交由路由转 400
  try {
    return JSON.parse(await fsp.readFile(file, 'utf8'));
  } catch {
    return null;
  }
}

export async function findMatchingUpload(buffer) {
  await ensure();
  for (const file of await fsp.readdir(UPLOADS)) {
    if (!file.endsWith('.pdf')) continue;
    const id = file.slice(0, -4);
    if (!isValidId(id)) continue;
    try {
      const path = pdfFile(id);
      if ((await fsp.stat(path)).size !== buffer.length) continue;
      if ((await fsp.readFile(path)).equals(buffer)) return id;
    } catch (error) {
      if (error.code !== 'ENOENT') throw error;
    }
  }
  return null;
}

export async function listDocs({ withHistory = false } = {}) {
  await ensure();
  const files = (await fsp.readdir(DOCS)).filter(f => f.endsWith('.json') && !f.endsWith('.state.json'));
  const docs = [];
  for (const f of files) {
    // 目录里可能残留非本系统命名的文件，逐个过白名单
    const id = f.slice(0, -'.json'.length);
    if (!isValidId(id)) continue;
    try {
      const d = JSON.parse(await fsp.readFile(path.join(DOCS, f), 'utf8'));
      const state = withHistory ? await getState(id) : null;
      if (withHistory && !state?.cards?.length) continue;
      docs.push({ id: d.id, title: d.title, numPages: d.pages?.length || 0, updatedAt: state?.savedAt || d.updatedAt || 0 });
    } catch { /* 跳过坏文件 */ }
  }
  docs.sort((a, b) => b.updatedAt - a.updatedAt);
  return docs;
}

const stateWrites = new Map();

async function queueStateWrite(id, action) {
  const write = (stateWrites.get(id) ?? Promise.resolve()).then(action);
  const tail = write.then(() => {}, () => {});
  stateWrites.set(id, tail);
  try {
    return await write;
  } finally {
    if (stateWrites.get(id) === tail) stateWrites.delete(id);
  }
}

export async function deleteDoc(id) {
  const targets = [docFile(id), stateFile(id), pdfFile(id)];
  await queueStateWrite(id, async () => {
    for (const file of targets) await fsp.rm(file, { force: true });
  });
}

export async function saveState(id, state) {
  const file = stateFile(id);
  return queueStateWrite(id, async () => {
    try {
      await fsp.access(docFile(id));
    } catch (error) {
      if (error.code === 'ENOENT') return false;
      throw error;
    }
    const temporary = `${file}.${randomUUID()}.tmp`;
    try {
      await fsp.writeFile(temporary, JSON.stringify({ ...state, savedAt: Date.now() }), 'utf8');
      await fsp.rename(temporary, file);
    } catch (error) {
      await fsp.rm(temporary, { force: true }).catch(() => {});
      throw error;
    }
    return true;
  });
}

export async function getState(id) {
  const file = stateFile(id);
  await stateWrites.get(id);
  try {
    return JSON.parse(await fsp.readFile(file, 'utf8'));
  } catch (error) {
    if (error.code === 'ENOENT') return null;
    throw error;
  }
}

/* ---------------- 静态托管 ---------------- */

export function staticDir() {
  return path.resolve(__dirname, '../../client/dist');
}

export function distExists() {
  return fs.existsSync(staticDir());
}

export { isValidId, InvalidIdError };
