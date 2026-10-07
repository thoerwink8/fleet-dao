// 三段（库里的 runs 表）的一笔怎么读给人看（#216）：认段名、派工档、结局，算起止，读不到的逐样点名、写明为什么。
// 后端的任务详情和网页的假数据都调这一份；汇总（usage.ts 的 summarizeUsage）吃这里读好的结果，算法只有一份。
// 读不到的不拿 0 顶、也不当没事：段名认不出、起止缺一头、token 没记到……各记一条「没读到」带原因（unread），
// 只给认得出的值——认不出的原样写进原因里，不塞进给页面的字段。
import type { BillingKind, SegmentKind, SegmentOutcome, SegmentTier } from './domain.ts';
import { type CostEstimate, estimateCostUsd, type ModelPrice, modelPriceOf } from './model-prices.ts';

export const SEGMENT_KINDS = ['scope', 'manual', 'verify'] as const satisfies readonly SegmentKind[];
export const SEGMENT_TIERS = ['fast', 'medium', 'heavyweight'] as const satisfies readonly SegmentTier[];
export const SEGMENT_OUTCOMES = [
  'done',
  'timeout',
  'killed',
  'spawn_failed',
  'admission_blocked',
  'failed',
  'org_switch',
] as const satisfies readonly SegmentOutcome[];

/** 三段给人看的名字（驾驶舱页面和主页流水线图的文字都从这里出，不各写一份）。 */
export const SEGMENT_LABELS: Record<SegmentKind, string> = { scope: '对题', manual: '动手', verify: '验收' };

/** 一段结局给人看的说法。 */
export const SEGMENT_OUTCOME_LABELS: Record<SegmentOutcome, string> = {
  done: '完成',
  timeout: '超时',
  killed: '被停掉',
  spawn_failed: '没起来',
  admission_blocked: '内存满没放行',
  failed: '失败',
  org_switch: '切号停下，切完重跑',
};

/** 进程没起来就结束的两种结局：没有用量读数。 */
const NOT_STARTED: readonly SegmentOutcome[] = ['spawn_failed', 'admission_blocked'];

/** 怎么和这张单对上的：task = 按 task_id；issueNumber = task_id 没记，按单号兜底（单号几个仓可能重）。 */
export type SegmentMatch = 'task' | 'issueNumber';

/** 哪一样没读到。 */
export type UnreadItem = 'segment' | 'time' | 'outcome' | 'tokens' | 'cost' | 'tier';

export interface UnreadNote {
  item: UnreadItem;
  /** 一句白话的为什么，页面原样显示。 */
  reason: string;
}

/**
 * 读之前的一笔：库里 runs 的一行（SegmentRun），加上查好的模型名、渠道的计费方式、怎么对上这张单的。
 * 段名、派工档、结局、时刻都按字符串收：库里有约束，但读的一方照样认一遍（内存版、以后导进来的数据没有约束）。
 */
export interface SegmentRunFacts {
  id: string;
  segment: string;
  model: string;
  modelName: string;
  channel?: string | undefined;
  /** 渠道的计费方式；渠道在库里查不到就不给（花费记进「分不清」，不猜成套餐内）。 */
  billing?: BillingKind | undefined;
  tier?: string | undefined;
  startedAt?: string | undefined;
  endedAt?: string | undefined;
  outcome?: string | undefined;
  inputTokens?: number | undefined;
  outputTokens?: number | undefined;
  cacheReadTokens?: number | undefined;
  cacheWriteTokens?: number | undefined;
  costUsd?: number | undefined;
  memoryPeakMb?: number | undefined;
  failureReason?: string | undefined;
  prNumber?: number | undefined;
  branch?: string | undefined;
  matchedBy: SegmentMatch;
}

