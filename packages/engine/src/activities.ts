// 工人这边：把端口实现包成 Temporal 活动。每次尝试记一笔计时（排队、干活分开），PortError 转成带错误码的失败；
// 起会话前现签 fleet 通行证、把 fleet 命令放进会话的 PATH（通行证不进工作流历史）。

import { Context } from '@temporalio/activity';
import { ApplicationFailure, CancelledFailure } from '@temporalio/common';
import type { EngineActivities } from './activity-options.ts';
import { enqueueSignal, type MergeQueueInput, mergeQueueWorkflowId, WORKFLOW_TYPES } from './contract.ts';
import {
  type ActivityTiming,
  type EnginePorts,
  type PortContext,
  PortError,
  type PortName,
  type StartSessionInput,
} from './ports.ts';

/** 端口名的全集。写成 Record 让编译器保证一个不漏（windsurf-dao#1422：假活动表缺名字，生产卡在 activity not found）。 */
const PORT_KEYS: Readonly<Record<PortName, true>> = {
  pickRoute: true,
  startSession: true,
  awaitSession: true,
  stopSession: true,
  createWorktree: true,
  removeWorktree: true,
  pushBranch: true,
  runTests: true,
  openPr: true,
  waitCi: true,
  syncMainline: true,
  mergePr: true,
  updateIssueProgress: true,
  saveTaskState: true,
  closeIssue: true,
  writeSpecDoc: true,
  askHuman: true,
  requestApproval: true,
  raiseAlert: true,
  recordTiming: true,
};
export const PORT_NAMES = Object.keys(PORT_KEYS) as PortName[];

/** fleet 通行证里的内容（驾驶舱后端 signAgentToken 的入参）。 */
export interface AgentTokenClaims {
  taskId: string;
  subtaskId?: string;
  runId: string;
  ttlSeconds: number;
}

export interface SessionLaunchConfig {
  /** fleet 命令的后端地址，进会话环境的 FLEET_API。 */
  fleetApi: string;
  /** 装着 fleet 命令的目录（packages/cli/bin），放到会话 PATH 最前面。 */
  cliBinDir: string;
  /** 签通行证：只对一个任务的一次会话有效。接驾驶舱后端的 signAgentToken（@fleet-dao/api/agent-token）。 */
  signToken(claims: AgentTokenClaims): string;
}

/** 通行证比会话限时多给一刻钟，最长一天（后端验的时候也卡这个上限）。 */
export function agentTokenTtlSeconds(sessionMinutes: number): number {
  return Math.min(sessionMinutes * 60 + 15 * 60, 24 * 60 * 60);
}

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

/** 引擎自己的活动：把条目排进合并队列（队列不在跑就顺手起一条）。工作流里发不了 signalWithStart，只能在活动里发。 */
async function enqueueMerge(input: Parameters<EngineActivities['enqueueMerge']>[0]): Promise<void> {
  const ctx = Context.current();
  const args: MergeQueueInput = { schemaVersion: 1, repo: input.item.repo, limits: input.limits };
  await ctx.client.workflow.signalWithStart(WORKFLOW_TYPES.mergeQueue, {
    workflowId: mergeQueueWorkflowId(input.item.repo),
    taskQueue: ctx.info.taskQueue,
    args: [args],
    signal: enqueueSignal,
    signalArgs: [input.item],
  });
}

export function createActivities(ports: EnginePorts, launch: SessionLaunchConfig): EngineActivities {
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
    } else if (name === 'startSession') {
      out[name] = timed(
        name,
        async (input, ctx) => {
          if (!launch.fleetApi) {
            // 会话里的 fleet 命令连不上后端就全废了：别起，挂起报警让人配 FLEET_AGENT_API_URL。
            throw new PortError('CONFIG_MISSING', '没配 fleet 命令的后端地址（FLEET_AGENT_API_URL）', {
              retryable: false,
            });
          }
          const start = input as StartSessionInput;
          const fleetToken = launch.signToken({
            taskId: start.taskId,
            ...(start.subtaskId ? { subtaskId: start.subtaskId } : {}),
            runId: start.runId,
            ttlSeconds: agentTokenTtlSeconds(start.sessionMinutes),
          });
          return port(
            { ...start, launch: { fleetApi: launch.fleetApi, fleetToken, pathPrepend: [launch.cliBinDir] } },
            ctx,
          );
        },
        record,
      );
    } else {
      out[name] = timed(name, port, record);
    }
  }
  out.enqueueMerge = timed('enqueueMerge', (input) => enqueueMerge(input as never), record);
  return out as unknown as EngineActivities;
}
