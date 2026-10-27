import test from 'node:test'
import assert from 'node:assert/strict'
import { contextAround, squeeze } from '../src/lib/text.ts'

test('squeeze: 去掉空白并保留下标映射（末位是原文长度哨兵）', () => {
  const { text, map } = squeeze('a b\nc')
  assert.equal(text, 'abc')
  assert.deepEqual(map, [0, 2, 4, 5])
})

test('contextAround: 前后文必须保留英文空格（回归：旧实现把空格全删了）', () => {
  const paper =
    'Diffusion models gradually reversing a fixed noising process. ' +
    'Starting from pure noise, the sampler walks back to data.'
  const ctx = contextAround(paper, 'gradually reversing', 40)
  assert.ok(ctx.includes('models gradually reversing a fixed'), `实际得到：${ctx}`)
  assert.ok(!ctx.includes('graduallyreversing'), '不得出现单词粘连')
})

test('contextAround: 选段与原文空白不一致时仍能定位', () => {
  const full = 'hello\n\nworld   again'
  // 用户选区里的换行被压成了单个空格
  assert.equal(contextAround(full, 'world again', 200), full)
})

test('contextAround: 超出原文时按半径截断', () => {
  const full = 'A'.repeat(1000) + 'NEEDLE' + 'B'.repeat(1000)
  const ctx = contextAround(full, 'NEEDLE', 10)
  assert.ok(ctx.includes('NEEDLE'))
  assert.equal(ctx.length, 10 + 'NEEDLE'.length + 10)
})

test('contextAround: 找不到选段时回退到文首', () => {
  const full = 'C'.repeat(100)
  assert.equal(contextAround(full, '根本不存在', 10), full.slice(0, 20))
})

test('contextAround: 中文论文正常', () => {
  const full = '前向过程逐步向数据中加入高斯噪声，反向过程学习去噪。'
  const ctx = contextAround(full, '学习去噪', 6)
  assert.equal(ctx, '声，反向过程学习去噪。')
})

test('contextAround: 空输入安全', () => {
  assert.equal(contextAround('', 'x'), '')
  assert.equal(contextAround('abc', ''), '')
  assert.equal(contextAround('abc', '   '), '')
})

test('contextAround: 半径覆盖全文时不截断', () => {
  const full = 'short text'
  assert.equal(contextAround(full, 'text', 9999), full)
})
