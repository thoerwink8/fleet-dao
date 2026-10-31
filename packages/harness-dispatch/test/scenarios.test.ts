// 场景脚本（#3775）：重复提交只出一件活；短截止的活交回终局且带原因（排队过期、预算比剩下的长、跑到总时限被杀三条路）；
// 断网的表现（工人一直没有实质事件）；被人叫停；事件链表读得全。镜像是本机建的裸仓，git 用真的，工人是假的。
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { makeRedactor } from '@fleet-dao/harness-runner';
import { createTestDb, type TestDb } from '@fleet-dao/harness-store/testing';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import {
  Dispatcher,
  type DispatcherOptions,
  intakeSpawnRequests,
  intakeStopRequests,
  shadowWorkspaces,
} from '../src/index.ts';
import {
  cleanupScenario,
  formatChain,
  formatRateLimit,
  jobsOf,
  readChain,
  requestStop,
  runRateLimit,
  scenarioSpec,
  submitScenario,
} from '../src/scenarios.ts';
import { git, makeRepo } from './helpers.ts';

const FAKE = fileURLToPath(new URL('./fake-worker.mjs', import.meta.url));
const redact = makeRedactor([]);
let t: TestDb;
let mirrorRoot: string;
let baseSha: string;

beforeAll(async () => {
  t = await createTestDb();
  const src = makeRepo();
  mirrorRoot = await mkdtemp(join(tmpdir(), 'fleet2-scn-mirrors-'));
  git(mirrorRoot, 'clone', '-q', '--bare', src, join(mirrorRoot, 'o', 'r.git'));
  baseSha = git(src, 'rev-parse', 'HEAD').trim();
}, 60_000);
afterAll(() => t.close());
beforeEach(async () => {
  await t.pg.exec(
    'truncate fleet2.events, fleet2.jobs, fleet2.session_tokens, fleet2.projection_checkpoints, fleet2.command_receipts, fleet2.queue_limits, fleet2.shadow_batch_items, fleet2.shadow_runs, fleet2.shadow_compare restart identity',
  );
});

const target = () => ({ repo: 'o/r', baseSha });

async function dispatcher(extra: Partial<DispatcherOptions> = {}, env: Record<string, string> = {}) {
  const tmpRoot = await mkdtemp(join(tmpdir(), 'fleet2-scn-ws-'));
  const d = new Dispatcher({
    db: t.db,
    mcpUrl: 'http://127.0.0.1:4799/mcp',
    command: [process.execPath, FAKE],
    model: 'claude-opus-5-5',
    permissionMode: 'bypassPermissions',
    prepareWorkspace: shadowWorkspaces({ db: t.db, mirrorRoot, tmpRoot, redact }),
    hostEnv: { PATH: process.env.PATH, SYSTEMROOT: process.env.SYSTEMROOT, HOME: '/h' },
    extraEnv: env,
    tmpRoot,
    workerBudget: { startupMs: 3_000, totalMs: 20_000, killGraceMs: 200 },
    leaseMs: 5_000,
    heartbeatMs: 50,
    perMinute: 100,
    ...extra,
  });
  await d.init();
  return d;
}

const reason0 = (h: Record<string, unknown> | undefined): string =>
  String(((h?.reasons ?? []) as string[])[0]);

const handbacks = async () =>
  (
    await t.pg.query<{ payload: Record<string, unknown> }>(
      "select payload from fleet2.events where type = 'handback.recorded' order by id",
    )
  ).rows.map((r) => r.payload);

describe('重复提交', () => {
  it('同一个 taskId 提交两次：两条请求事件、一件活、收请求算一件重复', async () => {
    const sub = await submitScenario(t.db, 'scn-t-duplicate', scenarioSpec('duplicate'), target());
    expect(sub.eventIds).toHaveLength(2);
    expect(await intakeSpawnRequests(t.db)).toEqual({ scheduled: 1, duplicate: 1, skipped: 0 });
    const js = await jobsOf(t.db, sub.eventIds);
    expect(js.map((j) => j.key)).toEqual([`spawn:${sub.eventIds[0]}`]);
    // 再收一遍也不多出来
    expect(await intakeSpawnRequests(t.db)).toEqual({ scheduled: 0, duplicate: 0, skipped: 0 });
  });
});

