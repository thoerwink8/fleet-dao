// 驾驶舱「思考档位」页经 routingEffortRows 读、经 setRoutingEffort 写 routing_catalog.effort（#470）。
// 起会话不读这一列（#1958）：会话档位在 routing_purpose_models.effort，由 setPurposeModelEffort 改。
// 这一页仍留着，改的是路由上的旧列。这条路由的执行方式认不认这一档照 shared 的 routeEffortProblem 判，判不过一行不写、回原因。
import { type HostId, routeEffortProblem, type SessionEffort } from '@fleet-dao/shared';
import { and, asc, eq } from 'drizzle-orm';
import type { Db } from './client.ts';
import { channels, models, routes, routingCatalog } from './schema/index.ts';

/** 路由两层里的一条路由和它配的档位（驾驶舱「思考档位」页一行）。 */
export interface RoutingEffortRow {
  modelId: string;
  modelName: string;
  family: string;
  routeId: string;
  /** 在它的模型下的先后。 */
  position: number;
  enabled: boolean;
  /** 空 = 这一页没配。起会话不读这一列。 */
  effort: SessionEffort | null;
  hostId: HostId;
  upstreamModel: string | null;
  channelId: string;
  channelName: string;
  poolId: string;
}

/** 挂进路由两层的每一条路由（routing_catalog 的每一行），按模型编号、再按模型下的先后。读不到抛。 */
export async function routingEffortRows(db: Db): Promise<RoutingEffortRow[]> {
  const rows = await db
    .select({ order: routingCatalog, route: routes, channel: channels, model: models })
    .from(routingCatalog)
    .innerJoin(routes, and(eq(routes.id, routingCatalog.routeId), eq(routes.modelId, routingCatalog.modelId)))
    .innerJoin(channels, eq(channels.id, routes.channelId))
    .innerJoin(models, eq(models.id, routingCatalog.modelId))
    .orderBy(asc(routingCatalog.modelId), asc(routingCatalog.position));
  return rows.map(({ order, route, channel, model }) => ({
    modelId: order.modelId,
    modelName: model.displayName,
    family: model.family,
    routeId: order.routeId,
    position: order.position,
    enabled: order.enabled,
    effort: order.effort,
    hostId: route.hostId,
    upstreamModel: route.upstreamModel,
    channelId: channel.id,
    channelName: channel.name,
    poolId: route.poolId,
  }));
}

export interface SetRoutingEffortInput {
  modelId: string;
  routeId: string;
  /** 要改成的档位；null = 清掉这一列。起会话不读它（#1958）。 */
  effort: string | null;
  /** 调用方改之前看到的值：给了就比，库里已经不是它（别人刚改过）回 conflict、不覆盖。不给 = 不比。 */
  expected?: SessionEffort | null;
}

export type SetRoutingEffortResult =
  | { ok: true; before: SessionEffort | null; after: SessionEffort | null }
  | { ok: false; kind: 'not_found'; why: string }
  | { ok: false; kind: 'invalid'; why: string }
  | { ok: false; kind: 'conflict'; current: SessionEffort | null };

/** 能传事务进来（驾驶舱后端在同一个事务里再记操作记录）。 */
export async function setRoutingEffort(
  db: Db,
  input: SetRoutingEffortInput,
): Promise<SetRoutingEffortResult> {
  const { modelId, routeId, effort } = input;
  return db.transaction(async (tx) => {
    const [row] = await tx
      .select({ effort: routingCatalog.effort, hostId: routes.hostId, upstreamModel: routes.upstreamModel })
      .from(routingCatalog)
      .innerJoin(
        routes,
        and(eq(routes.id, routingCatalog.routeId), eq(routes.modelId, routingCatalog.modelId)),
      )
      .where(and(eq(routingCatalog.modelId, modelId), eq(routingCatalog.routeId, routeId)))
      .for('update');
    if (!row) {
      return { ok: false, kind: 'not_found', why: `模型 ${modelId} 下没有路由 ${routeId}（路由两层里没挂）` };
    }
    if (effort !== null) {
      const problem = routeEffortProblem(row.hostId, row.upstreamModel ?? modelId, effort);
      if (problem) return { ok: false, kind: 'invalid', why: problem };
    }
    if (input.expected !== undefined && row.effort !== input.expected) {
      return { ok: false, kind: 'conflict', current: row.effort };
    }
    // 上面判过：不是 null 就是认得的档
    const after = effort as SessionEffort | null;
    await tx
      .update(routingCatalog)
      .set({ effort: after })
      .where(and(eq(routingCatalog.modelId, modelId), eq(routingCatalog.routeId, routeId)));
    return { ok: true, before: row.effort, after };
  });
}
