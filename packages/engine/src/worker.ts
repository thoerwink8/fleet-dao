// worker：连 Temporal、打包工作流、挂上活动。地址、命名空间、任务队列等从本机配置（环境变量）读，不写死进代码。
// 排空（drain.ts）：要发新版本、收到停机信号，都先不起新会话，在跑的最多再做一小段宽限，到点停下（按编号续上），再让工人停下。

import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { Client, Connection } from '@temporalio/client';
import {
  bundleWorkflowCode,
  NativeConnection,
  Runtime,
  Worker,
  type WorkflowBundle,
} from '@temporalio/worker';
import { createActivities, type EngineJobs, type EngineTasks } from './activities.ts';
import type { EngineActivities } from './activity-options.ts';
import { createDecide, type Decide, type FailureTriage } from './decisions/index.ts';
import {
  createEngineDrain,
  type DrainEnd,
  deadlineFrom,
  type EngineDrain,
  type InFlightSession,
  RELEASE_GRACE_MS,
  type WaitDrainedOptions,
  waitDrained,
} from './drain.ts';
import { createDrainControl, type DrainControl, ownReleaseSha } from './drain-control.ts';
import { startDrainStatusFile } from './drain-file.ts';
import type { EngineMasterGate } from './engine-master.ts';
import { createFakeWorld } from './fakes.ts';
import { engineTimerJobs } from './jobs/engine-timers.ts';
import { type GroomPoller, startGroomRequests } from './jobs/groom.ts';
import { type RouteProbeNowPoller, startRouteProbeRequests } from './jobs/route-probe-now.ts';
import { type EngineTimers, realTimerHost, startTimers } from './jobs/timers.ts';
import type { EnginePorts } from './ports.ts';

export interface EngineConfig {
  address: string;
  namespace: string;
  taskQueue: string;
  /** 工人停下时给在途活动多久收尾（会话已经在排空那一步停下、交回了，这里只剩等 CI、查库这类）。 */
  shutdownGraceSeconds: number;
  /** 同时执行的活动数；会话看守和等 CI 大多在等，真正的并发上限在选路由（账号池空位）那里。 */
  maxConcurrentActivities: number;
}

/** 任务书定的默认：法国本机的 Temporal、命名空间 fleet。 */
export const DEFAULT_ADDRESS = '127.0.0.1:7243';
export const DEFAULT_NAMESPACE = 'fleet';
export const DEFAULT_TASK_QUEUE = 'fleet';

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
  };
}

export const WORKFLOWS_PATH = fileURLToPath(new URL('./workflows/index.ts', import.meta.url));

type BundleLogger = Parameters<typeof bundleWorkflowCode>[0]['logger'];

export function bundleEngineWorkflows(logger?: BundleLogger): Promise<WorkflowBundle> {
  return bundleWorkflowCode({ workflowsPath: WORKFLOWS_PATH, ...(logger ? { logger } : {}) });
}

