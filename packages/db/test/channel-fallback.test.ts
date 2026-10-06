// 渠道顺延（#1118）：每次尝试落库、渠道运行中失败标 disabled 写原因和顺到谁、选路读 channel_states 不选 disabled 的渠道、
// 探针探通改回 ok。读不到 channel_states 必须明确失败，不当成全 ok。
import { eq } from 'drizzle-orm';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import {
  markChannelDisabled,
  noteRouteProbed,
  readChannelStates,
  recordChannelAttempt,
  setChannelFallback,
} from '../src/queries/channel-fallback.ts';
import { saveRouteProbe } from '../src/queries/probe.ts';
import { flattenRoutingLayers, routingLayers } from '../src/routing-layers.ts';
import { channelAttempts, channelStates, channels, pools } from '../src/schema/index.ts';
import { createTestDb, resetTestDb, TEST_DB_TIMEOUT_MS, type TestDb } from '../src/testing.ts';
import {
  addRepo,
  addRoute,
  addTask,
  addWindow,
  ago,
  catalog,
  expectViolation,
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
  // 同一个模型两个渠道：relay（r1）排前面，relay2（r2）是它的下一个渠道
  await t.db.insert(channels).values({ id: 'relay2', name: '备用中转', billing: 'subscription' });
  await t.db.insert(pools).values({ id: 'relay2-a', channelId: 'relay2', maxConcurrency: 2 });
  await addRoute(t.db, { id: 'r1', poolId: 'relay-a', modelId: 'opus-5.5' });
  await addRoute(t.db, { id: 'r2', poolId: 'relay2-a', modelId: 'opus-5.5', channelId: 'relay2' });
  await setRoutingLayers(t.db, {
    purposes: { execute: ['opus-5.5'] },
    models: { 'opus-5.5': ['r1', 'r2'] },
  });
  const fresh = { reading: 'measured', readAt: ago(MIN) } as const;
  await addWindow(t.db, { poolId: 'relay-a', window: '7d', utilization: 0.1, ...fresh });
  await addWindow(t.db, { poolId: 'relay2-a', window: '7d', utilization: 0.1, ...fresh });
});

const candidates = async () => flattenRoutingLayers(await routingLayers(t.db, 'execute', { now: NOW }));
const stateOf = async (channelId: string) => (await readChannelStates(t.db)).get(channelId);

describe('每次起会话的尝试', () => {
  const base = (taskId: string | undefined, over: Record<string, unknown> = {}) => ({
    ...(taskId === undefined ? {} : { taskId }),
    modelId: 'opus-5.5',
    routeId: 'r1',
    channelId: 'relay',
    startedAt: ago(5 * MIN),
    endedAt: ago(4 * MIN),
    ...over,
  });

  it('同一张单的尝试从 1 起顺序编号；别的单、不属于哪张单的各自从 1 起；耗时是起止之差', async () => {
    const repo = await addRepo(t.db);
    const a = await addTask(t.db, repo.id);
    const b = await addTask(t.db, repo.id);
    await recordChannelAttempt(t.db, base(a.id, { errorType: 'network_error', message: '上游断连' }));
    await recordChannelAttempt(t.db, base(a.id, { routeId: 'r2', channelId: 'relay2' }));
    await recordChannelAttempt(t.db, base(b.id));
    await recordChannelAttempt(t.db, base(undefined));
    const rows = await t.db.select().from(channelAttempts);
    const idx = (taskId: string | null) =>
      rows
        .filter((r) => r.taskId === taskId)
        .map((r) => r.attemptIdx)
        .sort();
    expect(idx(a.id)).toEqual([1, 2]);
    expect(idx(b.id)).toEqual([1]);
    expect(idx(null)).toEqual([1]);
    expect(rows.find((r) => r.errorType === 'network_error')).toMatchObject({
      channelId: 'relay',
      message: '上游断连',
      durationMs: MIN,
    });
  });

  it('【故意造出的失败】失败不写原因、结束早于开始：库的约束拒收', async () => {
    await expectViolation(
      recordChannelAttempt(t.db, base(undefined, { errorType: 'network_error' })),
      'channel_attempts_failed_has_reason',
    );
    await expectViolation(
      recordChannelAttempt(t.db, base(undefined, { startedAt: ago(MIN), endedAt: ago(2 * MIN) })),
      'channel_attempts_ended_after_start',
    );
  });
});

