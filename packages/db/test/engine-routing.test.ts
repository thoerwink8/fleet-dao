// 执行计时、任务快照、选路事实（在 candidates.ts 算好的挡法上加字段）。
import { randomUUID } from 'node:crypto';
import { and, eq, isNull } from 'drizzle-orm';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { recordStepTiming, routeFactsForStage, saveTaskSnapshot } from '../src/queries/engine.ts';
import { stagePolicies, stagePolicyRoutes, subtaskDeps, subtasks, tasks } from '../src/schema/index.ts';
import { createTestDb, resetTestDb, TEST_DB_TIMEOUT_MS, type TestDb } from '../src/testing.ts';
import {
  addRepo,
  addRoute,
  addRun,
  addTask,
  addWindow,
  ago,
  catalog,
  expectViolation,
  MIN,
  NOW,
  setStageOrder,
} from './helpers.ts';

let t: TestDb;
beforeAll(async () => {
  t = await createTestDb();
}, TEST_DB_TIMEOUT_MS);
afterAll(() => t.close());
beforeEach(async () => {
  await resetTestDb(t);
  await catalog(t.db);
});

describe('recordStepTiming', () => {
  const activity = {
    kind: 'activity' as const,
    workflowId: 'wf-1',
    temporalRunId: 'temporal-run-1',
    workflowType: 'subtaskWorkflow',
    activity: 'runTests',
    attempt: 1,
    scheduledAt: ago(2 * MIN),
    startedAt: ago(MIN),
    endedAt: NOW,
    queueMs: 60_000,
    runMs: 60_000,
    outcome: 'ok' as const,
  };
  const wait = {
    kind: 'wait' as const,
    workflowId: 'wf-1',
    temporalRunId: 'temporal-run-1',
    workflowType: 'subtaskWorkflow',
    waitFor: 'merge-queue',
    detail: '等前面两个子任务先合',
    startedAt: ago(10 * MIN),
    endedAt: ago(2 * MIN),
    waitMs: 8 * 60_000,
  };

  it('activity / wait 各写一条', async () => {
    expect(await recordStepTiming(t.db, activity)).toBe('written');
    expect(await recordStepTiming(t.db, wait)).toBe('written');
  });

  it('活动重试重写同一笔（同一次尝试）返回 duplicate，不报错', async () => {
    expect(await recordStepTiming(t.db, activity)).toBe('written');
    expect(await recordStepTiming(t.db, activity)).toBe('duplicate');
  });

  it('wait 行重复写同一段等待也返回 duplicate', async () => {
    expect(await recordStepTiming(t.db, wait)).toBe('written');
    expect(await recordStepTiming(t.db, wait)).toBe('duplicate');
  });

  it('activity 行缺必填列（没有 outcome）被检查约束拦住', async () => {
    // TS 类型本身不许漏 outcome；这里用 unknown 绕过类型，专测运行时的检查约束。
    const broken = { ...activity, outcome: undefined } as unknown as typeof activity;
    await expectViolation(recordStepTiming(t.db, broken), 'step_timings_activity_shape');
  });
});

