const questionLine = /^\s*(?:#{1,6}\s+)?(?:[-*•]\s+)?(?:\*\*|__)?(?:复习)?问题\s*[：:]\s*(?:\*\*|__)?\s*(.+?)\s*$/;
const bullet = /^\s*(?:[-*+•]\s+|[\d一二三四五六七八九十]+[、．）)]\s*|\d+\.\s+|[（(][\d一二三四五六七八九十]+[）)]\s*)/;
const withoutBold = text => text.trim().replace(/^(?:\*\*|__)(.+)(?:\*\*|__)$/, '$1').trim();

export function readKnowledgeOutput(output, originalQuestion, canRewrite) {
  const cleaned = output.trim().replace(/^```(?:json|markdown|text)?\s*|\s*```$/gi, '').trim();
  let points = [];
  let candidate;
  if (/^[\[{]/.test(cleaned)) {
    let parsed;
    try { parsed = JSON.parse(cleaned); } catch { return { points }; }
    points = Array.isArray(parsed) ? parsed : Array.isArray(parsed?.points) ? parsed.points : [];
    candidate = parsed?.reviewQuestion;
  } else {
    for (const raw of cleaned.split(/\r?\n/)) {
      const line = withoutBold(raw);
      const question = line.match(questionLine);
      if (question) candidate ??= question[1];
      else if (bullet.test(line)) points.push(line.replace(bullet, ''));
    }
    if (!points.length && cleaned && !cleaned.includes('\n') && !candidate && !/^\s*#{1,6}\s|^\s*```|^无法补全[。.]?$/.test(cleaned)) {
      points = [cleaned];
    }
  }
  points = points.filter(item => typeof item === 'string' && item.trim()).slice(0, 3).map(item => item.trim());
  const question = typeof candidate === 'string' ? withoutBold(candidate).replace(/(?:\*\*|__)$/, '').trim() : '';
  const reviewQuestion = canRewrite && question.length <= 180 && /[？?]$/.test(question) &&
    question.replace(/[？?]$/, '') !== originalQuestion.trim().replace(/[？?]$/, '') ? question : undefined;
  return { points, reviewQuestion };
}
