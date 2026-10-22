// 真实 Temporal + 真实 PG 存储事务（PgStore；CI 的 temporal 台没有真库变量时跑 PGlite 真迁移，两连接竞争在 store 的 real-pg 测试）：
// 兼容准入复用 taskWorkflow 首个 local activity（decide('limits')）。工作流是生产 kit.ts 的 limitsFor；准入来源是真实的
// createLegacyExecutionAdmission（读真实 Start 历史）；可信终态收敛读真实 DescribeWorkflowExecution。
import { randomUUID } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { createTestDb, TEST_DB_TIMEOUT_MS, type TestDb } from '@fleet-dao/db/testing';
import {
  createPgStore,
  type ExecutionIdentity,
  IDS,
  type ManagedTaskBirthV1,
  type Store,
} from '@fleet-dao/store';
import { seedPg } from '@fleet-dao/store/testing';
import { ApplicationFailure, CancelledFailure, Connection, WorkflowFailedError } from '@temporalio/client';
import type { TestWorkflowEnvironment } from '@temporalio/testing';
import { bundleWorkflowCode, Worker, type WorkflowBundle } from '@temporalio/worker';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { createAdmittingDecide } from '../src/decisions/admitting-decide.ts';
import { createDecide, type Decide } from '../src/decisions/index.ts';
import { EXECUTION_ADMISSION_DENIED } from '../src/execution-admission-failure.ts';
import { createFakeWorld } from '../src/fakes.ts';
import { createLegacyExecutionAdmission } from '../src/real/execution-legacy-admission.ts';
import { createExecutionRunRelease, executionRunTerminalReader } from '../src/real/execution-run-terminal.ts';
import { EXECUTION_HISTORY_MAX_BYTES } from '../src/real/execution-start-reader.ts';
import type { BoundedLegacyAdmission } from '../src/real/legacy-admission-protocol.ts';
import { configFromEnv, createEngineWorker } from '../src/worker.ts';
import { createRealEnv } from './support.ts';

const repo = {
  id: IDS.repo,
  owner: 'example',
  name: 'canary',
  defaultBranch: 'main',
  testCommand: 'pnpm check',
};
const quiet = { trace() {}, debug() {}, info() {}, warn() {}, error: console.error, log() {} } as never;
const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));
const audit = { actor: { kind: 'user' as const, id: IDS.founderA }, via: 'agent' as const };

let env: TestWorkflowEnvironment;
let bundle: WorkflowBundle;
let connection: Connection;
let namespace: string;
let t: TestDb;
let store: Store;

const admissionsOf = async (taskId: string) => (await store.listLegacyExecutionAdmissions(taskId)).length;

async function register(issue: number) {
  const taskId = randomUUID();
  await seedPg(t.db, {
    tasks: [
      {
        id: taskId,
        repoId: repo.id,
        issueNumber: issue,
        title: `t${issue}`,
        rawRequest: '',
        requestedBy: 'test',
        state: 'queued',
        priority: 0,
        createdAt: '2026-10-20T00:00:00.000Z',
      } as never,
    ],
  });
  return {
    taskId,
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
  t = await createTestDb();
  await seedPg(t.db, { repos: [repo] });
  store = createPgStore(t.db);
}, 180_000 + TEST_DB_TIMEOUT_MS);
afterAll(async () => {
  await connection?.close();
  await env?.teardown();
  await t?.close();
});

interface Hooks {
  /** 返回 true＝这一轮准入读写不可用（未知）。 */
  failAdmit?: () => boolean;
  /** 返回 true＝事务已提交但回执丢了（未知）。 */
  commitThenUnknown?: () => boolean;
  alertOutcome?: 'spooled' | 'unknown';
  /** 卡住 admit 直到放行；honorSignal 决定它是否在活动取消时提前收场。 */
  gate?: { open: Promise<void>; honorSignal: boolean };
  /** 返回 true＝这一轮读 Start 历史失败（RPC 不可用）。 */
  failHistory?: () => boolean;
}

