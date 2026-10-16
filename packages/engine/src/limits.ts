// 一次运行用到的上限与超时。全部可配（驾驶舱设置 → 工作流输入）；缺的字段读时现算默认值，不写回输入。
// 工作流开头经 decide 本地活动解析一次，结果进历史：以后改默认值，在途任务照旧用它开工时那一套（windsurf-dao#1813）。
import { BUDGET_CACHE_READ_WEIGHT } from '@fleet-dao/shared';

export interface Limits {
  /** 兜底梯：有界重试次数。 */
  retryAttempts: number;
  /** 兜底梯：换路由次数。 */
  routeSwaps: number;
  /** 兜底梯：换模型次数。 */
  modelSwaps: number;
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
  /**
   * 一张单动手和验收会话合计最多花多少 token（四样相加），超了停下等人（决定 0093）；0 = 不设。
   * 老历史开工时解析出来的上限里没有这一项：工作流见不到它就不查。
   */
  taskTokenBudget: number;
  /**
   * 一张单的 PR 最多新增多少行（#2755 体量预算，相对主线、含测试）；0 = 不设。推之前比：超了第一次打回让会话收窄，
   * 第二次停下等人并附拆单建议。老历史开工时解析出来的上限里没有这一项：工作流见不到它就不判。
   */
  prLineBudget: number;
}

/**
 * 体量预算的默认值（#2755）：近 7 天重活 PR 新增行 p90 是 7117（#2385、#2401 涨到 +8000），推分支撞冲突 31 次里重活占 24 次。
 * 取 3000：多数单子放得下（中、快活远在这之下），7000 行那种整片重写会被打回收窄或拆单。真要大改的，人看过点「继续」照推。
 */
export const DEFAULT_PR_LINE_BUDGET = 3000;

/**
 * 单任务 token 预算的默认值（决定 0093）：法国库 2026-10-14 查近 14 天 254 张单（1008 次动手和验收会话），每张单四样 token
 * 相加的 p95 是 36,357,792，取整到 37,000,000。超了停下等人；点「继续」再给一份同样多的。
 * 查法：_tmp/rethink/resume-q1.sql（runs 按 task_id 汇总 input+output+cache_read+cache_write）。
 */
export const DEFAULT_TASK_TOKEN_BUDGET = 37_000_000;

/**
 * 预算按「折算 token」算（#2830）：缓存读乘这个权重，新输入、输出、缓存写照旧乘 1。
 * 为什么是 0.1：缓存读的价钱大约是新输入的十分之一（Claude 缓存读 0.1×输入价，别家缓存命中也在一折上下）。
 * 原先四样 1:1 相加，#2763 的 37.8M 里 36.8M（97%）是缓存读，折下来才约 4.7M；越是续会话省钱的单越早撞预算。
 * 数值的单一出处在 shared（驾驶舱、每日简报也按它折），这里转出来并写明理由。
 * 预算上限 37M 不跟着改：它是按四样 1:1 的 p95 取的，改口径后只会更宽松，要收紧另开单按折算后的数据重算。
 */
export const CACHE_READ_TOKEN_WEIGHT = BUDGET_CACHE_READ_WEIGHT;

/** 法国 VPS 能分给会话的内存（MiB）：机器约 11.7G，给内核和系统留约 0.7G。 */
export const FRANCE_USABLE_MB = 11 * 1024;
/** 平台常驻的四个服务合计（MiB，实测）：引擎 0.27G、后端 0.09G、Temporal 0.12G、库 0.13G。 */
export const FRANCE_RESIDENT_MB = 600;
/**
 * fleet-agents.slice（所有会话共用的父节点）的内存总上限 = 能分给会话的 - 平台常驻服务 = 11264 - 600 = 10664 MiB。
 * cgroup v2 的常见做法是把「总量」管在父节点，子节点（各会话的 scope）只管自己那份、彼此间允许借用空闲内存
 * （kernel 文档 memory.high / memory.max 一节：https://docs.kernel.org/admin-guide/cgroup-v2.html；k8s 的
 * requests/limits 同理）：多个会话同时冲高时，内核按这道父节点总闸压着回收，不会有单个会话在整机明明有空闲内存时
 * 先被自己那道窄墙卡死——法国实测：某次审查会话（cursor-agent）在自己的 scope 里同时跑
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
  retryAttempts: 2,
  routeSwaps: 2,
  modelSwaps: 1,
  sessionMinutes: 90,
  stallSeconds: 360,
  sessionMemoryHighMb: SESSION_MEMORY_HIGH_MB,
  sessionMemoryMaxMb: SESSION_MEMORY_MAX_MB,
  heartbeatSeconds: 120,
  ciMinutes: 40,
  testsMinutes: 30,
  taskTokenBudget: DEFAULT_TASK_TOKEN_BUDGET,
  prLineBudget: DEFAULT_PR_LINE_BUDGET,
});

/** 缺的、非法的（非有限数、负数）一律取默认值。 */
export function resolveLimits(partial: Partial<Limits> | null | undefined): Limits {
  const out: Limits = { ...DEFAULT_LIMITS };
  if (!partial) return out;
  for (const key of Object.keys(DEFAULT_LIMITS) as (keyof Limits)[]) {
    const value: unknown = partial[key];
    if (typeof value === 'number' && Number.isFinite(value) && value >= 0) {
      out[key] = value;
    }
  }
  return out;
}
