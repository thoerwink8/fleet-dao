// 认领只有一处（决定 0124）：旧引擎拉单、点名派单、本机领取、新内核都写 tasks.owner 这一列。
// 租约过期不自动转手：原执行方的会话还在（这张单上有 ended_at 为空的 runs），只把 doing 标成「待确认释放」；
// 会话都结束了才允许改 owner。没有会话记录就确认不了停没停，不转手。
import type { TaskOwner } from '@fleet-dao/shared';
import { and, eq, isNotNull, isNull } from 'drizzle-orm';
import type { Db } from '../client.ts';
import { runs, tasks } from '../schema/index.ts';

/** 租约过期、原会话还在时写进 tasks.doing 的标记。不是新的任务状态。 */
export const PENDING_RELEASE = '待确认释放';

export type HandoffExpired =
  | { transferred: false; marked: true; owner: TaskOwner }
  | { transferred: true; owner: TaskOwner }
  | { transferred: false; marked: false; why: 'missing' | 'lease_live' | 'unconfirmed' };

/** 事务也能传：建行和派单都在自己的事务里写这一列。 */
type OwnerDb = Pick<Db, 'update'>;

async function setOwner(db: OwnerDb, taskId: string, owner: TaskOwner): Promise<void> {
  const rows = await db.update(tasks).set({ owner }).where(eq(tasks.id, taskId)).returning({ id: tasks.id });
  if (rows.length === 0) throw new Error(`任务 ${taskId} 没有这一行，owner 没写成`);
}

/**
 * 旧引擎拉单建行（store 的 createTaskFromIssue）之后把 owner 写成 v1。
 * 已经有的行不从这里改：新内核的行（harness）拉单不碰。
 */
export function writeIntakeOwner(db: OwnerDb, taskId: string): Promise<void> {
  return setOwner(db, taskId, 'v1');
}

/**
 * 点名派单（engine 的 dispatchIssue）派成之后把 owner 写成 v1。
 * 调用方先确认这张单不是新内核的（owner ≠ harness），这里只负责写入。
 */
export function writeDispatchOwner(db: OwnerDb, taskId: string): Promise<void> {
  return setOwner(db, taskId, 'v1');
}

/**
 * 租约已经过了，想把 owner 交给 `to`。
 * 还有没结束的会话：只标「待确认释放」，owner 不动。
 * 至少有一条已结束、且没有还开着的：才改 owner，并清掉这个标记。
 * 租约还没到期，或这张单上根本没有会话：不标、不转。
 */
export async function handoffExpiredOwner(
  db: Db,
  input: { taskId: string; now: Date; to: TaskOwner },
): Promise<HandoffExpired> {
  return db.transaction(async (tx) => {
    const [task] = await tx
      .select({ owner: tasks.owner, leaseUntil: tasks.leaseUntil, doing: tasks.doing })
      .from(tasks)
      .where(eq(tasks.id, input.taskId))
      .for('update');
    if (!task) return { transferred: false, marked: false, why: 'missing' } as const;
    if (task.leaseUntil === null || task.leaseUntil >= input.now) {
      return { transferred: false, marked: false, why: 'lease_live' } as const;
    }
    const [open] = await tx
      .select({ id: runs.id })
      .from(runs)
      .where(and(eq(runs.taskId, input.taskId), isNull(runs.endedAt)))
      .limit(1);
    if (open) {
      await tx.update(tasks).set({ doing: PENDING_RELEASE }).where(eq(tasks.id, input.taskId));
      return { transferred: false, marked: true, owner: task.owner } as const;
    }
    const [ended] = await tx
      .select({ id: runs.id })
      .from(runs)
      .where(and(eq(runs.taskId, input.taskId), isNotNull(runs.endedAt)))
      .limit(1);
    if (!ended) return { transferred: false, marked: false, why: 'unconfirmed' } as const;
    await tx
      .update(tasks)
      .set({ owner: input.to, ...(task.doing === PENDING_RELEASE ? { doing: null } : {}) })
      .where(eq(tasks.id, input.taskId));
    return { transferred: true, owner: input.to } as const;
  });
}
