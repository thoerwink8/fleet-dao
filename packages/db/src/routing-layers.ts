// 路由两层的读法（#574）：把 routing_purpose_models / routing_catalog 读成「用途 → 模型 → 路由」，每一层写明现在活着吗、为什么。
// 选路此刻仍读旧的 stage_policy_routes（specs/574 第 4 条），这里只给驾驶舱、对账、后续切换用。
// 「接得上、额度够、没被禁令挡」不在这里再判一遍：路由一条条交给选路用的 evaluateRoutes，再由 livenessOf 读成三件事。
// 空的一层是 dead（整层没人，派不出去），不是 live；没配的用途同理，写在 problems 里。
import type { StageKind } from '@fleet-dao/shared';
import { and, asc, eq } from 'drizzle-orm';
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
  routes: RoutingRouteView[];
  verdict: LivenessVerdict;
}

export interface RoutingLayers {
  purpose: StageKind;
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

  const views: RoutingModelView[] = [];
  for (const u of upper) {
    const lower = await db
      .select({ order: routingCatalog, route: routes, pool: pools, channel: channels, model: models })
      .from(routingCatalog)
      .innerJoin(
        routes,
        and(eq(routes.id, routingCatalog.routeId), eq(routes.modelId, routingCatalog.modelId)),
      )
      .innerJoin(pools, eq(pools.id, routes.poolId))
      .innerJoin(channels, eq(channels.id, routes.channelId))
      .innerJoin(models, eq(models.id, routes.modelId))
      .where(eq(routingCatalog.modelId, u.modelId))
      .orderBy(asc(routingCatalog.position));
    if (lower.length === 0) problems.push(`模型 ${u.modelId} 没有路由（routing_catalog 里一条都没有）`);
    const candidates = await evaluateRoutes(db, purpose, lower, { now, staleAfterMs });
    const routeViews = candidates.map((candidate): RoutingRouteView => {
      const liveness = livenessOf(candidate);
      return { candidate, liveness, verdict: routeLiveness(liveness) };
    });
    views.push({
      modelId: u.modelId,
      position: u.position,
      routes: routeViews,
      verdict: layerLiveness(routeViews.map((r) => r.verdict)),
    });
  }
  return { purpose, models: views, verdict: layerLiveness(views.map((m) => m.verdict)), problems };
}