describe('渠道运行中失败：标 disabled、顺到谁', () => {
  it('标 disabled 写原因和引发的路由；同一个渠道再失败换成最新原因、清掉旧的顺到谁、保留第一次的时刻', async () => {
    await markChannelDisabled(t.db, {
      channelId: 'relay',
      routeId: 'r1',
      reason: '上游断连',
      now: ago(10 * MIN),
    });
    expect(
      await setChannelFallback(t.db, {
        channelId: 'relay',
        fallbackChannelId: 'relay2',
        fallbackModelId: 'opus-5.5',
        now: ago(9 * MIN),
      }),
    ).toBe(true);
    expect(await stateOf('relay')).toMatchObject({
      status: 'disabled',
      reason: '上游断连',
      failedRouteId: 'r1',
      fallbackChannelId: 'relay2',
      fallbackModelId: 'opus-5.5',
      flaggedAt: ago(10 * MIN),
    });

    await markChannelDisabled(t.db, {
      channelId: 'relay',
      routeId: 'r1',
      reason: '被拒：429',
      now: ago(MIN),
    });
    expect(await stateOf('relay')).toMatchObject({
      status: 'disabled',
      reason: '被拒：429',
      fallbackChannelId: null,
      fallbackModelId: null,
      flaggedAt: ago(10 * MIN),
      updatedAt: ago(MIN),
    });
  });

  it('【故意造出的失败】不带原因不写；渠道不是 disabled（没出过事 / 已改回）时记顺到谁回 false，不写', async () => {
    await expect(
      markChannelDisabled(t.db, { channelId: 'relay', routeId: 'r1', reason: '  ', now: NOW }),
    ).rejects.toThrow('没带原因');
    expect(await stateOf('relay')).toBeUndefined();
    expect(
      await setChannelFallback(t.db, {
        channelId: 'relay',
        fallbackChannelId: 'relay2',
        fallbackModelId: 'opus-5.5',
        now: NOW,
      }),
    ).toBe(false);
    expect(await stateOf('relay')).toBeUndefined();
  });

  it('【故意造出的失败】库约束：disabled 没原因、顺到谁只记一半都拒收', async () => {
    await expectViolation(
      t.db.insert(channelStates).values({ channelId: 'relay', status: 'disabled', flaggedAt: NOW }),
      'channel_states_disabled_has_reason',
    );
    await expectViolation(
      t.db.insert(channelStates).values({ channelId: 'relay', status: 'ok', fallbackChannelId: 'relay2' }),
      'channel_states_fallback_together',
    );
  });
});

