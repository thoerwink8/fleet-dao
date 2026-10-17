// 全程模式的分组记录（#2823，task_flow_assignments）：每张单最多一行，写一次、读。
// 同一张单写第二次抛 FlowAssignmentExistsError，不覆盖；没有这张单抛普通错（不退成「写了」）。
import {
  FLOW_MODE_SETTING,
  type FlowAssignment,
  FlowAssignmentExistsError,
  type NewFlowAssignment,
} from '@fleet-dao/shared';
import { eq, inArray } from 'drizzle-orm';
import type { Db } from '../client.ts';
import { settings } from '../schema/index.ts';
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
  // 分组记录和 tasks.flow_mode 一起写（#2826）：分了组的单在任务行上就看得到走哪种流程
  return db.transaction(async (tx) => {
    const [row] = await tx
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
    await tx.update(tasks).set({ flowMode: input.mode }).where(eq(tasks.id, input.taskId));
    return toAssignment(row);
  });
}

/** 设置表里 engine.flowMode 那一行的原值（#2826）：没设过回 undefined。认不认得出由 shared 的 readFlowModeSetting 判。库读不了照抛。 */
export async function readFlowModeSettingRaw(db: Db): Promise<unknown> {
  const [row] = await db.select().from(settings).where(eq(settings.key, FLOW_MODE_SETTING));
  return row ? row.value : undefined;
}

/** 读一张单的分组记录；没分过组、编号不是 uuid 都是 null。 */
export async function getFlowAssignment(db: Db, taskId: string): Promise<FlowAssignment | null> {
  if (!UUID.test(taskId)) return null;
  const [row] = await db.select().from(taskFlowAssignments).where(eq(taskFlowAssignments.taskId, taskId));
  return row ? toAssignment(row) : null;
}

/** 一次读多张单的分组记录。编号不是 uuid 的跳过；没分过组的不在结果里。空列表不查库。 */
export async function listFlowAssignments(db: Db, taskIds: readonly string[]): Promise<FlowAssignment[]> {
  const ids = [...new Set(taskIds.filter((id) => UUID.test(id)))];
  if (ids.length === 0) return [];
  const rows = await db.select().from(taskFlowAssignments).where(inArray(taskFlowAssignments.taskId, ids));
  return rows.map(toAssignment);
}
