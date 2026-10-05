// 任务快照：一个事务里更新任务行、作废快照里没有的子任务、按 id upsert 子任务、整体替换依赖。
import type { SubtaskState, TaskState } from '@fleet-dao/shared';
import { and, eq, inArray, isNull, notInArray } from 'drizzle-orm';
import type { Db } from '../client.ts';
import { subtaskDeps, subtasks, tasks } from '../schema/index.ts';

export interface TaskSnapshotInput {
  taskId: string;
  state: TaskState;
  phase: string;
  doing: string;
  /**
   * 需求文档目录和三份文档。不给就不动库里这两列：Fusion 认出单子正文指的需求文档之前（收单还没做完、停在收单）也写快照，
   * 这时写空的会把上一轮（重开前）记下的冲掉。
   */
  specDir?: string;
  docs?: { requirement?: string; plan?: string; result?: string };
  lastProblem: string | null;
  subtasks: {
    id: string;
    key: string;
    index: number;
    title: string;
    touches: string[];
    dependsOn: string[];
    state: SubtaskState;
    prNumber: number | null;
    waitingOn: string | null;
    workflowId: string | null;
    holds: string[];
  }[];
}

/**
 * 一个事务：更新 tasks 那一行（含 updated_at）；这个任务里不在快照中的子任务标 superseded_at（已标的不重标）；
 * 快照里的逐个按 id upsert（清掉 superseded_at）；快照里子任务的依赖整体替换。任务行不在返回 'task_not_found'
 * （不建任务行：快照里没有标题、原话这些必填列）。
 *
 * 注意：子任务按 id 逐条 upsert，不是一条多行语句——如果快照把两个仍在役的子任务互换 index（不经过标作废），
 * 处理顺序在前的那条会撞部分唯一索引。目前唯一会撞索引的场景（旧子任务标作废、新子任务复用它的 index）
 * 天然没这问题：作废写在所有 upsert 之前，新记录落地时旧 index 早就让出来了。
 */
export async function saveTaskSnapshot(
  db: Db,
  input: TaskSnapshotInput,
): Promise<'saved' | 'task_not_found'> {
  return db.transaction(async (tx) => {
    const updated = await tx
      .update(tasks)
      .set({
        state: input.state,
        phase: input.phase,
        doing: input.doing,
        ...(input.specDir !== undefined ? { specDir: input.specDir } : {}),
        ...(input.docs !== undefined ? { docs: input.docs } : {}),
        lastProblem: input.lastProblem,
        updatedAt: new Date(),
      })
      .where(eq(tasks.id, input.taskId))
      .returning({ id: tasks.id });
    if (updated.length === 0) return 'task_not_found';

    const keepIds = input.subtasks.map((s) => s.id);
    await tx
      .update(subtasks)
      .set({ supersededAt: new Date() })
      .where(
        and(
          eq(subtasks.taskId, input.taskId),
          isNull(subtasks.supersededAt),
          keepIds.length > 0 ? notInArray(subtasks.id, keepIds) : undefined,
        ),
      );

    for (const s of input.subtasks) {
      const values = {
        index: s.index,
        title: s.title,
        touches: s.touches,
        state: s.state,
        prNumber: s.prNumber,
        waitingOn: s.waitingOn,
        key: s.key,
        workflowId: s.workflowId,
        holds: s.holds,
        supersededAt: null,
      };
      await tx
        .insert(subtasks)
        .values({ id: s.id, taskId: input.taskId, ...values })
        .onConflictDoUpdate({ target: subtasks.id, set: values });
    }

    await tx
      .delete(subtaskDeps)
      .where(
        and(
          eq(subtaskDeps.taskId, input.taskId),
          keepIds.length > 0 ? inArray(subtaskDeps.subtaskId, keepIds) : undefined,
        ),
      );
    const deps = input.subtasks.flatMap((s) =>
      s.dependsOn.map((dependsOnId) => ({ taskId: input.taskId, subtaskId: s.id, dependsOnId })),
    );
    if (deps.length > 0) await tx.insert(subtaskDeps).values(deps);

    return 'saved';
  });
}
