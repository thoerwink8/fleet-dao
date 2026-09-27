// 用量说给人听（#216）。数一律出自 shared 的 summarizeUsage：任务详情用后端算好的 usage，会话时间线的一次会话
// 也拿它现算（runUsage），算法只有一份。每一项分四种说法：还没有数（没有结束了的会话，这不是没读到）、全读到、
// 读到一部分（照数写，标「不全」、写明另有几次没读到）、全没读到（写「没读到」，不写 0）。
// 花费分三种计费方式说：按量是真花的钱；套餐内是按 API 价折合、不另花钱；渠道查不到的分不清，不猜成套餐内。
import { type CostShare, summarizeUsage, type UsageTotals } from '@fleet-dao/shared';
import type { Run } from '../api/types';
import { formatCount, formatDuration, formatUsd } from './format';

/** 一项合计的读数：value 是读到的那几次加起来的，missing 是没读到的次数。 */
export type Reading =
  | { kind: 'none' }
  | { kind: 'full'; value: number }
  | { kind: 'partial'; value: number; missing: number }
  | { kind: 'missing'; missing: number };

/** runs 次结束了的会话里，missing 次没读到，读到的加起来是 value。 */
export function reading(value: number, missing: number, runs: number): Reading {
  if (runs <= 0) return { kind: 'none' };
  if (missing >= runs) return { kind: 'missing', missing };
  if (missing > 0) return { kind: 'partial', value, missing };
  return { kind: 'full', value };
}

/** 一次会话的用量，照任务合计同一个算法算：还在跑的只记 running，结束了的缺哪样记哪样没读到。 */
export function runUsage(run: Run): UsageTotals {
  return summarizeUsage([{ ...run, model: run.routeId, modelName: run.modelName }]).total;
}

/**
 * 一小段用量的说法，页面照它拼：「{label} {value} {unit}」，全没读到时是 missing（提醒色），
 * 读到一部分时在后面写「（不全：N 次没读到）」。
 */
export interface UsagePart {
  key: string;
  label?: string;
  /** 读到的数（等宽显示）；全没读到就没有。 */
  value?: string;
  unit?: string;
  /** 全没读到时怎么说，例如「token 没读到」「花费没读到」。 */
  missing?: string;
  /** 读到一部分：另有几次没读到。 */
  incomplete?: number;
  /** 悬停看的细账。 */
  title?: string;
}

/** 输入当量的折法，写在悬停提示和面板说明里。 */
export const EQUIVALENT_RULE = '输入 1、缓存写 1.25、缓存读 0.1、输出 5';

function tokenBreakdown(t: UsageTotals): string {
  return `输入 ${formatCount(t.inputTokens)} · 输出 ${formatCount(t.outputTokens)} · 缓存读 ${formatCount(t.cacheReadTokens)} · 缓存写 ${formatCount(t.cacheWriteTokens)}（只算读到的）`;
}

/** 从一项读数拼一段说法：全读到照数写，读到一部分加「不全」，全没读到写 missingText。 */
function part(
  key: string,
  r: Reading,
  said: { label?: string; value: (v: number) => string; unit?: string; missing: string; title?: string },
): UsagePart[] {
  if (r.kind === 'none') return [];
  if (r.kind === 'missing') return [{ key, missing: said.missing }];
  const p: UsagePart = { key, value: said.value(r.value) };
  if (said.label) p.label = said.label;
  if (said.unit) p.unit = said.unit;
  if (said.title) p.title = said.title;
  if (r.kind === 'partial') p.incomplete = r.missing;
  return [p];
}

/**
 * token 那几段：输入当量读到了（哪怕一部分）就只写当量，细账放悬停提示；一次都折不成时退一步，
 * 分开写 token 和缓存各读到多少、哪样没读到——缓存读写没存下来的老会话就是「12 万 token · 缓存没读到」。
 */