describe('saveTaskSnapshot', () => {
  const ids = {
    a: '11111111-1111-4111-8111-111111111111',
    b: '22222222-2222-4222-8222-222222222222',
    c: '33333333-3333-4333-8333-333333333333',
  };

  async function baseSnapshot(taskId: string, over: Partial<Parameters<typeof saveTaskSnapshot>[1]> = {}) {
    return saveTaskSnapshot(t.db, {
      taskId,
      state: 'planning',
      phase: 'plan',
      doing: '写方案',
      specDir: 'specs/1-x',
      docs: { requirement: '需求.md' },
      lastProblem: null,
      subtasks: [],
      ...over,
    });
  }

  it('正常保存：任务字段落地，子任务连依赖一起写', async () => {
    const repo = await addRepo(t.db);
    const task = await addTask(t.db, repo.id);
    const result = await baseSnapshot(task.id, {
      state: 'running',
      phase: 'execute',
      doing: '在写第二个子任务',
      lastProblem: '第一版方案漏了一个依赖',
      docs: { requirement: '需求.md', plan: '方案.md' },
      subtasks: [
        {
          id: ids.a,
          key: 'login-api',
          index: 0,
          title: '接口',
          touches: ['packages/api'],
          dependsOn: [],
          state: 'merged',
          prNumber: 31,
          waitingOn: null,
          workflowId: 'wf-a',
          holds: [],
        },
        {
          id: ids.b,
          key: 'login-page',
          index: 1,
          title: '页面',
          touches: ['packages/web'],
          dependsOn: [ids.a],
          state: 'running',
          prNumber: null,
          waitingOn: '等接口先合',
          workflowId: 'wf-b',
          holds: ['release'],
        },
      ],
    });
    expect(result).toBe('saved');

    const [row] = await t.db.select().from(tasks).where(eq(tasks.id, task.id));
    expect(row).toMatchObject({
      state: 'running',
      phase: 'execute',
      doing: '在写第二个子任务',
      specDir: 'specs/1-x',
      docs: { requirement: '需求.md', plan: '方案.md' },
      lastProblem: '第一版方案漏了一个依赖',
    });
    expect(row?.updatedAt).not.toBeNull();

    const savedSubtasks = await t.db.select().from(subtasks).where(eq(subtasks.taskId, task.id));
    expect(savedSubtasks.map((s) => [s.id, s.key, s.holds])).toEqual([
      [ids.a, 'login-api', []],
      [ids.b, 'login-page', ['release']],
    ]);
    const deps = await t.db.select().from(subtaskDeps).where(eq(subtaskDeps.taskId, task.id));
    expect(deps.map((d) => [d.subtaskId, d.dependsOnId])).toEqual([[ids.b, ids.a]]);
  });

  it('任务不在回 task_not_found，不建任务行', async () => {
    expect(await baseSnapshot(randomUUID())).toBe('task_not_found');
  });

  it('重拆方案：旧子任务标作废，新子任务可以复用同一个 index', async () => {
    const repo = await addRepo(t.db);
    const task = await addTask(t.db, repo.id);
    await baseSnapshot(task.id, {
      subtasks: [
        {
          id: ids.a,
          key: 'v1',
          index: 0,
          title: '第一版拆法',
          touches: [],
          dependsOn: [],
          state: 'pending',
          prNumber: null,
          waitingOn: null,
          workflowId: null,
          holds: [],
        },
      ],
    });
    const result = await baseSnapshot(task.id, {
      subtasks: [
        {
          id: ids.b,
          key: 'v2',
          index: 0,
          title: '重拆后的第一步',
          touches: [],
          dependsOn: [],
          state: 'pending',
          prNumber: null,
          waitingOn: null,
          workflowId: null,
          holds: [],
        },
      ],
    });
    expect(result).toBe('saved');

    const [old] = await t.db.select().from(subtasks).where(eq(subtasks.id, ids.a));
    expect(old?.supersededAt).not.toBeNull();
    const active = await t.db
      .select()
      .from(subtasks)
      .where(and(eq(subtasks.taskId, task.id), isNull(subtasks.supersededAt)));
    expect(active.map((s) => [s.id, s.index])).toEqual([[ids.b, 0]]);
  });

  it('依赖指向快照外、库里也没有的子任务，被外键拦住', async () => {
    const repo = await addRepo(t.db);
    const task = await addTask(t.db, repo.id);
    await expectViolation(
      baseSnapshot(task.id, {
        subtasks: [
          {
            id: ids.c,
            key: 'c',
            index: 0,
            title: '依赖一个不存在的子任务',
            touches: [],
            dependsOn: [randomUUID()],
            state: 'pending',
            prNumber: null,
            waitingOn: null,
            workflowId: null,
            holds: [],
          },
        ],
      }),
      'subtask_deps_depends_on_fk',
    );
  });
});

describe('routeFactsForStage', () => {
  const fresh = { reading: 'measured' as const, readAt: ago(MIN) };

  it('阶段没配顺序：configured=false，不按 id 乱挑', async () => {
    await t.db.delete(stagePolicies).where(eq(stagePolicies.stage, 'research'));
    await addRoute(t.db, { id: 'r1', poolId: 'relay-a', modelId: 'opus-5.5' });
    expect(await routeFactsForStage(t.db, 'research', { now: NOW })).toEqual({
      stage: 'research',
      configured: false,
      stagePinned: false,
      order: [],
      routes: [],
    });
  });

  it('给出 enabled=false 的行；用量比例、reading、reserved 都从原始额度窗和会话表补上', async () => {
    await addRoute(t.db, {
      id: 'on',
      poolId: 'relay-a',
      modelId: 'opus-5.5',
      upstreamModel: 'claude-opus-5-5',
    });
    await addRoute(t.db, { id: 'off', poolId: 'relay-b', modelId: 'opus-4.9' });
    await setStageOrder(t.db, 'execute', ['on', 'off']);
    await t.db
      .update(stagePolicyRoutes)
      .set({ enabled: false })
      .where(and(eq(stagePolicyRoutes.stage, 'execute'), eq(stagePolicyRoutes.routeId, 'off')));
    await addWindow(t.db, {
      poolId: 'relay-a',
      window: '7d',
      used: 200,
      limit: 1000,
      unit: 'points',
      ...fresh,
    });

    // relay-a 上一个已选定、还没开工的会话：算进 on 这条路由的 reserved。
    const repo = await addRepo(t.db);
    const task = await addTask(t.db, repo.id);
    await addRun(t.db, { taskId: task.id, routeId: 'on', queuedAt: ago(MIN) });

    const facts = await routeFactsForStage(t.db, 'execute', { now: NOW });
    expect(facts.configured).toBe(true);
    expect(facts.order).toEqual([
      { routeId: 'on', position: 0, enabled: true },
      { routeId: 'off', position: 1, enabled: false },
    ]);
    const on = facts.routes.find((r) => r.routeId === 'on');
    expect(on).toMatchObject({
      poolId: 'relay-a',
      modelName: 'Opus 5.5',
      upstreamModel: 'claude-opus-5-5',
      reserved: 1,
      inFlight: 0,
    });
    expect(on?.windows).toEqual([
      expect.objectContaining({ label: '7d', used: 0.2, reading: 'measured', state: 'ok' }),
    ]);
    const off = facts.routes.find((r) => r.routeId === 'off');
    expect(off?.blockers).toContain('switched-off');
    expect(off?.reserved).toBe(0);
  });
});
