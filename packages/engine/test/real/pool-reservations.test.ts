// 三段的一段选定路由到写下开跑那一行之间预占池的名额（#757）全程：真库（PGlite）、真选路（store-ports 的 pickRoute 带 reserve，
// 和任务工作流一样）、真这一段（createRunSegment：真 git 建树、真 runs 写入、真预占交接和放掉），假插头。
// 拼车池上限 3：三张单选了它、都还没写开跑那一行，第四张来选路回「没空位」（等空位）；其中一张建树失败放掉之后，第四张派得出去。
// 几张单同时选路也只派出上限那么多；开跑那一行和预占交接时池上数的不变；换路由重选、过期都不让池一直显得满。
// 故意造的失败：预占写不进库（选路报错、不交回路由）、预占读不了（选路报错、不当成池空着）、不是库里的单要预占。

import { randomUUID } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { poolOccupancy, poolReservations, releaseTaskReservation, runs } from '@fleet-dao/db';
import { createTestDb, resetTestDb, TEST_DB_TIMEOUT_MS, type TestDb } from '@fleet-dao/db/testing';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import type { PickRouteResult, PortContext, RouteChoice } from '../../src/ports.ts';
import { localExec } from '../../src/real/exec.ts';
import type { HostDriver, HostReport, HostRunSpec, WiredHost } from '../../src/real/hosts.ts';
import { realReservations, realRuns } from '../../src/real/runs-writer.ts';
import type { SessionOrgReader } from '../../src/real/session-org.ts';
import {
  createStorePorts,
  RESERVE_RACE_RETRY_SECONDS,
  RESERVE_RACE_ROUNDS,
  type StorePortsDeps,
} from '../../src/real/store-ports.ts';
import { createRunSegment } from '../../src/real/task-segment.ts';
import type { RunSegmentInput } from '../../src/task-contract.ts';
import { goodBrief } from '../task-script.ts';
import { addTask, fakeTrees, MIN, mirror, NOW, world } from './fixtures.ts';

vi.setConfig({ testTimeout: 60_000 });

let t: TestDb;
beforeAll(async () => {
  t = await createTestDb();
}, TEST_DB_TIMEOUT_MS);
afterAll(() => t.close());

let root: string;
let clock: number;
beforeEach(async () => {
  await resetTestDb(t);
  // 写码这个用途只排拼车这一条路由（上限 3）：拼车满了就只能等，看得清「没空位」
  await world(t.db, { order: ['carpool'] });
  root = mkdtempSync(join(tmpdir(), 'fleet-pool-reservations-'));
  clock = NOW.getTime();
});
afterEach(() => rmSync(root, { recursive: true, force: true }));

const REPO = { id: 'r1', owner: 'acme', name: 'demo', defaultBranch: 'main', testCommand: 'pnpm check' };
const ctx = (): PortContext => ({
  signal: new AbortController().signal,
  heartbeat() {},
  attempt: 1,
  lastHeartbeat: undefined,
});
const onCarpool: SessionOrgReader = async () => ({ ok: true, org: 'carpool' });

const store = (over: Partial<StorePortsDeps> = {}) =>
  createStorePorts({
    db: t.db,
    now: () => new Date(clock),
    draw: () => 0.5,
    log: () => {},
    sessionOrg: onCarpool,
    ...over,
  });

/** 和任务工作流的 pick 一样：动手那一段来选路，派得出就预占。 */
const pick = (p: ReturnType<typeof store>, taskId: string): Promise<PickRouteResult> =>
  p.pickRoute(
    {
      taskId,
      stage: 'execute',
      avoidRouteIds: [],
      avoidPoolIds: [],
      avoidModelIds: [],
      reserve: { segment: 'manual' },
    },
    ctx(),
  );

async function picked(p: ReturnType<typeof store>, taskId: string): Promise<RouteChoice> {
  const got = await pick(p, taskId);
  if (!got.ok) throw new Error(`选路没派出去：${got.detail}`);
  expect(got.route).toMatchObject({ routeId: 'carpool', poolId: 'claude-carpool' });
  expect(got.route.reservationId).toEqual(expect.any(String));
  return got.route;
}

async function tasksOf(n: number): Promise<string[]> {
  const out: string[] = [];
  for (let i = 0; i < n; i++) out.push((await addTask(t.db)).task.id);
  return out;
}

const reservationRows = () => t.db.select().from(poolReservations);

const done = (): HostReport => ({
  hostId: 'claude-code',
  facts: { exitCode: 0, terminal: { isError: false, detail: 'done' }, quotaExhausted: false },
  usage: { inputTokens: 100, outputTokens: 20 },
  actualModel: 'claude-opus-5-5',
  answer: '做完了',
  wallMs: 1000,
  stderrTail: '',
});

