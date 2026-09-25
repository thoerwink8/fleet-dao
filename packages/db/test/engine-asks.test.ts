// 引擎提问、报警、人闸批准，外加会话进度事实。
import { randomUUID } from 'node:crypto';
import { eq } from 'drizzle-orm';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import {
  decideApproval,
  getApproval,
  openApproval,
  openEngineAsk,
  runProgressFacts,
  upsertAlert,
} from '../src/queries/engine.ts';
import { asks, notifications, progressEvents } from '../src/schema/index.ts';
import { createTestDb, resetTestDb, TEST_DB_TIMEOUT_MS, type TestDb } from '../src/testing.ts';
import { addRepo, addRoute, addRun, addTask, ago, catalog, MIN, NOW } from './helpers.ts';

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
  return { repo, task, run };
}

describe('openEngineAsk', () => {
  it('挂上会话时，和 fleet ask 一样在同一事务里补一条 kind=ask 的进度事件', async () => {
    const { task, run } = await fixtures();
    const id = randomUUID();
    const result = await openEngineAsk(t.db, {
      id,
      taskId: task.id,
      runId: run.id,
      question: '要不要兼容旧接口？',
      options: ['要', '不要'],
    });
    expect(result).toEqual({ created: true, runLinked: true });
    const [ask] = await t.db.select().from(asks).where(eq(asks.id, id));
    expect(ask).toMatchObject({ taskId: task.id, runId: run.id, question: '要不要兼容旧接口？' });
    const events = await t.db.select().from(progressEvents);
    expect(events.map((e) => e.kind)).toContain('ask');
  });

  it('没有会话（runId 为 null）照样能问，runLinked=false，不补进度事件', async () => {
    const { task } = await fixtures();
    const id = randomUUID();
    expect(
      await openEngineAsk(t.db, { id, taskId: task.id, runId: null, question: '要不要发版？', options: [] }),
    ).toEqual({
      created: true,
      runLinked: false,
    });
  });

  it('按 id 幂等：重复调用不插第二行', async () => {
    const { task, run } = await fixtures();
    const id = randomUUID();
    const first = await openEngineAsk(t.db, {
      id,
      taskId: task.id,
      runId: run.id,
      question: 'Q1',
      options: [],
    });
    expect(first).toEqual({ created: true, runLinked: true });
    const second = await openEngineAsk(t.db, {
      id,
      taskId: task.id,
      runId: run.id,
      question: '换一句也不会覆盖',
      options: [],
    });
    expect(second).toEqual({ created: false, runLinked: true });
    const rows = await t.db.select().from(asks).where(eq(asks.id, id));
    expect(rows).toHaveLength(1);
    expect(rows[0]?.question).toBe('Q1');
  });

  it('撞 (run_id, md5(question)) 唯一（同一会话已经问过一模一样的话）：退成 run_id=null 再插一次', async () => {
    const { task, run } = await fixtures();
    const already = randomUUID();
    await t.db.insert(asks).values({ id: already, taskId: task.id, runId: run.id, question: '要不要 A？' });
    const id = randomUUID();
    const result = await openEngineAsk(t.db, {
      id,
      taskId: task.id,
      runId: run.id,
      question: '要不要 A？',
      options: [],
    });
    expect(result).toEqual({ created: true, runLinked: false });
    const [row] = await t.db.select().from(asks).where(eq(asks.id, id));
    expect(row?.runId).toBeNull();
  });

  it('撞 (task_id, run_id) 外键不满足（这个 runId 不属于这个 taskId 名下的会话）：退成 run_id=null 再插一次', async () => {
    const { task } = await fixtures();
    const id = randomUUID();
    const result = await openEngineAsk(t.db, {
      id,
      taskId: task.id,
      runId: randomUUID(),
      question: '这个会话是野的',
      options: [],
    });
    expect(result).toEqual({ created: true, runLinked: false });
  });

  it('任务不在照常抛', async () => {
    await expect(
      openEngineAsk(t.db, {
        id: randomUUID(),
        taskId: randomUUID(),
        runId: null,
        question: 'x',
        options: [],
      }),
    ).rejects.toThrow();
  });
});

