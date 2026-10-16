// 工人这边：把端口实现包成 Temporal 活动。每次尝试记一笔计时（排队、干活分开），PortError 转成带错误码的失败。

import { Context } from '@temporalio/activity';
import type { Client } from '@temporalio/client';
import { ApplicationFailure, CancelledFailure } from '@temporalio/common';
import type { EngineActivities } from './activity-options.ts';
import type { CarpoolWatchDeps } from './jobs/carpool-watch.ts';
import type { CiTimingsJobDeps } from './jobs/ci-timings.ts';
import type { CliUpgradeJobDeps } from './jobs/cli-upgrade.ts';
import type { CliVersionsJobDeps } from './jobs/cli-versions.ts';
import type { ClosedIssueEventDeps } from './jobs/closed-issue-events.ts';
import type { DailyBriefDeps } from './jobs/daily-brief.ts';
import { probeAssignedRoute } from './jobs/dispatch-probe.ts';
import type { GitHubReconcileJobDeps } from './jobs/github-reconcile.ts';
import type { GroomRunDeps } from './jobs/groom.ts';
import type { HourlyReconcileJobDeps } from './jobs/hourly-reconcile.ts';
import type { IntakeDeps } from './jobs/intake.ts';
import type { IntakeChatDeps } from './jobs/intake-chat.ts';
import type { JudgeSelfCheckJobDeps } from './jobs/judge-self-check.ts';
import type { QuotaReadJobDeps } from './jobs/quota-read.ts';
import type { RequestSweepJobDeps } from './jobs/request-sweep.ts';
import type { RouteProbeJobDeps } from './jobs/route-probe.ts';
import type { RouteProbeNowDeps } from './jobs/route-probe-now.ts';
import { routeProbeLock } from './jobs/route-probe-now.ts';
import type { UsageBackfillJobDeps } from './jobs/usage-backfill.ts';
import type { WatchdogDeps } from './jobs/watchdog.ts';
import type { WorktreeCleanupDeps } from './jobs/worktree-cleanup.ts';
import {
  type ActivityTiming,
  type EnginePorts,
  type PortContext,
  PortError,
  type PortName,
} from './ports.ts';
import type { TaskBriefResult } from './runner/task-brief.ts';
import type {
  ArmAutoMergeInput,
  ArmAutoMergeResult,
  CheckGuardedInput,
  ColdVerifyInput,
  ColdVerifyResult,
  DecideFlowModeInput,
  DecideFlowModeResult,
  DeliveryRead,
  EngineStartedAt,
  GuardedPaths,
  MergeNowInput,
  MergeNowResult,
  MergeWait,
  NoteBare401Input,
  NoteBare401Result,
  PlanSegmentResumeInput,
  PlanSegmentResumeResult,
  ProbeAssignedInput,
  ReadCiPolicyInput,
  ReadCiPolicyResult,
  ReadDeliveryInput,
  ReadTaskBriefInput,
  ReleaseReservationInput,
  ReleaseReservationResult,
  RunSegmentInput,
  RunSegmentResult,
  SegmentSettledInput,
  SegmentSettledResult,
  SelfCheckInput,
  SelfCheckResult,
  TaskSpendInput,
  TaskSpendResult,
  WaitMergedInput,
} from './task-contract.ts';

/** 进程级启动代次：模块随 worker 进程只初始化一次。 */
const ENGINE_STARTED_AT = new Date().toISOString();

/** 端口名的全集。写成 Record 让编译器保证一个不漏（windsurf-dao#1422：假活动表缺名字，生产卡在 activity not found）。 */
const PORT_KEYS: Readonly<Record<PortName, true>> = {
  pickRoute: true,
  createWorktree: true,
  removeWorktree: true,
  pushBranch: true,
  openPr: true,
  updatePrBody: true,
  waitCi: true,
  syncMainline: true,
  saveTaskState: true,
  recordRound: true,
  closeIssue: true,
  raiseAlert: true,
  recordTiming: true,
};
export const PORT_NAMES = Object.keys(PORT_KEYS) as PortName[];

/** 记计时本身失败不影响干活，最多等这么久。 */
const TIMING_WRITE_BUDGET_MS = 5_000;

