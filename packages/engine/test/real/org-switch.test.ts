// 会话用户切号的真装配（real/org-switch.ts，#157）接真库（PGlite）、真路由探针（假插头）、假 reclaude（org list 的替身）、
// 假帮手（切号的替身）：「拼车被拒 → 等到没有在跑的会话 → 切独享 → 探针读回独享在线 → 到恢复时刻 → 没有在跑的会话时切回
// → 探针读回拼车在线」走一遍全程，操作记录里切号、核对各两条。失败的每一条都故意造一次：帮手没切成、切完探针读回不在线、
// 拼车用满却读不到几点恢复、让选路停下以后又有会话登记了——一律不当成切好了、不当成到点了，写「要人看」的提醒，好了自己撤。

import { randomUUID } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { SwitchSessionOrgResult } from '@fleet-dao/adapters';
import { readingsFromRateLimit } from '@fleet-dao/adapters/quota';
import {
  auditLog,
  notifications,
  routes,
  runs,
  saveOrgState,
  savePoolQuota,
  sessionRuns,
  settings,
  takeOrgLock,
  upsertAlert,
} from '@fleet-dao/db';
import { createTestDb, resetTestDb, TEST_DB_TIMEOUT_MS, type TestDb } from '@fleet-dao/db/testing';
import { beijingDateOf, type OrgKind } from '@fleet-dao/shared';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import type { CarpoolApiRead } from '../../src/jobs/carpool-outage.ts';
import { emptyLedger, serializeLedger } from '../../src/jobs/org-ledger.ts';
import { probeOrgNow, runRouteProbeJob } from '../../src/jobs/route-probe.ts';
import { registerEngineJobs } from '../../src/real/jobs.ts';
import type { OrgSwitchSessions } from '../../src/real/org-switch.ts';
import {
  ORG_CHANNEL_ALERT,
  ORG_DRIFT_ALERT,
  ORG_LEDGER_ALERT,
  ORG_POOL_HOLD_ALERT,
  ORG_POOL_HOLD_OVERDUE_ALERT,
  ORG_RESERVE_ALERT,
  ORG_STUCK_ALERT,
  ORG_SWITCH_ALERT,
  ORG_VERIFY_ALERT,
  orgDriftReporter,
  orgSwitchRound,
} from '../../src/real/org-switch.ts';
import { routeProbeJob } from '../../src/real/route-probe.ts';
import { realRuns } from '../../src/real/runs-writer.ts';
import { createStorePorts, poolHoldKey } from '../../src/real/store-ports.ts';
import { type OneShotSpawner, runOneShot } from '../../src/runner/one-shot.ts';
import {
  addTask,
  CARPOOL_ORG_ID,
  type FakeRunScript,
  fakeMirasimDeps,
  fakeRun,
  fakeTrees,
  MIN,
  NOW,
  orgListRig,
  REPLY,
  SOLO_ORG_ID,
  world,
} from './fixtures.ts';

let t: TestDb;
beforeAll(async () => {
  t = await createTestDb();
}, TEST_DB_TIMEOUT_MS);
afterAll(() => t.close());

let root: string;
beforeEach(async () => {
  await resetTestDb(t);
  await world(t.db);
  // 夹具里「5 分钟前探通」落在前 2 位 30 分钟的间隔之内（#1635），这一轮会照旧不探；这里测的是探的行为，把上一次探通挪到间隔之外
  await t.client.query(
    "update routes set probed_at = probed_at - interval '35 minutes' where probe_state = 'ok'",
  );
  // 真实的样子：独享池挂在独享组织上、拼车池挂在拼车组织上
  await t.client.query("update pools set org_kind = 'solo' where id = 'claude-solo'");
  await registerEngineJobs(t.db);
  root = mkdtempSync(join(tmpdir(), 'fleet-org-switch-'));
});
afterEach(() => rmSync(root, { recursive: true, force: true }));

const H = 60 * MIN;
const answered = (): FakeRunScript => ({ result: { text: REPLY } });

/** 接口读数的替身：本人额度还宽、拼车和独享各一个可用账号。每次现读都是新的（时刻跟着假钟走）。 */
const healthyRead = (at: Date): CarpoolApiRead => ({
  ok: true,
  requestedAt: at,
  serverDate: at,
  ageSeconds: null,
  quota: { usedUsd: 10, limitUsd: 80, resetsAt: new Date(at.getTime() + 3 * 60 * MIN), status: 'active' },
  org: 'ok',
  accounts: [
    { id: 'carpool-1', kind: 'carpool', hasAssignedAccount: true, expiresAt: null },
    { id: 'solo-1', kind: 'solo', hasAssignedAccount: true, expiresAt: null },
  ],
});

/** 本人额度到顶的接口读数（几点恢复由接口说）。 */
const fullRead = (at: Date, resetsAt: Date): CarpoolApiRead => {
  const ok = healthyRead(at);
  return ok.ok ? { ...ok, quota: { usedUsd: 80, limitUsd: 80, resetsAt, status: 'active' } } : ok;
};

function setup(
  over: {
    /** 接口读数的替身：不给就是两个账号都可用、本人额度还宽。 */
    api?: (at: Date) => CarpoolApiRead;
    /** 帮手的替身：不给就切成（假 reclaude 跟着改成切过去的那个）。 */
    helper?: (to: OrgKind) => Promise<SwitchSessionOrgResult>;
    probe?: (n: number) => FakeRunScript;
    /** 让选路停下以后等的那一会儿里发生的事（比如又有会话登记了）。 */
    duringGrace?: () => Promise<void>;
    /** 会话端口的切号那两样（#59）：给了就是有会话在跑也照切，先停下。 */
    sessions?: OrgSwitchSessions;
  } = {},
) {
  const rig = orgListRig();
  let clock = NOW.getTime();
  const now = () => new Date(clock);
  // 和真装配一样：起点变动（读数变了、引擎没切过号）写 session-org:drift 和操作记录（#335）
  const org = rig.reader({
    ttlMs: 30_000,
    now,
    onEvent: orgDriftReporter({ db: t.db, user: 'fleet-agent-carpool', machine: '法国', now }),
  });
  const helperCalls: OrgKind[] = [];
  const logs: string[] = [];
  const store = createStorePorts({ db: t.db, now, draw: () => 0.5, log: () => {}, sessionOrg: org });
  const pick = () =>
    store.pickRoute(
      { taskId: randomUUID(), stage: 'execute', avoidRouteIds: [], avoidPoolIds: [], avoidModelIds: [] },
      { signal: new AbortController().signal, heartbeat() {}, attempt: 1, lastHeartbeat: undefined },
    );
  const picksWhileSwitching: Awaited<ReturnType<typeof pick>>[] = [];
  const orgSwitch = orgSwitchRound({
    db: t.db,
    org,
    user: 'fleet-agent-carpool',
    switchOrg: async (to) => {
      helperCalls.push(to);
      // 切的那一会儿选路停着
      picksWhileSwitching.push(await pick());
      if (over.helper) return over.helper(to);
      rig.answer(to);
      return { ok: true, changed: true };
    },
    machine: '法国',
    readApi: async () => (over.api ?? healthyRead)(now()),
    // 当场触发的切号切完当场探切过去的池（和真装配一样用同一份路由探针）
    probeNow: (to) => probeOrgNow(job(), to),
    ...(over.sessions ? { sessions: over.sessions } : {}),
    now,
    sleep: async () => {
      await over.duringGrace?.();
    },
    graceMs: 0,
    drainTimeoutMs: 10_000,
    pollMs: 2_000,
    log: (level, text, fields) => void logs.push(JSON.stringify([level, text, fields])),
  });
  const fake = fakeRun((_, n) => (over.probe ? over.probe(n) : answered()));
  const job = routeProbeJob({
    db: t.db,
    trees: fakeTrees(join(root, 'work')).trees,
    claudeCommand: (user) => [`/opt/fake/${user}/reclaude`],
    cursorCommand: (user) => [`/opt/fake/${user}/cursor-agent`],
    grokCommand: (user) => [`/opt/fake/${user}/grok`],
    ...fakeMirasimDeps(),
    sessionOrg: org,
    orgSwitch,
    machine: '法国',
    now,
    log: () => {},
    sleep: async () => {},
    retryDelayMs: 0,
    run: { 'claude-code': fake.run },
  });
  return {
    rig,
    orgSwitch,
    helperCalls,
    picksWhileSwitching,
    logs,
    fake,
    pick,
    now,
    round: () => runRouteProbeJob(job()),
    advance: (ms: number) => {
      clock += ms;
    },
  };
}

/** 会话、探针被拒时记下的读数（和 real/sessions.ts 同一个换算、同一个写入口）。 */
async function rejected(poolId: string, at: Date, resetsAt: Date | null) {
  const windows = readingsFromRateLimit(
    {
      status: 'rejected',
      exhausted: true,
      rateLimitType: 'five_hour',
      ...(resetsAt ? { resetsAt: resetsAt.toISOString() } : {}),
      windows: [],
      observedAt: at.toISOString(),
    },
    { poolId },
  );
  if (!windows) throw new Error('被拒的读数换不出来');
  await savePoolQuota(t.db, { poolId, readAt: at.toISOString(), complete: false, windows }, { now: at });
}

