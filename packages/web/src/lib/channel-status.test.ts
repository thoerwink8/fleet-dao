// 渠道状态（#1087）：顺位怎么排、探针报错的渠道怎么写「暂不可用、顺延到下一个」、干粉渠道照列、超过间隔 + 3 分钟改成「检测中断」。
import { describe, expect, test } from 'vitest';
import type { Channel, LivenessVerdict, Route, RoutingLayerRoute, RoutingLayers } from '../api/types';
import { buildChannelCards, probeLatency } from './channel-status';
import { TIME } from './format';

const NOW = Date.parse('2026-10-05T12:00:00Z');
const ago = (min: number) => new Date(NOW - min * TIME.MIN).toISOString();

const channel = (id: string, over: Partial<Channel> = {}): Channel => ({
  id,
  name: `渠道 ${id}`,
  billing: 'subscription',
  enabled: true,
  ...over,
});

function layerRoute(
  routeId: string,
  channelId: string,
  verdict: LivenessVerdict,
  over: Partial<RoutingLayerRoute> = {},
): RoutingLayerRoute {
  return {
    routeId,
    channelId,
    channelName: `渠道 ${channelId}`,
    poolId: `pool-${routeId}`,
    hostId: 'claude-code',
    enabled: true,
    verdict,
    connect: {
      verdict,
      reason:
        verdict === 'live'
          ? '探针探通了'
          : verdict === 'dead'
            ? '探针判不在线：连探两次都没通'
            : '探针还没看过这条路由',
    },
    quota: { verdict: 'live', reason: '额度够' },
    ban: { verdict: 'live', reason: '没被挡' },
    probedAt: verdict === 'unknown' ? undefined : ago(4),
    exhausted: [],
    inFlight: 0,
    reserved: 0,
    maxConcurrency: 2,
    ...over,
  };
}

const layers = (models: Record<string, RoutingLayerRoute[]>[]): RoutingLayers => ({
  asOf: ago(0),
  purposes: [
    {
      purpose: 'execute',
      version: 0,
      verdict: 'live',
      problems: [],
      models: models.flatMap((m) =>
        Object.entries(m).map(([modelId, routes]) => ({
          modelId,
          displayName: modelId,
          verdict: 'live' as const,
          routes,
        })),
      ),
    },
  ],
});

const rawRoute = (id: string, channelId: string, detail: string, at = ago(4)): Route => ({
  id,
  channelId,
  poolId: `pool-${id}`,
  modelId: 'm',
  hostId: 'claude-code',
  alive: true,
  probe: { state: 'ok', at, detail },
});

const byId = (cards: ReturnType<typeof buildChannelCards>, id: string) => {
  const c = cards.find((x) => x.channel.id === id);
  if (!c) throw new Error(`没有渠道 ${id}`);
  return c;
};

describe('顺位：按路由两层里渠道最靠前的名次排', () => {
  test('一个模型下 a、b、c 三个渠道的路：顺位 1、2、3；同一个渠道的两条路只占一个名额', () => {
    const cards = buildChannelCards(
      { channels: [channel('c'), channel('b'), channel('a')], routes: [], models: [] },
      layers([
        {
          m1: [
            layerRoute('a1', 'a', 'live'),
            layerRoute('a2', 'a', 'live'),
            layerRoute('b1', 'b', 'live'),
            layerRoute('c1', 'c', 'live'),
          ],
        },
      ]),
      NOW,
    );
    expect(cards.map((c) => [c.channel.id, c.rank])).toEqual([
      ['a', 1],
      ['b', 2],
      ['c', 3],
    ]);
  });

  test('在别的模型里排第一的渠道也算靠前：b 在 m2 里排第一，和 a 并列名次 0，先排到的在前', () => {
    const cards = buildChannelCards(
      { channels: [channel('a'), channel('b'), channel('c')], routes: [], models: [] },
      layers([
        { m1: [layerRoute('a1', 'a', 'live'), layerRoute('c1', 'c', 'live')] },
        { m2: [layerRoute('b1', 'b', 'live'), layerRoute('c2', 'c', 'live')] },
      ]),
      NOW,
    );
    expect(cards.map((c) => c.channel.id)).toEqual(['a', 'b', 'c']);
    expect(cards.map((c) => c.rank)).toEqual([1, 2, 3]);
  });

  test('关着的路不参与顺位，也不算这个渠道在用', () => {
    const cards = buildChannelCards(
      { channels: [channel('a'), channel('b')], routes: [], models: [] },
      layers([{ m1: [layerRoute('a1', 'a', 'live', { enabled: false }), layerRoute('b1', 'b', 'live')] }]),
      NOW,
    );
    expect(byId(cards, 'b').rank).toBe(1);
    expect(byId(cards, 'a')).toMatchObject({ state: 'idle', label: '未被用途使用' });
    expect(byId(cards, 'a').rank).toBeUndefined();
  });
});

