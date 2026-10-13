// 等你的事：飞书单向通知「等你拍板」「引擎问你」读哪些行（提需求 F1 #2051）。
import { eq } from 'drizzle-orm';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { listAwaitingMe } from '../src/queries/awaiting-me.ts';
import { upsertAlert } from '../src/queries/engine.ts';
import { asks, notifications } from '../src/schema/index.ts';
import { createTestDb, resetTestDb, TEST_DB_TIMEOUT_MS, type TestDb } from '../src/testing.ts';
import { addRepo, addRoute, addRun, addTask, ago, catalog, DAY, HOUR, NOW } from './helpers.ts';

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

async function fixtures() {
  const repo = await addRepo(t.db);
  const task = await addTask(t.db, repo.id);
  const run = await addRun(t.db, { taskId: task.id, routeId: 'r1' });
  return { task, run };
}

describe('listAwaitingMe', () => {
  it('没处理的 decision 级提醒算「等你拍板」；alert、daily 级、已处理的、太老的不算', async () => {
    const { task } = await fixtures();
    const open = await upsertAlert(t.db, {
      dedupeKey: 'approval:a1',
      level: 'decision',
      taskId: task.id,
      title: '请批 PR #5',
      body: '请批 release：PR #5',
    });
    await upsertAlert(t.db, { dedupeKey: 'stuck:1', level: 'alert', taskId: null, title: '卡住', body: 'x' });
    await upsertAlert(t.db, { dedupeKey: 'daily:1', level: 'daily', taskId: null, title: '日报', body: 'x' });
    const done = await upsertAlert(t.db, {
      dedupeKey: 'approval:a2',
      level: 'decision',
      taskId: null,
      title: '批过了',
      body: 'x',
    });
    await t.db
      .update(notifications)
      .set({ resolvedAt: NOW, resolvedBy: 'founder-a' })
      .where(eq(notifications.id, done.id));
    const old = await upsertAlert(t.db, {
      dedupeKey: 'approval:a3',
      level: 'decision',
      taskId: null,
      title: '三天前的',
      body: 'x',
    });
    await t.db
      .update(notifications)
      .set({ createdAt: ago(3 * DAY) })
      .where(eq(notifications.id, old.id));

    const got = await listAwaitingMe(t.db, { since: ago(DAY) });
    expect(got.map((i) => [i.kind, i.id, i.taskId, i.title])).toEqual([
      ['decision', open.id, task.id, '请批 PR #5'],
    ]);
  });

  it('没回答、挡路的提问算「引擎问你」：scope 为空或 hold；task、outside 当场按推荐先做的不算；答过的不算', async () => {
    const { task, run } = await fixtures();
    const base = { taskId: task.id, runId: run.id, askedAt: ago(HOUR) };
    await t.db.insert(asks).values([
      { ...base, question: '引擎自己等人的' },
      {
        ...base,
        question: '碰了人闸',
        scope: 'hold',
        recommended: '批',
        options: ['批', '不批'],
        hold: 'release',
      },
      { ...base, question: '范围内先做', scope: 'task', recommended: '甲', options: ['甲', '乙'] },
      { ...base, question: '另开单', scope: 'outside', recommended: '甲', options: ['甲', '乙'] },
      { ...base, question: '答过的', answer: '好', answeredBy: 'founder-a', answeredAt: ago(HOUR / 2) },
    ]);
    const got = await listAwaitingMe(t.db, { since: ago(DAY) });
    expect(got.map((i) => [i.kind, i.title]).sort()).toEqual([
      ['ask', '引擎自己等人的'],
      ['ask', '碰了人闸'],
    ]);
  });

  it('两类合在一起，早的在前', async () => {
    const { task, run } = await fixtures();
    await t.db
      .insert(asks)
      .values({ taskId: task.id, runId: run.id, question: '先问的', askedAt: ago(2 * HOUR) });
    await upsertAlert(t.db, {
      dedupeKey: 'approval:b1',
      level: 'decision',
      taskId: null,
      title: '后来的',
      body: 'x',
    });
    const got = await listAwaitingMe(t.db, { since: ago(DAY) });
    expect(got.map((i) => i.title)).toEqual(['先问的', '后来的']);
  });
});