export interface CreateEngineWorkerOptions {
  config: EngineConfig;
  ports: EnginePorts;
  /**
   * 接活之前先收掉上一轮留下的会话（fleet-agent-scope list 再逐个 stop，再清它们的临时目录、收掉 runs 里没收场的行），返回收了几个会话。
   * 引擎被强杀时会话留在自己的 scope 里；它们的输出管道断了、接不上，三段那一段由任务工作流重跑（real/orphan-reap.ts）。
   */
  reapOrphanSessions?: () => Promise<number>;
  /** 定时任务要的东西（真端口才有）；不给，定时任务的活动明确报 JOB_NOT_CONFIGURED。 */
  jobs?: EngineJobs;
  /** 任务工作流（#632）要的活动（真端口才有）；不给，那几个活动明确报 TASK_NOT_CONFIGURED。 */
  tasks?: EngineTasks;
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
  const activities = createActivities(options.ports, options.jobs, options.tasks);
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

/** 装停机信号处理的地方：生产是 process，测试给假的。 */
export interface SignalSource {
  on(signal: 'SIGTERM' | 'SIGINT', handler: () => void): unknown;
  off(signal: 'SIGTERM' | 'SIGINT', handler: () => void): unknown;
}

export interface GracefulShutdownOptions {
  worker: Pick<Worker, 'getState' | 'shutdown'>;
  drain: EngineDrain;
  /** 到截止、被强停时停下还在跑的会话（real/one-shot-sessions.ts 的 drainStop；假端口没有会话，给空的）。 */
  stopSessions(why: string): string[];
  log: (message: string) => void;
  /** 停机信号来时给在跑的会话的宽限；不给就是 RELEASE_GRACE_MS。发布请求的截止更早就按它的。 */
  graceMs?: number;
  signals?: SignalSource;
  now?: () => number;
  sleep?: WaitDrainedOptions['sleep'];
  pollMs?: number;
  stopReportMs?: number;
}

const list = (sessions: InFlightSession[]) =>
  sessions
    .map((s) => `${s.stage}（${s.runId.slice(0, 8)}，${s.phase === 'starting' ? '在起' : '在跑'}）`)
    .join('、');

const DRAIN_END_WORDS: Readonly<Record<DrainEnd, string>> = {
  empty: '手上的会话都交回了',
  overdue: '到了截止、停下的会话也等过了交回',
  forced: '又收到一次停机信号，不等了',
};

/**
 * 接停机信号（Temporal 自己的那一套在 runEngineWorker 里关掉了）：第一次 SIGTERM 进排空（drain.ts）——不起新会话，在跑的
 * 最多再做一段宽限（发布请求的截止更早就按它），到点停下（交回 engine_stop，新引擎起来按编号续上），交回了再让工人停下；
 * 再来一次 SIGTERM 或 SIGINT：马上停下会话、让工人停下（工人停下时给在途活动 shutdownGraceSeconds 交回）。
 * done 在交代了工人停下之后落定，带上怎么结束的。
 */
export function installGracefulShutdown(o: GracefulShutdownOptions): {
  done: Promise<DrainEnd>;
  dispose(): void;
} {
  const signals = o.signals ?? process;
  const now = o.now ?? (() => Date.now());
  let forced = false;
  let settle!: (end: DrainEnd) => void;
  const done = new Promise<DrainEnd>((resolve) => {
    settle = resolve;
  });
  let started = false;
  let finished = false;
  const stopWorker = (end: DrainEnd) => {
    if (finished) return;
    finished = true;
    // 工人还没 run 起来、已经在停，都不再叫（shutdown 在不是 RUNNING 时会抛）
    if (o.worker.getState() === 'RUNNING') o.worker.shutdown();
    settle(end);
  };
  const force = (signal: string) => {
    if (finished) return;
    forced = true;
    const t = now();
    o.drain.cordon({
      source: 'signal',
      since: new Date(t).toISOString(),
      until: new Date(t).toISOString(),
      why: `收到 ${signal}`,
    });
    const stopped = o.stopSessions(`收到 ${signal}，马上停`);
    o.log(
      `收到 ${signal}：不等了，马上停${stopped.length > 0 ? `（停下 ${stopped.length} 个会话，新引擎起来按编号续上：${stopped.join('、')}）` : ''}`,
    );
    // 正在排空的那一圈醒来看到 forced 自己收手（stopWorker 只认第一次）
    stopWorker('forced');
  };
  const onTerm = () => {
    if (started || forced) {
      force('第二次 SIGTERM');
      return;
    }
    started = true;
    const t = now();
    o.drain.cordon({
      source: 'signal',
      since: new Date(t).toISOString(),
      until: deadlineFrom(t, o.graceMs ?? RELEASE_GRACE_MS),
      why: '收到 SIGTERM（systemd 在停引擎：发布切版本、重启或关机）',
    });
    const c = o.drain.stopping();
    const inFlight = o.drain.inFlight();
    o.log(
      inFlight.length === 0
        ? '收到 SIGTERM：手上没有会话，马上停'
        : `收到 SIGTERM：不起新会话，手上 ${inFlight.length} 个会话最晚做到 ${c?.until ?? '（截止认不出）'}，到点没做完的停下、新引擎起来按编号续上：${list(inFlight)}`,
    );
    let lastReport = t;
    void waitDrained(o.drain, {
      stopSessions: o.stopSessions,
      forced: () => forced,
      now,
      ...(o.sleep ? { sleep: o.sleep } : {}),
      ...(o.pollMs === undefined ? {} : { pollMs: o.pollMs }),
      ...(o.stopReportMs === undefined ? {} : { stopReportMs: o.stopReportMs }),
      onTick: (waiting, at) => {
        // 每分钟报一次还在等谁（journalctl -u fleet-engine 看得到）
        if (at - lastReport < 60_000) return;
        lastReport = at;
        o.log(`排空中：还在等 ${list(waiting)}；截止 ${o.drain.stopping()?.until ?? '（认不出）'}`);
      },
      onStopped: (runIds) =>
        o.log(`到了排空截止：停下还在跑的会话（新引擎起来按编号续上）：${runIds.join('、')}`),
    }).then(({ end, left }) => {
      if (finished) return;
      o.log(
        `排空结束：${DRAIN_END_WORDS[end]}${left.length > 0 ? `；还没交回的这几个新引擎起来按编号续上：${list(left)}` : ''}；让工人停下`,
      );
      stopWorker(end);
    });
  };
  const onInt = () => force('SIGINT');
  signals.on('SIGTERM', onTerm);
  signals.on('SIGINT', onInt);
  return {
    done,
    dispose() {
      signals.off('SIGTERM', onTerm);
      signals.off('SIGINT', onInt);
    },
  };
}

export { ownReleaseSha };

/** 进程入口用：按环境变量起一个 worker；要发新版本、停机信号都先排空（drain-control.ts、installGracefulShutdown）。 */
export async function runEngineWorker(env: Record<string, string | undefined> = process.env): Promise<void> {
  const config = configFromEnv(env);
  const mode = portsModeFromEnv(env);
  // SDK 默认一收到 SIGTERM 就停工人、30 秒后取消在途活动：会话等不到做完。停机信号改由 installGracefulShutdown 接。
  // 必须在第一次连 Temporal 之前装（Runtime 只能装一次）。
  Runtime.install({ shutdownSignals: [] });
  const drain = createEngineDrain();
  let ports: EnginePorts;
  let reapOrphanSessions: (() => Promise<number>) | undefined;
  let jobs: EngineJobs | undefined;
  let tasks: EngineTasks | undefined;
  let registerJobs: (() => Promise<void>) | undefined;
  let retireSchedules: ((client: Pick<Client, 'schedule'>) => Promise<void>) | undefined;
  let jobLastStartedAt: (() => Promise<ReadonlyMap<string, Date>>) | undefined;
  let master: EngineMasterGate | undefined;
  let recordSkippedRun: ((jobId: string, why: string) => Promise<void>) | undefined;
  let close: () => Promise<void> = async () => {};
  let statusFile: string | undefined;
  let control: DrainControl | undefined;
  let stopSessions: (why: string) => string[] = () => [];
  if (mode === 'real') {
    const { realPortsFromEnv } = await import('./real/index.ts');
    const real = realPortsFromEnv(env, { drain, ownSha: ownReleaseSha() });
    ports = real.ports;
    reapOrphanSessions = real.reapOrphanSessions;
    jobs = real.jobs;
    tasks = real.tasks;
    registerJobs = real.registerJobs;
    retireSchedules = real.retireSchedules;
    jobLastStartedAt = real.jobLastStartedAt;
    master = real.master;
    recordSkippedRun = real.recordSkippedRun;
    close = real.close;
    statusFile = join(real.stateDir, 'drain.json');
    control = createDrainControl({ ...real.drainControl, drain, log: (message) => console.info(message) });
    stopSessions = real.drainControl.stopSessions;
  } else {
    ports = createFakeWorld().ports;
  }
  const connection = await NativeConnection.connect({ address: config.address });
  let clientConnection: Connection | undefined;
  let client: Client | undefined;
  let timers: EngineTimers | undefined;
  let status: ReturnType<typeof startDrainStatusFile> | undefined;
  let shutdown: ReturnType<typeof installGracefulShutdown> | undefined;
  let stopControl: (() => void) | undefined;
  let stopMaster: (() => void) | undefined;
  let probeNow: RouteProbeNowPoller | undefined;
  let groomPoller: GroomPoller | undefined;
  try {
    // 引擎总开关（#1086）：接活之前先读一次（读不到按关），之后每 5 秒刷新；选路、一次性会话登记读缓存，定时器入口每轮现读
    if (master) {
      await master.refresh();
      stopMaster = master.start();
    }
    if (registerJobs) {
      // 定时任务只由真端口的工人起：假端口不碰库和 GitHub，起了也没有东西可跑。
      // 先登记：一次都没跑过的也在看门狗的名单上。任一步失败就不起，别让对账悄悄没人跑。
      await registerJobs();
      clientConnection = await Connection.connect({ address: config.address });
      client = new Client({ connection: clientConnection, namespace: config.namespace });
      // 定时器起之前，把 Temporal 上老的 Schedule（退役的、改由进程内定时器跑的，jobs/retired-schedules.ts）删掉，免得同一个任务
      // 两边各跑一轮；删不掉不挡这里往下走（real/retire-schedules.ts 报提醒）。
      if (retireSchedules) await retireSchedules(client);
    }
    // 排空状态写给发布脚本看（它拿 pid 和 systemd 的 MainPID 比）：假端口没有状态目录，不写
    if (statusFile) {
      status = startDrainStatusFile({
        drain,
        file: statusFile,
        pid: process.pid,
        log: (message) => console.warn(message),
      });
    }
    // 接活之前先看一眼排空请求：发布正在排空时起来的（人手动重启了旧版本），一起来就不起新会话
    if (control) {
      await control.resumed();
      await control.tick();
      stopControl = control.start();
    }
    const worker = await createEngineWorker({
      config,
      ports,
      connection,
      ...(reapOrphanSessions ? { reapOrphanSessions } : {}),
      ...(jobs ? { jobs } : {}),
      ...(tasks ? { tasks } : {}),
      log: (message) => console.info(message),
    });
    if (client && jobs && master && recordSkippedRun) {
      // 定时任务的定时器（jobs/timers.ts）：引擎进程里的普通定时器，重启后自己恢复；孤儿会话收完、工人建好之后再起，一起来就能接任务工作流
      const lastRuns = jobLastStartedAt?.();
      timers = startTimers(
        engineTimerJobs({ jobs, client, taskQueue: config.taskQueue }),
        realTimerHost(
          async (id) => (lastRuns ? ((await lastRuns).get(id) ?? null) : null),
          master,
          recordSkippedRun,
        ),
      );
      console.info('定时任务的定时器已起');
      // 驾驶舱的立即探测：每几秒看一眼有没人点（总开关关着也看：探针是看家检查）
      if (jobs.routeProbeNow) {
        probeNow = startRouteProbeRequests(jobs.routeProbeNow);
        console.info('立即探测已起');
      }
      // 临时指挥官整理待办：每几秒看一眼有没有排队的（总开关关着的接手时自己判，留在队里等）
      if (jobs.groom) {
        groomPoller = startGroomRequests(jobs.groom);
        console.info('整理待办的接手已起');
      }
    }
    shutdown = installGracefulShutdown({
      worker,
      drain,
      stopSessions,
      log: (message) => console.info(message),
    });
    console.info(
      `fleet 引擎 worker 已起：${config.address} 命名空间 ${config.namespace} 任务队列 ${config.taskQueue}（${mode} 实现）`,
    );
    await worker.run();
  } finally {
    shutdown?.dispose();
    // 不再起新的一轮，在跑的最多再等一个收尾宽限（和在途活动一样）
    const unfinished = await timers?.stop(config.shutdownGraceSeconds * 1000);
    if (unfinished && unfinished.length > 0) {
      console.warn(`停机时这些定时任务的一轮还没完，不等了：${unfinished.join('、')}`);
    }
    stopControl?.();
    stopMaster?.();
    probeNow?.stop();
    groomPoller?.stop();
    await status?.flush();
    status?.stop();
    await clientConnection?.close();
    await connection.close();
    await close();
  }
}
