// 真实 Temporal：兼容准入复用 taskWorkflow 首个 local activity（decide('limits')）。
// 工作流是生产 kit.ts 的 limitsFor；准入来源是真实的 createLegacyExecutionAdmission（读真实 Start 历史）+ 内存 Store。
import { randomUUID } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { createMemoryStore } from '@fleet-dao/store';
import { ApplicationFailure, Connection, WorkflowFailedError } from '@temporalio/client';
import type { TestWorkflowEnvironment } from '@temporalio/testing';
import { bundleWorkflowCode, Worker, type WorkflowBundle } from '@temporalio/worker';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { createAdmittingDecide } from '../src/decisions/admitting-decide.ts';
import { createDecide, type Decide } from '../src/decisions/index.ts';
import { EXECUTION_ADMISSION_DENIED } from '../src/execution-admission-failure.ts';
import { createLegacyExecutionAdmission } from '../src/real/execution-legacy-admission.ts';
import { EXECUTION_HISTORY_MAX_BYTES } from '../src/real/execution-start-reader.ts';
import type { BoundedLegacyAdmission } from '../src/real/legacy-admission-protocol.ts';
import { createRealEnv } from './support.ts';

const repo = {
  id: randomUUID(),
  owner: 'example',
  name: 'canary',
  defaultBranch: 'main',
  testCommand: 'pnpm check',
};
const quiet = { trace() {}, debug() {}, info() {}, warn() {}, error: console.error, log() {} } as never;
const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

let env: TestWorkflowEnvironment;
let bundle: WorkflowBundle;
let connection: Connection;
let namespace: string;
const tasks = new Map<number, string>();
const store = createMemoryStore({
  repos: [repo],
  tasks: [],
});

const admissionsOf = (taskId: string) =>
  [...store.data.legacyExecutionAdmissions.values()].filter((a) => a.taskId === taskId).length;

function register(issue: number) {
  const taskId = randomUUID();
  tasks.set(issue, taskId);
  store.data.tasks.push({
    id: taskId,
    repoId: repo.id,
    issueNumber: issue,
    title: `t${issue}`,
    rawRequest: '',
    requestedBy: 'test',
    state: 'queued',
    priority: 0,
    createdAt: '2026-10-20T00:00:00.000Z',
  } as never);
  return {
    workflowId: `task:example/canary#${issue}`,
    input: { schemaVersion: 1, taskId, repo, issueNumber: issue, title: `t${issue}` } as Record<
      string,
      unknown
    >,
  };
}

beforeAll(async () => {
  bundle = await bundleWorkflowCode({
    workflowsPath: fileURLToPath(new URL('./fixtures/execution-compat-probe.ts', import.meta.url)),
    logger: quiet,
  });
  env = await createRealEnv();
  namespace = env.namespace ?? 'default';
  connection = await Connection.connect({
    address: env.address,
    interceptors: [],
    channelArgs: { 'grpc.max_receive_message_length': EXECUTION_HISTORY_MAX_BYTES },
  });
}, 120_000);
afterAll(async () => {
  await connection?.close();
  await env?.teardown();
});

function compat(
  taskQueue: string,
  hooks: { failAdmit?: () => boolean; alertOutcome?: 'spooled' | 'unknown' } = {},
) {
  const inner = vi.fn<Decide>(createDecide());
  const admitSpy = vi.fn();
  const bounded: BoundedLegacyAdmission = async (input, audit) => {
    admitSpy();
    if (hooks.failAdmit?.()) return { kind: 'unknown', code: 'store_unavailable' };
    const result = await store.admitLegacyExecution(input, audit);
    return result.kind === 'rejected'
      ? { kind: 'denied', code: result.reason }
      : {
          kind: 'allowed',
          status: result.kind,
          admissionId: result.admission.id,
          postCommitWarnings: result.postCommitWarnings,
        };
  };
  const admit = createLegacyExecutionAdmission({
    namespace,
    taskQueue,
    connection,
    admit: bounded,
    audit: { actor: { kind: 'user', id: randomUUID() }, via: 'agent', reason: '兼容准入真实验证' },
  });
  const record = vi.fn(async () =>
    hooks.alertOutcome === 'unknown'
      ? ({ kind: 'unknown', code: 'io' } as const)
      : ({ kind: 'spooled', key: 'a'.repeat(64), recordHash: 'b'.repeat(64) } as const),
  );
  const decide = createAdmittingDecide({ decide: inner as unknown as Decide, admit, alert: { record } });
  return { decide, inner, admitSpy, record };
}

async function withWorker<T>(taskQueue: string, decide: Decide, fn: () => Promise<T>): Promise<T> {
  const worker = await Worker.create({
    connection: env.nativeConnection,
    namespace,
    taskQueue,
    workflowBundle: bundle,
    shutdownGraceTime: '1s',
    activities: { decide },
  });
  return worker.runUntil(fn);
}

const start = (taskQueue: string, workflowId: string, input: Record<string, unknown>) =>
  env.client.workflow.start('taskWorkflow', { workflowId, taskQueue, args: [input] });
const eventTypes = async (handle: Awaited<ReturnType<typeof start>>) =>
  (await handle.fetchHistory()).events?.map((e) => e.eventType) ?? [];
const hasTimer = async (handle: Awaited<ReturnType<typeof start>>) =>
  ((await handle.fetchHistory()).events ?? []).find((e) => e.timerStartedEventAttributes)
    ?.timerStartedEventAttributes;

