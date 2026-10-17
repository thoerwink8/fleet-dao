// 三段流水的用量怎么汇总（#216）：一张单按模型、按段（三段的 runs，每段再按模型）、整张合计，
// 四样 token 折成输入当量。后端的任务详情、任务列表和网页的演示数据都调这一份，免得几处算法不一样。
// 读不到的另记次数（missing*），不当成 0：没读到的那一项不往合计里加任何东西。
import type { BillingKind, SegmentKind, SegmentTier } from './domain.ts';
import type { CostEstimate } from './model-prices.ts';
import { SEGMENT_KINDS, type SegmentRunView } from './segment-runs.ts';

/**
 * 输入当量的折法（docs/design.md 第十节「一个 5 小时窗能干多少活」）：输入 1、缓存写 1.25、缓存读 0.1、输出 5。
 * 这是 Claude 的价格比例；别家的会话也按它折——只为拿同一把尺子比各步、各模型花了多少额度，不是钱。
 * 单任务 token 预算、每日简报的「每合并单输入当量」、驾驶舱的「输入当量」都用这一把（#2859）。
 */
export const INPUT_EQUIVALENT_WEIGHTS = { input: 1, cacheWrite: 1.25, cacheRead: 0.1, output: 5 } as const;

/**
 * 单任务 token 预算的默认值（决定 0093，#2859 改成按输入当量算）。查法：法国库 2026-10-16 查近 14 天 346 张单，
 * 每张单所有会话（runs 按 task_id 汇总）的输入当量（inputEquivalentOf，上面的权重）相加，p95 是 6,715,274，取整到 7,000,000
 * （p50 161 万、p99 1127 万）。超了停下等人；点「继续」再给一份同样多的。
 * 此前的 37,000,000 是按四样直接相加的 p95（3899 万）定的；预算改按当量后它永远碰不到，等于关了。
 * 在 shared 里是因为驾驶舱要写「上限」，和引擎读同一个数。
 */
export const DEFAULT_TASK_TOKEN_BUDGET = 7_000_000;

/** 按二十分之一算成整数再除：直接乘 0.1、1.25 会带出 1996.8000000000002 这种尾巴，四舍五入时可能进错位。 */
const SCALE = 20;
const SCALED = {
  input: Math.round(INPUT_EQUIVALENT_WEIGHTS.input * SCALE),
  cacheWrite: Math.round(INPUT_EQUIVALENT_WEIGHTS.cacheWrite * SCALE),
  cacheRead: Math.round(INPUT_EQUIVALENT_WEIGHTS.cacheRead * SCALE),
  output: Math.round(INPUT_EQUIVALENT_WEIGHTS.output * SCALE),
};

/** 一次会话的四样 token；没读到的不给。 */
export interface TokenCounts {
  inputTokens?: number | undefined;
  outputTokens?: number | undefined;
  cacheReadTokens?: number | undefined;
  cacheWriteTokens?: number | undefined;
}

/** token 数只认非负整数：没给、负数、小数、NaN 一律算没读到。 */
function tokens(v: number | undefined): number | undefined {
  return v !== undefined && Number.isSafeInteger(v) && v >= 0 ? v : undefined;
}

/** 四样 token 一个都没读到（结束了的一段才用这个数「读不到用量」）。 */
function tokensUnread(run: TokenCounts): boolean {
  return (
    tokens(run.inputTokens) === undefined &&
    tokens(run.outputTokens) === undefined &&
    tokens(run.cacheReadTokens) === undefined &&
    tokens(run.cacheWriteTokens) === undefined
  );
}

/**
 * 一次会话折成的输入当量（四舍五入到整数）。四样缺一样就折不成，回 undefined——不拿 0 顶，
 * 不然缓存读写没存下来的会话会显得几乎不花额度（长会话的额度大头是缓存读）。
 */
export function inputEquivalentOf(u: TokenCounts): number | undefined {
  const input = tokens(u.inputTokens);
  const output = tokens(u.outputTokens);
  const read = tokens(u.cacheReadTokens);
  const write = tokens(u.cacheWriteTokens);
  if (input === undefined || output === undefined || read === undefined || write === undefined)
    return undefined;
  const scaled =
    input * SCALED.input + write * SCALED.cacheWrite + read * SCALED.cacheRead + output * SCALED.output;
  return Math.round(scaled / SCALE);
}

/** 一种计费方式下的花费。 */
export interface CostShare {
  /** 走这种计费方式、结束了的会话数。 */
  runs: number;
  /** 读到的花费合计（美元）。 */
  usd: number;
  /** 没读到花费的次数。 */
  missing: number;
}

