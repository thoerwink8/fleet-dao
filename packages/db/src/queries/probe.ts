// 路由探针（design 第九节「路由探针」）：读每条路由探得了探不了的事实，写一条路由的结论。
// routes.alive 只由探针和熔断写：这里是探针那一半。库里约束 alive 为真时结论必须是 ok，不许拿默认值、手改冒充在线。
import type { BillingKind, HostId, OrgKind, RouteProbeState } from '@fleet-dao/shared';
import { asc, eq } from 'drizzle-orm';
import type { Db } from '../client.ts';
import { routesInUse } from '../routing-layers.ts';
import { channels, models, pools, routes } from '../schema/index.ts';
import { noteRouteProbed } from './channel-fallback.ts';

export interface RouteProbeTarget {
  routeId: string;
  hostId: HostId;
  channelId: string;
  channelName: string;
  billing: BillingKind;
  channelEnabled: boolean;
  poolId: string;
  /** 这个池的会话跑在哪个系统用户下（pools.run_as_user）；空 = 还没定。 */
  runAsUser: string | null;
  /** Claude 订阅池对应的组织类型（pools.org_kind）：会话用户挂着别的组织时探它扣的是别的池。 */
  orgKind: OrgKind | null;
  modelId: string;
  modelName: string;
  /** 插头实际发给上游的模型串（routes.upstream_model）；空 = 按模型目录的 id。 */
  upstreamModel: string | null;
  modelRetiredAt: Date | null;
  /**
   * 有用途在用（路由两层：它在自己的模型下开着，这个模型又排进了至少一个用途，routing-layers.ts 的 routesInUse）：
   * 选路派不到的路由不花额度去探。
   */
  inUse: boolean;
  alive: boolean;
  /** 上一次的结论；探针还没看过为空。 */
  previous: { state: RouteProbeState; at: Date; detail: string | null } | null;
}

/** 全部路由，按 id 排。连不上库、查询出错原样抛出（这一轮没跑成，由调用方记 failed）。 */
export async function routeProbeTargets(db: Db): Promise<RouteProbeTarget[]> {
  const [rows, used] = await Promise.all([
    db
      .select({ route: routes, pool: pools, channel: channels, model: models })
      .from(routes)
      .innerJoin(pools, eq(pools.id, routes.poolId))
      .innerJoin(channels, eq(channels.id, routes.channelId))
      .innerJoin(models, eq(models.id, routes.modelId))
      .orderBy(asc(routes.id)),
    routesInUse(db),
  ]);
  const inUse = new Set(used.map((u) => u.routeId));
  return rows.map(({ route, pool, channel, model }) => ({
    routeId: route.id,
    hostId: route.hostId,
    channelId: channel.id,
    channelName: channel.name,
    billing: channel.billing,
    channelEnabled: channel.enabled,
    poolId: pool.id,
    runAsUser: pool.runAsUser,
    orgKind: pool.orgKind,
    modelId: model.id,
    modelName: model.displayName,
    upstreamModel: route.upstreamModel,
    modelRetiredAt: model.retiredAt,
    inUse: inUse.has(route.id),
    alive: route.alive,
    previous:
      route.probeState === null || route.probedAt === null
        ? null
        : { state: route.probeState, at: route.probedAt, detail: route.probeDetail },
  }));
}

export interface RouteProbeWrite {
  routeId: string;
  state: RouteProbeState;
  /** 下这个结论的时刻。 */
  at: Date;
  /** 不是 ok 必须写原因（库里约束）；ok 也带一句。 */
  detail: string;
  /**
   * Claude 订阅池的路由：下这个结论时会话用户挂的是哪个组织（routes.probe_org）；读不到、不是 Claude 订阅池给 null。
   * 不给按 null 写（老的调用方）：不留上一次的，免得这个结论配上别的时候读到的组织。
   */
  org?: OrgKind | null;
}

/**
 * 写一条路由的结论：只有 ok 让它在线，其余一律不在线（alive、结论、那时挂的组织在同一条语句里写，不会一半）。
 * 路由已经不在了（这一轮当中被删）回 route_not_found；别的出错（约束不让写、库连不上）原样抛出。
 */
export async function saveRouteProbe(db: Db, w: RouteProbeWrite): Promise<'saved' | 'route_not_found'> {
  // 渠道近态（channel_states，#1118）跟着同一个事务：探通了引发 disabled 的那条路由就改回 ok，探针看过的时刻记下
  return db.transaction(async (tx) => {
    const updated = await tx
      .update(routes)
      .set({
        alive: w.state === 'ok',
        probeState: w.state,
        probedAt: w.at,
        probeDetail: w.detail,
        probeOrg: w.org ?? null,
      })
      .where(eq(routes.id, w.routeId))
      .returning({ id: routes.id });
    if (updated.length === 0) return 'route_not_found';
    await noteRouteProbed(tx, { routeId: w.routeId, state: w.state, at: w.at });
    return 'saved';
  });
}
