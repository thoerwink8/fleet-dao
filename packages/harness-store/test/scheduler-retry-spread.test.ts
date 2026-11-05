// 同一毫秒失败的重排要把到期错开（#3859 第 3 片）：退避上再加一段不超过退避本身的抖动。
// 退避为 0 不加抖动，到期不晚于数据库 now()，马上能再领。时刻仍只认数据库 now()，不改限速。
import { eq, sql } from 'drizzle-orm';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { claimJobs, retryJob, setQueueLimit } from '../src/scheduler.ts';
import { jobs } from '../src/schema.ts';
import type { Db } from '../src/store.ts';
import { createTestDb, type TestDb } from '../src/testing.ts';

let t: TestDb;
beforeAll(async () => {
  t = await createTestDb();
}, 60_000);
afterAll(() => t.close());
beforeEach(async () => {
  await t.pg.exec('truncate fleet2.jobs, fleet2.queue_limits restart identity');
  await setQueueLimit(t.db, 'q', 500, 500);
});

const LEASE = 60_000;
const N = 500;

describe('重排到期错开', () => {
  it('500 件用同一个大于 0 的退避重排：到期不全相同，都落在一倍到两倍退避之间', async () => {
    const backoffMs = 30_000;
    const secs = backoffMs / 1000;
    await t.pg.exec(
      `insert into fleet2.jobs (queue, key, payload)
       select 'q', 's' || i, '{}'::jsonb from generate_series(1, ${N}) as i`,
    );
    const claimed = await claimJobs(t.db, 'q', N, LEASE);
    expect(claimed).toHaveLength(N);

    // 放进同一个事务：Postgres 的 now() 在事务里不变，就是同一毫秒一起失败。
    // 比较也用这个 now()。没有抖动时 500 个 due_at 全相同；加上抖动后彼此错开，
    // 每个都在 now()+退避 到 now()+两倍退避（含两端）。
    const [stats] = await t.db.transaction(async (tx) => {
      const txDb = tx as unknown as Db;
      for (const job of claimed) await retryJob(txDb, job, '上游 503', backoffMs);
      return txDb
        .select({
          n: sql<number>`count(*)::int`,
          distinctDue: sql<number>`count(distinct ${jobs.dueAt})::int`,
          inWindow: sql<number>`(
            count(*) filter (
              where ${jobs.dueAt} >= now() + make_interval(secs => ${secs})
                and ${jobs.dueAt} <= now() + make_interval(secs => ${secs * 2})
            )
          )::int`,
        })
        .from(jobs)
        .where(eq(jobs.state, 'pending'));
    });

    expect(Number(stats?.n)).toBe(N);
    expect(Number(stats?.distinctDue)).toBeGreaterThan(1);
    expect(Number(stats?.inWindow)).toBe(N);
  }, 60_000);

  it('退避毫秒为 0：重排后的 due_at 不晚于数据库 now()，紧接着能领到', async () => {
    await t.pg.exec(`insert into fleet2.jobs (queue, key, payload) values ('q', 'z', '{}'::jsonb)`);
    const [job] = await claimJobs(t.db, 'q', 1, LEASE);
    if (!job) throw new Error('没领到');
    await retryJob(t.db, job, '上游 503', 0);
    const [row] = await t.db
      .select({ late: sql<number>`(${jobs.dueAt} > now())::int` })
      .from(jobs)
      .where(eq(jobs.key, 'z'));
    expect(Number(row?.late)).toBe(0);
    const [again] = await claimJobs(t.db, 'q', 1, LEASE);
    expect(again?.key).toBe('z');
  });
});
