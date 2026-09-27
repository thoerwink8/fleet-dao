// #259 问创始人不挡路：openEngineAsk 带范围和推荐、单子的提问列表、照改完记 applied_at、对账粗筛候选、回写后续单号。
import { randomUUID } from 'node:crypto';
import { eq } from 'drizzle-orm';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import {
  askIssueCandidates,
  listTaskAsks,
  markAsksApplied,
  setAskFollowUpIssue,
} from '../src/queries/asks.ts';
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

describe('askIssueCandidates', () => {
  it('(a)(b) 该进来的三条；不该进来的七种各一条都被挡住', async () => {
    const repo = await addRepo(t.db);
    const taskOutside = await addTask(t.db, repo.id, { title: '超出范围的单' });
    const taskDone = await addTask(t.db, repo.id, { title: '已经合了的单', state: 'done' });
    const taskRunning = await addTask(t.db, repo.id, { title: '还在做的单', state: 'running' });
    const opts = ['甲', '乙'];

    // (a) 该进来：超出范围、没开单、没回答
    await t.db.insert(asks).values({
      taskId: taskOutside.id,
      question: '超出范围-该开单',
      options: opts,
      scope: 'outside',
      recommended: '甲',
      askedAt: ago(60 * MIN),
    });
    // (a) 不该进来：超出范围、已经开单、没回答
    await t.db.insert(asks).values({
      taskId: taskOutside.id,
      question: '超出范围-已开单没回答',
      options: opts,
      scope: 'outside',
      recommended: '甲',
      followUpIssue: 101,
      askedAt: ago(59 * MIN),
    });
    // (a) 该进来：超出范围、已经开单、回答了（回答还没写到那张单上）
    await t.db.insert(asks).values({
      taskId: taskOutside.id,
      question: '超出范围-回答要写上去',
      options: opts,
      scope: 'outside',
      recommended: '甲',
      answer: '乙',
      answeredBy: 'founder-a',
      answeredAt: ago(10 * MIN),
      followUpIssue: 102,
      askedAt: ago(58 * MIN),
    });
    // (a) 不该进来：超出范围、已经开单、回答已经写上去了（applied_at 非空）
    await t.db.insert(asks).values({
      taskId: taskOutside.id,
      question: '超出范围-回答写过了',
      options: opts,
      scope: 'outside',
      recommended: '甲',
      answer: '乙',
      answeredBy: 'founder-a',
      answeredAt: ago(10 * MIN),
      appliedAt: ago(9 * MIN),
      followUpIssue: 103,
      askedAt: ago(57 * MIN),
    });

    // (b) 该进来：范围内、单已合、回答和推荐不一样
    await t.db.insert(asks).values({
      taskId: taskDone.id,
      question: '范围内-该开后续单',
      options: opts,
      scope: 'task',
      recommended: '甲',
      answer: '乙',
      answeredBy: 'founder-a',
      answeredAt: ago(9 * MIN),
      askedAt: ago(50 * MIN),
    });
    // (b) 不该进来：回答和推荐只差首尾空格
    await t.db.insert(asks).values({
      taskId: taskDone.id,
      question: '回答其实等于推荐',
      options: opts,
      scope: 'task',
      recommended: '甲',
      answer: ' 甲 ',
      answeredBy: 'founder-a',
      answeredAt: ago(8 * MIN),
      askedAt: ago(49 * MIN),
    });
    // (b) 不该进来：单子没合（state 不是 done）
    await t.db.insert(asks).values({
      taskId: taskRunning.id,
      question: '单子还没合',
      options: opts,
      scope: 'task',
      recommended: '甲',
      answer: '乙',
      answeredBy: 'founder-a',
      answeredAt: ago(7 * MIN),
      askedAt: ago(48 * MIN),
    });
    // (b) 不该进来：已经交给主导照改了（applied_at 非空）
    await t.db.insert(asks).values({
      taskId: taskDone.id,
      question: '已经交给主导改了',
      options: opts,
      scope: 'hold',
      hold: 'spend',
      recommended: '甲',
      answer: '乙',
      answeredBy: 'founder-a',
      answeredAt: ago(6 * MIN),
      appliedAt: ago(5 * MIN),
      askedAt: ago(47 * MIN),
    });
    // (b) 不该进来：已经有 follow_up_issue
    await t.db.insert(asks).values({
      taskId: taskDone.id,
      question: '已经开过后续单',
      options: opts,
      scope: 'task',
      recommended: '甲',
      answer: '乙',
      answeredBy: 'founder-a',
      answeredAt: ago(4 * MIN),
      followUpIssue: 202,
      askedAt: ago(46 * MIN),
    });
    // (b) 不该进来：老式提问（scope 为空），哪怕已回答、单子已合
    await t.db.insert(asks).values({
      taskId: taskDone.id,
      question: '老式提问',
      answer: '乙',
      answeredBy: 'founder-a',
      answeredAt: ago(3 * MIN),
      askedAt: ago(45 * MIN),
    });

    const candidates = await askIssueCandidates(t.db);
    expect(candidates.map((c) => c.ask.question)).toEqual([
      '超出范围-该开单',
      '超出范围-回答要写上去',
      '范围内-该开后续单',
    ]);
    expect(candidates[0]).toMatchObject({
      taskState: 'queued',
      taskTitle: '超出范围的单',
      issueNumber: taskOutside.issueNumber,
      repo: { owner: repo.owner, name: repo.name },
    });
    expect(candidates[2]).toMatchObject({
      taskState: 'done',
      taskTitle: '已经合了的单',
      issueNumber: taskDone.issueNumber,
      repo: { owner: repo.owner, name: repo.name },
    });
  });
});

