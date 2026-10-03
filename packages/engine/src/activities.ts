// 工人这边：把端口实现包成 Temporal 活动。每次尝试记一笔计时（排队、干活分开），PortError 转成带错误码的失败。

import { Context } from '@temporalio/activity';
import type { Client } from '@temporalio/client';
import { ApplicationFailure, CancelledFailure } from '@temporalio/common';
import type { EngineActivities } from './activity-options.ts';
import {
  type CanaryDeps,
  CanaryNotRecordedError,
  type CanaryState,
  checkCanaryRound,
  openCanaryRound,
} from './jobs/canary.ts';
import {
  GitHubReconcileFailedError,
  type GitHubReconcileJobDeps,
  runGitHubReconcileJob,
} from './jobs/github-reconcile.ts';
import {
  HourlyReconcileFailedError,
  type HourlyReconcileJobDeps,
  runHourlyReconcileJob,
} from './jobs/hourly-reconcile.ts';
import { type IntakeDeps, IntakeFailedError, runIntakeJob } from './jobs/intake.ts';
import { QuotaReadFailedError, type QuotaReadJobDeps, runQuotaReadJob } from './jobs/quota-read.ts';
import { RouteProbeFailedError, type RouteProbeJobDeps, runRouteProbeJob } from './jobs/route-probe.ts';
import { runWatchdogJob, type WatchdogDeps, WatchdogFailedError } from './jobs/watchdog.ts';
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
  DeliveryRead,
  GuardedPaths,
  MergeWait,
  ReadDeliveryInput,
  ReadTaskBriefInput,
  RunSegmentInput,
  RunSegmentResult,
  WaitMergedInput,
} from './task-contract.ts';

/** 端口名的全集。写成 Record 让编译器保证一个不漏（windsurf-dao#1422：假活动表缺名字，生产卡在 activity not found）。 */
const PORT_KEYS: Readonly<Record<PortName, true>> = {
  pickRoute: true,
  createWorktree: true,
  removeWorktree: true,
  pushBranch: true,
  openPr: true,
  waitCi: true,
  syncMainline: true,
  saveTaskState: true,
  closeIssue: true,
  authorFamilies: true,
  raiseAlert: true,
  recordTiming: true,
};
export const PORT_NAMES = Object.keys(PORT_KEYS) as PortName[];

/** 记计时本身失败不影响干活，最多等这么久。 */
const TIMING_WRITE_BUDGET_MS = 5_000;