/** 一个还没结束的会话（登记了、在跑），交回让它结束的函数。 */
async function running(routeId: string, at: Date, options: { started?: boolean } = {}) {
  const { task } = await addTask(t.db);
  const id = randomUUID();
  await t.db.insert(sessionRuns).values({
    id,
    taskId: task.id,
    stage: 'execute',
    routeId,
    whyRoute: '占位',
    queuedAt: at,
    runAsUser: 'fleet-agent-carpool',
    ...(options.started ? { startedAt: at, sessionId: randomUUID() } : {}),
  });
  return Object.assign(
    async (endedAt: Date) => {
      // 引擎包不直接依赖 drizzle-orm：收场直接写 SQL（收的时刻不早于开工、排队的时刻）。
      await t.client.query(
        'update session_runs set outcome = $1, ended_at = greatest($2::timestamptz, coalesce(started_at, queued_at)) where id = $3',
        ['ok', endedAt.toISOString(), id],
      );
    },
    { id },
  );
}

/**
 * 会话端口切号那两样的替身（#59）：手上几个会话，叫停以后再看 settle 次才收场（Infinity = 一直不收场）。
 */
function fakeSessions(runs: { id: string; poolId: string }[], settle = 1) {
  const state = new Map(runs.map((r) => [r.id, { poolId: r.poolId, stoppedAtPoll: -1 }]));
  let polls = 0;
  const stops: { poolIds: string[]; why: string; stopped: string[] }[] = [];
  const sessions: OrgSwitchSessions = {
    stop(poolIds, why, only) {
      const stopped: string[] = [];
      for (const [id, s] of state) {
        if (!poolIds.has(s.poolId) || s.stoppedAtPoll >= 0) continue;
        if (only && !only(id)) continue;
        s.stoppedAtPoll = polls;
        stopped.push(id);
      }
      stops.push({ poolIds: [...poolIds].sort(), why, stopped });
      return stopped;
    },
    live(poolIds) {
      polls += 1;
      for (const [id, s] of state) {
        if (s.stoppedAtPoll >= 0 && polls - s.stoppedAtPoll > settle) state.delete(id);
      }
      return [...state].filter(([, s]) => poolIds.has(s.poolId)).map(([id]) => id);
    },
  };
  return { sessions, stops };
}

/** #194 新加的几种记录（恢复条件、渠道状态、顺手发生的事、切回宽限）：单独看，不混进切号、核对这几条老记录里。 */
const NEW_AUDITS = [
  'session-org.outage',
  'session-org.channel',
  'session-org.note',
  'session-org.drain',
  'session-org.limit',
  'session-org.read-backoff',
];
const auditsWhere = async (keep: (action: string) => boolean) =>
  (await t.db.select().from(auditLog))
    .filter((a) => a.action.startsWith('session-org.') && keep(a.action))
    .sort((a, b) => a.id - b.id)
    .map((a) => ({
      action: a.action,
      ok: a.ok,
      before: a.before,
      after: a.after,
      error: a.error,
      reason: a.reason,
    }));
const audits = async () =>
  (await auditsWhere((x) => !NEW_AUDITS.includes(x))).map(({ reason: _r, ...rest }) => rest);
const newAudits = (action: string) => auditsWhere((x) => x === action);
const alertOf = async (key: string) =>
  (await t.db.select().from(notifications)).find((n) => n.dedupeKey === key);
const row = async (id: string) => (await t.db.select().from(routes)).find((r) => r.id === id);

describe('全程：拼车被拒 → 等到没有在跑的会话 → 切独享 → 读回在线 → 到恢复时刻 → 空着时切回 → 读回在线', () => {
  it('操作记录里切号、切回、两次核对都在；每次切都是在没有会话的时候；切完选路跟着走', async () => {
    // 接口读数跟着假钟走：清零时刻（NOW + 2 小时）之前说本人额度到顶，之后说恢复了
    const resetsAt = new Date(NOW.getTime() + 2 * H);
    let exhausted = false;
    const s = setup({
      api: (at) => (exhausted && at < resetsAt ? fullRead(at, resetsAt) : healthyRead(at)),
    });
    // 平时：挂拼车、额度宽，不切；拼车池探通，独享池不探
    await s.round();
    expect(s.helperCalls).toEqual([]);
    expect(await row('carpool')).toMatchObject({ alive: true, probeState: 'ok' });
    expect(await row('solo')).toMatchObject({ alive: false, probeState: 'skipped' });

    // 拼车的会话被拒（5 小时窗口，2 小时后清零）；还有一个拼车上的会话没结束
    const resets = new Date(NOW.getTime() + 2 * H);
    exhausted = true;
    await rejected('claude-carpool', s.now(), resets);
    const end = await running('carpool', s.now());
    // 选路不再往拼车派，独享没挂着也派不了：等额度
    expect(await s.pick()).toMatchObject({ ok: false, waitFor: 'quota' });
    s.advance(15 * MIN);
    await s.round();
    // 手上有会话：等，帮手一次都没调
    expect(s.helperCalls).toEqual([]);
    expect(await audits()).toEqual([]);

    // 会话跑完了：下一轮切到独享，这一轮探的就是独享（探通），拼车不探
    await end(s.now());
    s.advance(15 * MIN);
    await s.round();
    expect(s.helperCalls).toEqual(['solo']);
    expect(await row('solo')).toMatchObject({ alive: true, probeState: 'ok' });
    expect(await row('carpool')).toMatchObject({ alive: false, probeState: 'skipped' });
    expect(await s.pick()).toMatchObject({ ok: true, route: { routeId: 'solo', poolId: 'claude-solo' } });

    // 还没到恢复时刻：不切回；独享上又有会话在跑
    s.advance(30 * MIN);
    await s.round();
    expect(s.helperCalls).toEqual(['solo']);
    const endSolo = await running('solo', s.now());
    // 过了恢复时刻、会话还没结束：等
    s.advance(H + MIN);
    await s.round();
    expect(s.helperCalls).toEqual(['solo']);
    // 跑完了：切回拼车，探针读回拼车在线
    await endSolo(s.now());
    s.advance(15 * MIN);
    await s.round();
    expect(s.helperCalls).toEqual(['solo', 'carpool']);
    expect(await row('carpool')).toMatchObject({ alive: true, probeState: 'ok' });
    expect(await s.pick()).toMatchObject({ ok: true, route: { routeId: 'carpool' } });

    expect(await audits()).toEqual([
      {
        action: 'session-org.switch',
        ok: true,
        before: { org: 'carpool' },
        after: { org: 'solo' },
        error: null,
      },
      { action: 'session-org.verify', ok: true, before: null, after: { org: 'solo' }, error: null },
      {
        action: 'session-org.switch',
        ok: true,
        before: { org: 'solo' },
        // 切回拼车记是确认过的（接口读数连着两次说恢复了）还是试探的
        after: { org: 'carpool', mode: 'confirmed' },
        error: null,
      },
      { action: 'session-org.verify', ok: true, before: null, after: { org: 'carpool' }, error: null },
    ]);
    // 新记录：恢复条件（凭什么切、几点恢复）；切走那一刻落的
    const outage = await newAudits('session-org.outage');
    expect(outage).toHaveLength(1);
    expect(outage[0]?.after).toMatchObject({ kind: 'E1' });
    expect(outage[0]?.reason).toContain('拼车用不了（E1）');
    // 渠道状态：第一次判就记了一笔「正常」，之后没变就不再记
    expect((await newAudits('session-org.channel')).map((a) => a.after)).toEqual([{ state: 'ok' }]);
    // 切的那一会儿选路停着（不派、过一会儿再选）
    expect(s.picksWhileSwitching).toHaveLength(2);
    for (const p of s.picksWhileSwitching) {
      expect(p).toMatchObject({ ok: false, waitFor: 'slot' });
      expect(!p.ok && p.detail).toContain('正在把会话用户从');
    }
    // 没有要人看的
    for (const key of [ORG_SWITCH_ALERT, ORG_VERIFY_ALERT, ORG_STUCK_ALERT]) {
      expect(await alertOf(key), key).toBeUndefined();
    }
    // 操作记录、日志里不带组织编号
    const text = JSON.stringify([await t.db.select().from(auditLog), s.logs]);
    for (const bad of [String(CARPOOL_ORG_ID), String(SOLO_ORG_ID)]) expect(text).not.toContain(bad);
  });
});

