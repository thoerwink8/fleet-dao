// 看门狗（#203）：按登记表看各定时任务新不新鲜、推撤提醒（jobs/watchdog.ts）；真库上的装配（real/watchdog.ts，PGlite 跑真迁移）；
// 真 Temporal 测试服务端上的工作流。需求里的每一种都故意造一次：停了（stale）、连着失败（failing）、从没跑过（never）、
// 恢复了自动撤（写清为什么）、读不到登记表算没查成、推送没写进去记没跑成下一轮重推。看门狗自己停了由后端现算，
// 在 packages/api 的 watchdog-health.test.ts。
import {
  auditLog,
  finishScheduleRun,
  notifications,
  registerScheduledJobs,
  resolveAlertWithReason,
  type ScheduleResult,
  scheduleRuns,
  startScheduleRun,
  upsertAlert,
} from '@fleet-dao/db';
import { createTestDb, resetTestDb, TEST_DB_TIMEOUT_MS, type TestDb } from '@fleet-dao/db/testing';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import {
  jobIdOfKey,
  runWatchdogJob,
  spokenMinutes,
  WATCHDOG_JOB,
  type WatchdogDeps,
  WatchdogFailedError,
  watchdogAlertKey,
} from '../src/jobs/watchdog.ts';
import { watchdogJob } from '../src/real/watchdog.ts';

/** 北京时间 09-27 20:00。 */
const T0 = new Date('2026-09-27T12:00:00.000Z');
const MIN = 60_000;
const at = (min: number) => new Date(T0.getTime() + min * MIN);
const LONG_AGO = at(-30 * 24 * 60);

let t: TestDb;
let clock = T0;
let logs: string[] = [];

beforeAll(async () => {
  t = await createTestDb();
}, TEST_DB_TIMEOUT_MS);
afterAll(() => t.close());
beforeEach(async () => {
  await resetTestDb(t);
  clock = T0;
  logs = [];
});

interface JobSpec {
  id: string;
  name?: string;
  schedule?: string;
  expectEveryMinutes?: number;
  registeredAt?: Date;
}

/** 登记：看门狗自己（它每一轮的记录要外键）加上这些任务；登记时刻都给死，不跟着机器的钟走。 */
async function register(...jobs: JobSpec[]): Promise<void> {
  await registerScheduledJobs(t.db, [
    { ...WATCHDOG_JOB, registeredAt: LONG_AGO },
    ...jobs.map((j) => ({
      name: `任务 ${j.id}`,
      schedule: '每 15 分钟',
      expectEveryMinutes: 45,
      registeredAt: LONG_AGO,
      ...j,
    })),
  ]);
}

/** 记一次运行：第 startMin 分钟开始，第 endMin 分钟记上结局（result 是 null = 还在跑）。 */
async function run(job: string, startMin: number, result: ScheduleResult | null, endMin = startMin + 1) {
  const id = await startScheduleRun(t.db, job, at(startMin));
  if (result) await finishScheduleRun(t.db, id, result, at(endMin));
  return id;
}

function deps(over: Partial<WatchdogDeps> = {}): WatchdogDeps {
  const real = watchdogJob({
    db: t.db,
    now: () => clock,
    log: (level, text) => logs.push(`${level}:${text}`),
  })();
  return { ...real, ...over };
}

const allAlerts = async () =>
  (await t.db.select().from(notifications)).sort((a, b) => a.dedupeKey.localeCompare(b.dedupeKey));
const openAlerts = async () => (await allAlerts()).filter((a) => a.resolvedAt === null);
const alertOf = async (key: string) => (await allAlerts()).find((a) => a.dedupeKey === key);
const watchdogRuns = async () =>
  (await t.db.select().from(scheduleRuns))
    .filter((r) => r.job === WATCHDOG_JOB.id)
    .sort((a, b) => a.id - b.id);
const firstLine = (body: string | undefined) => body?.split('\n')[0];

