// 会话用户切号要看的（sessionOrgFacts）和要记的（recordEngineAudit），#157：带组织类型的池各自的额度窗口（和选路同一个判法，
// 只算管得着在用路由的窗口）、这些池上还没结束的会话；切号、核对进操作记录，没成的必须写为什么。
import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { startRun } from '../src/queries/runs.ts';
import { openOrgRuns, recordEngineAudit, sessionOrgFacts } from '../src/queries/session-org.ts';
import { auditLog, pools } from '../src/schema/index.ts';
import { createTestDb, resetTestDb, TEST_DB_TIMEOUT_MS, type TestDb } from '../src/testing.ts';
import {
  addRepo,
  addRoute,
  addRun,
  addTask,
  addWindow,
  ago,
  catalog,
  HOUR,
  later,
  MIN,
  NOW,
  setRoutingLayers,
} from './helpers.ts';

let t: TestDb;
beforeAll(async () => {
  t = await createTestDb();
}, TEST_DB_TIMEOUT_MS);
afterAll(() => t.close());
beforeEach(async () => {
  await resetTestDb(t);
  await catalog(t.db);
  await t.db.insert(pools).values([
    {
      id: 'claude-carpool',
      channelId: 'claude-subscription',
      maxConcurrency: 3,
      runAsUser: 'fleet-agent-carpool',
      orgKind: 'carpool',
    },
    {
      id: 'claude-solo',
      channelId: 'claude-subscription',
      maxConcurrency: 3,
      runAsUser: 'fleet-agent-carpool',
      orgKind: 'solo',
    },
  ]);
  for (const [id, poolId] of [
    ['car', 'claude-carpool'],
    ['solo', 'claude-solo'],
  ] as const) {
    await addRoute(t.db, {
      id,
      channelId: 'claude-subscription',
      poolId,
      modelId: 'opus-5.5',
      upstreamModel: 'claude-opus-5-5',
    });
  }
  await addRoute(t.db, { id: 'relay-opus', poolId: 'relay-a', modelId: 'opus-5.5', hostId: 'mirasim' });
  await setRoutingLayers(t.db, {
    purposes: { execute: ['opus-5.5'] },
    models: { 'opus-5.5': ['car', 'solo', 'relay-opus'] },
  });
});

const fresh = { reading: 'measured', readAt: ago(MIN) } as const;
const labels = (f: Awaited<ReturnType<typeof sessionOrgFacts>>, poolId: string) =>
  f.pools.find((p) => p.poolId === poolId)?.windows.map((w) => w.label);

