// 引擎起来时补记被腰斩的 schedule_runs（#1522）：进程重启后 start 了没 finish 的行会一直挂「进行中」。
import { eq } from 'drizzle-orm';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import {
  closeInterruptedScheduleRuns,
  finishScheduleRun,
  INTERRUPTED_SCHEDULE_WHY,
  registerScheduledJobs,
  scheduleHealth,
  startScheduleRun,
} from '../src/queries/schedule.ts';
import { scheduleRuns } from '../src/schema/index.ts';
import { createTestDb, resetTestDb, TEST_DB_TIMEOUT_MS, type TestDb } from '../src/testing.ts';
import { ago, MIN, NOW } from './helpers.ts';

let t: TestDb;
beforeAll(async () => {
  t = await createTestDb();
}, TEST_DB_TIMEOUT_MS);
afterAll(() => t.close());
beforeEach(async () => {
  await resetTestDb(t);
});

const job = (id: string, expectEveryMinutes = 45) => ({
  id,
  name: id,
  schedule: '每 15 分钟',
  expectEveryMinutes,
});

/** 顺着 cause 把报错拼起来。drizzle 把真正的库错误放在 cause 里，只看最外层会漏掉「库写不进」。 */
function errorText(error: unknown): string {
  const parts: string[] = [];
  for (let current: unknown = error; current instanceof Error && parts.length < 8; current = current.cause) {
    parts.push(current.message);
  }
  return parts.join('\n');
}

describe('起来时补记进程中断没收尾的 schedule_runs（#1522）', () => {
  it('超过一轮工作上限还没结束的补记成 failed，why 含「没收尾」；没超过的、别的任务的、已经收尾的不动', async () => {
    await registerScheduledJobs(t.db, [job('route-probe'), job('backup', 24 * 60)]);
    const oldId = await startScheduleRun(t.db, 'route-probe', ago(3 * 60 * MIN));
    const boundaryId = await startScheduleRun(t.db, 'route-probe', ago(15 * MIN));
    const youngId = await startScheduleRun(t.db, 'route-probe', ago(5 * MIN));
    const otherId = await startScheduleRun(t.db, 'backup', ago(3 * 60 * MIN));
    const doneId = await startScheduleRun(t.db, 'route-probe', ago(2 * 60 * MIN));
    await finishScheduleRun(t.db, doneId, { outcome: 'ok', scanned: 9, found: 0 }, ago(119 * MIN));

    const closed = await closeInterruptedScheduleRuns(t.db, {
      jobs: [{ id: 'route-probe', startedBefore: ago(15 * MIN) }],
      at: NOW,
    });

    expect(INTERRUPTED_SCHEDULE_WHY).toContain('没收尾');
    expect(closed).toEqual([oldId]);
    const rows = await t.db.select().from(scheduleRuns).orderBy(scheduleRuns.id);
    const byId = new Map(rows.map((r) => [r.id, r]));
    expect(byId.get(oldId)).toMatchObject({
      outcome: 'failed',
      why: INTERRUPTED_SCHEDULE_WHY,
      endedAt: ago(3 * 60 * MIN),
    });
    expect(byId.get(boundaryId)).toMatchObject({ outcome: null, endedAt: null });
    expect(byId.get(youngId)).toMatchObject({ outcome: null, endedAt: null });
    expect(byId.get(otherId)).toMatchObject({ outcome: null, endedAt: null });
    expect(byId.get(doneId)).toMatchObject({ outcome: 'ok', scanned: 9, found: 0 });
    expect(
      await closeInterruptedScheduleRuns(t.db, {
        jobs: [{ id: 'route-probe', startedBefore: ago(15 * MIN) }],
        at: NOW,
      }),
    ).toEqual([]);
  });

  it('补记不把结束时刻写成现在：后面已经跑成的一轮仍是最近一次结束的，看门狗不把旧孤儿当成「最近没跑成」', async () => {
    await registerScheduledJobs(t.db, [job('route-probe')]);
    await startScheduleRun(t.db, 'route-probe', ago(3 * 60 * MIN));
    const okId = await startScheduleRun(t.db, 'route-probe', ago(20 * MIN));
    await finishScheduleRun(t.db, okId, { outcome: 'ok', scanned: 9, found: 0 }, ago(19 * MIN));

    await closeInterruptedScheduleRuns(t.db, {
      jobs: [{ id: 'route-probe', startedBefore: ago(15 * MIN) }],
      at: NOW,
    });

    const [health] = await scheduleHealth(t.db, NOW);
    expect(health).toMatchObject({
      status: 'ok',
      fresh: true,
      running: false,
      lastFinished: { id: okId, outcome: 'ok' },
    });
    const [open] = await t.db.select().from(scheduleRuns).where(eq(scheduleRuns.outcome, 'failed'));
    expect(open?.why).toContain('没收尾');
    expect(open?.endedAt).toEqual(ago(3 * 60 * MIN));
  });

  it('不写为什么：抛，一行都不动', async () => {
    await registerScheduledJobs(t.db, [job('route-probe')]);
    const id = await startScheduleRun(t.db, 'route-probe', ago(3 * 60 * MIN));
    await expect(
      closeInterruptedScheduleRuns(t.db, {
        jobs: [{ id: 'route-probe', startedBefore: ago(15 * MIN) }],
        at: NOW,
        why: '  ',
      }),
    ).rejects.toThrow('要写为什么');
    const [row] = await t.db.select().from(scheduleRuns).where(eq(scheduleRuns.id, id));
    expect(row).toMatchObject({ outcome: null, endedAt: null });
  });

  it('【故意造出的失败】查到超时孤儿后，补记的更新写不进要抛，不能当成没有孤儿', async () => {
    await registerScheduledJobs(t.db, [job('route-probe')]);
    const id = await startScheduleRun(t.db, 'route-probe', ago(3 * 60 * MIN));
    // 查询读得到这条超时行；更新被触发器拒掉。错要出在更新上，不能在第一条 select 就抛。
    await t.client.exec(`
      create or replace function schedule_runs_close_boom() returns trigger
      language plpgsql as $$
      begin
        raise exception '库写不进';
      end;
      $$
    `);
    await t.client.exec(`
      create trigger schedule_runs_close_boom
      before update on schedule_runs
      for each row execute function schedule_runs_close_boom()
    `);
    try {
      const error = await closeInterruptedScheduleRuns(t.db, {
        jobs: [{ id: 'route-probe', startedBefore: ago(15 * MIN) }],
        at: NOW,
      }).then(
        () => null,
        (caught: unknown) => caught,
      );
      const text = errorText(error);
      expect(text).toContain('补记没收尾的定时任务失败');
      expect(text).toContain('Failed query: update');
      expect(text).toContain('库写不进');
      const [row] = await t.db.select().from(scheduleRuns).where(eq(scheduleRuns.id, id));
      expect(row).toMatchObject({ outcome: null, endedAt: null, why: null });
    } finally {
      await t.client.exec('drop trigger if exists schedule_runs_close_boom on schedule_runs');
      await t.client.exec('drop function if exists schedule_runs_close_boom()');
    }
  });
});
