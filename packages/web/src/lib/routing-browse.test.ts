// 路由页「模型目录」「渠道」两块的数据拼法（#1366 第二部分）：配进用途的模型带开关状态，没配进用途的照样列出但读不到开关。
import { describe, expect, test } from 'vitest';
import type { Model, Route, RoutingLayerRoute, RoutingLayers } from '../api/types';
import type { CatalogEntry } from './routing-browse';
import {
  buildCatalog,
  catalogMarks,
  channelRoutes,
  filterCatalog,
  flattenCatalog,
  groupCatalog,
  isRetired,
  NO_CATALOG_FILTER,
  supportedPurposeEfforts,
} from './routing-browse';

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

function entry(over: Partial<CatalogEntry> & Pick<CatalogEntry, 'modelId' | 'displayName'>): CatalogEntry {
  return {
    family: 'grok',
    verdict: null,
    routes: [],
    routeCount: 1,
    purposes: [],
    enabled: false,
    switchKnown: false,
    channelIds: ['ch-cursor'],
    discovered: false,
    ...over,
  };
}

describe('目录筛选、变体分组、用途档位', () => {
  const now = Date.parse('2026-10-09T00:00:00.000Z');
  const rows: CatalogEntry[] = [
    entry({ modelId: 'grok-4.7', displayName: 'Grok 4.7', family: 'grok', channelIds: ['xai'] }),
    entry({
      modelId: 'grok-4.7-fast',
      displayName: 'Grok 4.7 fast',
      family: 'grok',
      channelIds: ['cursor'],
    }),
    entry({
      modelId: 'cursor:grok-4.7[context=256k,fast=true]',
      displayName: 'grok-4.7[context=256k,fast=true]',
      family: 'grok',
      channelIds: ['cursor'],
      discovered: true,
    }),
    entry({
      modelId: 'opus-5',
      displayName: 'Opus 5',
      family: 'claude',
      retiredAt: '2026-01-01T00:00:00.000Z',
      channelIds: ['claude-sub'],
      switchKnown: true,
      enabled: false,
    }),
    entry({
      modelId: 'gpt-5.6-luna',
      displayName: 'GPT 5.6 luna',
      family: 'gpt',
      channelIds: ['mirasim'],
      switchKnown: true,
      enabled: false,
    }),
    entry({
      modelId: 'fable-5.1',
      displayName: 'Fable 5.1',
      family: 'claude',
      channelIds: ['mirasim'],
    }),
    entry({
      modelId: 'kimi-k3',
      displayName: 'Kimi k3',
      family: 'kimi',
      channelIds: ['mirasim'],
      switchKnown: true,
      enabled: true,
      purposes: ['execute'],
    }),
  ];

  test('同一模型的档位、fast、上下文并成一组；版本号不同的不并', () => {
    const groups = groupCatalog(rows);
    const grok = groups.find((g) => g.members.some((m) => m.modelId === 'grok-4.7'));
    expect(grok?.members.map((m) => m.modelId).sort()).toEqual([
      'cursor:grok-4.7[context=256k,fast=true]',
      'grok-4.7',
      'grok-4.7-fast',
    ]);
    expect(groups.find((g) => g.members.some((m) => m.modelId === 'opus-5'))?.members).toHaveLength(1);
    const flat = flattenCatalog(groups, new Set());
    expect(flat.some((row) => row.kind === 'group' && row.group.key === grok?.key)).toBe(true);
    expect(flat.some((row) => row.kind === 'entry' && row.entry.modelId === 'grok-4.7-fast')).toBe(false);
    const open = flattenCatalog(groups, new Set(grok ? [grok.key] : []));
    expect(
      open
        .filter((row) => row.kind === 'entry' && row.nested)
        .map((row) => row.kind === 'entry' && row.entry.modelId),
    ).toEqual(grok?.members.map((m) => m.modelId));
  });

  test('按厂家、渠道、状态筛；状态多选是或，和其他条件一起是并且', () => {
    expect(filterCatalog(rows, { ...NO_CATALOG_FILTER, vendor: 'grok' }, now).map((e) => e.modelId)).toEqual([
      'grok-4.7',
      'grok-4.7-fast',
      'cursor:grok-4.7[context=256k,fast=true]',
    ]);
    expect(
      filterCatalog(rows, { ...NO_CATALOG_FILTER, channel: 'cursor' }, now).map((e) => e.modelId),
    ).toEqual(['grok-4.7-fast', 'cursor:grok-4.7[context=256k,fast=true]']);
    expect(
      filterCatalog(rows, { ...NO_CATALOG_FILTER, statuses: ['retired'] }, now).map((e) => e.modelId),
    ).toEqual(['opus-5']);
    expect(
      filterCatalog(rows, { ...NO_CATALOG_FILTER, statuses: ['discovered'] }, now).map((e) => e.modelId),
    ).toEqual(['cursor:grok-4.7[context=256k,fast=true]']);
    expect(
      filterCatalog(rows, { ...NO_CATALOG_FILTER, statuses: ['off'] }, now)
        .map((e) => e.modelId)
        .sort(),
    ).toEqual(['gpt-5.6-luna', 'opus-5']);
    const locked = filterCatalog(rows, { ...NO_CATALOG_FILTER, statuses: ['locked'] }, now).map(
      (e) => e.modelId,
    );
    expect(locked.sort()).toEqual(['fable-5.1', 'gpt-5.6-luna']);
    expect(
      filterCatalog(
        rows,
        { ...NO_CATALOG_FILTER, vendor: 'claude', statuses: ['locked', 'retired'] },
        now,
      ).map((e) => e.modelId),
    ).toEqual(['opus-5', 'fable-5.1']);
  });

  test('醒目标记：新发现、已下架、锁住（Fable 只许创始人开、GPT 不做界面）', () => {
    const marked = (id: string): CatalogEntry => {
      const found = rows.find((item) => item.modelId === id);
      if (!found) throw new Error(`缺 ${id}`);
      return found;
    };
    expect(catalogMarks(marked('cursor:grok-4.7[context=256k,fast=true]'), now)).toMatchObject({
      discovered: true,
      locked: false,
      retired: false,
    });
    expect(catalogMarks(marked('opus-5'), now)).toMatchObject({ retired: true, off: true });
    expect(catalogMarks(marked('gpt-5.6-luna'), now).lockWhy).toContain('GPT');
    expect(catalogMarks(marked('fable-5.1'), now).lockWhy).toContain('创始人');
    expect(catalogMarks(marked('kimi-k3'), now).locked).toBe(false);
  });

  test('用途档位只列这个模型每条路由都认的档；Grok 没有 max，没路由时五档都认', () => {
    expect(supportedPurposeEfforts('grok-4.7', [{ hostId: 'grok' }])).toEqual([
      'low',
      'medium',
      'high',
      'xhigh',
    ]);
    expect(supportedPurposeEfforts('opus-5.5', [{ hostId: 'claude-code' }])).toEqual([
      'low',
      'medium',
      'high',
      'xhigh',
      'max',
    ]);
    expect(supportedPurposeEfforts('mix', [{ hostId: 'grok' }, { hostId: 'claude-code' }])).toEqual([
      'low',
      'medium',
      'high',
      'xhigh',
    ]);
    expect(supportedPurposeEfforts('orphan', [])).toEqual(['low', 'medium', 'high', 'xhigh', 'max']);
    expect(
      supportedPurposeEfforts('cursor-auto', [{ hostId: 'cursor-agent', upstreamModel: 'composer-2.5' }]),
    ).toEqual([]);
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
