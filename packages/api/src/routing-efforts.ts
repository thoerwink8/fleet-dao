// 驾驶舱「思考档位」页（#470）：路由两层里每个模型下的每条路由起会话想多深——读、改。
// 改这里之前必须知道：
// - 档位是运行时配置、留在库里（决定 0011 第 7 条）：改了直接写库，引擎下一个起的会话就照它（起会话时现读），不开 PR。
// - 这条路由能配哪几档、配的认不认，只照 shared 的 effort.ts 判（routeEffortChoices；写库的 db setRoutingEffort 照
//   routeEffortProblem 判），和引擎起会话、骨架装载同一份判法，这里不另判一遍。
// - 没接上（开发环境的内存版没有路由两层那张表）由接口写 unavailable、改的接口回 503；读不到、写不进抛，接口回 503 写明原因。
//   都不拿空列表冒充「都没配」。
// - 改档位和操作记录在同一个事务里：记不下就不改。
import {
  auditLog,
  type Db,
  type RoutingEffortRow,
  routingEffortRows,
  type SetRoutingEffortInput,
  type SetRoutingEffortResult,
  setRoutingEffort,
} from '@fleet-dao/db';
import { type EffortModelSchema, routeEffortChoices } from '@fleet-dao/shared';
import type { z } from 'zod';
import type { NewAuditEntry } from './ports.ts';

/** 改档位的操作记录：前后两个值由改的那一步按库里实际的填。 */
export type EffortAudit = Omit<NewAuditEntry, 'before' | 'after'>;

export interface RoutingEffortsPort {
  /** 挂进路由两层的每条路由和它配的档位。读不到抛。 */
  read(): Promise<RoutingEffortRow[]>;
  /** 改一条路由的档位；改成了就在同一个事务里记操作记录。写不进抛。 */
  set(input: SetRoutingEffortInput, audit: EffortAudit): Promise<SetRoutingEffortResult>;
}

export function pgRoutingEfforts(db: Db, now: () => Date): RoutingEffortsPort {
  return {
    read: () => routingEffortRows(db),
    set: (input, audit) =>
      db.transaction(async (tx) => {
        const result = await setRoutingEffort(tx, input);
        if (!result.ok) return result;
        // 和 pg-store 的 insertAudit 同一个写法（那份是 Store 里的私有函数，这里另起一份写同一张表）
        await tx.insert(auditLog).values({
          at: now(),
          actorKind: audit.actor.kind,
          actorId: audit.actor.id,
          action: audit.action,
          target: audit.target,
          before: { modelId: input.modelId, effort: result.before },
          after: { modelId: input.modelId, effort: result.after },
          reason: audit.reason ?? null,
          via: audit.via,
          ok: audit.ok,
          error: audit.error ?? null,
        });
        return result;
      }),
  };
}

/** 开发环境、内存版：没有路由两层那张表。 */
export const ROUTING_EFFORTS_NOT_HERE =
  '思考档位没接上：这里是开发环境的内存版，没有路由两层那张表（routing_catalog），真库上才有';

/** 换成驾驶舱的形状：按模型分组（保持读出来的先后），每条路由带能配哪几档、配不了的原因。 */
export function routingEffortsView(rows: readonly RoutingEffortRow[]): z.input<typeof EffortModelSchema>[] {
  const byModel = new Map<string, z.input<typeof EffortModelSchema>>();
  for (const row of rows) {
    const model = byModel.get(row.modelId) ?? {
      modelId: row.modelId,
      displayName: row.modelName,
      family: row.family,
      routes: [],
    };
    const sent = row.upstreamModel ?? row.modelId;
    const choices = routeEffortChoices(row.hostId, sent);
    model.routes.push({
      routeId: row.routeId,
      channelId: row.channelId,
      channelName: row.channelName,
      poolId: row.poolId,
      hostId: row.hostId,
      model: sent,
      enabled: row.enabled,
      ...(row.effort === null ? {} : { effort: row.effort }),
      choices: choices.kind === 'choices' ? [...choices.values] : [],
      ...(choices.kind === 'fixed' ? { fixed: choices.why } : {}),
    });
    byModel.set(row.modelId, model);
  }
  return [...byModel.values()];
}