describe('【故意造出的失败】', () => {
  it('帮手没切成（org use 失败、切回了原来的）：不当成切好了；操作记录写没成和原因，报「要人看」，下一轮切成了自己撤', async () => {
    let fail = true;
    const s = setup({
      helper: async (to) => {
        if (fail) {
          return {
            ok: false,
            code: 'failed',
            exitCode: 1,
            now: 'carpool',
            detail: 'fleet-agent-scope：没切成（org use 退出码 1：boom），现在挂的还是原来的拼车组织',
          };
        }
        s.rig.answer(to);
        return { ok: true, changed: true };
      },
    });
    await rejected('claude-carpool', s.now(), new Date(NOW.getTime() + 2 * H));
    await s.round();
    expect(s.helperCalls).toEqual(['solo']);
    // 还挂着拼车：独享不探、拼车照探
    expect(await row('solo')).toMatchObject({ alive: false, probeState: 'skipped' });
    expect(await audits()).toEqual([
      {
        action: 'session-org.switch',
        ok: false,
        before: { org: 'carpool' },
        after: { org: 'solo' },
        error:
          'fleet-agent-scope：没切成（org use 退出码 1：boom），现在挂的还是原来的拼车组织（现在挂的是拼车组织）',
      },
    ]);
    const alarm = await alertOf(ORG_SWITCH_ALERT);
    expect(alarm).toMatchObject({ level: 'alert', resolvedAt: null, title: '会话用户切号没成：拼车 → 独享' });
    expect(alarm?.body).toContain('拼车本人 5 小时额度用满');
    expect(alarm?.body).toContain('法国');

    fail = false;
    s.advance(15 * MIN);
    await s.round();
    expect(s.helperCalls).toEqual(['solo', 'solo']);
    expect((await alertOf(ORG_SWITCH_ALERT))?.resolvedAt).not.toBeNull();
    expect((await alertOf(ORG_SWITCH_ALERT))?.body).toMatch(/^已撤：这一次切成了：拼车 → 独享/);
  });

  it('切过去了，探针读回不在线：核对记没成、报「要人看」；之后哪一轮探通了自己撤', async () => {
    let down = true;
    const s = setup({
      probe: () =>
        down
          ? {
              result: {
                isError: true,
                terminalReason: 'api_error',
                text: 'Not logged in · Please run /login',
              },
              exitCode: 1,
            }
          : answered(),
    });
    await rejected('claude-carpool', s.now(), new Date(NOW.getTime() + 2 * H));
    await s.round();
    expect(s.helperCalls).toEqual(['solo']);
    const [, verify] = await audits();
    expect(verify).toMatchObject({ action: 'session-org.verify', ok: false, after: { org: 'solo' } });
    expect(verify?.error).toContain('独享池的路由一条都没探通');
    expect(verify?.error).toContain('登录失效');
    const alarm = await alertOf(ORG_VERIFY_ALERT);
    expect(alarm).toMatchObject({
      level: 'alert',
      resolvedAt: null,
      title: '切到独享组织以后探针读回不在线',
    });

    down = false;
    s.advance(15 * MIN);
    await s.round();
    // 没再切（拼车还没恢复），独享探通：撤
    expect(s.helperCalls).toEqual(['solo']);
    expect((await alertOf(ORG_VERIFY_ALERT))?.resolvedAt).not.toBeNull();
  });

  it('拼车用满了却读不到几点恢复：不切回（不当成到点了），报「要人看」；读到了恢复时刻就撤', async () => {
    const s = setup();
    s.rig.answer('solo');
    await rejected('claude-carpool', s.now(), null);
    await s.round();
    expect(s.helperCalls).toEqual([]);
    const alarm = await alertOf(ORG_STUCK_ALERT);
    expect(alarm).toMatchObject({ level: 'alert', resolvedAt: null });
    expect(alarm?.body).toContain('却读不到几点恢复');
    // 读数旧了（过了 30 分钟、选路那边算「不知道」）也照样不切回
    s.advance(3 * H);
    await s.round();
    expect(s.helperCalls).toEqual([]);
    expect((await alertOf(ORG_STUCK_ALERT))?.resolvedAt).toBeNull();

    // 新读数带着清零时刻（已经过了）：撤掉，切回拼车
    await rejected('claude-carpool', s.now(), new Date(s.now().getTime() - MIN));
    s.advance(15 * MIN);
    await s.round();
    expect((await alertOf(ORG_STUCK_ALERT))?.resolvedAt).not.toBeNull();
    expect(s.helperCalls).toEqual(['carpool']);
  });

  it('让选路停下以后等的那一会儿里又有会话登记了：这一轮不切，帮手不调', async () => {
    const s = setup({
      duringGrace: async () => {
        await running('carpool', NOW);
      },
    });
    await rejected('claude-carpool', s.now(), new Date(NOW.getTime() + 2 * H));
    await s.round();
    expect(s.helperCalls).toEqual([]);
    expect(await audits()).toEqual([]);
    // 选路停的那一道解开了：照常选（拼车额度用满，等额度）
    expect(await s.pick()).toMatchObject({ ok: false, waitFor: 'quota' });
  });

  it('挂的是哪个认不出（org list 读不到）：不切，也不因此撤掉之前没切成的那条', async () => {
    const s = setup();
    await upsertAlert(t.db, {
      dedupeKey: ORG_SWITCH_ALERT,
      level: 'alert',
      taskId: null,
      title: '会话用户切号没成：拼车 → 独享',
      body: '上一轮',
    });
    await rejected('claude-carpool', s.now(), new Date(NOW.getTime() + 2 * H));
    s.rig.answer({ code: 1, stderr: 'not logged in' });
    await s.round();
    expect(s.helperCalls).toEqual([]);
    expect((await alertOf(ORG_SWITCH_ALERT))?.resolvedAt).toBeNull();
    // 两个 Claude 池都没探成，写明认不出
    expect((await row('solo'))?.probeDetail).toContain('会话用户挂的组织认不出');
  });

  it('独享池整池暂停着（要人拍）：拼车用满也不切过去', async () => {
    const s = setup();
    await upsertAlert(t.db, {
      dedupeKey: poolHoldKey('claude-solo'),
      level: 'decision',
      taskId: null,
      title: '账号池 claude-solo 整池暂停：登录失效',
      body: '占位',
    });
    await rejected('claude-carpool', s.now(), new Date(NOW.getTime() + 2 * H));
    await s.round();
    expect(s.helperCalls).toEqual([]);
    // 独享这一类的池整池暂停 = 独享账号不可用，只剩拼车 1 个可用账号：没得切（创始人 2026-10-04 约 22:30 的规矩）
    expect(s.logs.join('\n')).toContain('只剩 1 个可用账号');
    expect(s.logs.join('\n')).toContain('独享账号不可用');
  });
});

describe('手上有会话在跑也照切：先停下、等收场、再切（#59）', () => {
  it('拼车被拒、手上两个拼车会话在跑：停下两个（只停带组织类型的池上的），收场了才切；操作记录写明停了哪几个', async () => {
    const a = await running('carpool', NOW, { started: true });
    const b = await running('carpool', NOW, { started: true });
    const fake = fakeSessions([
      { id: a.id, poolId: 'claude-carpool' },
      { id: b.id, poolId: 'claude-carpool' },
    ]);
    const s = setup({ sessions: fake.sessions });
    await rejected('claude-carpool', s.now(), new Date(NOW.getTime() + 2 * H));
    await s.round();
    expect(s.helperCalls).toEqual(['solo']);
    // 停的时候带着切号的原因（会话收场交回 org_switch，续会话时写进提示词）；两个池都在停的范围里
    expect(fake.stops[0]).toEqual({
      poolIds: ['claude-carpool', 'claude-solo'],
      why: '切号：会话用户从拼车组织切到独享组织，先停下，切完接着干',
      stopped: [a.id, b.id],
    });
    const [switched] = await audits();
    expect(switched).toMatchObject({
      action: 'session-org.switch',
      ok: true,
      before: { org: 'carpool' },
      after: { org: 'solo', stopped: [a.id, b.id] },
    });
    const row = (await t.db.select().from(auditLog)).find((r) => r.action === 'session-org.switch');
    expect(row?.reason).toContain('手上 2 个 Claude 会话先停下');
    expect(row?.reason).toContain('切之前停下了 2 个在跑的 Claude 会话，切完各自接着干');
    // 切的那一会儿选路停着
    expect(s.picksWhileSwitching[0]).toMatchObject({ ok: false, waitFor: 'slot' });
  });

  it('【故意造出的失败】停下的会话一直不收场：这一轮不切（不在会话还在跑的时候切），记没成、报「要人看」', async () => {
    const a = await running('carpool', NOW, { started: true });
    const fake = fakeSessions([{ id: a.id, poolId: 'claude-carpool' }], Number.POSITIVE_INFINITY);
    const s = setup({ sessions: fake.sessions });
    await rejected('claude-carpool', s.now(), new Date(NOW.getTime() + 2 * H));
    await s.round();
    expect(s.helperCalls).toEqual([]);
    const [attempt] = await audits();
    expect(attempt).toMatchObject({
      action: 'session-org.switch',
      ok: false,
      after: { org: 'solo', stopped: [a.id] },
    });
    expect(attempt?.error).toContain('还有 1 个没收场、0 个还在起，这一轮不切（停下的照样接着干）');
    expect(await alertOf(ORG_SWITCH_ALERT)).toMatchObject({ level: 'alert', resolvedAt: null });
    // 选路那一道解开了：停下的会话照样续上（还在拼车上，等额度）
    expect(await s.pick()).toMatchObject({ ok: false, waitFor: 'quota' });
  });

  it('登记了、进程还没起来的（还在建树）：等它；排队很久还没起来的、库里开着可手上没有的（上一轮工人留下的），不等', async () => {
    // 刚登记、还没起来：等不到它起来，这一轮不切
    await running('carpool', NOW);
    const s = setup({ sessions: fakeSessions([]).sessions });
    await rejected('claude-carpool', s.now(), new Date(NOW.getTime() + 2 * H));
    await s.round();
    expect(s.helperCalls).toEqual([]);
    expect((await audits())[0]?.error).toContain('0 个没收场、1 个还在起');

    // 排队 20 分钟还没起来的、起来了可手上没有的：不是在跑的进程，照切
    await t.client.query('delete from audit_log');
    await t.client.query('delete from session_runs');
    await running('carpool', new Date(NOW.getTime() - 20 * MIN));
    await running('carpool', NOW, { started: true });
    const t2 = setup({ sessions: fakeSessions([]).sessions });
    await t2.round();
    expect(t2.helperCalls).toEqual(['solo']);
  });

  it('到恢复时刻、手上的独享会话在跑：照样停下、切回拼车', async () => {
    const a = await running('solo', NOW, { started: true });
    const fake = fakeSessions([{ id: a.id, poolId: 'claude-solo' }]);
    const s = setup({ sessions: fake.sessions });
    s.rig.answer('solo');
    await rejected('claude-carpool', new Date(NOW.getTime() - 3 * H), new Date(NOW.getTime() - MIN));
    await s.round();
    expect(s.helperCalls).toEqual(['carpool']);
    expect(fake.stops[0]?.stopped).toEqual([a.id]);
    expect(fake.stops[0]?.why).toContain('从独享组织切到拼车组织');
  });
});

