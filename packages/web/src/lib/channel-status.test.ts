// 渠道状态（#1087）：顺位怎么排、探针报错的渠道怎么写「暂不可用、顺延到下一个」、干粉渠道照列、晚于下次探测时刻 20 分钟改成「检测中断」（#1798 片 7）。
import { describe, expect, test } from 'vitest';
import type {
  Channel,
  LivenessVerdict,
  ProbeHistoryCell,
  Route,
  RoutingLayerRoute,
  RoutingLayers,
} from '../api/types';
import {
  buildChannelCards,
  type ChannelCard,
  type ChannelQuota,
  probeLatency,
  quotaCountText,
  quotaResetLine,
} from './channel-status';
import { formatDateTime, TIME } from './format';
import { currentQuotaCells, probeKind, probeWord, quotaResetText } from './probe-history-view';

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

describe('检测中断：晚于 probeNextAt 加 20 分钟就不当现状', () => {
  const later = (min: number) => new Date(NOW + min * TIME.MIN).toISOString();
  const one = (over: Partial<RoutingLayerRoute>) =>
    byId(
      buildChannelCards(
        { channels: [channel('a')], routes: [], models: [] },
        layers([{ m1: [layerRoute('a1', 'a', 'live', { probeTier: 'active', ...over })] }]),
        NOW,
      ),
      'a',
    );

  test('下次探测时刻过了 19 分钟还算现状，过了 21 分钟改成检测中断，画红（不再亮绿灯）', () => {
    expect(one({ probeNextAt: later(-19) })).toMatchObject({
      interrupted: false,
      label: '在线',
      tone: 'done',
    });
    expect(one({ probeNextAt: later(-21) })).toMatchObject({
      interrupted: true,
      label: '检测中断',
      tone: 'fail',
      state: 'ok',
    });
  });
  test('不活跃的路由也一样：每天一次的下次时刻过了 20 分钟没探，就是中断', () => {
    expect(one({ probeTier: 'idle', probeNextAt: later(-21) }).interrupted).toBe(true);
    expect(one({ probeTier: 'idle', probeNextAt: later(600) }).interrupted).toBe(false);
  });
  test('不在用的路由不主动探，没有「下次」可晚：放多久都不算中断', () => {
    expect(one({ probeTier: 'unused', probeNextAt: later(-5000), probedAt: ago(5000) }).interrupted).toBe(
      false,
    );
  });
  test('库里没写 probeNextAt（老行、引擎还没走过钟）：判不了，不猜成中断', () => {
    expect(one({ probedAt: ago(600) }).interrupted).toBe(false);
  });
  test('不看探针原文：原文写什么退避、隔多久都不影响，只看 probeNextAt', () => {
    const detail = '答上了：OK。用途前 2 位，隔 30 分钟再探；退避中，下次约 16:07 再探（连着不通 3 次）';
    expect(one({ probeDetail: detail, probeNextAt: later(10) }).interrupted).toBe(false);
    expect(one({ probeDetail: detail, probeNextAt: later(-21) }).interrupted).toBe(true);
  });
  test('探针报错的渠道检测中断了：不再写「顺延」（那是旧结论）', () => {
    const cards = buildChannelCards(
      { channels: [channel('a'), channel('b')], routes: [], models: [] },
      layers([
        {
          m1: [
            layerRoute('a1', 'a', 'dead', { probeTier: 'active', probeNextAt: later(-40) }),
            layerRoute('b1', 'b', 'live'),
          ],
        },
      ]),
      NOW,
    );
    expect(byId(cards, 'a')).toMatchObject({ interrupted: true, label: '检测中断' });
    expect(byId(cards, 'a').fallback).toBeUndefined();
  });
  test('退避中的不通：下次探测时刻还没到，40 分钟前探的结论不算检测中断', () => {
    const cards = buildChannelCards(
      { channels: [channel('a')], routes: [], models: [] },
      layers([
        {
          m1: [
            layerRoute('a1', 'a', 'dead', {
              probedAt: ago(40),
              probeTier: 'active',
              probeFailStreak: 3,
              probeNextAt: later(20),
            }),
          ],
        },
      ]),
      NOW,
    );
    expect(byId(cards, 'a').interrupted).toBe(false);
  });
  test('一个渠道有一条路刚探过：不算中断（要每条在探的路都晚了才算）', () => {
    const cards = buildChannelCards(
      { channels: [channel('a')], routes: [], models: [] },
      layers([
        {
          m1: [
            layerRoute('a1', 'a', 'live', { probeTier: 'active', probeNextAt: later(-40) }),
            layerRoute('a2', 'a', 'live', { probeTier: 'active', probeNextAt: later(50) }),
          ],
        },
      ]),
      NOW,
    );
    expect(cards[0]?.interrupted).toBe(false);
  });
  test('渠道下每条路由各数各的：晚了的数检测中断，身份题说出旧答案的数疑似换模型', () => {
    const cards = buildChannelCards(
      {
        channels: [channel('a')],
        routes: [rawRoute('a1', 'a', '通'), rawRoute('a2', 'a', '通'), rawRoute('a3', 'a', '通')],
        models: [],
      },
      layers([
        {
          m1: [
            layerRoute('a1', 'a', 'live', { probeTier: 'active', probeNextAt: later(-40) }),
            layerRoute('a2', 'a', 'dead', { probeTier: 'active', probeNextAt: later(10) }),
            layerRoute('a3', 'a', 'live', { probeTier: 'active', probeNextAt: later(10) }),
          ],
        },
      ]),
      NOW,
      () => false,
      new Set(['a2']),
    );
    expect(byId(cards, 'a').counts).toMatchObject({ interrupted: 1, degraded: 1, live: 1, fault: 0 });
  });
});

