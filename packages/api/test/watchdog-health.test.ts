// /healthz 的 watchdog 项（健康页「看门狗」，#203）和后端看着看门狗的那一下：看门狗自己停了、没跑成，它自己报不了，
// 后端按登记表上它那一行现算。需求里「看门狗自己停了也要能被发现」在这里故意造：停了、没跑成、从没跑过、没登记都红，
// 后端推一条「看门狗停了」，好了自己撤、写明为什么。每一种对外的说法都拿演示版打包扫描的同一份名单扫：不带任务名、原因原文。
import {
  finishScheduleRun,
  type JobHealth,
  notifications,
  registerScheduledJobs,
  resolveAlertWithReason,
  type ScheduleResult,
  startScheduleRun,
} from '@fleet-dao/db';
import { createTestDb, resetTestDb, TEST_DB_TIMEOUT_MS, type TestDb } from '@fleet-dao/db/testing';
import { silentLogger } from '@fleet-dao/store';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { PublicHealthError, runHealthChecks } from '../src/health.ts';
import {
  WATCHDOG_DOWN_PREFIX,
  watchdogHealth,
  watchdogHealthCheck,
  watchdogWatchOnce,
} from '../src/watchdog-health.ts';

// 路径放进变量：api 的 tsconfig 不收 web 包的文件，照 deploy-lag.test.ts 的写法运行时再载
const SCAN = '../../web/src/build/scan.ts';
/** 北京时间 09-27 20:30。 */
const NOW = new Date('2026-09-27T12:30:00.000Z');
const MIN = 60_000;
const ago = (min: number) => new Date(NOW.getTime() - min * MIN);

type RunRow = NonNullable<JobHealth['lastRun']>;

const JOB: JobHealth['job'] = {
  id: 'watchdog',
  name: '看门狗（定时任务新不新鲜）',
  schedule: '每 5 分钟',
  expectEveryMinutes: 15,
  registeredAt: ago(30 * 24 * 60),
};

function runRow(over: Partial<RunRow> = {}): RunRow {
  return {
    id: 7,
    job: 'watchdog',
    startedAt: ago(4),
    endedAt: ago(4),
    outcome: 'ok',
    scanned: 7,
    found: 1,
    why: null,
    ...over,
  };
}

function health(over: Partial<JobHealth> = {}): JobHealth {
  const ok = runRow();
  return {
    job: JOB,
    status: 'ok',
    fresh: true,
    running: false,
    lastRun: ok,
    lastFinished: ok,
    lastSuccess: ok,
    ...over,
  };
}

