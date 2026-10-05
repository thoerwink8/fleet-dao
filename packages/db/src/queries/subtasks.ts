// 子任务的写入：依赖关系存在 subtask_deps，这里负责把领域对象 Subtask.dependsOn 拆进去。
import type { Subtask } from '@fleet-dao/shared';
import type { Db } from '../client.ts';
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