describe('三段的一次性会话也算在跑（#157）：开跑就在 runs 留一行没结束的，会话端口停不下它，等它跑完再切', () => {
  /** 起一个真的一次性会话（真 runs 写入、真库），进程卡在半路，放行了才收场。 */
  function oneShotOnCarpool(now: () => Date, routeId = 'carpool') {
    let release: () => void = () => {};
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    let entered: () => void = () => {};
    const spawned = new Promise<void>((resolve) => {
      entered = resolve;
    });
    let calls = 0;
    const spawn: OneShotSpawner = async () => {
      calls += 1;
      entered();
      await gate;
      return { exitCode: 0, stdout: '做完了', stderr: '', killed: false };
    };
    const done = runOneShot(
      { segment: 'manual', modelId: 'opus-5.5', routeId, issueNumber: 12, prompt: '干活', cwd: root },
      { spawn, runs: realRuns({ db: t.db }), tmpDir: join(root, 'runs'), now },
    );
    return { done, spawned, release: () => release(), calls: () => calls };
  }

  it('一次性 Claude 会话在跑、拼车用满：不切、等（会话端口接着也不切）；它跑完了下一轮切独享', async () => {
    const s = setup({ sessions: fakeSessions([]).sessions });
    const job = oneShotOnCarpool(s.now);
    await job.spawned;
    await rejected('claude-carpool', s.now(), new Date(NOW.getTime() + 2 * H));
    await s.round();
    // 手上有一次性会话：等，帮手一次都没调、没有切号记录
    expect(s.helperCalls).toEqual([]);
    expect(await audits()).toEqual([]);
    const plan = s.logs.find((l) => l.includes('这一轮的判断'));
    expect(plan).toContain('"action":"wait"');
    expect(plan).toContain('手上还有 1 个 Claude 会话没结束');
    // 选路照样不往拼车派、独享没挂着：等额度
    expect(await s.pick()).toMatchObject({ ok: false, waitFor: 'quota' });

    // 跑完了：开跑那一行收掉，下一轮切到独享
    job.release();
    expect((await job.done).outcome).toBe('done');
    s.advance(15 * MIN);
    await s.round();
    expect(s.helperCalls).toEqual(['solo']);
    expect(await s.pick()).toMatchObject({ ok: true, route: { routeId: 'solo' } });
  });

  it('让选路停下以后等的那一会儿里起了一次性会话：这一轮不切（会话端口停不下它），帮手不调', async () => {
    const writer = realRuns({ db: t.db });
    const s = setup({
      sessions: fakeSessions([]).sessions,
      duringGrace: async () => {
        await writer.start({
          runId: randomUUID(),
          segment: 'manual',
          model: 'opus-5.5',
          routeId: 'carpool',
          startedAt: NOW.toISOString(),
        });
      },
    });
    await rejected('claude-carpool', s.now(), new Date(NOW.getTime() + 2 * H));
    await s.round();
    expect(s.helperCalls).toEqual([]);
    expect(await audits()).toEqual([]);
    expect(s.logs.join('\n')).toContain('让选路停下以后又有会话登记了，这一轮不切');
    // 选路停的那一道解开了：照常选（拼车额度用满，等额度）
    expect(await s.pick()).toMatchObject({ ok: false, waitFor: 'quota' });
  });

  it('【故意造出的失败】开跑那一行写不进库（路由不在库里，外键拒收）：不起会话（RUN_START_FAILED），库里不留一行', async () => {
    let spawned = 0;
    const err = await runOneShot(
      { segment: 'manual', modelId: 'opus-5.5', routeId: 'no-such-route', prompt: '干活', cwd: root },
      {
        spawn: async () => {
          spawned += 1;
          return { exitCode: 0, stdout: '做完了', stderr: '', killed: false };
        },
        runs: realRuns({ db: t.db }),
        tmpDir: join(root, 'runs'),
      },
    ).catch((e: unknown) => e);
    expect(err).toMatchObject({ name: 'OneShotError', code: 'RUN_START_FAILED' });
    expect((err as Error).message).toContain('开跑那一行写不进 runs，没起会话');
    expect(spawned).toBe(0);
    expect(await t.db.select().from(runs)).toEqual([]);
  });
});