describe('超时', () => {
  it('截止时刻很短（60 秒）、预算比剩下的长：起工人之前终局，原因写预算（A4）', async () => {
    const d = await dispatcher();
    const sub = await submitScenario(t.db, 'scn-t-timeout', scenarioSpec('timeout'), target());
    await d.poll();
    expect(await d.settled()).toMatchObject([{ outcome: 'failed-to-start', final: true }]);
    const [h] = await handbacks();
    expect(h).toMatchObject({ final: true, outcome: 'failed-to-start' });
    expect(reason0(h)).toContain('预算');
    expect((await jobsOf(t.db, sub.eventIds))[0]?.state).toBe('done');
    // 派工器收请求时碰到的是同一个键：活还是一件，截止时刻保持脚本给的短值，没被改成默认的 12 小时
    const js = await jobsOf(t.db, sub.eventIds);
    expect(js).toHaveLength(1);
    expect((js[0]?.deadlineAt?.getTime() ?? 0) - Date.now()).toBeLessThan(60_000);
    const rows = await readChain(t.db, 'scn-t-timeout');
    expect(rows.map((r) => r.type)).toEqual(['worker.spawn.requested', 'handback.recorded']);
  });

  it('排队时过了截止：领活时记终局交回，outcome dead，原因取调度器的话', async () => {
    const d = await dispatcher();
    await submitScenario(t.db, 'scn-t-dead', { ...scenarioSpec('timeout'), deadlineMs: 1 }, target());
    await new Promise((r) => setTimeout(r, 50));
    expect(await d.poll()).toBe(0);
    const [h] = await handbacks();
    expect(h).toMatchObject({ final: true, outcome: 'dead', verdict: 'unknown' });
    expect(reason0(h)).toContain('过了截止时刻');
  });

  it('跑到总时限被杀：终局交回，被停原因 deadline，事件链表里看得到', async () => {
    const d = await dispatcher(
      { workerBudget: { startupMs: 3_000, totalMs: 1_500, killGraceMs: 200 }, verifyReserveMs: 0 },
      { FAKE_MODE: 'work-hang' },
    );
    await submitScenario(t.db, 'scn-t-run-timeout', scenarioSpec('timeout'), target());
    await d.poll();
    expect(await d.settled()).toMatchObject([{ outcome: 'killed', final: true }]);
    const [h] = await handbacks();
    expect(reason0(h)).toContain('deadline');
    const rows = await readChain(t.db, 'scn-t-run-timeout');
    expect(rows.map((r) => r.type)).toEqual([
      'worker.spawn.requested',
      'worker.spawned',
      'worker.settled',
      'handback.recorded',
    ]);
    const table = formatChain(rows);
    expect(table).toContain('killed');
    expect(table).toContain('true');
    expect(table).toContain('deadline');
  }, 30_000);
});

describe('断网的表现', () => {
  it('工人起来后一直没有实质事件：起步无进展，确定没副作用，交回 final=false 并退避重试', async () => {
    const d = await dispatcher(
      { workerBudget: { startupMs: 500, totalMs: 20_000, killGraceMs: 200 }, retryBackoffMs: 60_000 },
      { FAKE_MODE: 'silent' },
    );
    const sub = await submitScenario(t.db, 'scn-t-offline', scenarioSpec('success'), target());
    await d.poll();
    expect(await d.settled()).toMatchObject([{ outcome: 'retry', final: false }]);
    const [h] = await handbacks();
    expect(h).toMatchObject({ final: false, willRetry: true, outcome: 'killed' });
    expect(reason0(h)).toContain('no_progress');
    expect((await jobsOf(t.db, sub.eventIds))[0]?.state).toBe('pending');
  }, 30_000);
});

