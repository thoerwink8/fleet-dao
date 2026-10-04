// 工作流编号的拼法：引擎（起工作流）和驾驶舱后端（发信号）共用这一份。
// 拼法进了在途任务的历史：改格式要在引擎里用 patched()，并同时改后端，不许两边各拼各的。
// 这里不引任何东西：工作流代码也从这里拿（@fleet-dao/shared/workflow-ids），打进工作流沙箱的只有这几行。

export interface WorkflowRepoRef {
  owner: string;
  name: string;
}

/**
 * 三段总调度的任务工作流类型名（#632；specs/632-三段总调度/方案.md）：引擎自己拉单（jobs/intake.ts）起的就是它，一张单一条。
 * 必须等于引擎 workflows/task.ts 导出的函数名（Temporal 按导出名找工作流）。
 */
export const TASK_WORKFLOW_TYPE = 'taskWorkflow';

/**
 * 一张 issue 一条任务工作流，例如 `task:acme/demo#12`。编号定死、起的时候用 REJECT_DUPLICATE（同一编号不管开着还是已经结束都不许再起），
 * 同一张单任何时候最多一条：做完的、被放弃的不会自己重来，也收不到信号（驾驶舱「继续」「叫停」发给它回 409 workflow_gone）；
 * 「继续」只叫得醒还在跑、停着等人的那一条。驾驶舱后端发信号也按这个拼（api/src/temporal.ts 的 taskWorkflowIdForTask），信号名见 task-signals.ts。
 */
export function taskWorkflowId(repo: WorkflowRepoRef, issueNumber: number): string {
  return `task:${repo.owner}/${repo.name}#${issueNumber}`;
}

/**
 * 旧 Fusion 的需求工作流编号，例如 `req:acme/demo#12`。引擎里这条工作流已经没有了，驾驶舱后端也不再往它发信号（#901）；
 * 只剩每小时对账（engine/src/real/hourly-reconcile.ts）拼它来认「在等旧批准的工作流已经不在了」、把旧提醒撤掉。
 * 对账那一套旧读法换掉时（#901 查出的同根问题，另开单）这个函数一起删，别在别处新用。
 */
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
