// 引擎任务工作流（#632）开的 PR 的分支名：fleet/<单号>-t<这一轮执行编号的前 8 位十六进制>。合并闸（merge-gate.ts）据此认出
// 「这是引擎任务流程里的 PR」：合之前要有通过的冷调用结论（cold-verify）。
// 生成分支名的是 packages/engine/src/task-branch.ts——工作流代码会被打进 Temporal 的工作流包，不能引这个包（里面有 node:fs），
// 所以两边各一份正则，packages/engine/test/task-branch.test.ts 逐条对着测，改一边不改另一边当场红。
export const FLOW_BRANCH_PATTERN = /^fleet\/\d+-t[0-9a-f]{8}$/;

/** 这个分支名是不是引擎任务工作流起的。认不出的一律不是。 */
export function isFlowBranch(ref: string): boolean {
  return FLOW_BRANCH_PATTERN.test(ref);
}
