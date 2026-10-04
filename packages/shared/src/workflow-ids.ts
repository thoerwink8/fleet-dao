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
 * 同一张单任何时候最多一条：做完的、停下的不会自己重来，要人在驾驶舱点「继续」（发信号）。驾驶舱后端发信号也按这个拼。
 */
export function taskWorkflowId(repo: WorkflowRepoRef, issueNumber: number): string {
  return `task:${repo.owner}/${repo.name}#${issueNumber}`;
}

/** 一张 issue 一条工作流（Fusion；在途的旧需求工作流也是这个编号），例如 `req:acme/demo#12`。 */
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

/**
 * fleet 命令写库之后，只有这几类值得叫醒工作流（会改变走向）；say、plan 只进库，驾驶舱从库里读。
 * 每条都发的话，一个需求二十来个子任务就能把工作流的历史撑到上万条事件，撞上 Temporal 每条执行 1 万个信号的上限后，
 * 连叫停都发不进去。叫醒直接发给会话所属的工作流：子任务的会话发 subtaskWorkflowId，需求自己的会话发需求工作流。
 */
export const AGENT_EVENT_WAKE_KINDS = ['ask', 'done', 'blocked'] as const;
