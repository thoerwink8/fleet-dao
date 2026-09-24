import { eq } from 'drizzle-orm';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { taskTimeline } from '../src/queries/timeline.ts';
import {
  auditLog,
  notifications,
  progressEvents,
  stateChanges,
  subtasks,
  tasks,
  users,
} from '../src/schema/index.ts';
import { createTestDb, resetTestDb, TEST_DB_TIMEOUT_MS, type TestDb } from '../src/testing.ts';
import { addRepo, addRoute, addRun, addSubtask, addTask, ago, catalog, DAY, MIN } from './helpers.ts';

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

/** 把触发器按真实时钟记下的状态变化，依次挪到给定时刻。 */
async function backdateStates(taskId: string, times: Date[]) {
  const rows = await t.db
    .select()
    .from(stateChanges)
    .where(eq(stateChanges.taskId, taskId))
    .orderBy(stateChanges.id);
  expect(rows).toHaveLength(times.length);
  for (const [i, row] of rows.entries()) {
    await t.db.update(stateChanges).set({ at: times[i] }).where(eq(stateChanges.id, row.id));
  }
}

describe('需求时间线', () => {
  it('状态变化、会话的排队 / 开工 / 结束、进度、操作、通知按时间排好，排队和干活时长分开', async () => {
    const repo = await addRepo(t.db);
    const task = await addTask(t.db, repo.id, { createdAt: ago(60 * MIN) });
    const sub = await addSubtask(t.db, task.id);
    await t.db.update(tasks).set({ state: 'running' }).where(eq(tasks.id, task.id));
    await backdateStates(task.id, [ago(60 * MIN), ago(59 * MIN), ago(40 * MIN)]);
    const run = await addRun(t.db, {
      taskId: task.id,
      subtaskId: sub.id,
      routeId: 'opus',
      queuedAt: ago(35 * MIN),
      startedAt: ago(30 * MIN),
      endedAt: ago(5 * MIN),
      outcome: 'ok',
      actualModel: 'opus-5.5',
      inputTokens: 12000,
      outputTokens: 3400,
    });
    await t.db.insert(progressEvents).values([
      {
        runId: run.id,
        at: ago(29 * MIN),
        kind: 'plan',
        payload: { steps: [{ title: '写测试', state: 'in_progress' }] },
      },
      { runId: run.id, at: ago(20 * MIN), kind: 'file', payload: 'a.ts' },
      { runId: run.id, at: ago(10 * MIN), kind: 'say', payload: { text: '测试写好了' } },
    ]);
    const [founder] = await t.db
      .insert(users)
      .values({ displayName: '创始人甲', feishuUnionId: 'on_test_a', role: 'founder' })
      .returning();
    await t.db.insert(auditLog).values({
      at: ago(8 * MIN),
      actorKind: 'user',
      actorId: founder?.id ?? '',
      action: 'task.reroute',
      target: `subtask:${sub.id}`,
      reason: '换个模型试试',
      via: 'cockpit',
    });
    await t.db.insert(notifications).values({
      level: 'decision',
      dedupeKey: `gate:${task.id}`,
      taskId: task.id,
      title: '要你拍：发布',
      createdAt: ago(2 * MIN),
    });

    const tl = await taskTimeline(t.db, task.id);
    expect(tl?.runs).toEqual([
      expect.objectContaining({
        id: run.id,
        modelId: 'opus-5.5',
        queueMs: 5 * MIN,
        runMs: 25 * MIN,
        inputTokens: 12000,
      }),
    ]);
    expect(tl?.events.map((e) => [e.type, e.at.getTime() - ago(0).getTime()])).toEqual([
      ['state', -60 * MIN],
      ['state', -59 * MIN],
      ['state', -40 * MIN],
      ['run-queued', -35 * MIN],
      ['run-started', -30 * MIN],
      ['progress', -29 * MIN],
      ['progress', -10 * MIN],
      ['audit', -8 * MIN],
      ['run-ended', -5 * MIN],
      ['notification', -2 * MIN],
    ]);
    expect(tl?.events[2]).toMatchObject({ type: 'state', entity: 'task', from: 'queued', to: 'running' });
    expect(tl?.events[4]).toMatchObject({ type: 'run-started', queueMs: 5 * MIN });
    expect(tl?.events[7]).toMatchObject({
      type: 'audit',
      action: 'task.reroute',
      target: `subtask:${sub.id}`,
      actorKind: 'user',
      actorId: founder?.id,
      via: 'cockpit',
    });
    expect(tl?.events[8]).toMatchObject({ type: 'run-ended', outcome: 'ok', runMs: 25 * MIN });
    // 每条都有 id，且互不相同：翻页按 (at, id) 做游标不会漏。
    const eventIds = tl?.events.map((e) => e.id) ?? [];
    expect(new Set(eventIds).size).toBe(eventIds.length);
    expect(eventIds[4]).toBe(`run:${run.id}:2-started`);
  });

  it('同一时刻的几条按 (at, id) 排：顺序确定，会话三步按先后，编号按写入先后', async () => {
    const repo = await addRepo(t.db);
    const task = await addTask(t.db, repo.id);
    // 排队、开工、结束都在同一刻；十来条进度也在同一刻（编号跨过两位数，字面比较不能乱）。
    const run = await addRun(t.db, {
      taskId: task.id,
      routeId: 'opus',
      queuedAt: ago(10 * MIN),
      startedAt: ago(10 * MIN),
      endedAt: ago(10 * MIN),
      outcome: 'stopped',
    });
    await t.db.insert(progressEvents).values(
      Array.from({ length: 12 }, (_, i) => ({
        runId: run.id,
        at: ago(5 * MIN),
        kind: 'say' as const,
        payload: { text: `第 ${i} 句` },
      })),
    );
    const tl = await taskTimeline(t.db, task.id);
    const events = tl?.events ?? [];
    const keys = events.map((e) => [e.at.getTime(), e.id] as const);
    const sorted = [...keys].sort((a, b) => a[0] - b[0] || (a[1] < b[1] ? -1 : a[1] > b[1] ? 1 : 0));
    expect(keys).toEqual(sorted);
    expect(events.filter((e) => e.type.startsWith('run-')).map((e) => e.type)).toEqual([
      'run-queued',
      'run-started',
      'run-ended',
    ]);
    expect(
      events.filter((e) => e.type === 'progress').map((e) => (e.type === 'progress' ? e.payload : null)),
    ).toEqual(Array.from({ length: 12 }, (_, i) => ({ text: `第 ${i} 句` })));
  });

  it('默认不放改文件、调工具这类动作流；要的话可以点名要', async () => {
    const repo = await addRepo(t.db);
    const task = await addTask(t.db, repo.id);
    const run = await addRun(t.db, { taskId: task.id, routeId: 'opus' });
    await t.db.insert(progressEvents).values([
      { runId: run.id, kind: 'tool', payload: { name: 'bash' } },
      { runId: run.id, kind: 'file', payload: 'a.ts' },
      { runId: run.id, kind: 'test', payload: { passed: 3 } },
    ]);
    const byDefault = await taskTimeline(t.db, task.id);
    expect(
      byDefault?.events.filter((e) => e.type === 'progress').map((e) => e.type === 'progress' && e.kind),
    ).toEqual(['test']);
    const onlyTools = await taskTimeline(t.db, task.id, { progressKinds: ['tool'] });
    expect(
      onlyTools?.events.filter((e) => e.type === 'progress').map((e) => e.type === 'progress' && e.kind),
    ).toEqual(['tool']);
  });

  it('31 天前做完的需求，每一步都还读得到（不靠只留 30 天的 Temporal 历史）', async () => {
    const repo = await addRepo(t.db);
    const task = await addTask(t.db, repo.id, { createdAt: ago(40 * DAY) });
    const sub = await addSubtask(t.db, task.id);
    await t.db.update(subtasks).set({ state: 'merged' }).where(eq(subtasks.id, sub.id));
    await t.db.update(tasks).set({ state: 'done' }).where(eq(tasks.id, task.id));
    await backdateStates(task.id, [ago(40 * DAY), ago(40 * DAY), ago(32 * DAY), ago(31 * DAY)]);
    await addRun(t.db, {
      taskId: task.id,
      subtaskId: sub.id,
      routeId: 'opus',
      queuedAt: ago(35 * DAY),
      startedAt: ago(35 * DAY - MIN),
      endedAt: ago(34 * DAY),
      outcome: 'ok',
    });
    const tl = await taskTimeline(t.db, task.id);
    expect(tl?.events.map((e) => e.type)).toEqual([
      'state',
      'state',
      'run-queued',
      'run-started',
      'run-ended',
      'state',
      'state',
    ]);
    expect(tl?.events.at(-1)).toMatchObject({ type: 'state', to: 'done', at: ago(31 * DAY) });
  });

  it('别的需求的东西不混进来；没有这个需求返回空', async () => {
    const repo = await addRepo(t.db);
    const mine = await addTask(t.db, repo.id);
    const other = await addTask(t.db, repo.id);
    await addRun(t.db, { taskId: other.id, routeId: 'opus' });
    await t.db.insert(auditLog).values({
      actorKind: 'engine',
      actorId: 'worker-1',
      action: 'pr.merge',
      target: `task:${other.id}`,
      via: 'engine',
    });
    const tl = await taskTimeline(t.db, mine.id);
    expect(tl?.runs).toEqual([]);
    expect(tl?.events.map((e) => e.type)).toEqual(['state']);
    expect(await taskTimeline(t.db, '00000000-0000-4000-8000-000000000000')).toBeNull();
  });
});
