import { randomUUID } from 'node:crypto';
import {
  canonicalExecutionInput,
  createMemoryStore,
  type ExecutionAudit,
  executionInputHash,
  type TaskExecutionStore,
} from '@fleet-dao/store';
import type { Info } from '@temporalio/activity';
import { defaultPayloadConverter } from '@temporalio/common';
import { MockActivityEnvironment } from '@temporalio/testing';
import { describe, expect, it, vi } from 'vitest';
import {
  createLegacyExecutionAdmission,
  type LegacySourceAdmission,
} from '../src/real/execution-legacy-admission.ts';
import {
  EXECUTION_HISTORY_MAX_BYTES,
  type ExecutionHistoryConnection,
} from '../src/real/execution-start-reader.ts';
import type { BoundedLegacyAdmission } from '../src/real/legacy-admission-protocol.ts';

type History = Partial<
  Awaited<ReturnType<ExecutionHistoryConnection['workflowService']['getWorkflowExecutionHistory']>>
>;
type EventId = NonNullable<NonNullable<NonNullable<History['history']>['events']>[number]['eventId']>;
const TASK = '10000000-0000-4000-8000-000000000001';
const REPO = '20000000-0000-4000-8000-000000000001';
const RUN = '30000000-0000-4000-8000-000000000001';
const audit: ExecutionAudit = {
  actor: { kind: 'user', id: '40000000-0000-4000-8000-000000000001' },
  via: 'agent',
  reason: 'legacy 来源隔离测试',
};
const repo = { id: REPO, owner: 'example', name: 'canary', defaultBranch: 'main', testCommand: 'pnpm check' };
const startInput = (over: Record<string, unknown> = {}) => ({
  schemaVersion: 1,
  taskId: TASK,
  repo,
  issueNumber: 12,
  title: '  原始标题\n',
  extra: { body: '  私有完整正文\n', items: [3, null, 'first'] },
  ...over,
});
function history(input: unknown = startInput()): History {
  return {
    history: {
      events: [
        {
          eventId: { toString: () => '1' } as EventId,
          eventType: 1,
          workflowExecutionStartedEventAttributes: {
            workflowType: { name: 'taskWorkflow' },
            taskQueue: { name: 'legacy' },
            input: { payloads: [defaultPayloadConverter.toPayload(input)] },
          },
        },
      ],
    },
  };
}
function setup(input: unknown = startInput(), info: Partial<Info> = {}, notifyFails = false) {
  const store = createMemoryStore(
    {
      repos: [{ ...repo, owner: 'renamed-owner', name: 'renamed-repo' }],
      tasks: [
        {
          id: TASK,
          repoId: REPO,
          issueNumber: 12,
          title: '当前已修改标题',
          rawRequest: '',
          requestedBy: 'test',
          state: 'queued',
          priority: 0,
          createdAt: '2026-10-20T00:00:00.000Z',
        },
      ],
    },
    {
      onChange: () => {
        if (notifyFails) throw new Error('private notification');
      },
    },
  );
  const rpc = vi.fn(async (): Promise<History> => history(input));
  const connection = {
    options: {
      interceptors: [],
      channelArgs: { 'grpc.max_receive_message_length': EXECUTION_HISTORY_MAX_BYTES },
    },
    workflowService: { getWorkflowExecutionHistory: rpc },
    withDeadline: async <T>(_deadline: unknown, fn: () => Promise<T>) => fn(),
    withAbortSignal: async <T>(_signal: AbortSignal, fn: () => Promise<T>) => fn(),
  } as unknown as ExecutionHistoryConnection;
  const admit = vi.fn(store.admitLegacyExecution.bind(store));
  const bounded = vi.fn<BoundedLegacyAdmission>(async (input, audit) => {
    const result = await admit(input, audit);
    return result.kind === 'rejected'
      ? { kind: 'denied', code: result.reason }
      : {
          kind: 'allowed',
          status: result.kind,
          admissionId: result.admission.id,
          postCommitWarnings: result.postCommitWarnings,
        };
  });
  const env = new MockActivityEnvironment({
    namespace: 'test',
    activityNamespace: 'test',
    workflowNamespace: 'test',
    taskQueue: 'legacy',
    isLocal: true,
    activityType: 'decide',
    workflowType: 'taskWorkflow',
    workflowExecution: { workflowId: 'task:example/canary#12', runId: RUN },
    ...info,
  });
  const deps = {
    connection,
    admit: bounded,
    namespace: 'test',
    taskQueue: 'legacy',
    audit,
  };
  const entry = createLegacyExecutionAdmission(deps);
  return {
    store,
    rpc,
    connection,
    admit,
    bounded,
    env,
    deps,
    entry,
    run: () => env.run<[], LegacySourceAdmission, typeof entry>(entry),
  };
}