function compat(taskQueue: string, hooks: Hooks = {}) {
  const inner = vi.fn<Decide>(createDecide());
  const admitSpy = vi.fn();
  const bounded: BoundedLegacyAdmission = async (input, auditInfo, options) => {
    admitSpy();
    if (hooks.failAdmit?.()) return { kind: 'unknown', code: 'store_unavailable' };
    if (hooks.gate) {
      const { open, honorSignal } = hooks.gate;
      await Promise.race([
        open,
        new Promise<void>((resolve) => {
          if (honorSignal) options.signal.addEventListener('abort', () => resolve(), { once: true });
        }),
      ]);
    }
    const result = await store.admitLegacyExecution(input, auditInfo);
    if (hooks.commitThenUnknown?.()) return { kind: 'unknown', code: 'store_unavailable' };
    return result.kind === 'rejected'
      ? { kind: 'denied', code: result.reason }
      : {
          kind: 'allowed',
          status: result.kind,
          admissionId: result.admission.id,
          postCommitWarnings: result.postCommitWarnings,
        };
  };
  const reading = {
    options: connection.options,
    withDeadline: connection.withDeadline.bind(connection),
    withAbortSignal: connection.withAbortSignal.bind(connection),
    workflowService: {
      getWorkflowExecutionHistory: (request: never) =>
        hooks.failHistory?.()
          ? Promise.reject(Object.assign(new Error('history unavailable'), { code: 14 }))
          : connection.workflowService.getWorkflowExecutionHistory(request),
    },
  } as unknown as Connection;
  const admit = createLegacyExecutionAdmission({
    namespace,
    taskQueue,
    connection: reading,
    admit: bounded,
    audit: { ...audit, reason: '兼容准入真实验证' },
  });
  const record = vi.fn(async () =>
    hooks.alertOutcome === 'unknown'
      ? ({ kind: 'unknown', code: 'io' } as const)
      : ({ kind: 'spooled', key: 'a'.repeat(64), recordHash: 'b'.repeat(64) } as const),
  );
  const decide = createAdmittingDecide({ decide: inner as unknown as Decide, admit, alert: { record } });
  return { decide, inner, admitSpy, record, admit };
}

async function withWorker<T>(
  taskQueue: string,
  decide: Decide,
  fn: () => Promise<T>,
  options: { maxCachedWorkflows?: number } = {},
): Promise<T> {
  const worker = await Worker.create({
    connection: env.nativeConnection,
    namespace,
    taskQueue,
    workflowBundle: bundle,
    shutdownGraceTime: '1s',
    activities: { decide },
    ...options,
  });
  return worker.runUntil(fn);
}

const start = (
  taskQueue: string,
  workflowId: string,
  input: Record<string, unknown>,
  type: 'taskWorkflow' | 'continueProbe' = 'taskWorkflow',
) =>
  env.client.workflow.start(type, {
    workflowId,
    taskQueue,
    args: type === 'continueProbe' ? [0] : [input],
  });
type Handle = Awaited<ReturnType<typeof start>>;
const eventTypes = async (handle: Handle) =>
  (await handle.fetchHistory()).events?.map((e) => e.eventType) ?? [];
// 工作流任务相关事件随换工人必然多出来；其余（命令与结果）必须与不换工人时逐项相同。
const WORKFLOW_TASK_EVENTS = new Set([5, 6, 7, 8]);
const commandEvents = async (handle: Handle) =>
  (await eventTypes(handle)).filter((e) => !WORKFLOW_TASK_EVENTS.has(Number(e)));
const hasTimer = async (handle: Handle) =>
  ((await handle.fetchHistory()).events ?? []).find((e) => e.timerStartedEventAttributes)
    ?.timerStartedEventAttributes;
const hasMarker = async (handle: Handle) =>
  ((await handle.fetchHistory()).events ?? []).some((e) => e.markerRecordedEventAttributes);
async function until(check: () => Promise<boolean>, what: string, ms = 20_000) {
  const deadline = Date.now() + ms;
  while (Date.now() < deadline) {
    if (await check()) return;
    await sleep(150);
  }
  throw new Error(`等不到：${what}`);
}