describe('连通但额度耗尽（#2939）：只改说法，不改连通统计和选路', () => {
  const cell = (routeId: string, over: Partial<ProbeHistoryCell> = {}): ProbeHistoryCell => ({
    id: 1,
    routeId,
    channelId: 'a',
    probedAt: ago(4),
    result: 'passed',
    durationMs: 1200,
    failureReason: null,
    requestText: null,
    responseText: null,
    checkQuestion: null,
    checkExpected: null,
    checkAnswer: null,
    checkPassed: null,
    selfIdentity: null,
    ...over,
  });
  const RESET = '2026-10-05T14:30:00Z';
  const quotaCell = (routeId: string, over: Partial<ProbeHistoryCell> = {}) =>
    cell(routeId, { quotaExhausted: true, detail: '5 小时额度用完了', resetsAt: RESET, ...over });
  const catalog = [rawRoute('a1', 'a', '通'), rawRoute('a2', 'a', '通'), rawRoute('a3', 'a', '通')];
  const build = (
    quotaOf: ProbeHistoryCell[],
    routes: Route[] = catalog,
    verdict2: LivenessVerdict = 'live',
  ) =>
    buildChannelCards(
      { channels: [channel('a')], routes, models: [] },
      layers([
        {
          m1: [layerRoute('a1', 'a', 'live'), layerRoute('a2', 'a', verdict2), layerRoute('a3', 'a', 'live')],
        },
      ]),
      NOW,
      () => false,
      new Set(),
      currentQuotaCells(quotaOf, routes),
    );

  test('probeKind：只有 passed 且明说 quotaExhausted 才是额度耗尽；老行缺字段、认证失败、网络失败、临时 429 都不是', () => {
    expect(probeKind(quotaCell('a1'))).toBe('quota');
    expect(probeKind(cell('a1'))).toBe('passed');
    expect(probeKind(cell('a1', { quotaExhausted: false }))).toBe('passed');
    expect(probeKind(cell('a1', { result: 'failed', failureReason: '401 认证失败' }))).toBe('failed');
    expect(probeKind(cell('a1', { result: 'failed', failureReason: 'ECONNRESET 网络断了' }))).toBe('failed');
    expect(probeKind(cell('a1', { result: 'failed', failureReason: '429 临时限流，稍后重试' }))).toBe(
      'failed',
    );
    // 就算失败行带了 quotaExhausted 也不当额度耗尽（它是「连通」的前提）
    expect(probeKind(cell('a1', { result: 'failed', quotaExhausted: true }))).toBe('failed');
  });

  test('重置时间：上游给了写明确时刻；没给写没给，不从别处推算', () => {
    expect(quotaResetText(RESET)).toBe(`预计 ${formatDateTime(RESET)} 重置`);
    expect(quotaResetText(undefined)).toBe('重置时间上游没给');
    expect(probeWord(quotaCell('a1'))).toBe(`连通但额度耗尽（预计 ${formatDateTime(RESET)} 重置）`);
    expect(probeWord(quotaCell('a1', { resetsAt: undefined }))).toBe('连通但额度耗尽（重置时间上游没给）');
    expect(probeWord(cell('a1'))).toBe('通过');
  });

  test('所有在用的路都耗尽：渠道说「连通但额度耗尽」，状态仍是在线（ok），连通统计不变', () => {
    const [c] = build([quotaCell('a1'), quotaCell('a2'), quotaCell('a3')]);
    expect(c).toMatchObject({
      state: 'ok',
      label: '连通但额度耗尽',
      kind: 'live',
      hasFault: false,
      deadRoutes: 0,
    });
    expect(c?.counts.live).toBe(3);
    expect(c?.quota).toMatchObject({
      routes: 3,
      resetUnknown: 0,
      resetsAt: RESET,
      detail: '5 小时额度用完了',
    });
    expect(quotaCountText(c as ChannelCard)).toBe('额度耗尽 3/3 路');
    expect(quotaResetLine(c?.quota as ChannelQuota)).toBe(`预计 ${formatDateTime(RESET)} 重置`);
  });

  test('混合路由：只有部分路耗尽，不说成整个渠道都耗尽', () => {
    const [c] = build([quotaCell('a2'), cell('a1'), cell('a3')]);
    expect(c).toMatchObject({ state: 'ok', label: '部分路额度耗尽' });
    expect(c?.quota?.routes).toBe(1);
    expect(quotaCountText(c as ChannelCard)).toBe('额度耗尽 1/3 路');
  });

  test('额度耗尽但重置时间没给：写没给；有的给有的没给，写最早的并说明另有几路没给', () => {
    const [none] = build([quotaCell('a1', { resetsAt: undefined })]);
    expect(none?.quota).not.toHaveProperty('resetsAt');
    expect(quotaResetLine(none?.quota as ChannelQuota)).toBe('重置时间上游没给');
    const [some] = build([quotaCell('a1'), quotaCell('a2', { resetsAt: undefined })]);
    expect(quotaResetLine(some?.quota as ChannelQuota)).toBe(
      `最早预计 ${formatDateTime(RESET)} 重置（另有 1 路没给）`,
    );
  });

  test('普通成功、老行（缺字段）、失败行：卡片照旧说在线，不带 quota', () => {
    for (const rows of [
      [cell('a1'), cell('a2'), cell('a3')],
      [cell('a1', { quotaExhausted: undefined }), cell('a2', { detail: null })],
      [cell('a1', { result: 'failed', failureReason: '429 临时限流' })],
    ]) {
      const [c] = build(rows);
      expect(c?.label).toBe('在线');
      expect(c?.quota).toBeUndefined();
    }
  });

  test('旧的额度记录已被更新的成功覆盖：路由当前探针比它新，就不算额度耗尽', () => {
    const fresh = [rawRoute('a1', 'a', '通', ago(1)), rawRoute('a2', 'a', '通'), rawRoute('a3', 'a', '通')];
    // a1 的额度记录是 30 分钟前的，目录里的探针已经是 1 分钟前的新成功
    const stale = quotaCell('a1', { probedAt: ago(30) });
    expect(currentQuotaCells([stale], fresh).size).toBe(0);
    const [c] = build([stale], fresh);
    expect(c?.label).toBe('在线');
    expect(c?.quota).toBeUndefined();
    // 目录里探针不是通（失败）也不认
    const failedRoute: Route[] = [
      { ...rawRoute('a1', 'a', '不通'), probe: { state: 'failed', at: ago(4), detail: 'x' } },
    ];
    expect(currentQuotaCells([quotaCell('a1')], failedRoute).size).toBe(0);
  });

  test('渠道里有路不通：状态仍是部分路故障（不被额度盖掉），quota 另带', () => {
    const [c] = build([quotaCell('a1')], catalog, 'dead');
    expect(c).toMatchObject({ state: 'partial', label: '部分路故障', deadRoutes: 1, hasFault: true });
    expect(c?.quota?.routes).toBe(1);
  });

  test('检测中断时仍说检测中断', () => {
    const [c] = buildChannelCards(
      { channels: [channel('a')], routes: catalog, models: [] },
      layers([{ m1: [layerRoute('a1', 'a', 'live', { probeTier: 'active', probeNextAt: ago(60) })] }]),
      NOW,
      () => false,
      new Set(),
      currentQuotaCells([quotaCell('a1')], catalog),
    );
    expect(c?.interrupted).toBe(true);
    expect(c?.label).toBe('检测中断');
  });
});
