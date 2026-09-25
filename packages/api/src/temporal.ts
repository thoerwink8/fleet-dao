// 发给工作流的信号、健康检查都经这里的一份 Temporal 连接。
// 调用方（agent.ts 的 wake、cockpit.ts 的 signalAndAudit）先把目标算成工作流编号——子任务编号直接拼
// subtaskWorkflowId，需求工作流编号要查库（requirementWorkflowIdForTask：getTask 拿 repoId/issueNumber，
// getRepo 拿 owner/name），查不到就明确抛 WorkflowTargetNotFoundError，不瞎拼——算完了才调
// WorkflowControl.signal(workflowId, signal)。
// 真客户端由 connectTemporal 用 @temporalio/client 的懒连接（Connection.lazy）装配：这一步不连网络，
// Temporal 没起来时后端照样能起，真正发信号或查健康才会报错。测试一律用假客户端（TemporalClientLike /
// EnginePollerSource 的最小形状），不碰真网络；connectTemporal 本身没有自动化测试覆盖（要连真 Temporal）。
import { requirementWorkflowId } from '@fleet-dao/shared';
import { Client, Connection } from '@temporalio/client';
import { PublicHealthError } from './health.ts';
import type { BoardStore } from './ports.ts';
import {
  type TemporalConnection,
  type WorkflowControl,
  WorkflowGoneError,
  WorkflowTargetNotFoundError,
  WorkflowUnavailableError,
} from './ports.ts';

/** 还没接上 Temporal：发信号一律抛 WorkflowUnavailableError，健康检查报红。不装作接上了。 */
export function notConnectedTemporal(): TemporalConnection {
  const why = 'Temporal 客户端还没接上';
  const unavailable = async (): Promise<never> => {
    throw new PublicHealthError('not_connected', why);
  };
  return {
    control: {
      async signal() {
        throw new WorkflowUnavailableError(why);
      },
    },
    check: unavailable,
    checkEngine: unavailable,
    async close() {},
  };
}

/** 这个任务的需求工作流编号：查库拼。任务或它所在的仓不在库里就明确抛错，不瞎拼。 */
export async function requirementWorkflowIdForTask(
  store: Pick<BoardStore, 'getTask' | 'getRepo'>,
  taskId: string,
): Promise<string> {
  const task = await store.getTask(taskId);
  if (!task) throw new WorkflowTargetNotFoundError(`任务 ${taskId} 不在库里，拼不出需求工作流编号`);
  const repo = await store.getRepo(task.repoId);
  if (!repo) {
    throw new WorkflowTargetNotFoundError(
      `任务 ${taskId} 所在的仓 ${task.repoId} 不在库里，拼不出需求工作流编号`,
    );
  }
  return requirementWorkflowId(repo, task.issueNumber);
}

/** 发信号用得到的最小一块 Temporal 客户端形状；真客户端 `new Client(...)` 满足它。 */
export interface TemporalClientLike {
  workflow: {
    getHandle(workflowId: string): { signal(name: string, arg: unknown): Promise<void> };
  };
}

/** 发一次信号多久没回应就当连不上（真客户端的 UNAVAILABLE / DEADLINE_EXCEEDED 也归到这一类）。 */
const DEFAULT_SIGNAL_TIMEOUT_MS = 5_000;

export function createTemporalWorkflowControl(
  client: TemporalClientLike,
  timeoutMs = DEFAULT_SIGNAL_TIMEOUT_MS,
): WorkflowControl {
  return {
    async signal(workflowId, signal) {
      const { name, ...arg } = signal;
      try {
        await withTimeout(client.workflow.getHandle(workflowId).signal(name, arg), timeoutMs);
      } catch (err) {
        if (isGone(err)) throw new WorkflowGoneError(workflowId, err);
        if (isUnavailable(err)) throw new WorkflowUnavailableError('Temporal 连不上或没回应', err);
        throw err;
      }
    },
  };
}

