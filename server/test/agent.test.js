import test from 'node:test';
import assert from 'node:assert/strict';
import {
  MEMO_MARKER, createMemoGate, holdbackLength, parseMemo,
  docContext, buildExplainMessages, buildFollowupMessages,
  mockExplain, mockFollowup,
} from '../src/agent.js';

/* ---------------- hold-back 守门器 ---------------- */

test('holdbackLength: 只有真正构得成 marker 前缀时才扣字符', () => {
  assert.equal(holdbackLength('普通正文', MEMO_MARKER), 0);
  assert.equal(holdbackLength('正文-', MEMO_MARKER), 1); // 单个 '-' 也可能是 marker 开头
  assert.equal(holdbackLength('正文---MEM', MEMO_MARKER), 6);
  assert.equal(holdbackLength('正文---', MEMO_MARKER), 3);
  assert.equal(holdbackLength('', MEMO_MARKER), 0);
});

test('无 MEMO 标记时 finish 必须把尾巴全部吐出（回归：旧实现固定丢最后 10 字符）', () => {
  const gate = createMemoGate();
  let out = '';
  for (const ch of ['讲解', '正文', '到此结束。']) out += gate.push(ch);
  out += gate.finish();
  assert.equal(out, '讲解正文到此结束。');
  assert.equal(gate.truncated, true);
});

test('正文末尾疑似 marker 前缀：先扣住，收敛后补出', () => {
  const gate = createMemoGate();
  const first = gate.push('正文---MEM');
  assert.equal(first, '正文'); // '---MEM' 可能是 marker 开头，必须扣住
  assert.equal(gate.finish(), '---MEM'); // 模型没继续写 marker → 原样吐出
});

test('marker 跨 chunk 时正文正常下发且元数据不外泄', () => {
  const gate = createMemoGate();
  let out = '';
  out += gate.push('讲解正文');
  out += gate.push('\n---MEM');
  out += gate.push('O---\n{"summary":"s","concepts":["a"],"related":[2]}');
  out += gate.finish();
  assert.equal(out, '讲解正文\n');
  assert.ok(!out.includes('MEMO'));
  assert.ok(!out.includes('summary'));
  assert.equal(gate.truncated, false);
});

test('marker 出现在最开头时整段都不下发', () => {
  const gate = createMemoGate();
  assert.equal(gate.push('---MEMO---{"summary":"x"}'), '');
  assert.equal(gate.finish(), '');
});

test('gate.full 保留完整输出供 parseMemo 使用', () => {
  const gate = createMemoGate();
  gate.push('正文\n---MEMO---\n{"summary":"摘要","concepts":["x"],"related":[]}');
  gate.finish();
  assert.equal(parseMemo(gate.full).body, '正文');
  assert.equal(parseMemo(gate.full).memo.summary, '摘要');
});

/* ---------------- 输出解析 ---------------- */

test('parseMemo: 标准输出分离正文与记忆', () => {
  const { body, memo } = parseMemo(
    '这是讲解正文。\n\n---MEMO---\n{"summary":"摘要","concepts":["扩散","噪声"],"related":[1,3]}',
  );
  assert.equal(body, '这是讲解正文。');
  assert.equal(memo.summary, '摘要');
  assert.deepEqual(memo.concepts, ['扩散', '噪声']);
  assert.deepEqual(memo.related, [1, 3]);
});

test('parseMemo: 无标记时用正文首句兜底', () => {
  const { body, memo } = parseMemo('## 标题\n\n**一句话：** 这段在讲扩散模型。');
  assert.equal(body.includes('MEMO'), false);
  assert.ok(memo.summary.length > 0);
  assert.ok(!memo.summary.startsWith('#'));
  assert.deepEqual(memo.related, []);
});

test('parseMemo: JSON 被代码围栏包裹也能解析', () => {
  const { memo } = parseMemo('正文\n---MEMO---\n```json\n{"summary":"围栏","concepts":[],"related":[]}\n```');
  assert.equal(memo.summary, '围栏');
});

test('parseMemo: JSON 损坏时降级而不是抛错', () => {
  const { memo } = parseMemo('正文\n---MEMO---\n{ summary: 坏的 }');
  assert.equal(typeof memo.summary, 'string');
  assert.deepEqual(memo.concepts, []);
});

