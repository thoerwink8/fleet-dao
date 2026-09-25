// 题的形状：题面、选项（每个选项挂一个 Effect）、要喂的证据字段、拿不准时的默认走向。
// 题库本身在 bank.ts。改题面、选项或证据字段 = 换了一道题：rev 会变，之前攒的准确率不再算数，真拦的题退回只记不拦（store.syncQuestionBank）。
import { createHash } from 'node:crypto';
import { type Effect, isEffect } from './effects.ts';

/** 九个接入点（设计文档第十一节的表）。「选哪条路由」不在其中：旧系统里那道题占 64% 的调用、价值最低，不接。 */
export const SITES = {
  triage: '分诊',
  dedupe: '查重',
  'spec-check': '需求文档质检',
  'delivery-check': '交活核实',
  'review-grade': '审查意见分级',
  'error-route': '错误分流',
  'stall-check': '停滞预判',
  'feishu-intent': '飞书消息理解',
  'daily-digest': '日报挑重点',
} as const;
export type SiteId = keyof typeof SITES;

export interface OptionDef {
  /** 英文小写，给模型和库用。 */
  readonly id: string;
  /** 白话名，驾驶舱显示。 */
  readonly label: string;
  /** 什么时候选它，原样喂给模型。 */
  readonly criteria: string;
  /** 题目在真拦、答案有把握时，这个选项最多能把流程带到哪。 */
  readonly effect: Effect;
  /** 真拦时流程具体怎么走（白话，给调用方和驾驶舱看）。 */
  readonly does: string;
}

export interface EvidenceField {
  readonly key: string;
  /** 喂给模型时的字段名。 */
  readonly label: string;
  readonly required: boolean;
  /** 飞书私聊这类：库里只留长度和哈希，不留开头。 */
  readonly private?: boolean;
}

export interface QuestionDef {
  /** 稳定的题号，也是 jev_questions.id。 */
  readonly id: string;
  readonly site: SiteId;
  readonly title: string;
  /** 题面，原样喂给模型。 */
  readonly instructions: string;
  readonly options: readonly OptionDef[];
  /** 证据只给原文，不裁剪；数字比较（阈值、时长、额度）由代码算好，不交给它。 */
  readonly evidence: readonly EvidenceField[];
  /** 拿不准、没判出来、只记不拦时流程怎么走（= 当它不存在）。 */
  readonly whenUnsure: string;
  /** 把握线初值：把握度低于它 = 没判出来。登记进库后以库里那一行为准。 */
  readonly confidenceLine: number;
  /** 什么情况下才问这道题（不写 = 每次都问）。 */
  readonly askWhen?: string;
}

/** 保留字面量类型：调用方拿到的 option / act 能收窄到这道题自己的选项和效果。 */
export function defineQuestion<const Q extends QuestionDef>(q: Q): Q {
  return q;
}

export type OptionOf<Q extends QuestionDef> = Q['options'][number]['id'];
export type EffectOf<Q extends QuestionDef> = Q['options'][number]['effect'];
type FieldOf<Q extends QuestionDef> = Q['evidence'][number];

/** 一道题（或同一次问的几道题）要的证据：必填的必须给，选填的可以不给。 */
export type EvidenceOf<Q extends QuestionDef> = {
  [F in FieldOf<Q> as F['required'] extends true ? F['key'] : never]: string;
} & {
  [F in FieldOf<Q> as F['required'] extends true ? never : F['key']]?: string | undefined;
};

/**
 * 库里 jev_questions.prompt 存的就是这个：模型看得到的全部——题面、每个选项的判据、喂哪些证据字段（给模型看的名字、选填与否）。
 * 真拦资格比的是它、准确率按它的哈希（questionRev）分版本：两边必须是同一份，否则只改证据字段时准确率清零、题却照旧真拦。
 */
