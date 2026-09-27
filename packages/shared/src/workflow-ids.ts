// 工作流编号的拼法：引擎（起工作流）和驾驶舱后端（发信号）共用这一份。
// 拼法进了在途任务的历史：改格式要在引擎里用 patched()，并同时改后端，不许两边各拼各的。
// 这里不引任何东西：工作流代码也从这里拿（@fleet-dao/shared/workflow-ids），打进工作流沙箱的只有这几行。

export interface WorkflowRepoRef {
  owner: string;
  name: string;
}

/**
 * 旧的需求工作流的类型名，引擎的 WORKFLOW_TYPES.requirement 就是它。必须等于引擎 workflows/requirement.ts 导出的函数名
 * （Temporal 按导出名找工作流）。后端从 #214 第 3 个 PR 起不再起它（接活一律起 FUSION_WORKFLOW_TYPE），引擎留着它只为
 * 让那之前起的在途任务跑完；整个删掉归 #250。
 */
export const REQUIREMENT_WORKFLOW_TYPE = 'requirementWorkflow';

/**
 * Fusion 工作流的类型名（docs/decisions/0003-fusion-flow.md 第 5 条：一张单一个 Lead 会话带一个副手，引擎推分支、开 PR、
 * 合并、关单，不直写主线）：后端接活起的就是它（api 的 temporal.ts）。Fusion 模式还是单模型模式（0003 第 7 条）由它开工前
 * 按流程配置副本判，不是另一种工作流。必须等于引擎 workflows/fusion.ts 导出的函数名。工作流编号和旧的需求工作流同一个
 * （requirementWorkflowId）：驾驶舱、fleet 命令的信号照旧按它发；同一张单同一时刻只能有一条在跑，切换那一刻也起不了两条。
 */
export const FUSION_WORKFLOW_TYPE = 'fusionWorkflow';

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

/** 每个仓一条合并队列，例如 `mq:acme/demo`。 */
export function mergeQueueWorkflowId(repo: WorkflowRepoRef): string {
  return `mq:${repo.owner}/${repo.name}`;
}

/**
 * fleet 命令写库之后，只有这几类值得叫醒工作流（会改变走向）；say、plan 只进库，驾驶舱从库里读。
 * 每条都发的话，一个需求二十来个子任务就能把工作流的历史撑到上万条事件，撞上 Temporal 每条执行 1 万个信号的上限后，
 * 连叫停都发不进去。叫醒直接发给会话所属的工作流：子任务的会话发 subtaskWorkflowId，需求自己的会话发需求工作流。
 */
export const AGENT_EVENT_WAKE_KINDS = ['ask', 'done', 'blocked'] as const;
export type AgentEventWakeKind = (typeof AGENT_EVENT_WAKE_KINDS)[number];