describe('「死」拆开（#1366）：人关的、没用的、下架的、池暂停的都不是故障', () => {
  const raw = (id: string, channelId: string, over: Partial<Route> = {}): Route => ({
    ...rawRoute(id, channelId, '探针原文'),
    ...over,
  });

  test('路由都被人关了：渠道是已关，不是故障，也不进故障口径', () => {
    const cards = buildChannelCards(
      { channels: [channel('a'), channel('b')], routes: [raw('a1', 'a'), raw('b1', 'b')], models: [] },
      layers([
        {
          m1: [
            layerRoute('a1', 'a', 'dead', {
              enabled: false,
              ban: { verdict: 'dead', reason: '开关关着' },
            }),
            layerRoute('b1', 'b', 'live'),
          ],
        },
      ]),
      NOW,
    );
    expect(byId(cards, 'a')).toMatchObject({ kind: 'off', label: '已关', hasFault: false });
    expect(byId(cards, 'a').tone).not.toBe('fail');
    expect(byId(cards, 'a').counts.off).toBe(1);
  });

  test('渠道开关关着：已关；渠道从没被用途排过：未被用途使用；都不画红', () => {
    const cards = buildChannelCards(
      {
        channels: [channel('off', { enabled: false }), channel('dry'), channel('a')],
        routes: [raw('d1', 'dry')],
        models: [],
      },
      layers([{ m1: [layerRoute('a1', 'a', 'live')] }]),
      NOW,
    );
    expect(byId(cards, 'off')).toMatchObject({ kind: 'off', label: '已关', tone: 'stop', hasFault: false });
    expect(byId(cards, 'dry')).toMatchObject({ kind: 'unused', label: '未被用途使用', tone: 'stop' });
  });

  test('整池暂停：池暂停，不是故障，也不算在用', () => {
    const cards = buildChannelCards(
      { channels: [channel('a')], routes: [raw('a1', 'a')], models: [] },
      layers([{ m1: [layerRoute('a1', 'a', 'dead')] }]),
      NOW,
      (poolId) => poolId === 'pool-a1',
    );
    expect(byId(cards, 'a')).toMatchObject({ kind: 'held', label: '池暂停', hasFault: false });
    expect(byId(cards, 'a').tone).not.toBe('fail');
  });

  test('该在线却探不通才是故障', () => {
    const cards = buildChannelCards(
      { channels: [channel('a')], routes: [raw('a1', 'a')], models: [] },
      layers([{ m1: [layerRoute('a1', 'a', 'dead')] }]),
      NOW,
    );
    expect(byId(cards, 'a')).toMatchObject({ kind: 'fault', label: '故障', tone: 'fail', hasFault: true });
  });
});

