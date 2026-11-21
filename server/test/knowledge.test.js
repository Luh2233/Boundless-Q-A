import test from 'node:test';
import assert from 'node:assert/strict';
import { readKnowledgeOutput } from '../src/knowledge.js';

test('提炼接受中文紧凑编号、标题式问题，并分开保存问题和要点', () => {
  const text = '### **问题：** 偶数个样本如何计算中位数？\n\n复习要点\n1、先排序。\n（2）取中间两项的平均值。';
  assert.deepEqual(readKnowledgeOutput(text, '怎么算？', true), {
    reviewQuestion: '偶数个样本如何计算中位数？',
    points: ['先排序。', '取中间两项的平均值。'],
  });
});

test('提炼接受围栏内的 JSON，保留手写问句并拒绝不完整的 JSON', () => {
  const payload = '```json\n{"points":["要点一","要点二"],"reviewQuestion":"同一问题?"}\n```';
  assert.deepEqual(readKnowledgeOutput(payload, '同一问题？', true), {
    points: ['要点一', '要点二'], reviewQuestion: undefined,
  });
  assert.deepEqual(readKnowledgeOutput('["未完成', '问题', true).points, []);
  assert.deepEqual(readKnowledgeOutput('无法补全。', '问题', true).points, []);
});
