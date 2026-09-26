// 会话生命周期：起、开工、结束、叫停，外加起会话要的两个事实查询。
import { randomUUID } from 'node:crypto';
import { eq } from 'drizzle-orm';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import {
  finishSessionRun,
  getSessionRun,
  latestRunOfSession,
  markSessionRunStarted,
  openSessionRun,
  openSessionRuns,
  requestSessionStop,
  routeLaunchFacts,
  routeOutcomesSince,
  taskContext,
} from '../src/queries/engine.ts';
import { pools } from '../src/schema/index.ts';
import { createTestDb, resetTestDb, TEST_DB_TIMEOUT_MS, type TestDb } from '../src/testing.ts';
import {
  addRepo,
  addRoute,
  addTask,
  ago,
  catalog,
  expectViolation,
  HOUR,
  later,
  MIN,
  NOW,
} from './helpers.ts';

let t: TestDb;
beforeAll(async () => {
  t = await createTestDb();
}, TEST_DB_TIMEOUT_MS);
afterAll(() => t.close());
beforeEach(async () => {
  await resetTestDb(t);
  await catalog(t.db);
  await addRoute(t.db, { id: 'r1', poolId: 'relay-a', modelId: 'opus-5.5' });
});

const runId = () => randomUUID();

describe('openSessionRun', () => {
  it('起一次会话；session_stops 还没有就是 null', async () => {
    const repo = await addRepo(t.db);
    const task = await addTask(t.db, repo.id);
    const id = runId();
    const { created, run } = await openSessionRun(t.db, {
      id,
      taskId: task.id,
      subtaskId: null,
      stage: 'execute',
      routeId: 'r1',
      whyRoute: '首选',
      branch: 'task/1-x',
      queuedAt: NOW,
      workflowId: 'wf-1',
      runAsUser: 'fleet-agent-carpool',
      worktreePath: '/work/1',
    });
    expect(created).toBe(true);
    expect(run).toEqual({
      id,
      taskId: task.id,
      subtaskId: null,
      stage: 'execute',
      routeId: 'r1',
      branch: 'task/1-x',
      sessionId: null,
      workflowId: 'wf-1',
      runAsUser: 'fleet-agent-carpool',
      worktreePath: '/work/1',
      handle: null,
      queuedAt: NOW,
      startedAt: null,
      endedAt: null,
      outcome: null,
      failureCode: null,
      failureMessage: null,
      contextTokens: null,
      sessionCostUsd: null,
      stopRequested: null,
    });
  });

  it('按 id 幂等：重复调用不插第二行，原样返回第一次的', async () => {
    const repo = await addRepo(t.db);
    const task = await addTask(t.db, repo.id);
    const id = runId();
    const first = await openSessionRun(t.db, {
      id,
      taskId: task.id,
      subtaskId: null,
      stage: 'execute',
      routeId: 'r1',
      whyRoute: '首选',
      branch: null,
      queuedAt: NOW,
      workflowId: null,
      runAsUser: null,
      worktreePath: null,
    });
    const second = await openSessionRun(t.db, {
      id,
      taskId: task.id,
      subtaskId: null,
      stage: 'execute',
      routeId: 'r1',
      whyRoute: '换了个理由也不会覆盖',
      branch: 'task/should-not-land',
      queuedAt: later(HOUR),
      workflowId: 'wf-late',
      runAsUser: 'fleet-agent-carpool',
      worktreePath: '/work/late',
    });
    expect(second.created).toBe(false);
    expect(second.run).toEqual(first.run);
  });

  it('外键不满足（任务不在库里）照常抛，不吞', async () => {
    await expectViolation(
      openSessionRun(t.db, {
        id: runId(),
        taskId: randomUUID(),
        subtaskId: null,
        stage: 'execute',
        routeId: 'r1',
        whyRoute: '首选',
        branch: null,
        queuedAt: NOW,
        workflowId: null,
        runAsUser: null,
        worktreePath: null,
      }),
      'session_runs_task_id_tasks_id_fk',
    );
  });

  it('叫停请求可以先于这一行插入；起会话后原样带出 stopRequested', async () => {
    const id = runId();
    await requestSessionStop(t.db, { runId: id, reason: '帅位手动叫停', at: NOW });
    const { created, run } = await openSessionRun(t.db, {
      id,
      taskId: null,
      subtaskId: null,
      stage: 'judge',
      routeId: 'r1',
      whyRoute: '考新模型',
      branch: null,
      queuedAt: NOW,
      workflowId: null,
      runAsUser: null,
      worktreePath: null,
    });
    expect(created).toBe(true);
    expect(run.stopRequested).toEqual({ at: NOW, reason: '帅位手动叫停' });
    expect(await getSessionRun(t.db, id)).toEqual(run);
  });
});

