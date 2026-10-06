// 引擎定时任务登记的真装配（#1140）：registerEngineJobs 一边把代码里还在的任务写进登记表，一边把
// 退役名单（jobs/retired-schedules.ts，不带 moved 的）的登记行摘掉——不摘的话，#445 删掉的任务（alert-dispatch）
// 的登记行永远留在表上，定时任务页一直标「过期」。库是 PGlite 上跑真迁移。
import { scheduledJobs } from '@fleet-dao/db';
import { createTestDb, resetTestDb, TEST_DB_TIMEOUT_MS, type TestDb } from '@fleet-dao/db/testing';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { RETIRED_SCHEDULE_IDS } from '../../src/jobs/retired-schedules.ts';
import { ENGINE_JOBS, registerEngineJobs } from '../../src/real/jobs.ts';

let t: TestDb;
beforeAll(async () => {
  t = await createTestDb();
}, TEST_DB_TIMEOUT_MS);
afterAll(() => t.close());
beforeEach(async () => {
  await resetTestDb(t);
});

async function rows(): Promise<(typeof scheduledJobs.$inferSelect)[]> {
  return t.db.select().from(scheduledJobs);
}

describe('registerEngineJobs：登记在跑的、摘掉退役的（#1140）', () => {
  it('退役名单（alert-dispatch 这类）登记行标上摘除；ENGINE_JOBS 照常登记；外部注册的（备份脚本这类）不动', async () => {
    // 外部注册的任务：不在 ENGINE_JOBS、也不在退役名单上，登记行该留着
    await t.db
      .insert(scheduledJobs)
      .values({ id: 'backup.nightly', name: '备份', schedule: '每晚', expectEveryMinutes: 60 * 24 });
    // 上个版本的残留：alert-dispatch 还带着旧的登记行
    await t.db
      .insert(scheduledJobs)
      .values({ id: 'alert-dispatch', name: '提醒派单', schedule: '每 5 分钟', expectEveryMinutes: 5 });

    await registerEngineJobs(t.db);

    const all = await rows();
    for (const job of ENGINE_JOBS) {
      const row = all.find((r) => r.id === job.id);
      expect(row, `${job.id} 该登记上`).toBeDefined();
      expect(row?.removedAt).toBeNull();
    }
    expect(all.find((r) => r.id === 'alert-dispatch')?.removedAt).not.toBeNull();
    expect(all.find((r) => r.id === 'backup.nightly')?.removedAt).toBeNull();
  });

  it('退役名单里 moved 的（改进程内定时器的）不摘，照常登记', () => {
    // moved 的都在 ENGINE_JOBS 上（两边有测试核对对得上），退役名单摘的只有真退役的
    for (const id of RETIRED_SCHEDULE_IDS) expect(ENGINE_JOBS.some((j) => j.id === id)).toBe(false);
    expect([...RETIRED_SCHEDULE_IDS]).toContain('alert-dispatch');
  });
});