describe('可信 legacy 来源适配器（未接生产）', () => {
  it('无 Activity Context 明确未知，零历史读取和写库', async () => {
    const s = setup();
    expect(s.entry.length).toBe(0);
    expect(await s.entry()).toEqual({ kind: 'unknown', code: 'missing_context' });
    expect(s.rpc).not.toHaveBeenCalled();
    expect(s.admit).not.toHaveBeenCalled();
  });

  it.each<Partial<Info>>([
    { isLocal: false },
    { activityType: 'other' },
    { namespace: 'other' },
    { workflowNamespace: 'other' },
    { taskQueue: 'other' },
    { workflowType: 'other' },
    { workflowExecution: { workflowId: '', runId: RUN } },
    {
      workflowExecution: {
        workflowId: 'task:example/canary#12',
        runId: RUN.toUpperCase().replace('3000', 'ABCD'),
      },
    },
  ])('不符真实活动身份时零 IO：%j', async (info) => {
    const s = setup(startInput(), info);
    expect(await s.run()).toEqual({ kind: 'unknown', code: 'invalid_activity_context' });
    expect(s.rpc).not.toHaveBeenCalled();
    expect(s.admit).not.toHaveBeenCalled();
  });

  it('精确 run 读取完整原始输入，镜像改名改标题不重构身份；同 run 重送只登记一份', async () => {
    const input = startInput();
    const s = setup(input);
    const first = await s.run();
    expect(first).toMatchObject({ kind: 'allowed', status: 'admitted', postCommitWarnings: [] });
    expect(await s.run()).toEqual({ ...first, status: 'replayed' });
    expect(s.rpc).toHaveBeenCalledWith({
      namespace: 'test',
      execution: {
        workflowId: 'task:example/canary#12',
        runId: RUN,
      },
      maximumPageSize: 1,
      nextPageToken: new Uint8Array(),
      waitNewEvent: false,
      skipArchival: true,
    });
    expect(s.store.data.legacyExecutionAdmissions.size).toBe(1);
    expect(s.store.data.audit).toHaveLength(1);
    const admission = [...s.store.data.legacyExecutionAdmissions.values()][0];
    expect(admission).toMatchObject({
      taskId: TASK,
      namespace: 'test',
      runId: RUN,
      generation: 1,
      operation: 'legacy_first_limits',
      workflowId: 'task:example/canary#12',
      workflowType: 'taskWorkflow',
      taskQueue: 'legacy',
      inputCanonical: canonicalExecutionInput(input),
      inputHash: executionInputHash(canonicalExecutionInput(input)),
    });
    expect(s.admit.mock.calls[0]?.[0]).not.toHaveProperty('isLocal');
    expect(JSON.stringify(first)).not.toContain('私有完整正文');
    expect(JSON.stringify(s.store.data.audit)).not.toContain('私有完整正文');
  });

  it('r2 可从真实 workflowId 推导代次，不依赖可选 generation；不同 run 责任并存', async () => {
    const s = setup(startInput(), {
      workflowExecution: { workflowId: 'task:example/canary#12:r2', runId: randomUUID() },
    });
    expect(await s.run()).toMatchObject({ kind: 'allowed', status: 'admitted' });
    expect([...s.store.data.legacyExecutionAdmissions.values()][0]?.generation).toBe(2);
    const secondEnv = new MockActivityEnvironment({
      ...s.env.context.info,
      workflowExecution: { workflowId: 'task:example/canary#12:r2', runId: randomUUID() },
    });
    expect(await secondEnv.run(s.entry)).toMatchObject({ kind: 'allowed', status: 'admitted' });
    expect(s.store.data.legacyExecutionAdmissions.size).toBe(2);
  });

  it.each([
    'task:example/canary#12:r1',
    'task:example/canary#012',
    'task:example/canary#12:r21',
    'task:example/canary#13',
    'task:example/canary#12:park:1',
    'task:other/canary#12',
  ])('拒绝不规范或不对应的 workflowId：%s', async (workflowId) => {
    const s = setup(startInput(), { workflowExecution: { workflowId, runId: RUN } });
    expect(await s.run()).toEqual({ kind: 'denied', code: 'start_identity_conflict' });
    expect(s.admit).not.toHaveBeenCalled();
  });

  it.each([null, {}, { version: 99 }, { operationId: RUN }])(
    '保留 execution 字段不可降格为 legacy：%j',
    async (execution) => {
      const s = setup(startInput({ execution }));
      expect(await s.run()).toEqual({ kind: 'denied', code: 'managed_start_unsupported' });
      expect(s.admit).not.toHaveBeenCalled();
    },
  );

  it('未来 schema 明确未知；代次不符明确拒绝；基本形状不合明确拒绝', async () => {
    expect(await setup(startInput({ schemaVersion: 2 })).run()).toEqual({
      kind: 'unknown',
      code: 'unsupported_schema',
    });
    expect(await setup(startInput({ generation: 2 })).run()).toEqual({
      kind: 'denied',
      code: 'start_identity_conflict',
    });
    expect(await setup(startInput({ issueNumber: 0 })).run()).toEqual({
      kind: 'denied',
      code: 'invalid_start_input',
    });
  });

  it('同 run 输入改变不重放；不同 task、repo 或 issue 持久归属不一致不准入', async () => {
    const s = setup();
    await s.run();
    s.rpc.mockImplementation(async () => history(startInput({ title: '篡改后的 Start' })));
    expect(await s.run()).toEqual({ kind: 'denied', code: 'identity_conflict' });
    expect(s.store.data.legacyExecutionAdmissions.size).toBe(1);
    expect(s.store.data.audit).toHaveLength(1);
    expect(await setup(startInput({ taskId: randomUUID() })).run()).toEqual({
      kind: 'denied',
      code: 'not_found',
    });
    expect(await setup(startInput({ repo: { ...repo, id: randomUUID() } })).run()).toEqual({
      kind: 'denied',
      code: 'identity_conflict',
    });
    const issue = setup();
    const task = issue.store.data.tasks[0];
    if (!task) throw new Error('fixture 缺少 task');
    task.issueNumber = 13;
    expect(await issue.run()).toEqual({ kind: 'denied', code: 'identity_conflict' });
  });

  it('已受管任务不能走无 operation 的 legacy 路径', async () => {
    const s = setup();
    s.store.data.executionControls.set(TASK, {
      taskId: TASK,
      protocolVersion: 1,
      coverageEpoch: randomUUID(),
      revision: 0,
      currentOperationId: null,
    });
    expect(await s.run()).toEqual({ kind: 'denied', code: 'managed_requires_operation' });
    expect(s.store.data.legacyExecutionAdmissions.size).toBe(0);
  });

  it('通知失败明确返回提交后告警，不把已登记责任伪装成失败；重放不重发', async () => {
    const s = setup(startInput(), {}, true);
    expect(await s.run()).toMatchObject({
      kind: 'allowed',
      status: 'admitted',
      postCommitWarnings: [{ code: 'notification_failed', table: 'audit_log' }],
    });
    expect(await s.run()).toMatchObject({ kind: 'allowed', status: 'replayed', postCommitWarnings: [] });
    expect(s.store.data.audit).toHaveLength(1);
  });

  it.each([
    [5, 'not_found'],
    [8, 'limit'],
    [4, 'deadline'],
    [14, 'unavailable'],
  ] as const)('RPC 错误 %i 保持明确未知且不泄漏原文', async (code, suffix) => {
    const s = setup();
    s.rpc.mockRejectedValue(
      Object.assign(new Error('private Start text'), { code, details: 'private Start text', metadata: {} }),
    );
    expect(await s.run()).toEqual({ kind: 'unknown', code: `start_${suffix}` });
    expect(s.admit).not.toHaveBeenCalled();
  });

  it('读不到历史、坏 payload、Start 队列冲突各自保留语义', async () => {
    const missing = setup();
    missing.rpc.mockResolvedValue({});
    expect(await missing.run()).toEqual({ kind: 'unknown', code: 'start_malformed_history' });
    const bad = setup([]);
    expect(await bad.run()).toEqual({ kind: 'unknown', code: 'start_decode_failed' });
    const conflict = setup();
    const response = history();
    const queue = response.history?.events?.[0]?.workflowExecutionStartedEventAttributes?.taskQueue;
    if (!queue) throw new Error('fixture 缺少 Start queue');
    queue.name = 'other';
    conflict.rpc.mockResolvedValue(response);
    expect(await conflict.run()).toEqual({ kind: 'denied', code: 'start_identity_conflict' });
    for (const s of [missing, bad, conflict]) expect(s.admit).not.toHaveBeenCalled();
  });

  it('Store 异常返回未知，不泄漏私有 Start 或异常原文', async () => {
    const s = setup();
    s.admit.mockRejectedValue(new Error('private Start text'));
    expect(await s.run()).toEqual({ kind: 'unknown', code: 'store_unavailable' });
  });

  it('解码后出现非有限数，完整 canonical 失败而不是丢字段后准入', async () => {
    const s = setup();
    const response = history();
    const payload =
      response.history?.events?.[0]?.workflowExecutionStartedEventAttributes?.input?.payloads?.[0];
    if (!payload) throw new Error('fixture 缺少 Start payload');
    payload.data = Buffer.from(
      JSON.stringify(startInput()).replace('"items":[3,null,"first"]', '"items":[1e400,null,"first"]'),
    );
    s.rpc.mockResolvedValue(response);
    expect(await s.run()).toEqual({ kind: 'unknown', code: 'canonical_failed' });
    expect(s.admit).not.toHaveBeenCalled();
  });

  it('建厂后不再从可变 deps 读取身份和审计归属', async () => {
    const s = setup();
    s.deps.namespace = 'other';
    s.deps.taskQueue = 'other';
    s.deps.audit = { ...audit, reason: 'changed' };
    expect(await s.run()).toMatchObject({ kind: 'allowed', status: 'admitted' });
    expect(s.store.data.audit[0]?.reason).toBe(audit.reason);
  });

  it('预取消零 IO，读取途中取消不再登记', async () => {
    const before = setup();
    before.env.cancel();
    expect(await before.run()).toEqual({ kind: 'unknown', code: 'cancelled' });
    expect(before.rpc).not.toHaveBeenCalled();
    const during = setup();
    during.rpc.mockImplementation(async () => {
      during.env.cancel();
      return history();
    });
    expect(await during.run()).toEqual({ kind: 'unknown', code: 'cancelled' });
    expect(during.admit).not.toHaveBeenCalled();
  });

  it('在途 SQL 取消后迟到提交保留责任，不能返回允许或声称回滚', async () => {
    const s = setup();
    let release!: () => void;
    let entered!: () => void;
    const waiting = new Promise<void>((resolve) => {
      release = resolve;
    });
    const started = new Promise<void>((resolve) => {
      entered = resolve;
    });
    s.admit.mockImplementation(async (...args: Parameters<TaskExecutionStore['admitLegacyExecution']>) => {
      entered();
      await waiting;
      return s.store.admitLegacyExecution(...args);
    });
    const result = s.run();
    await started;
    s.env.cancel();
    release();
    expect(await result).toEqual({ kind: 'unknown', code: 'cancelled' });
    expect(s.store.data.legacyExecutionAdmissions.size).toBe(1);
    expect(s.store.data.audit).toHaveLength(1);
  });

  it('提交成功但活动收到取消时仍返回未知，已持久责任不删除', async () => {
    const s = setup();
    s.admit.mockImplementation(async (...args) => {
      const result = await s.store.admitLegacyExecution(...args);
      s.env.cancel();
      return result;
    });
    expect(await s.run()).toEqual({ kind: 'unknown', code: 'cancelled' });
    expect(s.store.data.legacyExecutionAdmissions.size).toBe(1);
  });

  it('配置身份、默认重试和接收限额不合时建厂即拒绝', () => {
    const s = setup();
    expect(() => createLegacyExecutionAdmission({ ...s.deps, namespace: ' test' })).toThrow();
    expect(() => createLegacyExecutionAdmission({ ...s.deps, taskQueue: '' })).toThrow();
    const options = s.connection.options as {
      interceptors?: unknown[];
      channelArgs: Record<string, unknown>;
    };
    delete options.interceptors;
    expect(() => createLegacyExecutionAdmission(s.deps)).toThrow(/禁默认重试/);
    options.interceptors = [() => undefined];
    expect(() => createLegacyExecutionAdmission(s.deps)).toThrow(/禁默认重试/);
    options.interceptors = [];
    options.channelArgs['grpc.max_receive_message_length'] = EXECUTION_HISTORY_MAX_BYTES + 1;
    expect(() => createLegacyExecutionAdmission(s.deps)).toThrow(/接收上限/);
  });

  it('History耗时不重置SQL预算，墙钟回拨不重新获得时间', async () => {
    const s = setup();
    let mono = 1000;
    const monoClock = vi.spyOn(performance, 'now').mockImplementation(() => mono);
    const wallClock = vi.spyOn(Date, 'now').mockReturnValue(100_000);
    try {
      s.rpc.mockImplementation(async () => {
        mono += 4000;
        wallClock.mockReturnValue(1);
        return history();
      });
      expect(await s.run()).toMatchObject({ kind: 'allowed' });
      expect(s.bounded.mock.calls[0]?.[2].deadlineAt).toBe(11_000);
      expect(s.bounded.mock.calls[0]?.[2].signal).toBeInstanceOf(AbortSignal);
    } finally {
      monoClock.mockRestore();
      wallClock.mockRestore();
    }
  });
  it('History已用尽运行预算时不spawn/登记，也不把超时变成denied', async () => {
    const s = setup();
    let mono = 1000;
    const clock = vi.spyOn(performance, 'now').mockImplementation(() => mono);
    try {
      s.rpc.mockImplementation(async () => {
        mono += 9001;
        return history();
      });
      expect(await s.run()).toEqual({ kind: 'unknown', code: 'deadline' });
      expect(s.bounded).not.toHaveBeenCalled();
    } finally {
      clock.mockRestore();
    }
  });
  it('History即使不响应取消也在本机5秒边界返回未知，绝不登记', async () => {
    const s = setup();
    vi.useFakeTimers();
    try {
      s.rpc.mockImplementation(() => new Promise(() => {}));
      const run = s.run();
      await vi.advanceTimersByTimeAsync(5001);
      expect(await run).toEqual({ kind: 'unknown', code: 'start_deadline' });
      expect(s.bounded).not.toHaveBeenCalled();
    } finally {
      vi.useRealTimers();
    }
  });
});