describe('requestSessionStop', () => {
  it('重复调用不报错（第一次的请求算数）', async () => {
    const id = runId();
    await requestSessionStop(t.db, { runId: id, reason: '第一次', at: NOW });
    await expect(
      requestSessionStop(t.db, { runId: id, reason: '第二次', at: later(MIN) }),
    ).resolves.toBeUndefined();
    const { run } = await openSessionRun(t.db, {
      id,
      taskId: null,
      subtaskId: null,
      stage: 'judge',
      routeId: 'r1',
      whyRoute: '考新模型',
      branch: null,
      queuedAt: NOW,
      workflowId: null,
      runAsUser: null,
      worktreePath: null,
    });
    expect(run.stopRequested).toEqual({ at: NOW, reason: '第一次' });
  });
});

describe('getSessionRun', () => {
  it('不存在回 null', async () => {
    expect(await getSessionRun(t.db, randomUUID())).toBeNull();
  });
});

describe('markSessionRunStarted', () => {
  async function openRun(id: string) {
    return openSessionRun(t.db, {
      id,
      taskId: null,
      subtaskId: null,
      stage: 'judge',
      routeId: 'r1',
      whyRoute: '考新模型',
      branch: null,
      queuedAt: NOW,
      workflowId: null,
      runAsUser: null,
      worktreePath: null,
    });
  }

  it('写 started_at、session_id、handle', async () => {
    const id = runId();
    await openRun(id);
    const result = await markSessionRunStarted(t.db, {
      id,
      startedAt: later(MIN),
      sessionId: 'claude-session-1',
      handle: { pid: 4321, scope: `fleet-agent-${id}.scope` },
    });
    expect(result).toBe('ok');
    const run = await getSessionRun(t.db, id);
    expect(run?.startedAt).toEqual(later(MIN));
    expect(run?.sessionId).toBe('claude-session-1');
    expect(run?.handle).toEqual({ pid: 4321, scope: `fleet-agent-${id}.scope` });
  });

  it('已经开工过：不倒退 started_at，但 session_id、handle 照样覆盖', async () => {
    const id = runId();
    await openRun(id);
    await markSessionRunStarted(t.db, { id, startedAt: later(MIN), sessionId: 's1', handle: { pid: 1 } });
    await markSessionRunStarted(t.db, { id, startedAt: later(2 * MIN), sessionId: 's2', handle: { pid: 2 } });
    const run = await getSessionRun(t.db, id);
    expect(run?.startedAt).toEqual(later(MIN));
    expect(run?.sessionId).toBe('s2');
    expect(run?.handle).toEqual({ pid: 2 });
  });

  it('行不在回 not_found', async () => {
    expect(
      await markSessionRunStarted(t.db, { id: randomUUID(), startedAt: NOW, sessionId: 's1', handle: null }),
    ).toBe('not_found');
  });
});

