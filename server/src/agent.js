// 「无界问答」讲解智能体：负责组装上下文（论文全文 + 画布记忆 + 祖先讲解链）、
// 构造提示词、解析模型输出末尾的记忆元数据（---MEMO--- JSON）。
//
// 注意本模块只做「上下文装配 + 输出结构化」，不发起任何模型调用；
// 流式转发与 hold-back 由 index.js 通过 createMemoGate() 驱动。

export const MEMO_MARKER = '---MEMO---';

/* 输入规模上限：客户端可提交任意内容，服务端必须自己封顶，否则 prompt 会被灌爆。 */
const LIMITS = {
  selection: 4000,
  context: 8000,
  question: 2000,
  ancestors: 4,
  ancestorChars: 4500,
  cards: 200,
  cardSummary: 80,
  cardConcepts: 8,
};

const SYSTEM_EXPLAIN = `你是「无界问答」画布上的论文讲解智能体。用户正在一张无限画布上阅读论文：他会划选论文原文、或划选你之前生成的讲解内容，请你针对选段生成一张新的讲解卡片。

## 你掌握的材料
- 论文全文（按页编号提供，篇幅较长时可能只给选段所在页与首尾页）
- 画布上已有讲解卡片的记忆索引（每张卡片有编号、摘要与关键词）
- 若选段来自某张讲解卡片，会提供那张卡片及其上层卡片的完整内容

## 讲解要求
1. 开头用一句加粗的话，直白回答「这段到底在讲什么」，不要复述原文。
2. 然后用二级标题分小节展开：
   - **拆解**：选段里每个关键概念/术语，用大白话和贴切的类比讲透，必要时举个小例子。
   - **在论文中的位置**：这段在整个论证链条里起什么作用，与前后文、方法或实验的关系。
   - **联系**：若「画布记忆」中已有相关的讲解卡片（编号对应），明确指出本讲解与卡片#几 呼应或深化；没有相关内容时可省略此节。
3. 数学表达式用 $...$（行内）或 $$...$$（独立公式）书写 LaTeX。
4. 用中文讲解；术语首次出现时在括号里给出英文原文。
5. 语气像一位耐心的学长：准确、克制、不堆砌背景；论文未说明的内容明说「论文未说明」。
6. 长度聚焦选段本身，不写无关的长篇背景。

## 输出格式（严格遵守）
先输出讲解正文（Markdown）。正文结束后，另起一行输出分隔标记：
---MEMO---
随后输出一行 JSON（供系统建立记忆，用户不会看到）：
{"summary":"不超过30字的卡片摘要","concepts":["关键词",...],"related":[相关卡片编号,...]}
related 只能从「画布记忆」列出的编号中选取；没有就给空数组。不要输出 JSON 之外的任何解释。`;

const SYSTEM_FOLLOWUP = `你是「无界问答」的论文讲解智能体。用户正在一张讲解卡片下追问。
你拥有：论文全文、该卡片的原始讲解内容、此前该卡片下的追问记录。
请直接回答用户的问题：准确、聚焦，必要时给例子和公式（$...$ 或 $$...$$），
若与画布上其他讲解相关可以顺带指出。用中文回答，术语标注英文。
不要输出 ---MEMO--- 标记。`;

const str = v => (typeof v === 'string' ? v : v == null ? '' : String(v));
const clip = (v, n) => {
  const s = str(v);
  return s.length > n ? s.slice(0, n) : s;
};

export function docContext(doc, page) {
  if (!doc || !doc.pages?.length) return '（论文文本暂缺）';
  const pages = doc.pages;
  const fullLen = pages.reduce((s, p) => s + (p.text || '').length, 0);
  if (fullLen <= 26000) {
    return pages.map(p => `【第${p.index + 1}页】\n${p.text}`).join('\n\n');
  }
  const keep = new Set([0, pages.length - 1]);
  if (Number.isInteger(page) && page >= 1 && page <= pages.length) {
    for (const i of [page - 2, page - 1, page]) if (i >= 0 && i < pages.length) keep.add(i);
  }
  const parts = [];
  pages.forEach((p, i) => {
    if (keep.has(i)) parts.push(`【第${i + 1}页】\n${(p.text || '').slice(0, 9000)}`);
    else parts.push(`【第${i + 1}页·开头】${(p.text || '').slice(0, 130).replace(/\s+/g, ' ')}…`);
  });
  return parts.join('\n\n');
}

