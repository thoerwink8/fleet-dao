// 一张单名下的各代工作流怎么对上。第一代是 task:owner/name#N，重做另起 :r2、:r3……（workflow-ids.ts）。
// 花费汇总要把重做出来的各代收进来。正则用 [0-9]，JavaScript 和 Postgres 的 ~ 同一套写法。

/** 第一代编号之后的重做代数（:r2、:r3……）。给 Postgres 的 ~ 和这里的正则共用。 */
export function laterGenerationPattern(baseWorkflowId: string): string {
  const escaped = baseWorkflowId.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  return `^${escaped}:r[1-9][0-9]*$`;
}

/** 这笔的工作流是不是这张单的第一代，或重做出来的下一代。挂起键（:park:）和别的后缀不算。 */
export function sameIssueWorkflow(
  runWorkflow: string | null | undefined,
  taskWorkflow: string | undefined,
): boolean {
  if (!taskWorkflow || !runWorkflow) return false;
  if (runWorkflow === taskWorkflow) return true;
  return new RegExp(laterGenerationPattern(taskWorkflow)).test(runWorkflow);
}

/** 对单要用的三列。taskId 空着才按单号兜底。 */
export interface IssueRunLink {
  taskId?: string | null | undefined;
  issueNumber?: number | null | undefined;
  workflowId?: string | null | undefined;
}

/**
 * 一条流水算不算这张单：记了 task_id 的只认那张单（别的单的不收，哪怕单号碰巧一样）；
 * 没记 task_id 的按单号，还得工作流是这张单的第一代或重做的下一代。没记工作流的分不出是哪个仓，不收。
 */
export function runBelongsToTask(
  run: IssueRunLink,
  task: { id: string; issueNumber: number; workflowId: string | undefined },
): 'task' | 'issueNumber' | undefined {
  if (run.taskId !== undefined && run.taskId !== null) return run.taskId === task.id ? 'task' : undefined;
  if (run.issueNumber !== task.issueNumber) return undefined;
  if (!sameIssueWorkflow(run.workflowId, task.workflowId)) return undefined;
  return 'issueNumber';
}
