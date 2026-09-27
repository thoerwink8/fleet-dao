// 开 PR 前别家验证的结论（docs/decisions/0003-fusion-flow.md 第 5 条）：对照「怎么算做完」逐条答
// 做到 / 没做到 / 看不出，带证据。只有三种能挡：没做到验收条、有证据弄坏原有功能、安全或丢数据；其余写进 PR 当建议。
// 交回的认不出、审的不是送检的头、验证模型和写的同族，一律判「作废」，不当成过了。
// 交回的 criterion、Lead 驳回的 target 按 criterionKey 对（只抹不改意思的格式差别），对上了一律换回原文往下传。
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

/** Lead 拿证据驳回的一条：target 是那条「怎么算做完」的原文，或那条发现的 text（格式差别照 criterionKey 认）。 */
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

const ZERO_WIDTH = /[\u200b-\u200d\u2060\ufeff]/g;
/** 全角的 ASCII（！到～），减掉 0xfee0 就是半角。 */
const FULL_WIDTH = /[\uff01-\uff5e]/g;
/** 中文字、假名、中文标点：挨着它们的空白只是排版。不含韩文（韩文词和词之间的空格算数）。 */
const CJK = '\\p{Script=Han}\\p{Script=Hiragana}\\p{Script=Katakana}\\u3000-\\u303f\\uff00-\\uffef';
const SPACE_NEAR_CJK = new RegExp(`(?<=[${CJK}]) | (?=[${CJK}])`, 'gu');
const WORD_CHAR = /[\p{L}\p{N}]/u;

/**
 * 对「怎么算做完」条目用的写法（#246 验收撞上的：清单原文带反引号，验证模型抄的时候顺手去掉了，逐字比就判成
 * 「答了清单外的一条」、整轮重跑）。只抹抄的时候常被顺手改掉、又不改意思的格式差别，只拿来对；往下传的一律是原文。
 * 收：反引号；星号（加粗、斜体，中文里常紧贴着字写）；词边上的下划线（snake_case 中间的不动）；全角的字母数字标点换半角；
 * 弯引号、直角引号换直引号（双、单分开）；空白压成一个，挨着中文、中文标点和 , ; : ( ) 的空白去掉（中英文之间空不空、
 * 全角标点换成半角后跟不跟空格，都只是排版）；开头抄进来的序号（提示词给清单编了号）；句末一个「。」「.」「;」。
 * 不收（拿不准会不会把两条不同的认成一条，宁可不收）：大小写、「、」和「，」、破折号和连字符、省略号、反斜杠转义、
 * 删除线、句中的「。」。每一步都是一趟扫过去，不回溯（交回的文字多长都不会卡住）。
 */
