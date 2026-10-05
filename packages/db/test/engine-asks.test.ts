// 报警、人闸批准，外加 asks 表的约束。
import { randomUUID } from 'node:crypto';
import { eq } from 'drizzle-orm';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import {
  getApproval,
  openAlertsByPrefix,
  openApproval,
  resolveAlertByKey,
  upsertAlert,
} from '../src/queries/engine.ts';
import { asks, notifications } from '../src/schema/index.ts';
import { createTestDb, resetTestDb, TEST_DB_TIMEOUT_MS, type TestDb } from '../src/testing.ts';
import {
  addRepo,
  addRoute,
  addRun,
  addTask,
  ago,
  catalog,
  expectViolation,
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

async function fixtures() {
  const repo = await addRepo(t.db);
  const task = await addTask(t.db, repo.id);
  const run = await addRun(t.db, { taskId: task.id, routeId: 'r1' });
  return { repo, task, run };
}

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

describe('resolveAlertByKey', () => {
  it('处理掉一条；再处理回 already_resolved，不改处理人和时刻；没报过的回 not_found', async () => {
    await upsertAlert(t.db, {
      dedupeKey: 'pool-hold:carpool-1',
      level: 'decision',
      taskId: null,
      title: '账号池暂停',
      body: '要重新登录',
    });
    expect(await resolveAlertByKey(t.db, { dedupeKey: 'pool-hold:carpool-1', by: 'engine', at: NOW })).toBe(
      'ok',
    );
    expect(
      await resolveAlertByKey(t.db, { dedupeKey: 'pool-hold:carpool-1', by: 'someone', at: later(MIN) }),
    ).toBe('already_resolved');
    const [row] = await t.db
      .select()
      .from(notifications)
      .where(eq(notifications.dedupeKey, 'pool-hold:carpool-1'));
    expect(row?.resolvedAt).toEqual(NOW);
    expect(row?.resolvedBy).toBe('engine');
    expect(await resolveAlertByKey(t.db, { dedupeKey: 'pool-hold:never', by: 'engine' })).toBe('not_found');
  });
});

describe('openAlertsByPrefix', () => {
  it('只给没处理的、前缀逐字对上的；前缀里的 % 和 _ 不当通配符', async () => {
    for (const key of ['pool-hold:a', 'pool-hold:b', 'pool-holder:x', 'stuck:1', 'p%_:1', 'pxx:1']) {
      await upsertAlert(t.db, { dedupeKey: key, level: 'alert', taskId: null, title: key, body: '' });
    }
    await resolveAlertByKey(t.db, { dedupeKey: 'pool-hold:b', by: 'engine' });
    expect((await openAlertsByPrefix(t.db, 'pool-hold:')).map((a) => a.dedupeKey)).toEqual(['pool-hold:a']);
    expect((await openAlertsByPrefix(t.db, 'p%_:')).map((a) => a.dedupeKey)).toEqual(['p%_:1']);
  });

  it('空前缀明确拒绝（那等于全表）', async () => {
    await expect(openAlertsByPrefix(t.db, '')).rejects.toThrow('空');
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
});

describe('asks 表的约束', () => {
  it('【故意造出的失败】提问的范围、推荐、人闸、后续单、生效时间：库里的约束拦下不成形的', async () => {
    const { task, run } = await fixtures();
    const base = { taskId: task.id, runId: run.id, options: ['甲', '乙'], askedAt: ago(MIN) };
    const bad: [typeof asks.$inferInsert, string][] = [
      [{ ...base, question: '范围认不出', scope: 'maybe' as never, recommended: '甲' }, 'asks_scope_known'],
      [{ ...base, question: '有范围没推荐', scope: 'task' }, 'asks_scoped_recommendation'],
      [
        { ...base, question: '推荐不在选项里', scope: 'task', recommended: '丙' },
        'asks_scoped_recommendation',
      ],
      [{ ...base, question: '人闸没说哪类', scope: 'hold', recommended: '甲' }, 'asks_hold_shape'],
      [
        { ...base, question: '不是人闸却带人闸', scope: 'task', recommended: '甲', hold: 'spend' },
        'asks_hold_shape',
      ],
      [
        { ...base, question: '人闸认不出', scope: 'hold', recommended: '甲', hold: 'secret' as never },
        'asks_hold_known',
      ],
      [
        { ...base, question: '没回答就生效', scope: 'task', recommended: '甲', appliedAt: ago(0) },
        'asks_applied_answered',
      ],
      [
        { ...base, question: '后续单号不对', scope: 'task', recommended: '甲', followUpIssue: 0 },
        'asks_follow_up_positive',
      ],
    ];
    for (const [row, constraint] of bad) await expectViolation(t.db.insert(asks).values(row), constraint);
    // 合格的写得进：老式的（全空）、按推荐先做的、碰人闸的、回答后生效并开了后续单的
    await t.db.insert(asks).values([
      { ...base, question: '老式的' },
      { ...base, question: '范围内', scope: 'task', recommended: '甲' },
      { ...base, question: '人闸', scope: 'hold', recommended: '乙', hold: 'standard' },
      {
        ...base,
        question: '晚到的回答',
        scope: 'task',
        recommended: '甲',
        answer: '乙',
        answeredBy: 'founder',
        answeredAt: ago(0),
        appliedAt: ago(0),
        followUpIssue: 12,
      },
    ]);
  });
});
