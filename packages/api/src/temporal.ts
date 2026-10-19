// 发给工作流的信号、健康检查都经这里的一份 Temporal 连接。
// 调用方（cockpit.ts 的 signalAndAudit）先把目标算成工作流编号——任务工作流编号要查库（taskWorkflowIdForTask：
// getTask 拿 repoId/issueNumber，getRepo 拿 owner/name），查不到就明确抛 WorkflowTargetNotFoundError，不瞎拼——
// 算完了才调 WorkflowControl.signal(workflowId, signal)。编号和信号名都和引擎同一份（shared/workflow-ids.ts、
// shared/task-signals.ts）：改一边不改另一边，packages/api/test/signal-chain.test.ts 和
// packages/engine/test/task-signals.test.ts 会红。
// 真客户端由 connectTemporal 用 @temporalio/client 的懒连接（Connection.lazy）装配：这一步不连网络，
// Temporal 没起来时后端照样能起，真正发信号或查健康才会报错。测试一律用假客户端（TemporalClientLike /
// EnginePollerSource 的最小形状），不碰真网络；connectTemporal 本身没有自动化测试覆盖（要连真 Temporal）。

import { TASK_SIGNAL_NAMES, TASK_WORKFLOW_TYPE, taskWorkflowId } from '@fleet-dao/shared';
import {
  generationLife,
  readTaskGenerations,
  redoCanStop,
  redoTask,
  type SeenLife,
  signalTaskWorkflowId,
} from '@fleet-dao/shared/task-redo';
import {
  Client,
  Connection,
  WorkflowExecutionAlreadyStartedError,
  WorkflowNotFoundError,
} from '@temporalio/client';
import type { TaskRedoPort } from './deps.ts';
import { PublicHealthError } from './health.ts';
import type { BoardStore, LineBudgetRemeasureReceiptView, LineBudgetRemeasureResponse } from './ports.ts';
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

/** 这个任务的任务工作流编号（引擎拉单起的那一条，task:<仓>#<号>）：查库拼。任务或它所在的仓不在库里就明确抛错，不瞎拼。 */
export async function taskWorkflowIdForTask(
  store: Pick<BoardStore, 'getTask' | 'getRepo'>,
  taskId: string,
): Promise<string> {
  const task = await store.getTask(taskId);
  if (!task) throw new WorkflowTargetNotFoundError(`任务 ${taskId} 不在库里，拼不出任务工作流编号`);
  const repo = await store.getRepo(task.repoId);
  if (!repo) {
    throw new WorkflowTargetNotFoundError(
      `任务 ${taskId} 所在的仓 ${task.repoId} 不在库里，拼不出任务工作流编号`,
    );
  }
  return taskWorkflowId(repo, task.issueNumber);
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
    getHandle(workflowId: string, runId?: string): { signal(name: string, arg: unknown): Promise<void> };
  };
}

interface TemporalRouteWakeClientLike {
  connection: TemporalClientLike['connection'];
  workflow: {
    list(options: { query: string }): AsyncIterable<{ workflowId: string }>;
    getHandle(workflowId: string, runId?: string): { signal(name: string, arg: unknown): Promise<void> };
  };
}

/** 发一次信号多久没回应就当连不上（真客户端的 UNAVAILABLE / DEADLINE_EXCEEDED 也归到这一类）。 */
const DEFAULT_SIGNAL_TIMEOUT_MS = 5_000;

export function createTemporalWorkflowControl(
  client: TemporalClientLike,
  timeoutMs = DEFAULT_SIGNAL_TIMEOUT_MS,
): WorkflowControl {
  return {
    async signal(workflowId, signal, runId) {
      const { name, ...arg } = signal;
      try {
        await client.connection.withDeadline(Date.now() + timeoutMs, () =>
          client.workflow.getHandle(workflowId, runId).signal(name, arg),
        );
      } catch (err) {
        if (isGone(err)) throw new WorkflowGoneError(workflowId, err);
        if (isUnavailable(err)) throw new WorkflowUnavailableError('Temporal 连不上或没回应', err);
        throw err;
      }
    },
  };
}

/** 修复核验读具体 execution。通过连接 deadline，读失败不猜 run。 */
export function createTaskWorkflowExecution(client: {
  connection: TemporalClientLike['connection'];
  workflow: {
    getHandle(workflowId: string): {
      describe(): Promise<{ workflowId: string; runId: string; status: { name: string } }>;
    };
  };
}): NonNullable<WorkflowControl['taskWorkflowExecution']> {
  return async (workflowId) => {
    const execution = await client.connection.withDeadline(Date.now() + DEFAULT_SIGNAL_TIMEOUT_MS, () =>
      client.workflow.getHandle(workflowId).describe(),
    );
    return {
      workflowId: execution.workflowId,
      runId: execution.runId,
      running: execution.status.name === 'RUNNING',
    };
  };
}

