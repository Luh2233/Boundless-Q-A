// API Key 落盘加密（AES-256-GCM），密钥来自本机 data 目录下的随机 secret 文件。
//
// 目标不是防御拿到整机权限的攻击者，而是避免配置文件被误同步 / 误分享 / 误提交时，
// 第三方模型服务的额度凭证以明文形态泄露。解不开时一律降级为「未配置」，
// 让服务回落到演示模式，而不是抛错把应用卡死。
import crypto from 'node:crypto';
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';

const ALG = 'aes-256-gcm';
const PREFIX = 'v1.';
const IV_BYTES = 12;
const TAG_BYTES = 16;

/** 读取（或首次创建）本机 secret。文件权限在 POSIX 下收紧到 0600。 */
export async function loadOrCreateSecret(secretPath) {
  try {
    const raw = (await fsp.readFile(secretPath, 'utf8')).trim();
    if (raw) {
      const buf = Buffer.from(raw, 'base64');
      if (buf.length === 32) return buf;
    }
  } catch { /* 首次运行或文件损坏，下面重建 */ }

  const secret = crypto.randomBytes(32);
  await fsp.mkdir(path.dirname(secretPath), { recursive: true });
  await fsp.writeFile(secretPath, secret.toString('base64'), { encoding: 'utf8', mode: 0o600 });
  try { fs.chmodSync(secretPath, 0o600); } catch { /* Windows 不支持 POSIX 权限位 */ }
  return secret;
}

export function encryptSecret(plain, secret) {
  if (!plain) return '';
  const iv = crypto.randomBytes(IV_BYTES);
  const cipher = crypto.createCipheriv(ALG, secret, iv);
  const enc = Buffer.concat([cipher.update(String(plain), 'utf8'), cipher.final()]);
  return PREFIX + Buffer.concat([iv, cipher.getAuthTag(), enc]).toString('base64');
}

/** 解密失败（密钥轮换、文件被改、格式陈旧）统一返回空串。 */
export function decryptSecret(stored, secret) {
  if (!stored || typeof stored !== 'string' || !stored.startsWith(PREFIX)) return '';
  let buf;
  try { buf = Buffer.from(stored.slice(PREFIX.length), 'base64'); } catch { return ''; }
  if (buf.length <= IV_BYTES + TAG_BYTES) return '';
  const iv = buf.subarray(0, IV_BYTES);
  const tag = buf.subarray(IV_BYTES, IV_BYTES + TAG_BYTES);
  const data = buf.subarray(IV_BYTES + TAG_BYTES);
  try {
    const d = crypto.createDecipheriv(ALG, secret, iv);
    d.setAuthTag(tag);
    return Buffer.concat([d.update(data), d.final()]).toString('utf8');
  } catch {
    return '';
  }
}
