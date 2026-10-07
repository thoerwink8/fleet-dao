// 驾驶舱单子页「用哪个模型」（驾驶舱改版 2026-10-07：「每个任务能点进去随意切换模型」）：读、改一张单每段（动手、验收）指定的模型。
// 改这里之前必须知道：
// - 存在库里（task_route_pins，db 的 queries/task-route-pins.ts）：引擎每次给这一段选路时现读（engine 的 real/store-ports.ts），
//   在跑的这一轮不打断，下一次选路就照它。不发信号：任务工作流没有「中途换路由」的接收处（#901）。
// - 指定和操作记录在同一个事务里：记不下就不改。
// - 没接上（开发环境的内存版没有这张表）由接口写 unavailable、改的接口回 503；读不到、写不进抛，接口回 503 写明原因。
//   都不拿空列表冒充「没指定」。
import {
  auditLog,
  type Db,
  listTaskRoutePins,
  type SetTaskRoutePinInput,
  type SetTaskRoutePinResult,
  setTaskRoutePin,
  type TaskRoutePin,
} from '@fleet-dao/db';
import type { TaskRoutePinSchema } from '@fleet-dao/shared';
import type { z } from 'zod';
import type { NewAuditEntry } from './ports.ts';

/** 改指定的操作记录：前后两个值由改的那一步按库里实际的填。 */
export type PinAudit = Omit<NewAuditEntry, 'before' | 'after'>;

export interface TaskRoutePinsPort {
  /** 这张单每段的指定（含清掉了的）。读不到抛。 */
  list(taskId: string): Promise<TaskRoutePin[]>;
  /** 指定或清掉一段；改成了就在同一个事务里记操作记录。写不进抛。 */
  set(input: SetTaskRoutePinInput, audit: PinAudit): Promise<SetTaskRoutePinResult>;
}

const pinFacts = (p: TaskRoutePin | null) => (p ? { modelId: p.modelId, routeId: p.routeId } : null);

export function pgTaskRoutePins(db: Db, now: () => Date): TaskRoutePinsPort {
  return {
    list: (taskId) => listTaskRoutePins(db, taskId),
    set: (input, audit) =>
      db.transaction(async (tx) => {
        const result = await setTaskRoutePin(tx, input);
        if (!result.ok) return result;
        // 和 routing-efforts.ts 同一个写法（pg-store 的 insertAudit 是 Store 里的私有函数，这里另起一份写同一张表）
        await tx.insert(auditLog).values({
          at: now(),
          actorKind: audit.actor.kind,
          actorId: audit.actor.id,
          action: audit.action,
          target: audit.target,
          before: { segment: input.segment, pin: pinFacts(result.before) },
          after: { segment: input.segment, pin: pinFacts(result.after) },
          reason: audit.reason ?? null,
          via: audit.via,
          ok: audit.ok,
          error: audit.error ?? null,
        });
        return result;
      }),
  };
}

/** 开发环境、内存版：没有这张表。 */
export const TASK_ROUTE_PINS_NOT_HERE =
  '按单指定模型没接上：这里是开发环境的内存版，没有 task_route_pins 这张表，真库上才有';

/** 换成驾驶舱的形状。 */
export function taskRoutePinView(p: TaskRoutePin): z.input<typeof TaskRoutePinSchema> {
  return {
    segment: p.segment,
    ...(p.modelId === null ? {} : { modelId: p.modelId }),
    ...(p.routeId === null ? {} : { routeId: p.routeId }),
    setBy: p.setBy,
    setAt: p.setAt.toISOString(),
    ...(p.reason === null ? {} : { reason: p.reason }),
  };
}