/** 重评 Update 名和 taskStatus 里的停点字段，与引擎 task-contract.ts 同一份（api 的 src 不许引 engine；test 核对）。 */
export const REMEASURE_UPDATE_NAME = 'taskRemeasureLineBudget';
/** 一次重评最多等多久：工作流里 240 秒限时，再留回执余量。 */
const REMEASURE_DEADLINE_MS = 300_000;

interface ParkIdentityWire {
  version: 1;
  runId: string;
  parks: number;
  generation: number;
  continued: number;
  prNumber: number | null;
  head: string;
  rawAddedLines: number;
  chargeableAddedLines: number;
  budget: number;
}

export const parkLabel = (id: Pick<ParkIdentityWire, 'parks' | 'generation' | 'continued'>): string =>
  `${id.parks}.${id.generation}.${id.continued}`;

interface RemeasureClientLike {
  connection: TemporalClientLike['connection'];
  workflow: {
    getHandle(
      workflowId: string,
      runId?: string,
    ): {
      query(name: string): Promise<unknown>;
      executeUpdate(name: string, options: { args: unknown[] }): Promise<unknown>;
    };
  };
}

/**
 * 体量关口重评（#3249）：先现读 taskStatus 的 lineBudgetPark.identity（旧 worker 没有这个字段＝不支持，
 * 不凭停下原因的自由文本猜），再发 taskRemeasureLineBudget Update。身份对不上在本地就拒，不发 Update；
 * 真正的停点比对仍由工作流自己做一遍。
 */
export function createTemporalLineBudgetRemeasure(
  client: RemeasureClientLike,
): NonNullable<WorkflowControl['remeasureLineBudget']> {
  return async (request): Promise<LineBudgetRemeasureResponse> => {
    const handle = client.workflow.getHandle(request.workflowId, request.runId);
    let status: unknown;
    try {
      status = await client.connection.withDeadline(Date.now() + DEFAULT_SIGNAL_TIMEOUT_MS, () =>
        handle.query('taskStatus'),
      );
    } catch (err) {
      if (isGone(err)) throw new WorkflowGoneError(request.workflowId, err);
      if (isUnavailable(err)) throw new WorkflowUnavailableError('Temporal 连不上或没回应', err);
      throw err;
    }
    const field = (status as { lineBudgetPark?: { version?: unknown; identity?: ParkIdentityWire | null } })
      ?.lineBudgetPark;
    if (!field || field.version !== 1) {
      return {
        ok: false,
        reason: 'unsupported',
        detail: '这条工作流的 worker 不报体量停点身份（旧版本），不能重评',
      };
    }
    const id = field.identity;
    if (!id) {
      return {
        ok: false,
        reason: 'stale',
        detail: '工作流此刻不在可重评的体量停点（运行中、已继续、已放行、别的停法或正在重评）',
      };
    }
    const current = {
      head: id.head,
      rawAddedLines: id.rawAddedLines,
      chargeableAddedLines: id.chargeableAddedLines,
      budget: id.budget,
    };
    const park = parkLabel(id);
    if (id.runId !== request.runId)
      return { ok: false, reason: 'stale', detail: '停点属于另一个 run', park, current };
    if (request.park !== undefined && request.park !== park)
      return {
        ok: false,
        reason: 'stale',
        detail: `停点编号已变（现在是 ${park}，请求的是 ${request.park}）`,
        park,
        current,
      };
    if (id.head !== request.head)
      return { ok: false, reason: 'changed', detail: '停点上的交付头与请求的 head 不同', park, current };
    let result: unknown;
    try {
      result = await client.connection.withDeadline(Date.now() + REMEASURE_DEADLINE_MS, () =>
        handle.executeUpdate(REMEASURE_UPDATE_NAME, {
          args: [
            {
              version: 1,
              mode: request.mode,
              identity: id,
              repo: request.repo,
              taskId: request.taskId,
              workflowId: request.workflowId,
              head: request.head,
              base: request.base,
              by: request.by,
            },
          ],
        }),
      );
    } catch (err) {
      if (isGone(err)) throw new WorkflowGoneError(request.workflowId, err);
      if (isUnavailable(err)) throw new WorkflowUnavailableError('Temporal 连不上或没回应', err);
      throw err;
    }
    const r = result as {
      outcome?: string;
      receipt?: LineBudgetRemeasureReceiptView;
      reason?: string;
      detail?: string;
    };
    if (
      (r.outcome === 'eligible' || r.outcome === 'resumed' || r.outcome === 'already_resumed') &&
      r.receipt
    ) {
      const g = r.receipt;
      return {
        ok: true,
        outcome: r.outcome,
        park,
        receipt: {
          head: g.head,
          base: g.base,
          rawAddedLines: g.rawAddedLines,
          verifiedGeneratedLines: g.verifiedGeneratedLines,
          chargeableAddedLines: g.chargeableAddedLines,
          budget: g.budget,
          reason: g.reason,
        },
      };
    }
    if (r.outcome === 'refused') {
      return { ok: false, reason: String(r.reason), detail: String(r.detail ?? ''), park, current };
    }
    // 回执认不出：不当成功
    return { ok: false, reason: 'unknown', detail: '工作流的回执认不出，当作没放行', park, current };
  };
}

