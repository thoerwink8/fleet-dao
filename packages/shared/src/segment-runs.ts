// 三段（库里的 runs 表）的一笔怎么读给人看（#216）：认段名、派工档、结局，算起止，读不到的逐样点名、写明为什么。
// 后端的任务详情和网页的假数据都调这一份；汇总（usage.ts 的 summarizeUsage）吃这里读好的结果，算法只有一份。
// 读不到的不拿 0 顶、也不当没事：段名认不出、起止缺一头、token 没记到……各记一条「没读到」带原因（unread），
// 只给认得出的值——认不出的原样写进原因里，不塞进给页面的字段。
import type { BillingKind, SegmentKind, SegmentOutcome, SegmentTier } from './domain.ts';
import { type CostEstimate, estimateCostUsd, type ModelPrice, modelPriceOf } from './model-prices.ts';
import { RUN_CAUSES, type RunCause, type RunVerdict } from './run-cause.ts';

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

/**
 * 确定没发出模型调用时写进 runs.usage_note 的原因（#2689）。哪一种写哪一句。
 * 起会话之前就停、但不是总开关（发布排空、切号）也确定没有调用，用 NOT_STARTED 那句。
 */
export const USAGE_NOTE_MASTER_OFF = '总开关关，没起会话，没有模型调用';
export const USAGE_NOTE_MEMORY = '内存不够，没起会话，没有模型调用';
export const USAGE_NOTE_SPAWN_FAILED = '起会话失败，没有模型调用';
export const USAGE_NOTE_NOT_STARTED = '还没起会话，没有模型调用';
/**
 * 起会话是否成功读不准、又没有会话号：用量留空（可能已经调用过模型，不能记成 0），原因写这一句。
 * 看板据此显示「读不到」，不留空。
 */
export const USAGE_SESSION_UNREAD = '会话号没拿到，用量读不到';
/** 上面那句在看板上的短字。 */
export const USAGE_BOARD_UNREAD = '读不到';

export interface SessionlessUsageInput {
  outcome: string;
  failureReason?: string | null;
  /** 有会话号就不改：补记任务按它补。 */
  hasSessionId: boolean;
  /** 插头已经写了为什么读不到（被叫停、超时杀没走到终帧）。留着那句，不改成「会话号没拿到」。 */
  hasUsageWhy: boolean;
  /** 四样 token 里已经有数。有数就不记成 0。 */
  hasToken: boolean;
}

/** 没会话号的一笔该怎么记：记 0 并写原因、只写「读不到」、或者不动。 */
export type SessionlessUsage =
  | { kind: 'zero'; note: string }
  | { kind: 'unread'; note: string }
  | { kind: 'leave' };

/** 还没把进程拉起来（总开关、排空、切号都在这一步停）。 */
function stoppedBeforeStart(failureReason: string): boolean {
  return failureReason.includes('还没起会话') || failureReason.includes('这一段没起会话');
}

/**
 * 没有会话号的一笔怎么记用量。确定没发出模型调用的记 0（总开关关、内存不够、起会话失败，以及起会话之前就停的）；
 * 读不准起没起的只写原因、数留空。有会话号、或插头已经解释过为什么读不到的，不动。
 */
