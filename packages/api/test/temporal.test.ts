import {
  REQUIREMENT_WORKFLOW_TYPE,
  type Repo,
  type RequirementStartInput,
  requirementWorkflowId,
  type Task,
} from '@fleet-dao/shared';
import { WorkflowExecutionAlreadyStartedError } from '@temporalio/client';
import { describe, expect, it } from 'vitest';
import type { BoardStore } from '../src/ports.ts';
import { WorkflowGoneError, WorkflowTargetNotFoundError, WorkflowUnavailableError } from '../src/ports.ts';
import {
  createEnginePollerCheck,
  createNamespaceCheck,
  createTemporalRequirementWorkflows,
  createTemporalWorkflowControl,
  type EnginePollerSource,
  type NamespaceCheckClient,
  notConnectedTemporal,
  type PollerSnapshot,
  requirementWorkflowIdForTask,
  type TemporalClientLike,
  type WorkflowStarterLike,
} from '../src/temporal.ts';

/** withDeadline 透传给 fn：默认场景里连接本身不到点，只验证 signal 调用的成败。 */
function fakeClient(fail?: Error) {
  const sent: { workflowId: string; name: string; arg: unknown }[] = [];
  const client: TemporalClientLike = {
    connection: {
      async withDeadline(_deadline, fn) {
        return fn();
      },
    },
    workflow: {
      getHandle: (workflowId) => ({
        async signal(name, arg) {
          if (fail) throw fail;
          sent.push({ workflowId, name, arg });
        },
      }),
    },
  };
  return { client, sent };
}

describe('Temporal 信号', () => {
  it('按给定的工作流编号找到工作流，信号名就是 TaskSignal 的 name，其余字段是参数', async () => {
    const { client, sent } = fakeClient();
    const control = createTemporalWorkflowControl(client);
    await control.signal('task/t1', { name: 'reroute', by: 'u1', routeId: 'r2', subtaskId: 's1' });
    expect(sent).toEqual([
      { workflowId: 'task/t1', name: 'reroute', arg: { by: 'u1', routeId: 'r2', subtaskId: 's1' } },
    ]);
  });

  it('工作流不存在或已结束：WorkflowGoneError，带着是哪条工作流编号', async () => {
    const notFound = Object.assign(new Error('workflow not found for ID: task/t1'), {
      name: 'WorkflowNotFoundError',
    });
    const control = createTemporalWorkflowControl(fakeClient(notFound).client);
    await expect(control.signal('task/t1', { name: 'pause', by: 'u1' })).rejects.toBeInstanceOf(
      WorkflowGoneError,
    );
    await expect(control.signal('task/t1', { name: 'pause', by: 'u1' })).rejects.toMatchObject({
      workflowId: 'task/t1',
    });
  });

  it('连不上或超时（UNAVAILABLE / DEADLINE_EXCEEDED）：WorkflowUnavailableError，驾驶舱按它回 503', async () => {
    for (const message of [
      '14 UNAVAILABLE: no connection established',
      '4 DEADLINE_EXCEEDED: deadline exceeded',
    ]) {
      const control = createTemporalWorkflowControl(fakeClient(new Error(message)).client);
      await expect(control.signal('t1', { name: 'pause', by: 'u1' }), message).rejects.toBeInstanceOf(
        WorkflowUnavailableError,
      );
    }
  });

  it('连接本身到点：调用以 DEADLINE_EXCEEDED 失败（不是本地空等——调用发出去了，只是不再等它），按连不上处理', async () => {
    let calledFn = false;
    // 模拟 Connection.withDeadline 的真实行为：deadline 到点由连接本身判定失败，不是「答复来不来都不管」的本地竞速；
    // fn（真实场景里是那次 gRPC 调用）还是被调用了，只是这层不再等它决议。
    const timesOut: TemporalClientLike = {
      connection: {
        async withDeadline(_deadline, fn) {
          calledFn = true;
          void fn();
          throw Object.assign(new Error('4 DEADLINE_EXCEEDED: deadline exceeded'), { code: 4 });
        },
      },
      workflow: { getHandle: () => ({ signal: () => new Promise(() => {}) }) },
    };
    const control = createTemporalWorkflowControl(timesOut, 20);
    await expect(control.signal('t1', { name: 'pause', by: 'u1' })).rejects.toBeInstanceOf(
      WorkflowUnavailableError,
    );
    expect(calledFn).toBe(true);
  });

  it('真客户端把 gRPC 错误包成 ServiceError（原错误挂在 cause 上）：顺着 cause 认出连不上', async () => {
    const wrapped = new Error('Failed to signal Workflow', {
      cause: Object.assign(new Error('No connection established'), { code: 14 }),
    });
    const control = createTemporalWorkflowControl(fakeClient(wrapped).client);
    await expect(control.signal('t1', { name: 'pause', by: 'u1' })).rejects.toBeInstanceOf(
      WorkflowUnavailableError,
    );
  });

  it('别的错误原样抛，不装成上面两种', async () => {
    const boom = new Error('boom');
    const control = createTemporalWorkflowControl(fakeClient(boom).client);
    await expect(control.signal('t1', { name: 'pause', by: 'u1' })).rejects.toBe(boom);
  });
});

