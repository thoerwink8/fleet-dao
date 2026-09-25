// 一次运行用到的上限与超时。全部可配（驾驶舱设置 → 工作流输入）；缺的字段读时现算默认值，不写回输入。
// 工作流开头经 decide 本地活动解析一次，结果进历史：以后改默认值，在途任务照旧用它开工时那一套（windsurf-dao#1813）。

import { QUICK_TIMEOUT_SECONDS } from './activity-options.ts';

export interface Limits {
  /** 一个需求同时最多跑几个子任务。 */
  maxParallelSubtasks: number;
  /** 方案最多拆几个子任务。 */
  maxSubtasks: number;
  /** 第二意见打回主会话的轮数上限（设计五：最多 2 轮）。 */
  reviewRounds: number;
  /** CI 红了回主会话修的轮数上限，与第二意见分开计（windsurf-dao#1813 的 F1）。 */
  ciFixRounds: number;
  /** 同步主线有冲突、回主会话解决的轮数上限。 */
  conflictRounds: number;
  /** 合并队列退回的次数上限。 */
  mergeReturns: number;
  /** 改的文件和方案点名的地方对不上，退回重做的次数上限。 */
  offPlanRounds: number;
  /** 一个子任务的墙钟预算：超了就不再自动返工，交帅位（人看过之后重新计；等人、排队的时间不算）。 */
  subtaskWallMinutes: number;
  /** 兜底梯：有界重试次数。 */
  retryAttempts: number;
  /** 兜底梯：换路由次数。 */
  routeSwaps: number;
  /** 兜底梯：换模型次数。 */
  modelSwaps: number;
  /** 分诊追问创始人的次数上限，到了按写明的假设继续。 */
  maxQuestions: number;
  /** 方案不合格时重写方案的次数。 */
  planRetries: number;
  /** 没空位、没额度时隔多久再选一次路由。 */
  routePollSeconds: number;
  /** 一个 AI 会话最长多久（等会话结束的限时）。 */
  sessionMinutes: number;
  /** 会话里没有工具在跑、又这么久没动静就判停滞（交给插头的 idle 超时）。 */
  stallSeconds: number;
  /** 一个会话（连同它跑的测试）的内存软上限，超了先回收（fleet-agent-scope --memory-high）。 */
  sessionMemoryHighMb: number;
  /** 内存硬上限，连 swap 一起封（--memory-max，--memory-swap-max 0）。 */
  sessionMemoryMaxMb: number;
  /** 长活动的心跳超时：工人丢了多久能发现。 */
  heartbeatSeconds: number;
  /** 等 CI 的限时。 */
  ciMinutes: number;
  /** 跑测试的限时。 */
  testsMinutes: number;
  /** 等合并队列回话多久没消息就重新入队一次（入队按条目编号去重）。 */
  mergeWaitMinutes: number;
  /** 合并队列每处理多少条换一次历史（continue-as-new）。 */
  mergeQueueBatch: number;
  /** 合并队列空闲多久就收工（有新条目时会被重新拉起）。 */
  mergeQueueIdleMinutes: number;
  /**
   * 一条工作流的事件数到这么多就报一次警（需求、子任务不换历史）。Temporal 每条执行 1 万个信号封顶、事件数 1 万出警告、
   * 5 万多封死：到那一步连叫停都发不进去，所以在一半之前就要有人知道。
   */
  historyAlertEvents: number;
}

export const DEFAULT_LIMITS: Readonly<Limits> = Object.freeze({
  maxParallelSubtasks: 3,
  maxSubtasks: 12,
  reviewRounds: 2,
  ciFixRounds: 3,
  conflictRounds: 3,
  mergeReturns: 3,
  offPlanRounds: 1,
  subtaskWallMinutes: 240,
  retryAttempts: 2,
  routeSwaps: 2,
  modelSwaps: 1,
  maxQuestions: 2,
  planRetries: 1,
  routePollSeconds: 30,
  sessionMinutes: 90,
  stallSeconds: 360,
  sessionMemoryHighMb: 1536,
  sessionMemoryMaxMb: 2048,
  heartbeatSeconds: 120,
  ciMinutes: 40,
  testsMinutes: 30,
  mergeWaitMinutes: 360,
  mergeQueueBatch: 50,
  mergeQueueIdleMinutes: 60,
  historyAlertEvents: 5000,
});

/**
 * 有下限的项：给了比下限小的取下限。
 * 合并队列空闲收工不能早于排队活动一次尝试的限时：排队的那一下最晚在限时内落地（带截止时间），
 * 队列记下的撤回至少要活到那时候才挡得住它。
 */
export const LIMIT_MINIMUMS: Readonly<Partial<Record<keyof Limits, number>>> = Object.freeze({
  mergeQueueIdleMinutes: QUICK_TIMEOUT_SECONDS / 60,
});

/** 缺的、非法的（非有限数、负数）一律取默认值；比下限小的取下限。 */
export function resolveLimits(partial: Partial<Limits> | null | undefined): Limits {
  const out: Limits = { ...DEFAULT_LIMITS };
  if (!partial) return out;
  for (const key of Object.keys(DEFAULT_LIMITS) as (keyof Limits)[]) {
    const value: unknown = partial[key];
    if (typeof value === 'number' && Number.isFinite(value) && value >= 0) {
      out[key] = Math.max(value, LIMIT_MINIMUMS[key] ?? 0);
    }
  }
  return out;
}

/**
 * 工作流事件数的报警线。上限在工作流开头解析一次、记进历史：这一项加进来之前开工的在途任务，记下的那一套里没有它，
 * 读出来是 undefined——那样一比就报「报警线 undefined」。缺了按现在的默认值。
 */
export function historyAlertLine(limits: Partial<Limits>): number {
  const value = limits.historyAlertEvents;
  return typeof value === 'number' && Number.isFinite(value) ? value : DEFAULT_LIMITS.historyAlertEvents;
}
