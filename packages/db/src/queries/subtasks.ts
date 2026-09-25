// 子任务的读写：依赖关系存在 subtask_deps，这里负责和领域对象 Subtask.dependsOn 互转。
import type { Subtask } from '@fleet-dao/shared';
import { and, asc, eq, isNull } from 'drizzle-orm';
import type { Db } from '../client.ts';
import { toSubtask } from '../domain-map.ts';
import { subtaskDeps, subtasks } from '../schema/index.ts';

export type NewSubtask = Omit<Subtask, 'taskId' | 'state'> & { state?: Subtask['state'] };

/** 一次写入一个需求的子任务和它们之间的依赖（同一事务）。依赖只能指向同一需求里的子任务，指错了整批回滚。 */
export async function insertSubtasks(db: Db, taskId: string, items: readonly NewSubtask[]): Promise<void> {
  if (items.length === 0) return;
  await db.transaction(async (tx) => {
    await tx.insert(subtasks).values(
      items.map((s) => ({
        id: s.id,
        taskId,
        index: s.index,
        title: s.title,
        touches: s.touches,
        state: s.state ?? 'pending',
        prNumber: s.prNumber ?? null,
        waitingOn: s.waitingOn ?? null,
      })),
    );
    const deps = items.flatMap((s) =>
      s.dependsOn.map((dependsOnId) => ({ taskId, subtaskId: s.id, dependsOnId })),
    );
    if (deps.length > 0) await tx.insert(subtaskDeps).values(deps);
  });
}

/** 重拆方案作废的子任务（subtasks.superseded_at 非空）不返回：它们的 index 可能和现役子任务重复。 */
export async function getSubtasks(db: Db, taskId: string): Promise<Subtask[]> {
  const [rows, deps] = await Promise.all([
    db
      .select()
      .from(subtasks)
      .where(and(eq(subtasks.taskId, taskId), isNull(subtasks.supersededAt)))
      .orderBy(asc(subtasks.index)),
    db.select().from(subtaskDeps).where(eq(subtaskDeps.taskId, taskId)),
  ]);
  return rows.map((r) =>
    toSubtask(
      r,
      deps.filter((d) => d.subtaskId === r.id).map((d) => d.dependsOnId),
    ),
  );
}