describe('拉起需求工作流（createTemporalRequirementWorkflows）', () => {
  const INPUT: RequirementStartInput = {
    schemaVersion: 1,
    taskId: 't1',
    repo: { id: 'r1', owner: 'acme', name: 'demo', defaultBranch: 'main', testCommand: 'pnpm check' },
    issueNumber: 12,
    title: '登录页加验证码',
    rawRequest: '给登录页加手机验证码',
    requestedBy: 'founder',
  };
  type StartCall = { workflowType: string; options: Parameters<WorkflowStarterLike['workflow']['start']>[1] };

  /** 像 Temporal 服务端那样按工作流编号去重：同一编号在跑就抛 WorkflowExecutionAlreadyStartedError。fail 给了就一律抛它。 */
  function fakeStarter(fail?: unknown) {
    const calls: StartCall[] = [];
    const running = new Set<string>();
    const client: WorkflowStarterLike = {
      connection: {
        async withDeadline(_deadline, fn) {
          return fn();
        },
      },
      workflow: {
        async start(workflowType, options) {
          calls.push({ workflowType, options });
          if (fail) throw fail;
          if (running.has(options.workflowId)) {
            throw new WorkflowExecutionAlreadyStartedError(
              'Workflow execution already started',
              options.workflowId,
              workflowType,
            );
          }
          running.add(options.workflowId);
          return {};
        },
      },
    };
    return { client, calls, finish: (id: string) => running.delete(id) };
  }

  it('按 requirementWorkflowId 起引擎的需求工作流：类型名、任务队列、输入原样、编号冲突报错、结束了的可以再起', async () => {
    const { client, calls } = fakeStarter();
    const requirements = createTemporalRequirementWorkflows(client, 'fleet-main');
    expect(await requirements.start(INPUT)).toBe('started');
    expect(calls).toEqual([
      {
        workflowType: REQUIREMENT_WORKFLOW_TYPE,
        options: {
          taskQueue: 'fleet-main',
          workflowId: requirementWorkflowId(INPUT.repo, 12),
          args: [INPUT],
          workflowIdConflictPolicy: 'FAIL',
          workflowIdReusePolicy: 'ALLOW_DUPLICATE',
        },
      },
    ]);
    expect(REQUIREMENT_WORKFLOW_TYPE).toBe('requirementWorkflow');
  });

  it('同一张 issue 再起一次（重投、重放）：already_running，不起第二条；上一条结束了（重开）就再起', async () => {
    const { client, finish } = fakeStarter();
    const requirements = createTemporalRequirementWorkflows(client, 'q');
    expect(await requirements.start(INPUT)).toBe('started');
    expect(await requirements.start({ ...INPUT, taskId: 't1-again' })).toBe('already_running');
    // 别的 issue 不受影响
    expect(await requirements.start({ ...INPUT, issueNumber: 13 })).toBe('started');
    finish(requirementWorkflowId(INPUT.repo, 12));
    expect(await requirements.start(INPUT)).toBe('started');
  });

  it('连不上（UNAVAILABLE，裸的或包在 ServiceError 的 cause 里）、超时（DEADLINE_EXCEEDED）：WorkflowUnavailableError，不回 started', async () => {
    const failures = [
      new Error('14 UNAVAILABLE: No connection established'),
      new Error('Failed to start Workflow', {
        cause: Object.assign(new Error('No connection established'), { code: 14 }),
      }),
      new Error('Failed to start Workflow', {
        cause: Object.assign(new Error('deadline exceeded'), { code: 4 }),
      }),
    ];
    for (const fail of failures) {
      const requirements = createTemporalRequirementWorkflows(fakeStarter(fail).client, 'q');
      await expect(requirements.start(INPUT), fail.message).rejects.toBeInstanceOf(WorkflowUnavailableError);
    }
  });

  it('连接本身到点（withDeadline 以 DEADLINE_EXCEEDED 失败）：WorkflowUnavailableError，带着是哪条工作流', async () => {
    const timesOut: WorkflowStarterLike = {
      connection: {
        async withDeadline() {
          throw Object.assign(new Error('4 DEADLINE_EXCEEDED: deadline exceeded'), { code: 4 });
        },
      },
      workflow: { start: () => new Promise(() => {}) },
    };
    const requirements = createTemporalRequirementWorkflows(timesOut, 'q', 20);
    await expect(requirements.start(INPUT)).rejects.toThrow(
      new WorkflowUnavailableError(
        `拉起需求工作流 ${requirementWorkflowId(INPUT.repo, 12)}：Temporal 连不上或没回应`,
      ),
    );
  });

  it('认不出的错原样抛，不当成起来了，也不当成已经在跑', async () => {
    const boom = new Error('namespace default is not found');
    await expect(createTemporalRequirementWorkflows(fakeStarter(boom).client, 'q').start(INPUT)).rejects.toBe(
      boom,
    );
    // 名字像、但不是客户端的那个类：不按名字猜成 already_running
    const lookalike = Object.assign(new Error('already started?'), {
      name: 'WorkflowExecutionAlreadyStartedError',
    });
    await expect(
      createTemporalRequirementWorkflows(fakeStarter(lookalike).client, 'q').start(INPUT),
    ).rejects.toBe(lookalike);
  });

  it('还没接上 Temporal：拉起一律 WorkflowUnavailableError', async () => {
    await expect(notConnectedTemporal().requirements.start(INPUT)).rejects.toBeInstanceOf(
      WorkflowUnavailableError,
    );
  });
});

