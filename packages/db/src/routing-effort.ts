// 路由两层里每条路由的思考档位（#470）：驾驶舱「思考档位」页经 routingEffortRows 读、经 setRoutingEffort 写。
// 起会话只读 routing_purpose_models.effort（#1967）。这一页改一条路由时，把这个模型在每个用途里的档写成同一个值，
// routing_catalog.effort 跟着写，但起会话不读它。档位是运行时配置、留在库里（决定 0011
// 第 7 条），不走「改仓库再部署」；引擎起会话时现读（queries/engine-launch-facts.ts 的 routeLaunchFacts），改完下一个会话就照新的。
// 这条路由的执行方式认不认这一档照 shared 的 routeEffortProblem 判（和骨架装载、引擎起会话同一份判法），判不过一行不写、回原因。
import { type HostId, routeEffortProblem, type SessionEffort, type StageKind } from '@fleet-dao/shared';
import { and, asc, eq } from 'drizzle-orm';
import type { Db } from './client.ts';
import {
  channels,
  models,
  routes,
  routingCatalog,
  routingPurposeModels,
  routingPurposeRevisions,
} from './schema/index.ts';

/**
 * 这个用途的版本加一（routing_purpose_revisions；没有这一行就写成 1）。和 routing-order.ts 的 bumpPurposeVersion 同一个写法：
 * 先锁版本行（和 lockPurpose 同一顺序：先用途成员行、再版本行，不换序就不互相等），没有这一行才插。
 */
async function bumpPurposeRevision(tx: Db, purpose: StageKind): Promise<void> {
  const [rev] = await tx
    .select({ version: routingPurposeRevisions.version })
    .from(routingPurposeRevisions)
    .where(eq(routingPurposeRevisions.purpose, purpose))
    .for('update');
  if (rev) {
    await tx
      .update(routingPurposeRevisions)
      .set({ version: rev.version + 1 })
      .where(eq(routingPurposeRevisions.purpose, purpose));
  } else {
    await tx.insert(routingPurposeRevisions).values({ purpose, version: 1 });
  }
}

/** 路由两层里的一条路由和它配的档位（驾驶舱「思考档位」页一行）。 */
export interface RoutingEffortRow {
  modelId: string;
  modelName: string;
  family: string;
  routeId: string;
  /** 在它的模型下的先后。 */
  position: number;
  enabled: boolean;
  /** 空 = 没配（起会话用 high）。 */
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
  /** 要改成的档位；null = 清掉、回到没配（起会话用 high）。 */
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
    // 起会话只读用途表。这一页按路由改，同根写到这个模型的每一个用途上（各用途原先不同档的，以这一次为准）。
    // 用途表动了，那些用途的版本（routing_purpose_revisions）跟着加一：驾驶舱「用途」页带着自己看到的版本改档位，
    // 版本不加它下一次改就会拿过期的版本、把这一次的档位悄悄盖掉（routing-order.ts 的 setPurposeModelEffort 照版本判冲突）。
    const purposeRows = await tx
      .select({ purpose: routingPurposeModels.purpose })
      .from(routingPurposeModels)
      .where(eq(routingPurposeModels.modelId, modelId))
      .for('update');
    await tx
      .update(routingPurposeModels)
      .set({ effort: after })
      .where(eq(routingPurposeModels.modelId, modelId));
    for (const { purpose } of purposeRows) await bumpPurposeRevision(tx, purpose);
    return { ok: true, before: row.effort, after };
  });
}
