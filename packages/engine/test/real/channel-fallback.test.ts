// 渠道运行中失败换同一个模型的下一个渠道（#1118）的选路这一半，接真库（PGlite）：
// 选路带着 failedChannel 来 → 先在 channel_states 标 disabled 写原因，选到别的渠道就记顺到谁；
// disabled 的渠道不被选；全部渠道都不能用就派不出去（停下报人）；channel_states 读不到明确失败，不当成全 ok。
import { randomUUID } from 'node:crypto';
import { readChannelStates, routeProbeAuditRows } from '@fleet-dao/db';
import { createTestDb, resetTestDb, TEST_DB_TIMEOUT_MS, type TestDb } from '@fleet-dao/db/testing';
import { foldRouteProbeRequests } from '@fleet-dao/shared';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import type { FailedChannel, PickRouteInput } from '../../src/ports.ts';
import type { SessionOrgReader } from '../../src/real/session-org.ts';
import { createStorePorts } from '../../src/real/store-ports.ts';
import { NOW, world } from './fixtures.ts';

let t: TestDb;
beforeAll(async () => {
  t = await createTestDb();
}, TEST_DB_TIMEOUT_MS);
afterAll(() => t.close());
beforeEach(async () => {
  await resetTestDb(t);
  await world(t.db);
});

const ctx = { signal: new AbortController().signal, heartbeat() {}, attempt: 1, lastHeartbeat: undefined };
const onCarpool: SessionOrgReader = async () => ({ ok: true, org: 'carpool' });
const ports = () =>
  createStorePorts({ db: t.db, now: () => NOW, draw: () => 0.5, log: () => {}, sessionOrg: onCarpool });
const pick = (over: Partial<PickRouteInput> = {}) =>
  ports().pickRoute(
    {
      taskId: randomUUID(),
      stage: 'triage',
      avoidRouteIds: [],
      avoidPoolIds: [],
      avoidModelIds: [],
      ...over,
    },
    ctx,
  );

/** solo 在 claude-subscription 渠道；让第二条路由（carpool）换到另一个渠道，同一个模型 opus-5.5 就有了两个渠道。 */
const secondChannel = () =>
  t.client.query(`update routes set channel_id = 'mirasim-cloud', pool_id = 'relay' where id = 'carpool'`);

const failed = (over: Partial<FailedChannel> = {}): FailedChannel => ({
  channelId: 'claude-subscription',
  routeId: 'solo',
  modelId: 'opus-5.5',
  reason: '上游断连（已重试 2 次）',
  ...over,
});

const errorChain = async (p: Promise<unknown>): Promise<string> => {
  const err = await p.then(
    () => null,
    (e: unknown) => e,
  );
  const messages: string[] = [];
  for (let e: unknown = err; e instanceof Error; e = e.cause) messages.push(e.message);
  return messages.join('\n');
};