describe('upsertAlert', () => {
  it('第一次创建；再报同一件事原地更新标题正文，不新开一条', async () => {
    const first = await upsertAlert(t.db, {
      dedupeKey: 'stuck:12:execute',
      level: 'alert',
      taskId: null,
      title: '卡住了',
      body: '第一版说法',
    });
    expect(first.created).toBe(true);
    const second = await upsertAlert(t.db, {
      dedupeKey: 'stuck:12:execute',
      level: 'alert',
      taskId: null,
      title: '还卡着',
      body: '第二版说法',
    });
    expect(second).toEqual({ id: first.id, created: false });
    const rows = await t.db.select().from(notifications);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ title: '还卡着', body: '第二版说法' });
  });

  it('已处理的重新打开', async () => {
    const { id } = await upsertAlert(t.db, {
      dedupeKey: 'gate:1',
      level: 'decision',
      taskId: null,
      title: '要你拍',
      body: '批不批',
    });
    await t.db
      .update(notifications)
      .set({ resolvedAt: NOW, resolvedBy: 'founder-a' })
      .where(eq(notifications.id, id));
    await upsertAlert(t.db, {
      dedupeKey: 'gate:1',
      level: 'decision',
      taskId: null,
      title: '要你拍',
      body: '又要批一次',
    });
    const [row] = await t.db.select().from(notifications).where(eq(notifications.id, id));
    expect(row?.resolvedAt).toBeNull();
    expect(row?.resolvedBy).toBeNull();
  });
});

describe('人闸批准', () => {
  it('openApproval 按 id 幂等，同时开一条待批的报警', async () => {
    const { task } = await fixtures();
    const id = randomUUID();
    const input = {
      id,
      taskId: task.id,
      subtaskId: null,
      holds: ['release'],
      prNumber: 7,
      head: 'deadbeef',
      title: '发版',
      summary: '合并即上线',
    };
    expect(await openApproval(t.db, input)).toEqual({ created: true });
    expect(await openApproval(t.db, input)).toEqual({ created: false });
    expect(await getApproval(t.db, id)).toMatchObject({
      id,
      taskId: task.id,
      holds: ['release'],
      prNumber: 7,
      decision: null,
    });
    const [alert] = await t.db
      .select()
      .from(notifications)
      .where(eq(notifications.dedupeKey, `approval:${id}`));
    expect(alert).toMatchObject({ level: 'decision', title: '发版' });
  });

  it('decideApproval 正常批准；已决定的不改；不存在回 not_found', async () => {
    const { task } = await fixtures();
    const id = randomUUID();
    await openApproval(t.db, {
      id,
      taskId: task.id,
      subtaskId: null,
      holds: ['release'],
      prNumber: 7,
      head: 'deadbeef',
      title: '发版',
      summary: '合并即上线',
    });
    expect(await decideApproval(t.db, { id, decision: 'approved', by: 'founder-a' })).toBe('ok');
    expect(await getApproval(t.db, id)).toMatchObject({ decision: 'approved', decidedBy: 'founder-a' });

    expect(await decideApproval(t.db, { id, decision: 'rejected', by: 'someone-else', reason: '手滑' })).toBe(
      'already_decided',
    );
    expect(await getApproval(t.db, id)).toMatchObject({
      decision: 'approved',
      decidedBy: 'founder-a',
      reason: null,
    });

    expect(await decideApproval(t.db, { id: randomUUID(), decision: 'approved', by: 'founder-a' })).toBe(
      'not_found',
    );
  });
});