test('parseMemo: related 里的非数字被过滤掉', () => {
  const { memo } = parseMemo('正文\n---MEMO---\n{"summary":"s","concepts":[],"related":[1,"x",null,2]}');
  assert.deepEqual(memo.related, [1, 2]);
});

/* ---------------- 论文上下文 ---------------- */

const makeDoc = (pages, charsPerPage) => ({
  title: '测试论文',
  pages: Array.from({ length: pages }, (_, i) => ({ index: i, text: 'A'.repeat(charsPerPage) })),
});

test('docContext: 短论文全文给足', () => {
  const text = docContext(makeDoc(2, 100), null);
  assert.ok(text.includes('【第1页】'));
  assert.ok(text.includes('【第2页】'));
});

test('docContext: 超长论文只保留选段页±1、首尾页，其余给开头摘要', () => {
  const text = docContext(makeDoc(10, 4000), 3); // 总长 40000 > 26000
  assert.ok(text.includes('【第3页】'));
  assert.ok(text.includes('【第2页】'));
  assert.ok(text.includes('【第1页】') || text.includes('【第1页】'));
  assert.ok(text.includes('【第5页·开头】'));
  assert.ok(text.includes('【第10页】'));
});

/* ---------------- 提示词组装 ---------------- */

test('buildExplainMessages: 缺选段直接拒绝', () => {
  assert.throws(() => buildExplainMessages(makeDoc(1, 10), {}), /缺少选段内容/);
  assert.throws(() => buildExplainMessages(makeDoc(1, 10), { selectionText: '   ' }), /缺少选段内容/);
});

test('buildExplainMessages: 选段与前后文被截断，不会被客户端灌爆', () => {
  const msgs = buildExplainMessages(makeDoc(1, 10), {
    selectionText: 'X'.repeat(99999),
    contextText: 'Y'.repeat(99999),
    question: 'Z'.repeat(99999),
    cards: Array.from({ length: 5000 }, (_, i) => ({ id: i, depth: 1, summary: 's', concepts: ['c'] })),
  });
  const user = msgs[1].content;
  assert.ok(user.length < 4000 + 8000 + 2000 + 200 * 60 + 6000);
  assert.equal((user.match(/卡片#/g) || []).length, 200);
});

test('buildExplainMessages: 祖先链最多取 4 层，且取最近的四层', () => {
  const ancestors = Array.from({ length: 9 }, (_, i) => ({ id: String(i), content: `第${i}层`, sourceText: 'x' }));
  const user = buildExplainMessages(makeDoc(1, 10), { selectionText: 'sel', ancestors })[1].content;
  assert.ok(user.includes('卡片#8'));
  assert.ok(!user.includes('卡片#0'));
});

test('buildExplainMessages: 画布记忆索引与选段都在', () => {
  const user = buildExplainMessages(makeDoc(1, 10), {
    selectionText: '扩散过程',
    sourceDesc: '论文第1页',
    cards: [{ id: 1, depth: 1, summary: '前向过程', concepts: ['噪声'] }],
  })[1].content;
  assert.ok(user.includes('【画布上已有的讲解记忆】'));
  assert.ok(user.includes('卡片#1｜第1层｜前向过程｜关键词：噪声'));
  assert.ok(user.includes('>>> 扩散过程 <<<'));
});

test('buildFollowupMessages: 缺问题直接拒绝', () => {
  assert.throws(() => buildFollowupMessages(makeDoc(1, 10), {}), /缺少追问内容/);
});

test('buildFollowupMessages: 追问记录最多带最近 8 条', () => {
  const followups = Array.from({ length: 30 }, (_, i) => ({ q: `问${i}`, a: `答${i}` }));
  const user = buildFollowupMessages(makeDoc(1, 10), {
    question: '新问题', cardId: '1', content: '讲解', followups,
  })[1].content;
  assert.ok(user.includes('问29'));
  assert.ok(!user.includes('问0\n'));
});

/* ---------------- 演示模式 ---------------- */

test('mockExplain 产出能被 parseMemo 正确分离', () => {
  const { body, memo } = parseMemo(mockExplain({ selectionText: '一段选段', sourceDesc: '论文第1页' }));
  assert.ok(body.startsWith('**一句话：**'));
  assert.ok(!body.includes('MEMO'));
  assert.equal(memo.concepts[0], '演示模式');
});

test('mockFollowup 不含函数调用痕迹', () => {
  assert.ok(mockFollowup({ question: '为什么' }).includes('为什么'));
});