describe('看门狗一轮（真库）', () => {
  it(
    '【故意造出的失败】停了（stale）：上次跑成过了期望间隔，推一条卡住报警（写上次跑成的时刻，不写「多久了」），点进去是定时任务页；再看一轮没变不改卡',
    async () => {
      await register({ id: 'route-probe', name: '路由探针' });
      const ok = await run('route-probe', -120, { outcome: 'ok', scanned: 3, found: 0 });
      expect(await runWatchdogJob(deps())).toMatchObject({ outcome: 'ok', scanned: 1, found: 1 });
      const [a] = await openAlerts();
      expect(a).toMatchObject({
        dedupeKey: `watchdog:job:route-probe:after-${ok}`,
        level: 'alert',
        taskId: null,
        title: '定时任务「路由探针」停了：超过 45 分钟没跑',
        link: '/schedules',
      });
      expect(a?.body).toBe(
        [
          '上次跑成是 09-27 18:01，之后过了期望间隔（45 分钟）没再跑成。',
          '这个任务：route-probe，每 15 分钟。看驾驶舱「定时任务」页这一行；按期跑成一次，这条自己撤。',
        ].join('\n'),
      );
      const before = a?.updatedAt;
      clock = at(5);
      await runWatchdogJob(deps());
      const again = await allAlerts();
      expect(again).toHaveLength(1);
      expect(again[0]?.updatedAt).toEqual(before);
      expect((await watchdogRuns()).map((r) => [r.outcome, r.scanned, r.found])).toEqual([
        ['ok', 1, 1],
        ['ok', 1, 1],
      ]);
    },
    TEST_DB_TIMEOUT_MS,
  );

  it('【故意造出的失败】连着失败（failing）：最近一次没跑成就推（哪怕上次跑成还在间隔里），写没跑成的原因和上次跑成的时刻；还在跑的那次不算结局', async () => {
    await register({ id: 'github-reconcile', name: 'GitHub 对账补漏' });
    const ok = await run('github-reconcile', -40, { outcome: 'ok', scanned: 2, found: 0 });
    await run('github-reconcile', -25, { outcome: 'failed', why: '对账没跑成：读 repos 表超时' });
    await run('github-reconcile', -10, { outcome: 'failed', why: '对账没跑成：读 repos 表超时' });
    await run('github-reconcile', -1, null);
    expect(await runWatchdogJob(deps())).toMatchObject({ outcome: 'ok', scanned: 1, found: 1 });
    const [a] = await openAlerts();
    expect(a).toMatchObject({
      dedupeKey: `watchdog:job:github-reconcile:after-${ok}`,
      title: '定时任务「GitHub 对账补漏」没跑成',
    });
    expect(a?.body.split('\n')).toEqual([
      '最近一次没跑成：对账没跑成：读 repos 表超时',
      '上次跑成：09-27 19:21',
      '这个任务：github-reconcile，每 15 分钟。看驾驶舱「定时任务」页这一行；按期跑成一次，这条自己撤。',
    ]);
  });

  it('【故意造出的失败】从没跑过（never）：登记了超过期望间隔还一次没跑过就推；刚登记、还没轮到第一次的先不推，过了期望间隔再推', async () => {
    await register(
      {
        id: 'backup.drill',
        name: '恢复演练',
        schedule: '每周日 05:40（北京时间）',
        expectEveryMinutes: 10200,
        registeredAt: at(-8 * 24 * 60),
      },
      { id: 'quota-read', name: '读额度', registeredAt: at(-10) },
    );
    expect(await runWatchdogJob(deps())).toMatchObject({ outcome: 'ok', scanned: 2, found: 1 });
    const open = await openAlerts();
    expect(open.map((a) => [a.dedupeKey, a.title])).toEqual([
      ['watchdog:job:backup.drill:no-success', '定时任务「恢复演练」从没跑过'],
    ]);
    expect(firstLine(open[0]?.body)).toBe(
      '09-19 20:00 登记的，过了期望间隔（7 天 2 小时）还一次都没跑过：定时器可能没排上、没在响。',
    );
    clock = at(40);
    await runWatchdogJob(deps());
    expect((await openAlerts()).map((a) => a.dedupeKey)).toEqual([
      'watchdog:job:backup.drill:no-success',
      'watchdog:job:quota-read:no-success',
    ]);
  });

  it('【故意造出的失败】一直一个都没扫到、过了期望间隔（比如 GitHub 读不到）：报「超过期望间隔没跑成」，写最近一次为什么没扫到；只是这一轮没扫到、上次跑成还在间隔里的不报', async () => {
    await register(
      { id: 'github-reconcile', name: 'GitHub 对账补漏' },
      { id: 'route-probe', name: '路由探针' },
    );
    const ok = await run('github-reconcile', -120, { outcome: 'ok', scanned: 2, found: 0 });
    for (const m of [-90, -75, -60, -45, -30, -15]) {
      await run('github-reconcile', m, { outcome: 'unscanned', why: '一个仓都没查成' });
    }
    await run('route-probe', -20, { outcome: 'ok', scanned: 3, found: 0 });
    await run('route-probe', -5, { outcome: 'unscanned', why: '这一轮没有要探的路由' });
    expect(await runWatchdogJob(deps())).toMatchObject({ outcome: 'ok', scanned: 2, found: 1 });
    const [a] = await openAlerts();
    expect(a).toMatchObject({
      dedupeKey: `watchdog:job:github-reconcile:after-${ok}`,
      title: '定时任务「GitHub 对账补漏」超过 45 分钟没跑成',
    });
    expect(a?.body.split('\n').slice(0, 2)).toEqual([
      '上次跑成是 09-27 18:01，之后过了期望间隔（45 分钟）没再跑成。',
      '最近一次跑完了，但一个都没扫到：一个仓都没查成',
    ]);
  });

  it('【故意造出的失败】恢复了自动撤：正文开头写「已撤：」和为什么（几点跑成、扫了几个），处理人记看门狗、进操作记录；之后再出事是新的一段、新的一张卡', async () => {
    await register({ id: 'route-probe', name: '路由探针' });
    const first = await run('route-probe', -120, { outcome: 'ok', scanned: 3, found: 0 });
    await runWatchdogJob(deps());
    const key = `watchdog:job:route-probe:after-${first}`;
    expect((await openAlerts()).map((a) => a.dedupeKey)).toEqual([key]);

    const back = await run('route-probe', 1, { outcome: 'ok', scanned: 4, found: 1 });
    clock = at(5);
    await runWatchdogJob(deps());
    const done = await alertOf(key);
    expect(done).toMatchObject({ resolvedBy: 'engine:watchdog', resolvedAt: at(5) });
    expect(firstLine(done?.body)).toBe(
      '已撤：「路由探针」按期跑成了：09-27 20:02 跑完：扫了 4 个、发现 1 个问题',
    );
    expect(await t.db.select().from(auditLog)).toContainEqual(
      expect.objectContaining({
        actorId: 'engine:watchdog',
        action: 'notification.resolve',
        reason: '「路由探针」按期跑成了：09-27 20:02 跑完：扫了 4 个、发现 1 个问题',
      }),
    );
    expect(await openAlerts()).toEqual([]);

    await run('route-probe', 20, { outcome: 'failed', why: '探针会话起不来' });
    clock = at(25);
    await runWatchdogJob(deps());
    expect((await openAlerts()).map((a) => a.dedupeKey)).toEqual([`watchdog:job:route-probe:after-${back}`]);
    expect((await alertOf(key))?.resolvedAt).toEqual(at(5));
  });

  it('【故意造出的失败】读不到登记表、跑记录：这一轮记没跑成、写明原因，开着的报警一条都不撤（不当成都新鲜），也不另推「看门狗没查成」（后端看着看门狗的那一下报）', async () => {
    await register({ id: 'route-probe', name: '路由探针' });
    const ok = await run('route-probe', -120, { outcome: 'ok', scanned: 3, found: 0 });
    await runWatchdogJob(deps());
    clock = at(5);
    const blind = deps({
      health: async () => {
        throw new Error('relation "schedule_runs" does not exist');
      },
    });
    await expect(runWatchdogJob(blind)).rejects.toMatchObject({
      name: 'WatchdogFailedError',
      message: expect.stringContaining('读不到定时任务的登记表或跑记录'),
    });
    expect((await watchdogRuns()).at(-1)).toMatchObject({
      outcome: 'failed',
      why: '读不到定时任务的登记表或跑记录：relation "schedule_runs" does not exist',
    });
    const open = await openAlerts();
    expect(open.map((a) => [a.dedupeKey, a.title])).toEqual([
      [`watchdog:job:route-probe:after-${ok}`, '定时任务「路由探针」停了：超过 45 分钟没跑'],
    ]);
    expect(logs).toContain('error:看门狗这一轮没跑成');

    // 下一轮读到了：照常判（那条「停了」还不对，原样开着）
    clock = at(10);
    expect(await runWatchdogJob(deps())).toMatchObject({ outcome: 'ok', found: 1 });
    expect((await openAlerts()).map((a) => a.dedupeKey)).toEqual([`watchdog:job:route-probe:after-${ok}`]);
  });

  it('【故意造出的失败】推送没写进去：这一轮记没跑成（写明哪条没写进去），不当成推过了——下一轮照库里的样子重推；撤没写进去也一样', async () => {
    await register({ id: 'route-probe', name: '路由探针' });
    await run('route-probe', -120, { outcome: 'ok', scanned: 3, found: 0 });
    const base = deps();
    const cannotRaise = deps({
      alerts: {
        ...base.alerts,
        raise: async () => {
          throw new Error('库写不进去');
        },
      },
    });
    await expect(runWatchdogJob(cannotRaise)).rejects.toMatchObject({ name: 'WatchdogFailedError' });
    expect((await watchdogRuns()).at(-1)).toMatchObject({
      outcome: 'failed',
      scanned: 1,
      found: 1,
      why: '「路由探针」的提醒没写进去：库写不进去',
    });
    expect(await allAlerts()).toEqual([]);

    clock = at(5);
    expect(await runWatchdogJob(deps())).toMatchObject({ outcome: 'ok', found: 1 });
    expect(await openAlerts()).toHaveLength(1);

    await run('route-probe', 6, { outcome: 'ok', scanned: 3, found: 0 });
    clock = at(10);
    const cannotResolve = deps({
      alerts: {
        ...base.alerts,
        resolve: async () => {
          throw new Error('库写不进去');
        },
      },
    });
    await expect(runWatchdogJob(cannotResolve)).rejects.toMatchObject({ name: 'WatchdogFailedError' });
    expect(await openAlerts()).toHaveLength(1);
    clock = at(15);
    await runWatchdogJob(deps());
    expect(await openAlerts()).toEqual([]);
  });

  it('同一段里人点了「处理」：不再打开（人接手了）；看门狗自己撤过的，同一段里又不对了照样打开', async () => {
    await register({ id: 'route-probe', name: '路由探针' }, { id: 'hourly', name: '每小时对账' });
    const probeOk = await run('route-probe', -120, { outcome: 'ok', scanned: 3, found: 0 });
    const hourlyOk = await run('hourly', -30, { outcome: 'ok', scanned: 5, found: 0 });
    await run('hourly', -10, { outcome: 'failed', why: '列不了工作树的根' });
    await runWatchdogJob(deps());
    const probeKey = `watchdog:job:route-probe:after-${probeOk}`;
    const hourlyKey = `watchdog:job:hourly:after-${hourlyOk}`;
    expect((await openAlerts()).map((a) => a.dedupeKey)).toEqual([hourlyKey, probeKey]);

    // 人在驾驶舱点了「处理」
    await resolveAlertWithReason(t.db, { dedupeKey: probeKey, by: 'user-1', why: '知道了，在修', at: at(1) });
    // hourly 这一轮只是没扫到东西、上次跑成还在间隔里：看门狗撤掉
    await run('hourly', 2, { outcome: 'unscanned', why: '工作树的根下什么都没有，也没有没处理的提醒' });
    clock = at(5);
    await runWatchdogJob(deps());
    expect(await alertOf(probeKey)).toMatchObject({ resolvedBy: 'user-1' });
    expect(await alertOf(hourlyKey)).toMatchObject({ resolvedBy: 'engine:watchdog' });
    expect(firstLine((await alertOf(hourlyKey))?.body)).toBe(
      '已撤：「每小时对账」按期跑成了：09-27 19:31 跑完：扫了 5 个、发现 0 个问题；最近一次：09-27 20:03 跑完、一个都没扫到：工作树的根下什么都没有，也没有没处理的提醒',
    );

    // 过了间隔还是一个都没扫到：同一段（还是从那次跑成算），看门狗撤过的照样打开；人处理过的那条还是不动
    clock = at(20);
    await runWatchdogJob(deps());
    expect(await alertOf(probeKey)).toMatchObject({ resolvedBy: 'user-1' });
    expect(await alertOf(hourlyKey)).toMatchObject({
      resolvedAt: null,
      title: '定时任务「每小时对账」超过 45 分钟没跑成',
    });
  });

  it('任务自己为这次没跑成报过（键以 <编号>:run 开头，备份脚本就这么报）：看门狗不报第二条，自己那条撤掉写明看哪条；「停了」照报', async () => {
    await register({
      id: 'backup.nightly',
      name: '每晚备份',
      schedule: '每天 04:10（北京时间）',
      expectEveryMinutes: 1560,
    });
    const ok = await run('backup.nightly', -24 * 60, { outcome: 'ok', scanned: 3, found: 0 });
    await run('backup.nightly', -30, { outcome: 'failed', why: 'restic 退出 1' });
    // 看门狗先看到了（备份脚本那条还没写）：报了
    await runWatchdogJob(deps());
    const key = `watchdog:job:backup.nightly:after-${ok}`;
    expect((await openAlerts()).map((a) => a.dedupeKey)).toEqual([key]);

    // 备份脚本自己报的那条写进来了（在这次没跑成之后）：看门狗那条撤掉，写明看哪条
    await t.db.insert(notifications).values({
      level: 'alert',
      dedupeKey: 'backup.nightly:run42',
      title: '每晚备份没做成',
      body: 'restic 退出 1',
      createdAt: at(-29),
      updatedAt: at(-29),
    });
    clock = at(5);
    await runWatchdogJob(deps());
    expect(firstLine((await alertOf(key))?.body)).toBe(
      '已撤：「每晚备份」自己报了没跑成（每晚备份没做成），这一段看那一条',
    );
    // 人把备份那条处理了、还是没跑成：同一件事，看门狗不另开一张
    await resolveAlertWithReason(t.db, {
      dedupeKey: 'backup.nightly:run42',
      by: 'user-1',
      why: '看过了',
      at: at(6),
    });
    clock = at(10);
    await runWatchdogJob(deps());
    expect(await openAlerts()).toEqual([]);

    // 之后它一直没再跑（定时器停了）：过了期望间隔，「停了」它自己报不了，看门狗照报（同一段，看门狗撤过的照样打开）
    clock = at(26 * 60);
    await runWatchdogJob(deps());
    const stopped = await openAlerts();
    expect(stopped.map((a) => [a.dedupeKey, a.title])).toEqual([
      [key, '定时任务「每晚备份」停了：超过 26 小时没跑'],
    ]);
    expect(stopped[0]?.body.split('\n').slice(0, 2)).toEqual([
      '上次跑成是 09-26 20:01，之后过了期望间隔（26 小时）没再跑成。',
      '最近一次：09-27 19:31 没跑成：restic 退出 1',
    ]);
  });

  it('不在登记表上了的任务：之前那条撤掉、写明为什么；看门狗不看自己；登记表上除了它自己什么都没有：记 unscanned（不装作看过）', async () => {
    await register();
    await upsertAlert(t.db, {
      dedupeKey: 'watchdog:job:old-job:after-3',
      level: 'alert',
      taskId: null,
      title: '定时任务「旧任务」没跑成',
      body: 'x',
    });
    // 看门狗自己最近一次没跑成、早就过期了：不给自己报（它自己停没停由后端看，watchdog-health.ts）
    await run('watchdog', -60, { outcome: 'failed', why: '上一轮库连不上' });
    const r = await runWatchdogJob(deps());
    expect(r).toEqual({
      runId: expect.any(Number),
      outcome: 'unscanned',
      scanned: 0,
      found: 0,
      why: '登记表上除了看门狗自己没有别的定时任务',
    });
    expect(firstLine((await alertOf('watchdog:job:old-job:after-3'))?.body)).toBe(
      '已撤：「old-job」不在定时任务登记表上了（不再要求它按期跑）',
    );
    expect(await openAlerts()).toEqual([]);
  });

  it('记不上开始（看门狗没登记，外键不让写）：原样抛出，不去看、不碰提醒', async () => {
    let looked = false;
    await expect(
      runWatchdogJob(
        deps({
          health: async () => {
            looked = true;
            return [];
          },
        }),
      ),
    ).rejects.toThrow();
    expect(looked).toBe(false);
    expect(await allAlerts()).toEqual([]);
  });

  it('【故意造出的失败】退役的任务（alert-dispatch，#445「提醒派单」整层删掉）：登记表上还在、早停了也不报——它不会再跑，报了也没人能处理；没登记在 ENGINE_JOBS 里的别的任务（这里的 route-probe）照样正常管，不因为筛退役任务被连带漏管', async () => {
    await register({ id: 'alert-dispatch' }, { id: 'route-probe' });
    await run('alert-dispatch', -120, { outcome: 'ok', scanned: 1, found: 0 });
    const ok = await run('route-probe', -120, { outcome: 'ok', scanned: 3, found: 0 });
    expect(await runWatchdogJob(deps())).toMatchObject({ outcome: 'ok' });
    expect((await openAlerts()).map((a) => a.dedupeKey)).toEqual([`watchdog:job:route-probe:after-${ok}`]);
  });
});

