import { desc, eq } from 'drizzle-orm';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { planProgress, repoBoard } from '../src/queries/board.ts';
import { insertSubtasks } from '../src/queries/subtasks.ts';
import { progressEvents, stateChanges, subtasks, tasks } from '../src/schema/index.ts';
import { createTestDb, resetTestDb, TEST_DB_TIMEOUT_MS, type TestDb } from '../src/testing.ts';
import { addRepo, addRoute, addRun, addTask, ago, catalog, DAY, HOUR, MIN } from './helpers.ts';

let t: TestDb;
beforeAll(async () => {
  t = await createTestDb();
}, TEST_DB_TIMEOUT_MS);
afterAll(() => t.close());
beforeEach(async () => {
  await resetTestDb(t);
  await catalog(t.db);
  await addRoute(t.db, { id: 'opus', poolId: 'relay-a', modelId: 'opus-5.5' });
});

/** 触发器按真实时钟记状态变化；测试把某个对象最近一次变化挪到指定时刻。 */
async function enteredStateAt(entityId: string, at: Date) {
  const [last] = await t.db
    .select({ id: stateChanges.id })
    .from(stateChanges)
    .where(eq(stateChanges.entityId, entityId))
    .orderBy(desc(stateChanges.id))
    .limit(1);
  if (!last) throw new Error('没有状态变化');
  await t.db.update(stateChanges).set({ at }).where(eq(stateChanges.id, last.id));
}

const ids = {
  a: '11111111-1111-4111-8111-111111111111',
  b: '22222222-2222-4222-8222-222222222222',
  c: '33333333-3333-4333-8333-333333333333',
};