function memoryIndex(cards) {
  if (!Array.isArray(cards) || !cards.length) return '';
  const rows = cards.slice(0, LIMITS.cards).map(c => {
    const concepts = Array.isArray(c.concepts) ? c.concepts.slice(0, LIMITS.cardConcepts).map(str) : [];
    return `卡片#${Number(c.id)}｜第${Number(c.depth) || 1}层｜${clip(c.summary, LIMITS.cardSummary)}｜关键词：${concepts.join('、')}`;
  });
  return `【画布上已有的讲解记忆】\n${rows.join('\n')}`;
}

export function buildExplainMessages(doc, req = {}) {
  const selectionText = str(req.selectionText);
  if (!selectionText.trim()) throw new Error('缺少选段内容');

  const parts = [];
  parts.push(`【论文】《${clip(doc?.title || '未命名文档', 200)}》`);
  parts.push(`【论文文本】\n${docContext(doc, req.page)}`);

  const ancestors = Array.isArray(req.ancestors) ? req.ancestors.slice(-LIMITS.ancestors) : [];
  if (ancestors.length) {
    parts.push(`【本次选段所在的讲解卡片（从上层到本层）】\n` +
      ancestors.map(a =>
        `卡片#${str(a.id)}（其讲解对象：「${clip(a.sourceText, 80)}」）：\n${clip(a.content, LIMITS.ancestorChars)}`
      ).join('\n\n'));
  }

  const memory = memoryIndex(req.cards);
  if (memory) parts.push(memory);

  parts.push(`【本次要讲解的选段】（出处：${clip(req.sourceDesc, 120) || '论文'}）\n>>> ${clip(selectionText, LIMITS.selection)} <<<`);
  const contextText = clip(req.contextText, LIMITS.context);
  if (contextText) parts.push(`【选段前后文】\n${contextText}`);
  const question = clip(req.question, LIMITS.question).trim();
  if (question) parts.push(`【用户附加的问题】${question}`);

  return [
    { role: 'system', content: SYSTEM_EXPLAIN },
    { role: 'user', content: parts.join('\n\n') },
  ];
}

export function buildFollowupMessages(doc, req = {}) {
  const question = clip(req.question, LIMITS.question).trim();
  if (!question) throw new Error('缺少追问内容');

  const parts = [];
  parts.push(`【论文】《${clip(doc?.title || '未命名文档', 200)}》`);
  parts.push(`【论文文本】\n${docContext(doc, null)}`);

  const memory = memoryIndex(req.cards);
  if (memory) parts.push(memory);

  parts.push(`【当前卡片】卡片#${str(req.cardId)}，其讲解对象：「${clip(req.sourceText, 100)}」`);
  const memo = clip(req.memo, 200).trim();
  if (memo) parts.push(`【当前卡片摘要】${memo}`);
  parts.push(`【当前卡片的讲解内容】\n${clip(req.content, 6000)}`);

  const followups = Array.isArray(req.followups) ? req.followups.slice(-8) : [];
  if (followups.length) {
    parts.push(`【此前的追问记录】\n` + followups
      .map(f => `用户问：${clip(f.q, 500)}\n你答：${clip(f.a, 2000)}`)
      .join('\n\n'));
  }

  parts.push(`【用户的新问题】${question}`);
  return [
    { role: 'system', content: SYSTEM_FOLLOWUP },
    { role: 'user', content: parts.join('\n\n') },
  ];
}

