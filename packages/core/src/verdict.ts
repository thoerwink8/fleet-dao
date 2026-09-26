// 开 PR 前别家验证的结论（docs/decisions/0003-fusion-flow.md 第 5 条）：对照「怎么算做完」逐条答
// 做到 / 没做到 / 看不出，带证据。只有三种能挡：没做到验收条、有证据弄坏原有功能、安全或丢数据；其余写进 PR 当建议。
// 交回的认不出、审的不是送检的头、验证模型和写的同族，一律判「作废」，不当成过了。
import { z } from 'zod';

export const ANSWERS = ['done', 'not-done', 'unclear'] as const;
export type Answer = (typeof ANSWERS)[number];

/** 能挡的三种（没做到验收条另算）；suggestion 只进 PR 正文。 */
export const FINDING_KINDS = ['breaks-existing', 'security', 'data-loss', 'suggestion'] as const;
export type FindingKind = (typeof FINDING_KINDS)[number];

const KIND_NAMES: Record<FindingKind, string> = {
  'breaks-existing': '弄坏了原有功能',
  security: '安全',
  'data-loss': '丢数据',
  suggestion: '建议',
};

const evidence = z.string().trim().min(1);

export const ReportSchema = z.object({
  /** 审的是哪个提交。 */
  head: z.string().trim().min(7),
  results: z.array(z.object({ criterion: z.string().trim().min(1), answer: z.enum(ANSWERS), evidence })),
  findings: z.array(z.object({ kind: z.enum(FINDING_KINDS), text: z.string().trim().min(1), evidence })),
});

export type VerifyReport = z.infer<typeof ReportSchema>;

export interface VerdictInput {
  /** 这张单的「怎么算做完」，逐条原文。 */
  criteria: readonly string[];
  /** 送检的那个提交。 */
  sentHead: string;
  /** 验证模型交回的东西，解析前。 */
  report: unknown;
  /** 验证模型的族，和写这张单的模型的族（Lead、副手）。 */
  verifierFamily: string;
  authorFamilies: readonly string[];
  /** Lead 拿证据驳回的：target 是那条「怎么算做完」的原文，或那条发现的 text。 */
  rebuttals: readonly { target: string; evidence: string }[];
}

export type VerdictDecision =
  | { verdict: 'pass'; notes: string[]; rebutted: string[] }
  | { verdict: 'block'; reasons: string[]; notes: string[]; rebutted: string[] }
  | { verdict: 'invalid'; why: string };

const norm = (s: string) => s.trim().toLowerCase();

export function decideVerdict(input: VerdictInput): VerdictDecision {
  const invalid = (why: string): VerdictDecision => ({ verdict: 'invalid', why });
  if (!norm(input.verifierFamily)) return invalid('没写验证模型是哪一族');
  if (input.authorFamilies.some((f) => norm(f) === norm(input.verifierFamily))) {
    return invalid(`验证模型和写这张单的是同一族（${input.verifierFamily}），验证必须是别家`);
  }
  if (input.criteria.length === 0) return invalid('这张单没有「怎么算做完」，没法对照着验');

  const parsed = ReportSchema.safeParse(input.report);
  if (!parsed.success) {
    return invalid(
      `交回的认不出：${parsed.error.issues.map((i) => `${i.path.join('.') || '整份'} ${i.message}`).join('；')}`,
    );
  }
  const report = parsed.data;
  if (report.head.trim() !== input.sentHead.trim()) {
    return invalid(`审的不是送检的头：送的是 ${input.sentHead}，审的是 ${report.head}`);
  }

  const wanted = new Set(input.criteria.map((c) => c.trim()));
  const answered = new Map<string, (typeof report.results)[number]>();
  for (const r of report.results) {
    const c = r.criterion.trim();
    if (!wanted.has(c)) return invalid(`答了清单外的一条：「${c}」`);
    if (answered.has(c)) return invalid(`同一条答了两遍：「${c}」`);
    answered.set(c, r);
  }
  const missing = [...wanted].filter((c) => !answered.has(c));
  if (missing.length) return invalid(`没答：${missing.map((c) => `「${c}」`).join('、')}`);

  const blockingTargets = new Set<string>([
    ...report.results.filter((r) => r.answer === 'not-done').map((r) => r.criterion.trim()),
    ...report.findings.filter((f) => f.kind !== 'suggestion').map((f) => f.text.trim()),
  ]);
  const rebutted = new Set<string>();
  for (const r of input.rebuttals) {
    const target = r.target.trim();
    if (!blockingTargets.has(target)) return invalid(`驳回的对象不是一条能挡的意见：「${target}」`);
    if (!r.evidence.trim()) return invalid(`驳回「${target}」没带证据`);
    rebutted.add(target);
  }

  const reasons: string[] = [];
  const notes: string[] = [];
  for (const r of report.results) {
    const c = r.criterion.trim();
    if (r.answer === 'not-done' && !rebutted.has(c))
      reasons.push(`没做到：${c}（证据：${r.evidence.trim()}）`);
    if (r.answer === 'unclear') notes.push(`看不出：${c}（${r.evidence.trim()}）`);
  }
  for (const f of report.findings) {
    const line = `${KIND_NAMES[f.kind]}：${f.text.trim()}（证据：${f.evidence.trim()}）`;
    if (f.kind === 'suggestion') notes.push(line);
    else if (!rebutted.has(f.text.trim())) reasons.push(line);
  }
  const rebuttedList = [...rebutted];
  return reasons.length
    ? { verdict: 'block', reasons, notes, rebutted: rebuttedList }
    : { verdict: 'pass', notes, rebutted: rebuttedList };
}