describe('组织临时被切走又切回（#335）：选路、探针、切号按同一个起点判，活不挂起、自己接着走', () => {
  /** 法国现在的样子（创始人 09-27 夜拍）：独享池整池暂停着，选路不派、拼车用满也不切过去。 */
  const holdSolo = () =>
    upsertAlert(t.db, {
      dedupeKey: poolHoldKey('claude-solo'),
      level: 'decision',
      taskId: null,
      title: '账号池 claude-solo 整池暂停：法国暂时不用独享号',
      body: '创始人 2026-09-27 夜拍',
    });

  it('09-27 21:54 那次：人经帮手切到独享、两分钟内又切回——选路等着（不挂起），推一条带前后两次读数的提醒，切回来照常派拼车、提醒自己撤；独享暂停照旧', async () => {
    const s = setup();
    await holdSolo();
    // 21:52 那一轮：挂拼车，拼车探通；独享不探，记下探的时候挂的是拼车
    await s.round();
    expect(await row('carpool')).toMatchObject({ alive: true, probeState: 'ok', probeOrg: 'carpool' });
    expect(await row('solo')).toMatchObject({ alive: false, probeState: 'skipped', probeOrg: 'carpool' });

    // 21:53 人手动切到独享（引擎没切，库里没有切号记录）
    s.advance(2 * MIN);
    s.rig.answer('solo');
    const during = await s.pick();
    // 不照新读数派，也不挂起等人：过 30 秒再选
    expect(during).toMatchObject({ ok: false, waitFor: 'slot' });
    expect(!during.ok && during.detail).toContain('会话用户挂的组织这会儿定不下来，过一会儿再选');
    const drift = await alertOf(ORG_DRIFT_ALERT);
    expect(drift).toMatchObject({ level: 'alert', resolvedAt: null });
    expect(drift?.title).toBe('会话用户挂的组织变了，引擎没切过号：拼车 → 独享');
    // 提醒里是前后两次读数：几点、谁读的、读到哪个
    expect(drift?.body).toContain('09-25 16:00:00 切号读到拼车');
    expect(drift?.body).toContain('09-25 16:02:00 选路读到独享');
    expect(drift?.body).toContain('fleet-agent-scope org-use');

    // 21:55 人切回拼车：读数回到起点，马上照常派拼车，提醒自己撤、写明为什么
    s.advance(MIN);
    s.rig.answer('carpool');
    expect(await s.pick()).toMatchObject({ ok: true, route: { routeId: 'carpool' } });
    const settled = await alertOf(ORG_DRIFT_ALERT);
    expect(settled?.resolvedAt).not.toBeNull();
    expect(settled?.body).toMatch(/^已撤：读数回到了拼车（09-25 16:03:00 选路读到拼车）/);

    // 下一轮探针：挂拼车，不切号；独享暂停照旧（没探它、没派它、没撤它的暂停）
    s.advance(12 * MIN);
    await s.round();
    expect(s.helperCalls).toEqual([]);
    expect((await alertOf(poolHoldKey('claude-solo')))?.resolvedAt).toBeNull();
    expect(await audits()).toEqual([
      {
        action: 'session-org.drift',
        ok: true,
        before: { org: 'carpool', at: '2026-09-25T08:00:00.000Z', by: '切号' },
        after: { org: 'solo', at: '2026-09-25T08:02:00.000Z', by: '选路' },
        error: null,
      },
      {
        action: 'session-org.settle',
        ok: true,
        before: { org: 'carpool' },
        after: { org: 'carpool', how: 'back' },
        error: null,
      },
    ]);
    const text = JSON.stringify([
      await t.db.select().from(auditLog),
      await t.db.select().from(notifications),
    ]);
    for (const bad of [String(CARPOOL_ORG_ID), String(SOLO_ORG_ID)]) expect(text).not.toContain(bad);
  });

  it('切过去一直没切回：2 分钟后认它（提醒撤掉、写明认了），活等切号不挂起；下一轮探针引擎切回拼车，切完照常派', async () => {
    const s = setup();
    await s.round();
    s.advance(MIN);
    s.rig.answer('solo');
    expect(await s.pick()).toMatchObject({ ok: false, waitFor: 'slot' });
    // 连着 2 分钟都是独享：认了。拼车要等切号（引擎下一轮切回：拼车没用满），独享上一轮在拼车下没探、等探针——等得来
    s.advance(2 * MIN);
    const waiting = await s.pick();
    expect(waiting).toMatchObject({ ok: false, waitFor: 'slot' });
    expect(!waiting.ok && waiting.detail).toContain('在等引擎切号');
    expect(!waiting.ok && waiting.detail).toContain('等切号');
    expect(!waiting.ok && waiting.detail).toContain('等下一轮路由探针在独享组织下探过再派');
    expect((await alertOf(ORG_DRIFT_ALERT))?.body).toMatch(
      /^已撤：读数定下来了：从 ?09-25 16:01:00 ?起连着 2 分钟都是独享/,
    );

    // 下一轮：切号判的也是这个起点——挂独享、拼车没用满，切回拼车；帮手切的，不算没记录的变动
    s.advance(12 * MIN);
    await s.round();
    expect(s.helperCalls).toEqual(['carpool']);
    expect(await s.pick()).toMatchObject({ ok: true, route: { routeId: 'carpool' } });
    expect((await audits()).map((a) => a.action)).toEqual([
      'session-org.drift',
      'session-org.settle',
      'session-org.switch',
      'session-org.verify',
    ]);
  });

  it('引擎切到独享、拼车恢复了人先切回拼车：拼车那条上一轮在独享下没探——等下一轮探针，不当成坏了挂起；下一轮探通照常派', async () => {
    const s = setup();
    // 拼车被拒、20 分钟后清零：这一轮引擎切到独享，拼车不探（记下探的时候挂的是独享）
    await rejected('claude-carpool', s.now(), new Date(NOW.getTime() + 20 * MIN));
    await s.round();
    expect(s.helperCalls).toEqual(['solo']);
    s.advance(15 * MIN);
    await s.round();
    expect(await row('carpool')).toMatchObject({ alive: false, probeState: 'skipped', probeOrg: 'solo' });
    // 到点了，人赶在下一轮之前手动切回拼车
    s.advance(6 * MIN);
    s.rig.answer('carpool');
    expect(await s.pick()).toMatchObject({ ok: false, waitFor: 'slot' });
    s.advance(2 * MIN);
    // 认了拼车：拼车路由不是坏了、是上一轮没探——等下一轮探针（改之前：拼车不在线、独享要等切过去，两个硬挡，挂起等人）
    const waiting = await s.pick();
    expect(waiting).toMatchObject({ ok: false, waitFor: 'slot' });
    expect(!waiting.ok && waiting.detail).toContain('等下一轮路由探针在拼车组织下探过再派');
    // 下一轮：挂拼车、不切，探通拼车，照常派
    s.advance(7 * MIN);
    await s.round();
    expect(s.helperCalls).toEqual(['solo']);
    expect(await row('carpool')).toMatchObject({ alive: true, probeState: 'ok', probeOrg: 'carpool' });
    expect(await s.pick()).toMatchObject({ ok: true, route: { routeId: 'carpool' } });
  });

  it('【故意造出的失败】读数刚变、还没定下来时轮到探针：切号不判（写明定不下来），Claude 池这一轮不探、结论照旧，这一轮记 partial', async () => {
    const s = setup();
    await s.round();
    s.advance(MIN);
    s.rig.answer('solo');
    const run = await s.round();
    expect(run.outcome).toBe('partial');
    expect(run.why).toContain('会话用户挂的组织这会儿定不下来，Claude 订阅池的 2 条路由这一轮没探、结论照旧');
    expect(s.helperCalls).toEqual([]);
    expect(s.logs.join('\n')).toContain('会话用户挂的组织这会儿定不下来');
    // 结论照旧：拼车还是上一轮探通的在线，独享还是「没探」
    expect(await row('carpool')).toMatchObject({ alive: true, probeState: 'ok', probeOrg: 'carpool' });
    expect(await row('solo')).toMatchObject({ probeState: 'skipped', probeOrg: 'carpool' });
  });
});