function portContext(ctx: Context, activity?: string): PortContext {
  const workflowId = ctx.info.workflowExecution?.workflowId;
  return {
    signal: ctx.cancellationSignal,
    heartbeat: (details?: unknown) =>
      ctx.heartbeat({
        ...(details && typeof details === 'object' ? details : {}),
        engineStartedAt: ENGINE_STARTED_AT,
        ...(activity ? { activity } : {}),
      }),
    attempt: ctx.info.attempt,
    lastHeartbeat: ctx.info.heartbeatDetails,
    ...(workflowId !== undefined ? { workflowId } : {}),
  };
}

/** 错误码过 Temporal 边界：PortError → ApplicationFailure（type = code）；其余原样（SDK 会带上 name 当 type）。 */
export function toActivityFailure(error: unknown): unknown {
  if (error instanceof PortError) {
    return ApplicationFailure.create({
      type: error.code,
      message: error.message,
      nonRetryable: !error.retryable,
      details: error.details === undefined ? [] : [error.details],
    });
  }
  return error;
}

function scopeOf(input: unknown): { taskId?: string; subtaskId?: string; subtaskKey?: string } {
  if (!input || typeof input !== 'object') return {};
  const { taskId, subtaskId, subtaskKey } = input as {
    taskId?: unknown;
    subtaskId?: unknown;
    subtaskKey?: unknown;
  };
  return {
    ...(typeof taskId === 'string' ? { taskId } : {}),
    ...(typeof subtaskId === 'string' ? { subtaskId } : {}),
    ...(typeof subtaskKey === 'string' ? { subtaskKey } : {}),
  };
}

async function writeTiming(
  record: EnginePorts['recordTiming'],
  entry: ActivityTiming,
  ctx: Context,
): Promise<void> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    // 被取消的那次也要记下来：记账不跟着这次活动一起被取消。
    await Promise.race([
      record(entry, { ...portContext(ctx), signal: new AbortController().signal }),
      new Promise((_, reject) => {
        timer = setTimeout(
          () => reject(new Error(`超过 ${TIMING_WRITE_BUDGET_MS} 毫秒`)),
          TIMING_WRITE_BUDGET_MS,
        );
      }),
    ]);
  } catch (error) {
    ctx.log.warn('记计时失败（不影响这次活动）', { activity: entry.activity, error: String(error) });
  } finally {
    clearTimeout(timer);
  }
}

type Handler = (input: unknown, ctx: PortContext) => Promise<unknown>;

function timed(name: string, handler: Handler, record: EnginePorts['recordTiming']) {
  return async (input: unknown): Promise<unknown> => {
    const ctx = Context.current();
    const info = ctx.info;
    const startedAt = Date.now();
    let outcome: ActivityTiming['outcome'] = 'ok';
    let errorCode: string | undefined;
    try {
      return await handler(input, portContext(ctx, name));
    } catch (error) {
      if (error instanceof CancelledFailure || ctx.cancellationSignal.aborted) {
        outcome = 'cancelled';
        throw error;
      }
      outcome = 'failed';
      const failure = toActivityFailure(error);
      errorCode =
        failure instanceof ApplicationFailure
          ? (failure.type ?? 'Error')
          : ((failure as Error)?.name ?? 'Error');
      throw failure;
    } finally {
      const endedAt = Date.now();
      const scheduled = info.currentAttemptScheduledTimestampMs;
      await writeTiming(
        record,
        {
          kind: 'activity',
          workflowId: info.workflowExecution?.workflowId ?? '',
          runId: info.workflowExecution?.runId ?? '',
          workflowType: info.workflowType ?? '',
          activity: name,
          attempt: info.attempt,
          ...scopeOf(input),
          scheduledAt: new Date(scheduled).toISOString(),
          startedAt: new Date(startedAt).toISOString(),
          endedAt: new Date(endedAt).toISOString(),
          queueMs: Math.max(0, startedAt - scheduled),
          runMs: Math.max(0, endedAt - startedAt),
          outcome,
          ...(errorCode ? { errorCode } : {}),
        },
        ctx,
      );
    }
  };
}

