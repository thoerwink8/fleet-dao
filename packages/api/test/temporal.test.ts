import type { Repo, Task } from '@fleet-dao/shared';
import { describe, expect, it } from 'vitest';
import type { BoardStore } from '../src/ports.ts';
import { WorkflowGoneError, WorkflowTargetNotFoundError, WorkflowUnavailableError } from '../src/ports.ts';
import {
  createEnginePollerCheck,
  createNamespaceCheck,
  createTemporalWorkflowControl,
  type EnginePollerSource,
  type NamespaceCheckClient,
  type PollerSnapshot,
  requirementWorkflowIdForTask,
  type TemporalClientLike,
} from '../src/temporal.ts';

function fakeClient(fail?: Error) {
  const sent: { workflowId: string; name: string; arg: unknown }[] = [];
  const client: TemporalClientLike = {
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

  it('发一次信号超过时限：按连不上处理（WorkflowUnavailableError），不是无限等下去', async () => {
    const neverResolves: TemporalClientLike = {
      workflow: { getHandle: () => ({ signal: () => new Promise(() => {}) }) },
    };
    const control = createTemporalWorkflowControl(neverResolves, 20);
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

  it('命名空间不存在（gRPC NOT_FOUND，状态码 5）：报红，写清是哪个命名空间', async () => {
    const client: NamespaceCheckClient = {
      async describeNamespace() {
        throw Object.assign(new Error('namespace fleet-nope is not found'), { code: 5 });
      },
    };
    await expect(createNamespaceCheck(client, 'fleet-nope')()).rejects.toMatchObject({
      name: 'PublicHealthError',
      code: 'namespace_not_found',
      message: expect.stringContaining('fleet-nope'),
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
    await expect(check()).rejects.toThrow(/activity 任务队列上没有 poller/);
  });

  it('缺 workflow 类的 poller：红，写明是 workflow', async () => {
    const check = createEnginePollerCheck(source({ workflow: [] }), () => NOW, FRESH_MS);
    await expect(check()).rejects.toThrow(/workflow 任务队列上没有 poller/);
  });

  it('poller 在，但最近一次拉活太旧：红', async () => {
    const stale = new Date(NOW.getTime() - 5 * 60_000);
    const check = createEnginePollerCheck(
      source({ workflow: [{ lastAccessAt: stale }] }),
      () => NOW,
      FRESH_MS,
    );
    await expect(check()).rejects.toThrow(/workflow poller 最近一次拉活是 5 分钟前/);
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