describe('状态：通 / 部分路不通 / 暂不可用 / 还没探到', () => {
  const two = (a: LivenessVerdict, b: LivenessVerdict) =>
    buildChannelCards(
      { channels: [channel('a')], routes: [], models: [] },
      layers([{ m1: [layerRoute('a1', 'a', a), layerRoute('a2', 'a', b)] }]),
      NOW,
    )[0];

  test('在用的路都探通了：通', () => {
    expect(two('live', 'live')).toMatchObject({ state: 'ok', label: '在线', tone: 'done', deadRoutes: 0 });
  });
  test('有路探通、有路探针报错：部分路不通，写明几条不通和报错', () => {
    const c = two('live', 'dead');
    expect(c).toMatchObject({ state: 'partial', label: '部分路故障', deadRoutes: 1, activeRoutes: 2 });
    expect(c?.reason).toBe('探针判不在线：连探两次都没通');
  });
  test('在用的路探针全报错：暂不可用（红），报错写全，另有几条也不通', () => {
    const c = two('dead', 'dead');
    expect(c).toMatchObject({ state: 'down', label: '故障', tone: 'fail', deadRoutes: 2 });
    expect(c?.reason).toBe('探针判不在线：连探两次都没通（另有 1 条路也不通）');
  });
  test('探针都还没看过：还没探到，不画成通也不画成不通', () => {
    const c = two('unknown', 'unknown');
    expect(c).toMatchObject({ state: 'unknown', label: '还没探到', tone: 'stall', interrupted: false });
    expect(c?.probedAt).toBeUndefined();
  });
  test('按量计费的渠道探针不自动探：写明原因，不写「还没探到」', () => {
    const c = buildChannelCards(
      { channels: [channel('a', { billing: 'metered' })], routes: [], models: [] },
      layers([{ m1: [layerRoute('a1', 'a', 'unknown')] }]),
      NOW,
    )[0];
    expect(c).toMatchObject({ state: 'unknown', label: '按量计费，不自动探' });
  });
  test('延迟取探通那条路的探针 detail 里的「用时 N 秒」；没写就不给', () => {
    const withDetail = buildChannelCards(
      { channels: [channel('a')], routes: [rawRoute('a1', 'a', '答上了：OK · 用时 8 秒')], models: [] },
      layers([{ m1: [layerRoute('a1', 'a', 'live')] }]),
      NOW,
    )[0];
    expect(withDetail?.latency).toBe('用时 8 秒');
    expect(probeLatency('答上了：OK')).toBeUndefined();
    expect(probeLatency(undefined)).toBeUndefined();
  });
});

describe('已下架模型下的路由不算渠道的通不通', () => {
  test('a 的一条路挂在已下架的模型下（死因是模型下架）：不拉低 a，也不占顺位；a 只剩这一条时按干粉列', () => {
    const model = (id: string, retiredAt?: string) => ({
      id,
      family: 'x',
      displayName: id,
      ...(retiredAt ? { retiredAt } : {}),
    });
    const cards = buildChannelCards(
      { channels: [channel('a'), channel('b')], routes: [], models: [model('old', ago(60)), model('m1')] },
      layers([
        { old: [layerRoute('b0', 'b', 'dead', { connect: { verdict: 'dead', reason: '模型已下架' } })] },
        { m1: [layerRoute('a1', 'a', 'live')] },
      ]),
      NOW,
    );
    expect(byId(cards, 'a')).toMatchObject({ state: 'ok', rank: 1 });
    expect(byId(cards, 'b')).toMatchObject({ state: 'idle' });
  });
});

describe('探针报错 = 暂不可用（禁用），顺延到下一个', () => {
  test('顺位第 1 的渠道探针全报错：写顺延到顺位第 2（能用的）；跳过同样不可用的', () => {
    const cards = buildChannelCards(
      { channels: [channel('a'), channel('b'), channel('c')], routes: [], models: [] },
      layers([
        {
          m1: [layerRoute('a1', 'a', 'dead'), layerRoute('b1', 'b', 'dead'), layerRoute('c1', 'c', 'live')],
        },
      ]),
      NOW,
    );
    expect(byId(cards, 'a').fallback).toBe('这个渠道暂不可用（已禁用），选路顺延到「渠道 c」');
    expect(byId(cards, 'b').fallback).toBe('这个渠道暂不可用（已禁用），选路顺延到「渠道 c」');
    expect(byId(cards, 'c').fallback).toBeUndefined();
  });
  test('后面没有能用的渠道：照实写，不编一个顺延对象', () => {
    const cards = buildChannelCards(
      { channels: [channel('a'), channel('b')], routes: [], models: [] },
      layers([{ m1: [layerRoute('a1', 'a', 'live'), layerRoute('b1', 'b', 'dead')] }]),
      NOW,
    );
    expect(byId(cards, 'b').fallback).toBe('这个渠道暂不可用（已禁用），后面没有能用的渠道了');
  });
  test('部分路不通的渠道不整个禁用：不写顺延', () => {
    const cards = buildChannelCards(
      { channels: [channel('a'), channel('b')], routes: [], models: [] },
      layers([
        { m1: [layerRoute('a1', 'a', 'live'), layerRoute('a2', 'a', 'dead')] },
        { m2: [layerRoute('b1', 'b', 'live')] },
      ]),
      NOW,
    );
    expect(byId(cards, 'a').fallback).toBeUndefined();
  });
});