/**
 * 花费按渠道的计费方式分开：metered 按量，是真花的钱；subscription 套餐内，只是按 API 价折合、不另花钱；
 * unknown 渠道查不到，分不清是哪种（不猜成套餐内）。
 */
export interface CostByBilling {
  metered: CostShare;
  subscription: CostShare;
  unknown: CostShare;
}

/**
 * 一组会话的用量合计。每一样只加读到的；读不到的会话另记次数（missing*），不当成 0。
 * 还在跑的会话只记 running（用量还没出来，不算没读到），不进 runs 和各项合计。
 */
export interface UsageTotals {
  /** 结束了的会话数。 */
  runs: number;
  running: number;
  /** runs 里进程没起来就结束的：没有读数，照样记进各项的「没读到」；干活时长按 0（它没干过活）。 */
  notStarted: number;
  /** 输入（只算没命中缓存的）、输出两样都读到的会话才加进来；缺一样记一次 missingTokens。 */
  inputTokens: number;
  outputTokens: number;
  missingTokens: number;
  /** 缓存读、缓存写两样都读到的会话才加进来；缺一样记一次 missingCache。 */
  cacheReadTokens: number;
  cacheWriteTokens: number;
  missingCache: number;
  /** 输入当量（INPUT_EQUIVALENT_WEIGHTS）：四样 token 都读到的会话才算进来，缺一样记一次 missingEquivalent。 */
  inputEquivalent: number;
  missingEquivalent: number;
  /**
   * 执行体报的花费（美元；订阅内的也报一个数，说明这一轮值多少，不说明账单多了这一笔）。只有 Claude 报：
   * cursor 这类只报 token 的渠道每次都记 missingCost。这两项是 cost 里三种计费方式的和（和 Fusion 关单评论的
   * ModelUsage 同名）；给人看花了多少钱要看 cost，分清按量和套餐内。
   */
  costUsd: number;
  missingCost: number;
  cost: CostByBilling;
  /**
   * 三段的流水里执行体没报花费的那几笔，按模型目录的单价估（model-prices.ts）：runs 笔估成了、合计 usd；noPrice 笔目录里
   * 没有单价；noTokens 笔 token 没读全估不了。估出来的是「按 API 价值多少」，不是账单。
   */
  estimate: CostEstimateTotals;
  /** 干活时长（毫秒）：readSegmentRun 读好的耗时；读不到的记 missingTime。三段不记排队，所以没有排队时长。 */
  runMs: number;
  missingTime: number;
  /**
   * 结束了的三段里，四样 token 一个都没读到的段数。在跑的不计（用量还没出来）。
   * 页面写「另有 N 段读不到用量」。缺了一两样、其余读到了的不算在这里（那是 missingTokens / 估不了）。
   */
  unreadSegments: number;
}

export interface CostEstimateTotals {
  runs: number;
  usd: number;
  noPrice: number;
  noTokens: number;
}

export interface ModelUsageTotals extends UsageTotals {
  model: string;
  modelName: string;
}

/** 三段里的一段（对题 / 动手 / 验收）：合计，再按模型分。 */
export interface SegmentUsageTotals extends UsageTotals {
  /** 段名认不出的几笔归在 null 这一组（每一笔认不出的原样在它的 unread 里）。 */
  segment: SegmentKind | null;
  /** 这一段用过的派工档，按第一次出现的先后；对题、验收不分档，是空的。 */
  tiers: SegmentTier[];
  /** 没记派工档或认不出的笔数（只有动手段分档，对题、验收不算）。 */
  missingTier: number;
  byModel: ModelUsageTotals[];
}

export interface TaskUsage {
  /** 三段的 runs 整张合计。 */
  total: UsageTotals;
  /** 按第一次出现的先后：三段按起跑时刻排好传进来，就是先用上的在前。 */
  byModel: ModelUsageTotals[];
  /** 三段（runs）按段：对题、动手、验收的固定先后，段名认不出的一组排最后。只列有过一笔的段。 */
  bySegment: SegmentUsageTotals[];
}

/** 汇总要用的一笔三段：readSegmentRun 读好的结果（认不出的、读不到的已经剔掉、记在 unread 里）。 */
export type SegmentUsageFacts = Pick<
  SegmentRunView,
  | 'segment'
  | 'model'
  | 'modelName'
  | 'billing'
  | 'tier'
  | 'running'
  | 'outcome'
  | 'durationMs'
  | 'inputTokens'
  | 'outputTokens'
  | 'cacheReadTokens'
  | 'cacheWriteTokens'
  | 'costUsd'
  | 'estimate'
  | 'unread'
