// 选路事实：按路由两层读一个用途下每条路由的池、模型、探针、额度窗、在途和占位、挡因。
import type { HostId, OrgKind, QuotaWindowKind, StageKind } from '@fleet-dao/shared';
import { eq, inArray } from 'drizzle-orm';
import type { Db } from '../client.ts';
import { flattenRoutingLayers, routingLayers } from '../routing-layers.ts';
import { channels, models, pools, quotaWindows, routes } from '../schema/index.ts';
import type { Blocker, RouteCandidate } from './candidates.ts';

/** 没有的话来 candidates.ts 已算好的比例，反过来（1 - 比例）会在超额（>100%）时把信息夹没，所以单独写一份。 */
function usedRatio(w: {
  utilization: number | null;
  used: number | null;
  limit: number | null;
}): number | null {
  if (w.utilization !== null) return w.utilization;
  if (w.used !== null && w.limit !== null && w.limit > 0) return w.used / w.limit;
  return null;
}

export interface PurposeRouteFacts {
  purpose: StageKind;
  /** 这个用途配过模型顺序没有（routing_purpose_models 里有没有它的行）。没配就派不出，不按 id 乱挑。 */
  configured: boolean;
  /**
   * 选路的先后：用途下模型的先后、再是模型下路由的先后，摊平成一串，位置从 0 数（routing-layers.ts）。开关是那条路由在它的模型下
   * 开没开（routing_catalog.enabled，不分用途）；关着的照样排在里面，选路按 switched-off 挡。两层没有「钉住」：选路按没钉住算。
   */
  order: { routeId: string; position: number; enabled: boolean }[];
  /** 配置上的缺口（用途没有模型、模型下一条路由都没有）：照实给出，派不出时写进原因，不当成「没有」。 */
  problems: string[];
  routes: {
    routeId: string;
    channelId: string;
    /** 渠道的显示名（channels.name，例如「Claude 订阅」）：选路给人看的池名从它拼，不带账号。 */
    channelName: string;
    poolId: string;
    poolRunAsUser: string | null;
    /** Claude 订阅池对应的组织类型（pools.org_kind）：会话用户挂着哪个组织，只有那个池能派。别的池 null。 */
    poolOrgKind: OrgKind | null;
    modelId: string;
    modelName: string;
    family: string;
    hostId: HostId;
    upstreamModel: string | null;
    upstreamAliases: string[];
    /** Mirasim 记下的执行体（routes.executor）。别的执行方式也读出来，选路只用在 mirasim 上。 */
    executor: string | null;
    /** 路由探针最近一次下结论的时刻（候选查询的 probedAt）：在线的一定有，过没过期由选路判。 */
    probedAt: Date | null;
    /** 那次结论是什么、下结论时会话用户挂的是哪个组织（候选查询的 probeState、probeOrg）。 */
    probeState: RouteCandidate['probeState'];
    probeOrg: RouteCandidate['probeOrg'];
    quota: 'ok' | 'exhausted' | 'unknown';
    windows: {
      label: string;
      window: QuotaWindowKind;
      scope: string | null;
      state: 'ok' | 'exhausted' | 'stale' | 'reset';
      applies: 'yes' | 'unknown';
      used: number | null;
      resetsAt: Date | null;
      reading: 'measured' | 'estimated';
      readAt: Date;
      staleSince: Date | null;
    }[];
    inFlight: number;
    reserved: number;
    maxConcurrency: number;
    banReasons: string[];
    blockers: Blocker[];
  }[];
}

/**
 * 选路的事实，按路由两层读（#574，routing-layers.ts）：在 evaluateRoutes 算好的挡法上加字段，不重判一遍谁能派谁不能派。
 * routing_catalog 里 enabled=false 的行带着 'switched-off' 这个挡因，这里原样透出到 order。
 */
export async function routeFactsForPurpose(
  db: Db,
  purpose: StageKind,
  options: { now?: Date; staleAfterMs?: number } = {},
): Promise<PurposeRouteFacts> {
  const layers = await routingLayers(db, purpose, options);
  const configured = layers.models.length > 0;
  const sorted = flattenRoutingLayers(layers);
  const order = sorted.map((c, position) => ({
    routeId: c.routeId,
    position,
    enabled: !c.blockers.includes('switched-off'),
  }));
  if (sorted.length === 0) return { purpose, configured, order, problems: layers.problems, routes: [] };

  const routeIds = sorted.map((c) => c.routeId);
  const poolIds = [...new Set(sorted.map((c) => c.poolId))];
  const [detailRows, windowRows] = await Promise.all([
    db
      .select({
        routeId: routes.id,
        upstreamModel: routes.upstreamModel,
        upstreamAliases: routes.upstreamAliases,
        executor: routes.executor,
        poolRunAsUser: pools.runAsUser,
        poolOrgKind: pools.orgKind,
        modelName: models.displayName,
        channelName: channels.name,
      })
      .from(routes)
      .innerJoin(pools, eq(pools.id, routes.poolId))
      .innerJoin(models, eq(models.id, routes.modelId))
      .innerJoin(channels, eq(channels.id, routes.channelId))
      .where(inArray(routes.id, routeIds)),
    db.select().from(quotaWindows).where(inArray(quotaWindows.poolId, poolIds)),
  ]);
  const detailByRoute = new Map(detailRows.map((r) => [r.routeId, r]));
  const windowByKey = new Map(windowRows.map((w) => [`${w.poolId}\u0000${w.label}`, w]));

  const routesOut = sorted.map((c) => {
    const detail = detailByRoute.get(c.routeId);
    if (!detail) throw new Error(`路由 ${c.routeId} 查不到渠道 / 池 / 模型详情`);
    return {
      routeId: c.routeId,
      channelId: c.channelId,
      channelName: detail.channelName,
      poolId: c.poolId,
      poolRunAsUser: detail.poolRunAsUser,
      poolOrgKind: detail.poolOrgKind,
      modelId: c.modelId,
      modelName: detail.modelName,
      family: c.family,
      hostId: c.hostId,
      upstreamModel: detail.upstreamModel,
      upstreamAliases: detail.upstreamAliases,
      executor: detail.executor,
      probedAt: c.probedAt,
      probeState: c.probeState,
      probeOrg: c.probeOrg,
      quota: c.quota,
      windows: c.windows.map((w) => {
        const raw = windowByKey.get(`${c.poolId}\u0000${w.label}`);
        if (!raw) throw new Error(`额度窗 ${c.poolId}/${w.label} 在候选查询之后就没了`);
        return {
          label: w.label,
          window: w.window,
          scope: w.scope,
          state: w.state,
          applies: w.applies,
          used: usedRatio(raw),
          resetsAt: w.resetsAt,
          reading: raw.reading,
          readAt: w.readAt,
          staleSince: w.staleSince,
        };
      }),
      inFlight: c.inFlight,
      // 和 inFlight 同一次读出来（candidates.ts），Fusion 排着的、三段占着名额的都在里面（#757）
      reserved: c.reserved,
      maxConcurrency: c.maxConcurrency,
      banReasons: c.banReasons,
      blockers: c.blockers,
    };
  });

  return { purpose, configured, order, problems: layers.problems, routes: routesOut };
}