// 从完整输出中分离讲解正文与记忆元数据
export function parseMemo(text) {
  let body = text;
  let memo = null;
  const i = text.indexOf(MEMO_MARKER);
  if (i >= 0) {
    body = text.slice(0, i);
    let raw = text.slice(i + MEMO_MARKER.length).trim();
    raw = raw.replace(/```json|```/g, '').trim();
    const m = raw.match(/\{[\s\S]*\}/);
    if (m) {
      try {
        const j = JSON.parse(m[0]);
        const summary = typeof j.summary === 'string' ? j.summary.trim().slice(0, 60) : '';
        memo = {
          summary,
          concepts: Array.isArray(j.concepts)
            ? j.concepts.filter(c => typeof c === 'string' && c.trim()).map(c => c.trim()).slice(0, 8)
            : [],
          // 只接受正整数：Number(null) === 0 会让脏数据变成「卡片#0」这种幽灵引用
          related: Array.isArray(j.related)
            ? j.related.map(Number).filter(n => Number.isInteger(n) && n > 0)
            : [],
        };
        if (!memo.summary) memo = null; // summary 为空视为无效，走正文兜底
      } catch { /* 解析失败走兜底 */ }
    }
  }
  if (!memo) {
    const plain = body.replace(/[#*`>\-\[\]()]/g, '').replace(/\s+/g, ' ').trim();
    memo = { summary: plain.slice(0, 26) || '讲解', concepts: [], related: [] };
  }
  return { body: body.trimEnd(), memo };
}

/* ---------------- 流式 hold-back ---------------- */

/**
 * full 末尾有多长的一部分「可能是 marker 的前缀」，必须扣住不发。
 * 精确到字符级：只有真的构得成 marker 开头时才扣，避免无谓地把正文尾巴压住。
 */
export function holdbackLength(full, marker = MEMO_MARKER) {
  const max = Math.min(marker.length - 1, full.length);
  for (let k = max; k > 0; k--) {
    if (full.endsWith(marker.slice(0, k))) return k;
  }
  return 0;
}

/**
 * 流式转发的守门器：保证 ---MEMO--- 及其后的 JSON 永不外泄，同时不丢正文尾巴。
 *
 * push(chunk) 返回本次可安全下发的文本；finish() 在模型收敛后冲刷残余。
 * 关键点：没有 marker 时 finish 必须把整段尾部发完（旧实现会固定扣住 10 个字符）。
 */
export function createMemoGate(marker = MEMO_MARKER) {
  let full = '';
  let sent = 0;
  let cutAt = -1;

  const locate = () => {
    if (cutAt < 0) {
      const i = full.indexOf(marker);
      if (i >= 0) cutAt = i;
    }
  };

  const take = end => {
    if (end <= sent) return '';
    const out = full.slice(sent, end);
    sent = end;
    return out;
  };

  return {
    push(chunk) {
      if (chunk) full += chunk;
      locate();
      if (cutAt >= 0) return take(cutAt);
      return take(full.length - holdbackLength(full, marker));
    },
    finish() {
      locate();
      return take(cutAt >= 0 ? cutAt : full.length);
    },
    get full() {
      return full;
    },
    get truncated() {
      return cutAt < 0;
    },
  };
}

/* ---------------- 演示模式 ---------------- */

function esc(s) {
  return String(s ?? '').replace(/"/g, '”');
}

export function mockExplain(req = {}) {
  const sel = (str(req.selectionText) || '选段').trim().replace(/\s+/g, ' ');
  const head = sel.length > 40 ? sel.slice(0, 40) + '…' : sel;
  return `**一句话：**「${esc(head)}」是${esc(req.sourceDesc || '论文')}中的一段关键表述，下面把它拆开讲清楚。

## 拆解

- **这段话在说什么**（演示模式）：选段围绕「${esc(head.slice(0, 20))}」展开。真实模式下，智能体会结合论文全文、画布上已有的讲解记忆以及选段的前后文，把每个概念用大白话和类比讲透。
- **公式怎么呈现**：若选段含数学内容，讲解会用 LaTeX 排版，例如 $f(x)=\\sum_{i=1}^{n} w_i x_i + b$，独立公式如：

$$\\mathcal{L}_{\\text{simple}} = \\mathbb{E}_{t,\\,x_0,\\,\\epsilon}\\;\\bigl\\| \\epsilon - \\epsilon_\\theta(\\sqrt{\\bar\\alpha_t}\\,x_0 + \\sqrt{1-\\bar\\alpha_t}\\,\\epsilon,\\; t) \\bigr\\|^2$$

## 在论文中的位置

（演示模式）此处会说明该选段在整篇论文论证链条中的作用，以及它与引言、方法、实验部分的关系。

## 联系

（演示模式）若画布上已有相关讲解卡片，这里会指出本讲解与卡片#几 相呼应、是深化还是补充。

> 💡 当前处于**演示模式**（未配置模型 API）。在右上角「设置」中填入任意 OpenAI 兼容服务（智谱 GLM、DeepSeek、OpenAI 等）即可获得真实讲解。

---MEMO---
{"summary":"演示讲解：${esc(head.slice(0, 16))}","concepts":["演示模式"],"related":[]}`;
}

export function mockFollowup(req = {}) {
  return `（演示模式）你问的是：「${esc(req.question)}」。

真实模式下，智能体会带着论文全文与这张卡片的完整上下文来回答：先定位问题对应的原文与讲解，再给出准确、聚焦的解释，必要时补充例子与公式。

> 在右上角「设置」中配置模型 API 后即可获得真实回答。`;
}
