// 文档 ID 的校验与安全路径拼接。
//
// 所有 ID 都按「不透明文件名主体」对待：只允许字母数字与 - _，长度受限，
// 不含路径分隔符、点号或任何需要二次解码的字符。这样 `../../x` 一类的输入
// 在到达 path.join 之前就被拒绝。
import path from 'node:path';

const ID_RE = /^[A-Za-z0-9_-]{1,64}$/;

export function isValidId(id) {
  return typeof id === 'string' && ID_RE.test(id);
}

export class InvalidIdError extends Error {
  constructor(id) {
    super(`无效的文档 ID：${String(id).slice(0, 32)}`);
    this.name = 'InvalidIdError';
    this.status = 400;
  }
}

/**
 * 在 baseDir 下解析 `<id><suffix>`。
 * 双重防护：格式白名单 + resolve 后前缀校验（后者不依赖白名单是否完备）。
 */
export function safePath(baseDir, id, suffix) {
  if (!isValidId(id)) throw new InvalidIdError(id);
  const root = path.resolve(baseDir);
  const resolved = path.resolve(root, `${id}${suffix}`);
  if (!resolved.startsWith(root + path.sep)) throw new InvalidIdError(id);
  return resolved;
}
