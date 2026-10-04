// /healthz 的 canary 项（健康页「全流程巡检」，#223）：最近一轮的结论和时间。通过而且不旧是好的；断了、没跑成、太久没跑完一轮、
// 一轮都还没跑完是红。每一种对外的说法都拿演示版打包扫描的同一份名单扫：不带仓名、单号和断的原因原文（原因只进日志）。
import {
  CANARY_RUN_TIMEOUT_MINUTES,
  type CanaryRunRow,
  finishCanaryRun,
  registerScheduledJobs,
  startCanaryRun,
  startScheduleRun,
} from '@fleet-dao/db';
import { createTestDb, TEST_DB_TIMEOUT_MS, type TestDb } from '@fleet-dao/db/testing';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { CANARY_STALE_MS, canaryHealth, canaryHealthCheck } from '../src/canary-health.ts';
import { PublicHealthError, runHealthChecks } from '../src/health.ts';
import { silentLogger } from '../src/log.ts';

// 路径放进变量：api 的 tsconfig 不收 web 包的文件，照 deploy-lag.test.ts 的写法运行时再载
const SCAN = '../../web/src/build/scan.ts';
const NOW = new Date('2026-09-27T12:30:00.000Z');
const ago = (min: number) => new Date(NOW.getTime() - min * 60_000);

function row(over: Partial<CanaryRunRow> = {}): CanaryRunRow {
  return {
    id: 1,
    scheduleRunId: 1,
    repo: 'acme/fleet-canary',
    issueNumber: 12,
    taskId: null,
    startedAt: ago(60),
    endedAt: ago(17),
    verdict: 'pass',
    stage: 'board',
    why: null,
    steps: [],
    cleanedAt: null,
    updatedAt: ago(17),
    ...over,
  };
}

const running = row({ id: 2, endedAt: null, verdict: null, stage: 'plan', startedAt: ago(5) });

describe('canary 项怎么判', () => {
  it('最近一轮通过、不旧：好的，带一句几点通过、用了多久；这一轮在跑也写上', () => {
    expect(canaryHealth({ finished: row(), running: null }, NOW)).toEqual({
      ok: true,
      note: '最近一轮 09-27 20:13 通过（用时 43 分钟）',
    });
    expect(canaryHealth({ finished: row(), running }, NOW)).toMatchObject({
      ok: true,
      note: expect.stringContaining('这一轮在跑'),
    });
  });

  it('【故意造出的失败】断了：红，说断在哪一步、几点；原因原文（带仓名、单号）只进日志', () => {
    const got = canaryHealth(
      {
        finished: row({
          verdict: 'broken',
          stage: 'implement',
          why: '断在「动手」（这一步走了 3 分 0 秒）：acme/fleet-canary #12 停下等人：没有可用的路由',
        }),
        running: null,
      },
      NOW,
    );
    expect(got).toEqual({
      ok: false,
      code: 'canary_broken',
      message: '最近一轮（09-27 20:13 有结论）断在「动手」',
      detail: '断在「动手」（这一步走了 3 分 0 秒）：acme/fleet-canary #12 停下等人：没有可用的路由',
    });
  });

  it('换成三段任务工作流之前的老几轮（记的是老步骤「派活」）：照样说人话，不露出步骤的英文编号', () => {
    const got = canaryHealth(
      {
        finished: row({ verdict: 'broken', stage: 'dispatch', why: '断在「派活」：挂起等人' }),
        running: null,
      },
      NOW,
    );
    expect(got).toMatchObject({ ok: false, message: '最近一轮（09-27 20:13 有结论）断在「派活」' });
  });

  it('【故意造出的失败】巡检自己没跑成：红，和「断了」分开说', () => {
    const got = canaryHealth(
      { finished: row({ verdict: 'not_run', stage: 'open', why: '读不到里程碑' }), running: null },
      NOW,
    );
    expect(got).toMatchObject({
      ok: false,
      code: 'canary_not_run',
      message: '最近一轮（09-27 20:13）巡检自己没跑成',
    });
  });

  it('【故意造出的失败】最近一次通过太旧（之后没跑完过一轮）：红；一轮都还没跑完：红（在跑的写明还没有结论）', () => {
    const stale = row({ endedAt: new Date(NOW.getTime() - CANARY_STALE_MS - 60_000) });
    expect(canaryHealth({ finished: stale, running: null }, NOW)).toMatchObject({
      ok: false,
      code: 'canary_stale',
    });
    expect(canaryHealth({ finished: null, running: null }, NOW)).toMatchObject({
      ok: false,
      code: 'canary_never',
      message: '还没跑完过一轮',
    });
    expect(canaryHealth({ finished: null, running }, NOW)).toMatchObject({
      ok: false,
      code: 'canary_never',
      message: '第一轮还在跑，还没有结论',
    });
  });

  it('【故意造出的失败】没收尾的一轮（过了一轮工作流的时限还没结论）：红，说巡检自己没收尾，不说「在跑」；比最近有结论的那轮还早的不算在跑', () => {
    const lost = row({
      id: 3,
      endedAt: null,
      verdict: null,
      stage: 'plan',
      startedAt: ago(CANARY_RUN_TIMEOUT_MINUTES + 1),
    });
    const earlier = row({
      startedAt: ago(CANARY_RUN_TIMEOUT_MINUTES + 400),
      endedAt: ago(CANARY_RUN_TIMEOUT_MINUTES + 360),
    });
    for (const finished of [earlier, null]) {
      expect(canaryHealth({ finished, running: lost }, NOW)).toEqual({
        ok: false,
        code: 'canary_not_run',
        message: '最近一轮（09-27 14:59 开始）过了 5.5 小时还没有结论：巡检自己没收尾',
        detail: undefined,
      });
    }
    const old = row({ id: 0, endedAt: null, verdict: null, stage: 'plan', startedAt: ago(24 * 60) });
    expect(canaryHealth({ finished: row(), running: old }, NOW)).toEqual({
      ok: true,
      note: '最近一轮 09-27 20:13 通过（用时 43 分钟）',
    });
  });

  it('每一种对外的说法都拿演示版打包扫描的名单扫一遍：没有内部名', async () => {
    const scan = (await import(/* @vite-ignore */ SCAN)) as {
      BUILTIN_TERMS: readonly string[];
      scanText(file: string, text: string, terms: readonly string[]): { term: string }[];
    };
    expect(scan.BUILTIN_TERMS.length).toBeGreaterThan(0);
    const said = [
      canaryHealth({ finished: row(), running }, NOW),
      canaryHealth({ finished: row({ verdict: 'broken', stage: 'implement', why: 'x' }), running }, NOW),
      canaryHealth({ finished: row({ verdict: 'not_run', stage: 'open', why: 'x' }), running }, NOW),
      canaryHealth({ finished: row({ endedAt: ago(24 * 60) }), running }, NOW),
      canaryHealth({ finished: null, running }, NOW),
      canaryHealth({ finished: null, running: null }, NOW),
      canaryHealth(
        { finished: null, running: row({ endedAt: null, verdict: null, startedAt: ago(24 * 60) }) },
        NOW,
      ),
    ].map((h) => (h.ok ? h.note : h.message));
    expect(said).toHaveLength(7);
    for (const text of said) expect(scan.scanText('canary', text, scan.BUILTIN_TERMS), text).toEqual([]);
  });
});