describe('看板树：需求 → 子任务 → PR', () => {
  it('按优先级排需求；子任务带依赖、PR 链接、在跑的会话和步骤进度', async () => {
    const repo = await addRepo(t.db, 'shop');
    const later = await addTask(t.db, repo.id, { issueNumber: 7, priority: 20, title: '后做' });
    const task = await addTask(t.db, repo.id, { issueNumber: 12, priority: 1, title: '登录验证码' });
    await insertSubtasks(t.db, task.id, [
      {
        id: ids.a,
        index: 0,
        title: '接口',
        touches: ['packages/api'],
        dependsOn: [],
        state: 'merged',
        prNumber: 31,
      },
      {
        id: ids.b,
        index: 1,
        title: '页面',
        touches: ['packages/web'],
        dependsOn: [ids.a],
        state: 'running',
        prNumber: 32,
      },
      {
        id: ids.c,
        index: 2,
        title: '文档',
        touches: ['docs'],
        dependsOn: [ids.a, ids.b],
        state: 'waiting_deps',
      },
    ]);
    const run = await addRun(t.db, {
      taskId: task.id,
      subtaskId: ids.b,
      routeId: 'opus',
      startedAt: ago(12 * MIN),
    });
    await t.db.insert(progressEvents).values([
      {
        runId: run.id,
        at: ago(11 * MIN),
        kind: 'plan',
        payload: { steps: [{ title: '读需求', state: 'in_progress' }] },
      },
      {
        runId: run.id,
        at: ago(5 * MIN),
        kind: 'plan',
        payload: {
          steps: [
            { title: '读需求', state: 'done' },
            { title: '写验证码过期的测试', state: 'in_progress' },
            { title: '开 PR', state: 'pending' },
          ],
        },
      },
      { runId: run.id, at: ago(MIN), kind: 'file', payload: 'packages/web/login.tsx' },
    ]);

    const board = await repoBoard(t.db, repo.id);
    expect(board?.repo).toEqual({ id: repo.id, owner: 'acme', name: 'shop' });
    expect(board?.tasks.map((x) => [x.issueNumber, x.title])).toEqual([
      [12, '登录验证码'],
      [7, '后做'],
    ]);
    expect(board?.tasks[1]?.id).toBe(later.id);
    const top = board?.tasks[0];
    expect(top?.issueUrl).toBe('https://github.com/acme/shop/issues/12');
    expect(top?.subtasks.map((s) => [s.index, s.state, s.dependsOn.sort(), s.pr?.url ?? null])).toEqual([
      [0, 'merged', [], 'https://github.com/acme/shop/pull/31'],
      [1, 'running', [ids.a], 'https://github.com/acme/shop/pull/32'],
      [2, 'waiting_deps', [ids.a, ids.b].sort(), null],
    ]);
    const current = top?.subtasks[1]?.run;
    expect(current).toMatchObject({
      id: run.id,
      modelName: 'Opus 5.5',
      startedAt: ago(12 * MIN),
      lastProgressAt: ago(MIN),
      progress: { done: 1, total: 3, current: '写验证码过期的测试' },
    });
    expect(top?.subtasks[0]?.run).toBeNull();
  });

  it('需求级的会话（分诊、写方案）挂在需求上；已结束的会话不算在跑', async () => {
    const repo = await addRepo(t.db);
    const task = await addTask(t.db, repo.id);
    await addRun(t.db, {
      taskId: task.id,
      routeId: 'opus',
      stage: 'triage',
      queuedAt: ago(HOUR),
      endedAt: ago(50 * MIN),
      outcome: 'ok',
    });
    const planning = await addRun(t.db, { taskId: task.id, routeId: 'opus', stage: 'plan' });
    const board = await repoBoard(t.db, repo.id);
    expect(board?.tasks[0]?.run).toMatchObject({
      id: planning.id,
      stage: 'plan',
      startedAt: null,
      progress: null,
    });
  });

  it('「进入当前状态多久」从状态变化算，不从开单算', async () => {
    const repo = await addRepo(t.db);
    const task = await addTask(t.db, repo.id, { createdAt: ago(10 * HOUR) });
    await t.db.update(tasks).set({ state: 'running' }).where(eq(tasks.id, task.id));
    await enteredStateAt(task.id, ago(HOUR));
    const board = await repoBoard(t.db, repo.id);
    expect(board?.tasks[0]?.createdAt).toEqual(ago(10 * HOUR));
    expect(board?.tasks[0]?.stateSince).toEqual(ago(HOUR));
  });

  it('可以隐藏早就结束的需求，最近结束的照常列出', async () => {
    const repo = await addRepo(t.db);
    const old = await addTask(t.db, repo.id, { title: '上周做完的' });
    const recent = await addTask(t.db, repo.id, { title: '刚做完的' });
    const open = await addTask(t.db, repo.id, { title: '还在做的', createdAt: ago(30 * DAY) });
    for (const x of [old, recent]) await t.db.update(tasks).set({ state: 'done' }).where(eq(tasks.id, x.id));
    await enteredStateAt(old.id, ago(7 * DAY));
    await enteredStateAt(recent.id, ago(HOUR));
    await enteredStateAt(open.id, ago(30 * DAY));
    const board = await repoBoard(t.db, repo.id, { hideTerminalBefore: ago(DAY) });
    expect(board?.tasks.map((x) => x.title).sort()).toEqual(['刚做完的', '还在做的']);
  });

  it('只列这个仓的需求；没有这个仓返回空', async () => {
    const mine = await addRepo(t.db);
    const other = await addRepo(t.db);
    await addTask(t.db, other.id);
    expect((await repoBoard(t.db, mine.id))?.tasks).toEqual([]);
    expect(await repoBoard(t.db, '00000000-0000-4000-8000-000000000000')).toBeNull();
  });

  it('insertSubtasks 里依赖指到别的需求，整批不写', async () => {
    const repo = await addRepo(t.db);
    const a = await addTask(t.db, repo.id);
    const b = await addTask(t.db, repo.id);
    await insertSubtasks(t.db, b.id, [{ id: ids.c, index: 0, title: 'b0', touches: [], dependsOn: [] }]);
    await expect(
      insertSubtasks(t.db, a.id, [
        { id: ids.a, index: 0, title: 'a0', touches: [], dependsOn: [] },
        { id: ids.b, index: 1, title: 'a1', touches: [], dependsOn: [ids.c] },
      ]),
    ).rejects.toThrow();
    const board = await repoBoard(t.db, repo.id);
    expect(board?.tasks.find((x) => x.id === a.id)?.subtasks).toEqual([]);
  });

  it('步骤清单算进度：形状不对的步骤跳过，没有进行中的步就没有「当前」', () => {
    expect(
      planProgress({
        steps: [{ title: 'a', state: 'done' }, { title: 'b', state: 'pending' }, 'junk', { state: 'done' }],
      }),
    ).toEqual({ done: 1, total: 2, current: null });
    expect(planProgress({ steps: [] })).toEqual({ done: 0, total: 0, current: null });
    // 载荷不是 { steps: [...] } 就算不出来，给空，不给 0/0。
    expect(planProgress([{ title: 'a', state: 'done' }])).toBeNull();
    expect(planProgress(null)).toBeNull();
  });
});

describe('子任务的「进入当前状态多久」', () => {
  it('取子任务自己最近一次状态变化', async () => {
    const repo = await addRepo(t.db);
    const task = await addTask(t.db, repo.id);
    await insertSubtasks(t.db, task.id, [{ id: ids.a, index: 0, title: 'x', touches: [], dependsOn: [] }]);
    await t.db
      .update(subtasks)
      .set({ state: 'waiting_slot', waitingOn: '等 relay-a 的并发空位' })
      .where(eq(subtasks.id, ids.a));
    await enteredStateAt(ids.a, ago(3 * HOUR));
    const board = await repoBoard(t.db, repo.id);
    expect(board?.tasks[0]?.subtasks[0]).toMatchObject({
      state: 'waiting_slot',
      waitingOn: '等 relay-a 的并发空位',
      stateSince: ago(3 * HOUR),
    });
  });
});