/**
 * 定时任务要的东西（真端口才有：库、GitHub）。给的是工厂：拉起工作流、查工作流要用引擎的 Temporal 客户端（jobs/engine-timers.ts
 * 每一轮现装）。不给（假端口）就不起定时器；真端口缺了哪个，起的时候就明说起不来。
 */
export interface EngineJobs {
  /** taskQueue：这个工人取活的任务队列，补回来的单的工作流（Fusion）起在这里。 */
  githubReconcile?: (client: Client, taskQueue: string) => GitHubReconcileJobDeps;
  /** 路由探针（#129）：读路由、真起最小会话、写结论。 */
  routeProbe?: () => RouteProbeJobDeps;
  /**
   * 放掉选路时预占、这轮又不用的名额（#1409 派前探测不通）。不给，活动报 JOB_NOT_CONFIGURED，不装作放过。
   */
  releaseReservation?: (reservationId: string) => Promise<void>;
  /** 驾驶舱的立即探测（jobs/route-probe-now.ts）：每几秒看一眼有没人点、接手、探、回结论。不给就不看。 */
  routeProbeNow?: () => RouteProbeNowDeps;
  /** 临时指挥官整理待办（jobs/groom.ts，母单 #1335 第 3 片）：每几秒看一眼有没有排队的整理，有就接手、起会话、执行清单。不给就不看。 */
  groom?: () => GroomRunDeps;
  /** 驾驶舱「提需求」的指挥官会话（jobs/intake-chat.ts，#2061）：每两秒看一眼有没有排着的一轮，接手、起会话或续会话、写回话。不给就不看。 */
  intakeChat?: () => IntakeChatDeps;
  /** 定时读额度（#76）：读配置、读各池额度、读成的写库、读失败的报警。 */
  quotaRead?: () => QuotaReadJobDeps;
  /** 拼车额度盯读（#194，给切号用）：按情况读开放接口、交给切号当场判。 */
  carpoolWatch?: () => CarpoolWatchDeps;
  /**
   * 每小时对账：看工作树、两处核对、撤过时的提醒、再推没人处理的、机器人权限自检（查工作流在不在跑、挂没挂着用这次活动的
   * Temporal 客户端；taskQueue 同上：排队的单补拉起的工作流起在这里）。
   */
  hourlyReconcile?: (client: Client, taskQueue: string) => HourlyReconcileJobDeps;
  /** 一键清理没用的工作树（jobs/worktree-cleanup.ts，#1993）：每几秒看一眼有没人点，接手跑一轮和每小时对账同一份判据的清扫。不给就不看。 */
  worktreeCleanup?: (client: Client, taskQueue: string) => WorktreeCleanupDeps;
  /** 单一关就撤停着等人的任务（jobs/closed-issue-events.ts，#2103）：每几秒捞一次投递账上没处理的 issues.closed，走每小时对账同一个撤法。不给就不看。 */
  closedIssueEvents?: (client: Client, taskQueue: string) => ClosedIssueEventDeps;
  /** 看门狗（#203）：按登记表看各定时任务新不新鲜、推撤提醒（只读写库）。 */
  watchdog?: () => WatchdogDeps;
  /** 拉单（#632）：读开着开关的仓里该做的单、起任务工作流（起工作流、数在跑的用这次活动的 Temporal 客户端；taskQueue 同上）。 */
  intake?: (client: Client, taskQueue: string) => IntakeDeps;
  /** 判断题自检（#1365）：最近一次调用失败超过 30 分钟，发一道不占额度的固定题，结果写进判断记录。不拉单。 */
  judgeSelfCheck?: () => JudgeSelfCheckJobDeps;
  /** 每天刷新 CI 测试耗时表（#921）：读 ci.yml 日志、重写表、开 PR。不拉单。 */
  ciTimings?: () => CiTimingsJobDeps;
  /** 用量补记（#1935）：经 Mirasim 起的会话，按中转计量把 runs 的输入、缓存、花费补齐，没齐写原因。不拉单。 */
  usageBackfill?: () => UsageBackfillJobDeps;
  /** 命令行工具升级（#1971）：空闲时排空并写请求，root 的单元去装。不拉单。 */
  cliUpgrade?: () => CliUpgradeJobDeps;
  /** 命令行工具版本（#1969）：读在用版本和官方最新。不升级、不拉单。 */
  cliVersions?: () => CliVersionsJobDeps;
  /** 需求整理（#2049）：删了满 30 天的需求硬删、该归档的归档。不拉单。 */
  requestSweep?: () => RequestSweepJobDeps;
  /** 每日简报（决定 0096）：每天 08:30 推飞书、在 #1055 发评论。不拉单。 */
  dailyBrief?: () => DailyBriefDeps;
}

