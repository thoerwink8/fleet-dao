// #259 问创始人不挡路：openEngineAsk 带范围和推荐、单子的提问列表、照改完记 applied_at。
import { randomUUID } from 'node:crypto';
import { eq } from 'drizzle-orm';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { listTaskAsks, markAsksApplied } from '../src/queries/asks.ts';
import { openEngineAsk } from '../src/queries/engine.ts';
import { asks } from '../src/schema/index.ts';
import { createTestDb, resetTestDb, TEST_DB_TIMEOUT_MS, type TestDb } from '../src/testing.ts';
import { addRepo, addRoute, addRun, addTask, ago, catalog, expectViolation, MIN } from './helpers.ts';

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

/** 一个仓、一张需求、一次会话（openEngineAsk 挂 runId 要用）。 */
async function fixtures() {
  const repo = await addRepo(t.db);
  const task = await addTask(t.db, repo.id);
  const run = await addRun(t.db, { taskId: task.id, routeId: 'r1' });
  return { repo, task, run };
}

describe('openEngineAsk 带 scope、recommended（#259）', () => {
  it('scope=task、recommended 在选项里：写进去、读回来对得上', async () => {
    const { task, run } = await fixtures();
    const id = randomUUID();
    const result = await openEngineAsk(t.db, {
      id,
      taskId: task.id,
      runId: run.id,
      question: '先做哪一块？',
      options: ['甲', '乙'],
      recommended: '甲',
      scope: 'task',
    });
    expect(result).toEqual({ created: true, runLinked: true });
    const [row] = await t.db.select().from(asks).where(eq(asks.id, id));
    expect(row).toMatchObject({ recommended: '甲', scope: 'task' });
  });

  it('只给 scope 不给 recommended、或推荐不在选项里：被 asks_scoped_recommendation 拦下', async () => {
    const { task } = await fixtures();
    await expectViolation(
      openEngineAsk(t.db, {
        id: randomUUID(),
        taskId: task.id,
        runId: null,
        question: '只给了范围',
        options: ['甲', '乙'],
        scope: 'task',
      }),
      'asks_scoped_recommendation',
    );
    await expectViolation(
      openEngineAsk(t.db, {
        id: randomUUID(),
        taskId: task.id,
        runId: null,
        question: '推荐不在选项里',
        options: ['甲', '乙'],
        recommended: '丙',
        scope: 'task',
      }),
      'asks_scoped_recommendation',
    );
  });
});

describe('listTaskAsks', () => {
  it('按提问先后排序；别的单的不混进来；没填的列是 null', async () => {
    const repo = await addRepo(t.db);
    const taskA = await addTask(t.db, repo.id);
    const taskB = await addTask(t.db, repo.id);
    const [older] = await t.db
      .insert(asks)
      .values({ taskId: taskA.id, question: '先问的', askedAt: ago(20 * MIN) })
      .returning();
    const [newer] = await t.db
      .insert(asks)
      .values({ taskId: taskA.id, question: '后问的', askedAt: ago(10 * MIN) })
      .returning();
    await t.db.insert(asks).values({ taskId: taskB.id, question: '别的单的', askedAt: ago(5 * MIN) });
    if (!older || !newer) throw new Error('夹具没写进去');

    const rows = await listTaskAsks(t.db, taskA.id);
    expect(rows.map((r) => r.question)).toEqual(['先问的', '后问的']);
    expect(rows[0]).toMatchObject({
      id: older.id,
      taskId: taskA.id,
      runId: null,
      answer: null,
      answeredAt: null,
      scope: null,
      recommended: null,
      hold: null,
      followUpIssue: null,
      appliedAt: null,
    });
  });
});

describe('markAsksApplied', () => {
  it('只记这张单的、回答了的、没记过的；已经记过的保留原时刻；条数对；空列表回 0', async () => {
    const repo = await addRepo(t.db);
    const taskA = await addTask(t.db, repo.id);
    const taskB = await addTask(t.db, repo.id);
    const [answered] = await t.db
      .insert(asks)
      .values({
        taskId: taskA.id,
        question: '已回答该记',
        askedAt: ago(30 * MIN),
        answer: '甲',
        answeredBy: 'founder-a',
        answeredAt: ago(20 * MIN),
      })
      .returning();
    const [unanswered] = await t.db
      .insert(asks)
      .values({ taskId: taskA.id, question: '还没回答', askedAt: ago(25 * MIN) })
      .returning();
    const oldAppliedAt = ago(15 * MIN);
    const [alreadyApplied] = await t.db
      .insert(asks)
      .values({
        taskId: taskA.id,
        question: '已经记过',
        askedAt: ago(24 * MIN),
        answer: '乙',
        answeredBy: 'founder-a',
        answeredAt: ago(23 * MIN),
        appliedAt: oldAppliedAt,
      })
      .returning();
    const [otherTask] = await t.db
      .insert(asks)
      .values({
        taskId: taskB.id,
        question: '别的单的回答',
        askedAt: ago(10 * MIN),
        answer: '甲',
        answeredBy: 'founder-a',
        answeredAt: ago(9 * MIN),
      })
      .returning();
    if (!answered || !unanswered || !alreadyApplied || !otherTask) throw new Error('夹具没写进去');

    expect(await markAsksApplied(t.db, { taskId: taskA.id, askIds: [], at: ago(0) })).toBe(0);

    const at = ago(0);
    const count = await markAsksApplied(t.db, {
      taskId: taskA.id,
      askIds: [answered.id, unanswered.id, alreadyApplied.id, otherTask.id],
      at,
    });
    expect(count).toBe(1);

    const rows = await listTaskAsks(t.db, taskA.id);
    expect(rows.find((r) => r.id === answered.id)?.appliedAt).toEqual(at);
    expect(rows.find((r) => r.id === unanswered.id)?.appliedAt).toBeNull();
    expect(rows.find((r) => r.id === alreadyApplied.id)?.appliedAt).toEqual(oldAppliedAt);
    const [otherRow] = await t.db.select().from(asks).where(eq(asks.id, otherTask.id));
    expect(otherRow?.appliedAt).toBeNull();
  });

  it('askIds 里有不是 UUID 的：抛错（调用方的错，不悄悄跳过）', async () => {
    const repo = await addRepo(t.db);
    const task = await addTask(t.db, repo.id);
    await expect(
      markAsksApplied(t.db, { taskId: task.id, askIds: ['not-a-uuid'], at: ago(0) }),
    ).rejects.toThrow();
  });
});
