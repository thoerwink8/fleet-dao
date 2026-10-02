// 测试共用（不依赖 vitest，录重放夹具的脚本也用）：可跳时间的 Temporal 测试服务端 + 真的工作流包 + 假端口。
import { randomUUID } from 'node:crypto';
import type { Repo } from '@fleet-dao/shared';
import type { WorkflowHandle } from '@temporalio/client';
import { TestWorkflowEnvironment } from '@temporalio/testing';
import { DefaultLogger, Runtime, type WorkflowBundle } from '@temporalio/worker';
import type { EngineJobs, EngineTasks } from '../src/activities.ts';
import type { EngineActivities } from '../src/activity-options.ts';
import type { FailureTriage } from '../src/decisions/failure.ts';
import type { Decide } from '../src/decisions/index.ts';
import type { FakeWorld } from '../src/fakes.ts';
import { bundleEngineWorkflows, createEngineWorker } from '../src/worker.ts';

Runtime.install({ logger: new DefaultLogger('ERROR') });

const silent = { trace() {}, debug() {}, info() {}, warn() {}, error: console.error, log() {} };
let bundle: Promise<WorkflowBundle> | undefined;
/** 整个测试文件共用一份工作流包（打包要一秒左右）。 */
export function engineBundle(): Promise<WorkflowBundle> {
  bundle ??= bundleEngineWorkflows(silent as never);
  return bundle;
}

export function createEnv(): Promise<TestWorkflowEnvironment> {
  return TestWorkflowEnvironment.createTimeSkipping();
}

/**
 * 真的 Temporal 开发服务端（temporal server start-dev），不能跳时间。只给「测试服务端和真服务端行为不同」的用例用：
 * 比如测试服务端不会让已经请求叫停、又不心跳的活动超时（一直等工人回话），真服务端到了限时就判超时。
 * FLEET_TEST_TEMPORAL_CLI 指向本机的 temporal 命令就用它（最好和法国同一版），否则按 SDK 默认的版本下载一份（缓存一天）。
 */
export function createRealEnv(): Promise<TestWorkflowEnvironment> {
  const cli = process.env.FLEET_TEST_TEMPORAL_CLI?.trim();
  // CI 按 deploy/france.sh 钉的版本装好命令行再交过来（.github/workflows/ci.yml）；没给说明那几步坏了，
  // 不许悄悄退回 SDK 默认版本（和法国不同版，测过也不算数）。
  if (!cli && process.env.CI) {
    throw new Error(
      'CI 里没给 FLEET_TEST_TEMPORAL_CLI：Temporal 命令行没按法国的版本装上，这条真服务端的测试不算数',
    );
  }
  return TestWorkflowEnvironment.createLocal(
    cli ? { server: { executable: { type: 'existing-path', path: cli } } } : {},
  );
}

export interface WorkerOptions {
  taskQueue?: string;
  triage?: FailureTriage;
  /** 换掉判断入口（演练「判断出错」）。 */
  decide?: Decide;
  /** 包一层活动（让某个活动卡在半路）。 */
  wrapActivities?: (activities: EngineActivities) => EngineActivities;
  /**
   * 换工人的用例设 0：不走粘性队列。可跳时间的测试服务端不会把关掉的工人粘性队列里的任务挪回普通队列，
   * 真服务端会（工人停机时通知服务端，或粘性队列超时后挪回）。
   */
  maxCachedWorkflows?: number;
  /** 定时任务要的东西（对账补漏）；不给就是假端口那样，定时任务的活动报 JOB_NOT_CONFIGURED。 */
  jobs?: EngineJobs;
  /** 任务工作流要的活动；不给就是假端口那样，报 TASK_NOT_CONFIGURED。 */
  tasks?: EngineTasks;
  /** 换一份工作流包（测试宿主工作流）；不给就是引擎自己的。 */
  workflowBundle?: WorkflowBundle;
}

/** 起一个真的引擎 worker（假端口），跑完 fn 就关。 */
export async function withWorker<T>(
  env: TestWorkflowEnvironment,
  world: FakeWorld,
  fn: (taskQueue: string) => Promise<T>,
  options: WorkerOptions = {},
): Promise<T> {
  const taskQueue = options.taskQueue ?? `q-${randomUUID()}`;
  const worker = await createEngineWorker({
    config: {
      address: env.address,
      namespace: env.namespace ?? 'default',
      taskQueue,
      shutdownGraceSeconds: 1,
      maxConcurrentActivities: 40,
    },
    ports: world.ports,
    connection: env.nativeConnection,
    workflowBundle: options.workflowBundle ?? (await engineBundle()),
    ...(options.triage ? { triage: options.triage } : {}),
    ...(options.decide ? { decide: options.decide } : {}),
    ...(options.wrapActivities ? { wrapActivities: options.wrapActivities } : {}),
    ...(options.maxCachedWorkflows === undefined ? {} : { maxCachedWorkflows: options.maxCachedWorkflows }),
    ...(options.jobs ? { jobs: options.jobs } : {}),
    ...(options.tasks ? { tasks: options.tasks } : {}),
  });
  return worker.runUntil(fn(taskQueue));
}

