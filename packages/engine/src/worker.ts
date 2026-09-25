// worker：连 Temporal、打包工作流、挂上活动。地址、命名空间、任务队列等从本机配置（环境变量）读，不写死进代码。

import { fileURLToPath } from 'node:url';
import { signAgentToken } from '@fleet-dao/api/agent-token';
import { Client, Connection } from '@temporalio/client';
import { bundleWorkflowCode, NativeConnection, Worker, type WorkflowBundle } from '@temporalio/worker';
import { type AgentTokenClaims, createActivities, type EngineJobs } from './activities.ts';
import type { EngineActivities } from './activity-options.ts';
import { createDecide, type Decide, type FailureTriage } from './decisions/index.ts';
import { createFakeWorld } from './fakes.ts';
import { ensureEngineSchedules } from './jobs/schedules.ts';
import type { EnginePorts } from './ports.ts';

export interface EngineConfig {
  address: string;
  namespace: string;
  taskQueue: string;
  /** 停机时给在途活动多久收尾。 */
  shutdownGraceSeconds: number;
  /** 同时执行的活动数；会话看守和等 CI 大多在等，真正的并发上限在选路由（账号池空位）那里。 */
  maxConcurrentActivities: number;
  /** fleet 命令的后端地址，会话环境里的 FLEET_API（驾驶舱后端 fleet 命令接口的监听地址）。没配就起不了会话。 */
  agentApiUrl: string | null;
  /** 装着 fleet 命令的目录，放到会话 PATH 最前面。 */
  cliBinDir: string;
}

/** 任务书定的默认：法国本机的 Temporal、命名空间 fleet。 */
export const DEFAULT_ADDRESS = '127.0.0.1:7243';
export const DEFAULT_NAMESPACE = 'fleet';
export const DEFAULT_TASK_QUEUE = 'fleet';
export const DEFAULT_CLI_BIN_DIR = fileURLToPath(new URL('../../cli/bin', import.meta.url));

function positiveInt(raw: string | undefined, fallback: number): number {
  const n = Number(raw);
  return Number.isInteger(n) && n > 0 ? n : fallback;
}

export function configFromEnv(env: Record<string, string | undefined> = process.env): EngineConfig {
  return {
    address: env.TEMPORAL_ADDRESS?.trim() || DEFAULT_ADDRESS,
    namespace: env.TEMPORAL_NAMESPACE?.trim() || DEFAULT_NAMESPACE,
    taskQueue: env.FLEET_TASK_QUEUE?.trim() || DEFAULT_TASK_QUEUE,
    shutdownGraceSeconds: positiveInt(env.FLEET_SHUTDOWN_GRACE_SECONDS, 30),
    maxConcurrentActivities: positiveInt(env.FLEET_MAX_ACTIVITIES, 40),
    agentApiUrl: env.FLEET_AGENT_API_URL?.trim() || null,
    cliBinDir: env.FLEET_CLI_BIN?.trim() || DEFAULT_CLI_BIN_DIR,
  };
}

/**
 * fleet 通行证用驾驶舱后端的 signAgentToken 签（后端用同一把钥匙验）。钥匙从本机配置 FLEET_AGENT_TOKEN_SECRET 读，没配返回 null。
 */
export function agentTokenSignerFromEnv(
  env: Record<string, string | undefined> = process.env,
): ((claims: AgentTokenClaims) => string) | null {
  const secret = env.FLEET_AGENT_TOKEN_SECRET;
  if (!secret) return null;
  return (claims) =>
    signAgentToken(secret, {
      taskId: claims.taskId,
      subtaskId: claims.subtaskId,
      runId: claims.runId,
      ttlSeconds: claims.ttlSeconds,
    });
}

export const WORKFLOWS_PATH = fileURLToPath(new URL('./workflows/index.ts', import.meta.url));

type BundleLogger = Parameters<typeof bundleWorkflowCode>[0]['logger'];

export function bundleEngineWorkflows(logger?: BundleLogger): Promise<WorkflowBundle> {
  return bundleWorkflowCode({ workflowsPath: WORKFLOWS_PATH, ...(logger ? { logger } : {}) });
}

export interface CreateEngineWorkerOptions {
  config: EngineConfig;
  ports: EnginePorts;
  /** 签 fleet 通行证：接驾驶舱后端的 signAgentToken（`@fleet-dao/api/agent-token`，密钥 FLEET_AGENT_TOKEN_SECRET）。 */
  signAgentToken: (claims: AgentTokenClaims) => string;
  /**
   * 接活之前先收掉上一轮留下的会话（fleet-agent-scope list 再逐个 stop），返回收了几个。
   * 引擎被强杀时会话留在自己的 scope 里；它们的输出管道断了、接不上，工作流会按 SESSION_LOST 续会话重起。
   */
  reapOrphanSessions?: () => Promise<number>;
  /** 定时任务要的东西（真端口才有）；不给，定时任务的活动明确报 JOB_NOT_CONFIGURED。 */
  jobs?: EngineJobs;
  /** 不给就按 config.address 自己连。 */
  connection?: NativeConnection;
  /** 不给就现打包。 */
  workflowBundle?: WorkflowBundle;
  /** 失败分流；不给就是规则表 + 兜底梯（failure/classify.ts）。 */
  triage?: FailureTriage;
  /** 整个换掉判断入口（演练「判断出错」用）；不给就是 createDecide({ triage })。 */
  decide?: Decide;
  /** 包一层活动（演练用：让某个活动卡在半路，看叫停、换工人时的先后）；不给就是原样。 */
  wrapActivities?: (activities: EngineActivities) => EngineActivities;
  /** 缓存几条工作流；0 = 不缓存、每个工作流任务都从历史重放（换工人、换代码演练用）。 */
  maxCachedWorkflows?: number;
  log?: (message: string) => void;
}

