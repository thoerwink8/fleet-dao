// 改一条路由的思考档位（#470）：驾驶舱的「改档位」经它写 routing_catalog.effort。档位是运行时配置、留在库里（决定 0011
// 第 7 条），不走「改仓库再部署」；引擎起会话时现读（queries/engine.ts 的 routeLaunchFacts），改完下一个会话就照新的。
// 这条路由的执行方式认不认这一档照 shared 的 routeEffortProblem 判（和骨架装载、引擎起会话同一份判法），判不过一行不写、回原因。
import { routeEffortProblem, type SessionEffort } from '@fleet-dao/shared';
import { and, eq } from 'drizzle-orm';
import type { Db } from './client.ts';
import { routes, routingCatalog } from './schema/index.ts';

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
    return { ok: true, before: row.effort, after };
  });
}
