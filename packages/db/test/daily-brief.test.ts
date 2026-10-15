// 每日简报要读的库（queries/daily-brief.ts）：合并提交对上 PR 和开单时刻、开着的要你拍和卡住报警、昨天停下的单、
// 以及看门狗和巡检判「今天的简报送到没」的事实和判法。

import { eq } from 'drizzle-orm';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import {
  beijingDay,
  dailyBriefKey,
  dailyBriefProblem,
  dailyBriefStatus,
  openBriefNotes,
  pullsByMergeSha,
  repoByName,
  stoppedTasksBetween,
} from '../src/queries/daily-brief.ts';
import { recordFeishuDelivery } from '../src/queries/feishu-push.ts';
import { registerScheduledJobs } from '../src/queries/schedule.ts';
import { notifications, pullRequests, scheduleRuns, stateChanges, tasks } from '../src/schema/index.ts';
import { createTestDb, resetTestDb, TEST_DB_TIMEOUT_MS, type TestDb } from '../src/testing.ts';
import { addRepo, addTask, ago, HOUR, MIN, NOW } from './helpers.ts';

let t: TestDb;
beforeAll(async () => {
  t = await createTestDb();
}, TEST_DB_TIMEOUT_MS);
afterAll(() => t.close());
beforeEach(() => resetTestDb(t));

const sha = (c: string) => c.repeat(40);

async function note(
  dedupeKey: string,
  level: 'decision' | 'alert' | 'daily',
  o: { taskId?: string; resolvedAt?: Date } = {},
) {
  const [row] = await t.db
    .insert(notifications)
    .values({ dedupeKey, level, title: `标题 ${dedupeKey}`, createdAt: ago(2 * HOUR), ...o })
    .returning({ id: notifications.id });
  if (!row) throw new Error('没插进去');
  return row.id;
}

describe('beijingDay', () => {
  it('按北京时间（UTC+8）切日：UTC 16:00 起是第二天', () => {
    expect(beijingDay(new Date('2026-10-14T15:59:00Z'))).toEqual({
      day: '2026-10-14',
      start: new Date('2026-10-13T16:00:00Z'),
    });
    expect(beijingDay(new Date('2026-10-14T16:00:00Z')).day).toBe('2026-10-15');
  });
});

describe('pullsByMergeSha', () => {
  it('按合并提交对上 PR；开单时刻取 PR 关的单里最早登记的那张，对不上单是 null', async () => {
    const r = await addRepo(t.db, 'fleet-dao');
    await addTask(t.db, r.id, { issueNumber: 7, title: '单七', createdAt: ago(5 * HOUR) });
    await addTask(t.db, r.id, { issueNumber: 8, createdAt: ago(9 * HOUR) });
    const base = {
      repoId: r.id,
      state: 'merged' as const,
      headSha: sha('a'),
      updatedAt: NOW,
      mergedAt: ago(HOUR),
    };
    await t.db.insert(pullRequests).values([
      { ...base, number: 101, headRef: 'fleet/7-a', mergeSha: sha('1'), issueRefs: [7, 8], title: '修 A' },
      { ...base, number: 102, headRef: 'local/9-b', mergeSha: sha('2'), issueRefs: [], title: '修 B' },
      { ...base, number: 103, headRef: 'local/9-c', mergeSha: sha('3'), issueRefs: [], title: '没上线' },
    ]);
    const got = await pullsByMergeSha(t.db, r.id, [sha('1'), sha('2'), sha('9')]);
    expect(got.sort((a, b) => a.number - b.number)).toEqual([
      {
        number: 101,
        title: '修 A',
        mergeSha: sha('1'),
        issueOpenedAt: ago(9 * HOUR),
        issues: [
          { number: 7, title: '单七' },
          { number: 8, title: expect.any(String) },
        ],
      },
      { number: 102, title: '修 B', mergeSha: sha('2'), issueOpenedAt: null, issues: [] },
    ]);
    expect(await pullsByMergeSha(t.db, r.id, [])).toEqual([]);
    expect(await repoByName(t.db, 'fleet-dao')).toMatchObject({ id: r.id, owner: 'acme', name: 'fleet-dao' });
    expect(await repoByName(t.db, 'nope')).toBeNull();
  });
});