describe('拼车用不了，当场切（#194）：不等路由探针那一轮，切完当场探', () => {
  const USER = 'fleet-agent-carpool';
  const rejection = (at: Date) => ({
    at,
    code: 'quota_exhausted',
    text: '拼车 5 小时额度已用完，约 120 分钟后重置',
  });
  /** 接口读数的几种账号状态。 */
  const withAccounts = (
    at: Date,
    accounts: { carpool?: boolean | null; solo?: boolean | null },
  ): CarpoolApiRead => {
    const r = healthyRead(at);
    if (!r.ok) return r;
    const list = [
      ...(accounts.carpool === undefined
        ? []
        : [
            {
              id: 'carpool-1',
              kind: 'carpool' as const,
              hasAssignedAccount: accounts.carpool,
              expiresAt: null,
            },
          ]),
      ...(accounts.solo === undefined
        ? []
        : [{ id: 'solo-1', kind: 'solo' as const, hasAssignedAccount: accounts.solo, expiresAt: null }]),
    ];
    return { ...r, accounts: list };
  };

  it('被拒当场：不用等探针，立刻切独享、当场探独享、选路马上能派独享；恢复条件和凭什么都进操作记录', async () => {
    const s = setup();
    expect(await s.orgSwitch.now({ by: '拼车会话被拒', rejection: rejection(s.now()) })).toBe('solo');
    expect(s.helperCalls).toEqual(['solo']);
    // 没跑过一轮探针，独享路由已经探通了（切完当场探）
    expect(await row('solo')).toMatchObject({ alive: true, probeState: 'ok' });
    expect(await s.pick()).toMatchObject({ ok: true, route: { routeId: 'solo' } });
    const [switched, verify] = await audits();
    expect(switched).toMatchObject({ action: 'session-org.switch', ok: true, after: { org: 'solo' } });
    expect(verify).toMatchObject({ action: 'session-org.verify', ok: true, after: { org: 'solo' } });
    const [outage] = await newAudits('session-org.outage');
    expect(outage?.after).toMatchObject({ kind: 'E1', resetsFrom: 'text' });
    // 接口说本人还有余额、请求却被拒：照被拒办，另记一笔「读数和实际对不上」
    expect((await newAudits('session-org.note')).map((n) => n.reason).join('')).toContain('接口说本人额度');
  });

  it('【故意造出的失败】同时来两个当场触发（一批会话一起被拒）：只切一次，帮手只调一次，操作记录里切号只有一条', async () => {
    const s = setup();
    const [a, b] = await Promise.all([
      s.orgSwitch.now({ by: '会话 A 被拒', rejection: rejection(s.now()) }),
      s.orgSwitch.now({ by: '会话 B 被拒', rejection: rejection(s.now()) }),
    ]);
    expect([a, b].filter((x) => x === 'solo')).toHaveLength(1);
    expect(s.helperCalls).toEqual(['solo']);
    expect((await audits()).filter((x) => x.action === 'session-org.switch')).toHaveLength(1);
  });

  it('【故意造出的失败】别的进程拿着切号的锁（没过期）：这一次不判、帮手不调；锁过期了才接手', async () => {
    const s = setup();
    await takeOrgLock(t.db, USER, {
      holder: '另一个进程',
      now: s.now(),
      ttlMs: 5 * MIN,
      emptyDoc: serializeLedger(emptyLedger()),
    });
    expect(await s.orgSwitch.now({ by: '被拒', rejection: rejection(s.now()) })).toBeNull();
    expect(s.helperCalls).toEqual([]);
    expect(s.logs.join('\n')).toContain('切号的锁在别的进程手里');
    s.advance(6 * MIN);
    expect(await s.orgSwitch.now({ by: '被拒', rejection: rejection(s.now()) })).toBe('solo');
  });

  it('【故意造出的失败】设置里开着「引擎暂不用独享」：拼车被拒也不切；关了就切', async () => {
    const s = setup();
    await t.db.insert(settings).values({ key: 'engine.soloPaused', value: true, updatedBy: '创始人' });
    expect(await s.orgSwitch.now({ by: '被拒', rejection: rejection(s.now()) })).toBeNull();
    expect(s.helperCalls).toEqual([]);
    expect(s.logs.join('\n')).toContain('引擎暂不用独享');
    await t.client.query(`update settings set value = 'false'::jsonb where key = 'engine.soloPaused'`);
    expect(await s.orgSwitch.now({ by: '被拒', rejection: rejection(s.now()) })).toBe('solo');
  });

  it('【故意造出的失败】设置的值认不出（不是 true/false）：按暂停办，不切', async () => {
    const s = setup();
    await t.db.insert(settings).values({ key: 'engine.soloPaused', value: '开' });
    expect(await s.orgSwitch.now({ by: '被拒', rejection: rejection(s.now()) })).toBeNull();
    expect(s.logs.join('\n')).toContain('认不出，按暂停办');
  });

  describe('整池暂停开关（#746，设置 engine.poolHolds）：切号照它整池避开，读不出按暂停办并报警，到期标红不自动撤', () => {
    const hold = (over: Record<string, unknown> = {}) => ({
      reason: '创始人要大用独享',
      decidedBy: '「法国暂时不用独享号」2026-09-27',
      revokeWhen: '创始人说可以用了',
      reviewBy: '2026-10-30',
      ...over,
    });
    const putHolds = (value: unknown) =>
      t.client.query(
        `insert into settings (key, value, updated_by) values ('engine.poolHolds', $1::jsonb, '创始人')
         on conflict (key) do update set value = excluded.value`,
        [JSON.stringify(value)],
      );
    const open = async (key: string) => {
      const a = await alertOf(key);
      return a !== undefined && a.resolvedAt === null;
    };

    it('【故意造出的失败】独享池开关暂停着：拼车被拒也不切过去；撤了开关（删掉那一项）下一次立刻就切', async () => {
      const s = setup();
      await putHolds({ 'claude-solo': hold() });
      expect(await s.orgSwitch.now({ by: '被拒', rejection: rejection(s.now()) })).toBeNull();
      expect(s.helperCalls).toEqual([]);
      expect(s.logs.join('\n')).toContain('独享账号不可用');
      await putHolds({});
      expect(await s.orgSwitch.now({ by: '被拒', rejection: rejection(s.now()) })).toBe('solo');
    });

    it('【故意造出的失败】开关缺字段（读不出）：这个池照样按暂停办、不切；报「要人看」；补全了自己撤', async () => {
      const s = setup();
      await putHolds({ 'claude-solo': hold({ reviewBy: undefined }) });
      expect(await s.orgSwitch.now({ by: '被拒', rejection: rejection(s.now()) })).toBeNull();
      expect(s.helperCalls).toEqual([]);
      expect(await open(ORG_POOL_HOLD_ALERT)).toBe(true);
      expect((await alertOf(ORG_POOL_HOLD_ALERT))?.body).toContain('claude-solo');
      await putHolds({ 'claude-solo': hold() });
      await s.orgSwitch.now({ by: '被拒', rejection: rejection(s.now()) });
      expect(await open(ORG_POOL_HOLD_ALERT)).toBe(false);
    });

    it('【故意造出的失败】整份设置认不出（不是对象）：所有池按暂停办、不切，报警', async () => {
      const s = setup();
      await putHolds('停');
      expect(await s.orgSwitch.now({ by: '被拒', rejection: rejection(s.now()) })).toBeNull();
      expect(s.helperCalls).toEqual([]);
      expect(await open(ORG_POOL_HOLD_ALERT)).toBe(true);
    });

    it('【故意造出的失败】过了复查日期还开着：报「到期」但不自动撤（开关还在、照样不切）；人改了日期续期才撤掉这条提醒', async () => {
      const s = setup();
      const yesterday = beijingDateOf(new Date(s.now().getTime() - 24 * H));
      await putHolds({ 'claude-solo': hold({ reviewBy: yesterday }) });
      expect(await s.orgSwitch.now({ by: '被拒', rejection: rejection(s.now()) })).toBeNull();
      expect(await open(ORG_POOL_HOLD_OVERDUE_ALERT)).toBe(true);
      expect((await alertOf(ORG_POOL_HOLD_OVERDUE_ALERT))?.body).toContain('不会自动撤');
      const left = await t.client.query<{ value: object }>(
        `select value from settings where key = 'engine.poolHolds'`,
      );
      expect(Object.keys(left.rows[0]?.value ?? {})).toEqual(['claude-solo']);
      await putHolds({
        'claude-solo': hold({ reviewBy: beijingDateOf(new Date(s.now().getTime() + 30 * 24 * H)) }),
      });
      await s.orgSwitch.now({ by: '被拒', rejection: rejection(s.now()) });
      expect(await open(ORG_POOL_HOLD_OVERDUE_ALERT)).toBe(false);
    });
  });

  describe('额度留量线（#194 方案 4.8）：线只来自库里（种子装的），引擎、驾驶舱读同一份', () => {
    const reserveAlert = () => alertOf(ORG_RESERVE_ALERT);
    /** 把独享池的周窗读数改成这个已用比例（读成的时刻是假钟的现在，算新读数）。 */
    const soloWeek = async (s: { now: () => Date }, used: number) => {
      const at = new Date(s.now().getTime() - MIN).toISOString();
      await savePoolQuota(
        t.db,
        {
          poolId: 'claude-solo',
          readAt: at,
          complete: true,
          windows: [
            {
              poolId: 'claude-solo',
              window: '7d',
              label: 'seven_day',
              unit: 'percent',
              utilization: used,
              reading: 'measured',
              readAt: at,
              source: 'test',
            },
          ],
        },
        { now: s.now() },
      );
    };
    const setLines = (value: unknown) =>
      t.client.query(`update settings set value = $1::jsonb where key = 'engine.quotaReserve'`, [
        JSON.stringify(value),
      ]);

    it('种子装进库的线是 5 小时窗 0.8、周窗 0.7（来自种子文件，不是代码常量）', async () => {
      const { rows } = await t.client.query<{ value: unknown; updated_by: string }>(
        `select value, updated_by from settings where key = 'engine.quotaReserve'`,
      );
      expect(rows[0]).toEqual({
        value: { 'claude-solo': { '5h': 0.8, '7d': 0.7 } },
        updated_by: 'seed:quota-reserve.default.json',
      });
    });

    it('【故意造出的失败】独享周窗已用 75%、线 70%：拼车被拒也不切，帮手不调，「留量线」进操作记录；创始人把线调到 90% 就切', async () => {
      const s = setup();
      await soloWeek(s, 0.75);
      expect(await s.orgSwitch.now({ by: '被拒', rejection: rejection(s.now()) })).toBeNull();
      expect(s.helperCalls).toEqual([]);
      expect((await newAudits('session-org.note')).map((n) => n.reason).join('')).toContain('留量线');
      expect(s.logs.join('\n')).toContain('独享到了留量线');
      await setLines({ 'claude-solo': { '5h': 0.8, '7d': 0.9 } });
      expect(await s.orgSwitch.now({ by: '被拒', rejection: rejection(s.now()) })).toBe('solo');
    });

    it('线清成「不限」（null）或这个池没写：独享用到 99% 也照切', async () => {
      const s = setup();
      await soloWeek(s, 0.99);
      await setLines({ 'claude-solo': { '7d': null } });
      expect(await s.orgSwitch.now({ by: '被拒', rejection: rejection(s.now()) })).toBe('solo');
    });

    it('【故意造出的失败】库里没有留量线这一行（种子没装上）：不切，报「要人看」，不当成不限；装上了自己撤', async () => {
      const s = setup();
      await t.client.query(`delete from settings where key = 'engine.quotaReserve'`);
      expect(await s.orgSwitch.now({ by: '被拒', rejection: rejection(s.now()) })).toBeNull();
      expect(s.helperCalls).toEqual([]);
      expect(await reserveAlert()).toMatchObject({ level: 'alert', resolvedAt: null });
      expect((await reserveAlert())?.body).toContain('在库里没有');
      // 选路同样不派（每个池都硬挡，写明原因）
      const picked = await s.pick();
      expect(picked.ok).toBe(false);
      await setLines({});
      await t.client.query(
        `insert into settings (key, value) values ('engine.quotaReserve', '{}'::jsonb) on conflict do nothing`,
      );
      expect(await s.orgSwitch.now({ by: '被拒', rejection: rejection(s.now()) })).toBe('solo');
      expect((await reserveAlert())?.resolvedAt).not.toBeNull();
    });

    it('【故意造出的失败】线是负数 / 大于 1 / 字符串 / 整份不是对象：不切、报「要人看」，不当成不限也不当成 0', async () => {
      const s = setup();
      for (const bad of [
        { 'claude-solo': { '7d': -0.5 } },
        { 'claude-solo': { '7d': 1.5 } },
        { 'claude-solo': { '7d': 'x' } },
        'on',
      ]) {
        await setLines(bad);
        expect(
          await s.orgSwitch.now({ by: '被拒', rejection: rejection(s.now()) }),
          JSON.stringify(bad),
        ).toBeNull();
        expect(await reserveAlert()).toMatchObject({ level: 'alert', resolvedAt: null });
      }
      expect(s.helperCalls).toEqual([]);
    });

    it('读不到独享的周窗读数（额度未知）：照切，切之前不拿空冒充「没到线」，原因里写明', async () => {
      const s = setup();
      await t.client.query(`delete from quota_windows where pool_id = 'claude-solo' and label = 'seven_day'`);
      expect(await s.orgSwitch.now({ by: '被拒', rejection: rejection(s.now()) })).toBe('solo');
      const [switched] = await newAudits('session-org.switch');
      expect(switched?.reason).toContain('额度未知');
    });

    it('第 17 条：切过去以后第一条读数说独享周窗 75%（线 70%）→ 选路不再派独享；调高线马上又能派', async () => {
      const s = setup();
      expect(await s.orgSwitch.now({ by: '被拒', rejection: rejection(s.now()) })).toBe('solo');
      expect(await s.pick()).toMatchObject({ ok: true, route: { routeId: 'solo' } });
      await soloWeek(s, 0.75);
      const blocked = await s.pick();
      expect(blocked.ok ? blocked.route.routeId : 'wait').not.toBe('solo');
      await setLines({ 'claude-solo': { '5h': 0.8, '7d': 0.9 } });
      expect(await s.pick()).toMatchObject({ ok: true, route: { routeId: 'solo' } });
    });

    it('【故意造出的失败】库里没有留量线时选路一个池都不派，不悄悄当成不限', async () => {
      const s = setup();
      await t.client.query(`delete from settings where key = 'engine.quotaReserve'`);
      expect(await s.pick()).toMatchObject({ ok: false });
    });
  });

  it('【故意造出的失败】切号账本认不出：不切、报「要人看」，不当成空账本；修好了自己撤', async () => {
    const s = setup();
    await saveOrgState(t.db, USER, { v: 99, garbage: true }, s.now());
    expect(await s.orgSwitch.now({ by: '被拒', rejection: rejection(s.now()) })).toBeNull();
    expect(s.helperCalls).toEqual([]);
    expect(await alertOf(ORG_LEDGER_ALERT)).toMatchObject({ level: 'alert', resolvedAt: null });
    await saveOrgState(t.db, USER, serializeLedger(emptyLedger()), s.now());
    expect(await s.orgSwitch.now({ by: '被拒', rejection: rejection(s.now()) })).toBe('solo');
    expect((await alertOf(ORG_LEDGER_ALERT))?.resolvedAt).not.toBeNull();
  });

  it('【故意造出的失败】帮手切号失败：账本记着失败时刻，2 分钟内再来不砸帮手，过了才再试', async () => {
    let fail = true;
    const resetsAt = new Date(NOW.getTime() + 2 * H);
    const s = setup({
      // 接口一直说本人额度到顶：拼车用不了的条件一直在，每次判都想切
      api: (at) => fullRead(at, resetsAt),
      helper: async (to) => {
        if (fail) {
          return { ok: false, code: 'failed', exitCode: 1, now: 'carpool', detail: '没切成' };
        }
        s.rig.answer(to);
        return { ok: true, changed: true };
      },
    });
    await s.orgSwitch.now({ by: '被拒', rejection: rejection(s.now()) });
    expect(s.helperCalls).toEqual(['solo']);
    s.advance(MIN);
    fail = false;
    await s.orgSwitch.now({ by: '定时读接口' });
    expect(s.helperCalls).toEqual(['solo']);
    expect(s.logs.join('\n')).toContain('退避');
    s.advance(2 * MIN);
    expect(await s.orgSwitch.now({ by: '定时读接口' })).toBe('solo');
    expect(s.helperCalls).toEqual(['solo', 'solo']);
  });

  describe('切之前逐个查账号状态（创始人 2026-10-04 约 22:30）', () => {
    it('【故意造出的失败】独享账号被封（接口说没分到账号）、拼车 1 个可用：不切；状态记「只剩 1 个」，拼车照派', async () => {
      const s = setup({ api: (at) => withAccounts(at, { carpool: true, solo: false }) });
      expect(await s.orgSwitch.now({ by: '被拒', rejection: rejection(s.now()) })).toBeNull();
      expect(s.helperCalls).toEqual([]);
      expect(s.logs.join('\n')).toContain('只剩 1 个可用账号');
      expect((await newAudits('session-org.channel')).map((a) => a.after)).toEqual([{ state: 'single' }]);
      // 唯一可用的就是挂着的拼车：没有异常，不推提醒
      expect(await alertOf(ORG_CHANNEL_ALERT)).toBeUndefined();
    });

    it('【故意造出的失败】拼车账号被封、独享 1 个可用、挂着拼车：不自动切，推「要人看」', async () => {
      const s = setup({ api: (at) => withAccounts(at, { carpool: false, solo: true }) });
      expect(await s.orgSwitch.now({ by: '被拒', rejection: rejection(s.now()) })).toBeNull();
      expect(s.helperCalls).toEqual([]);
      const alarm = await alertOf(ORG_CHANNEL_ALERT);
      expect(alarm).toMatchObject({ level: 'alert', resolvedAt: null });
      expect(alarm?.title).toContain('只剩 1 个可用账号');
    });

    it('【故意造出的失败】两边账号都被封（可用 0 个）：渠道不可用——不切、提醒、操作记录失败一笔、选路不往 Claude 池派；恢复后自己撤', async () => {
      let api = (at: Date) => withAccounts(at, { carpool: false, solo: false });
      const s = setup({ api: (at) => api(at) });
      expect(await s.orgSwitch.now({ by: '被拒', rejection: rejection(s.now()) })).toBeNull();
      expect(s.helperCalls).toEqual([]);
      const alarm = await alertOf(ORG_CHANNEL_ALERT);
      expect(alarm).toMatchObject({ level: 'alert', resolvedAt: null });
      expect(alarm?.title).toContain('渠道不可用');
      const [down] = await newAudits('session-org.channel');
      expect(down).toMatchObject({ ok: false, after: { state: 'unavailable' } });
      expect(down?.error).toContain('渠道不可用');
      const picked = await s.pick();
      expect(picked.ok).toBe(false);
      expect(!picked.ok && picked.detail).toContain('渠道不可用');

      // 账号恢复：状态自动恢复、提醒自己撤、记一笔
      api = healthyRead;
      s.advance(MIN);
      await s.orgSwitch.now({ by: '定时读接口' });
      expect((await alertOf(ORG_CHANNEL_ALERT))?.resolvedAt).not.toBeNull();
      expect((await newAudits('session-org.channel')).map((a) => a.after)).toEqual([
        { state: 'unavailable' },
        { state: 'ok' },
      ]);
    });

    it('【故意造出的失败】读不到账号状态（接口 503）：不切；刚读不到不报警，读不到满 15 分钟才报；不当成可用', async () => {
      const s = setup({
        api: (at) => ({ ok: false, requestedAt: at, code: 'http', why: '503' }),
      });
      expect(await s.orgSwitch.now({ by: '被拒', rejection: rejection(s.now()) })).toBeNull();
      expect(s.helperCalls).toEqual([]);
      expect(s.logs.join('\n')).toContain('读不到状态');
      expect(await alertOf(ORG_CHANNEL_ALERT)).toBeUndefined();
      s.advance(16 * MIN);
      await s.orgSwitch.now({ by: '定时读接口' });
      expect(s.helperCalls).toEqual([]);
      expect((await alertOf(ORG_CHANNEL_ALERT))?.title).toContain('读不到 Claude 账号的状态');
    });

    it('【故意造出的失败】接口读成了但没有账号清单（组织接口没读成）：当读不到状态，不切', async () => {
      const s = setup({
        api: (at) => {
          const r = healthyRead(at);
          return r.ok ? { ...r, org: 'unknown', accounts: undefined as never } : r;
        },
      });
      expect(await s.orgSwitch.now({ by: '被拒', rejection: rejection(s.now()) })).toBeNull();
      expect(s.helperCalls).toEqual([]);
    });
  });

  it('切回有宽限：恢复了先停派独享、开跑不到 5 分钟的当场停；老的跑完（或宽限到点）才切回拼车', async () => {
    // 挂着独享、账本里记着一小时前拼车本人额度用满（半小时前就该恢复）
    await saveOrgState(
      t.db,
      USER,
      serializeLedger({
        ...emptyLedger(),
        outage: {
          kind: 'E1',
          since: new Date(NOW.getTime() - 60 * MIN),
          resetsAt: new Date(NOW.getTime() - 30 * MIN),
          resetsFrom: 'api',
          evidence: '接口说本人额度到顶',
        },
        onSoloSince: new Date(NOW.getTime() - 59 * MIN),
      }),
      NOW,
    );
    const old = await running('solo', new Date(NOW.getTime() - 20 * MIN), { started: true });
    const young = await running('solo', new Date(NOW.getTime() - MIN), { started: true });
    const fake = fakeSessions([
      { id: old.id, poolId: 'claude-solo' },
      { id: young.id, poolId: 'claude-solo' },
    ]);
    const s = setup({ sessions: fake.sessions });
    s.rig.answer('solo');
    // 第一次新读数说恢复了：还要隔一分钟的第二次确认，不切、不停
    expect(await s.orgSwitch.now({ by: '定时读接口' })).toBeNull();
    expect(fake.stops).toEqual([]);
    // 第二次也说恢复了：进宽限——只停开跑不到 5 分钟的，老的接着跑；帮手还没调
    s.advance(2 * MIN);
    expect(await s.orgSwitch.now({ by: '定时读接口' })).toBeNull();
    expect(s.helperCalls).toEqual([]);
    expect(fake.stops).toHaveLength(1);
    expect(fake.stops[0]?.stopped).toEqual([young.id]);
    const [drainRow] = await newAudits('session-org.drain');
    expect(drainRow?.reason).toContain('先停下了 1 个');
    // 宽限中：选路不往独享派新活（写明在切回的宽限中）
    const during = await s.pick();
    expect(during.ok).toBe(false);
    expect(!during.ok && during.detail).toContain('宽限');
    // 宽限里老的跑完了：手上空了，马上切回拼车、当场探通
    await old(s.now());
    await young(s.now());
    s.advance(3 * MIN);
    expect(await s.orgSwitch.now({ by: '定时读接口' })).toBe('carpool');
    expect(s.helperCalls).toEqual(['carpool']);
    expect(await row('carpool')).toMatchObject({ alive: true, probeState: 'ok' });
    expect(await s.pick()).toMatchObject({ ok: true, route: { routeId: 'carpool' } });
  });

  it('切回宽限到点（10 分钟）老会话还没完：停下、切回拼车，各自在拼车上接着干', async () => {
    await saveOrgState(
      t.db,
      USER,
      serializeLedger({
        ...emptyLedger(),
        outage: {
          kind: 'E1',
          since: new Date(NOW.getTime() - 60 * MIN),
          resetsAt: new Date(NOW.getTime() - 30 * MIN),
          resetsFrom: 'api',
          evidence: '接口说本人额度到顶',
        },
        onSoloSince: new Date(NOW.getTime() - 59 * MIN),
      }),
      NOW,
    );
    const old = await running('solo', new Date(NOW.getTime() - 20 * MIN), { started: true });
    const fake = fakeSessions([{ id: old.id, poolId: 'claude-solo' }]);
    const s = setup({ sessions: fake.sessions });
    s.rig.answer('solo');
    await s.orgSwitch.now({ by: '定时读接口' });
    s.advance(2 * MIN);
    await s.orgSwitch.now({ by: '定时读接口' });
    expect(s.helperCalls).toEqual([]);
    s.advance(5 * MIN);
    await s.orgSwitch.now({ by: '定时读接口' });
    expect(s.helperCalls).toEqual([]);
    // 宽限从判恢复那一刻起算，到点还没完：停下 + 切回
    s.advance(6 * MIN);
    expect(await s.orgSwitch.now({ by: '定时读接口' })).toBe('carpool');
    expect(s.helperCalls).toEqual(['carpool']);
    expect(fake.stops.flatMap((x) => x.stopped)).toEqual([old.id]);
  });
});

