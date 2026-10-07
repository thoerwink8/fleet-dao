// 模型单价目录（驾驶舱改版 2026-10-07：创始人「每个环节花费测不出来」）：执行体不报花费的那几笔（订阅制的 Grok、
// Claude 拼车这类，runs.cost_usd 是空的），按「token × 目录里的单价」估一个数，页面标「估算」。
//
// 改这里之前必须知道：
// - 只写查得到出处的价：每一项带 source（链接）和 checkedAt（查的那天）。查不到的模型不写——页面写「没有单价」，不显示 0、
//   不拿别家的价顶。
// - 单价是 API 标价（美元 / 百万 token）。订阅、拼车的账单不按它算：估出来的数是「这一轮按 API 价值多少」，用来比各段、各模型
//   花了多少，不是账单多出的钱（和执行体报的「套餐内折合」同一个意思）。
// - 只估执行体没报花费的那几笔：报了的照用报的，不另估一遍。
// - 键是模型目录的 id（models.id，和 runs.model 同一个），不是上游串。

import type { TokenCounts } from './usage.ts';

export interface ModelPrice {
  /** 没命中缓存的输入（美元 / 百万 token）。 */
  inputPerMTok: number;
  outputPerMTok: number;
  cacheReadPerMTok: number;
  /** 写缓存。不单列写缓存价的家（xAI、OpenAI）按输入价算，note 里写明。 */
  cacheWritePerMTok: number;
  /** 价从哪来（链接）。 */
  source: string;
  /** 查价的那天（YYYY-MM-DD）。 */
  checkedAt: string;
  /** 价表上没写、这里按什么算的。 */
  note?: string;
}

export const MODEL_PRICES: Readonly<Record<string, ModelPrice>> = {
  'opus-5.5': {
    inputPerMTok: 4,
    outputPerMTok: 20,
    cacheReadPerMTok: 0.2,
    cacheWritePerMTok: 5,
    source: 'https://platform.claude.com/docs/en/about-claude/pricing',
    checkedAt: '2026-10-07',
    note: '写缓存按 5 分钟缓存价（输入价的 1.25 倍）',
  },
  'sonnet-5.5': {
    inputPerMTok: 2,
    outputPerMTok: 10,
    cacheReadPerMTok: 0.2,
    cacheWritePerMTok: 2.5,
    source: 'https://platform.claude.com/docs/en/about-claude/pricing',
    checkedAt: '2026-10-07',
    note: '写缓存按 5 分钟缓存价（输入价的 1.25 倍）',
  },
  'grok-4.7': {
    inputPerMTok: 2,
    outputPerMTok: 6,
    cacheReadPerMTok: 0.5,
    cacheWritePerMTok: 2,
    source: 'https://www.eesel.ai/blog/grok-4-7-pricing',
    checkedAt: '2026-10-07',
    note: '200K 以内的价（超过 200K 的请求整笔翻倍，这里不分）；xAI 不单列写缓存价，按输入价算；出处是第三方汇总，没核到 xAI 官方页',
  },
  'gpt-5.6-luna': {
    inputPerMTok: 0.2,
    outputPerMTok: 1.2,
    cacheReadPerMTok: 0.02,
    cacheWritePerMTok: 0.2,
    source: 'https://developers.openai.com/api/docs/models/gpt-5.6-luna',
    checkedAt: '2026-10-07',
    note: '2026-07-30 降价后的价；OpenAI 不单列写缓存价，按输入价算',
  },
};

/** 目录里这个模型的单价；没有就是 undefined（页面写「没有单价」）。 */
export function modelPriceOf(model: string): ModelPrice | undefined {
  return Object.hasOwn(MODEL_PRICES, model) ? MODEL_PRICES[model] : undefined;
}

/**
 * 一笔的估算花费。
 * - estimated：四样 token 都读到了，按单价算出的数（美元）；
 * - noPrice：目录里没有这个模型的单价；
 * - noTokens：token 没读全（缺哪几样写在 why 里），估不了——不拿 0 顶缺的那几样，不然缓存读写没记下的会显得几乎不花钱。
 */
export type CostEstimate =
  | { kind: 'estimated'; usd: number }
  | { kind: 'noPrice'; why: string }
  | { kind: 'noTokens'; why: string };

const TOKEN_NAMES = {
  inputTokens: '输入',
  outputTokens: '输出',
  cacheReadTokens: '缓存读',
  cacheWriteTokens: '缓存写',
} as const;

const count = (v: number | undefined): v is number => v !== undefined && Number.isSafeInteger(v) && v >= 0;

/** 按单价估一笔：先看有没有单价，再看 token 读没读全。 */
export function estimateCostUsd(
  tokens: TokenCounts,
  model: string,
  price: ModelPrice | undefined,
): CostEstimate {
  if (!price) return { kind: 'noPrice', why: `模型目录里没有「${model}」的单价` };
  const missing = (Object.keys(TOKEN_NAMES) as (keyof typeof TOKEN_NAMES)[])
    .filter((k) => !count(tokens[k]))
    .map((k) => TOKEN_NAMES[k]);
  if (missing.length) return { kind: 'noTokens', why: `没读到${missing.join('、')}，估不了` };
  const usd =
    ((tokens.inputTokens as number) * price.inputPerMTok +
      (tokens.outputTokens as number) * price.outputPerMTok +
      (tokens.cacheReadTokens as number) * price.cacheReadPerMTok +
      (tokens.cacheWriteTokens as number) * price.cacheWritePerMTok) /
    1_000_000;
  // 到小数点后 6 位（和 runs.cost_usd 的精度一样），免得浮点尾巴
  return { kind: 'estimated', usd: Math.round(usd * 1_000_000) / 1_000_000 };
}