/** 这一段（createRunSegment）接真库：开跑那一行、预占的交接和放掉都是真的；插头按 driverRun 交结局。 */
function segments(driverRun: (spec: HostRunSpec) => Promise<HostReport> = async () => done()) {
  const m = mirror(root);
  const ft = fakeTrees(join(root, 'work'));
  const driver = (hostId: WiredHost): HostDriver => ({
    hostId,
    userFrom: 'pool',
    canFork: false,
    newSessionId: () => ({ id: randomUUID(), known: true }),
    run: (spec) => driverRun(spec),
    loginFix: () => '去登录',
  });
  const run = createRunSegment({
    tree: {
      gh: m.gh as never,
      trees: ft.trees,
      exec: localExec(),
      tmpDir: join(root, 'engine-tmp'),
      gitBin: 'git',
      shBin: 'sh',
    },
    spawner: {
      db: t.db,
      drivers: {
        'claude-code': driver('claude-code'),
        'cursor-agent': driver('cursor-agent'),
        grok: driver('grok'),
        mirasim: driver('mirasim'),
      } as Record<WiredHost, HostDriver>,
      trees: ft.trees,
      baseEnv: { PATH: '/usr/bin' },
      resources: { memoryHighMb: 5888, memoryMaxMb: 6144, swapMaxMb: 0 },
    },
    runs: realRuns({ db: t.db }),
    reservations: realReservations({ db: t.db }),
    attempts: { async record() {} },
    runsDir: join(root, 'runs'),
    now: () => new Date(clock),
    heartbeatEveryMs: 5,
  });
  const input = (
    taskId: string,
    route: RouteChoice,
    over: Partial<RunSegmentInput> = {},
  ): RunSegmentInput => {
    const branch = `fleet/12-t${randomUUID().slice(0, 8)}`;
    return {
      schemaVersion: 1,
      taskId,
      repo: REPO,
      issueNumber: 12,
      route,
      worktreePath: ft.trees.treeFor(REPO, branch),
      branch,
      baseSha: m.head,
      brief: goodBrief(),
      tier: { tier: 'medium', effort: 'high', reason: '一个目录', modules: 1 } as never,
      feedback: [],
      timeoutMinutes: 5,
      ...over,
    };
  };
  return { run, input };
}

/** 报的错一层层的原话（drizzle 外面包了一层「Failed query」，库报的那句在 cause 里）。 */
async function errorChain(work: Promise<unknown>): Promise<string> {
  const err = await work.then(
    () => null,
    (e: unknown) => e,
  );
  expect(err, '该明确报错的却照常回了结果').not.toBeNull();
  const messages: string[] = [];
  for (let e: unknown = err; e instanceof Error; e = e.cause) messages.push(e.message);
  return messages.join('\n');
}