/** 工作流不存在或已经结束：Temporal 客户端抛 WorkflowNotFoundError（服务端 NOT_FOUND）。 */
function isGone(err: unknown): boolean {
  return (
    err instanceof Error &&
    (err.name === 'WorkflowNotFoundError' || /workflow execution already completed/i.test(err.message))
  );
}

/** 连不上或超时：gRPC UNAVAILABLE / DEADLINE_EXCEEDED（真客户端），或本地这层加的超时。 */
function isUnavailable(err: unknown): boolean {
  return err instanceof Error && /UNAVAILABLE|DEADLINE_EXCEEDED|秒没回应/.test(err.message);
}

function withTimeout<T>(p: Promise<T>, ms: number): Promise<T> {
  return Promise.race([
    p,
    new Promise<T>((_, reject) => {
      const timer = setTimeout(() => reject(new Error(`${ms / 1000} 秒没回应`)), ms);
      timer.unref();
    }),
  ]);
}

// ---- 引擎在不在：查任务队列上 workflow、activity 两类 poller ----

/** FLEET_TASK_QUEUE 上 workflow、activity 两类都要有 poller、且最近一次拉活在这么久以内，才算引擎在线。 */
const DEFAULT_POLLER_FRESH_MS = 2 * 60 * 1000;

export interface PollerSnapshot {
  /** 最近一次拉活的时刻；查得到 poller 但没带这个字段时为 null。 */
  lastAccessAt: Date | null;
}

export interface EnginePollerSource {
  /** 查一类（workflow / activity）的 poller 列表；查不到就抛错（原样抛，参照 pg-store.ts 的 probeDb）。 */
  listPollers(kind: 'workflow' | 'activity'): Promise<PollerSnapshot[]>;
}

/** 组一个「引擎在线」的检查函数：两类 poller 都要有、都够新鲜才算过；缺哪类、哪类太旧都写进错误里。 */
export function createEnginePollerCheck(
  source: EnginePollerSource,
  now: () => Date,
  freshMs = DEFAULT_POLLER_FRESH_MS,
): () => Promise<void> {
  return async () => {
    const [workflow, activity] = await Promise.all([
      source.listPollers('workflow'),
      source.listPollers('activity'),
    ]);
    const problems = [
      ...pollerProblems('workflow', workflow, now(), freshMs),
      ...pollerProblems('activity', activity, now(), freshMs),
    ];
    if (problems.length > 0) throw new PublicHealthError('engine_offline', problems.join('；'));
  };
}

function pollerProblems(
  kind: 'workflow' | 'activity',
  pollers: readonly PollerSnapshot[],
  now: Date,
  freshMs: number,
): string[] {
  if (pollers.length === 0) return [`${kind} 任务队列上没有 poller`];
  const latest = pollers.reduce<Date | null>(
    (acc, p) => (p.lastAccessAt && (!acc || p.lastAccessAt > acc) ? p.lastAccessAt : acc),
    null,
  );
  if (!latest) return [`${kind} poller 没有拉活时刻`];
  const ageMs = now.getTime() - latest.getTime();
  if (ageMs > freshMs) {
    return [
      `${kind} poller 最近一次拉活是 ${Math.round(ageMs / 60_000)} 分钟前，超过 ${Math.round(freshMs / 60_000)} 分钟`,
    ];
  }
  return [];
}

// ---- 真客户端：main.ts 用它装配，测试不用（会连真网络），一律用上面这几个假客户端接口 ----

export interface TemporalConnectionConfig {
  /** Temporal 服务地址，hostname:port（配置 TEMPORAL_ADDRESS）。 */
  address: string;
  /** Temporal 命名空间（配置 TEMPORAL_NAMESPACE）。 */
  namespace: string;
  /** 引擎工人取活的任务队列，只给 checkEngine 用（配置 FLEET_TASK_QUEUE）。 */
  taskQueue: string;
}