/** 读好的一笔（任务详情 segmentRuns 的一条，形状和 web-api.ts 的 SegmentRunSchema 一字不差）。 */
export interface SegmentRunView {
  id: string;
  /** 认得出的段；认不出是 null，原样写在 unread 的原因里。 */
  segment: SegmentKind | null;
  model: string;
  modelName: string;
  channel?: string | undefined;
  billing?: BillingKind | undefined;
  tier?: SegmentTier | undefined;
  /** 认得出的时刻（统一成 toISOString 的写法）。 */
  startedAt?: string | undefined;
  endedAt?: string | undefined;
  /** 还在跑：没结束，单子也还没结束。在跑的用量等它结束才有，不算没读到。 */
  running: boolean;
  outcome?: SegmentOutcome | undefined;
  /** 结束了、起止都读得到：结束 − 开始（毫秒）。读不到的不给，原因在 unread。 */
  durationMs?: number | undefined;
  inputTokens?: number | undefined;
  outputTokens?: number | undefined;
  cacheReadTokens?: number | undefined;
  cacheWriteTokens?: number | undefined;
  costUsd?: number | undefined;
  /**
   * 执行体没报花费（订阅制的 Grok、Claude 拼车……）时按模型目录的单价估的（model-prices.ts）：估成了、没有单价、token 没读全
   * 三种之一。报了花费的、在跑的、进程没起来的没有这一项。
   */
  estimate?: CostEstimate | undefined;
  memoryPeakMb?: number | undefined;
  failureReason?: string | undefined;
  prNumber?: number | undefined;
  branch?: string | undefined;
  matchedBy: SegmentMatch;
  /** 这一笔哪几样没读到、为什么；全读到是空的。 */
  unread: UnreadNote[];
}

export interface SegmentReadContext {
  /** 单子已经结束（done / stopped / failed）：开着的那一段不是在跑，是没记结束。 */
  taskFinished: boolean;
  /** 模型的单价从哪查；不给就是 model-prices.ts 的目录（测试可换）。 */
  priceOf?: ((model: string) => ModelPrice | undefined) | undefined;
}

const TOKEN_NAMES = {
  inputTokens: '输入',
  outputTokens: '输出',
  cacheReadTokens: '缓存读',
  cacheWriteTokens: '缓存写',
} as const;
type TokenKey = keyof typeof TOKEN_NAMES;
const TOKEN_KEYS = Object.keys(TOKEN_NAMES) as TokenKey[];

const isOneOf = <T extends string>(list: readonly T[], v: string | undefined): v is T =>
  v !== undefined && (list as readonly string[]).includes(v);

/** 认得出的时刻统一成 toISOString 的写法；认不出回 undefined。 */
function instant(raw: string | undefined): { iso: string; ms: number } | undefined {
  if (raw === undefined) return undefined;
  const ms = Date.parse(raw);
  return Number.isFinite(ms) ? { iso: new Date(ms).toISOString(), ms } : undefined;
}

/** token 只认非负整数。 */
const isCount = (v: number | undefined): v is number => v !== undefined && Number.isSafeInteger(v) && v >= 0;

