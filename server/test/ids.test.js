import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { isValidId, safePath, InvalidIdError } from '../src/ids.js';

test('isValidId: 接受 UUID 与常见安全 ID', () => {
  assert.equal(isValidId('83382824-982f-451e-97fc-f90e819221a4'), true);
  assert.equal(isValidId('abc_123'), true);
  assert.equal(isValidId('A'.repeat(64)), true);
});

test('isValidId: 拒绝一切路径片段与超长输入', () => {
  for (const bad of [
    '', '..', '.', '../x', '../../etc/passwd', 'a/b', 'a\\b',
    'x.json', '.hidden', 'a b', 'a%2Fb', 'A'.repeat(65), null, undefined, 123, {},
  ]) {
    assert.equal(isValidId(bad), false, `应拒绝：${String(bad)}`);
  }
});

test('safePath: 正常拼接落在目标目录内', () => {
  const base = path.resolve('/tmp/data/docs');
  assert.equal(safePath(base, 'abc-123', '.json'), path.join(base, 'abc-123.json'));
});

test('safePath: 穿越尝试抛 InvalidIdError（而不是悄悄拼出越界路径）', () => {
  const base = path.resolve('/tmp/data/docs');
  for (const bad of ['../secret', '..', '../../config', 'a/b', 'a\\b']) {
    assert.throws(() => safePath(base, bad, '.json'), InvalidIdError, `应拒绝：${bad}`);
  }
});

test('InvalidIdError 携带 400 状态，便于路由直接映射', () => {
  const err = new InvalidIdError('..');
  assert.equal(err.status, 400);
  assert.equal(err.name, 'InvalidIdError');
});