export async function createEngineWorker(options: CreateEngineWorkerOptions): Promise<Worker> {
  const { config } = options;
  if (options.reapOrphanSessions) {
    const reaped = await options.reapOrphanSessions();
    options.log?.(`收掉上一轮留下的会话 ${reaped} 个`);
  }
  const connection = options.connection ?? (await NativeConnection.connect({ address: config.address }));
  const activities = createActivities(
    options.ports,
    {
      fleetApi: config.agentApiUrl ?? '',
      cliBinDir: config.cliBinDir,
      signToken: options.signAgentToken,
    },
    options.jobs,
  );
  return Worker.create({
    connection,
    namespace: config.namespace,
    taskQueue: config.taskQueue,
    workflowBundle: options.workflowBundle ?? (await bundleEngineWorkflows()),
    activities: {
      ...(options.wrapActivities ? options.wrapActivities(activities) : activities),
      decide: options.decide ?? createDecide(options.triage ? { triage: options.triage } : {}),
    },
    shutdownGraceTime: `${config.shutdownGraceSeconds} seconds`,
    maxConcurrentActivityTaskExecutions: config.maxConcurrentActivities,
    ...(options.maxCachedWorkflows === undefined ? {} : { maxCachedWorkflows: options.maxCachedWorkflows }),
  });
}

/** 端口用哪一套：real = 真仓、真会话、真 GitHub；fake = 假实现（联调、演练，不碰真东西）。没配、配错都不起。 */
export type PortsMode = 'real' | 'fake';

export function portsModeFromEnv(env: Record<string, string | undefined>): PortsMode {
  const mode = env.FLEET_ENGINE_PORTS?.trim();
  if (mode === 'real' || mode === 'fake') return mode;
  throw new Error(
    `FLEET_ENGINE_PORTS 要写 real（真仓、真会话、真 GitHub）或 fake（假实现，不碰真东西）：现在是「${mode ?? ''}」`,
  );
}

/** 进程入口用：按环境变量起一个 worker，收到 SIGINT/SIGTERM 优雅停机。 */
export async function runEngineWorker(env: Record<string, string | undefined> = process.env): Promise<void> {
  const config = configFromEnv(env);
  const mode = portsModeFromEnv(env);
  let ports: EnginePorts;
  let reapOrphanSessions: (() => Promise<number>) | undefined;
  let jobs: EngineJobs | undefined;
  let registerJobs: (() => Promise<void>) | undefined;
  let close: () => Promise<void> = async () => {};
  let signAgentToken = agentTokenSignerFromEnv(env);
  if (mode === 'real') {
    // 真会话里的 fleet 命令要连后端、要通行证：缺一样就不起（起了也只会一个个会话起不来）。
    const missing = [
      ...(config.agentApiUrl ? [] : ['FLEET_AGENT_API_URL']),
      ...(signAgentToken ? [] : ['FLEET_AGENT_TOKEN_SECRET']),
    ];
    if (missing.length > 0) throw new Error(`真端口起不来，本机配置缺：${missing.join('、')}`);
    const { realPortsFromEnv } = await import('./real/index.ts');
    const real = realPortsFromEnv(env);
    ports = real.ports;
    reapOrphanSessions = real.reapOrphanSessions;
    jobs = real.jobs;
    registerJobs = real.registerJobs;
    close = real.close;
  } else {
    ports = createFakeWorld().ports;
    signAgentToken ??= (claims) => `fake-token.${claims.runId}`;
  }
  const connection = await NativeConnection.connect({ address: config.address });
  let clientConnection: Connection | undefined;
  try {
    if (registerJobs) {
      // 定时任务只由真端口的工人建：假端口不碰库和 GitHub，建了也只会一轮轮报 JOB_NOT_CONFIGURED。
      // 先登记再建：一次都没跑过的也在看门狗的名单上。任一步失败就不起，别让对账悄悄没人跑。
      await registerJobs();
      clientConnection = await Connection.connect({ address: config.address });
      const client = new Client({ connection: clientConnection, namespace: config.namespace });
      const ensured = await ensureEngineSchedules(client, config.taskQueue);
      console.info(`定时任务已对齐：${JSON.stringify(ensured)}`);
    }
    const worker = await createEngineWorker({
      // 假实现不真起会话，fleet 命令的后端地址用不上。
      config: { ...config, agentApiUrl: config.agentApiUrl ?? 'fake://agent-api' },
      ports,
      connection,
      signAgentToken: signAgentToken as (claims: AgentTokenClaims) => string,
      ...(reapOrphanSessions ? { reapOrphanSessions } : {}),
      ...(jobs ? { jobs } : {}),
      log: (message) => console.info(message),
    });
    console.info(
      `fleet 引擎 worker 已起：${config.address} 命名空间 ${config.namespace} 任务队列 ${config.taskQueue}（${mode} 实现）`,
    );
    await worker.run();
  } finally {
    await clientConnection?.close();
    await connection.close();
    await close();
  }
}