describe('canary 项读库（真库）', () => {
  let t: TestDb;
  beforeAll(async () => {
    t = await createTestDb();
  }, TEST_DB_TIMEOUT_MS);
  afterAll(() => t.close());

  it('【故意造出的失败】库里最近一轮断了：/healthz 这一项红、整体 503 那种红，原因只进日志；再来一轮通过就回绿', async () => {
    await registerScheduledJobs(t.db, [
      { id: 'canary', name: '全流程巡检', schedule: '每 6 小时', expectEveryMinutes: 780 },
    ]);
    const broken = await startCanaryRun(t.db, {
      scheduleRunId: await startScheduleRun(t.db, 'canary', ago(120)),
      repo: 'acme/fleet-canary',
      at: ago(120),
    });
    await finishCanaryRun(t.db, broken, {
      verdict: 'broken',
      stage: 'verify',
      why: '断在「验收」：停下等人',
      steps: [],
      at: ago(90),
    });
    const err = await canaryHealthCheck(t.db, () => NOW)().then(
      () => null,
      (e: unknown) => e,
    );
    expect(err).toBeInstanceOf(PublicHealthError);
    const report = await runHealthChecks(
      [{ name: 'canary', check: canaryHealthCheck(t.db, () => NOW) }],
      silentLogger,
    );
    expect(report).toEqual({
      ok: false,
      checks: {
        canary: { ok: false, code: 'canary_broken', message: '最近一轮（09-27 19:00 有结论）断在「验收」' },
      },
    });
    const pass = await startCanaryRun(t.db, {
      scheduleRunId: await startScheduleRun(t.db, 'canary', ago(60)),
      repo: 'acme/fleet-canary',
      at: ago(60),
    });
    await finishCanaryRun(t.db, pass, { verdict: 'pass', stage: 'board', why: null, steps: [], at: ago(10) });
    await expect(canaryHealthCheck(t.db, () => NOW)()).resolves.toBe(
      '最近一轮 09-27 20:20 通过（用时 50 分钟）',
    );
  });
});