describe('runProgressFacts', () => {
  it('会话不在回 null（不是「没有进度」）', async () => {
    expect(await runProgressFacts(t.db, randomUUID())).toBeNull();
  });

  it('步骤推进时刻按相邻两次 plan 比较；第一次 plan 全是 pending 不算推进', async () => {
    const { run } = await fixtures();
    await t.db.insert(progressEvents).values([
      {
        runId: run.id,
        at: ago(30 * MIN),
        kind: 'plan',
        payload: { steps: [{ title: '读需求', state: 'pending' }] },
      },
      {
        runId: run.id,
        at: ago(20 * MIN),
        kind: 'plan',
        payload: { steps: [{ title: '读需求', state: 'in_progress' }] },
      },
      {
        runId: run.id,
        at: ago(10 * MIN),
        kind: 'plan',
        payload: {
          steps: [
            { title: '读需求', state: 'done' },
            { title: '写测试（新加的一步）', state: 'pending' },
          ],
        },
      },
    ]);
    const facts = await runProgressFacts(t.db, run.id);
    expect(facts?.lastStepAdvanceAt).toEqual(ago(10 * MIN));
    expect(facts?.lastPlan).toEqual({
      at: ago(10 * MIN),
      steps: [
        { title: '读需求', state: 'done' },
        { title: '写测试（新加的一步）', state: 'pending' },
      ],
    });
  });

  it('第一次 plan 里有非 pending 的也算推进', async () => {
    const { run } = await fixtures();
    await t.db.insert(progressEvents).values({
      runId: run.id,
      at: ago(MIN),
      kind: 'plan',
      payload: { steps: [{ title: '接着上次继续', state: 'in_progress' }] },
    });
    expect((await runProgressFacts(t.db, run.id))?.lastStepAdvanceAt).toEqual(ago(MIN));
  });

  it('给出最后一条 done / blocked、最早的未答 ask、最近 N 条 say（新的在后）、最后一条事件的时刻', async () => {
    const { task, run } = await fixtures();
    await t.db.insert(progressEvents).values([
      { runId: run.id, at: ago(50 * MIN), kind: 'say', payload: { text: '第一句' } },
      { runId: run.id, at: ago(40 * MIN), kind: 'say', payload: { text: '第二句' } },
      { runId: run.id, at: ago(30 * MIN), kind: 'say', payload: { text: '第三句' } },
      {
        runId: run.id,
        at: ago(20 * MIN),
        kind: 'done',
        payload: { summary: '写完了', testsPassed: true, verified: { prNumber: 9 } },
      },
      { runId: run.id, at: ago(10 * MIN), kind: 'blocked', payload: { reason: '缺凭据', needs: 'access' } },
    ]);
    await t.db.insert(asks).values([
      { taskId: task.id, runId: run.id, question: '后问的', askedAt: ago(15 * MIN) },
      { taskId: task.id, runId: run.id, question: '先问的', askedAt: ago(25 * MIN) },
    ]);

    const facts = await runProgressFacts(t.db, run.id, { saysLimit: 2 });
    expect(facts?.lastEventAt).toEqual(ago(10 * MIN));
    expect(facts?.says).toEqual([
      { at: ago(40 * MIN), text: '第二句' },
      { at: ago(30 * MIN), text: '第三句' },
    ]);
    expect(facts?.pendingAsk?.question).toBe('先问的');
    expect(facts?.done).toMatchObject({ at: ago(20 * MIN), summary: '写完了', testsPassed: true });
    expect(facts?.blocked).toMatchObject({ at: ago(10 * MIN), reason: '缺凭据', needs: 'access' });
  });

  it("done 事件的 summary / testsPassed 认不出格式时给 '' / null，但原始 payload 照样带出去", async () => {
    const { run } = await fixtures();
    await t.db
      .insert(progressEvents)
      .values({ runId: run.id, at: ago(MIN), kind: 'done', payload: { weird: true } });
    const facts = await runProgressFacts(t.db, run.id);
    expect(facts?.done).toEqual({ at: ago(MIN), summary: '', testsPassed: null, payload: { weird: true } });
  });
});