export const REPO: Repo = {
  id: 'repo-1',
  owner: 'acme',
  name: 'demo',
  defaultBranch: 'main',
  testCommand: 'pnpm check',
};

/**
 * 每条用例一个仓：合并队列按仓单例，而且钉在第一次拉起它的任务队列上。
 * 测试里每条用例一个任务队列、用完就关 worker，共用仓的话后一条用例会排进前一条留下的、没人干活的队列。
 */
export function freshRepo(): Repo {
  return { ...REPO, id: `repo-${randomUUID().slice(0, 8)}`, name: `demo-${randomUUID().slice(0, 8)}` };
}

/** 真实时间里轮询，直到条件成立（测试服务端在有活动跑着时不跳时间）。 */
export async function waitUntil(
  check: () => boolean | Promise<boolean>,
  what: string,
  timeoutMs = 20_000,
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    if (await check()) return;
    if (Date.now() > deadline) throw new Error(`等了 ${timeoutMs} 毫秒还没等到：${what}`);
    await new Promise((r) => setTimeout(r, 50));
  }
}

/**
 * 轮询一个读状态的动作，直到状态满足条件；返回那一刻的状态。
 * 工作流刚起、worker 还没处理完第一个工作流任务时查询会当场失败：这算「还没好」接着等，不当成测试失败；
 * 等到期还没读成，报错里带上最后一次读失败的原因（不是只剩一句「Failed to query Workflow」）。
 */
export async function pollQuery<S>(
  read: () => Promise<S>,
  check: (status: S) => boolean,
  what: string,
  timeoutMs = 20_000,
): Promise<S> {
  let last: S | undefined;
  let lastError: unknown;
  try {
    await waitUntil(
      async () => {
        try {
          last = await read();
        } catch (error) {
          lastError = error;
          return false;
        }
        return check(last);
      },
      what,
      timeoutMs,
    );
  } catch (error) {
    throw new Error(`${(error as Error).message}
最后一次状态：${JSON.stringify(last)}${describeReadFailure(lastError)}`);
  }
  return last as S;
}

function describeReadFailure(error: unknown): string {
  if (error === undefined) return '';
  const cause = error instanceof Error && error.cause instanceof Error ? `（${error.cause.message}）` : '';
  return `
最后一次读失败：${error instanceof Error ? error.message : String(error)}${cause}`;
}

/** 轮询查询，直到状态满足条件；返回那一刻的状态。 */
export function queryUntil<S>(
  handle: WorkflowHandle,
  check: (status: S) => boolean,
  what: string,
  timeoutMs = 20_000,
): Promise<S> {
  return pollQuery(() => handle.query('status') as Promise<S>, check, what, timeoutMs);
}

/** 把历史里的载荷（字节）都解成文字拼起来，方便逐字查「有没有某样东西进了历史」。 */
export function historyText(history: unknown): string {
  const parts: string[] = [];
  const walk = (value: unknown) => {
    if (value instanceof Uint8Array) parts.push(Buffer.from(value).toString('utf8'));
    else if (Array.isArray(value)) for (const v of value) walk(v);
    else if (value && typeof value === 'object') for (const v of Object.values(value)) walk(v);
    else if (typeof value === 'string') parts.push(value);
  };
  walk(history);
  return parts.join('\n');
}

/** 只取历史里本地活动（decide）记下的那些条目的文字：查「这个值是不是从判断记录里来的」。 */
export function markerText(history: {
  events?: readonly { markerRecordedEventAttributes?: unknown }[] | null;
}): string {
  return historyText((history.events ?? []).filter((e) => e.markerRecordedEventAttributes));
}

/** 两段时间是否重叠。 */
export function overlaps(
  a: { at: number; end: number | null },
  b: { at: number; end: number | null },
): boolean {
  const aEnd = a.end ?? Number.POSITIVE_INFINITY;
  const bEnd = b.end ?? Number.POSITIVE_INFINITY;
  return a.at < bEnd && b.at < aEnd;
}