/** 配置改完后叫醒所有在跑的任务工作流；工作流自己判断当前是否正在等路由。 */
export function createTemporalRouteWake(
  client: TemporalRouteWakeClientLike,
  timeoutMs = DEFAULT_SIGNAL_TIMEOUT_MS,
): (reason: string) => Promise<void> {
  return async (reason) => {
    const workflowIds: string[] = [];
    for await (const info of client.workflow.list({
      query: `WorkflowType = '${TASK_WORKFLOW_TYPE}' AND ExecutionStatus = 'Running'`,
    })) {
      workflowIds.push(info.workflowId);
    }
    const outcomes = await Promise.allSettled(
      workflowIds.map(async (workflowId) => {
        try {
          await client.connection.withDeadline(Date.now() + timeoutMs, () =>
            client.workflow.getHandle(workflowId).signal(TASK_SIGNAL_NAMES.routeWake, {
              by: '驾驶舱路由配置',
              reason,
            }),
          );
        } catch (error) {
          if (isGone(error)) return;
          throw error;
        }
      }),
    );
    const failed = outcomes
      .map((outcome, index) =>
        outcome.status === 'rejected' ? `${workflowIds[index]}：${String(outcome.reason)}` : null,
      )
      .filter((failure): failure is string => failure !== null);
    if (failed.length > 0) {
      throw new Error(
        `有 ${failed.length} 个任务工作流没收到 taskRouteWake：${failed.slice(0, 3).join('；')}`,
      );
    }
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

// ---- 引擎在不在：查任务队列上 workflow、activity 两类 poller ----

/** FLEET_TASK_QUEUE 上 workflow、activity 两类都要有 poller、且最近一次拉活在这么久以内，才算引擎在线。 */
const DEFAULT_POLLER_FRESH_MS = 2 * 60 * 1000;

/** 这台机器按设置没开引擎（config.ts 的 engineEnabled）时，/healthz 的 engine 项报「未接」带的说明；公网看得到，只写中性的话。 */
export const ENGINE_OFF = '这台机器按设置没开引擎';

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
 * 真正发信号、查健康才会报错。判断逻辑（命名空间查不到、poller 缺不缺、新不新鲜）在 createNamespaceCheck /
 * createEnginePollerCheck 里，用假客户端测过；这里只是把真客户端接进那两个函数，没有自动化测试覆盖
 * （测试规矩不许连真网络），改动后要在真机上核对。
 */
async function seenLife(client: Client, workflowId: string): Promise<SeenLife> {
  try {
    const described = await client.connection.withDeadline(Date.now() + DEFAULT_SIGNAL_TIMEOUT_MS, () =>
      client.workflow.getHandle(workflowId).describe(),
    );
    return generationLife(described.status.name) === 'running' ? 'running' : 'closed';
  } catch (err) {
    if (err instanceof WorkflowNotFoundError) return 'missing';
    throw err;
  }
}

/** 问任务工作流停在哪。问不到、看不清当还在跑：重做不去叫停一台看不清的。已经结束的当 parked，后面的叫停会发现它不在了。 */
async function redoPosture(client: Client, workflowId: string): Promise<'parked' | 'running'> {
  try {
    const status = await client.connection.withDeadline(Date.now() + DEFAULT_SIGNAL_TIMEOUT_MS, () =>
      client.workflow.getHandle(workflowId).query('taskStatus'),
    );
    return redoCanStop((status as { phase?: unknown }).phase) ? 'parked' : 'running';
  } catch (err) {
    if (isGone(err)) return 'parked';
    return 'running';
  }
}

/**
 * 停在等人的上一代：发放弃，等到工作流终止。没停下来就抛错，重做不另起。
 * 收树正常要几秒到几十秒（git 档一次最多 5 分钟）。这里等 60 秒，留在驾驶舱请求的 90 秒限时里；
 * 没停完再点一次会看到 phase=abandoned，接着等，不会当成还在跑拒绝。
 */
const ABANDON_WAIT_MS = 60_000;

async function abandonParkedWorkflow(client: Client, workflowId: string): Promise<void> {
  const handle = client.workflow.getHandle(workflowId);
  try {
    await client.connection.withDeadline(Date.now() + DEFAULT_SIGNAL_TIMEOUT_MS, () =>
      handle.signal(TASK_SIGNAL_NAMES.abandon, {
        by: 'redo',
        reason: '重做前先叫停停住的上一代',
      }),
    );
  } catch (err) {
    if (!isGone(err)) throw err;
  }
  const deadline = Date.now() + ABANDON_WAIT_MS;
  while (Date.now() < deadline) {
    const life = await seenLife(client, workflowId);
    if (life !== 'running') return;
    await new Promise((resolve) => setTimeout(resolve, 200));
  }
  throw new Error(`叫停 ${workflowId} 后还没停，没有另起`);
}

/** 真 Temporal 上的重做：顺着代数 describe。都终止，或还在跑但只是停在 parked / 正在收尾放弃（先叫停再等到终止），才用新编号起下一代（REJECT_DUPLICATE，不盖旧执行）。真在跑拒绝。 */
export function createTemporalTaskRedo(client: Client, taskQueue: string): TaskRedoPort {
  return {
    async redo(input) {
      const repo = { owner: input.repo.owner, name: input.repo.name };
      const read = await readTaskGenerations(repo, input.issueNumber, async (workflowId) => {
        try {
          const life = await seenLife(client, workflowId);
          if (life === 'missing') return { life: 'missing' };
          return { life: life === 'running' ? 'running' : 'terminated', record: { workflowId } };
        } catch {
          return { life: 'unknown' };
        }
      });
      if (!read.ok) return read;
      const generations = read.generations;
      return redoTask({
        list: async () => generations,
        posture: (workflowId) => redoPosture(client, workflowId),
        abandonParked: (workflowId) => abandonParkedWorkflow(client, workflowId),
        start: async (workflowId) => {
          try {
            await client.connection.withDeadline(Date.now() + DEFAULT_SIGNAL_TIMEOUT_MS, () =>
              client.workflow.start(TASK_WORKFLOW_TYPE, {
                taskQueue,
                workflowId,
                args: [
                  {
                    schemaVersion: 1,
                    taskId: input.taskId,
                    repo: {
                      id: input.repo.id,
                      owner: input.repo.owner,
                      name: input.repo.name,
                      defaultBranch: input.repo.defaultBranch,
                      testCommand: input.repo.testCommand,
                    },
                    issueNumber: input.issueNumber,
                    title: input.title,
                  },
                ],
                workflowIdConflictPolicy: 'FAIL',
                workflowIdReusePolicy: 'REJECT_DUPLICATE',
              }),
            );
            return 'started';
          } catch (err) {
            if (err instanceof WorkflowExecutionAlreadyStartedError) return 'already_exists';
            throw err;
          }
        },
      });
    },
  };
}

export function connectTemporal(
  config: TemporalConnectionConfig,
): TemporalConnection & { taskRedo: TaskRedoPort; routeWake: (reason: string) => Promise<void> } {
  const connection = Connection.lazy({ address: config.address });
  const client = new Client({ connection, namespace: config.namespace });
  const control = createTemporalWorkflowControl(client);
  return {
    control: {
      ...control,
      taskWorkflowExecution: createTaskWorkflowExecution(client),
      remeasureLineBudget: createTemporalLineBudgetRemeasure(client),
      runningTaskWorkflow(repo, issueNumber) {
        return signalTaskWorkflowId(repo, issueNumber, (id) => seenLife(client, id)).catch((err: unknown) => {
          if (err instanceof WorkflowUnavailableError) throw err;
          if (isUnavailable(err)) throw new WorkflowUnavailableError('Temporal 连不上或没回应', err);
          throw new WorkflowUnavailableError('查在跑的任务工作流没成', err);
        });
      },
    },
    taskRedo: createTemporalTaskRedo(client, config.taskQueue),
    routeWake: createTemporalRouteWake(client),
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
