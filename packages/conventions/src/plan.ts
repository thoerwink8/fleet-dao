// plan.md 的阶段（「### P0 …」）和各阶段里的条目。PR 的「对应计划」一栏、文档里「plan.md P6 的「规则」一条」
// 这类指针都按这里认：阶段是 P 加数字，条目是那一阶段里某一行的原话（开头几个字就行，中间一段也行）。
import { type MdDoc, norm, readQuote, sectionRange } from './markdown.ts';

export interface PlanPhase {
  phase: number;
  /** 标题行，从 1 数。 */
  line: number;
  /** 标题的字，例如「P0 地基（约 6 小时）」。 */
  title: string;
  /** 这一阶段下面的每一行（比较用的写法），空行不算；line 从 1 数。 */
  entries: { line: number; text: string }[];
}

export function planPhases(doc: MdDoc): Map<number, PlanPhase> {
  const phases = new Map<number, PlanPhase>();
  for (const h of doc.headings) {
    if (h.phase === undefined || phases.has(h.phase)) continue;
    const { start, end } = sectionRange(doc, h);
    const entries: PlanPhase['entries'] = [];
    for (let i = start + 1; i < end; i++) {
      const text = norm(doc.lines[i] ?? '');
      if (text) entries.push({ line: i + 1, text });
    }
    phases.set(h.phase, { phase: h.phase, line: h.line, title: h.text, entries });
  }
  return phases;
}

/** 条目在这一阶段的哪一行；找不到返回 undefined。 */
export function findItem(phase: PlanPhase, item: string): number | undefined {
  const want = norm(item);
  if (!want) return undefined;
  return phase.entries.find((e) => e.text.includes(want))?.line;
}

/** 「P0–P6」：报错时告诉人有哪些阶段。 */
export function phaseRange(phases: Map<number, PlanPhase>): string {
  const ns = [...phases.keys()].sort((a, b) => a - b);
  if (ns.length === 0) return '（plan.md 里一个阶段也没有）';
  return ns.length === 1 ? `P${ns[0]}` : `P${ns[0]}–P${ns[ns.length - 1]}`;
}

/** 给报错举例用：这一阶段第一条的开头（「- 仓骨架：…」→「仓骨架」）。 */
export function itemExample(phase: PlanPhase | undefined): string {
  const first = phase?.entries[0]?.text.replace(/^[-*]\s+/, '') ?? '';
  const label = first.split(/[：:（(，。]/)[0]?.trim() ?? '';
  return label.slice(0, 12) || '那一条的原话开头';
}

export interface PlanRef {
  phase: number;
  /** 引号里的字；undefined = 只写了阶段、没写是哪一条；'' = 引号是空的。 */
  item: string | undefined;
  /** 原文，报错时照引。 */
  raw: string;
}

/** 从一段字里认出所有「P1「工作流」」这样的写法（阶段后面可以隔空格或「的」）。 */
export function parsePlanRefs(value: string): PlanRef[] {
  const refs: PlanRef[] = [];
  for (const m of value.matchAll(/(?<![A-Za-z0-9])P(\d+)(?!\d)/g)) {
    const start = m.index;
    const after = /\s*(?:的\s*)?/y;
    after.lastIndex = start + m[0].length;
    const at = after.exec(value) ? after.lastIndex : start + m[0].length;
    const quote = readQuote(value, at);
    refs.push({
      phase: Number(m[1]),
      item: quote?.text,
      raw: quote ? value.slice(start, quote.end) : m[0],
    });
  }
  return refs;
}
