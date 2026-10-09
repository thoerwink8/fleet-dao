// 引擎起来时补记被腰斩的 schedule_runs（#1522）：进程重启后 start 了没 finish 的行会一直挂「进行中」。
import { eq } from 'drizzle-orm';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import type { Db } from '../src/client.ts';
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

/** 任何一次库调用都写成失败：补记必须把这个错抛出去，不能当成没有孤儿。 */
function failingDb(): Db {
  const boom = () => {
    throw new Error('库写不进');
  };
  const chain: unknown = new Proxy(boom, {
    get: () => chain,
    apply: () => {
      throw new Error('库写不进');
    },
  });
  return new Proxy({} as Db, {
    get: () => () => chain,
  });
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

  it('【故意造出的失败】补记写库失败要抛，不能当成没有孤儿', async () => {
    await expect(
      closeInterruptedScheduleRuns(failingDb(), {
        jobs: [{ id: 'route-probe', startedBefore: ago(15 * MIN) }],
        at: NOW,
      }),
    ).rejects.toThrow(/补记没收尾的定时任务失败：库写不进/);
  });
});
