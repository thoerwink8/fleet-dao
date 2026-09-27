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
  finishSessionRun,
  markSessionRunStarted,
  notifications,
  openSessionRun,
  routes,
  savePoolQuota,
  upsertAlert,
} from '@fleet-dao/db';
import { createTestDb, resetTestDb, TEST_DB_TIMEOUT_MS, type TestDb } from '@fleet-dao/db/testing';
import type { OrgKind } from '@fleet-dao/shared';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { runRouteProbeJob } from '../../src/jobs/route-probe.ts';
import { registerEngineJobs } from '../../src/real/jobs.ts';
import {
  ORG_STUCK_ALERT,
  ORG_SWITCH_ALERT,
  ORG_VERIFY_ALERT,
  orgSwitchRound,
} from '../../src/real/org-switch.ts';
import { routeProbeJob } from '../../src/real/route-probe.ts';
import type { OrgSwitchSessions } from '../../src/real/sessions.ts';
import { createStorePorts, poolHoldKey } from '../../src/real/store-ports.ts';
import {
  addTask,
  CARPOOL_ORG_ID,
  type FakeRunScript,
  fakeRun,
  fakeTrees,
  MIN,
  NOW,
  orgListRig,
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
  // 真实的样子：独享池挂在独享组织上、拼车池挂在拼车组织上
  await t.client.query("update pools set org_kind = 'solo' where id = 'claude-solo'");
  await registerEngineJobs(t.db);
  root = mkdtempSync(join(tmpdir(), 'fleet-org-switch-'));
});
afterEach(() => rmSync(root, { recursive: true, force: true }));

const H = 60 * MIN;
const answered = (): FakeRunScript => ({ result: { text: 'OK' } });

function setup(
  over: {
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
  const org = rig.reader({ ttlMs: 30_000, now });
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
  await openSessionRun(t.db, {
    id,
    taskId: task.id,
    subtaskId: null,
    stage: 'execute',
    routeId,
    whyRoute: '占位',
    branch: null,
    queuedAt: at,
    workflowId: null,
    runAsUser: 'fleet-agent-carpool',
    worktreePath: null,
  });
  if (options.started) {
    await markSessionRunStarted(t.db, { id, startedAt: at, sessionId: randomUUID(), handle: null });
  }
  return Object.assign(
    async (endedAt: Date) => {
      await finishSessionRun(t.db, { id, outcome: 'ok', endedAt });
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
    stop(poolIds, why) {
      const stopped: string[] = [];
      for (const [id, s] of state) {
        if (!poolIds.has(s.poolId) || s.stoppedAtPoll >= 0) continue;
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

const audits = async () =>
  (await t.db.select().from(auditLog))
    .filter((a) => a.action.startsWith('session-org.'))
    .sort((a, b) => a.id - b.id)
    .map((a) => ({ action: a.action, ok: a.ok, before: a.before, after: a.after, error: a.error }));
const alertOf = async (key: string) =>
  (await t.db.select().from(notifications)).find((n) => n.dedupeKey === key);
const row = async (id: string) => (await t.db.select().from(routes)).find((r) => r.id === id);

describe('全程：拼车被拒 → 等到没有在跑的会话 → 切独享 → 读回在线 → 到恢复时刻 → 空着时切回 → 读回在线', () => {
  it('操作记录里切号、切回、两次核对都在；每次切都是在没有会话的时候；切完选路跟着走', async () => {
    const s = setup();
    // 平时：挂拼车、额度宽，不切；拼车池探通，独享池不探
    await s.round();
    expect(s.helperCalls).toEqual([]);
    expect(await row('carpool')).toMatchObject({ alive: true, probeState: 'ok' });
    expect(await row('solo')).toMatchObject({ alive: false, probeState: 'skipped' });

    // 拼车的会话被拒（5 小时窗口，2 小时后清零）；还有一个拼车上的会话没结束
    const resets = new Date(NOW.getTime() + 2 * H);
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
        after: { org: 'carpool' },
        error: null,
      },
      { action: 'session-org.verify', ok: true, before: null, after: { org: 'carpool' }, error: null },
    ]);
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
    expect(alarm?.body).toContain('拼车额度用满了');
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
    expect(s.logs.join('\n')).toContain('独享池整池暂停着');
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
    expect(row?.reason).toContain('切之前停下了 2 个在跑的 Claude 会话，切完各自续上');
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
    expect(attempt?.error).toContain('还有 1 个没收场、0 个还在起，这一轮不切（停下的照样续上）');
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