describe('选路：渠道运行中失败换渠道', () => {
  it('派出去的路由带着渠道编号（失败分流要它认是哪个渠道）', async () => {
    expect(await pick()).toMatchObject({
      ok: true,
      route: { routeId: 'solo', channelId: 'claude-subscription' },
    });
  });

  it('带着 failedChannel 来：先标 disabled 写原因，派到同一个模型的下一个渠道，并记下顺到谁', async () => {
    await secondChannel();
    const got = await pick({ failedChannel: failed(), avoidRouteIds: ['solo'] });
    expect(got).toMatchObject({ ok: true, route: { routeId: 'carpool', channelId: 'mirasim-cloud' } });
    const state = (await readChannelStates(t.db)).get('claude-subscription');
    expect(state).toMatchObject({
      status: 'disabled',
      reason: '上游断连（已重试 2 次）',
      failedRouteId: 'solo',
      fallbackChannelId: 'mirasim-cloud',
      fallbackModelId: 'opus-5.5',
    });
  });

  it('标过 disabled 的渠道以后的选路也不选（不用每次都带 failedChannel），别的任务也一样', async () => {
    await secondChannel();
    await pick({ failedChannel: failed(), avoidRouteIds: ['solo'] });
    // 另一张单没避开 solo，选路也不会把 disabled 渠道的 solo 派出去
    expect(await pick()).toMatchObject({ ok: true, route: { routeId: 'carpool' } });
  });

  it('【故意造出的失败】换到的渠道也失败：再带一次 failedChannel，第二个渠道也标 disabled，继续往下（这里没有第三个渠道，派不出）', async () => {
    await secondChannel();
    await pick({ failedChannel: failed(), avoidRouteIds: ['solo'] });
    const next = await pick({
      failedChannel: failed({ channelId: 'mirasim-cloud', routeId: 'carpool', reason: '被拒：429' }),
      avoidRouteIds: ['solo', 'carpool'],
    });
    expect(next).toMatchObject({ ok: false, waitFor: 'none' });
    const states = await readChannelStates(t.db);
    expect(states.get('mirasim-cloud')).toMatchObject({
      status: 'disabled',
      reason: '被拒：429',
      fallbackChannelId: null,
    });
    // 第一个渠道的「顺到谁」还指着它，页面能看出这条链
    expect(states.get('claude-subscription')).toMatchObject({
      status: 'disabled',
      fallbackChannelId: 'mirasim-cloud',
    });
  });

  it('【故意造出的失败】全部渠道都失败：没有别的渠道可顺延，派不出去（waitFor none，原因写明渠道运行中失败），顺到谁留空', async () => {
    const got = await pick({ failedChannel: failed() });
    expect(got).toMatchObject({ ok: false, waitFor: 'none' });
    expect(!got.ok && got.detail).toContain('渠道运行中失败');
    expect((await readChannelStates(t.db)).get('claude-subscription')).toMatchObject({
      status: 'disabled',
      fallbackChannelId: null,
      fallbackModelId: null,
    });
  });

  it('【故意造出的失败】标 disabled 写不进库（原因是空的）：选路抛错，不当成没事接着派', async () => {
    const chain = await errorChain(pick({ failedChannel: failed({ reason: '  ' }) }));
    expect(chain).toContain('没带原因');
    expect((await readChannelStates(t.db)).size).toBe(0);
  });

  it('【故意造出的失败】channel_states 读不到：选路抛错（带表名），不当成全 ok 派出 disabled 的渠道', async () => {
    await t.client.exec('alter table channel_states rename to channel_states_unreadable');
    try {
      expect(await errorChain(pick())).toContain('channel_states');
    } finally {
      await t.client.exec('alter table channel_states_unreadable rename to channel_states');
    }
  });
});

describe('选路：渠道运行中失败后当场排立即探测（#1636）', () => {
  const probeRows = () => routeProbeAuditRows(t.db, new Date(NOW.getTime() - 60 * 60_000));

  it('判了换渠道的失败：排一次 routing.probe.request，点那一条路由、带单号来源、actor 是引擎', async () => {
    await secondChannel();
    const got = await pick({ failedChannel: failed({ issueNumber: 1621 }), avoidRouteIds: ['solo'] });
    expect(got).toMatchObject({ ok: true, route: { routeId: 'carpool' } });
    const rows = await probeRows();
    expect(rows.map((r) => r.action)).toEqual(['routing.probe.request']);
    const { requests } = foldRouteProbeRequests(rows, NOW);
    expect(requests).toHaveLength(1);
    expect(requests[0]).toMatchObject({
      state: 'queued',
      by: 'engine:route-probe-now',
      routeIds: ['solo'],
      source: { kind: 'task-route-broken', issueNumber: 1621 },
    });
  });

  it('同一条路由 10 分钟里又断（另一张单）：不再排', async () => {
    await secondChannel();
    await pick({ failedChannel: failed({ issueNumber: 1621 }), avoidRouteIds: ['solo'] });
    await pick({ failedChannel: failed({ issueNumber: 1622 }), avoidRouteIds: ['solo'] });
    expect(await probeRows()).toHaveLength(1);
  });

  it('不是路由的错（选路没带 failedChannel）：不排；老历史重放没带单号：也不排', async () => {
    await pick();
    await pick({ failedChannel: failed(), avoidRouteIds: ['solo'] });
    expect(await probeRows()).toHaveLength(0);
  });

  it('【故意造出的失败】排探测抛错：选路照样标 disabled、派到下一个渠道，不抛', async () => {
    await secondChannel();
    const logs: string[] = [];
    const broken = createStorePorts({
      db: t.db,
      now: () => NOW,
      draw: () => 0.5,
      log: (m) => logs.push(m),
      sessionOrg: onCarpool,
      scheduleBreakProbe: async () => {
        throw new Error('写不进库');
      },
    });
    const got = await broken.pickRoute(
      {
        taskId: randomUUID(),
        stage: 'triage',
        avoidRouteIds: ['solo'],
        avoidPoolIds: [],
        avoidModelIds: [],
        failedChannel: failed({ issueNumber: 1621 }),
      },
      ctx,
    );
    expect(got).toMatchObject({ ok: true, route: { routeId: 'carpool' } });
    expect((await readChannelStates(t.db)).get('claude-subscription')).toMatchObject({ status: 'disabled' });
    expect(logs.some((m) => m.includes('排立即探测没成'))).toBe(true);
  });
});