describe('openBriefNotes / stoppedTasksBetween', () => {
  it('开着的要你拍带上单子；卡住报警不含再提醒和已撤的', async () => {
    const r = await addRepo(t.db, 'fleet-dao');
    const task = await addTask(t.db, r.id, { issueNumber: 42 });
    await note('decide', 'decision', { taskId: task.id });
    await note('decide-done', 'decision', { resolvedAt: ago(MIN) });
    await note('task:x:park:1', 'alert');
    await note('remind:x:2026-10-14', 'alert');
    await note('release:done:abc:1', 'daily');
    await note('feishu:brief:2026-10-15', 'daily');
    const decisions = await openBriefNotes(t.db, 'decision');
    expect(decisions.map((n) => [n.dedupeKey, n.issue])).toEqual([
      ['decide', { repo: 'acme/fleet-dao', number: 42 }],
    ]);
    expect((await openBriefNotes(t.db, 'alert')).map((n) => n.dedupeKey)).toEqual(['task:x:park:1']);
    expect((await openBriefNotes(t.db, 'daily')).map((n) => n.dedupeKey).sort()).toEqual([
      'feishu:brief:2026-10-15',
      'release:done:abc:1',
    ]);
  });

  it('窗口里转成 failed / stalled、现在还是这个状态的才算', async () => {
    const r = await addRepo(t.db, 'fleet-dao');
    const failed = await addTask(t.db, r.id, {
      issueNumber: 1,
      title: '挂了的',
      lastProblem: '动手 3 轮都没过',
    });
    const healed = await addTask(t.db, r.id, { issueNumber: 2 });
    const older = await addTask(t.db, r.id, { issueNumber: 3 });
    await t.db.update(tasks).set({ state: 'failed' }).where(eq(tasks.id, failed.id));
    await t.db.update(tasks).set({ state: 'stalled' }).where(eq(tasks.id, older.id));
    const change = (taskId: string, toState: string, at: Date) => ({
      entity: 'task' as const,
      entityId: taskId,
      taskId,
      toState,
      at,
    });
    await t.db
      .insert(stateChanges)
      .values([
        change(failed.id, 'failed', ago(3 * HOUR)),
        change(healed.id, 'stalled', ago(3 * HOUR)),
        change(older.id, 'stalled', ago(30 * HOUR)),
      ]);
    expect(await stoppedTasksBetween(t.db, ago(24 * HOUR), NOW)).toEqual([
      { repo: 'acme/fleet-dao', number: 1, title: '挂了的', state: 'failed', lastProblem: '动手 3 轮都没过' },
    ]);
  });
});

describe('dailyBriefStatus / dailyBriefProblem（看门狗和巡检的判法）', () => {
  // 北京时间 2026-10-15 09:10
  const at = new Date('2026-10-15T01:10:00Z');
  const { day, start } = beijingDay(at);

  it('09:00 之前不判', async () => {
    const s = await dailyBriefStatus(t.db, day, start);
    expect(dailyBriefProblem(s, new Date('2026-10-15T00:50:00Z'))).toBeNull();
  });

  it('今天一轮都没起：报没跑', async () => {
    expect(dailyBriefProblem(await dailyBriefStatus(t.db, day, start), at)).toContain('没跑');
  });

  it('跑了没做成：报原因；做成了但没推到飞书：报试了几次；推到了：好', async () => {
    await registerScheduledJobs(t.db, [
      { id: 'daily-brief', name: '每日简报', schedule: '每天 08:30', expectEveryMinutes: 2880 },
    ]);
    const run = async (outcome: 'failed' | 'ok', why: string) =>
      t.db.insert(scheduleRuns).values({
        job: 'daily-brief',
        startedAt: new Date('2026-10-15T00:30:00Z'),
        endedAt: new Date('2026-10-15T00:31:00Z'),
        outcome,
        why,
        ...(outcome === 'ok' ? { scanned: 4, found: 0 } : {}),
      });
    await run('failed', '#1055 评论没发成：403');
    expect(dailyBriefProblem(await dailyBriefStatus(t.db, day, start), at)).toContain(
      '#1055 评论没发成：403',
    );

    await t.db.delete(scheduleRuns);
    await run('ok', '简报发了');
    expect(dailyBriefProblem(await dailyBriefStatus(t.db, day, start), at)).toContain('没建出来');

    const [row] = await t.db
      .insert(notifications)
      .values({ dedupeKey: dailyBriefKey(day), level: 'daily', title: '【每日简报】', createdAt: start })
      .returning({ id: notifications.id });
    if (!row) throw new Error('没插进去');
    await recordFeishuDelivery(t.db, { notificationId: row.id, at, error: '飞书回了 code=99991663' });
    const s = await dailyBriefStatus(t.db, day, start);
    expect(s.notification).toMatchObject({ attempts: 1, deliveredAt: null });
    expect(dailyBriefProblem(s, at)).toContain('没推到飞书：试了 1 次，最近一次：飞书回了 code=99991663');

    await recordFeishuDelivery(t.db, { notificationId: row.id, at, messageId: 'om_1' });
    expect(dailyBriefProblem(await dailyBriefStatus(t.db, day, start), at)).toBeNull();
  });
});