/** 健康检查单项的限时（health.ts 的 CHECK_TIMEOUT_MS 也是 3 秒；这里显式设一遍，不完全依赖外层race）。 */
const HEALTH_CHECK_TIMEOUT_MS = 3_000;

/** proto 的 TaskQueueType：WORKFLOW=1、ACTIVITY=2（不额外引 @temporalio/proto 这个内部依赖，数值抄自
 * temporal.api.enums.v1.TaskQueueType）。 */
const TASK_QUEUE_TYPE = { workflow: 1, activity: 2 } as const;

interface ProtoTimestampLike {
  seconds?: number | { toNumber(): number } | null;
  nanos?: number | null;
}

function protoTimestampToDate(ts: ProtoTimestampLike | null | undefined): Date | null {
  if (!ts || ts.seconds === undefined || ts.seconds === null) return null;
  const seconds = typeof ts.seconds === 'number' ? ts.seconds : ts.seconds.toNumber();
  if (!Number.isFinite(seconds)) return null;
  return new Date(seconds * 1000 + Math.floor((ts.nanos ?? 0) / 1e6));
}

/** 命名空间查不到：Temporal 服务端报 gRPC NOT_FOUND（状态码 5）。 */
function isNamespaceNotFound(err: unknown): boolean {
  return typeof err === 'object' && err !== null && (err as { code?: unknown }).code === 5;
}

export interface NamespaceCheckClient {
  /** 查一次命名空间；查不到、连不上、超时都直接原样抛错，由 createNamespaceCheck 分类。 */
  describeNamespace(namespace: string): Promise<void>;
}

/** 命名空间查不到归成一条安全的 PublicHealthError；别的错误（连不上、超时）原样抛，交给 health.ts 的通用兜底。 */
export function createNamespaceCheck(client: NamespaceCheckClient, namespace: string): () => Promise<void> {
  return async () => {
    try {
      await client.describeNamespace(namespace);
    } catch (err) {
      if (isNamespaceNotFound(err)) {
        throw new PublicHealthError('namespace_not_found', `Temporal 命名空间「${namespace}」不存在`);
      }
      throw err;
    }
  };
}

function enginePollerSourceFromClient(client: Client, config: TemporalConnectionConfig): EnginePollerSource {
  return {
    async listPollers(kind) {
      const res = await client.connection.withDeadline(Date.now() + HEALTH_CHECK_TIMEOUT_MS, () =>
        client.connection.workflowService.describeTaskQueue({
          namespace: config.namespace,
          taskQueue: { name: config.taskQueue },
          taskQueueType: TASK_QUEUE_TYPE[kind],
        }),
      );
      return (res.pollers ?? []).map((p) => ({ lastAccessAt: protoTimestampToDate(p.lastAccessTime) }));
    },
  };
}

/**
 * 真接 Temporal：懒连接（Connection.lazy），这一步不连网络、不校验能不能连上，后端照样能起；
 * 真正发信号、查健康才会报错。判断逻辑（命名空间查不到、poller 缺不缺、新不新鲜）在 createNamespaceCheck /
 * createEnginePollerCheck 里，用假客户端测过；这里只是把真客户端接进那两个函数，没有自动化测试覆盖
 * （测试规矩不许连真网络），改动后要在真机上核对。
 */
export function connectTemporal(config: TemporalConnectionConfig): TemporalConnection {
  const connection = Connection.lazy({ address: config.address });
  const client = new Client({ connection, namespace: config.namespace });
  return {
    control: createTemporalWorkflowControl(client),
    check: createNamespaceCheck(
      {
        async describeNamespace(namespace) {
          await connection.withDeadline(Date.now() + HEALTH_CHECK_TIMEOUT_MS, () =>
            connection.workflowService.describeNamespace({ namespace }),
          );
        },
      },
      config.namespace,
    ),
    checkEngine: createEnginePollerCheck(enginePollerSourceFromClient(client, config), () => new Date()),
    async close() {
      await connection.close();
    },
  };
}