>;

function emptyShare(): CostShare {
  return { runs: 0, usd: 0, missing: 0 };
}

function emptyTotals(): UsageTotals {
  return {
    runs: 0,
    running: 0,
    notStarted: 0,
    inputTokens: 0,
    outputTokens: 0,
    missingTokens: 0,
    cacheReadTokens: 0,
    cacheWriteTokens: 0,
    missingCache: 0,
    inputEquivalent: 0,
    missingEquivalent: 0,
    costUsd: 0,
    missingCost: 0,
    cost: { metered: emptyShare(), subscription: emptyShare(), unknown: emptyShare() },
    estimate: { runs: 0, usd: 0, noPrice: 0, noTokens: 0 },
    runMs: 0,
    missingTime: 0,
    unreadSegments: 0,
  };
}

/** 认不出的计费方式（没给、库里出了新种类）一律算分不清，不猜成套餐内。 */
function shareOf(cost: CostByBilling, billing: string | undefined): CostShare {
  if (billing === 'metered') return cost.metered;
  if (billing === 'subscription') return cost.subscription;
  return cost.unknown;
}

/** 三段的一笔：在跑的只记 running；结束了的干活 = 读好的耗时（读不到记 missingTime）。 */
function addSegment(t: UsageTotals, run: SegmentUsageFacts): void {
  if (run.running) {
    t.running += 1;
    return;
  }
  t.runs += 1;
  if (tokensUnread(run)) t.unreadSegments += 1;
  if (run.outcome === 'spawn_failed' || run.outcome === 'admission_blocked') t.notStarted += 1;
  addReadings(t, run, run.estimate);
  const ms = run.durationMs;
  if (ms !== undefined && Number.isFinite(ms) && ms >= 0) t.runMs += ms;
  else t.missingTime += 1;
}

/** 结束了的一笔的 token、缓存、当量、花费：读到的加进来，缺哪样记哪样没读到。 */
function addReadings(
  t: UsageTotals,
  run: TokenCounts & { costUsd?: number | undefined; billing?: BillingKind | undefined },
  estimate: CostEstimate | undefined,
): void {
  const input = tokens(run.inputTokens);
  const output = tokens(run.outputTokens);
  if (input !== undefined && output !== undefined) {
    t.inputTokens += input;
    t.outputTokens += output;
  } else t.missingTokens += 1;

  const read = tokens(run.cacheReadTokens);
  const write = tokens(run.cacheWriteTokens);
  if (read !== undefined && write !== undefined) {
    t.cacheReadTokens += read;
    t.cacheWriteTokens += write;
  } else t.missingCache += 1;

  const equivalent = inputEquivalentOf(run);
  if (equivalent !== undefined) t.inputEquivalent += equivalent;
  else t.missingEquivalent += 1;

  const share = shareOf(t.cost, run.billing);
  share.runs += 1;
  const cost = run.costUsd;
  if (cost !== undefined && Number.isFinite(cost) && cost >= 0) {
    t.costUsd += cost;
    share.usd += cost;
  } else {
    t.missingCost += 1;
    share.missing += 1;
  }
  if (estimate?.kind === 'estimated') {
    t.estimate.runs += 1;
    // 到小数点后 6 位：一笔笔加会带出浮点尾巴
    t.estimate.usd = Math.round((t.estimate.usd + estimate.usd) * 1_000_000) / 1_000_000;
  } else if (estimate?.kind === 'noPrice') t.estimate.noPrice += 1;
  else if (estimate?.kind === 'noTokens') t.estimate.noTokens += 1;
}

function modelOf(
  byModel: Map<string, ModelUsageTotals>,
  run: { model: string; modelName: string },
): ModelUsageTotals {
  let model = byModel.get(run.model);
  if (!model) {
    model = { model: run.model, modelName: run.modelName, ...emptyTotals() };
    byModel.set(run.model, model);
  }
  return model;
}

/** 段的先后：对题、动手、验收，认不出的排最后。 */
const segmentRank = (s: SegmentKind | null) => (s === null ? SEGMENT_KINDS.length : SEGMENT_KINDS.indexOf(s));