describe('选路读 channel_states', () => {
  it('没有行 / ok 的渠道照常能选；disabled 的渠道下所有路由带 channel-failed 挡因，只剩下一个渠道', async () => {
    expect((await candidates()).map((c) => [c.routeId, c.eligible])).toEqual([
      ['r1', true],
      ['r2', true],
    ]);
    await markChannelDisabled(t.db, { channelId: 'relay', routeId: 'r1', reason: '上游断连', now: ago(MIN) });
    const got = await candidates();
    expect(got.find((c) => c.routeId === 'r1')).toMatchObject({
      eligible: false,
      blockers: ['channel-failed'],
    });
    expect(got.find((c) => c.routeId === 'r2')).toMatchObject({ eligible: true, blockers: [] });
  });

  it('【故意造出的失败】全部渠道都 disabled：一条都不能选（选路据此停下报人），不是「都能用」', async () => {
    await markChannelDisabled(t.db, { channelId: 'relay', routeId: 'r1', reason: '上游断连', now: ago(MIN) });
    await markChannelDisabled(t.db, { channelId: 'relay2', routeId: 'r2', reason: '被拒', now: ago(MIN) });
    expect((await candidates()).every((c) => !c.eligible && c.blockers.includes('channel-failed'))).toBe(
      true,
    );
  });

  it('【故意造出的失败】channel_states 读不到（表不在）：选路读事实直接抛错，不当成全 ok 把 disabled 的渠道派出去', async () => {
    await markChannelDisabled(t.db, { channelId: 'relay', routeId: 'r1', reason: '上游断连', now: ago(MIN) });
    await t.client.exec('alter table channel_states rename to channel_states_unreadable');
    try {
      await expect(candidates()).rejects.toThrow();
      const err = await candidates().catch((e: unknown) => e);
      const chain: string[] = [];
      for (let e: unknown = err; e instanceof Error; e = e.cause) chain.push(e.message);
      expect(chain.join('\n')).toContain('channel_states');
    } finally {
      await t.client.exec('alter table channel_states_unreadable rename to channel_states');
    }
  });
});

describe('探针探通改回 ok', () => {
  const probe = (routeId: string, state: 'ok' | 'failed', at = ago(MIN)) =>
    saveRouteProbe(t.db, { routeId, state, at, detail: state === 'ok' ? '答上了：OK' : '连不上' });

  it('探通引发 disabled 的那条路由：改回 ok、写依据、清掉顺到谁和第一次的时刻；选路又能选它', async () => {
    await markChannelDisabled(t.db, {
      channelId: 'relay',
      routeId: 'r1',
      reason: '上游断连',
      now: ago(10 * MIN),
    });
    await setChannelFallback(t.db, {
      channelId: 'relay',
      fallbackChannelId: 'relay2',
      fallbackModelId: 'opus-5.5',
      now: ago(9 * MIN),
    });
    expect(await probe('r1', 'ok')).toBe('saved');
    expect(await stateOf('relay')).toMatchObject({
      status: 'ok',
      failedRouteId: null,
      fallbackChannelId: null,
      flaggedAt: null,
      lastProbedAt: ago(MIN),
    });
    expect((await stateOf('relay'))?.reason).toContain('r1');
    expect((await candidates()).every((c) => c.eligible)).toBe(true);
  });

  it('探针没探通（或探通的是同渠道别的路由）：仍是 disabled，只记探针看过的时刻', async () => {
    await addRoute(t.db, { id: 'r1b', poolId: 'relay-b', modelId: 'opus-5.5' });
    await markChannelDisabled(t.db, {
      channelId: 'relay',
      routeId: 'r1',
      reason: '上游断连',
      now: ago(10 * MIN),
    });
    await probe('r1', 'failed', ago(3 * MIN));
    expect(await stateOf('relay')).toMatchObject({ status: 'disabled', lastProbedAt: ago(3 * MIN) });
    await probe('r1b', 'ok', ago(2 * MIN));
    expect(await stateOf('relay')).toMatchObject({ status: 'disabled', lastProbedAt: ago(2 * MIN) });
  });

  it('引发的路由已被删（failed_route_id 置空）：渠道下任一路由探通就改回，不让渠道永远卡着', async () => {
    await markChannelDisabled(t.db, {
      channelId: 'relay',
      routeId: 'r1',
      reason: '上游断连',
      now: ago(10 * MIN),
    });
    await t.db.update(channelStates).set({ failedRouteId: null }).where(eq(channelStates.channelId, 'relay'));
    expect(await noteRouteProbed(t.db, { routeId: 'r1', state: 'ok', at: NOW })).toBe(true);
    expect((await stateOf('relay'))?.status).toBe('ok');
  });
});