describe('干粉和下架的渠道照列，排在后面', () => {
  test('没排进任何用途：没在配的路由里，未探，灰色；下架的写渠道已下架，排最后', () => {
    const cards = buildChannelCards(
      {
        channels: [channel('off', { enabled: false }), channel('dry'), channel('a')],
        routes: [],
        models: [],
      },
      layers([{ m1: [layerRoute('a1', 'a', 'live')] }]),
      NOW,
    );
    expect(cards.map((c) => c.channel.id)).toEqual(['a', 'dry', 'off']);
    expect(byId(cards, 'dry')).toMatchObject({ state: 'idle', tone: 'stop', label: '未被用途使用' });
    expect(byId(cards, 'off')).toMatchObject({ state: 'off', tone: 'stop', label: '已关' });
    expect(byId(cards, 'dry').interrupted).toBe(false);
  });
});

describe('检测中断：上次探超过「探测间隔 + 3 分钟」就不当现状', () => {
  const one = (probedMinutesAgo: number, hostId: RoutingLayerRoute['hostId'] = 'claude-code') =>
    byId(
      buildChannelCards(
        { channels: [channel('a')], routes: [], models: [] },
        layers([{ m1: [layerRoute('a1', 'a', 'live', { probedAt: ago(probedMinutesAgo), hostId })] }]),
        NOW,
      ),
      'a',
    );

  test('15 分钟一轮的渠道：17 分钟前还算现状，19 分钟前改成检测中断（不再亮绿灯）', () => {
    expect(one(17)).toMatchObject({ interrupted: false, label: '在线', tone: 'done' });
    expect(one(19)).toMatchObject({ interrupted: true, label: '检测中断', tone: 'stall', state: 'ok' });
  });
  test('半小时前的结论：检测中断（e2e 用的就是这个）', () => {
    expect(one(30).interrupted).toBe(true);
  });
  test('放慢到 2 小时一轮的执行方式用它自己的间隔：30 分钟前不中断，125 分钟前才中断', () => {
    expect(one(30, 'cursor-agent').interrupted).toBe(false);
    expect(one(125, 'cursor-agent').interrupted).toBe(true);
  });
  test('探针报错的渠道检测中断了：不再写「顺延」（那是旧结论）', () => {
    const cards = buildChannelCards(
      { channels: [channel('a'), channel('b')], routes: [], models: [] },
      layers([
        {
          m1: [layerRoute('a1', 'a', 'dead', { probedAt: ago(40) }), layerRoute('b1', 'b', 'live')],
        },
      ]),
      NOW,
    );
    expect(byId(cards, 'a')).toMatchObject({ interrupted: true, label: '检测中断' });
    expect(byId(cards, 'a').fallback).toBeUndefined();
  });
  test('一个渠道有一条路刚探过：不算中断（要每条探过的路都过了才算）', () => {
    const cards = buildChannelCards(
      { channels: [channel('a')], routes: [], models: [] },
      layers([
        {
          m1: [
            layerRoute('a1', 'a', 'live', { probedAt: ago(40) }),
            layerRoute('a2', 'a', 'live', { probedAt: ago(2) }),
          ],
        },
      ]),
      NOW,
    );
    expect(cards[0]?.interrupted).toBe(false);
  });
});