describe('键和说法', () => {
  it('一段一条的键：从哪次跑成之后算；任务编号里有冒号也读得回来', () => {
    expect(watchdogAlertKey('a:b', null)).toBe('watchdog:job:a:b:no-success');
    expect(jobIdOfKey(watchdogAlertKey('a:b', null))).toBe('a:b');
    expect(jobIdOfKey('watchdog:job:backup.nightly:after-12')).toBe('backup.nightly');
  });

  it('期望间隔说成人话', () => {
    expect([15, 45, 150, 780, 1560, 10200].map(spokenMinutes)).toEqual([
      '15 分钟',
      '45 分钟',
      '2 小时 30 分钟',
      '13 小时',
      '26 小时',
      '7 天 2 小时',
    ]);
  });

  it('登记的名字、频率：每 5 分钟一轮，漏两轮不报、连着三轮没跑成才算过期（后端按它判看门狗自己停没停）', () => {
    expect(WATCHDOG_JOB).toMatchObject({ id: 'watchdog', schedule: '每 5 分钟', expectEveryMinutes: 15 });
  });
});

describe('看门狗一轮的结局', () => {
  it('一轮跑完：交回这一轮的结局（和记进 schedule_runs 的同一份）', async () => {
    await register({ id: 'route-probe', name: '路由探针' });
    await run('route-probe', -120, { outcome: 'ok', scanned: 3, found: 0 });
    const got = await runWatchdogJob(deps());
    expect(got).toMatchObject({ outcome: 'ok', scanned: 1, found: 1 });
    expect((await watchdogRuns()).map((r) => r.id)).toEqual([got.runId]);
  });

  it('【故意造出的失败】这一轮没跑成：抛 WatchdogFailedError、带着原因（下一轮 5 分钟后照来）', async () => {
    await register();
    const err = await runWatchdogJob(
      deps({
        health: async () => {
          throw new Error('库连不上');
        },
      }),
    ).then(
      () => null,
      (e: unknown) => e,
    );
    expect(err).toBeInstanceOf(WatchdogFailedError);
    expect((err as Error).message).toContain('库连不上');
  });
});
