// 把一段文本里命中卫生规则（rules.ts 的 RULES）的真密钥打码，其余原样。给「会话过程记录」这类要把外来文本写进库、
// 再展示给人看的地方用（#1640）：和推送前的闸、全仓扫共用同一份规则，不另抄一份正则。
// 打码的是规则命中的整段（例如「password: xxxx」整条赋值，或一个令牌），换成 [已打码：<规则名>]；
// 命中位置按原文算，所以换的时候从后往前换。

import { findHits, RULES, type Rule } from './rules.ts';

export interface Redacted {
  text: string;
  /** 打了几处码；0 = 原样没动。 */
  count: number;
}

/** 一段范围 [start, end)。 */
type Span = { start: number; end: number; label: string };

/** 文本里每处规则命中的位置（同一类规则重叠的 findHits 已经合并；不同类规则重叠的这里再合并成一处）。 */
function spansOf(text: string, rules: readonly Rule[]): Span[] {
  const spans: Span[] = [];
  const used = new Map<string, number>();
  for (const hit of findHits(text, rules)) {
    // 同一段原文可能出现多次：每次从上一次找到的位置之后找，逐处对上
    const from = used.get(hit.match) ?? 0;
    const at = text.indexOf(hit.match, from);
    if (at < 0) continue;
    used.set(hit.match, at + hit.match.length);
    spans.push({ start: at, end: at + hit.match.length, label: hit.label });
  }
  spans.sort((a, b) => a.start - b.start || b.end - a.end);
  const merged: Span[] = [];
  for (const s of spans) {
    const last = merged[merged.length - 1];
    if (last && s.start < last.end) last.end = Math.max(last.end, s.end);
    else merged.push({ ...s });
  }
  return merged;
}

/** 打码。命中的整段换成「[已打码：<规则名>]」；没有命中的原样返回。 */
export function redactSecrets(text: string, rules: readonly Rule[] = RULES): Redacted {
  const spans = spansOf(text, rules);
  if (spans.length === 0) return { text, count: 0 };
  let out = '';
  let cursor = 0;
  for (const s of spans) {
    out += `${text.slice(cursor, s.start)}[已打码：${s.label}]`;
    cursor = s.end;
  }
  return { text: out + text.slice(cursor), count: spans.length };
}
