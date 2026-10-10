// /healthz 的 canary 项（健康页「全流程巡检」，#223）：最近一轮的结论和时间。通过而且不旧是好的；断了、没跑成、太久没跑完一轮、
// 一轮都还没跑完是红。每一种对外的说法都拿公开页禁用词名单（web/src/build/scan.ts）扫：不带仓名、单号和断的原因原文（原因只进日志）。
import {
  CANARY_RUN_TIMEOUT_MINUTES,
  type CanaryRunRow,
  finishCanaryRun,
  registerScheduledJobs,
  startCanaryRun,
  startScheduleRun,
} from '@fleet-dao/db';
import { createTestDb, resetTestDb, TEST_DB_TIMEOUT_MS, type TestDb } from '@fleet-dao/db/testing';
import type { EngineMasterState } from '@fleet-dao/shared';
import { silentLogger } from '@fleet-dao/store';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { CANARY_STALE_MS, canaryHealth, canaryHealthCheck } from '../src/canary-health.ts';
import { PublicHealthError, runHealthChecks } from '../src/health.ts';

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

/** 总开关关着的几种样子（#1141）：没设过＝默认关、值认不出＝按关算、人关的＝关着。 */
const masterOff = (why: 'never_set' | 'unreadable' | 'set') => ({ on: false as const, why });

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

  it('跳过（巡检仓的「让 AI 接活」关着，#1050 / #1808）：不当通过，回待定；过期的跳过也一样待定，不报 canary_stale', () => {
    const skipped = row({
      verdict: 'skipped',
      stage: 'open',
      issueNumber: null,
      why: '跳过：巡检仓的「让 AI 接活」关着',
    });
    expect(canaryHealth({ finished: skipped, running: null }, NOW)).toEqual({
      ok: 'pending',
      note: '最近一轮 09-27 20:13 跳过：巡检仓的「让 AI 接活」关着，没开单、没验',
    });
    const stale = row({ ...skipped, endedAt: new Date(NOW.getTime() - CANARY_STALE_MS - 60_000) });
    expect(canaryHealth({ finished: stale, running: null }, NOW)).toEqual({
      ok: 'pending',
      note: expect.stringMatching(/^最近一轮 .+ 跳过：巡检仓的「让 AI 接活」关着，没开单、没验$/),
    });
    expect(canaryHealth({ finished: stale, running: null }, NOW)).not.toMatchObject({
      code: 'canary_stale',
    });
  });

  it('最近一轮结论早于当前部署、断在收单（#1808）：待定，不报 canary_broken', () => {
    const finished = row({
      verdict: 'broken',
      stage: 'intake',
      endedAt: ago(120),
      why: '断在「收单」：库里还没有这张单的任务行',
    });
    // 部署晚于那轮结论
    const deployedAt = ago(30);
    const got = canaryHealth({ finished, running: null }, NOW, undefined, deployedAt);
    expect(got).toEqual({
      ok: 'pending',
      note: '这条结论早于当前部署（09-27 20:00），等新一轮',
    });
    expect(got).not.toMatchObject({ code: 'canary_broken' });
  });

  it('结论晚于部署、断在收单（#1808）：照旧报 canary_broken', () => {
    const deployedAt = ago(180);
    const finished = row({
      verdict: 'broken',
      stage: 'intake',
      endedAt: ago(17),
      why: '断在「收单」：库里还没有这张单的任务行',
    });
    expect(canaryHealth({ finished, running: null }, NOW, undefined, deployedAt)).toEqual({
      ok: false,
      code: 'canary_broken',
      message: '最近一轮（09-27 20:13 有结论）断在「收单」',
      detail: '断在「收单」：库里还没有这张单的任务行',
    });
  });

  it('最近一轮是「跳过」（#1808）：不当通过，回待定（含过期跳过）', () => {
    const skipped = row({
      verdict: 'skipped',
      stage: 'open',
      issueNumber: null,
      why: '跳过：巡检仓的「让 AI 接活」关着',
    });
    const got = canaryHealth({ finished: skipped, running: null }, NOW);
    expect(got.ok).toBe('pending');
    expect(got).not.toMatchObject({ ok: true });
    const stale = row({ ...skipped, endedAt: new Date(NOW.getTime() - CANARY_STALE_MS - 60_000) });
    const staleGot = canaryHealth({ finished: stale, running: null }, NOW);
    expect(staleGot.ok).toBe('pending');
    expect(staleGot).not.toMatchObject({ ok: true });
    expect(staleGot).not.toMatchObject({ code: 'canary_stale' });
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

  it('总开关关着（#1141 / #1808）：待定（不当通过、不拿断了的旧结论报 canary_broken），也没跑过什么都不说「最近一轮」；在跑的一轮也没到期限也不说「在跑」', () => {
    const broken = row({ verdict: 'broken', stage: 'dispatch', why: '断在「派活」：挂起等人' });
    expect(canaryHealth({ finished: broken, running: null }, NOW, masterOff('never_set'))).toEqual({
      ok: 'pending',
      note: '跳过：引擎总开关从没打开过（默认关），巡检没跑、没验；最近一轮有结论的是 09-27 20:13「派活」',
    });
    expect(canaryHealth({ finished: broken, running: null }, NOW, masterOff('set'))).toMatchObject({
      ok: 'pending',
      note: expect.stringContaining('跳过：引擎总开关关着，巡检没跑、没验'),
    });
    expect(canaryHealth({ finished: broken, running: null }, NOW, masterOff('unreadable'))).toMatchObject({
      ok: 'pending',
      note: expect.stringContaining('跳过：引擎总开关的设置认不出，按关算'),
    });
    expect(canaryHealth({ finished: null, running: null }, NOW, masterOff('never_set'))).toEqual({
      ok: 'pending',
      note: '跳过：引擎总开关从没打开过（默认关），巡检没跑、没验',
    });
    // 过了时限的没收尾的一轮：关着期间也照实说跳过，不说「巡检自己没收尾」
    const lost = running;
    expect(canaryHealth({ finished: broken, running: lost }, NOW, masterOff('never_set'))).toMatchObject({
      ok: 'pending',
      note: expect.stringContaining('跳过：'),
    });
  });

  it('每一种对外的说法都拿公开页禁用词名单扫一遍：没有内部名', async () => {
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
      canaryHealth({ finished: row({ verdict: 'skipped', stage: 'open', why: 'x' }), running }, NOW),
      canaryHealth(
        { finished: row({ verdict: 'skipped', stage: 'open', why: 'x', endedAt: ago(24 * 60) }), running },
        NOW,
      ),
      canaryHealth(
        { finished: row({ verdict: 'broken', stage: 'dispatch', why: 'x' }), running: null },
        NOW,
        masterOff('never_set'),
      ),
      canaryHealth({ finished: null, running: null }, NOW, masterOff('set')),
      canaryHealth(
        { finished: row({ verdict: 'broken', stage: 'intake', endedAt: ago(120), why: 'x' }), running: null },
        NOW,
        undefined,
        ago(30),
      ),
    ].map((h) => (h.ok === false ? h.message : h.note));
    expect(said).toHaveLength(12);
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
    const masterOn = async (): Promise<EngineMasterState> => ({ on: true });
    // 部署早于库里各轮结论：这一条测的是「断了 / 通过」本身，不是「早于部署」
    const boot = ago(24 * 60);
    const err = await canaryHealthCheck(t.db, masterOn, () => NOW, boot)().then(
      () => null,
      (e: unknown) => e,
    );
    expect(err).toBeInstanceOf(PublicHealthError);
    const report = await runHealthChecks(
      [{ name: 'canary', check: canaryHealthCheck(t.db, masterOn, () => NOW, boot) }],
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
    await expect(canaryHealthCheck(t.db, masterOn, () => NOW, boot)()).resolves.toBe(
      '最近一轮 09-27 20:20 通过（用时 50 分钟）',
    );
  });

  it('总开关关着：库里最近一轮就算断了也不报 canary_broken，报待定（跳过）；开关开着才照旧红（#1141 / #1808）', async () => {
    await resetTestDb(t);
    await registerScheduledJobs(t.db, [
      { id: 'canary', name: '全流程巡检', schedule: '每 6 小时', expectEveryMinutes: 780 },
    ]);
    const masterOffState = async (): Promise<EngineMasterState> => ({ on: false, why: 'never_set' });
    const masterOn = async (): Promise<EngineMasterState> => ({ on: true });
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
    const boot = ago(24 * 60);
    const pending = await canaryHealthCheck(t.db, masterOffState, () => NOW, boot)().then(
      () => null,
      (e: unknown) => e,
    );
    expect(pending).toBeInstanceOf(PublicHealthError);
    expect(pending).toMatchObject({
      code: 'canary_pending',
      message: '跳过：引擎总开关从没打开过（默认关），巡检没跑、没验；最近一轮有结论的是 09-27 19:00「验收」',
    });
    const err = await canaryHealthCheck(t.db, masterOn, () => NOW, boot)().then(
      () => null,
      (e: unknown) => e,
    );
    expect(err).toBeInstanceOf(PublicHealthError);
    expect(err).toMatchObject({ code: 'canary_broken' });
  });
});