/**
 * 任务工作流（task-contract.ts，#632）要的那几个活动的实现（真端口才有）。和 EngineJobs 一个做法：不给（假端口，或真端口没接上）
 * 的活动明确报 TASK_NOT_CONFIGURED（不重试），不装作做过。
 */
export interface EngineTasks {
  /** 当前 worker 的进程启动时刻；只读、无业务副作用。 */
  engineStartedAt?: (input: { schemaVersion: 1 }, ctx: PortContext) => Promise<EngineStartedAt>;
  readTaskBrief?: (input: ReadTaskBriefInput, ctx: PortContext) => Promise<TaskBriefResult>;
  runSegment?: (input: RunSegmentInput, ctx: PortContext) => Promise<RunSegmentResult>;
  readDelivery?: (input: ReadDeliveryInput, ctx: PortContext) => Promise<DeliveryRead>;
  coldVerify?: (input: ColdVerifyInput, ctx: PortContext) => Promise<ColdVerifyResult>;
  checkGuarded?: (input: CheckGuardedInput, ctx: PortContext) => Promise<GuardedPaths>;
  armAutoMerge?: (input: ArmAutoMergeInput, ctx: PortContext) => Promise<ArmAutoMergeResult>;
  waitMerged?: (input: WaitMergedInput, ctx: PortContext) => Promise<MergeWait>;
  /** 现读这个仓的 CI 模式。没有这个受管仓要抛，不许当成不强制。 */
  readCiPolicy?: (input: ReadCiPolicyInput, ctx: PortContext) => Promise<ReadCiPolicyResult>;
  /** 不强制 CI：直接合并，不等检查。 */
  mergeNow?: (input: MergeNowInput, ctx: PortContext) => Promise<MergeNowResult>;
  /** 判这一段能不能续上一段的会话（决定 0088）。续不上回原因，不抛。 */
  planSegmentResume?: (input: PlanSegmentResumeInput, ctx: PortContext) => Promise<PlanSegmentResumeResult>;
  /** 上一段收场了没有（决定 0093）：重试、重派前问，没收场不起第二段。库读不了抛。 */
  segmentSettled?: (input: SegmentSettledInput, ctx: PortContext) => Promise<SegmentSettledResult>;
  /** 动手会话收场后在会话的树里跑测试和 tsc（决定 0093）。没跑成回 skipped，不抛。 */
  selfCheck?: (input: SelfCheckInput, ctx: PortContext) => Promise<SelfCheckResult>;
  /** 这张单到现在花掉多少 token（单任务预算，决定 0093）。 */
  taskSpend?: (input: TaskSpendInput, ctx: PortContext) => Promise<TaskSpendResult>;
  /** 只凭 HTTP 401 的共享记号：所有任务一起数，短时间里第二次才停池。 */
  noteBare401?: (input: NoteBare401Input, ctx: PortContext) => Promise<NoteBare401Result>;
  /** 定这张单走三段还是全程（#2826，flow-mode.ts）：读标签、开关、仓档案，写一次分组记录。读不到抛。 */
  decideFlowMode?: (input: DecideFlowModeInput, ctx: PortContext) => Promise<DecideFlowModeResult>;
}

/** 任务工作流的活动名全集（写成 Record 让编译器保证一个不漏）。 */
const TASK_ACTIVITY_KEYS: Readonly<Record<keyof EngineTasks, true>> = {
  engineStartedAt: true,
  readTaskBrief: true,
  runSegment: true,
  readDelivery: true,
  coldVerify: true,
  checkGuarded: true,
  armAutoMerge: true,
  waitMerged: true,
  readCiPolicy: true,
  mergeNow: true,
  planSegmentResume: true,
  segmentSettled: true,
  selfCheck: true,
  taskSpend: true,
  noteBare401: true,
  decideFlowMode: true,
};
export const TASK_ACTIVITY_NAMES = Object.keys(TASK_ACTIVITY_KEYS) as (keyof EngineTasks)[];