describe('requirementWorkflowIdForTask：任务的需求工作流编号查库拼，查不到就明确抛错', () => {
  const TASK: Task = {
    id: 't1',
    repoId: 'r1',
    issueNumber: 7,
    title: '标题',
    rawRequest: '原话',
    requestedBy: 'u1',
    state: 'running',
    priority: 1,
    createdAt: '2026-09-25T00:00:00.000Z',
  };
  const REPO: Repo = {
    id: 'r1',
    owner: 'acme',
    name: 'demo',
    defaultBranch: 'main',
    testCommand: 'pnpm check',
  };

  function fakeStore(
    overrides: Partial<Pick<BoardStore, 'getTask' | 'getRepo'>> = {},
  ): Pick<BoardStore, 'getTask' | 'getRepo'> {
    return {
      getTask: overrides.getTask ?? (async () => null),
      getRepo: overrides.getRepo ?? (async () => null),
    };
  }

  it('查得到任务和仓：拼成 req:owner/name#issueNumber', async () => {
    const store = fakeStore({
      getTask: async (id) => (id === 't1' ? TASK : null),
      getRepo: async (id) => (id === 'r1' ? REPO : null),
    });
    expect(await requirementWorkflowIdForTask(store, 't1')).toBe('req:acme/demo#7');
  });

  it('任务查不到：明确抛 WorkflowTargetNotFoundError，不瞎拼', async () => {
    const store = fakeStore();
    await expect(requirementWorkflowIdForTask(store, 'missing')).rejects.toBeInstanceOf(
      WorkflowTargetNotFoundError,
    );
  });

  it('任务在，但它所在的仓查不到：也明确抛错，不瞎拼', async () => {
    const store = fakeStore({ getTask: async (id) => (id === 't1' ? TASK : null) });
    await expect(requirementWorkflowIdForTask(store, 't1')).rejects.toBeInstanceOf(
      WorkflowTargetNotFoundError,
    );
  });
});