export function sessionlessUsage(input: SessionlessUsageInput): SessionlessUsage {
  if (input.hasSessionId || input.hasUsageWhy) return { kind: 'leave' };
  const why = input.failureReason ?? '';
  if (!input.hasToken) {
    if (input.outcome === 'admission_blocked') return { kind: 'zero', note: USAGE_NOTE_MEMORY };
    if (input.outcome === 'spawn_failed') return { kind: 'zero', note: USAGE_NOTE_SPAWN_FAILED };
    if (input.outcome === 'org_switch' && stoppedBeforeStart(why)) {
      return { kind: 'zero', note: why.includes('总开关') ? USAGE_NOTE_MASTER_OFF : USAGE_NOTE_NOT_STARTED };
    }
  }
  return { kind: 'unread', note: USAGE_SESSION_UNREAD };
}

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
  /** 选路时那句「为什么派它」（runs.route_why）。没记的不给。 */
  routeWhy?: string | undefined;
  startedAt?: string | undefined;
  endedAt?: string | undefined;
  outcome?: string | undefined;
  inputTokens?: number | undefined;
  outputTokens?: number | undefined;
  cacheReadTokens?: number | undefined;
  cacheWriteTokens?: number | undefined;
  costUsd?: number | undefined;
  /** 用量为什么没记全（runs.usage_note）：token 有缺时接在「没记到」后面，写明为什么。 */
  usageNote?: string | undefined;
  memoryPeakMb?: number | undefined;
  /** 这一次会话的 CPU 秒数。没记、0、认不出都不给（不当成 0）；主页 lastSession 据此写「CPU 没读到」。 */
  cpuSeconds?: number | undefined;
  /** 判定不开上一段会话时的原因。 */
  resumeReason?: string | undefined;
  /** 接着上一笔的会话（runs.resume_session_id）。 */
  resumeSessionId?: string | undefined;
  /** 为什么起这一笔、摘要、所属回合、验收结论（#3140）；老行都没有。起因按字符串收，认不出的不给。 */
  cause?: string | undefined;
  causeSummary?: string | undefined;
  roundSeq?: number | undefined;
  verdict?: RunVerdict | undefined;
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
  /** 选路时那句「为什么派它」。没记的不给，页面写「没记」。 */
  routeWhy?: string | undefined;
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
  /** 这一次会话的 CPU 秒数（大于 0）。没记的不给，不在 unread 里点名：老行本来就没有，主页用 lastSession 写「CPU 没读到」。 */
  cpuSeconds?: number | undefined;
  /** 判定不开上一段会话时的原因；页面原样显示。 */
  resumeReason?: string | undefined;
  /**
   * 是新会话还是接上一笔的会话（#3140）：true＝记了续的会话号（接上一笔）；false＝记了新会话的原因；
   * 都没记（老行、对题和验收）不给，页面写「没记」。
   */
  resumed?: boolean | undefined;
  /** 为什么起这一笔、摘要、所属回合（task_rounds.seq）、验收这一笔的结论（#3140）；老行没有，页面写「老记录没记」。 */
  cause?: RunCause | undefined;
  causeSummary?: string | undefined;
  roundSeq?: number | undefined;
  verdict?: RunVerdict | undefined;
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
  const sessionUnread = run.usageNote?.trim() === USAGE_SESSION_UNREAD;

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
    // 「用量补记」写下的原因（还在等中转计量回填、中转没有这次调用的记录……）：有缺才接上。
    // 会话号没拿到的那一句，看板写「读不到」，不写成空、也不混进「都没记到」（那是真漏）。
    const why = run.usageNote?.trim();
    if (missing.length === TOKEN_KEYS.length) {
      tokens.push(
        sessionUnread ? USAGE_BOARD_UNREAD : notStarted ? '进程没起来，没有用量读数' : '四样 token 都没记到',
      );
    } else if (missing.length) tokens.push(`没记到：${missing.join('、')}`);
    if (missing.length && !notStarted && why && !(sessionUnread && missing.length === TOKEN_KEYS.length)) {
      tokens.push(why);
    }
    if (bad.length) tokens.push(`认不出：${bad.join('、')}`);
    note('tokens', tokens);
  }

  let costUsd: number | undefined;
  if (!running) {
    const v = run.costUsd;
    if (v !== undefined && Number.isFinite(v) && v >= 0) costUsd = v;
    else if (v === undefined) {
      note('cost', [
        sessionUnread ? USAGE_BOARD_UNREAD : notStarted ? '进程没起来，没有花费读数' : '花费没记到',
      ]);
    } else note('cost', [`花费「${v}」认不出`]);
  }

  // 没报花费、进程起来过的：按目录单价估一个数（页面标「估算」），没有单价、token 没读全的照实写
  // 会话号没拿到的不估：数是空的是因为读不准，不是「token 没读全所以估不了」
  const estimate =
    !running && costUsd === undefined && !notStarted && !sessionUnread
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
    ...(run.routeWhy?.trim() ? { routeWhy: run.routeWhy.trim() } : {}),
    ...(start ? { startedAt: start.iso } : {}),
    ...(end ? { endedAt: end.iso } : {}),
    running,
    ...(outcome !== undefined ? { outcome } : {}),
    ...(durationMs !== undefined ? { durationMs } : {}),
    ...counts,
    ...(costUsd !== undefined ? { costUsd } : {}),
    ...(estimate !== undefined ? { estimate } : {}),
    ...(isCount(run.memoryPeakMb) ? { memoryPeakMb: run.memoryPeakMb } : {}),
    ...(isCount(run.cpuSeconds) && run.cpuSeconds > 0 ? { cpuSeconds: run.cpuSeconds } : {}),
    ...(run.resumeReason?.trim() ? { resumeReason: run.resumeReason.trim() } : {}),
    ...(run.resumeSessionId?.trim() ? { resumed: true } : run.resumeReason?.trim() ? { resumed: false } : {}),
    ...(isOneOf(RUN_CAUSES, run.cause) ? { cause: run.cause } : {}),
    ...(run.causeSummary?.trim() ? { causeSummary: run.causeSummary.trim() } : {}),
    ...(run.roundSeq !== undefined && Number.isSafeInteger(run.roundSeq) && run.roundSeq > 0
      ? { roundSeq: run.roundSeq }
      : {}),
    ...(run.verdict !== undefined ? { verdict: run.verdict } : {}),
    ...(run.failureReason !== undefined ? { failureReason: run.failureReason } : {}),
    ...(run.prNumber !== undefined && Number.isSafeInteger(run.prNumber) && run.prNumber > 0
      ? { prNumber: run.prNumber }
      : {}),
    ...(run.branch !== undefined ? { branch: run.branch } : {}),
    matchedBy: run.matchedBy,
    unread,
  };
}