function parseProbeAssigned(input: unknown): ProbeAssignedInput {
  const raw = input as Partial<ProbeAssignedInput> | null;
  if (
    raw?.schemaVersion !== 1 ||
    typeof raw.routeId !== 'string' ||
    raw.routeId.length === 0 ||
    typeof raw.label !== 'string' ||
    raw.label.length === 0
  ) {
    throw new PortError('INVALID_INPUT', '派前探测：要有路由编号和名字', { retryable: false });
  }
  return { schemaVersion: 1, routeId: raw.routeId, label: raw.label };
}

/**
 * 派单前探选定的这一条。没装探针明确报 JOB_NOT_CONFIGURED，不当成探通，也不按上一次结论派。
 * 读路由表失败原样抛：不把没读成当成探通。
 */
async function runProbeAssigned(jobs: EngineJobs, input: unknown): Promise<unknown> {
  const parsed = parseProbeAssigned(input);
  const make = jobs.routeProbe;
  if (!make) {
    throw new PortError(
      'JOB_NOT_CONFIGURED',
      '这个引擎工人没装路由探针（假端口，或真端口没接上）：不装作探过，也不派',
      { retryable: false },
    );
  }
  return probeAssignedRoute(make(), routeProbeLock, parsed);
}

function parseReleaseReservation(input: unknown): ReleaseReservationInput {
  const raw = input as Partial<ReleaseReservationInput> | null;
  if (raw?.schemaVersion !== 1 || typeof raw.reservationId !== 'string' || raw.reservationId.length === 0) {
    throw new PortError('INVALID_INPUT', '放预占：要有预占编号', { retryable: false });
  }
  return { schemaVersion: 1, reservationId: raw.reservationId };
}

/** 派前探测不通、这轮不用这条路由：放掉选路时预占的名额。没装放名额不装作放过。 */
async function runReleaseReservation(jobs: EngineJobs, input: unknown): Promise<ReleaseReservationResult> {
  const parsed = parseReleaseReservation(input);
  const release = jobs.releaseReservation;
  if (!release) {
    throw new PortError(
      'JOB_NOT_CONFIGURED',
      '这个引擎工人没装放预占名额（假端口，或真端口没接上）：不装作放过',
      { retryable: false },
    );
  }
  await release(parsed.reservationId);
  return { released: true };
}

export function createActivities(
  ports: EnginePorts,
  jobs: EngineJobs = {},
  tasks: EngineTasks = {},
): EngineActivities {
  const record = ports.recordTiming.bind(ports);
  const out: Record<string, (input: unknown) => Promise<unknown>> = {};
  for (const name of PORT_NAMES) {
    const port = (ports[name] as Handler).bind(ports);
    if (name === 'recordTiming') {
      // 记计时自己不再记计时，不然没完没了。
      out[name] = async (input: unknown) => {
        try {
          return await port(input, portContext(Context.current()));
        } catch (error) {
          throw toActivityFailure(error);
        }
      };
    } else {
      out[name] = timed(name, port, record);
    }
  }
  out.probeAssignedRoute = timed('probeAssignedRoute', (input) => runProbeAssigned(jobs, input), record);
  out.releaseReservation = timed('releaseReservation', (input) => runReleaseReservation(jobs, input), record);
  for (const name of TASK_ACTIVITY_NAMES) {
    if (name === 'engineStartedAt') {
      out[name] = timed(name, async () => ({ schemaVersion: 1, startedAt: ENGINE_STARTED_AT }), record);
      continue;
    }
    out[name] = timed(
      name,
      async (input, ctx) => {
        const impl = tasks[name] as Handler | undefined;
        if (!impl) {
          throw new PortError(
            'TASK_NOT_CONFIGURED',
            `这个引擎工人没装「${name}」（假端口，或真端口没接上）：不装作做过`,
            { retryable: false },
          );
        }
        return impl(input, ctx);
      },
      record,
    );
  }
  return out as unknown as EngineActivities;
}