describe('兼容准入（真实 Temporal，未启用生产）', () => {
  it('放行：结果和历史事件序列与无准入的旧工人一致，重放不再准入', async () => {
    const q = `compat-ok-${randomUUID()}`;
    const old = register(101);
    const next = register(102);
    const plain = await withWorker(q, createDecide(), async () => {
      const handle = await start(q, old.workflowId, old.input);
      return {
        result: await handle.result(),
        types: await eventTypes(handle),
        history: await handle.fetchHistory(),
      };
    });
    expect(store.data.legacyExecutionAdmissions.size).toBe(0);
    const c = compat(q);
    const admitted = await withWorker(q, c.decide, async () => {
      const handle = await start(q, next.workflowId, next.input);
      return {
        result: await handle.result(),
        types: await eventTypes(handle),
        runId: handle.firstExecutionRunId,
      };
    });
    expect(admitted.result).toEqual(plain.result);
    expect(admitted.types).toEqual(plain.types);
    expect(c.inner).toHaveBeenCalledWith('limits', {});
    const stored = [...store.data.legacyExecutionAdmissions.values()];
    expect(stored).toHaveLength(1);
    expect(stored[0]).toMatchObject({
      runId: admitted.runId,
      workflowId: next.workflowId,
      taskId: next.input.taskId,
    });
    // 旧 run 的已录历史在兼容版重放：不触发任何准入，也不出现新增命令。
    const before = c.admitSpy.mock.calls.length;
    await Worker.runReplayHistory(
      { workflowBundle: bundle, replayName: 'old-history' },
      plain.history,
      old.workflowId,
    );
    expect(c.admitSpy.mock.calls.length).toBe(before);
    expect(store.data.legacyExecutionAdmissions.size).toBe(1);
  }, 60_000);

  it.each([
    [
      'managed 保留字段（未来 V1 候选）',
      () => ({ ...register(111).input, execution: { protocolVersion: 1 } }),
      'task:example/canary#111',
      'managed_start_unsupported',
    ],
    [
      'workflowId 与 repo/issue 不符',
      () => register(112).input,
      'task:example/canary#999',
      'start_identity_conflict',
    ],
    [
      '伪造 taskId（库里没有）',
      () => ({ ...register(113).input, taskId: randomUUID() }),
      'task:example/canary#113',
      'not_found',
    ],
  ])(
    '确证拒绝：%s——TaskFlow 构造前终结，不退避、零业务、零准入',
    async (_name, input, workflowId, code) => {
      const q = `compat-deny-${randomUUID()}`;
      const c = compat(q);
      const admissions = store.data.legacyExecutionAdmissions.size;
      const handle = await withWorker(q, c.decide, async () => {
        const handle = await start(q, workflowId, input());
        const error = await handle.result().catch((e: unknown) => e);
        expect(error).toBeInstanceOf(WorkflowFailedError);
        const cause = (error as WorkflowFailedError).cause;
        expect(cause).toBeInstanceOf(ApplicationFailure);
        expect(cause).toMatchObject({
          type: EXECUTION_ADMISSION_DENIED,
          nonRetryable: true,
          details: [code],
        });
        return handle;
      });
      expect(c.inner).not.toHaveBeenCalled();
      expect(c.record).not.toHaveBeenCalled();
      expect(await hasTimer(handle)).toBeUndefined();
      expect(store.data.legacyExecutionAdmissions.size).toBe(admissions);
    },
    60_000,
  );

  it('未知（读/写不可用）：不判死不放行，15 秒退避，报警承接记下；恢复后下一轮才放行', async () => {
    const q = `compat-unknown-${randomUUID()}`;
    const item = register(121);
    let calls = 0;
    const c = compat(q, { failAdmit: () => ++calls <= 3 });
    await withWorker(q, c.decide, async () => {
      const handle = await start(q, item.workflowId, item.input);
      let timer = await hasTimer(handle);
      for (let i = 0; i < 100 && !timer; i += 1) {
        await sleep(200);
        timer = await hasTimer(handle);
      }
      expect(Number(timer?.startToFireTimeout?.seconds)).toBe(15);
      expect(c.inner).not.toHaveBeenCalled();
      expect((await handle.describe()).status.name).toBe('RUNNING');
      expect(c.record).toHaveBeenCalledWith(
        {
          identity: expect.objectContaining({
            namespace,
            workflowId: item.workflowId,
            runId: handle.firstExecutionRunId,
          }),
          firstCode: 'store_unavailable',
        },
        expect.anything(),
      );
      expect(admissionsOf(item.input.taskId as string)).toBe(0);
      await handle.result();
    });
    expect(admissionsOf(item.input.taskId as string)).toBe(1);
  }, 90_000);

  it('未知且报警写也失败：仍只是未知，不放行、不判拒绝', async () => {
    const q = `compat-unknown-alert-${randomUUID()}`;
    const item = register(131);
    const c = compat(q, { failAdmit: () => true, alertOutcome: 'unknown' });
    await withWorker(q, c.decide, async () => {
      const handle = await start(q, item.workflowId, item.input);
      for (let i = 0; i < 100 && !(await hasTimer(handle)); i += 1) await sleep(200);
      expect(c.record).toHaveBeenCalled();
      expect((await handle.describe()).status.name).toBe('RUNNING');
      expect(c.inner).not.toHaveBeenCalled();
      await handle.terminate('test');
    });
  }, 60_000);

  it('未来 V1 队列：兼容版工人不轮询的队列上，Start 不被消费也不准入', async () => {
    const q = `compat-owned-${randomUUID()}`;
    const futureQueue = `v1-future-${randomUUID()}`;
    const item = register(141);
    const c = compat(q);
    await withWorker(q, c.decide, async () => {
      const handle = await start(futureQueue, item.workflowId, item.input);
      await sleep(1500);
      expect((await eventTypes(handle)).length).toBeLessThanOrEqual(2);
      expect(c.admitSpy).not.toHaveBeenCalled();
      await handle.terminate('test');
    });
  }, 60_000);
});
