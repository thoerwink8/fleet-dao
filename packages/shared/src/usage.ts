// 会话用量怎么汇总（#216）：一张单按模型、按阶段（老流程的会话）、按段（三段的 runs，每段再按模型）、整张合计，
// 四样 token 折成输入当量。后端的任务详情、网页的演示数据和会话时间线（一次会话也按它算）都调这一份，免得几处算法不一样。
// 读不到的另记次数（missing*），不当成 0：没读到的那一项不往合计里加任何东西。
import type { BillingKind, SegmentKind, SegmentTier, SessionRun, StageKind } from './domain.ts';
import { SEGMENT_KINDS, type SegmentRunView } from './segment-runs.ts';

/**
 * 输入当量的折法（docs/design.md 第十节「一个 5 小时窗能干多少活」）：输入 1、缓存写 1.25、缓存读 0.1、输出 5。
 * 这是 Claude 的价格比例；别家的会话也按它折——只为拿同一把尺子比各步、各模型花了多少额度，不是钱。
 */
export const INPUT_EQUIVALENT_WEIGHTS = { input: 1, cacheWrite: 1.25, cacheRead: 0.1, output: 5 } as const;

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

type OptionalFact =
  | 'startedAt'
  | 'endedAt'
  | 'inputTokens'
  | 'outputTokens'
  | 'cacheReadTokens'
  | 'cacheWriteTokens'
  | 'costUsd';

/**
 * 一次会话的用量事实（session_runs 一行，和 SessionRun 同名同义）：读不到的字段不给，给 undefined 也一样——
 * 网页拿接口返回的会话（zod 推出来的，可选字段带 undefined）直接算，不另抄一份。
 */
export type RunUsageFacts = Pick<SessionRun, 'stage' | 'queuedAt'> & {
  [K in OptionalFact]?: SessionRun[K] | undefined;
} & {
  /**
   * 记在哪个模型名下：路由上的模型（模型目录的 id），和 Fusion 关单评论「各模型额度」一个口径；
   * 上游实际回话的模型（actualModel）不在这里分。
   */
  model: string;
  /** 给人看的模型名。 */
  modelName: string;
  /**
   * 路由所在渠道的计费方式（channels.billing）：按量的花费是真花的钱；套餐内的是执行体报的「按 API 价折合」，
   * 账单不因它多一笔。渠道在库里查不到就不给——记进「分不清」，不猜成套餐内。
   */
  billing?: BillingKind | undefined;
};

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
  /** 缓存读、缓存写两样都读到的会话才加进来；缺一样记一次 missingCache（存缓存读写之前的老会话全是没读到）。 */
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
   * 排队、干活时长（毫秒），和库里 queue_ms / run_ms 同一个算法；时刻认不出或倒着的记 missingTime。
   * 三段的一笔没有排队这回事（runs 表不记）：干活 = 结束 − 开始，排队不加，记一次 noQueue——排队合计要把它算作没读到。
   */
  queueMs: number;
  runMs: number;
  missingTime: number;
  noQueue: number;
}

export interface ModelUsageTotals extends UsageTotals {
  model: string;
  modelName: string;
}

export interface StageUsageTotals extends UsageTotals {
  stage: StageKind;
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
  /** 老流程的会话和三段的 runs 加在一起：各模型额度看这里才全。 */
  total: UsageTotals;
  /** 按第一次出现的先后：会话按排队时刻、三段按起跑时刻排好传进来，就是先用上的在前。 */
  byModel: ModelUsageTotals[];
  /** 老流程（session_runs）的会话按阶段。 */
  byStage: StageUsageTotals[];
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
    queueMs: 0,
    runMs: 0,
    missingTime: 0,
    noQueue: 0,
  };
}

/** 认不出的计费方式（没给、库里出了新种类）一律算分不清，不猜成套餐内。 */
function shareOf(cost: CostByBilling, billing: string | undefined): CostShare {
  if (billing === 'metered') return cost.metered;
  if (billing === 'subscription') return cost.subscription;
  return cost.unknown;
}

/** 排队 = (开工 ?? 结束) − 排队，干活 = 结束 − 开工（没开工就是 0）：和 session_runs 的两个生成列一样。 */
function durations(run: RunUsageFacts, endedAt: string): { queueMs: number; runMs: number } | undefined {
  const queued = Date.parse(run.queuedAt);
  const ended = Date.parse(endedAt);
  const started = run.startedAt === undefined ? undefined : Date.parse(run.startedAt);
  if (!Number.isFinite(queued) || !Number.isFinite(ended)) return undefined;
  if (started !== undefined && !Number.isFinite(started)) return undefined;
  const queueMs = (started ?? ended) - queued;
  const runMs = started === undefined ? 0 : ended - started;
  return queueMs >= 0 && runMs >= 0 ? { queueMs, runMs } : undefined;
}

function add(t: UsageTotals, run: RunUsageFacts): void {
  if (run.endedAt === undefined) {
    t.running += 1;
    return;
  }
  t.runs += 1;
  if (run.startedAt === undefined) t.notStarted += 1;
  addReadings(t, run);
  const spent = durations(run, run.endedAt);
  if (spent) {
    t.queueMs += spent.queueMs;
    t.runMs += spent.runMs;
  } else t.missingTime += 1;
}

/** 三段的一笔：在跑的只记 running；结束了的干活 = 读好的耗时（读不到记 missingTime），排队不记（noQueue）。 */
function addSegment(t: UsageTotals, run: SegmentUsageFacts): void {
  if (run.running) {
    t.running += 1;
    return;
  }
  t.runs += 1;
  t.noQueue += 1;
  if (run.outcome === 'spawn_failed' || run.outcome === 'admission_blocked') t.notStarted += 1;
  addReadings(t, run);
  const ms = run.durationMs;
  if (ms !== undefined && Number.isFinite(ms) && ms >= 0) t.runMs += ms;
  else t.missingTime += 1;
}

/** 结束了的一笔的 token、缓存、当量、花费：读到的加进来，缺哪样记哪样没读到。 */
function addReadings(
  t: UsageTotals,
  run: TokenCounts & { costUsd?: number | undefined; billing?: BillingKind | undefined },
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

/**
 * 一张单的用量：runs 是老流程的会话（按排队时刻排好），segments 是三段读好的流水（readSegmentRun 的结果，按起跑时刻排好）。
 * 整张合计和按模型两样都算；按阶段只算会话，按段只算三段。
 */
export function summarizeUsage(
  runs: readonly RunUsageFacts[],
  segments: readonly SegmentUsageFacts[] = [],
): TaskUsage {
  const total = emptyTotals();
  const byModel = new Map<string, ModelUsageTotals>();
  const byStage = new Map<StageKind, StageUsageTotals>();
  for (const run of runs) {
    let stage = byStage.get(run.stage);
    if (!stage) {
      stage = { stage: run.stage, ...emptyTotals() };
      byStage.set(run.stage, stage);
    }
    add(total, run);
    add(modelOf(byModel, run), run);
    add(stage, run);
  }
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
    byStage: [...byStage.values()],
    bySegment: [...bySegment.values()]
      .sort((a, b) => segmentRank(a.segment) - segmentRank(b.segment))
      .map(({ models, ...seg }) => ({ ...seg, byModel: [...models.values()] })),
  };
}
