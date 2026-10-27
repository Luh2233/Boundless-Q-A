import test from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import { encryptSecret, decryptSecret } from '../src/keyvault.js';

const secret = crypto.randomBytes(32);

test('加解密往返一致，密文不含明文', () => {
  const plain = 'sk-test-1234567890abcdef';
  const enc = encryptSecret(plain, secret);
  assert.ok(enc.startsWith('v1.'));
  assert.ok(!enc.includes(plain));
  assert.equal(decryptSecret(enc, secret), plain);
});

test('同一明文两次加密结果不同（随机 IV）', () => {
  const a = encryptSecret('same', secret);
  const b = encryptSecret('same', secret);
  assert.notEqual(a, b);
  assert.equal(decryptSecret(a, secret), decryptSecret(b, secret));
});

test('空值不产生密文', () => {
  assert.equal(encryptSecret('', secret), '');
  assert.equal(decryptSecret('', secret), '');
});

test('密钥错误或密文被篡改时返回空串而不抛错', () => {
  const enc = encryptSecret('sk-secret', secret);
  assert.equal(decryptSecret(enc, crypto.randomBytes(32)), '');

  const buf = Buffer.from(enc.slice(3), 'base64');
  buf[buf.length - 1] ^= 0xff; // 破坏认证标签覆盖的数据
  assert.equal(decryptSecret('v1.' + buf.toString('base64'), secret), '');
});

test('未知格式与垃圾输入安全降级', () => {
  assert.equal(decryptSecret('not-a-v1-value', secret), '');
  assert.equal(decryptSecret('v1.@@@', secret), '');
  assert.equal(decryptSecret('v1.' + Buffer.alloc(4).toString('base64'), secret), '');
});