describe('sessionOrgFacts：带组织类型的池、它们的额度窗口、还没结束的会话', () => {
  it('只列带组织类型的池（按 id 排）；窗口的状态和选路同一个判法，另带「读数本身说到顶了」', async () => {
    await addWindow(t.db, {
      poolId: 'claude-carpool',
      window: '5h',
      label: 'five_hour',
      upstreamStatus: 'limit_reached',
      resetsAt: later(2 * HOUR),
      ...fresh,
    });
    await addWindow(t.db, {
      poolId: 'claude-solo',
      window: '5h',
      label: 'five_hour',
      utilization: 0.3,
      ...fresh,
    });
    await addWindow(t.db, { poolId: 'relay-a', window: '7d', utilization: 1, ...fresh });
    const f = await sessionOrgFacts(t.db, { now: NOW });
    expect(f.pools.map((p) => [p.poolId, p.orgKind])).toEqual([
      ['claude-carpool', 'carpool'],
      ['claude-solo', 'solo'],
    ]);
    expect(f.pools[0]?.windows).toEqual([
      { label: 'five_hour', state: 'exhausted', full: true, resetsAt: later(2 * HOUR) },
    ]);
    expect(f.pools[1]?.windows).toEqual([{ label: 'five_hour', state: 'ok', full: false, resetsAt: null }]);
    expect(f.busy).toBe(0);
  });

  it('读数旧了：状态是 stale（选路算「不知道」），可「到顶了」照实给（切号靠它判拼车恢复没有）', async () => {
    await addWindow(t.db, {
      poolId: 'claude-carpool',
      window: '5h',
      label: 'five_hour',
      upstreamStatus: 'limit_reached',
      reading: 'measured',
      readAt: ago(2 * HOUR),
    });
    const f = await sessionOrgFacts(t.db, { now: NOW });
    expect(f.pools[0]?.windows).toEqual([{ label: 'five_hour', state: 'stale', full: true, resetsAt: null }]);
  });

  it('按模型组扣的窗口：只算扣得着在用路由的（只扣 Sonnet 的不算，扣 Opus 的算）；上游不再报的，除非还用满着，不算', async () => {
    await addWindow(t.db, {
      poolId: 'claude-carpool',
      window: '7d_model',
      scope: 'sonnet',
      utilization: 1,
      ...fresh,
    });
    await addWindow(t.db, {
      poolId: 'claude-carpool',
      window: '7d_model',
      scope: 'opus',
      utilization: 0.5,
      ...fresh,
    });
    await addWindow(t.db, {
      poolId: 'claude-carpool',
      window: '7d',
      utilization: 0.2,
      staleSince: ago(MIN),
      ...fresh,
    });
    await addWindow(t.db, {
      poolId: 'claude-carpool',
      window: '5h',
      upstreamStatus: 'limit_reached',
      resetsAt: later(HOUR),
      staleSince: ago(MIN),
      ...fresh,
    });
    const f = await sessionOrgFacts(t.db, { now: NOW });
    expect(labels(f, 'claude-carpool')).toEqual(['5h', '7d_model_opus']);
  });

  it('池没有在用的路由：按模型组扣的窗口一个都不算，不分模型的照算', async () => {
    await t.client.query(`update routing_catalog set enabled = false where route_id = 'car'`);
    await addWindow(t.db, {
      poolId: 'claude-carpool',
      window: '7d_model',
      scope: 'opus',
      utilization: 1,
      ...fresh,
    });
    await addWindow(t.db, { poolId: 'claude-carpool', window: '5h', utilization: 0.1, ...fresh });
    expect(labels(await sessionOrgFacts(t.db, { now: NOW }), 'claude-carpool')).toEqual(['5h']);
  });

  it('还没结束的会话：只数带组织类型的池上的（排着的、在跑的都算），结束了的、别的池上的不算', async () => {
    const repo = await addRepo(t.db);
    const task = await addTask(t.db, repo.id);
    const queued = await addRun(t.db, { taskId: task.id, routeId: 'car', queuedAt: ago(5 * MIN) });
    const running = await addRun(t.db, { taskId: task.id, routeId: 'solo', startedAt: ago(10 * MIN) });
    await addRun(t.db, {
      taskId: task.id,
      routeId: 'solo',
      startedAt: ago(20 * MIN),
      endedAt: ago(MIN),
      outcome: 'ok',
    });
    await addRun(t.db, { taskId: task.id, routeId: 'relay-opus' });
    expect(await sessionOrgFacts(t.db, { now: NOW })).toMatchObject({ busy: 2, busyOneShot: 0 });
    // 切号前停会话时一轮轮看的就是这几个（#59）：按排队时刻排，分得清还在起的（没开工）和在跑的
    expect(await openOrgRuns(t.db)).toEqual([
      {
        runId: running.id,
        poolId: 'claude-solo',
        kind: 'session',
        queuedAt: running.queuedAt,
        startedAt: running.startedAt,
      },
      {
        runId: queued.id,
        poolId: 'claude-carpool',
        kind: 'session',
        queuedAt: queued.queuedAt,
        startedAt: null,
      },
    ]);
  });

  it('三段的一次性会话（runs 里开跑就留的那一行，#157）也数：只数带组织类型的池上、还没结束的；连不到路由的数不着', async () => {
    const repo = await addRepo(t.db);
    const task = await addTask(t.db, repo.id);
    const fusion = await addRun(t.db, { taskId: task.id, routeId: 'solo', startedAt: ago(30 * MIN) });
    const oneShot = randomUUID();
    await startRun(t.db, {
      id: oneShot,
      segment: 'manual',
      model: 'opus-5.5',
      routeId: 'car',
      startedAt: ago(5 * MIN),
    });
    // 收了场的、别的池上的、没写路由的（老行）：都不算
    await startRun(t.db, {
      segment: 'verify',
      model: 'opus-5.5',
      routeId: 'car',
      startedAt: ago(20 * MIN),
      endedAt: ago(MIN),
      outcome: 'done',
    });
    await startRun(t.db, {
      segment: 'manual',
      model: 'opus-5.5',
      routeId: 'relay-opus',
      startedAt: ago(MIN),
    });
    await startRun(t.db, { segment: 'manual', model: 'opus-5.5', startedAt: ago(MIN) });
    expect(await sessionOrgFacts(t.db, { now: NOW })).toMatchObject({ busy: 2, busyOneShot: 1 });
    expect(await openOrgRuns(t.db)).toEqual([
      {
        runId: fusion.id,
        poolId: 'claude-solo',
        kind: 'session',
        queuedAt: fusion.queuedAt,
        startedAt: fusion.startedAt,
      },
      {
        runId: oneShot,
        poolId: 'claude-carpool',
        kind: 'oneShot',
        queuedAt: ago(5 * MIN),
        startedAt: ago(5 * MIN),
      },
    ]);
    // 收场补完那一行（同一个编号）：不再算
    await startRun(t.db, {
      id: oneShot,
      segment: 'manual',
      model: 'opus-5.5',
      routeId: 'car',
      startedAt: ago(5 * MIN),
      endedAt: NOW,
      outcome: 'failed',
    });
    expect(await sessionOrgFacts(t.db, { now: NOW })).toMatchObject({ busy: 1, busyOneShot: 0 });
  });

  it('库里没有带组织类型的池：空的，会话照数', async () => {
    await t.client.query(`delete from routing_catalog where route_id in ('car', 'solo')`);
    await t.client.query(`delete from routes where id in ('car', 'solo')`);
    await t.client.query(`delete from pools where org_kind is not null`);
    expect(await sessionOrgFacts(t.db, { now: NOW })).toEqual({ pools: [], busy: 0, busyOneShot: 0 });
  });
});

