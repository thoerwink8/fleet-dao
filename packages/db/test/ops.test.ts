import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import {
  claimIdempotencyKey,
  completeIdempotencyKey,
  releaseIdempotencyKey,
} from '../src/queries/idempotency.ts';
import {
  finishScheduleRun,
  registerScheduledJobs,
  scheduleHealth,
  startScheduleRun,
} from '../src/queries/schedule.ts';
import { scheduledJobs } from '../src/schema/index.ts';
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

describe('定时任务：没跑成 ≠ 没问题', () => {
  /** 6 小时一轮的任务，7 小时没成功就算过期。 */
  const every6h = (id: string) => ({ id, name: id, schedule: '每 6 小时', expectEveryMinutes: 7 * 60 });

  async function run(
    job: string,
    startMinAgo: number,
    result: Parameters<typeof finishScheduleRun>[2] | null,
  ) {
    const id = await startScheduleRun(t.db, job, ago(startMinAgo * MIN));
    if (result) await finishScheduleRun(t.db, id, result, ago((startMinAgo - 1) * MIN));
    return id;
  }

  it('登记了但一次都没跑过的任务也列出来，标 never', async () => {
    await registerScheduledJobs(t.db, [every6h('quota-read')]);
    const [health] = await scheduleHealth(t.db, NOW);
    expect(health).toMatchObject({
      job: { id: 'quota-read', expectEveryMinutes: 420 },
      status: 'never',
      running: false,
      lastRun: null,
      lastSuccess: null,
    });
  });

  it('查了、0 个问题是 ok；一个对象都没扫到记 unscanned，健康度是 no-samples，两者分开', async () => {
    await registerScheduledJobs(t.db, [every6h('reconcile'), every6h('canary')]);
    await run('reconcile', 30, { outcome: 'ok', scanned: 12, found: 0 });
    await run('canary', 30, { outcome: 'unscanned', why: '考题库是空的' });
    const health = await scheduleHealth(t.db, NOW);
    expect(health.map((h) => [h.job.id, h.status, h.lastRun?.outcome, h.lastRun?.scanned])).toEqual([
      ['canary', 'no-samples', 'unscanned', 0],
      ['reconcile', 'ok', 'ok', 12],
    ]);
  });

  it('一直没扫到东西的任务报 no-samples，不因为「跑过了」就当没事', async () => {
    await registerScheduledJobs(t.db, [every6h('model-scan')]);
    await run('model-scan', 20 * 60, { outcome: 'ok', scanned: 8, found: 0 });
    await run('model-scan', 60, { outcome: 'unscanned', why: '名册帧是空的' });
    await run('model-scan', 10, { outcome: 'unscanned', why: '名册帧是空的' });
    const [health] = await scheduleHealth(t.db, NOW);
    expect(health).toMatchObject({ status: 'no-samples', lastSuccess: { scanned: 8 } });
  });

  it('ok 却一个都没扫到，库不收（要写 unscanned）', async () => {
    await registerScheduledJobs(t.db, [every6h('probe')]);
    const id = await startScheduleRun(t.db, 'probe', ago(MIN));
    await expect(finishScheduleRun(t.db, id, { outcome: 'ok', scanned: 0, found: 0 }, NOW)).rejects.toThrow();
  });

  it('上次成功太久了就是 stale，哪怕最近一次还在跑', async () => {
    await registerScheduledJobs(t.db, [every6h('probe')]);
    await run('probe', 9 * 60, { outcome: 'ok', scanned: 3, found: 1 });
    await run('probe', 5, null);
    const [health] = await scheduleHealth(t.db, NOW);
    expect(health).toMatchObject({ status: 'stale', running: true });
  });

  it('最近一次没跑成是 failing；还在跑的那次不算结局', async () => {
    await registerScheduledJobs(t.db, [every6h('backup')]);
    await run('backup', 120, { outcome: 'ok', scanned: 1, found: 0 });
    await run('backup', 60, { outcome: 'failed', why: 'pg_dump 退出 1' });
    await run('backup', 5, null);
    const [health] = await scheduleHealth(t.db, NOW);
    expect(health).toMatchObject({ status: 'failing', running: true });
    expect(health?.lastSuccess?.scanned).toBe(1);
  });

  it('部分没查成算跑成了（数据不全是状态不是故障），原因留着', async () => {
    await registerScheduledJobs(t.db, [every6h('cursor-usage')]);
    await run('cursor-usage', 10, {
      outcome: 'partial',
      scanned: 153,
      found: 0,
      why: '15 个会话超出回看窗口',
    });
    const [health] = await scheduleHealth(t.db, NOW);
    expect(health).toMatchObject({
      status: 'ok',
      lastSuccess: { outcome: 'partial', why: '15 个会话超出回看窗口' },
    });
  });

  it('重复登记只更新计划，不丢运行记录', async () => {
    await registerScheduledJobs(t.db, [every6h('probe')]);
    await run('probe', 10, { outcome: 'ok', scanned: 3, found: 0 });
    await registerScheduledJobs(t.db, [
      { ...every6h('probe'), schedule: '每 3 小时', expectEveryMinutes: 200 },
    ]);
    expect(await t.db.select().from(scheduledJobs)).toEqual([
      { id: 'probe', name: 'probe', schedule: '每 3 小时', expectEveryMinutes: 200 },
    ]);
    const [health] = await scheduleHealth(t.db, NOW);
    expect(health?.status).toBe('ok');
  });

  it('收尾一个不存在的记录要报错，不装成功', async () => {
    await expect(finishScheduleRun(t.db, 999, { outcome: 'ok', scanned: 1, found: 0 })).rejects.toThrow(
      /999/,
    );
  });
});

describe('外部写操作的幂等键', () => {
  const input = {
    key: 'gh:comment:acme/shop#12:progress',
    action: 'github.issue.comment',
    target: 'acme/shop#12',
  };

  it('先占到的去写；写成后重放直接拿回执，不再写', async () => {
    expect(await claimIdempotencyKey(t.db, input, NOW)).toEqual({ status: 'claimed' });
    expect(await claimIdempotencyKey(t.db, input, NOW)).toEqual({ status: 'in-flight', claimedAt: NOW });
    await completeIdempotencyKey(t.db, input.key, { url: 'https://github.com/acme/shop/issues/12#c1' }, NOW);
    expect(await claimIdempotencyKey(t.db, input, NOW)).toEqual({
      status: 'done',
      result: { url: 'https://github.com/acme/shop/issues/12#c1' },
      completedAt: NOW,
    });
  });

  it('同时来抢，只有一个占到', async () => {
    const results = await Promise.all(Array.from({ length: 5 }, () => claimIdempotencyKey(t.db, input, NOW)));
    expect(results.filter((r) => r.status === 'claimed')).toHaveLength(1);
  });

  it('确认没写成就放键，重试能重新占；写成了的键放不掉，也不能完成两次', async () => {
    await claimIdempotencyKey(t.db, input, NOW);
    expect(await releaseIdempotencyKey(t.db, input.key)).toBe(true);
    expect(await claimIdempotencyKey(t.db, input, NOW)).toEqual({ status: 'claimed' });
    await completeIdempotencyKey(t.db, input.key, { number: 31 }, NOW);
    expect(await releaseIdempotencyKey(t.db, input.key)).toBe(false);
    await expect(completeIdempotencyKey(t.db, input.key, { number: 32 }, NOW)).rejects.toThrow(/已经完成/);
  });
});