describe('读接口的节奏（#194 方案 4.1）：切号前后各现读一次、退避期不砸接口、上限变了和进退避记一笔', () => {
  const USER = 'fleet-agent-carpool';
  const failedRead = (at: Date, code: 'throttled' | 'http' | 'network' = 'throttled'): CarpoolApiRead => ({
    ok: false,
    requestedAt: at,
    code,
    why: code === 'throttled' ? 'HTTP 429' : 'HTTP 503',
  });
  /** 账本里先放几条读数（接口那边的历史）。 */
  const seed = (reads: CarpoolApiRead[], at: Date) =>
    saveOrgState(t.db, USER, serializeLedger({ ...emptyLedger(), reads }), at);
  const full = (at: Date) => fullRead(at, new Date(at.getTime() + 2 * H));
  const counting = (make: (at: Date) => CarpoolApiRead) => {
    const state = { calls: 0 };
    return {
      state,
      api: (at: Date) => {
        state.calls += 1;
        return make(at);
      },
    };
  };

  it('切号前现读一次：手上的读数是旧的、说用满，新读数说有余额——重判后不切（不凭旧读数动手）', async () => {
    const c = counting(healthyRead);
    const s = setup({ api: c.api });
    const stale = full(new Date(s.now().getTime() - 60_000));
    expect(await s.orgSwitch.now({ by: '定时读接口', read: stale })).toBeNull();
    expect(c.state.calls).toBe(1);
    expect(s.helperCalls).toEqual([]);
  });

  it('切号前、切完各现读一次：旧读数说用满、新读数还是用满 → 切；这一次一共现读了 2 次（切前 1、切完 1）', async () => {
    const c = counting(full);
    const s = setup({ api: c.api });
    const stale = full(new Date(s.now().getTime() - 60_000));
    expect(await s.orgSwitch.now({ by: '定时读接口', read: stale })).toBe('solo');
    expect(c.state.calls).toBe(2);
  });

  it('刚读过（几秒内）的不为了「切前现读」再砸一次：只有切完那 1 次', async () => {
    const c = counting(full);
    const s = setup({ api: c.api });
    expect(await s.orgSwitch.now({ by: '定时读接口', read: full(s.now()) })).toBe('solo');
    expect(c.state.calls).toBe(1);
  });

  it('【故意造出失败】退避期里（最近一次读失败不到 1 分钟）：被拒当场判也不去砸接口，按读不到办（账号状态读不到不切）；退避过了才读、才切', async () => {
    const c = counting(healthyRead);
    const s = setup({ api: c.api });
    // 账号清单还是 10 分钟前读成的那份（15 分钟内算数），之后读失败进了退避
    await seed(
      [healthyRead(new Date(s.now().getTime() - 10 * MIN)), failedRead(new Date(s.now().getTime() - 30_000))],
      s.now(),
    );
    await s.orgSwitch.now({
      by: '被拒',
      rejection: { at: s.now(), code: 'quota_exhausted', text: '拼车 5 小时额度已用完，约 120 分钟后重置' },
    });
    expect(c.state.calls).toBe(0);
    // 最近一次读失败 → 账号状态读不到 → 照现有规矩（方案第六节第 1 条）不切、不当成账号可用；退避过了读成了才切
    expect(s.helperCalls).toEqual([]);
    s.advance(2 * MIN);
    await s.orgSwitch.now({
      by: '被拒',
      rejection: { at: s.now(), code: 'quota_exhausted', text: '拼车 5 小时额度已用完，约 120 分钟后重置' },
    });
    expect(c.state.calls).toBeGreaterThan(0);
    expect(s.helperCalls).toEqual(['solo']);
  });

  it('【故意造出失败】退避期里没有被拒、也没有别的证据：不读、不切；退避过了才读', async () => {
    const c = counting(healthyRead);
    const s = setup({ api: c.api });
    await seed([failedRead(new Date(s.now().getTime() - 30_000))], s.now());
    await s.orgSwitch.now({ by: '定时读接口' });
    expect(c.state.calls).toBe(0);
    expect(s.helperCalls).toEqual([]);
    s.advance(2 * MIN);
    await s.orgSwitch.now({ by: '定时读接口' });
    expect(c.state.calls).toBe(1);
  });

  it('拼车上限变了（80 → 100）：操作记录写一笔「拼车上限从 80 变成 100」；没变不记', async () => {
    const at = (m: number) => new Date(NOW.getTime() + m * MIN);
    const s = setup({
      api: (when) => {
        const r = healthyRead(when);
        return r.ok && when.getTime() >= at(10).getTime()
          ? { ...r, quota: { ...(r.quota as NonNullable<typeof r.quota>), limitUsd: 100 } }
          : r;
      },
    });
    await seed([healthyRead(at(-10))], s.now());
    s.advance(10 * MIN - 1);
    await s.orgSwitch.now({ by: '定时读接口' });
    expect(await newAudits('session-org.limit')).toEqual([]);
    s.advance(MIN);
    await s.orgSwitch.now({ by: '定时读接口' });
    const [note] = await newAudits('session-org.limit');
    expect(note?.reason).toContain('拼车上限从 80 变成 100');
    expect(note).toMatchObject({ ok: true, before: { limitUsd: 80 }, after: { limitUsd: 100 } });
  });

  it('【故意造出失败】接口 429：进退避，操作记录记一笔（第 1 次、等 1 分钟），不是静默', async () => {
    const s = setup({ api: (at) => failedRead(at) });
    await s.orgSwitch.now({ by: '定时读接口' });
    const [note] = await newAudits('session-org.read-backoff');
    expect(note).toMatchObject({ ok: false, after: { fails: 1, waitMinutes: 1, code: 'throttled' } });
    expect(note?.reason).toContain('429');
  });
});