describe('createNamespaceCheck：命名空间查不到归成安全的红，别的错误原样抛', () => {
  it('查得到：过', async () => {
    const client: NamespaceCheckClient = { async describeNamespace() {} };
    await expect(createNamespaceCheck(client, 'fleet')()).resolves.toBeUndefined();
  });

  it('命名空间不存在（gRPC NOT_FOUND，状态码 5）：报红；对外一句中性话，哪个命名空间只进日志', async () => {
    const client: NamespaceCheckClient = {
      async describeNamespace() {
        throw Object.assign(new Error('namespace fleet-nope is not found'), { code: 5 });
      },
    };
    await expect(createNamespaceCheck(client, 'fleet-nope')()).rejects.toMatchObject({
      name: 'PublicHealthError',
      code: 'namespace_not_found',
      message: expect.not.stringContaining('fleet-nope'),
      detail: expect.stringContaining('fleet-nope'),
    });
  });

  it('连不上、超时等别的错误：原样抛，不装成「命名空间不存在」', async () => {
    const boom = Object.assign(new Error('14 UNAVAILABLE'), { code: 14 });
    const client: NamespaceCheckClient = {
      async describeNamespace() {
        throw boom;
      },
    };
    await expect(createNamespaceCheck(client, 'fleet')()).rejects.toBe(boom);
  });
});

describe('createEnginePollerCheck：FLEET_TASK_QUEUE 上 workflow、activity 两类 poller 都要有、都要新鲜', () => {
  const NOW = new Date('2026-09-25T08:00:00Z');
  const FRESH_MS = 2 * 60 * 1000;

  function source(
    overrides: Partial<Record<'workflow' | 'activity', PollerSnapshot[]>> = {},
  ): EnginePollerSource {
    return {
      async listPollers(kind) {
        return overrides[kind] ?? [{ lastAccessAt: new Date(NOW) }];
      },
    };
  }

  it('两类都有且新鲜：过', async () => {
    const check = createEnginePollerCheck(source(), () => NOW, FRESH_MS);
    await expect(check()).resolves.toBeUndefined();
  });

  it('缺 activity 类的 poller：红，写明是 activity', async () => {
    const check = createEnginePollerCheck(source({ activity: [] }), () => NOW, FRESH_MS);
    await expect(check()).rejects.toMatchObject({
      code: 'engine_offline',
      detail: expect.stringMatching(/activity 任务队列上没有 poller/),
    });
  });

  it('缺 workflow 类的 poller：红，写明是 workflow', async () => {
    const check = createEnginePollerCheck(source({ workflow: [] }), () => NOW, FRESH_MS);
    await expect(check()).rejects.toMatchObject({
      code: 'engine_offline',
      detail: expect.stringMatching(/workflow 任务队列上没有 poller/),
    });
  });

  it('poller 在，但最近一次拉活太旧：红', async () => {
    const stale = new Date(NOW.getTime() - 5 * 60_000);
    const check = createEnginePollerCheck(
      source({ workflow: [{ lastAccessAt: stale }] }),
      () => NOW,
      FRESH_MS,
    );
    await expect(check()).rejects.toMatchObject({
      detail: expect.stringMatching(/workflow poller 最近一次拉活是 5 分钟前/),
    });
  });

  it('查任务队列本身报错：红（不是「没查成」当绿）', async () => {
    const failing: EnginePollerSource = {
      async listPollers() {
        throw new Error('Temporal 连不上');
      },
    };
    const check = createEnginePollerCheck(failing, () => NOW, FRESH_MS);
    await expect(check()).rejects.toThrow('Temporal 连不上');
  });
});
