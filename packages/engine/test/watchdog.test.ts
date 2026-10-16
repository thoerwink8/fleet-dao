// 看门狗（#203）：按登记表看各定时任务新不新鲜、推撤提醒（jobs/watchdog.ts）；真库上的装配（real/watchdog.ts，PGlite 跑真迁移）；
// 真 Temporal 测试服务端上的工作流。需求里的每一种都故意造一次：停了（stale）、连着失败（failing）、从没跑过（never）、
// 恢复了自动撤（写清为什么）、读不到登记表算没查成、推送没写进去记没跑成下一轮重推。看门狗自己停了由后端现算，
// 在 packages/api 的 watchdog-health.test.ts。
import { mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import {
  auditLog,
  channels,
  finishScheduleRun,
  MASTER_OFF_SKIP_WHY,
  notifications,
  pools,
  registerScheduledJobs,
  repos,
  resolveAlertWithReason,
  type ScheduleResult,
  scheduleRuns,
  settings,
  startScheduleRun,
  upsertAlert,
} from '@fleet-dao/db';
import { createTestDb, resetTestDb, TEST_DB_TIMEOUT_MS, type TestDb } from '@fleet-dao/db/testing';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { CARPOOL_WATCH_JOB } from '../src/jobs/carpool-watch.ts';
import {
  judgeReleaseAttention,
  lastHistoryEntry,
  parseHealthzResponse,
  releaseAttentionReasons,
  TRAIN_STUCK_MS,
} from '../src/jobs/release-watch.ts';
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
/** 新鲜度这几组不看法国发布目录：目录在时简报和发版会卷进来，那两条另有用例。 */
const NO_RELEASES = join(tmpdir(), 'watchdog-test-no-releases');

beforeAll(async () => {
  t = await createTestDb();
}, TEST_DB_TIMEOUT_MS);
afterAll(() => t.close());
beforeEach(async () => {
  await resetTestDb(t);
  rmSync(NO_RELEASES, { recursive: true, force: true });
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
    // 这组测定时任务新鲜度。发版和每日简报认发布目录：法国这台目录在，不指开会把宿主机的发版卷进断言。
    releasesDir: NO_RELEASES,
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
      why: '定时任务登记表上除了看门狗自己没有别的任务；也没有哪个仓开着「让 AI 接活」，没有仓可看',
    });
    expect(firstLine((await alertOf('watchdog:job:old-job:after-3'))?.body)).toBe(
      '已撤：「old-job」不在定时任务登记表上了（不再要求它按期跑）',
    );
    expect(await openAlerts()).toEqual([]);

    // 没接 mergeStall 的装配（这一轮没读仓）：说明里照实写，不冒充看过仓
    const { mergeStall: _unused, ...noRepos } = deps();
    expect(await runWatchdogJob(noRepos)).toMatchObject({
      outcome: 'unscanned',
      why: '定时任务登记表上除了看门狗自己没有别的任务；这一轮没读各仓',
    });
  });

  it('一个任务都没登记：有仓开着「让 AI 接活」时算扫过那几个仓（不是 unscanned）；一个仓都没开写着没有仓可看', async () => {
    await register();
    const [shop] = await t.db
      .insert(repos)
      .values({ owner: 'acme', name: 'shop', testCommand: 'pnpm check', autoDispatchSince: LONG_AGO })
      .returning();
    expect(shop).toBeDefined();
    expect(await runWatchdogJob(deps())).toMatchObject({ outcome: 'ok', scanned: 1, found: 0 });

    // 仓的开关关了：又变成「一个都没扫到」，说明里写「没有哪个仓开着『让 AI 接活』」
    await t.db.update(repos).set({ autoDispatchSince: null });
    expect(await runWatchdogJob(deps())).toMatchObject({
      outcome: 'unscanned',
      why: '定时任务登记表上除了看门狗自己没有别的任务；也没有哪个仓开着「让 AI 接活」，没有仓可看',
    });
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

  it('拼车池整池暂停：carpool-watch 登记行还在也不报「停了」，开着的撤掉；还有拼车池没停则照常报；撤了暂停、超时没跑再报', async () => {
    const hold = {
      reason: '324 个账号被封，整池停用',
      decidedBy: '创始人 2026-10-08',
      revokeWhen: '换上新账号并登记新组织编号后撤',
      reviewBy: '2026-11-07',
    };
    await t.db.insert(channels).values({
      id: 'claude-subscription',
      name: 'Claude 订阅',
      billing: 'subscription',
    });
    await t.db.insert(pools).values([
      {
        id: 'claude-carpool',
        channelId: 'claude-subscription',
        maxConcurrency: 4,
        runAsUser: 'fleet-agent-carpool',
        orgKind: 'carpool',
      },
      {
        id: 'claude-carpool-b',
        channelId: 'claude-subscription',
        maxConcurrency: 1,
        runAsUser: 'fleet-agent-carpool',
        orgKind: 'carpool',
      },
    ]);
    await register({
      id: CARPOOL_WATCH_JOB.id,
      name: CARPOOL_WATCH_JOB.name,
      schedule: CARPOOL_WATCH_JOB.schedule,
      expectEveryMinutes: CARPOOL_WATCH_JOB.expectEveryMinutes,
    });
    const ok = await run(CARPOOL_WATCH_JOB.id, -30, { outcome: 'ok', scanned: 1, found: 0 });
    const key = `watchdog:job:${CARPOOL_WATCH_JOB.id}:after-${ok}`;
    // 只停了一个拼车池：还有一个没停，盯读该照常跑，超时没跑照报
    await t.db.insert(settings).values({
      key: 'engine.poolHolds',
      value: { 'claude-carpool': hold },
      updatedBy: '创始人',
    });
    expect(await runWatchdogJob(deps())).toMatchObject({ outcome: 'ok', found: 1 });
    expect((await openAlerts()).map((a) => a.dedupeKey)).toEqual([key]);

    // 每个拼车池都停着：不报，已经开着的撤掉（登记行还在）
    await t.db.delete(settings);
    await t.db.insert(settings).values({
      key: 'engine.poolHolds',
      value: { 'claude-carpool': hold, 'claude-carpool-b': hold },
      updatedBy: '创始人',
    });
    expect(await runWatchdogJob(deps())).toMatchObject({ outcome: 'ok', found: 0 });
    expect(await openAlerts()).toEqual([]);
    expect(firstLine((await alertOf(key))?.body)).toContain('已撤：');
    expect((await alertOf(key))?.body).toContain('整池暂停着');

    // 撤了暂停，仍超时没跑：照常要求新鲜
    await t.db.delete(settings);
    expect(await runWatchdogJob(deps())).toMatchObject({ outcome: 'ok', found: 1 });
    expect((await openAlerts()).map((a) => [a.dedupeKey, a.title])).toEqual([
      [key, '定时任务「拼车额度盯读（切号用）」停了：超过 10 分钟没跑'],
    ]);
  });

  it('【故意造出的失败】读不到哪些任务是有意停的：不当成暂停，照常报停了，这一轮记没查成', async () => {
    await register({
      id: CARPOOL_WATCH_JOB.id,
      name: CARPOOL_WATCH_JOB.name,
      expectEveryMinutes: CARPOOL_WATCH_JOB.expectEveryMinutes,
    });
    await run(CARPOOL_WATCH_JOB.id, -30, { outcome: 'ok', scanned: 1, found: 0 });
    await expect(
      runWatchdogJob(
        deps({
          pausedJobs: async () => {
            throw new Error('库断了');
          },
        }),
      ),
    ).rejects.toThrow(/有意停/);
    expect((await openAlerts()).map((a) => a.title)).toEqual([
      '定时任务「拼车额度盯读（切号用）」停了：超过 10 分钟没跑',
    ]);
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

describe('同一个任务连着没跑全（partial 算跑成，所以单靠新鲜度看不见）', () => {
  const partial = (why: string): ScheduleResult => ({ outcome: 'partial', why, scanned: 3, found: 1 });
  const reds = () => openAlerts().then((all) => all.filter((a) => a.dedupeKey.startsWith('watchdog:red:')));

  it('【故意造出的失败】从没跑全过、连着 4 次 partial 跨过 2 小时：报一张卡（写从几点起、最近一次的原因），点进定时任务页；再看一轮没变不改卡', async () => {
    await register({ id: 'cli-versions', name: '命令行工具版本', expectEveryMinutes: 100_000 });
    for (const m of [-200, -140, -80, -20])
      await run('cli-versions', m, partial('3 处没读成：pilot 的 Grok 没读成'));
    expect(await runWatchdogJob(deps())).toMatchObject({ outcome: 'ok', found: 1 });
    const [a] = await reds();
    expect(a).toMatchObject({
      dedupeKey: 'watchdog:red:cli-versions:no-ok',
      level: 'alert',
      title: '定时任务「命令行工具版本」连着只跑了一部分',
      link: '/schedules',
    });
    expect(a?.body).toContain('每一次都没有跑全');
    expect(a?.body).toContain('3 处没读成：pilot 的 Grok 没读成');
    const before = a?.updatedAt;
    clock = at(5);
    await runWatchdogJob(deps());
    expect((await reds())[0]?.updatedAt).toEqual(before);
  });

  it('不够报的不报：只有 2 次、或 3 次但没跨过 2 小时、或中间有一次跑全了', async () => {
    await register(
      { id: 'two', expectEveryMinutes: 100_000 },
      { id: 'short', expectEveryMinutes: 100_000 },
      { id: 'broken-by-ok', expectEveryMinutes: 100_000 },
    );
    for (const m of [-300, -10]) await run('two', m, partial('x'));
    for (const m of [-30, -20, -10]) await run('short', m, partial('x'));
    await run('broken-by-ok', -300, partial('x'));
    await run('broken-by-ok', -200, partial('x'));
    await run('broken-by-ok', -100, { outcome: 'ok', scanned: 1, found: 0 });
    await run('broken-by-ok', -10, partial('x'));
    await runWatchdogJob(deps());
    expect(await reds()).toEqual([]);
  });

  it('跑全一次就自己撤，写明为什么；之后又红是新的一段、新的一张卡', async () => {
    await register({ id: 'j', name: '某任务', expectEveryMinutes: 100_000 });
    for (const m of [-200, -140, -80]) await run('j', m, partial('读不到'));
    await runWatchdogJob(deps());
    expect(await reds()).toHaveLength(1);
    const okId = await run('j', 1, { outcome: 'ok', scanned: 1, found: 0 });
    clock = at(5);
    await runWatchdogJob(deps());
    expect(await reds()).toEqual([]);
    const gone = await alertOf('watchdog:red:j:no-ok');
    expect(gone?.resolvedBy).toBe('engine:watchdog');
    expect(gone?.body).toContain('跑全了一次');
    for (const m of [6, 70, 130]) await run('j', m, partial('又读不到'));
    clock = at(140);
    await runWatchdogJob(deps());
    expect((await reds()).map((a) => a.dedupeKey)).toEqual([`watchdog:red:j:after-${okId}`]);
  });

  it('最近一次没跑成（failed）的任务，看门狗已经按「没跑成」报了，这一项不再报第二张', async () => {
    await register({ id: 'f', name: '会失败的', expectEveryMinutes: 100_000 });
    for (const m of [-200, -140, -80, -20]) await run('f', m, { outcome: 'failed', why: '库断了' });
    await runWatchdogJob(deps());
    expect(await reds()).toEqual([]);
    expect((await openAlerts()).map((a) => a.dedupeKey.split(':')[1])).toEqual(['job']);
  });
});

describe('总开关关着的跳过不算「连着没跑全」', () => {
  it('拉单连着 4 次因总开关关着记 partial、跨过 2 小时：不报；中间夹着真的 partial 也不被它打断', async () => {
    await register({ id: 'intake', name: '拉单', expectEveryMinutes: 100_000 });
    for (const m of [-200, -140, -80, -20]) {
      await run('intake', m, {
        outcome: 'partial',
        why: `${MASTER_OFF_SKIP_WHY}总开关关着`,
        scanned: 0,
        found: 0,
      });
    }
    await runWatchdogJob(deps());
    expect((await openAlerts()).filter((a) => a.dedupeKey.startsWith('watchdog:red:'))).toEqual([]);

    // 真的 partial 三次跨 2 小时，中间夹两次跳过：照样报
    await register({ id: 'real-red', name: '真红', expectEveryMinutes: 100_000 });
    await run('real-red', -200, { outcome: 'partial', why: '读不到', scanned: 1, found: 1 });
    await run('real-red', -150, { outcome: 'partial', why: `${MASTER_OFF_SKIP_WHY}x`, scanned: 0, found: 0 });
    await run('real-red', -100, { outcome: 'partial', why: '读不到', scanned: 1, found: 1 });
    await run('real-red', -50, { outcome: 'partial', why: `${MASTER_OFF_SKIP_WHY}x`, scanned: 0, found: 0 });
    await run('real-red', -10, { outcome: 'partial', why: '读不到', scanned: 1, found: 1 });
    await runWatchdogJob(deps());
    expect((await openAlerts()).map((a) => a.dedupeKey)).toEqual(['watchdog:red:real-red:no-ok']);
  });
});

describe('发版要人看、健康页非 200 持续 > 10 分钟（2026-10-14 法国发版失败后漏报）', () => {
  const SHA = 'abcd1234'.padEnd(40, '0');
  let dir: string;
  let health: { status: number; body: unknown } | 'down';
  let probes = 0;

  const fetchHealth = (async () => {
    probes += 1;
    if (health === 'down') throw new Error('connect ECONNREFUSED 10.99.0.2:8787');
    return new Response(JSON.stringify(health.body), { status: health.status });
  }) as unknown as typeof fetch;

  const history = (...rows: string[]) => writeFileSync(join(dir, '.history'), `${rows.join('\n')}\n`);
  const BAD_HISTORY = [
    `2026-10-14T17:03:00Z ${SHA} release`,
    `2026-10-14T17:05:00Z ${SHA} unhealthy`,
    '2026-10-14T17:06:00Z 1111aaaa2222 auto-rollback',
    '2026-10-14T17:08:00Z 1111aaaa2222 unhealthy',
  ];
  const RED_503 = {
    status: 503,
    body: {
      ok: false,
      checks: { db: { ok: true }, temporal: { ok: false, code: 'down', message: '连不上 Temporal' } },
    },
  };

  // 这一组只看发版和健康页：发布目录在（像法国）时看门狗还会看「今天的每日简报送到没」，那一条在 daily-brief.test.ts 测，这里摘掉
  const wd = (): WatchdogDeps => {
    const { brief: _brief, ...rest } = watchdogJob({
      db: t.db,
      now: () => clock,
      log: (level, text) => logs.push(`${level}:${text}`),
      releasesDir: dir,
      healthzUrl: 'http://127.0.0.1:1/healthz',
      fetchImpl: fetchHealth,
    })();
    return rest;
  };

  beforeEach(async () => {
    dir = mkdtempSync(join(tmpdir(), 'watchdog-release-'));
    mkdirSync(join(dir, '.train'), { recursive: true });
    mkdirSync(join(dir, '.auto'), { recursive: true });
    health = { status: 200, body: { ok: true, checks: {} } };
    probes = 0;
    await register();
  });
  afterEach(() => rmSync(dir, { recursive: true, force: true }));

  const openKeys = async () => (await openAlerts()).map((a) => a.dedupeKey);

  it('【故意造出的失败】重放那次事故：发布历史最近一条 unhealthy、进度记录 failed、自动发布说要人看 → 一张「发版要人看」卡；/healthz 503 满 10 分钟才报，写红的检查；恢复后两张都自己撤', async () => {
    history(...BAD_HISTORY);
    writeFileSync(join(dir, '.train', 'release-train.json'), JSON.stringify({ status: 'failed' }));
    writeFileSync(
      join(dir, '.auto', 'state.json'),
      JSON.stringify({ auto: { note: '现在不发：上一趟发版是「failed」状态，要人看，不自动再发' } }),
    );
    health = RED_503;

    // 第 0 分钟：发版那张立刻报；健康页刚发现，不到 10 分钟不报
    expect(await runWatchdogJob(wd())).toMatchObject({ outcome: 'ok', found: 1 });
    expect(await openKeys()).toEqual([`watchdog:release:1111aaaa2222:unhealthy`]);
    const rel = (await openAlerts())[0];
    expect(rel?.title).toBe('发版要人看：新版没发成或退回了，自动发版停着');
    expect(rel?.body).toContain('发布历史最近一条是「健康检查没过」');
    expect(rel?.body).toContain('发版进度记录停在「failed」');
    expect(rel?.body).toContain('自动发布说：现在不发：上一趟发版是「failed」状态，要人看');
    expect(rel?.link).toBe('/france');

    clock = at(9);
    await runWatchdogJob(wd());
    expect(await openKeys()).toHaveLength(1);

    // 第 10 分钟起：健康页那张报出来，写从几点起、红的检查
    clock = at(10);
    expect(await runWatchdogJob(wd())).toMatchObject({ outcome: 'ok', found: 2 });
    expect(await openKeys()).toContain(`watchdog:healthz:since-${T0.getTime()}`);
    const hz = (await openAlerts()).find((a) => a.dedupeKey.startsWith('watchdog:healthz:'));
    expect(hz?.title).toBe('健康页（/healthz）非 200，已持续超过 10 分钟');
    expect(hz?.body).toContain('HTTP 503');
    expect(hz?.body).toContain('temporal：连不上 Temporal');
    expect(hz?.body).not.toContain('db：');

    // 再看一轮没变：不改卡
    const before = (await alertOf(hz?.dedupeKey ?? ''))?.updatedAt;
    clock = at(15);
    await runWatchdogJob(wd());
    expect((await alertOf(hz?.dedupeKey ?? ''))?.updatedAt).toEqual(before);

    // 恢复：/healthz 回 200、发布历史最近一条是 release、进度记录收尾 → 两张都撤，写明为什么
    health = { status: 200, body: { ok: true, checks: {} } };
    history(...BAD_HISTORY, `2026-10-14T18:00:00Z ${'9'.repeat(40)} release`);
    writeFileSync(join(dir, '.train', 'release-train.json'), JSON.stringify({ status: 'done' }));
    writeFileSync(join(dir, '.auto', 'state.json'), JSON.stringify({ auto: { note: '在用的就是主线头' } }));
    clock = at(20);
    await runWatchdogJob(wd());
    expect(await openKeys()).toEqual([]);
    expect((await alertOf(hz?.dedupeKey ?? ''))?.body).toContain('已撤：/healthz 回 200 了');
    expect((await alertOf(rel?.dedupeKey ?? ''))?.body).toContain('已撤：发版现在不用人看了');
  });

  it('【故意造出的失败】release.sh 没退回、末行记「健康检查没过」，接活脚本发后体检过了（进度 done、current 就是目标）：不报，旧卡撤掉；current 不是目标照报（#2207）', async () => {
    const PREV = 'df3692b292a74d8f0394dcf2238f1e7d9e9d7d4e';
    const NEW = '2f5dc42f4636fe0a68264eb11ecc39a723e36b7d';
    history(
      `2026-10-14T22:49:55Z ${PREV} release`,
      `2026-10-14T23:04:53Z ${NEW} release`,
      `2026-10-14T23:05:30Z ${NEW} unhealthy`,
    );
    writeFileSync(
      join(dir, '.train', 'release-train.json'),
      JSON.stringify({
        schema: 1,
        status: 'done',
        phase: 8,
        startedAt: at(-10).toISOString(),
        target: { kind: 'sha', value: NEW },
      }),
    );
    writeFileSync(
      join(dir, '.auto', 'state.json'),
      JSON.stringify({ auto: { note: '在用的就是主线头，没有要发的' } }),
    );
    // 旧版看门狗当时开的那条
    await upsertAlert(t.db, {
      dedupeKey: `watchdog:release:${NEW.slice(0, 12)}:unhealthy`,
      level: 'alert',
      taskId: null,
      title: '发版要人看：新版没发成或退回了，自动发版停着',
      body: '发布历史最近一条是「健康检查没过」',
    });
    symlinkSync(NEW, join(dir, 'current'));
    await runWatchdogJob(wd());
    expect(await openKeys()).toEqual([]);
    expect((await alertOf(`watchdog:release:${NEW.slice(0, 12)}:unhealthy`))?.body).toContain(
      '已撤：发版现在不用人看了',
    );

    // current 还是上一版（没切过去 / 退回了）：照报；自动发版没停（进度 done），标题不说「停着」
    rmSync(join(dir, 'current'));
    symlinkSync(PREV, join(dir, 'current'));
    clock = at(1);
    await runWatchdogJob(wd());
    expect(await openKeys()).toEqual([`watchdog:release:${NEW.slice(0, 12)}:unhealthy`]);
    const card = (await openAlerts())[0];
    expect(card?.title).toBe('发版要人看：新版没发成或退回了');
    expect(card?.body).toContain('自动发版没停');
    expect(card?.body).not.toContain('不会再发');
  });

  it('只改文档的版本发成了：历史末行是 release、进度记录不是 failed，不报「新版没发成或退回了」', async () => {
    const prev = '1478b87a15f7'.padEnd(40, 'a');
    const next = 'b0ef012b26a1'.padEnd(40, 'b');
    history(`2026-10-16T02:08:44Z ${prev} release`, `2026-10-16T02:09:00Z ${next} release`);
    writeFileSync(
      join(dir, '.train', 'release-train.json'),
      JSON.stringify({
        schema: 1,
        status: 'done',
        phase: 8,
        startedAt: '2026-10-16T02:06:00.000Z',
        target: { kind: 'sha', value: next },
      }),
    );
    writeFileSync(join(dir, '.auto', 'state.json'), JSON.stringify({ auto: { note: '在用的就是主线头' } }));
    symlinkSync(next, join(dir, 'current'));
    await runWatchdogJob(wd());
    expect(await openKeys()).toEqual([]);
    const train = JSON.parse(readFileSync(join(dir, '.train', 'release-train.json'), 'utf8')) as {
      status: string;
    };
    expect(train.status).not.toBe('failed');
  });

  it('重放 2026-10-14 22:58Z：一趟正常自动发版在走（真格式进度记录 running）不报，挂在上一版身上的误报撤掉；超过阈值才报、键写正在发的；发完撤', async () => {
    const PREV = 'df3692b292a74d8f0394dcf2238f1e7d9e9d7d4e';
    const NEW = '2f5dc42f4636fe0a68264eb11ecc39a723e36b7d';
    history(`2026-10-14T22:49:55Z ${PREV} release`);
    const train = (status: string) =>
      writeFileSync(
        join(dir, '.train', 'release-train.json'),
        JSON.stringify({
          schema: 1,
          status,
          phase: 4,
          startedAt: at(-5).toISOString(),
          updatedAt: at(-5).toISOString(),
          target: { kind: 'sha', value: NEW },
          waiting: 'release.sh 2f5dc42f4636 在跑（最多 30 分钟）',
        }),
      );
    train('running');
    writeFileSync(
      join(dir, '.auto', 'state.json'),
      JSON.stringify({ auto: { note: '现在不发：有一趟发版在跑（2f5dc42f4636），等它收尾' } }),
    );
    // 旧版看门狗开的那条误报（键挂在上一版身上）
    await upsertAlert(t.db, {
      dedupeKey: 'watchdog:release:df3692b292a7:release',
      level: 'alert',
      taskId: null,
      title: '发版要人看：新版没发成或退回了，自动发版停着',
      body: '发版进度记录停在「running」',
    });

    // 进行中 5 分钟：不报，那条误报撤掉
    await runWatchdogJob(wd());
    expect(await openKeys()).toEqual([]);
    expect((await alertOf('watchdog:release:df3692b292a7:release'))?.body).toContain(
      '已撤：发版现在不用人看了',
    );

    // 过了阈值还 running：报，键是正在发的这一趟
    clock = at(TRAIN_STUCK_MS / MIN - 4);
    await runWatchdogJob(wd());
    expect(await openKeys()).toEqual(['watchdog:release:train:2f5dc42f4636:running']);

    // 发完（历史多一条 release、进度 done）：自己撤
    history(`2026-10-14T22:49:55Z ${PREV} release`, `2026-10-14T23:04:53Z ${NEW} release`);
    train('done');
    clock = at(TRAIN_STUCK_MS / MIN);
    await runWatchdogJob(wd());
    expect(await openKeys()).toEqual([]);
  });

  it('非 200 没满 10 分钟就恢复：从不报，也清掉记的时刻（下次重新数）', async () => {
    history(`2026-10-14T17:03:00Z ${SHA} release`);
    health = RED_503;
    await runWatchdogJob(wd());
    clock = at(8);
    await runWatchdogJob(wd());
    health = { status: 200, body: {} };
    clock = at(9);
    await runWatchdogJob(wd());
    expect(await allAlerts()).toHaveLength(0);
    // 又坏：从这一刻重新数，满 10 分钟前不报
    health = RED_503;
    clock = at(12);
    await runWatchdogJob(wd());
    clock = at(21);
    await runWatchdogJob(wd());
    expect(await allAlerts()).toHaveLength(0);
    clock = at(22);
    await runWatchdogJob(wd());
    expect(await openKeys()).toEqual([`watchdog:healthz:since-${at(12).getTime()}`]);
  });

  it('【故意造出的失败】后端连不上（fetch 抛）也算非 200：满 10 分钟报，写连不上', async () => {
    history(`2026-10-14T17:03:00Z ${SHA} release`);
    health = 'down';
    await runWatchdogJob(wd());
    clock = at(10);
    await runWatchdogJob(wd());
    const [a] = await openAlerts();
    expect(a?.dedupeKey).toBe(`watchdog:healthz:since-${T0.getTime()}`);
    expect(a?.body).toContain('连不上');
  });

  it('发布历史最近一条是 auto-rollback 也要人看；最近一条是 recovered / rollback / release 不报', async () => {
    history(`2026-10-14T17:03:00Z ${SHA} release`, '2026-10-14T17:06:00Z 1111aaaa2222 auto-rollback');
    await runWatchdogJob(wd());
    expect(await openKeys()).toEqual(['watchdog:release:1111aaaa2222:auto-rollback']);
    for (const event of ['recovered', 'rollback', 'release']) {
      history(`2026-10-14T17:03:00Z ${SHA} ${event}`);
      clock = new Date(clock.getTime() + 5 * MIN);
      await runWatchdogJob(wd());
      expect(await openKeys(), event).toEqual([]);
    }
  });

  it('不是法国（没有发布目录）：这两项不看，也不去问 /healthz', async () => {
    const r = await runWatchdogJob(
      watchdogJob({
        db: t.db,
        now: () => clock,
        log: () => {},
        releasesDir: join(dir, 'not-there'),
        fetchImpl: fetchHealth,
      })(),
    );
    expect(r).toMatchObject({ outcome: 'unscanned' });
    expect(probes).toBe(0);
    expect(await allAlerts()).toHaveLength(0);
  });

  it('【故意造出的失败】目录在、发布历史读不到：这一轮记没跑成（不当成发版没事），开着的发版提醒不撤', async () => {
    history(...BAD_HISTORY);
    await runWatchdogJob(wd());
    expect(await openKeys()).toHaveLength(1);
    rmSync(join(dir, '.history'));
    clock = at(5);
    await expect(runWatchdogJob(wd())).rejects.toThrow(WatchdogFailedError);
    expect(await openKeys()).toHaveLength(1);
    expect((await watchdogRuns()).at(-1)?.why).toContain('发布历史读不到');
  });

  it('和「连着没跑全」互不相干：发版出事不会多出 watchdog:red: 的卡', async () => {
    history(...BAD_HISTORY);
    await runWatchdogJob(wd());
    expect((await allAlerts()).every((a) => !a.dedupeKey.startsWith('watchdog:red:'))).toBe(true);
  });
});

describe('发版和健康页的判法（纯函数）', () => {
  it('发布历史最后一行认不出抛，不当成没事；空的是 null', () => {
    expect(lastHistoryEntry('')).toBeNull();
    expect(lastHistoryEntry('2026-10-14T17:03:00Z abc release unmerged\n')).toEqual({
      at: '2026-10-14T17:03:00Z',
      sha: 'abc',
      event: 'release',
    });
    expect(() => lastHistoryEntry('乱七八糟')).toThrow('认不出');
  });

  it('/healthz 的回应：200 好；503 列红的检查；不是健康报告的正文（502 页面）只报状态码', () => {
    expect(parseHealthzResponse(200, '{}')).toEqual({ ok: true });
    expect(
      parseHealthzResponse(
        503,
        JSON.stringify({ checks: { a: { ok: false, message: 'x' }, b: { ok: true } } }),
      ),
    ).toMatchObject({ ok: false, status: 503, failing: [{ name: 'a', message: 'x' }] });
    expect(parseHealthzResponse(502, '<html>Bad Gateway</html>')).toMatchObject({
      ok: false,
      status: 502,
      failing: [],
    });
  });

  it('进度记录 done、aborted 不算要人看，其他状态算；自动发布没说「要人看」不算', () => {
    const f = (trainStatus: string | null, autoNote: string | null = null) => ({
      last: null,
      trainStatus,
      autoNote,
    });
    expect(releaseAttentionReasons(f('done'), T0)).toEqual([]);
    expect(releaseAttentionReasons(f('aborted'), T0)).toEqual([]);
    expect(releaseAttentionReasons(f(null, '主线头 CI 不是绿的，等绿'), T0)).toEqual([]);
    expect(releaseAttentionReasons(f('deploying'), T0)).toHaveLength(1);
    expect(releaseAttentionReasons(f('failed'), T0)).toHaveLength(1);
  });

  describe('进度记录 running：正常在走不报，超过 TRAIN_STUCK_MS 才算卡住（2026-10-14 22:58Z 每趟自动发版都误报）', () => {
    const NEW = '2f5dc42f4636fe0a68264eb11ecc39a723e36b7d';
    const LAST = `2026-10-14T22:49:55Z df3692b292a74d8f0394dcf2238f1e7d9e9d7d4e release`;
    const START = new Date('2026-10-14T22:57:55.841Z');
    const running = (over: Record<string, unknown> = {}) => ({
      last: lastHistoryEntry(LAST),
      trainStatus: 'running',
      trainSince: START.toISOString(),
      trainSha: NEW,
      autoNote: '现在不发：有一趟发版在跑（2f5dc42f4636），等它收尾',
      ...over,
    });
    const after = (min: number) => new Date(START.getTime() + min * MIN);

    it('进行中 5 分钟：不报；自动发布写的是在跑，不含「要人看」', () => {
      expect(running().autoNote).not.toContain('要人看');
      expect(releaseAttentionReasons(running(), after(5))).toEqual([]);
      expect(judgeReleaseAttention(running(), after(1))).toEqual({ kind: 'fine' });
      expect(judgeReleaseAttention(running(), after(TRAIN_STUCK_MS / MIN))).toEqual({ kind: 'fine' });
    });

    it('【故意造出的失败】超过阈值：报，键和正文写正在发的提交，不挂在上一版（df3692b2）身上', () => {
      const v = judgeReleaseAttention(running(), after(TRAIN_STUCK_MS / MIN + 1));
      expect(v).toMatchObject({ kind: 'alert', key: 'watchdog:release:train:2f5dc42f4636:running' });
      if (v.kind !== 'alert') throw new Error('应当报');
      expect(v.key).not.toContain('df3692b292a7');
      expect(v.title).toBe('发版卡住：2f5dc42f4636 这一趟超过 70 分钟没收尾，自动发版停着');
      expect(v.body).toContain('正在发 2f5dc42f4636 的这一趟从 10-15 06:57 起停在「running」');
      // 进行中的话不含「要人看」，不另写一条自动发布
      expect(v.body).not.toContain('自动发布说');
    });

    it('done 不报（上一版、这一版都不报）', () => {
      expect(judgeReleaseAttention(running({ trainStatus: 'done' }), after(500))).toEqual({ kind: 'fine' });
    });

    it('旧格式（只有 status，没有起点时间）：running 判不了多久，照旧报，写明老格式', () => {
      const v = judgeReleaseAttention(
        { last: lastHistoryEntry(LAST), trainStatus: 'running', autoNote: null },
        after(1),
      );
      expect(v).toMatchObject({ kind: 'alert', key: 'watchdog:release:train:unknown:running' });
      if (v.kind !== 'alert') throw new Error('应当报');
      expect(v.body).toContain('没有起止时间（老格式）');
    });

    it('收了尾却没成（failed）：立刻报，键认这一趟的提交', () => {
      const v = judgeReleaseAttention(running({ trainStatus: 'failed' }), after(3));
      expect(v).toMatchObject({
        kind: 'alert',
        key: 'watchdog:release:train:2f5dc42f4636:failed',
        title: '发版要人看：2f5dc42f4636 这一趟停在「failed」，自动发版停着',
      });
    });

    it('这一趟落地了（done、current 就是目标），末行「健康检查没过」说的是它：不报；说的是别的提交、或 current 不是目标：报（#2207）', () => {
      const landed = {
        last: lastHistoryEntry(`2026-10-14T23:05:30Z ${NEW} unhealthy`),
        trainStatus: 'done',
        trainSince: START.toISOString(),
        trainSha: NEW,
        currentSha: NEW,
        autoNote: null,
      };
      expect(judgeReleaseAttention(landed, after(10))).toEqual({ kind: 'fine' });
      expect(judgeReleaseAttention({ ...landed, currentSha: null }, after(10))).toMatchObject({
        kind: 'alert',
      });
      expect(
        judgeReleaseAttention(
          { ...landed, currentSha: 'df3692b292a74d8f0394dcf2238f1e7d9e9d7d4e' },
          after(10),
        ),
      ).toMatchObject({ kind: 'alert', key: 'watchdog:release:2f5dc42f4636:unhealthy' });
      // 退回了：末行是 auto-rollback（上一版），照报
      expect(
        judgeReleaseAttention(
          { ...landed, last: lastHistoryEntry(`2026-10-14T23:05:31Z ${NEW} auto-rollback`) },
          after(10),
        ),
      ).toMatchObject({ kind: 'alert' });
      // 进度没成（failed）：照报，而且自动发版真停着
      const v = judgeReleaseAttention({ ...landed, trainStatus: 'failed' }, after(10));
      expect(v).toMatchObject({ kind: 'alert', title: '发版要人看：新版没发成或退回了，自动发版停着' });
    });

    it('阈值不小于发版接活脚本各步上限加起来（到上限它自己写成没成；没到的一律当正常在走）', async () => {
      // 发版接活脚本是 deploy/ 下的 .mjs（不在引擎的类型检查里），按文件地址引
      const { LIMITS: L } = (await import(
        pathToFileURL(join(import.meta.dirname, '../../../deploy/france/release-request/lib.mjs')).href
      )) as { LIMITS: Record<'releaseMs' | 'deployMs' | 'checkMs' | 'verifyMs' | 'stepMs', number> };
      const worst = L.releaseMs + L.deployMs + L.checkMs + L.verifyMs + 8 * L.stepMs;
      expect(TRAIN_STUCK_MS).toBeGreaterThanOrEqual(worst);
      // 最多多 5 分钟余量：巡查（agents/test/patrol.test.ts）对 LIMITS.trainStuckMinutes 做同样的核对，两边落在同一条线上
      expect(TRAIN_STUCK_MS).toBeLessThanOrEqual(worst + 5 * 60_000);
    });
  });
});
