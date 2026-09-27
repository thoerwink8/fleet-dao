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
  /**
   * 会话 fleet blocked --needs human|info 说要人才能往下做：退回让它带选项和推荐用 fleet ask 重问（#259：问他不挡路），
   * 一个阶段最多退回几次；到数还这样才停下等人。access、other 不退回，照旧等人。
   */
  reaskRounds: number;
  /** 方案不合格时重写方案的次数。 */
  planRetries: number;
  /** 没空位、没额度时隔多久再选一次路由。 */
  routePollSeconds: number;
  /** 一个 AI 会话最长多久（等会话结束的限时）。 */
  sessionMinutes: number;
  /** 会话里没有工具在跑、又这么久没动静就判停滞（交给插头的 idle 超时）。 */
  stallSeconds: number;
  /** 一个会话（连同它跑的测试）的内存软上限，超了先回收（fleet-agent-scope --memory-high）。默认值怎么算见 SESSION_MEMORY_MAX_MB。 */
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

/** 法国 VPS 能分给会话的内存（MiB）：机器约 11.7G，给内核和系统留约 0.7G。 */
export const FRANCE_USABLE_MB = 11 * 1024;
/** 平台常驻的四个服务合计（MiB，2026-09-26 实测）：引擎 0.27G、后端 0.09G、Temporal 0.12G、库 0.13G。 */
export const FRANCE_RESIDENT_MB = 600;
/**
 * 同一时刻大致有几个会话在跑测试（内存的大头）：Fusion 的估算是法国同时约 3 张单，每张同一时间只一个模型写代码、跑测试
 * （docs/decisions/0002-fusion.md「容量」；design 第四节的「同时跑测试 2–3 份」）。只是容量规划的参考数，不再拿它去除
 * 单会话的内存上限（见 SESSION_MEMORY_MAX_MB 的推导）：总量不超的安全垫现在挪到父节点 fleet-agents.slice 这一层
 * （见 SLICE_MEMORY_MAX_MB），多个会话同时冲高由它兜住，不指望单会话早早卡死自己。
 */
export const CONCURRENT_SESSIONS = 3;

/**
 * fleet-agents.slice（所有会话共用的父节点）的内存总上限 = 能分给会话的 - 平台常驻服务 = 11264 - 600 = 10664 MiB。
 * cgroup v2 的常见做法是把「总量」管在父节点，子节点（各会话的 scope）只管自己那份、彼此间允许借用空闲内存
 * （kernel 文档 memory.high / memory.max 一节：https://docs.kernel.org/admin-guide/cgroup-v2.html；k8s 的
 * requests/limits 同理）：多个会话同时冲高时，内核按这道父节点总闸压着回收，不会有单个会话在整机明明有空闲内存时
 * 先被自己那道窄墙卡死——法国 2026-09-28 06:35–06:45 实测：#307 的审查会话（cursor-agent）在自己的 scope 里同时跑
 * `pnpm test:changed` 和 `pnpm exec tsc -b`：tsc 一个进程约 1.9G、vitest 几个 worker、cursor-agent 本身合计约
 * 3.5G，超过旧的单会话软上限 3298M，内核压着这个 cgroup 回收，进程卡在 D 状态（wchan mem_cgroup_handle_over_high）、
 * 1 分钟负载 12，但 vmstat 看 CPU 七到九成空闲、整机 MemAvailable 还有 6.8G——和 #160 同一个坑，第二次踩。
 * 这份总上限装进 `deploy/france/fleet-agents.slice` 的单元文件；两处数值要对得上，`packages/engine/test/slice-unit.test.ts`
 * 核对，免得改一边忘了改另一边。
 */
export const SLICE_MEMORY_MAX_MB = FRANCE_USABLE_MB - FRANCE_RESIDENT_MB;
/** 父节点的软上限比总上限低 512 MiB（比单会话那道 256 的夹缝宽一倍：这里要扛的是好几个会话一起冲高，留多一点余量）。 */
export const SLICE_MEMORY_HIGH_MB = SLICE_MEMORY_MAX_MB - 512;

/**
 * 单会话（连同它跑的测试）的内存硬上限：不再按「总量 ÷ 同时几个会话」严格三等分——旧算法把安全垫做在单会话这一层，
 * 三等分出来的 3554M 连「tsc -b 全仓 + 跑测试 + 代理本身」这一种会话内部就可能撞见的组合都放不下
 * （见 SLICE_MEMORY_MAX_MB 注释里的实测事故）。新算法把「总量不超」的安全垫交给父节点，单会话放宽成「一次放得下最坏
 * 情形」：tsc -b 全仓约 1.9G + 测试 2–3 个进程约 2.5–3.2G + 代理本身约 0.3–1G，取整到 6144（6 GiB）——约等于能分给
 * 会话的总量的一半，比旧值（三分之一）宽松得多，同时仍明显小于父节点的总上限（assertSessionFitsSlice 在模块加载时
 * 就校验这一点），多个会话同时顶到硬上限时由父节点的 MemoryHigh/MemoryMax 兜住。
 */
export const SESSION_MEMORY_MAX_MB = 6144;
/**
 * 软上限只比硬上限低 256 MiB：超了软上限、又没 swap 可换，内核就压着这个会话回收，半死不活（#160 在软 1.5G、硬 2G 之间
 * 一动不动十几分钟）；夹缝留窄，真超了就撞硬上限被明确杀掉。测试开几个进程按它算（packages/conventions/src/test-run.ts
 * 的 workersThatFit：新软上限放得下 5 个）。
 */
export const SESSION_MEMORY_HIGH_MB = SESSION_MEMORY_MAX_MB - 256;

export class LimitsConfigError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'LimitsConfigError';
  }
}

/**
 * 单会话的硬上限不能比父节点 fleet-agents.slice 的总上限还大：那样父节点这道总闸根本兜不住单个会话，形同没设。
 * 【故意造出的失败】常量改坏了（比如手改时把单会话上限抬到超过父节点）要在这里明确报错，不能悄悄放过去、等内核事后杀掉。
 */
export function assertSessionFitsSlice(sessionMaxMb: number, sliceMaxMb: number): void {
  if (sessionMaxMb > sliceMaxMb) {
    throw new LimitsConfigError(
      `单会话内存硬上限 ${sessionMaxMb}M 比父节点 fleet-agents.slice 的总上限 ${sliceMaxMb}M 还大，父节点兜不住：` +
        '改 SESSION_MEMORY_MAX_MB 或 SLICE_MEMORY_MAX_MB（packages/engine/src/limits.ts）',
    );
  }
}

// 模块加载时就校验一次：常量改坏了要立刻炸，不等到部署到法国才发现。
assertSessionFitsSlice(SESSION_MEMORY_MAX_MB, SLICE_MEMORY_MAX_MB);

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
  reaskRounds: 2,
  planRetries: 1,
  routePollSeconds: 30,
  sessionMinutes: 90,
  stallSeconds: 360,
  sessionMemoryHighMb: SESSION_MEMORY_HIGH_MB,
  sessionMemoryMaxMb: SESSION_MEMORY_MAX_MB,
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

/** 退回重问的次数上限：和 historyAlertLine 一样，这一项加进来之前开工的在途任务记下的那一套里没有它，缺了按现在的默认值。 */
export function reaskLimit(limits: Partial<Limits>): number {
  const value = limits.reaskRounds;
  return typeof value === 'number' && Number.isFinite(value) && value >= 0
    ? value
    : DEFAULT_LIMITS.reaskRounds;
}
