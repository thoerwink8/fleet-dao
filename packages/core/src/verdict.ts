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

/** Lead 拿证据驳回的一条：target 是那条「怎么算做完」的原文，或那条发现的 text。 */
export interface Rebuttal {
  target: string;
  evidence: string;
}

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
  /** Lead 拿证据驳回的。 */
  rebuttals: readonly Rebuttal[];
}

/**
 * 作废了该谁改：setup = 派错了、配错了（没写族、同族、没有「怎么算做完」），让验证模型重写也没用；
 * verifier = 验证模型交回的不对（认不出、审错了头、漏答多答），让它照原因重写；lead = Lead 的驳回不对（驳的不是能挡的、没带证据）。
 */
export type InvalidFault = 'setup' | 'verifier' | 'lead';

export type VerdictDecision =
  | { verdict: 'pass'; notes: string[]; rebutted: string[] }
  | { verdict: 'block'; reasons: string[]; notes: string[]; rebutted: string[] }
  | { verdict: 'invalid'; why: string; fault: InvalidFault };

const norm = (s: string) => s.trim().toLowerCase();

/**
 * 验证模型交回的这一份本身对不对：认得出、审的是送检的头、「怎么算做完」一条不漏、不多、不重。不看族、不看驳回。
 * 会话端口读结论文件时先拿它挡一道（交错了退回会话照原因重写），decideVerdict 判的时候也用它，两边是同一个判法。
 */
export function checkReport(
  report: unknown,
  criteria: readonly string[],
  sentHead: string,
): { ok: true; report: VerifyReport } | { ok: false; why: string } {
  if (criteria.length === 0) return { ok: false, why: '这张单没有「怎么算做完」，没法对照着验' };
  const parsed = ReportSchema.safeParse(report);
  if (!parsed.success) {
    return {
      ok: false,
      why: `交回的认不出：${parsed.error.issues.map((i) => `${i.path.join('.') || '整份'} ${i.message}`).join('；')}`,
    };
  }
  const got = parsed.data;
  if (got.head.trim() !== sentHead.trim()) {
    return { ok: false, why: `审的不是送检的头：送的是 ${sentHead}，审的是 ${got.head}` };
  }
  const wanted = new Set(criteria.map((c) => c.trim()));
  const answered = new Set<string>();
  for (const r of got.results) {
    const c = r.criterion.trim();
    if (!wanted.has(c)) return { ok: false, why: `答了清单外的一条：「${c}」` };
    if (answered.has(c)) return { ok: false, why: `同一条答了两遍：「${c}」` };
    answered.add(c);
  }
  const missing = [...wanted].filter((c) => !answered.has(c));
  if (missing.length) return { ok: false, why: `没答：${missing.map((c) => `「${c}」`).join('、')}` };
  return { ok: true, report: got };
}

export function decideVerdict(input: VerdictInput): VerdictDecision {
  const invalid = (why: string, fault: InvalidFault): VerdictDecision => ({ verdict: 'invalid', why, fault });
  if (!norm(input.verifierFamily)) return invalid('没写验证模型是哪一族', 'setup');
  if (input.authorFamilies.some((f) => norm(f) === norm(input.verifierFamily))) {
    return invalid(`验证模型和写这张单的是同一族（${input.verifierFamily}），验证必须是别家`, 'setup');
  }
  if (input.criteria.length === 0) return invalid('这张单没有「怎么算做完」，没法对照着验', 'setup');

  const checked = checkReport(input.report, input.criteria, input.sentHead);
  if (!checked.ok) return invalid(checked.why, 'verifier');
  const report = checked.report;

  const blockingTargets = new Set<string>([
    ...report.results.filter((r) => r.answer === 'not-done').map((r) => r.criterion.trim()),
    ...report.findings.filter((f) => f.kind !== 'suggestion').map((f) => f.text.trim()),
  ]);
  const rebutted = new Set<string>();
  for (const r of input.rebuttals) {
    const target = r.target.trim();
    if (!blockingTargets.has(target)) return invalid(`驳回的对象不是一条能挡的意见：「${target}」`, 'lead');
    if (!r.evidence.trim()) return invalid(`驳回「${target}」没带证据`, 'lead');
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

/** 一轮验证写进 PR 正文要的：第几轮、谁验的、核了几条、Lead 驳回了什么、驳回之后的结论。 */
export interface VerifiedRound {
  round: number;
  /** 给人看的验证模型，例如「Kimi k3（kimi 族）」。 */
  verifier: string;
  /** 这一轮逐条核了几条「怎么算做完」。 */
  criteria: number;
  rebuttals: readonly Rebuttal[];
  /** 这一轮最后的结论（Lead 驳回之后的）。 */
  final: Extract<VerdictDecision, { verdict: 'pass' | 'block' }>;
}

/**
 * 验证结论写成 PR 正文的几行（0003 第 5 条：结论写进 PR 正文，其余当建议）：verified 进「怎么验证的」——每轮一行，
 * Lead 的驳回各一行（带证据）；owed 进「还欠什么」——最后一轮的「看不出」和建议。一轮都没有明说没有，不空着。
 */
export function verificationLines(rounds: readonly VerifiedRound[]): { verified: string[]; owed: string[] } {
  const last = rounds.at(-1);
  if (!last) return { verified: ['开 PR 前别家验证：没有记录'], owed: [] };
  const verified: string[] = [];
  for (const r of rounds) {
    const blocked =
      r.final.verdict === 'block'
        ? `，挡在 ${r.final.reasons.length} 条：${r.final.reasons[0] ?? ''}${r.final.reasons.length > 1 ? ' 等' : ''}`
        : '';
    const rebutted = r.rebuttals.length ? `，Lead 拿证据驳回 ${r.rebuttals.length} 条` : '';
    verified.push(
      `开 PR 前别家验证第 ${r.round} 轮（${r.verifier}）：${r.final.verdict === 'pass' ? '过' : '挡'}，逐条核了 ${r.criteria} 条「怎么算做完」${rebutted}${blocked}`,
    );
    for (const b of r.rebuttals)
      verified.push(`第 ${r.round} 轮 Lead 驳回「${b.target.trim()}」：${b.evidence.trim()}`);
  }
  return { verified, owed: last.final.notes.map((n) => `验证${n}`) };
}
