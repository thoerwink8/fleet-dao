// 测试共用（不依赖 vitest，录重放夹具的脚本也用）：可跳时间的 Temporal 测试服务端 + 真的工作流包 + 假端口。
import { randomUUID } from 'node:crypto';
import type { Repo } from '@fleet-dao/shared';
import type { WorkflowHandle } from '@temporalio/client';
import { TestWorkflowEnvironment } from '@temporalio/testing';
import { DefaultLogger, Runtime, type WorkflowBundle } from '@temporalio/worker';
import type { RequirementInput, SubtaskInput } from '../src/contract.ts';
import type { Classifier } from '../src/decisions/failure.ts';
import type { Decide } from '../src/decisions/index.ts';
import type { SubtaskSpec } from '../src/decisions/plan.ts';
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

export interface WorkerOptions {
  taskQueue?: string;
  classify?: Classifier;
  /** 换掉判断入口（演练「判断出错」）。 */
  decide?: Decide;
  /**
   * 换工人的用例设 0：不走粘性队列。可跳时间的测试服务端不会把关掉的工人粘性队列里的任务挪回普通队列，
   * 真服务端会（工人停机时通知服务端，或粘性队列超时后挪回）。
   */
  maxCachedWorkflows?: number;
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
      agentApiUrl: 'http://127.0.0.1:8788',
      cliBinDir: '/repo/packages/cli/bin',
    },
    ports: world.ports,
    signAgentToken: (claims) =>
      `token:${claims.taskId}:${claims.subtaskId ?? '-'}:${claims.runId}:${claims.ttlSeconds}`,
    connection: env.nativeConnection,
    workflowBundle: await engineBundle(),
    ...(options.classify ? { classify: options.classify } : {}),
    ...(options.decide ? { decide: options.decide } : {}),
    ...(options.maxCachedWorkflows === undefined ? {} : { maxCachedWorkflows: options.maxCachedWorkflows }),
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

export function requirementInput(over: Partial<RequirementInput> = {}): RequirementInput {
  return {
    schemaVersion: 1,
    taskId: `task-${randomUUID().slice(0, 8)}`,
    repo: freshRepo(),
    issueNumber: 12,
    title: '登录页加验证码',
    rawRequest: '给登录页加手机验证码',
    requestedBy: 'founder',
    ...over,
  };
}

export function spec(key: string, over: Partial<SubtaskSpec> = {}): SubtaskSpec {
  return {
    key,
    index: 0,
    title: `子任务 ${key}`,
    touches: [`src/${key}`],
    dependsOn: [],
    stage: 'execute',
    secondOpinion: true,
    acceptance: [],
    ...over,
  };
}

export function subtaskInput(sub: SubtaskSpec, over: Partial<SubtaskInput> = {}): SubtaskInput {
  return {
    schemaVersion: 1,
    taskId: `task-${randomUUID().slice(0, 8)}`,
    subtaskId: randomUUID(),
    repo: freshRepo(),
    issueNumber: 12,
    specDir: 'specs/12-登录页加验证码',
    subtask: sub,
    ...over,
  };
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

/** 轮询查询，直到状态满足条件；返回那一刻的状态。 */
export async function queryUntil<S>(
  handle: WorkflowHandle,
  check: (status: S) => boolean,
  what: string,
  timeoutMs = 20_000,
): Promise<S> {
  let last: S | undefined;
  try {
    await waitUntil(
      async () => {
        last = (await handle.query('status')) as S;
        return check(last);
      },
      what,
      timeoutMs,
    );
  } catch (error) {
    throw new Error(`${(error as Error).message}\n最后一次状态：${JSON.stringify(last)}`);
  }
  return last as S;
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