describe('setAskFollowUpIssue', () => {
  it('四种结局：写上、本来就是这个号、已经是别的号不动、没这条', async () => {
    const repo = await addRepo(t.db);
    const task = await addTask(t.db, repo.id);
    const [ask] = await t.db
      .insert(asks)
      .values({ taskId: task.id, question: '要不要开后续单', askedAt: ago(MIN) })
      .returning();
    if (!ask) throw new Error('ask 没写进去');

    expect(await setAskFollowUpIssue(t.db, { askId: ask.id, issueNumber: 321 })).toBe('ok');
    expect((await t.db.select().from(asks).where(eq(asks.id, ask.id)))[0]?.followUpIssue).toBe(321);

    expect(await setAskFollowUpIssue(t.db, { askId: ask.id, issueNumber: 321 })).toBe('same');
    expect((await t.db.select().from(asks).where(eq(asks.id, ask.id)))[0]?.followUpIssue).toBe(321);

    expect(await setAskFollowUpIssue(t.db, { askId: ask.id, issueNumber: 999 })).toBe('conflict');
    expect((await t.db.select().from(asks).where(eq(asks.id, ask.id)))[0]?.followUpIssue).toBe(321);

    expect(await setAskFollowUpIssue(t.db, { askId: randomUUID(), issueNumber: 5 })).toBe('not_found');
  });

  it('issueNumber 不是正整数：抛错', async () => {
    const repo = await addRepo(t.db);
    const task = await addTask(t.db, repo.id);
    const [ask] = await t.db
      .insert(asks)
      .values({ taskId: task.id, question: '要不要开后续单', askedAt: ago(MIN) })
      .returning();
    if (!ask) throw new Error('ask 没写进去');
    await expect(setAskFollowUpIssue(t.db, { askId: ask.id, issueNumber: 0 })).rejects.toThrow('正整数');
    await expect(setAskFollowUpIssue(t.db, { askId: ask.id, issueNumber: -3 })).rejects.toThrow('正整数');
    await expect(setAskFollowUpIssue(t.db, { askId: ask.id, issueNumber: 1.5 })).rejects.toThrow('正整数');
  });
});
