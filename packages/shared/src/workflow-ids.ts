// 工作流编号的拼法：引擎（起工作流）和驾驶舱后端（发信号）共用这一份。
// 拼法进了在途任务的历史：改已经在跑的那种格式要在引擎里用 patched()，并同时改后端，不许两边各拼各的。
// 代数后缀是起工作流时从外面拼的，工作流代码不调用这里，所以加 :rN 不用 patched()。
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
 * 一张 issue 的任务工作流。第一代是 `task:acme/demo#12`（不带后缀，历史编号照旧能读、能回放）。
 * 被撤掉以后要重做，另起一代：`task:acme/demo#12:r2`（第二代）、`:r3`……不写 `:r1`。
 * 每一代起的时候都用 REJECT_DUPLICATE：同一个编号不管开着还是已经结束都不许再起，所以重做不会盖掉旧代。
 * 接活不会自己重来；驾驶舱「继续」只叫得醒还在跑的那一代，「重做」才另起下一代（engine/src/jobs/redo.ts）。
 * 工作流代码不拼这个编号（起的时候由外面传入），加代数不用 patched()。
 * 驾驶舱后端发信号也按这个拼（api/src/temporal.ts），信号名见 task-signals.ts。
 */
export function taskWorkflowId(repo: WorkflowRepoRef, issueNumber: number, generation = 1): string {
  if (!Number.isInteger(generation) || generation < 1) {
    throw new Error(`任务工作流代数必须是正整数，收到 ${String(generation)}`);
  }
  const base = `task:${repo.owner}/${repo.name}#${issueNumber}`;
  return generation === 1 ? base : `${base}:r${generation}`;
}

/** 从任务工作流编号拆出仓、单号、代数。第一代（没有 `:rN`）代数是 1。挂起键（`:park:`）和别的后缀认不出，回 null。 */
export function parseTaskWorkflowId(
  id: string,
): { repo: WorkflowRepoRef; issueNumber: number; generation: number } | null {
  const m = /^task:([^/]+)\/([^#]+)#(\d+)(?::r([1-9]\d*))?$/.exec(id);
  if (!m?.[1] || !m[2] || !m[3]) return null;
  const generation = m[4] ? Number(m[4]) : 1;
  if (!Number.isInteger(generation) || generation < 1) return null;
  return { repo: { owner: m[1], name: m[2] }, issueNumber: Number(m[3]), generation };
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