describe('watchdog 项怎么判', () => {
  it('最近一轮跑完、不旧：好的，带一句几点跑完、查了几个、几个没按期跑成', () => {
    expect(watchdogHealth(health())).toEqual({
      ok: true,
      note: '最近一轮 09-27 20:26 跑完：查了 7 个定时任务，1 个没按期跑成',
    });
    const clean = runRow({ found: 0 });
    expect(watchdogHealth(health({ lastRun: clean, lastFinished: clean, lastSuccess: clean }))).toMatchObject(
      {
        ok: true,
        note: '最近一轮 09-27 20:26 跑完：查了 7 个定时任务，都按期跑成',
      },
    );
  });

  it('【故意造出的失败】看门狗停了（过了期望间隔没跑完一轮）：红，说上次几点跑完', () => {
    const old = runRow({ startedAt: ago(40), endedAt: ago(40) });
    expect(
      watchdogHealth(
        health({ status: 'stale', fresh: false, lastRun: old, lastFinished: old, lastSuccess: old }),
      ),
    ).toEqual({
      ok: false,
      code: 'watchdog_stale',
      message: '看门狗 09-27 19:50 之后超过 15 分钟没跑完一轮',
      detail: undefined,
    });
  });

  it('【故意造出的失败】看门狗最近一轮没跑成：红，原因原文只进日志', () => {
    const failed = runRow({
      id: 8,
      outcome: 'failed',
      why: '读不到定时任务的登记表或跑记录：relation 不在',
      scanned: null,
      found: null,
    });
    expect(watchdogHealth(health({ status: 'failing', lastRun: failed, lastFinished: failed }))).toEqual({
      ok: false,
      code: 'watchdog_failing',
      message: '看门狗最近一轮（09-27 20:26）没跑成',
      detail: '读不到定时任务的登记表或跑记录：relation 不在',
    });
  });

  it('【故意造出的失败】从没跑过、登记后过了期望间隔：红；没登记：红；最近一轮一个定时任务都没查到：红', () => {
    expect(
      watchdogHealth(
        health({ status: 'never', fresh: false, lastRun: null, lastFinished: null, lastSuccess: null }),
      ),
    ).toMatchObject({ ok: false, code: 'watchdog_stale', message: '看门狗登记后超过 15 分钟还没跑过一轮' });
    expect(watchdogHealth(undefined)).toMatchObject({
      ok: false,
      code: 'watchdog_unregistered',
      message: '看门狗还没登记',
    });
    const empty = runRow({
      id: 9,
      outcome: 'unscanned',
      why: '登记表上除了看门狗自己没有别的定时任务',
      scanned: 0,
      found: null,
    });
    expect(
      watchdogHealth(health({ status: 'no-samples', lastRun: empty, lastFinished: empty })),
    ).toMatchObject({
      ok: false,
      code: 'watchdog_unscanned',
      message: '看门狗最近一轮一个定时任务都没查到',
    });
  });

  it('刚登记、还在第一个期望间隔里（第一轮还没跑完）：好的，写明还没跑完第一轮', () => {
    expect(
      watchdogHealth(
        health({ status: 'never', fresh: true, lastRun: null, lastFinished: null, lastSuccess: null }),
      ),
    ).toEqual({ ok: true, note: '刚登记，第一轮还没跑完' });
  });

  it('每一种对外的说法都拿演示版打包扫描的名单扫一遍：没有内部名', async () => {
    const scan = (await import(/* @vite-ignore */ SCAN)) as {
      BUILTIN_TERMS: readonly string[];
      scanText(file: string, text: string, terms: readonly string[]): { term: string }[];
    };
    expect(scan.BUILTIN_TERMS.length).toBeGreaterThan(0);
    const old = runRow({ startedAt: ago(40), endedAt: ago(40) });
    const failed = runRow({ outcome: 'failed', why: 'x' });
    const said = [
      watchdogHealth(health()),
      watchdogHealth(
        health({ status: 'stale', fresh: false, lastRun: old, lastFinished: old, lastSuccess: old }),
      ),
      watchdogHealth(health({ status: 'stale', fresh: false, lastSuccess: null })),
      watchdogHealth(
        health({ status: 'never', fresh: false, lastRun: null, lastFinished: null, lastSuccess: null }),
      ),
      watchdogHealth(
        health({ status: 'never', fresh: true, lastRun: null, lastFinished: null, lastSuccess: null }),
      ),
      watchdogHealth(health({ status: 'failing', lastRun: failed, lastFinished: failed })),
      watchdogHealth(health({ status: 'no-samples', lastFinished: failed })),
      watchdogHealth(undefined),
    ].map((h) => (h.ok ? h.note : h.message));
    expect(new Set(said).size).toBe(8);
    for (const text of said) expect(scan.scanText('watchdog', text, scan.BUILTIN_TERMS), text).toEqual([]);
  });
});