describe('finishSessionRun', () => {
  async function openAndStart(id: string, startedAt = later(MIN)) {
    await openSessionRun(t.db, {
      id,
      taskId: null,
      subtaskId: null,
      stage: 'judge',
      routeId: 'r1',
      whyRoute: '考新模型',
      branch: null,
      queuedAt: NOW,
      workflowId: null,
      runAsUser: null,
      worktreePath: null,
    });
    await markSessionRunStarted(t.db, { id, startedAt, sessionId: 's1', handle: null });
  }

  it('正常结束，写结局和用量', async () => {
    const id = runId();
    await openAndStart(id);
    const result = await finishSessionRun(t.db, {
      id,
      outcome: 'ok',
      endedAt: later(10 * MIN),
      actualModel: 'claude-opus-5-5',
      inputTokens: 1000,
      outputTokens: 200,
      costUsd: 0.5,
      sessionCostUsd: 1.2,
      contextTokens: 50000,
      routeOutcome: 'ok',
    });
    expect(result).toBe('finished');
    const run = await getSessionRun(t.db, id);
    expect(run?.outcome).toBe('ok');
    expect(run?.endedAt).toEqual(later(10 * MIN));
    expect(run?.contextTokens).toBe(50000);
    expect(run?.sessionCostUsd).toBe(1.2);
  });

  it('已结束的不改：第二次调用回 already_finished，字段不变', async () => {
    const id = runId();
    await openAndStart(id);
    await finishSessionRun(t.db, { id, outcome: 'ok', endedAt: later(10 * MIN) });
    const result = await finishSessionRun(t.db, {
      id,
      outcome: 'failed',
      endedAt: later(20 * MIN),
      failureCode: 'SHOULD_NOT_LAND',
    });
    expect(result).toBe('already_finished');
    const run = await getSessionRun(t.db, id);
    expect(run?.outcome).toBe('ok');
    expect(run?.endedAt).toEqual(later(10 * MIN));
    expect(run?.failureCode).toBeNull();
  });

  it('行不在回 not_found', async () => {
    expect(await finishSessionRun(t.db, { id: randomUUID(), outcome: 'ok', endedAt: NOW })).toBe('not_found');
  });

  it('ended_at 早于 started_at 时被拉齐到 started_at，不违反检查约束', async () => {
    const id = runId();
    await openAndStart(id, later(10 * MIN));
    const result = await finishSessionRun(t.db, { id, outcome: 'failed', endedAt: later(MIN) });
    expect(result).toBe('finished');
    const run = await getSessionRun(t.db, id);
    expect(run?.endedAt).toEqual(later(10 * MIN));
  });

  it('失败的原话读得回来（续会话时写进提示词），超长的截到 2000 字', async () => {
    const id = runId();
    await openAndStart(id);
    await finishSessionRun(t.db, {
      id,
      outcome: 'failed',
      endedAt: later(MIN),
      failureCode: 'quota_exhausted',
      failureMessage: `额度用满${'。'.repeat(3000)}`,
    });
    const run = await getSessionRun(t.db, id);
    expect(run?.failureCode).toBe('quota_exhausted');
    expect(run?.failureMessage?.startsWith('额度用满')).toBe(true);
    expect(run?.failureMessage).toHaveLength(2000);
  });

  it('不知道的用量是 null，不是 0', async () => {
    const id = runId();
    await openAndStart(id);
    await finishSessionRun(t.db, { id, outcome: 'stopped', endedAt: later(MIN) });
    const run = await getSessionRun(t.db, id);
    expect(run?.contextTokens).toBeNull();
    expect(run?.sessionCostUsd).toBeNull();
  });
});

describe('latestRunOfSession', () => {
  it('取按 queued_at 最新的一条', async () => {
    const older = runId();
    const newer = runId();
    await openSessionRun(t.db, {
      id: older,
      taskId: null,
      subtaskId: null,
      stage: 'judge',
      routeId: 'r1',
      whyRoute: '考新模型',
      branch: null,
      queuedAt: ago(HOUR),
      workflowId: null,
      runAsUser: null,
      worktreePath: null,
    });
    await markSessionRunStarted(t.db, {
      id: older,
      startedAt: ago(HOUR),
      sessionId: 'claude-x',
      handle: null,
    });
    await openSessionRun(t.db, {
      id: newer,
      taskId: null,
      subtaskId: null,
      stage: 'judge',
      routeId: 'r1',
      whyRoute: '考新模型',
      branch: null,
      queuedAt: NOW,
      workflowId: null,
      runAsUser: null,
      worktreePath: null,
    });
    await markSessionRunStarted(t.db, { id: newer, startedAt: NOW, sessionId: 'claude-x', handle: null });
    expect((await latestRunOfSession(t.db, 'claude-x'))?.id).toBe(newer);
  });

  it('没有这个执行体会话编号回 null', async () => {
    expect(await latestRunOfSession(t.db, 'nobody-home')).toBeNull();
  });
});