export function renderPrompt(q: QuestionDef): string {
  return [
    q.instructions,
    ...q.options.map((o) => `- ${o.id}：${o.criteria}`),
    '证据字段：',
    ...q.evidence.map((f) => `- ${f.key}：${f.label}${f.required ? '' : '（选填）'}`),
  ].join('\n');
}

/** 题目版本：renderPrompt 里任何一个字变了，rev 就变。每条判断记录都带着它，准确率只按当前版本算。 */
export function questionRev(q: QuestionDef): string {
  return createHash('sha256').update(renderPrompt(q)).digest('hex').slice(0, 12);
}

const ID = /^[a-z][a-z0-9-]*$/;
const OPTION_ID = /^[a-z][a-z0-9_]*$/;

/** 题目本身写得对不对。返回问题清单，空 = 没问题。 */
export function checkQuestion(q: QuestionDef): string[] {
  const problems: string[] = [];
  const at = `题 ${q.id}`;
  if (!ID.test(q.id)) problems.push(`${at}：题号要是小写字母、数字、连字符`);
  if (!(q.site in SITES)) problems.push(`${at}：接入点 ${q.site} 不在九个接入点里`);
  if (!q.title.trim() || !q.instructions.trim()) problems.push(`${at}：题名和题面都要有`);
  if (!q.whenUnsure.trim()) problems.push(`${at}：要写拿不准时的默认走向`);
  if (!(q.confidenceLine > 0 && q.confidenceLine < 1)) problems.push(`${at}：把握线要在 0 和 1 之间`);
  if (q.options.length < 2) problems.push(`${at}：至少两个选项`);
  const optionIds = new Set<string>();
  for (const o of q.options) {
    if (!OPTION_ID.test(o.id)) problems.push(`${at}：选项 ${o.id} 要是小写字母、数字、下划线`);
    if (optionIds.has(o.id)) problems.push(`${at}：选项 ${o.id} 重复`);
    optionIds.add(o.id);
    if (!isEffect(o.effect)) problems.push(`${at}：选项 ${o.id} 的效果 ${String(o.effect)} 不认识`);
    if (!o.label.trim() || !o.criteria.trim() || !o.does.trim())
      problems.push(`${at}：选项 ${o.id} 的名字、判据、真拦时怎么走都要写`);
  }
  // 至少有一个选项什么都不改：否则只要判出来就一定拦，等于没有「放过」的答法。
  if (!q.options.some((o) => o.effect === 'none')) problems.push(`${at}：至少要有一个不改流程（none）的选项`);
  if (q.evidence.length === 0) problems.push(`${at}：至少要喂一个证据字段`);
  if (!q.evidence.some((f) => f.required)) problems.push(`${at}：至少要有一个必填的证据字段`);
  const keys = new Set<string>();
  for (const f of q.evidence) {
    if (!/^[a-z][a-z0-9_]*$/.test(f.key))
      problems.push(`${at}：证据字段 ${f.key} 要是小写字母、数字、下划线`);
    if (keys.has(f.key)) problems.push(`${at}：证据字段 ${f.key} 重复`);
    keys.add(f.key);
    if (!f.label.trim()) problems.push(`${at}：证据字段 ${f.key} 要有给模型看的名字`);
  }
  return problems;
}

/** 同一次问的几道题要共用证据：同一个字段在几道题里的名字必须一样，否则喂给模型的字段名对不上。 */
export function checkBatch(questions: readonly QuestionDef[]): string[] {
  const problems: string[] = [];
  const labels = new Map<string, string>();
  const ids = new Set<string>();
  for (const q of questions) {
    if (ids.has(q.id)) problems.push(`题 ${q.id} 在同一次里问了两遍`);
    ids.add(q.id);
    for (const f of q.evidence) {
      const seen = labels.get(f.key);
      if (seen !== undefined && seen !== f.label)
        problems.push(`证据字段 ${f.key} 在几道题里的名字不一样：${seen} / ${f.label}`);
      labels.set(f.key, f.label);
    }
  }
  return problems;
}