export function tokenParts(t: UsageTotals): UsagePart[] {
  const eq = reading(t.inputEquivalent, t.missingEquivalent, t.runs);
  if (eq.kind !== 'missing') {
    return part('equivalent', eq, {
      label: '当量',
      value: formatCount,
      missing: '当量没读到',
      title: `输入当量（${EQUIVALENT_RULE}）。${tokenBreakdown(t)}`,
    });
  }
  const tokens = reading(t.inputTokens + t.outputTokens, t.missingTokens, t.runs);
  const cache = reading(t.cacheReadTokens + t.cacheWriteTokens, t.missingCache, t.runs);
  // 两样都一次没读到（进程断了、没交终帧）：一句话说完
  if (tokens.kind === 'missing' && cache.kind === 'missing') {
    return [{ key: 'tokens', missing: 'token 和缓存都没读到' }];
  }
  return [
    ...part('tokens', tokens, {
      value: formatCount,
      unit: 'token',
      missing: 'token 没读到',
      title: `输入 ${formatCount(t.inputTokens)} · 输出 ${formatCount(t.outputTokens)}`,
    }),
    ...part('cache', cache, {
      label: '缓存',
      value: formatCount,
      missing: '缓存没读到，折不成当量',
      title: `缓存读 ${formatCount(t.cacheReadTokens)} · 缓存写 ${formatCount(t.cacheWriteTokens)}`,
    }),
  ];
}

/** 三种计费方式各怎么说。 */
export const BILLING_WORDS = {
  metered: { label: '按量', value: '按量', title: '按量计费：真花的钱' },
  subscription: {
    label: '套餐内',
    value: '套餐内折合',
    title: '套餐内：执行体按 API 价折合的数，账单不因它多一笔',
  },
  unknown: {
    label: '分不清',
    value: '花费',
    title: '渠道在库里查不到，分不清按量还是套餐内',
  },
} as const;

type Billing = keyof typeof BILLING_WORDS;
const BILLINGS: Billing[] = ['metered', 'subscription', 'unknown'];

function sharePart(billing: Billing, share: CostShare): UsagePart[] {
  const words = BILLING_WORDS[billing];
  const r = reading(share.usd, share.missing, share.runs);
  if (r.kind === 'none') return [];
  if (r.kind === 'missing') {
    // 分不清的没有前缀可写：直接「花费没读到」
    return [
      billing === 'unknown'
        ? { key: billing, missing: '花费没读到', title: words.title }
        : { key: billing, label: words.label, missing: '花费没读到', title: words.title },
    ];
  }
  const p: UsagePart = { key: billing, label: words.value, value: formatUsd(r.value), title: words.title };
  if (billing === 'unknown') p.unit = '（分不清按量、套餐内）';
  if (r.kind === 'partial') p.incomplete = r.missing;
  return [p];
}

/** 花费那几段：按量、套餐内、分不清各写各的，没有会话的那种不写。 */
export function costParts(t: UsageTotals): UsagePart[] {
  return BILLINGS.flatMap((b) => sharePart(b, t.cost[b]));
}

/** 干活时长那一段（按模型、按阶段的一行用）：时刻认不出的另记，不当成 0 秒。 */
export function workParts(t: UsageTotals): UsagePart[] {
  const r = reading(t.runMs, t.missingTime, t.runs);
  if (r.kind === 'none') return [];
  if (r.kind === 'missing') return [{ key: 'work', missing: '时刻认不出，时长没读到' }];
  const p: UsagePart = { key: 'work', label: '干活', value: formatDuration(r.value) };
  if (r.kind === 'partial') p.incomplete = r.missing;
  return [p];
}

/** 一组会话（一个模型、一个阶段）的一行：干活时长、当量、花费；只有在跑的会话时什么都还没有。 */
export function groupParts(t: UsageTotals): UsagePart[] {
  return [...workParts(t), ...tokenParts(t), ...costParts(t)];
}