describe('recordEngineAudit：引擎做的事进操作记录', () => {
  it('成的、没成的各一条：谁做的、对谁、前后、为什么、错在哪', async () => {
    await recordEngineAudit(t.db, {
      action: 'session-org.switch',
      target: 'session-user:fleet-agent-carpool',
      actorId: 'engine:org-switch',
      before: { org: 'carpool' },
      after: { org: 'solo' },
      reason: '拼车额度用满了',
      ok: true,
      at: NOW,
    });
    await recordEngineAudit(t.db, {
      action: 'session-org.verify',
      target: 'session-user:fleet-agent-carpool',
      actorId: 'engine:org-switch',
      after: { org: 'solo' },
      ok: false,
      error: '独享池的路由一条都没探通',
      at: NOW,
    });
    const rows = (await t.db.select().from(auditLog)).sort((a, b) => a.id - b.id);
    expect(
      rows.map((r) => [r.actorKind, r.via, r.actorId, r.action, r.before, r.after, r.reason, r.ok, r.error]),
    ).toEqual([
      [
        'engine',
        'engine',
        'engine:org-switch',
        'session-org.switch',
        { org: 'carpool' },
        { org: 'solo' },
        '拼车额度用满了',
        true,
        null,
      ],
      [
        'engine',
        'engine',
        'engine:org-switch',
        'session-org.verify',
        null,
        { org: 'solo' },
        null,
        false,
        '独享池的路由一条都没探通',
      ],
    ]);
  });

  it('【故意造出的失败】没成却没写为什么：拒写，说清是哪一条', async () => {
    await expect(
      recordEngineAudit(t.db, {
        action: 'session-org.switch',
        target: 'session-user:fleet-agent-carpool',
        actorId: 'engine:org-switch',
        ok: false,
        error: '  ',
      }),
    ).rejects.toThrow('操作记录 session-org.switch 没成却没写为什么');
    expect(await t.db.select().from(auditLog)).toEqual([]);
  });
});
