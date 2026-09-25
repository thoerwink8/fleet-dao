// 工作流编号的拼法：引擎（起工作流）和驾驶舱后端（发信号）共用这一份。
// 拼法进了在途任务的历史：改格式要在引擎里用 patched()，并同时改后端，不许两边各拼各的。
// 这里不引任何东西：工作流代码也从这里拿（@fleet-dao/shared/workflow-ids），打进工作流沙箱的只有这几行。

export interface WorkflowRepoRef {
  owner: string;
  name: string;
}

/** 一张 issue 一条需求工作流，例如 `req:acme/demo#12`。 */
export function requirementWorkflowId(repo: WorkflowRepoRef, issueNumber: number): string {
  return `req:${repo.owner}/${repo.name}#${issueNumber}`;
}

/**
 * 子任务工作流编号 = `sub:<subtasks.id>`。后端手里有 session_runs.subtask_id 就拼得出来，不用查别的；
 * subtasks.id 每次拆方案新生成，需求重开也不会和上一轮已关闭的子任务撞编号。
 */
export function subtaskWorkflowId(subtaskId: string): string {
  return `sub:${subtaskId}`;
}

/** 每个仓一条合并队列，例如 `mq:acme/demo`。 */
export function mergeQueueWorkflowId(repo: WorkflowRepoRef): string {
  return `mq:${repo.owner}/${repo.name}`;
}
