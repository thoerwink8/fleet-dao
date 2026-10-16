// 全程模式的分组记录（#2823，task_flow_assignments）：每张单最多一行，写一次、读。
// 同一张单写第二次抛 FlowAssignmentExistsError，不覆盖；没有这张单抛普通错（不退成「写了」）。
import { type FlowAssignment, FlowAssignmentExistsError, type NewFlowAssignment } from '@fleet-dao/shared';
import { eq } from 'drizzle-orm';
import type { Db } from '../client.ts';
import { taskFlowAssignments, tasks } from '../schema/work.ts';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function toAssignment(r: typeof taskFlowAssignments.$inferSelect): FlowAssignment {
  return {
    taskId: r.taskId,
    mode: r.mode,
    source: r.source,
    stratum: r.stratum,
    assignedAt: r.assignedAt.toISOString(),
    reason: r.reason,
  };
}

/** 写一次。assignedAt 不给就用库的钟。返回写进去的那一行。 */
export async function recordFlowAssignment(
  db: Db,
  input: NewFlowAssignment & { assignedAt?: Date | undefined },
): Promise<FlowAssignment> {
  if (!UUID.test(input.taskId)) throw new Error(`没有这张单：${input.taskId}`);
  const [task] = await db.select({ id: tasks.id }).from(tasks).where(eq(tasks.id, input.taskId));
  if (!task) throw new Error(`没有这张单：${input.taskId}`);
  const [row] = await db
    .insert(taskFlowAssignments)
    .values({
      taskId: input.taskId,
      mode: input.mode,
      source: input.source,
      stratum: input.stratum,
      reason: input.reason ?? null,
      ...(input.assignedAt ? { assignedAt: input.assignedAt } : {}),
    })
    .onConflictDoNothing({ target: taskFlowAssignments.taskId })
    .returning();
  if (!row) throw new FlowAssignmentExistsError(input.taskId);
  return toAssignment(row);
}

/** 读一张单的分组记录；没分过组、编号不是 uuid 都是 null。 */
export async function getFlowAssignment(db: Db, taskId: string): Promise<FlowAssignment | null> {
  if (!UUID.test(taskId)) return null;
  const [row] = await db.select().from(taskFlowAssignments).where(eq(taskFlowAssignments.taskId, taskId));
  return row ? toAssignment(row) : null;
}