/** 一张单的用量：segments 是三段读好的流水（readSegmentRun 的结果，按起跑时刻排好）。整张合计、按模型、按段（每段再按模型）。 */
export function summarizeUsage(segments: readonly SegmentUsageFacts[]): TaskUsage {
  const total = emptyTotals();
  const byModel = new Map<string, ModelUsageTotals>();
  const bySegment = new Map<
    SegmentKind | null,
    SegmentUsageTotals & { models: Map<string, ModelUsageTotals> }
  >();
  for (const run of segments) {
    let seg = bySegment.get(run.segment);
    if (!seg) {
      seg = {
        segment: run.segment,
        tiers: [],
        missingTier: 0,
        byModel: [],
        models: new Map(),
        ...emptyTotals(),
      };
      bySegment.set(run.segment, seg);
    }
    if (run.tier !== undefined && !seg.tiers.includes(run.tier)) seg.tiers.push(run.tier);
    if (run.unread.some((n) => n.item === 'tier')) seg.missingTier += 1;
    addSegment(total, run);
    addSegment(modelOf(byModel, run), run);
    addSegment(seg, run);
    addSegment(modelOf(seg.models, run), run);
  }
  return {
    total,
    byModel: [...byModel.values()],
    bySegment: [...bySegment.values()]
      .sort((a, b) => segmentRank(a.segment) - segmentRank(b.segment))
      .map(({ models, ...seg }) => ({ ...seg, byModel: [...models.values()] })),
  };
}

/** 任务列表一行的花费：实付和按 API 价折算分开。usd 跟实付同一个数，老页面只认这一栏。 */
export interface ListedTaskCost {
  /** 执行体报的实付合计。一笔都没报是 null，不当成 0。 */
  actual: number | null;
  /** 没报实付、token 读全、目录有单价的段，按 API 价折算的合计。一笔都没估成是 null，不当成 0。 */
  estimated: number | null;
  /** 和 actual 同一个数。 */
  usd: number | null;
  /** 结束了的三段笔数（在跑的不算）。调用方数好传进来。 */
  segments: number;
  /** 四样 token 都没读到的段数（usage.unreadSegments）。 */
  unreadSegments: number;
  /** 目录里没有单价、估不出的段数。 */
  noPrice: number;
  /** 没有要说的就不给这个键。 */
  note?: string | undefined;
}

const round6 = (n: number) => Math.round(n * 1_000_000) / 1_000_000;

/** 和驾驶舱 formatUsd 同一档：不到一分多写两位，再小的不写成 $0.00。 */
function usdText(n: number): string {
  if (n > 0 && n < 0.0001) return '<$0.0001';
  if (n > 0 && n < 0.01) return `$${n.toFixed(4)}`;
  return `$${n.toFixed(n >= 100 ? 0 : 2)}`;
}

/**
 * 任务列表一行的花费。segments 是这张单结束了的三段笔数。
 * 实付是执行体报的 cost_usd；报了的不再估。一笔都没报、但 token 和单价都齐的，estimated 给按 API 价折算的数。
 * 订阅渠道因此不是 0 元。目录里没有单价的记 noPrice，不把估计写成 0。
 */
export function taskListCost(usage: UsageTotals, segments: number): ListedTaskCost {
  const reported = usage.runs - usage.missingCost;
  const actual = reported > 0 ? round6(usage.costUsd) : null;
  const estimated = usage.estimate.runs > 0 ? round6(usage.estimate.usd) : null;
  const notes: string[] = [];
  if (usage.runs === 0) notes.push('还没有结束的会话记录，花费没得算');
  else if (actual === null && estimated === null && usage.estimate.noPrice === 0) {
    notes.push(`${usage.runs} 笔会话都没报花费`);
  }
  if (estimated !== null) notes.push(`按 API 价折算 ${usdText(estimated)}（订阅渠道，不是另花的钱）`);
  if (usage.estimate.noPrice > 0) notes.push(`${usage.estimate.noPrice} 段没有单价`);
  if (usage.unreadSegments > 0) notes.push(`另有 ${usage.unreadSegments} 段读不到用量`);
  // 没报实付、又没估成的（token 没读全，或有实付时剩下的）才叫偏低。估成了的已经在「按 API 价折算」里。
  const unestimated = usage.missingCost - usage.estimate.runs;
  if (actual !== null && unestimated > 0) {
    notes.push(`另有 ${unestimated} 笔没算进实付也没估出来，这个数偏低`);
  }
  const note = notes.join('；');
  return {
    actual,
    estimated,
    usd: actual,
    segments,
    unreadSegments: usage.unreadSegments,
    noPrice: usage.estimate.noPrice,
    ...(note ? { note } : {}),
  };
}