describe('被人叫停', () => {
  it('叫停请求取消活，工人下次心跳收到，终局交回 cancelled，原因里有 user-stop', async () => {
    const d = await dispatcher({}, { FAKE_MODE: 'work-hang' });
    const sub = await submitScenario(t.db, 'scn-t-killed', scenarioSpec('killed'), target());
    await d.poll();
    // 等工人真起来（worker.spawned 写进库）再叫停，不然是「还没起就被叫停」，原因里没有 user-stop
    const until = Date.now() + 15_000;
    while ((await readChain(t.db, 'scn-t-killed')).every((r) => r.type !== 'worker.spawned')) {
      if (Date.now() > until) throw new Error('等工人起来超时');
      await new Promise((r) => setTimeout(r, 25));
    }
    await requestStop(t.db, 'scn-t-killed', sub.taskId, '场景验收：人叫停');
    expect(await intakeStopRequests(t.db)).toBe(1);
    expect(await d.settled()).toMatchObject([{ outcome: 'cancelled', final: true }]);
    const [h] = await handbacks();
    expect(JSON.stringify(h?.reasons)).toContain('user-stop');
  }, 30_000);
});

describe('重启接回', () => {
  it('工人在跑时派工器停机：交回 released / final=false / willRetry，活回 pending；新派工器重领跑完才是终局', async () => {
    const d1 = await dispatcher({}, { FAKE_MODE: 'work-hang' });
    const sub = await submitScenario(t.db, 'scn-t-restart', scenarioSpec('restart'), target());
    await d1.poll();
    const until = Date.now() + 15_000;
    while ((await readChain(t.db, 'scn-t-restart')).every((r) => r.type !== 'worker.spawned')) {
      if (Date.now() > until) throw new Error('等工人起来超时');
      await new Promise((r) => setTimeout(r, 25));
    }
    await d1.stop();
    expect((await jobsOf(t.db, sub.eventIds))[0]?.state).toBe('pending');
    const d2 = await dispatcher();
    await d2.poll();
    await d2.settled();
    const rows = await readChain(t.db, 'scn-t-restart');
    const hb = rows.filter((r) => r.type === 'handback.recorded');
    expect(hb.map((r) => [r.outcome, r.final])).toEqual([
      ['released', 'false/willRetry'],
      ['completed', 'true'],
    ]);
  }, 30_000);
});

describe('限流', () => {
  it('专用队列上排 7 件、每分钟 3 件：第一轮只放 3 件，其余等窗口', async () => {
    const r = await runRateLimit(t.db, 't', { perMinute: 3, total: 7, pollMs: 100, maxWaitMs: 1_500 });
    expect(r.releases).toHaveLength(3);
    expect(r.releases.every((x) => x.atMs < 1_000)).toBe(true);
    expect(formatRateLimit(r)).toContain('放行 3 件');
    // 清干净：队列的活和限速行都删了
    expect(
      (await t.pg.query("select 1 from fleet2.jobs where queue like 'scenario-rate-%'")).rows,
    ).toHaveLength(0);
    expect(
      (await t.pg.query("select 1 from fleet2.queue_limits where queue like 'scenario-rate-%'")).rows,
    ).toHaveLength(0);
  }, 30_000);
});

describe('清理', () => {
  it('cleanupScenario 删批次、回执和已收尾的活，事件留着', async () => {
    const d = await dispatcher();
    const sub = await submitScenario(t.db, 'scn-t-clean', scenarioSpec('timeout'), target());
    await d.poll();
    await d.settled();
    await cleanupScenario(t.db, 'scn-t-clean', sub.eventIds);
    for (const table of ['shadow_batch_items', 'jobs']) {
      expect((await t.pg.query(`select 1 from fleet2.${table}`)).rows).toHaveLength(0);
    }
    expect(
      (await t.pg.query("select 1 from fleet2.command_receipts where key like 'shadow-spawn:%'")).rows,
    ).toHaveLength(0);
    expect(
      (await t.pg.query("select 1 from fleet2.events where type = 'handback.recorded'")).rows,
    ).toHaveLength(1);
  });
});