function portContext(ctx: Context): PortContext {
  return {
    signal: ctx.cancellationSignal,
    heartbeat: (details?: unknown) => ctx.heartbeat(details),
    attempt: ctx.info.attempt,
    lastHeartbeat: ctx.info.heartbeatDetails,
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
      return await handler(input, portContext(ctx));
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
 * 定时任务要的东西（真端口才有：库、GitHub）。给的是工厂：发信号、拉起工作流要用这次活动自己的 Temporal 客户端。
 * 不给（假端口）就不跑，活动明确报 JOB_NOT_CONFIGURED——定时任务是真端口那边建的，假端口的工人接到了也不装作跑过。
 */
export interface EngineJobs {
  /** taskQueue：这个工人取活的任务队列，补回来的单的工作流（Fusion）起在这里。 */
  githubReconcile?: (client: Client, taskQueue: string) => GitHubReconcileJobDeps;
  /** 路由探针（#129）：读路由、真起最小会话、写结论。 */
  routeProbe?: () => RouteProbeJobDeps;
  /** 定时读额度（#76）：读配置、读各池额度、读成的写库、读失败的报警。 */
  quotaRead?: () => QuotaReadJobDeps;
  /**
   * 每小时对账：看工作树、两处核对、撤过时的提醒、再推没人处理的、机器人权限自检（查工作流在不在跑、挂没挂着用这次活动的
   * Temporal 客户端；taskQueue 同上：排队的单补拉起的工作流起在这里）。
   */
  hourlyReconcile?: (client: Client, taskQueue: string) => HourlyReconcileJobDeps;
  /** 全流程巡检（#223）：在巡检仓开单、看它一路走完（叫停前几轮留下的单、查工作流用这次活动的 Temporal 客户端）。 */
  canary?: (client: Client) => CanaryDeps;
  /** 看门狗（#203）：按登记表看各定时任务新不新鲜、推撤提醒（只读写库）。 */
  watchdog?: () => WatchdogDeps;
  /** 拉单（#632）：读开着开关的仓里该做的单、起任务工作流（起工作流、数在跑的用这次活动的 Temporal 客户端；taskQueue 同上）。 */
  intake?: (client: Client, taskQueue: string) => IntakeDeps;
}

/**
 * 任务工作流（task-contract.ts，#632）要的那几个活动的实现（真端口才有）。和 EngineJobs 一个做法：不给（假端口，或真端口没接上）
 * 的活动明确报 TASK_NOT_CONFIGURED（不重试），不装作做过。
 */
export interface EngineTasks {
  readTaskBrief?: (input: ReadTaskBriefInput, ctx: PortContext) => Promise<TaskBriefResult>;
  runSegment?: (input: RunSegmentInput, ctx: PortContext) => Promise<RunSegmentResult>;
  readDelivery?: (input: ReadDeliveryInput, ctx: PortContext) => Promise<DeliveryRead>;
  coldVerify?: (input: ColdVerifyInput, ctx: PortContext) => Promise<ColdVerifyResult>;
  checkGuarded?: (input: CheckGuardedInput, ctx: PortContext) => Promise<GuardedPaths>;
  armAutoMerge?: (input: ArmAutoMergeInput, ctx: PortContext) => Promise<ArmAutoMergeResult>;
  waitMerged?: (input: WaitMergedInput, ctx: PortContext) => Promise<MergeWait>;
}

/** 任务工作流的活动名全集（写成 Record 让编译器保证一个不漏）。 */
const TASK_ACTIVITY_KEYS: Readonly<Record<keyof EngineTasks, true>> = {
  readTaskBrief: true,
  runSegment: true,
  readDelivery: true,
  coldVerify: true,
  checkGuarded: true,
  armAutoMerge: true,
  waitMerged: true,
};
export const TASK_ACTIVITY_NAMES = Object.keys(TASK_ACTIVITY_KEYS) as (keyof EngineTasks)[];

/** 引擎自己的活动：对账补漏跑一轮。没跑成的已经记进 schedule_runs，这里再报成不重试的失败（下一轮 15 分钟后照来）。 */
async function reconcileGitHub(jobs: EngineJobs): Promise<unknown> {
  const make = jobs.githubReconcile;
  if (!make) {
    throw new PortError(
      'JOB_NOT_CONFIGURED',
      '这个引擎工人没装对账补漏（假端口，或真端口没接上库和 GitHub）',
      {
        retryable: false,
      },
    );
  }
  try {
    const ctx = Context.current();
    return await runGitHubReconcileJob(make(ctx.client, ctx.info.taskQueue));
  } catch (error) {
    if (error instanceof GitHubReconcileFailedError) {
      throw new PortError('RECONCILE_FAILED', error.message, {
        retryable: false,
        details: { runId: error.runId },
      });
    }
    throw error;
  }
}

/** 引擎自己的活动：路由探针跑一轮。没跑成的已经记进 schedule_runs，这里再报成不重试的失败（下一轮 15 分钟后照来）。 */
async function probeRoutes(jobs: EngineJobs): Promise<unknown> {
  const make = jobs.routeProbe;
  if (!make) {
    throw new PortError(
      'JOB_NOT_CONFIGURED',
      '这个引擎工人没装路由探针（假端口，或真端口没接上库和会话）：不装作探过',
      { retryable: false },
    );
  }
  try {
    return await runRouteProbeJob(make());
  } catch (error) {
    if (error instanceof RouteProbeFailedError) {
      throw new PortError('ROUTE_PROBE_FAILED', error.message, {
        retryable: false,
        details: { runId: error.runId },
      });
    }
    throw error;
  }
}

/** 引擎自己的活动：定时读额度跑一轮。没跑成的已经记进 schedule_runs，这里再报成不重试的失败（下一轮 15 分钟后照来）。 */
async function readQuotas(jobs: EngineJobs): Promise<unknown> {
  const make = jobs.quotaRead;
  if (!make) {
    throw new PortError(
      'JOB_NOT_CONFIGURED',
      '这个引擎工人没装定时读额度（假端口，或真端口没接上库）：不装作读过',
      { retryable: false },
    );
  }
  try {
    return await runQuotaReadJob(make());
  } catch (error) {
    if (error instanceof QuotaReadFailedError) {
      throw new PortError('QUOTA_READ_FAILED', error.message, {
        retryable: false,
        details: { runId: error.runId },
      });
    }
    throw error;
  }
}

/** 引擎自己的活动：每小时对账跑一轮。没跑成的已经记进 schedule_runs，这里再报成不重试的失败（下一轮一小时后照来）。 */
async function reconcileHourly(jobs: EngineJobs): Promise<unknown> {
  const make = jobs.hourlyReconcile;
  if (!make) {
    throw new PortError(
      'JOB_NOT_CONFIGURED',
      '这个引擎工人没装每小时对账（假端口，或真端口没接上库和工作树）：不装作对过',
      { retryable: false },
    );
  }
  try {
    const ctx = Context.current();
    return await runHourlyReconcileJob(make(ctx.client, ctx.info.taskQueue));
  } catch (error) {
    if (error instanceof HourlyReconcileFailedError) {
      throw new PortError('HOURLY_RECONCILE_FAILED', error.message, {
        retryable: false,
        details: { runId: error.runId },
      });
    }
    throw error;
  }
}

/** 引擎自己的活动：看门狗跑一轮。没跑成的已经记进 schedule_runs，这里再报成不重试的失败（下一轮 5 分钟后照来）。 */
async function watchSchedules(jobs: EngineJobs): Promise<unknown> {
  const make = jobs.watchdog;
  if (!make) {
    throw new PortError(
      'JOB_NOT_CONFIGURED',
      '这个引擎工人没装看门狗（假端口，或真端口没接上库）：不装作看过',
      { retryable: false },
    );
  }
  try {
    return await runWatchdogJob(make());
  } catch (error) {
    if (error instanceof WatchdogFailedError) {
      throw new PortError('WATCHDOG_FAILED', error.message, {
        retryable: false,
        details: { runId: error.runId },
      });
    }
    throw error;
  }
}

/** 引擎自己的活动：拉单跑一轮。没跑成的已经记进 schedule_runs，这里再报成不重试的失败（下一轮 5 分钟后照来）。 */
async function intakeRound(jobs: EngineJobs): Promise<unknown> {
  const make = jobs.intake;
  if (!make) {
    throw new PortError(
      'JOB_NOT_CONFIGURED',
      '这个引擎工人没装拉单（假端口，或真端口没接上库和 GitHub）：不装作拉过',
      { retryable: false },
    );
  }
  try {
    const ctx = Context.current();
    return await runIntakeJob(make(ctx.client, ctx.info.taskQueue));
  } catch (error) {
    if (error instanceof IntakeFailedError) {
      throw new PortError('INTAKE_FAILED', error.message, {
        retryable: false,
        details: { runId: error.runId },
      });
    }
    throw error;
  }
}

/** 巡检没装（假端口，或真端口没接上库和 GitHub）：明确报 JOB_NOT_CONFIGURED，不装作巡检过。 */
function canaryDeps(jobs: EngineJobs): CanaryDeps {
  const make = jobs.canary;
  if (!make) {
    throw new PortError(
      'JOB_NOT_CONFIGURED',
      '这个引擎工人没装全流程巡检（假端口，或真端口没接上库和 GitHub）：不装作巡检过',
      { retryable: false },
    );
  }
  return make(Context.current().client);
}

/** 引擎自己的活动：全流程巡检开单。没跑成的已经记进库、回结论；记开始就没成报 CANARY_NOT_RECORDED（不重试）。 */
async function canaryOpen(jobs: EngineJobs): Promise<unknown> {
  try {
    return await openCanaryRound(canaryDeps(jobs));
  } catch (error) {
    if (error instanceof CanaryNotRecordedError) {
      throw new PortError('CANARY_NOT_RECORDED', error.message, { retryable: false });
    }
    throw error;
  }
}

/** 引擎自己的活动：全流程巡检看一回、判、记。 */
async function canaryCheck(jobs: EngineJobs, input: unknown): Promise<unknown> {
  const state = (input as { state?: CanaryState } | null)?.state;
  if (state?.schemaVersion !== 1) {
    throw new PortError('INVALID_INPUT', '全流程巡检看一回：输入里没有认得出的状态', { retryable: false });
  }
  return checkCanaryRound(canaryDeps(jobs), state);
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
  out.reconcileGitHub = timed('reconcileGitHub', () => reconcileGitHub(jobs), record);
  out.probeRoutes = timed('probeRoutes', () => probeRoutes(jobs), record);
  out.readQuotas = timed('readQuotas', () => readQuotas(jobs), record);
  out.reconcileHourly = timed('reconcileHourly', () => reconcileHourly(jobs), record);
  out.canaryOpen = timed('canaryOpen', () => canaryOpen(jobs), record);
  out.canaryCheck = timed('canaryCheck', (input) => canaryCheck(jobs, input), record);
  out.watchSchedules = timed('watchSchedules', () => watchSchedules(jobs), record);
  out.intakeRound = timed('intakeRound', () => intakeRound(jobs), record);
  for (const name of TASK_ACTIVITY_NAMES) {
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
