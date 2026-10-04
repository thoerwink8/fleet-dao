// 路由两层的读法（#574）：把 routing_purpose_models / routing_catalog 读成「用途 → 模型 → 路由」，每一层写明现在活着吗、为什么。
// 选路（queries/engine-route-facts.ts 的 routeFactsForPurpose）、驾驶舱、探针都按这两张表：先后是用途下模型的先后，再是模型下路由的先后。
// 「接得上、额度够、没被禁令挡」不在这里再判一遍：路由一条条交给 evaluateRoutes（「为什么不能用」只有这一处判法），再由
// livenessOf 读成三件事。
// 空的一层是 dead（整层没人，派不出去），不是 live；没配的用途同理，写在 problems 里。
import type { StageKind } from '@fleet-dao/shared';
import { and, asc, eq, inArray } from 'drizzle-orm';
import type { Db } from './client.ts';
import { evaluateRoutes, type RouteCandidate } from './queries/candidates.ts';
import { QUOTA_STALE_AFTER_MS } from './queries/quota.ts';
import {
  type LivenessVerdict,
  layerLiveness,
  livenessOf,
  type RoutingLiveness,
  routeLiveness,
} from './routing-liveness.ts';
import { channels, models, pools, routes, routingCatalog, routingPurposeModels } from './schema/index.ts';

export interface RoutingRouteView {
  /** 选路用的候选（含 blockers、窗口、禁令原因）。 */
  candidate: RouteCandidate;
  liveness: RoutingLiveness;
  verdict: LivenessVerdict;
}

export interface RoutingModelView {
  modelId: string;
  position: number;
  /** 这个模型下的路由，按 routing_catalog 的先后。 */
  routes: RoutingRouteView[];
  verdict: LivenessVerdict;
}

export interface RoutingLayers {
  purpose: StageKind;
  /** 这个用途的模型，按 routing_purpose_models 的先后。空 = 这个用途没配模型顺序（problems 里写明）。 */
  models: RoutingModelView[];
  verdict: LivenessVerdict;
  /** 这一层空着、或模型没有路由这类配置上的缺口；照实写，不当成「没有」。 */
  problems: string[];
}

export async function routingLayers(
  db: Db,
  purpose: StageKind,
  options: { now?: Date; staleAfterMs?: number } = {},
): Promise<RoutingLayers> {
  const now = options.now ?? new Date();
  const staleAfterMs = options.staleAfterMs ?? QUOTA_STALE_AFTER_MS;
  const problems: string[] = [];

  const upper = await db
    .select()
    .from(routingPurposeModels)
    .where(eq(routingPurposeModels.purpose, purpose))
    .orderBy(asc(routingPurposeModels.position));
  if (upper.length === 0) {
    problems.push(`用途 ${purpose} 没配模型顺序`);
    return { purpose, models: [], verdict: 'dead', problems };
  }

  // 下层一次查齐、一次交给 evaluateRoutes（额度窗、禁令、在途数各查一遍，不按模型各查一遍）；它不丢行、不改顺序。
  const lower = await db
    .select({ order: routingCatalog, route: routes, pool: pools, channel: channels, model: models })
    .from(routingCatalog)
    .innerJoin(routes, and(eq(routes.id, routingCatalog.routeId), eq(routes.modelId, routingCatalog.modelId)))
    .innerJoin(pools, eq(pools.id, routes.poolId))
    .innerJoin(channels, eq(channels.id, routes.channelId))
    .innerJoin(models, eq(models.id, routes.modelId))
    .where(
      inArray(
        routingCatalog.modelId,
        upper.map((u) => u.modelId),
      ),
    )
    .orderBy(asc(routingCatalog.modelId), asc(routingCatalog.position));
  const candidates =
    lower.length === 0 ? [] : await evaluateRoutes(db, purpose, lower, { now, staleAfterMs });
  const byModel = new Map<string, RoutingRouteView[]>();
  for (const candidate of candidates) {
    const liveness = livenessOf(candidate);
    const list = byModel.get(candidate.modelId) ?? [];
    list.push({ candidate, liveness, verdict: routeLiveness(liveness) });
    byModel.set(candidate.modelId, list);
  }

  const views = upper.map((u): RoutingModelView => {
    const routeViews = byModel.get(u.modelId) ?? [];
    if (routeViews.length === 0) problems.push(`模型 ${u.modelId} 没有路由（routing_catalog 里一条都没有）`);
    return {
      modelId: u.modelId,
      position: u.position,
      routes: routeViews,
      verdict: layerLiveness(routeViews.map((r) => r.verdict)),
    };
  });
  return { purpose, models: views, verdict: layerLiveness(views.map((m) => m.verdict)), problems };
}

/** 两层摊平成选路的先后：用途下模型的先后，再是模型下路由的先后（不按活不活重排，活不活由选路判）。 */
export function flattenRoutingLayers(layers: RoutingLayers): RouteCandidate[] {
  return layers.models.flatMap((m) => m.routes.map((r) => r.candidate));
}

/**
 * 「有用途在用」的路由：挂在某个模型下、开着，而且这个模型排进了至少一个用途的模型顺序。选路只会派到这些路由上，所以路由探针
 * 只探它们（不在用的不花额度去探，queries/probe.ts），会话用户挂的组织也只按它们看哪些额度窗管着这个池（queries/session-org.ts）。
 * 回的是查询本身：可以 await 成行，也可以放进 inArray 当子查询。
 */
export function routesInUse(db: Db) {
  return db
    .selectDistinct({ routeId: routingCatalog.routeId })
    .from(routingCatalog)
    .innerJoin(routingPurposeModels, eq(routingPurposeModels.modelId, routingCatalog.modelId))
    .where(eq(routingCatalog.enabled, true));
}
