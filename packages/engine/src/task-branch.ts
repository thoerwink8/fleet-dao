// 任务工作流的分支名（#632 S2-4）：fleet/<单号>-t<这一轮执行编号的前 8 位>。
// 单独一个文件、不引任何依赖：工作流代码、每小时对账的自动合并兜底都要认它，别让对账代码顺带拖进 Temporal 的工作流库。

/**
 * 任务的分支：带上执行编号——同一张单被重新起一轮（上一条放弃了或做完了）时，上一轮的分支在 GitHub 上还在，同名会推不上去。
 */
export function taskBranch(issueNumber: number, runKey: string): string {
  return `fleet/${issueNumber}-t${runKey.replace(/-/g, '').slice(0, 8)}`;
}

const TASK_BRANCH = /^fleet\/\d+-t[0-9a-f]{8}$/;

/** 这个分支是不是任务工作流起的。认不出的一律不是（宁可让兜底多看一眼，不把别人的分支当成任务的）。 */
export function isTaskBranch(ref: string): boolean {
  return TASK_BRANCH.test(ref);
}
