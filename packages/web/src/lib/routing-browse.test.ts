// 路由页「模型目录」「渠道」两块的数据拼法（#1366 第二部分）：配进用途的模型带开关状态，没配进用途的照样列出但读不到开关。
import { describe, expect, test } from 'vitest';
import type { Model, Route, RoutingLayerRoute, RoutingLayers } from '../api/types';
import { buildCatalog, channelRoutes, isRetired } from './routing-browse';

const fact = { verdict: 'live' as const, reason: '好' };
const lr = (routeId: string, channelId: string, enabled: boolean): RoutingLayerRoute => ({
  routeId,
  channelId,
  channelName: channelId,
  poolId: 'p',
  hostId: 'claude-code',
  enabled,
  verdict: 'live',
  connect: fact,
  quota: fact,
  ban: fact,
  exhausted: [],
  inFlight: 0,
  reserved: 0,
  maxConcurrency: 2,
});

const layers: Pick<RoutingLayers, 'purposes'> = {
  purposes: [
    {
      purpose: 'execute',
      version: 0,
      verdict: 'live',
      problems: [],
      models: [
        {
          modelId: 'a',
          displayName: 'A',
          family: 'claude',
          verdict: 'live',
          routes: [lr('a1', 'c1', true), lr('a2', 'c2', false)],
        },
        { modelId: 'b', displayName: 'B', verdict: 'dead', routes: [] },
      ],
    },
    {
      purpose: 'verify',
      version: 0,
      verdict: 'live',
      problems: [],
      models: [
        {
          modelId: 'a',
          displayName: 'A',
          family: 'claude',
          verdict: 'live',
          routes: [lr('a1', 'c1', true), lr('a2', 'c2', false)],
        },
      ],
    },
  ],
};

const models: Model[] = [
  { id: 'a', family: 'claude', displayName: 'A' },
  { id: 'b', family: 'x', displayName: 'B' },
  { id: 'z', family: 'grok', displayName: 'Z 没配', retiredAt: '2026-01-01T00:00:00.000Z' },
  { id: 'y', family: 'grok', displayName: 'Y 没配' },
];
const route = (id: string, modelId: string, channelId: string): Route => ({
  id,
  channelId,
  poolId: 'p',
  modelId,
  hostId: 'grok',
  alive: false,
});
const routes: Route[] = [
  route('a1', 'a', 'c1'),
  route('a2', 'a', 'c2'),
  route('z1', 'z', 'c1'),
  route('z2', 'z', 'c3'),
];

describe('buildCatalog', () => {
  const catalog = buildCatalog(layers, { models, routes });

  test('配进用途的在前（按用途里的先后），同一个模型只一行，用途合并；没配进的接在后面按名字排', () => {
    expect(catalog.map((e) => e.modelId)).toEqual(['a', 'b', 'y', 'z']);
    expect(catalog[0]?.purposes).toEqual(['execute', 'verify']);
  });

  test('配进用途的：开关状态读得到，下面至少一条开着就算开；一条路由都没有的读不到', () => {
    const a = catalog[0];
    expect(a).toMatchObject({ switchKnown: true, enabled: true, routeCount: 2, verdict: 'live' });
    const b = catalog[1];
    expect(b).toMatchObject({ switchKnown: false, enabled: false, routeCount: 0, verdict: 'dead' });
  });

  test('没配进任何用途的：列出来，结论和开关都是「读不到」（不画成活、不画成开），路由数照目录数', () => {
    const z = catalog.find((e) => e.modelId === 'z');
    expect(z).toMatchObject({
      verdict: null,
      switchKnown: false,
      enabled: false,
      routeCount: 2,
      purposes: [],
    });
    expect(z?.routes).toEqual([]);
  });

  test('目录没读到：只剩配进用途的模型', () => {
    expect(buildCatalog(layers, undefined).map((e) => e.modelId)).toEqual(['a', 'b']);
  });

  test('isRetired：下架时间过了才算', () => {
    const z = catalog.find((e) => e.modelId === 'z');
    const y = catalog.find((e) => e.modelId === 'y');
    const now = Date.parse('2026-10-09T00:00:00.000Z');
    expect(z && isRetired(z, now)).toBe(true);
    expect(y && isRetired(y, now)).toBe(false);
  });
});

describe('channelRoutes', () => {
  test('渠道下配进用途的路由（去重、带所属模型）和没配进任何用途的路由分开', () => {
    const c1 = channelRoutes('c1', layers, { models, routes });
    expect(c1.inLayers.map((x) => [x.route.routeId, x.modelId])).toEqual([['a1', 'a']]);
    expect(c1.others.map((x) => [x.route.id, x.modelName])).toEqual([['z1', 'Z 没配']]);
    const c3 = channelRoutes('c3', layers, { models, routes });
    expect(c3.inLayers).toEqual([]);
    expect(c3.others.map((x) => x.route.id)).toEqual(['z2']);
  });
});