export function criterionKey(text: string): string {
  return text
    .normalize('NFC')
    .replace(ZERO_WIDTH, '')
    .replace(FULL_WIDTH, (c) => String.fromCharCode(c.charCodeAt(0) - 0xfee0))
    .replace(/[“”「」]/g, '"')
    .replace(/[‘’『』]/g, "'")
    .replace(/[`*]/g, '')
    .replace(/_+/g, (run: string, at: number, s: string) =>
      WORD_CHAR.test(s[at - 1] ?? '') && WORD_CHAR.test(s[at + run.length] ?? '') ? run : '',
    )
    .replace(/\s+/g, ' ')
    .trim()
    .replace(/^(?:[-+]|\d{1,9}[.)]) /, '')
    .replace(SPACE_NEAR_CJK, '')
    .replace(/ ?([,;:()]) ?/g, '$1')
    .replace(/(?<!\.)[。.;]$/, '')
    .trim();
}

type Located = { hit: string } | { miss: 'none' } | { miss: 'many'; hits: string[] };

/**
 * 在一张清单（原文）里找交回的这一条：先逐字，逐字比不上再按 criterionKey 对。清单里规范化后撞在一起的几条只认逐字
 * （miss: 'many'），不替模型挑一条。
 */
function locator(list: readonly string[]): (text: string) => Located {
  const exact = new Set(list);
  const byKey = new Map<string, string[]>();
  for (const item of list) {
    const key = criterionKey(item);
    if (key) byKey.set(key, [...(byKey.get(key) ?? []), item]);
  }
  return (text) => {
    const t = text.trim();
    if (exact.has(t)) return { hit: t };
    const [only, ...more] = byKey.get(criterionKey(t)) ?? [];
    if (only === undefined) return { miss: 'none' };
    return more.length === 0 ? { hit: only } : { miss: 'many', hits: [only, ...more] };
  };
}

const quoted = (items: readonly string[]) => items.map((s) => `「${s}」`).join('、');

/**
 * 验证模型交回的这一份本身对不对：认得出、审的是送检的头、「怎么算做完」一条不漏、不多、不重（按 criterionKey 对）。
 * 不看族、不看驳回。对上了的 criterion 换回清单原文交回，下游（decideVerdict、给 Lead 驳回的对象、PR 正文）都认原文。
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
  const wanted = [...new Set(criteria.map((c) => c.trim()))];
  const locate = locator(wanted);
  /** 清单原文 → 交回的写法。 */
  const answered = new Map<string, string>();
  const results: VerifyReport['results'] = [];
  for (const r of got.results) {
    const c = r.criterion.trim();
    const found = locate(c);
    if ('miss' in found) {
      return {
        ok: false,
        why:
          found.miss === 'many'
            ? `这一条对得上清单里不止一条：「${c}」（${quoted(found.hits)}），criterion 要照清单原文逐字抄`
            : `答了清单外的一条：「${c}」（criterion 要照清单原文逐字抄）`,
      };
    }
    const earlier = answered.get(found.hit);
    if (earlier !== undefined) {
      const forms = earlier === found.hit && c === found.hit ? '' : `（交回的写法：${quoted([earlier, c])}）`;
      return { ok: false, why: `同一条答了两遍：「${found.hit}」${forms}` };
    }
    answered.set(found.hit, c);
    results.push({ ...r, criterion: found.hit });
  }
  const missing = wanted.filter((c) => !answered.has(c));
  if (missing.length) return { ok: false, why: `没答：${quoted(missing)}` };
  return { ok: true, report: { ...got, results } };
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

  const blocking = new Set<string>([
    ...report.results.filter((r) => r.answer === 'not-done').map((r) => r.criterion.trim()),
    ...report.findings.filter((f) => f.kind !== 'suggestion').map((f) => f.text.trim()),
  ]);
  const locate = locator([...blocking]);
  /** 驳回了的，记原文（能挡的那一条的写法，不是 Lead 抄的那份）。 */
  const rebutted = new Set<string>();
  for (const r of input.rebuttals) {
    const target = r.target.trim();
    const found = locate(target);
    if ('miss' in found) {
      return invalid(
        found.miss === 'many'
          ? `驳回的对象对得上不止一条能挡的意见：「${target}」（${quoted(found.hits)}），target 要照原文逐字抄`
          : `驳回的对象不是一条能挡的意见：「${target}」`,
        'lead',
      );
    }
    if (!r.evidence.trim()) return invalid(`驳回「${found.hit}」没带证据`, 'lead');
    rebutted.add(found.hit);
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
    // 驳回的对象写原文：decideVerdict 记在 final.rebutted 里的那份，不是 Lead 抄的那份（抄的时候可能改了格式）
    const locate = locator(r.final.rebutted);
    for (const b of r.rebuttals) {
      const found = locate(b.target);
      const target = 'hit' in found ? found.hit : b.target.trim();
      verified.push(`第 ${r.round} 轮 Lead 驳回「${target}」：${b.evidence.trim()}`);
    }
  }
  return { verified, owed: last.final.notes.map((n) => `验证${n}`) };
}