describe('兼容准入（真实 Temporal + 真实 PG 存储事务，未启用生产）', () => {
  it('放行：结果和历史事件序列与无准入的旧工人一致，重放不再准入', async () => {
    const q = `compat-ok-${randomUUID()}`;
    const old = await register(101);
    const next = await register(102);
    const plain = await withWorker(q, createDecide(), async () => {
      const handle = await start(q, old.workflowId, old.input);
      return {
        result: await handle.result(),
        types: await eventTypes(handle),
        history: await handle.fetchHistory(),
      };
    });
    expect(await admissionsOf(old.taskId)).toBe(0);
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
    const stored = await store.listLegacyExecutionAdmissions(next.taskId);
    expect(stored).toHaveLength(1);
    expect(stored[0]).toMatchObject({
      runId: admitted.runId,
      workflowId: next.workflowId,
      taskId: next.taskId,
      generation: 1,
      operation: 'legacy_first_limits',
      namespace,
      taskQueue: q,
    });
    // 旧 run 的已录历史在兼容版重放：不触发任何准入，也不出现新增命令。
    const before = c.admitSpy.mock.calls.length;
    await Worker.runReplayHistory(
      { workflowBundle: bundle, replayName: 'old-history' },
      plain.history,
      old.workflowId,
    );
    expect(c.admitSpy.mock.calls.length).toBe(before);
    expect(await admissionsOf(old.taskId)).toBe(0);
    // 旧对象不能事后被管理化：已有 task 的初始化被强制拒绝（缺口：旧任务尚无管理化入口）。
    const birth: ManagedTaskBirthV1 = {
      protocolVersion: 1,
      birthRequestId: randomUUID(),
      coverageEpoch: randomUUID(),
      task: {
        id: next.taskId,
        repoId: repo.id,
        issueNumber: 102,
        title: 't102',
        rawRequest: '',
        requestedBy: 'test',
      },
      namespace,
      workflowType: 'taskWorkflow',
      taskQueue: q,
    };
    expect(await store.createManagedTaskFromIssue(birth, audit)).toMatchObject({
      kind: 'rejected',
    });
  }, 90_000);

  it('r2 代次只信 workflowId，并持久为 generation=2', async () => {
    const q = `compat-r2-${randomUUID()}`;
    const item = await register(103);
    const c = compat(q);
    await withWorker(q, c.decide, async () => {
      const handle = await start(q, `${item.workflowId}:r2`, item.input);
      await handle.result();
    });
    expect(await store.listLegacyExecutionAdmissions(item.taskId)).toMatchObject([
      { generation: 2, workflowId: `${item.workflowId}:r2` },
    ]);
  }, 60_000);

  it.each([
    [
      'managed 保留字段（未来 V1 候选）',
      async () => ({ ...(await register(111)).input, execution: { protocolVersion: 1 } }),
      'task:example/canary#111',
      'managed_start_unsupported',
    ],
    [
      'workflowId 与 repo/issue 不符',
      async () => (await register(112)).input,
      'task:example/canary#999',
      'start_identity_conflict',
    ],
    [
      '伪造 taskId（库里没有）',
      async () => ({ ...(await register(113)).input, taskId: randomUUID() }),
      'task:example/canary#113',
      'not_found',
    ],
    [
      '变输入：repo.id 换成别的仓（task 镜像不符）',
      async () => ({
        ...(await register(114)).input,
        repo: { ...repo, id: randomUUID() },
      }),
      'task:example/canary#114',
      'identity_conflict',
    ],
    [
      '变代次：输入自带 generation 与 workflowId 解析值不一致',
      async () => ({ ...(await register(115)).input, generation: 2 }),
      'task:example/canary#115',
      'start_identity_conflict',
    ],
    [
      '缺失/非法 Start 输入',
      async () => ({ ...(await register(116)).input, issueNumber: 'x' }),
      'task:example/canary#116',
      'invalid_start_input',
    ],
  ])(
    '确证拒绝：%s——TaskFlow 构造前终结，不退避、零业务、零准入',
    async (_name, input, workflowId, code) => {
      const q = `compat-deny-${randomUUID()}`;
      const c = compat(q);
      const body = (await input()) as Record<string, unknown>;
      const taskId = body.taskId as string;
      const handle = await withWorker(q, c.decide, async () => {
        const handle = await start(q, workflowId, body);
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
      expect(await admissionsOf(taskId)).toBe(0);
    },
    60_000,
  );

  it('已受管（有控制行）的 task 被 legacy Start 指向：managed_requires_operation，不降格也不改控制', async () => {
    const q = `compat-managed-${randomUUID()}`;
    const taskId = randomUUID();
    const birth: ManagedTaskBirthV1 = {
      protocolVersion: 1,
      birthRequestId: randomUUID(),
      coverageEpoch: randomUUID(),
      task: {
        id: taskId,
        repoId: repo.id,
        issueNumber: 121,
        title: 'm121',
        rawRequest: '',
        requestedBy: 'test',
      },
      namespace,
      workflowType: 'taskWorkflow',
      taskQueue: q,
    };
    expect(await store.createManagedTaskFromIssue(birth, audit)).toMatchObject({ kind: 'created' });
    const c = compat(q);
    await withWorker(q, c.decide, async () => {
      const handle = await start(q, 'task:example/canary#121', {
        schemaVersion: 1,
        taskId,
        repo,
        issueNumber: 121,
        title: 'm121',
      });
      const error = await handle.result().catch((e: unknown) => e);
      expect((error as WorkflowFailedError).cause).toMatchObject({
        type: EXECUTION_ADMISSION_DENIED,
        details: ['managed_requires_operation'],
      });
    });
    expect(c.inner).not.toHaveBeenCalled();
    expect(await admissionsOf(taskId)).toBe(0);
    expect(await store.getExecutionControl(taskId)).toMatchObject({ kind: 'managed', current: null });
  }, 60_000);

  it('未知（读/写不可用）：不判死不放行，15 秒退避，报警承接记下；恢复后下一轮才放行', async () => {
    const q = `compat-unknown-${randomUUID()}`;
    const item = await register(131);
    let calls = 0;
    const c = compat(q, { failAdmit: () => ++calls <= 3 });
    await withWorker(q, c.decide, async () => {
      const handle = await start(q, item.workflowId, item.input);
      await until(async () => (await hasTimer(handle)) !== undefined, '15 秒退避定时器');
      expect(Number((await hasTimer(handle))?.startToFireTimeout?.seconds)).toBe(15);
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
      expect(await admissionsOf(item.taskId)).toBe(0);
      await handle.result();
    });
    expect(await admissionsOf(item.taskId)).toBe(1);
  }, 90_000);

  it('Start 历史读不到（RPC 不可用）同样是未知：退避后才放行，不缓存放行', async () => {
    const q = `compat-history-${randomUUID()}`;
    const item = await register(132);
    let calls = 0;
    const c = compat(q, { failHistory: () => ++calls <= 3 });
    await withWorker(q, c.decide, async () => {
      const handle = await start(q, item.workflowId, item.input);
      await until(async () => (await hasTimer(handle)) !== undefined, '15 秒退避定时器');
      expect(c.inner).not.toHaveBeenCalled();
      expect(c.record).toHaveBeenCalledWith(
        expect.objectContaining({ firstCode: 'start_unavailable' }),
        expect.anything(),
      );
      expect(await admissionsOf(item.taskId)).toBe(0);
      await handle.result();
    });
    expect(await admissionsOf(item.taskId)).toBe(1);
  }, 90_000);

  it('未知且报警写也失败：仍只是未知，不放行、不判拒绝', async () => {
    const q = `compat-unknown-alert-${randomUUID()}`;
    const item = await register(133);
    const c = compat(q, { failAdmit: () => true, alertOutcome: 'unknown' });
    await withWorker(q, c.decide, async () => {
      const handle = await start(q, item.workflowId, item.input);
      await until(async () => (await hasTimer(handle)) !== undefined, '退避定时器');
      expect(c.record).toHaveBeenCalled();
      expect((await handle.describe()).status.name).toBe('RUNNING');
      expect(c.inner).not.toHaveBeenCalled();
      await handle.terminate('test');
    });
    expect(await admissionsOf(item.taskId)).toBe(0);
  }, 60_000);

  it('同请求幂等：事务已提交但回执丢了（未知），活动自重试重放同一责任，只一条责任一条审计', async () => {
    const q = `compat-idem-${randomUUID()}`;
    const item = await register(134);
    let calls = 0;
    const c = compat(q, { commitThenUnknown: () => ++calls === 1 });
    await withWorker(q, c.decide, async () => {
      const handle = await start(q, item.workflowId, item.input);
      await handle.result();
    });
    expect(c.admitSpy.mock.calls.length).toBeGreaterThanOrEqual(2);
    expect(await admissionsOf(item.taskId)).toBe(1);
    const audits = await t.client.query<{ n: number }>(
      "select count(*)::int as n from audit_log where action = 'task_execution.legacy_admit' and target = $1",
      [`task:${item.taskId}`],
    );
    expect(audits.rows[0]?.n).toBe(1);
  }, 60_000);

  it.each([true, false])(
    '准入进行中取消（admit %s 活动信号）：CancelledFailure 结束，不放行、不报警；迟到的 admit 结果不再放行',
    async (honorSignal) => {
      const q = `compat-cancel-${randomUUID()}`;
      const item = await register(honorSignal ? 135 : 136);
      let open!: () => void;
      const c = compat(q, {
        gate: { open: new Promise<void>((resolve) => (open = resolve)), honorSignal },
      });
      await withWorker(q, c.decide, async () => {
        const handle = await start(q, item.workflowId, item.input);
        await until(async () => c.admitSpy.mock.calls.length > 0, '准入开始');
        await handle.cancel();
        const error = await handle.result().catch((e: unknown) => e);
        expect(error).toBeInstanceOf(WorkflowFailedError);
        expect((error as WorkflowFailedError).cause).toBeInstanceOf(CancelledFailure);
        open();
        await sleep(1_000);
      });
      expect(c.inner).not.toHaveBeenCalled();
      expect(c.record).not.toHaveBeenCalled();
      // 取消后迟到提交的责任（若有）只会多保留，绝不释放或放行。
      expect(await admissionsOf(item.taskId)).toBeLessThanOrEqual(1);
    },
    60_000,
  );

  it('混部/回退：pre-A 起、兼容版收尾；兼容版起并准入、pre-A 收尾——命令序列与结果和单工人一致，不重新准入也不释放', async () => {
    const base = await register(141);
    const q0 = `compat-mixed-base-${randomUUID()}`;
    const baseline = await withWorker(q0, createDecide(), async () => {
      const handle = await start(q0, base.workflowId, { ...base.input, hold: true });
      await until(() => hasMarker(handle), 'limits 标记');
      await handle.signal('finish');
      return { result: await handle.result(), commands: await commandEvents(handle) };
    });

    // pre-A → 兼容版
    const forward = await register(142);
    const q1 = `compat-mixed-fwd-${randomUUID()}`;
    const c1 = compat(q1);
    const fwdHandle = await withWorker(q1, createDecide(), async () =>
      start(q1, forward.workflowId, { ...forward.input, hold: true }).then(async (h) => {
        await until(() => hasMarker(h), 'limits 标记');
        return h;
      }),
    );
    await withWorker(
      q1,
      c1.decide,
      async () => {
        await fwdHandle.signal('finish');
        expect(await fwdHandle.result()).toEqual(baseline.result);
      },
      { maxCachedWorkflows: 0 },
    );
    expect(await commandEvents(fwdHandle)).toEqual(baseline.commands);
    // 已录 limits 结果的旧 run：重放不再执行活动，不会被悄悄管理化（缺口留给后续旧 run 协议）。
    expect(c1.admitSpy).not.toHaveBeenCalled();
    expect(await admissionsOf(forward.taskId)).toBe(0);

    // 兼容版 → pre-A（回退）
    const back = await register(143);
    const q2 = `compat-mixed-back-${randomUUID()}`;
    const c2 = compat(q2);
    const backHandle = await withWorker(q2, c2.decide, async () => {
      const h = await start(q2, back.workflowId, { ...back.input, hold: true });
      await until(async () => (await admissionsOf(back.taskId)) === 1, '准入落库');
      await until(() => hasMarker(h), 'limits 标记');
      return h;
    });
    await withWorker(
      q2,
      createDecide(),
      async () => {
        await backHandle.signal('finish');
        expect(await backHandle.result()).toEqual(baseline.result);
      },
      { maxCachedWorkflows: 0 },
    );
    expect(await commandEvents(backHandle)).toEqual(baseline.commands);
    // 回退不释放已登记责任。
    expect(await admissionsOf(back.taskId)).toBe(1);
  }, 120_000);

  it('createEngineWorker 装配：移交循环随 worker.run 起一次、结束即停；准入经真实 worker 的 decide', async () => {
    const q = `compat-wired-${randomUUID()}`;
    const item = await register(152);
    const c = compat(q);
    const sink = { transferOne: vi.fn(async () => ({ kind: 'empty' }) as const) };
    const worker = await createEngineWorker({
      config: {
        ...configFromEnv({}),
        address: env.address,
        namespace,
        taskQueue: q,
        shutdownGraceSeconds: 1,
      },
      ports: createFakeWorld().ports,
      connection: env.nativeConnection,
      workflowBundle: bundle,
      admission: { admit: c.admit, alert: { record: c.record }, transfer: { sink, intervalMs: 100 } },
    });
    expect(sink.transferOne).not.toHaveBeenCalled();
    await worker.runUntil(async () => {
      const handle = await start(q, item.workflowId, item.input);
      await handle.result();
      await until(async () => sink.transferOne.mock.calls.length >= 2, '移交循环按间隔运转');
    });
    expect(await admissionsOf(item.taskId)).toBe(1);
    const stopped = sink.transferOne.mock.calls.length;
    await sleep(500);
    expect(sink.transferOne.mock.calls.length).toBe(stopped);
  }, 60_000);

  it('未来冻结 V1 候选的队列：兼容版与 pre-A 工人都不轮询它，Start 不被消费也不准入', async () => {
    const q = `compat-owned-${randomUUID()}`;
    const futureQueue = `v1-future-${randomUUID()}`;
    const item = await register(151);
    const c = compat(q);
    for (const decide of [c.decide, createDecide()])
      await withWorker(q, decide, async () => {
        const handle = await start(futureQueue, `${item.workflowId}:${randomUUID().slice(0, 4)}`, {
          ...item.input,
          execution: { protocolVersion: 1 },
        });
        await sleep(1_200);
        expect((await eventTypes(handle)).length).toBeLessThanOrEqual(2);
        expect(c.admitSpy).not.toHaveBeenCalled();
        await handle.terminate('test');
      });
    expect(await admissionsOf(item.taskId)).toBe(0);
  }, 60_000);
});

describe('可信终态收敛（真实 DescribeWorkflowExecution + PgStore CAS）', () => {
  const futureQueue = `v1-future-${randomUUID()}`;
  const release = (taskQueue: string) =>
    createExecutionRunRelease({
      reader: executionRunTerminalReader(connection),
      store,
      taskQueue,
      audit: { ...audit, reason: '终态收敛真实验证' },
    });

  /** 建一个受管任务，预留→派发→在「未来 V1 队列」真起 run→接纳精确 runId。 */
  async function admittedOperation(issue: number, type: 'taskWorkflow' | 'continueProbe' = 'taskWorkflow') {
    const taskId = randomUUID();
    const birth: ManagedTaskBirthV1 = {
      protocolVersion: 1,
      birthRequestId: randomUUID(),
      coverageEpoch: randomUUID(),
      task: {
        id: taskId,
        repoId: repo.id,
        issueNumber: issue,
        title: `v${issue}`,
        rawRequest: '',
        requestedBy: 'test',
      },
      namespace,
      workflowType: 'taskWorkflow',
      taskQueue: futureQueue,
    };
    const created = await store.createManagedTaskFromIssue(birth, audit);
    if (created.kind === 'rejected') throw new Error('出生被拒');
    const workflowId = `task:example/canary#${issue}`;
    const identity: ExecutionIdentity = {
      taskId,
      operationId: randomUUID(),
      coverageEpoch: birth.coverageEpoch,
      revision: 1,
      requestId: randomUUID(),
      nodeId: 'compat-test',
      kind: 'start',
      namespace,
      workflowId,
      generation: 1,
      workflowType: type,
      inputHash: 'sha256:test',
    };
    await store.reserveExecution({ ...identity, expectedRevision: 0 }, audit);
    await store.dispatchExecution(identity, audit);
    const handle = await start(futureQueue, workflowId, { hold: true }, type);
    const runId = handle.firstExecutionRunId;
    await store.admitExecution({ ...identity, runId }, audit);
    return { identity: { ...identity, runId }, handle, taskId };
  }
  const phaseOf = async (taskId: string) => {
    const read = await store.getExecutionControl(taskId);
    return read.kind === 'managed' ? (read.current?.phase ?? 'none') : read.kind;
  };

  it('运行中不释放；真实完成后凭精确 run 的 completed 释放，重放幂等；错 run/找不到不释放', async () => {
    const { identity, handle, taskId } = await admittedOperation(161);
    const worker = await Worker.create({
      connection: env.nativeConnection,
      namespace,
      taskQueue: futureQueue,
      workflowBundle: bundle,
      shutdownGraceTime: '1s',
      activities: { decide: createDecide() },
    });
    await worker.runUntil(async () => {
      const run = release(futureQueue);
      const signal = new AbortController().signal;
      await until(() => hasMarker(handle), 'V1 候选 run 在途');
      expect(await run(identity, signal)).toEqual({ kind: 'not_closed', status: 'running' });
      expect(await phaseOf(taskId)).toBe('admitted');
      // 找不到的 run（describe missing）与随便一个 runId：不释放，不碰 Store。
      expect(await run({ ...identity, runId: randomUUID() }, signal)).toEqual({
        kind: 'unknown',
        code: 'not_found',
      });
      // 队列/类型对不上也不背书。
      expect(await release('another-queue')(identity, signal)).toEqual({
        kind: 'unknown',
        code: 'identity_conflict',
      });
      expect(await run({ ...identity, workflowType: 'otherWorkflow' }, signal)).toEqual({
        kind: 'unknown',
        code: 'identity_conflict',
      });
      const aborted = new AbortController();
      aborted.abort();
      expect(await run(identity, aborted.signal)).toEqual({ kind: 'unknown', code: 'cancelled' });
      expect(await phaseOf(taskId)).toBe('admitted');
      await handle.signal('finish');
      await handle.result();
      expect(await run(identity, signal)).toEqual({ kind: 'released', terminal: 'completed' });
      expect(await run(identity, signal)).toEqual({ kind: 'replayed', terminal: 'completed' });
    });
    expect(await phaseOf(taskId)).toBe('none');
    const op = await t.client.query<{ resolved_reason: string; admitted_run_id: string }>(
      'select resolved_reason, admitted_run_id from task_execution_operations where task_id = $1',
      [taskId],
    );
    expect(op.rows).toEqual([{ resolved_reason: 'run_completed', admitted_run_id: identity.runId }]);
  }, 90_000);

  it('terminated 是真实终态可释放；ContinuedAsNew 的首个 run 虽已关闭但不释放', async () => {
    const killed = await admittedOperation(162);
    await killed.handle.terminate('compat-test');
    expect(await release(futureQueue)(killed.identity, new AbortController().signal)).toEqual({
      kind: 'released',
      terminal: 'terminated',
    });
    expect(await phaseOf(killed.taskId)).toBe('none');

    const continued = await admittedOperation(163, 'continueProbe');
    const worker = await Worker.create({
      connection: env.nativeConnection,
      namespace,
      taskQueue: futureQueue,
      workflowBundle: bundle,
      shutdownGraceTime: '1s',
      activities: { decide: createDecide() },
    });
    await worker.runUntil(async () => {
      await until(
        async () =>
          (
            await env.client.workflow
              .getHandle(continued.handle.workflowId, continued.identity.runId)
              .describe()
          ).status.name === 'CONTINUED_AS_NEW',
        '首个 run 进入 ContinuedAsNew',
      );
      expect(await release(futureQueue)(continued.identity, new AbortController().signal)).toEqual({
        kind: 'not_closed',
        status: 'continued_as_new',
      });
    });
    expect(await phaseOf(continued.taskId)).toBe('admitted');
  }, 90_000);
});
