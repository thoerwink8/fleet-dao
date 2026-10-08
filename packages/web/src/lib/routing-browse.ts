// 路由页「模型目录」「渠道」两块的数据（#1366 第二部分）：把路由两层（只含配进用途的模型）和路由目录（全部模型、渠道、路由）并成
// 一行一个模型、一行一个渠道。只做拼，不判活不活（判法在后端 routing-liveness.ts，页面只读）。
// 开关状态只有路由两层里有：没配进任何用途的模型读不到它的路由开着没有，如实标出来，不猜、不画成开或关。

import type {
  LivenessVerdict,
  Model,
  Route,
  RoutingLayerPurpose,
  RoutingLayerRoute,
  RoutingLayers,
} from '../api/types';

export interface CatalogEntry {
  modelId: string;
  displayName: string;
  family: string;
  /** 在路由两层里的结论；没配进任何用途 = null（没人算过，不画成活也不画成死）。 */
  verdict: LivenessVerdict | null;
  /** 路由两层里这个模型下的路由（带开关、三件事）；没配进用途为空。 */
  routes: RoutingLayerRoute[];
  /** 目录里这个模型下一共几条路由（没配进用途的也数）。 */
  routeCount: number;
  /** 配进了哪些用途（用途编号，按页面顺序）。 */
  purposes: RoutingLayerPurpose['purpose'][];
  /** 下面至少一条路由开着。没配进用途的读不到，按 false，调用方另看 switchKnown。 */
  enabled: boolean;
  /** 能不能读到开关状态：配进了用途且下面有路由才读得到。 */
  switchKnown: boolean;
  /** 目录里的下架时间；没下架没有。 */
  retiredAt?: string;
}

export function buildCatalog(
  layers: Pick<RoutingLayers, 'purposes'>,
  routing: { models: readonly Model[]; routes: readonly Route[] } | undefined,
): CatalogEntry[] {
  const entries = new Map<string, CatalogEntry>();
  const info = new Map((routing?.models ?? []).map((m) => [m.id, m]));
  const rawCount = new Map<string, number>();
  for (const r of routing?.routes ?? []) rawCount.set(r.modelId, (rawCount.get(r.modelId) ?? 0) + 1);

  for (const p of layers.purposes) {
    for (const m of p.models) {
      const have = entries.get(m.modelId);
      if (have) {
        if (!have.purposes.includes(p.purpose)) have.purposes.push(p.purpose);
        continue;
      }
      const meta = info.get(m.modelId);
      entries.set(m.modelId, {
        modelId: m.modelId,
        displayName: m.displayName,
        family: m.family ?? meta?.family ?? '',
        verdict: m.verdict,
        routes: m.routes,
        routeCount: Math.max(m.routes.length, rawCount.get(m.modelId) ?? 0),
        purposes: [p.purpose],
        enabled: m.routes.some((r) => r.enabled),
        switchKnown: m.routes.length > 0,
        ...(meta?.retiredAt ? { retiredAt: meta.retiredAt } : {}),
      });
    }
  }

  const rest = (routing?.models ?? [])
    .filter((m) => !entries.has(m.id))
    .map(
      (m): CatalogEntry => ({
        modelId: m.id,
        displayName: m.displayName,
        family: m.family,
        verdict: null,
        routes: [],
        routeCount: rawCount.get(m.id) ?? 0,
        purposes: [],
        enabled: false,
        switchKnown: false,
        ...(m.retiredAt ? { retiredAt: m.retiredAt } : {}),
      }),
    )
    .sort((a, b) => a.displayName.localeCompare(b.displayName) || a.modelId.localeCompare(b.modelId));
  return [...entries.values(), ...rest];
}

export const isRetired = (e: Pick<CatalogEntry, 'retiredAt'>, now: number): boolean =>
  e.retiredAt !== undefined && Date.parse(e.retiredAt) <= now;

/** 渠道下的路由：配进了用途的（带开关）和目录里有、没配进任何用途的（读不到开关）。 */
export interface ChannelRoutes {
  inLayers: { route: RoutingLayerRoute; modelId: string; modelName: string }[];
  others: { route: Route; modelName: string }[];
}

export function channelRoutes(
  channelId: string,
  layers: Pick<RoutingLayers, 'purposes'>,
  routing: { models: readonly Model[]; routes: readonly Route[] } | undefined,
): ChannelRoutes {
  const seen = new Set<string>();
  const inLayers: ChannelRoutes['inLayers'] = [];
  for (const p of layers.purposes) {
    for (const m of p.models) {
      for (const r of m.routes) {
        if (r.channelId !== channelId || seen.has(r.routeId)) continue;
        seen.add(r.routeId);
        inLayers.push({ route: r, modelId: m.modelId, modelName: m.displayName });
      }
    }
  }
  const names = new Map((routing?.models ?? []).map((m) => [m.id, m.displayName]));
  const others = (routing?.routes ?? [])
    .filter((r) => r.channelId === channelId && !seen.has(r.id))
    .map((route) => ({ route, modelName: names.get(route.modelId) ?? route.modelId }));
  return { inLayers, others };
}
