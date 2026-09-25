// 发给工作流的信号、拉起需求工作流、健康检查都经这里的一份 Temporal 连接。
// 调用方（agent.ts 的 wake、cockpit.ts 的 signalAndAudit）先把目标算成工作流编号——子任务编号直接拼
// subtaskWorkflowId，需求工作流编号要查库（requirementWorkflowIdForTask：getTask 拿 repoId/issueNumber，
// getRepo 拿 owner/name），查不到就明确抛 WorkflowTargetNotFoundError，不瞎拼——算完了才调
// WorkflowControl.signal(workflowId, signal)。
// 拉起需求工作流（issue-intake.ts 调 RequirementWorkflows.start）按 requirementWorkflowId 起，同一张 issue 只有一条在跑：
// 撞上在跑的回 already_running；连不上、超时、认不出的错一律抛出，不回 started（投递记成出错，对账重放再来）。
// 真客户端由 connectTemporal 用 @temporalio/client 的懒连接（Connection.lazy）装配：这一步不连网络，
// Temporal 没起来时后端照样能起，真正发信号或查健康才会报错。测试一律用假客户端（TemporalClientLike /
// EnginePollerSource 的最小形状），不碰真网络；connectTemporal 本身没有自动化测试覆盖（要连真 Temporal）。
// 拉起需求工作流另有一条对着 Temporal 测试服务端和真引擎工作流的：packages/engine/test/requirement-start.test.ts。
import {
  REQUIREMENT_WORKFLOW_TYPE,
  type RequirementStartInput,
  requirementWorkflowId,
} from '@fleet-dao/shared';
import { Client, Connection, WorkflowExecutionAlreadyStartedError } from '@temporalio/client';
import { PublicHealthError } from './health.ts';
import type { BoardStore } from './ports.ts';
import {
  type RequirementWorkflows,
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
    requirements: {
      async start() {
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

/** 发信号用得到的最小一块 Temporal 客户端形状；真客户端 `new Client(...)` 满足它（BaseClient.connection 就是 ConnectionLike）。 */
export interface TemporalClientLike {
  /**
   * 发信号的调用要挂在这份连接的 deadline 下：到点由连接本身取消调用（gRPC DEADLINE_EXCEEDED），不是本地空等——
   * 本地空等只是不再等回应，调用还在后端跑，回应可能晚到，调用方这时候如果重发就可能发两次。
   */
  connection: {
    withDeadline<R>(deadline: number | Date, fn: () => Promise<R>): Promise<R>;
  };
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
        await client.connection.withDeadline(Date.now() + timeoutMs, () =>
          client.workflow.getHandle(workflowId).signal(name, arg),
        );
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

/** gRPC 状态码：DEADLINE_EXCEEDED=4、UNAVAILABLE=14（抄自 @grpc/grpc-js 的 status，不为两个数多引一个依赖）。 */
const GRPC_UNAVAILABLE_CODES: readonly unknown[] = [4, 14];

/**
 * 连不上或超时：gRPC UNAVAILABLE / DEADLINE_EXCEEDED（真客户端 withDeadline 到点取消调用也报这个）。
 * 真客户端把 gRPC 错误包成 ServiceError（「Failed to start Workflow」这类，原错误挂在 cause 上），所以顺着 cause 往下找。
 */
function isUnavailable(err: unknown): boolean {
  for (let e: unknown = err, depth = 0; e instanceof Error && depth < 5; e = e.cause, depth++) {
    if (GRPC_UNAVAILABLE_CODES.includes((e as { code?: unknown }).code)) return true;
    if (/UNAVAILABLE|DEADLINE_EXCEEDED|秒没回应/.test(e.message)) return true;
  }
  return false;
}

// ---- 拉起需求工作流 ----

/** 起工作流用得到的最小一块客户端形状；真客户端 `new Client(...)` 满足它。 */
export interface WorkflowStarterLike {
  /** 同 TemporalClientLike.connection：起工作流的调用挂在连接的 deadline 下，到点由连接取消（DEADLINE_EXCEEDED）。 */
  connection: {
    withDeadline<R>(deadline: number | Date, fn: () => Promise<R>): Promise<R>;
  };
  workflow: {
    start(
      workflowType: string,
      options: {
        taskQueue: string;
        workflowId: string;
        args: [RequirementStartInput];
        workflowIdConflictPolicy: 'FAIL';
        workflowIdReusePolicy: 'ALLOW_DUPLICATE';
      },
    ): Promise<unknown>;
  };
}

/** 起一次工作流多久没回应就当连不上。 */
const DEFAULT_START_TIMEOUT_MS = 5_000;

/**
 * 拉起需求工作流的真实现。编号 requirementWorkflowId(repo, issueNumber)：
 * - 同一编号正在跑（服务端 ALREADY_EXISTS，客户端抛 WorkflowExecutionAlreadyStartedError）→ already_running，不起第二条；
 * - 上一条已经结束（需求重开）→ 再起一条（ALLOW_DUPLICATE）；
 * - 连不上、超时 → WorkflowUnavailableError；别的错原样抛。都不回 started。
 * 已知的窟窿：起工作流到点被取消、其实服务端已经起了，重放时会拿到 already_running——新开单无所谓（就是起来了），
 * 重开的会等这一条跑完再起一轮（多跑一轮）。客户端没公开 requestId，堵不上。
 */
export function createTemporalRequirementWorkflows(
  client: WorkflowStarterLike,
  taskQueue: string,
  timeoutMs = DEFAULT_START_TIMEOUT_MS,
): RequirementWorkflows {
  return {
    async start(input) {
      const workflowId = requirementWorkflowId(input.repo, input.issueNumber);
      try {
        await client.connection.withDeadline(Date.now() + timeoutMs, () =>
          client.workflow.start(REQUIREMENT_WORKFLOW_TYPE, {
            taskQueue,
            workflowId,
            args: [input],
            workflowIdConflictPolicy: 'FAIL',
            workflowIdReusePolicy: 'ALLOW_DUPLICATE',
          }),
        );
        return 'started';
      } catch (err) {
        if (isAlreadyStarted(err)) return 'already_running';
        if (isUnavailable(err)) {
          throw new WorkflowUnavailableError(`拉起需求工作流 ${workflowId}：Temporal 连不上或没回应`, err);
        }
        throw err;
      }
    },
  };
}

/** 同一编号的工作流正在跑：客户端把服务端的 ALREADY_EXISTS 转成 WorkflowExecutionAlreadyStartedError。只认这个类，不按名字猜。 */
function isAlreadyStarted(err: unknown): boolean {
  return err instanceof WorkflowExecutionAlreadyStartedError;
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
    if (problems.length > 0) throw new PublicHealthError('engine_offline', '引擎不在线', problems.join('；'));
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
  /** 引擎工人取活的任务队列：需求工作流起在这上面，checkEngine 也查它（配置 FLEET_TASK_QUEUE）。 */
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
        throw new PublicHealthError(
          'namespace_not_found',
          'Temporal 配置不对',
          `命名空间「${namespace}」不存在`,
        );
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
 * 真正发信号、起工作流、查健康才会报错。判断逻辑（命名空间查不到、poller 缺不缺、新不新鲜）在 createNamespaceCheck /
 * createEnginePollerCheck 里，用假客户端测过；这里只是把真客户端接进那两个函数，没有自动化测试覆盖
 * （测试规矩不许连真网络），改动后要在真机上核对。
 */
export function connectTemporal(config: TemporalConnectionConfig): TemporalConnection {
  const connection = Connection.lazy({ address: config.address });
  const client = new Client({ connection, namespace: config.namespace });
  return {
    control: createTemporalWorkflowControl(client),
    requirements: createTemporalRequirementWorkflows(client, config.taskQueue),
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