/** 读一笔：认段名、派工档、结局，算起止和耗时，读不到的逐样记一条带原因。 */
export function readSegmentRun(run: SegmentRunFacts, ctx: SegmentReadContext): SegmentRunView {
  const unread: UnreadNote[] = [];
  const note = (item: UnreadItem, reasons: string[]) => {
    if (reasons.length) unread.push({ item, reason: reasons.join('；') });
  };

  const segment = isOneOf(SEGMENT_KINDS, run.segment) ? run.segment : null;
  if (segment === null) {
    note('segment', [`段名「${run.segment}」认不出（只认 scope / manual / verify）`]);
  }

  const start = instant(run.startedAt);
  const end = instant(run.endedAt);
  const noEnd = run.endedAt === undefined;
  // 没结束、也没结局：单子还在跑就是在跑；单子已经结束了，就是这一段没收尾（进程断了没记结束），不当成在跑
  const running = noEnd && run.outcome === undefined && !ctx.taskFinished;
  const time: string[] = [];
  if (run.startedAt === undefined) time.push('没记开始时刻');
  else if (!start) time.push(`开始时刻「${run.startedAt}」认不出`);
  let durationMs: number | undefined;
  if (!running) {
    if (noEnd && run.outcome === undefined) {
      time.push('单子已经结束，这一段没记结束时刻（多半是进程断了、没收尾）');
    } else if (noEnd) time.push(`有结局（${run.outcome}）却没记结束时刻`);
    else if (!end) time.push(`结束时刻「${run.endedAt}」认不出`);
    if (start && end) {
      if (end.ms < start.ms) time.push('结束早于开始，起止是倒着的');
      // 真跑完的一段不会 0 毫秒：起止同一刻是写入时刻占位（verify.ts 的 saveVerifyRound 就这么写），不是真起止
      else if (end.ms === start.ms && run.outcome === 'done')
        time.push('起止是同一刻，不是真起止（多半是写入时刻占位）');
      else durationMs = end.ms - start.ms;
    }
  }
  note('time', time);

  let outcome: SegmentOutcome | undefined;
  if (!running) {
    if (run.outcome === undefined) note('outcome', ['结束了却没记结局']);
    else if (isOneOf(SEGMENT_OUTCOMES, run.outcome)) outcome = run.outcome;
    else note('outcome', [`结局「${run.outcome}」认不出`]);
  }
  const notStarted = outcome !== undefined && NOT_STARTED.includes(outcome);

  const counts: Partial<Record<TokenKey, number>> = {};
  if (!running) {
    const missing: string[] = [];
    const bad: string[] = [];
    for (const key of TOKEN_KEYS) {
      const v = run[key];
      if (isCount(v)) counts[key] = v;
      else if (v === undefined) missing.push(TOKEN_NAMES[key]);
      else bad.push(`${TOKEN_NAMES[key]}（${v}）`);
    }
    const tokens: string[] = [];
    if (missing.length === TOKEN_KEYS.length) {
      tokens.push(notStarted ? '进程没起来，没有用量读数' : '四样 token 都没记到');
    } else if (missing.length) tokens.push(`没记到：${missing.join('、')}`);
    if (bad.length) tokens.push(`认不出：${bad.join('、')}`);
    note('tokens', tokens);
  }

  let costUsd: number | undefined;
  if (!running) {
    const v = run.costUsd;
    if (v !== undefined && Number.isFinite(v) && v >= 0) costUsd = v;
    else if (v === undefined) note('cost', [notStarted ? '进程没起来，没有花费读数' : '花费没记到']);
    else note('cost', [`花费「${v}」认不出`]);
  }

  // 没报花费、进程起来过的：按目录单价估一个数（页面标「估算」），没有单价、token 没读全的照实写
  const estimate =
    !running && costUsd === undefined && !notStarted
      ? estimateCostUsd(counts, run.model, (ctx.priceOf ?? modelPriceOf)(run.model))
      : undefined;

  // 只有动手段分档（决定 0010 第 3 条）：对题、验收没有派工档是对的，不算没读到
  let tier: SegmentTier | undefined;
  if (isOneOf(SEGMENT_TIERS, run.tier)) tier = run.tier;
  else if (run.tier !== undefined) note('tier', [`派工档「${run.tier}」认不出`]);
  else if (segment === 'manual') note('tier', ['动手段没记派工档']);

  return {
    id: run.id,
    segment,
    model: run.model,
    modelName: run.modelName,
    ...(run.channel !== undefined ? { channel: run.channel } : {}),
    ...(run.billing !== undefined ? { billing: run.billing } : {}),
    ...(tier !== undefined ? { tier } : {}),
    ...(start ? { startedAt: start.iso } : {}),
    ...(end ? { endedAt: end.iso } : {}),
    running,
    ...(outcome !== undefined ? { outcome } : {}),
    ...(durationMs !== undefined ? { durationMs } : {}),
    ...counts,
    ...(costUsd !== undefined ? { costUsd } : {}),
    ...(estimate !== undefined ? { estimate } : {}),
    ...(isCount(run.memoryPeakMb) ? { memoryPeakMb: run.memoryPeakMb } : {}),
    ...(run.failureReason !== undefined ? { failureReason: run.failureReason } : {}),
    ...(run.prNumber !== undefined && Number.isSafeInteger(run.prNumber) && run.prNumber > 0
      ? { prNumber: run.prNumber }
      : {}),
    ...(run.branch !== undefined ? { branch: run.branch } : {}),
    matchedBy: run.matchedBy,
    unread,
  };
}