describe('看门狗自己停了能被发现（真库）', () => {
  let t: TestDb;
  beforeAll(async () => {
    t = await createTestDb();
  }, TEST_DB_TIMEOUT_MS);
  afterAll(() => t.close());
  beforeEach(async () => {
    await resetTestDb(t);
  });

  let clock = NOW;
  const now = () => clock;

  async function register() {
    await registerScheduledJobs(t.db, [{ ...JOB }]);
  }
  async function round(startMinAgo: number, result: ScheduleResult) {
    const id = await startScheduleRun(t.db, 'watchdog', ago(startMinAgo));
    await finishScheduleRun(t.db, id, result, ago(startMinAgo));
    return id;
  }
  const downAlerts = async () =>
    (await t.db.select().from(notifications)).filter((n) => n.dedupeKey.startsWith(WATCHDOG_DOWN_PREFIX));

  it(
    '【故意造出的失败】看门狗 20 分钟没跑完一轮：/healthz 这一项红；后端推一条「看门狗停了」（写上次几点跑完、去哪看）；再看一轮没变不改卡；又跑完一轮自己撤、写明为什么',
    async () => {
      clock = NOW;
      await register();
      const last = await round(20, { outcome: 'ok', scanned: 7, found: 0 });
      const err = await watchdogHealthCheck(t.db, now)().then(
        () => null,
        (e: unknown) => e,
      );
      expect(err).toBeInstanceOf(PublicHealthError);
      expect(
        await runHealthChecks([{ name: 'watchdog', check: watchdogHealthCheck(t.db, now) }], silentLogger),
      ).toEqual({
        ok: false,
        checks: {
          watchdog: {
            ok: false,
            code: 'watchdog_stale',
            message: '看门狗 09-27 20:10 之后超过 15 分钟没跑完一轮',
          },
        },
      });

      expect(await watchdogWatchOnce({ db: t.db, now })).toBe('raised');
      const [down] = await downAlerts();
      expect(down).toMatchObject({
        dedupeKey: `watchdog-down:after-${last}`,
        level: 'alert',
        title: '看门狗停了：定时任务没人盯着',
        link: '/schedules',
        resolvedAt: null,
      });
      expect(down?.body.split('\n')[0]).toBe('看门狗 09-27 20:10 之后超过 15 分钟没跑完一轮。');
      expect(down?.body).toContain('fleet-temporal schedule trigger --schedule-id watchdog');
      clock = new Date(NOW.getTime() + 5 * MIN);
      expect(await watchdogWatchOnce({ db: t.db, now })).toBe('same');

      await round(-6, { outcome: 'ok', scanned: 7, found: 1 });
      clock = new Date(NOW.getTime() + 7 * MIN);
      expect(await watchdogWatchOnce({ db: t.db, now })).toBe('fine');
      const [back] = await downAlerts();
      expect(back).toMatchObject({ resolvedBy: 'api:watchdog' });
      expect(back?.body.split('\n')[0]).toBe(
        '已撤：看门狗恢复了：最近一轮 09-27 20:36 跑完：查了 7 个定时任务，1 个没按期跑成',
      );
      await expect(watchdogHealthCheck(t.db, now)()).resolves.toBe(
        '最近一轮 09-27 20:36 跑完：查了 7 个定时任务，1 个没按期跑成',
      );
    },
    TEST_DB_TIMEOUT_MS,
  );

  it('【故意造出的失败】看门狗最近一轮没跑成：红、推「看门狗没跑成」，原因写进提醒正文；同一段人处理过的不再打开，之后跑成一轮再出事是新的一张卡', async () => {
    clock = NOW;
    await register();
    const ok = await round(9, { outcome: 'ok', scanned: 7, found: 0 });
    await round(4, { outcome: 'failed', why: '读不到定时任务的登记表或跑记录：库连不上' });
    await expect(watchdogHealthCheck(t.db, now)()).rejects.toMatchObject({
      code: 'watchdog_failing',
      message: '看门狗最近一轮（09-27 20:26）没跑成',
    });
    expect(await watchdogWatchOnce({ db: t.db, now })).toBe('raised');
    const key = `watchdog-down:after-${ok}`;
    const [a] = await downAlerts();
    expect(a).toMatchObject({ dedupeKey: key, title: '看门狗没跑成：定时任务没人盯着' });
    expect(a?.body.split('\n')[0]).toBe(
      '看门狗最近一轮（09-27 20:26）没跑成：读不到定时任务的登记表或跑记录：库连不上。',
    );

    await resolveAlertWithReason(t.db, { dedupeKey: key, by: 'user-1', why: '在修', at: NOW });
    clock = new Date(NOW.getTime() + 5 * MIN);
    expect(await watchdogWatchOnce({ db: t.db, now })).toBe('handled');
    expect((await downAlerts()).filter((n) => n.resolvedAt === null)).toEqual([]);

    const again = await round(-6, { outcome: 'ok', scanned: 7, found: 0 });
    await round(-11, { outcome: 'failed', why: '又没跑成' });
    clock = new Date(NOW.getTime() + 12 * MIN);
    expect(await watchdogWatchOnce({ db: t.db, now })).toBe('raised');
    expect((await downAlerts()).filter((n) => n.resolvedAt === null).map((n) => n.dedupeKey)).toEqual([
      `watchdog-down:after-${again}`,
    ]);
  });

  it('【故意造出的失败】看门狗没登记、从没跑过（过了期望间隔）：都红、都推；刚登记还没轮到第一轮的不推', async () => {
    clock = NOW;
    await expect(watchdogHealthCheck(t.db, now)()).rejects.toMatchObject({ code: 'watchdog_unregistered' });
    expect(await watchdogWatchOnce({ db: t.db, now })).toBe('raised');
    expect((await downAlerts()).map((n) => [n.dedupeKey, n.title])).toEqual([
      ['watchdog-down:no-success', '看门狗没登记：定时任务没人盯着'],
    ]);
    await registerScheduledJobs(t.db, [{ ...JOB, registeredAt: ago(3) }]);
    await expect(watchdogHealthCheck(t.db, now)()).resolves.toBe('刚登记，第一轮还没跑完');
    expect(await watchdogWatchOnce({ db: t.db, now })).toBe('fine');
    clock = new Date(NOW.getTime() + 20 * MIN);
    await expect(watchdogHealthCheck(t.db, now)()).rejects.toMatchObject({
      code: 'watchdog_stale',
      message: '看门狗登记后超过 15 分钟还没跑过一轮',
    });
    expect(await watchdogWatchOnce({ db: t.db, now })).toBe('raised');
  });
});
