// 验证模型交回的那一份结论的形状和检查：对照「怎么算做完」逐条答 做到 / 没做到 / 看不出，带证据；能挡的三种：没做到验收条、
// 有证据弄坏原有功能、安全或丢数据，其余是建议。交回的认不出、审的不是送检的头、漏答多答，checkReport 一律说明原因退回。
// 交回的 criterion 按 criterionKey 对（只抹不改意思的格式差别），对上了一律换回原文往下传。
// 原来这里还有 decideVerdict（Lead 驳回之后的 pass / block / invalid）和 verificationLines（写进 PR 正文），随 Fusion 的
// Lead 验收一起删了（#901 审查：只有测试在引用）。
import { z } from 'zod';

export const ANSWERS = ['done', 'not-done', 'unclear'] as const;

/** 能挡的三种（没做到验收条另算）；suggestion 只进 PR 正文。 */
export const FINDING_KINDS = ['breaks-existing', 'security', 'data-loss', 'suggestion'] as const;

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
 * 不看族、不看驳回。对上了的 criterion 换回清单原文交回，下游都认原文。
 * 会话端口读结论文件时先拿它挡一道（交错了退回会话照原因重写）。
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