describe('选定路由到写下开跑那一行之间，这一段预占着池的名额（#757）', () => {
  it('拼车池上限 3：三张单选了它、都还没写开跑那一行，第四张来选路回「没空位」（等空位）；其中一张建树失败放掉之后，第四张派得出去', async () => {
    const p = store();
    const [a, b, c, d] = (await tasksOf(4)) as [string, string, string, string];
    const aRoute = await picked(p, a);
    await picked(p, b);
    await picked(p, c);
    expect(await t.db.select().from(runs)).toEqual([]);

    const fourth = await pick(p, d);
    expect(fourth).toMatchObject({ ok: false, waitFor: 'slot' });
    expect(!fourth.ok && fourth.detail).toContain('已选定还没开工 3 个');

    // a 建树失败（起会话前的头不是完整提交号）：这一段没起会话、runs 里一行没写，收场时放掉它预占的名额
    const seg = segments();
    await expect(seg.run(seg.input(a, aRoute, { baseSha: 'not-a-sha' }), ctx())).rejects.toMatchObject({
      code: 'BAD_INPUT',
    });
    expect(await t.db.select().from(runs)).toEqual([]);
    expect((await reservationRows()).map((r) => r.taskId).sort()).toEqual([b, c].sort());
    await picked(p, d);
  });

  it('几张单同时选路：上限 3 的拼车池只派出 3 个，第 4 个等空位（预占那一下被抢先的按新事实重选，不硬塞）', async () => {
    const p = store();
    const ids = await tasksOf(4);
    const got = await Promise.all(ids.map((id) => pick(p, id)));
    expect(got.filter((g) => g.ok)).toHaveLength(3);
    expect(got.filter((g) => !g.ok)).toEqual([expect.objectContaining({ ok: false, waitFor: 'slot' })]);
    expect(await reservationRows()).toHaveLength(3);
  });

  describe('读事实到预占之间池被别的单占满（选路读组织那一下插进来的「别的单」）', () => {
    /** 三张别的单，每次被叫到就（换掉旧的）预占满拼车池，占到 ttl 毫秒后。 */
    const rivals = async (ttl: number) => {
      const ids = await tasksOf(3);
      return async () => {
        for (const taskId of ids) {
          await releaseTaskReservation(t.db, { taskId, segment: 'manual' });
          await t.db.insert(poolReservations).values({
            taskId,
            segment: 'manual',
            routeId: 'carpool',
            reservedAt: new Date(clock),
            expiresAt: new Date(clock + ttl),
          });
        }
      };
    };

    it('预占那一下发现满了：这一次的结论不作数，按新事实重选——这回看得见池满了，等空位；一个都没多派', async () => {
      const [a] = (await tasksOf(1)) as [string];
      const fill = await rivals(20 * MIN);
      let calls = 0;
      const p = store({
        sessionOrg: async () => {
          calls += 1;
          if (calls === 1) await fill();
          return { ok: true, org: 'carpool' };
        },
      });
      const got = await pick(p, a);
      expect(got).toMatchObject({ ok: false, waitFor: 'slot' });
      expect(!got.ok && got.detail).toContain('已选定还没开工 3 个');
      expect(calls).toBe(2);
      expect((await reservationRows()).filter((r) => r.taskId === a)).toEqual([]);
    });

    it('连着几次都在预占那一下被抢先：不硬塞，回「过一会儿再选」并写明是被同时选路的单抢先了', async () => {
      const [a] = (await tasksOf(1)) as [string];
      // 别的单每次都在读完事实之后占满、又在下一次读事实之前过期：每一轮都是读的时候空着、占的时候满了
      const fill = await rivals(1);
      const p = store({
        sessionOrg: async () => {
          await fill();
          clock += 1;
          return { ok: true, org: 'carpool' };
        },
      });
      const got = await pick(p, a);
      expect(got).toMatchObject({
        ok: false,
        waitFor: 'slot',
        retryAfterSeconds: RESERVE_RACE_RETRY_SECONDS,
      });
      expect(!got.ok && got.detail).toContain(`连着 ${RESERVE_RACE_ROUNDS} 次`);
      expect(!got.ok && got.detail).toContain('刚被别的单占满（3/3）');
      expect((await reservationRows()).filter((r) => r.taskId === a)).toEqual([]);
    });
  });

  it('开跑那一行和预占交接：会话跑着时池上 1 个在跑、2 个预占着，一共还是 3 个；跑完名额空出来，第四张派得出去', async () => {
    const p = store();
    const [a, b, c, d] = (await tasksOf(4)) as [string, string, string, string];
    const aRoute = await picked(p, a);
    await picked(p, b);
    await picked(p, c);
    const during: unknown[] = [];
    const seg = segments(async () => {
      during.push(Object.fromEntries(await poolOccupancy(t.db, { now: new Date(clock) })));
      return done();
    });
    expect(await seg.run(seg.input(a, aRoute), ctx())).toMatchObject({ ok: true });
    expect(during).toEqual([{ 'claude-carpool': { inFlight: 1, reserved: 2 } }]);
    expect((await reservationRows()).map((r) => r.taskId).sort()).toEqual([b, c].sort());
    expect(await t.db.select().from(runs)).toEqual([
      expect.objectContaining({ taskId: a, routeId: 'carpool', outcome: 'done' }),
    ]);
    await picked(p, d);
  });

  it('同一张单重新选路（上一次没开跑、换了路由）：之前的预占作废，不和自己抢；卡得太久的预占过期就不算，让出名额并记一笔', async () => {
    const logged: string[] = [];
    const p = store({ reservationTtlMs: 5 * MIN, log: (message) => logged.push(message) });
    const [a, b, c, d] = (await tasksOf(4)) as [string, string, string, string];
    await picked(p, a);
    await picked(p, b);
    await picked(p, c);
    await picked(p, a);
    expect(await reservationRows()).toHaveLength(3);
    expect(await pick(p, d)).toMatchObject({ ok: false, waitFor: 'slot' });

    clock += 6 * MIN;
    await picked(p, d);
    expect((await reservationRows()).map((r) => r.taskId)).toEqual([d]);
    expect(logged.filter((m) => m.includes('过期的预占'))).toHaveLength(3);
  });

  it('【故意造出的失败】预占写不进库：选路明确报错、不交回路由（这一段就不会起会话），库里一行预占都没有', async () => {
    const [a] = (await tasksOf(1)) as [string];
    await t.client.exec(
      'alter table pool_reservations add constraint reservations_unwritable check (false) not valid',
    );
    try {
      expect(await errorChain(pick(store(), a))).toContain('reservations_unwritable');
      expect(await reservationRows()).toEqual([]);
    } finally {
      await t.client.exec('alter table pool_reservations drop constraint reservations_unwritable');
    }
  });

  it('【故意造出的失败】预占读不了：选路明确报错，不当成池空着派出去（不预占的选路一样）', async () => {
    const [a] = (await tasksOf(1)) as [string];
    await t.client.exec('alter table pool_reservations rename to pool_reservations_unreadable');
    try {
      expect(await errorChain(pick(store(), a))).toContain('relation "pool_reservations" does not exist');
      const plain = store().pickRoute(
        { taskId: a, stage: 'execute', avoidRouteIds: [], avoidPoolIds: [], avoidModelIds: [] },
        ctx(),
      );
      expect(await errorChain(plain)).toContain('relation "pool_reservations" does not exist');
    } finally {
      await t.client.exec('alter table pool_reservations_unreadable rename to pool_reservations');
    }
  });

  it('【故意造出的失败】要预占的不是库里的单（编号不是 UUID）：BAD_INPUT、不可重试，不派', async () => {
    await expect(pick(store(), 'canary-1')).rejects.toMatchObject({ code: 'BAD_INPUT', retryable: false });
    expect(await reservationRows()).toEqual([]);
  });
});