describe('openSessionRuns', () => {
  it('只要还没结束的；给了 runAsUser 就只要那个会话用户的', async () => {
    // 另一个用户用停用的 fleet-agent-dedicated：库里只剩历史行会带它
    const retired = runId();
    const carpool = runId();
    const ended = runId();
    await openSessionRun(t.db, {
      id: retired,
      taskId: null,
      subtaskId: null,
      stage: 'judge',
      routeId: 'r1',
      whyRoute: 'x',
      branch: null,
      queuedAt: NOW,
      workflowId: null,
      runAsUser: 'fleet-agent-dedicated',
      worktreePath: null,
    });
    await openSessionRun(t.db, {
      id: carpool,
      taskId: null,
      subtaskId: null,
      stage: 'judge',
      routeId: 'r1',
      whyRoute: 'x',
      branch: null,
      queuedAt: NOW,
      workflowId: null,
      runAsUser: 'fleet-agent-carpool',
      worktreePath: null,
    });
    await openSessionRun(t.db, {
      id: ended,
      taskId: null,
      subtaskId: null,
      stage: 'judge',
      routeId: 'r1',
      whyRoute: 'x',
      branch: null,
      queuedAt: NOW,
      workflowId: null,
      runAsUser: 'fleet-agent-dedicated',
      worktreePath: null,
    });
    await markSessionRunStarted(t.db, { id: ended, startedAt: NOW, sessionId: 's', handle: null });
    await finishSessionRun(t.db, { id: ended, outcome: 'ok', endedAt: later(MIN) });

    expect(new Set((await openSessionRuns(t.db)).map((r) => r.id))).toEqual(new Set([retired, carpool]));
    expect((await openSessionRuns(t.db, { runAsUser: 'fleet-agent-carpool' })).map((r) => r.id)).toEqual([
      carpool,
    ]);
  });
});

describe('routeOutcomesSince', () => {
  it('只要 since 之后结束的会话', async () => {
    const early = runId();
    const late = runId();
    for (const [id, endedAt] of [
      [early, ago(2 * HOUR)],
      [late, ago(MIN)],
    ] as const) {
      await openSessionRun(t.db, {
        id,
        taskId: null,
        subtaskId: null,
        stage: 'execute',
        routeId: 'r1',
        whyRoute: 'x',
        branch: null,
        queuedAt: ago(3 * HOUR),
        workflowId: null,
        runAsUser: null,
        worktreePath: null,
      });
      await markSessionRunStarted(t.db, { id, startedAt: ago(3 * HOUR), sessionId: id, handle: null });
      await finishSessionRun(t.db, { id, outcome: 'ok', endedAt, routeOutcome: 'ok' });
    }
    const rows = await routeOutcomesSince(t.db, ago(HOUR));
    expect(rows.map((r) => r.routeId)).toEqual(['r1']);
    expect(rows[0]).toMatchObject({ stage: 'execute', outcome: 'ok', routeOutcome: 'ok' });
  });
});

describe('taskContext', () => {
  it('给出任务属于哪个仓、哪张 issue', async () => {
    const repo = await addRepo(t.db, 'shop');
    const task = await addTask(t.db, repo.id, { issueNumber: 42, title: '标题', rawRequest: '原话' });
    expect(await taskContext(t.db, task.id)).toEqual({
      taskId: task.id,
      issueNumber: 42,
      title: '标题',
      rawRequest: '原话',
      specDir: null,
      acceptance: [],
      repo: { id: repo.id, owner: 'acme', name: 'shop', defaultBranch: 'main', testCommand: 'pnpm check' },
    });
  });

  it('任务不在回 null', async () => {
    expect(await taskContext(t.db, randomUUID())).toBeNull();
  });
});

describe('routeLaunchFacts', () => {
  it('给出池、会话用户、执行方式、上游模型串', async () => {
    // relay-a、opus-5.5、claude-code 这一组合在 beforeEach 里已经被 r1 占了，另找 relay-b 避免撞 routes_pool_model_host_unique。
    await t.db
      .update(pools)
      .set({ runAsUser: 'fleet-agent-carpool', orgKind: 'solo' })
      .where(eq(pools.id, 'relay-b'));
    await addRoute(t.db, {
      id: 'r2',
      poolId: 'relay-b',
      modelId: 'opus-5.5',
      upstreamModel: 'claude-opus-5-5',
    });
    expect(await routeLaunchFacts(t.db, 'r2')).toEqual({
      routeId: 'r2',
      channelId: 'relay',
      poolId: 'relay-b',
      modelId: 'opus-5.5',
      hostId: 'claude-code',
      upstreamModel: 'claude-opus-5-5',
      runAsUser: 'fleet-agent-carpool',
      orgKind: 'solo',
    });
  });

  it('路由不在回 null', async () => {
    expect(await routeLaunchFacts(t.db, 'nope')).toBeNull();
  });
});
