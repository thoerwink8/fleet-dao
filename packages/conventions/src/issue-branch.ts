// 一张单固定一个分支前缀（决定 0096）：引擎 fleet/<单号>-，本机 local/<单号>-。两边开 PR 前、拉单、收本机租约都按它认单号。
// 放在 conventions（零安装区）：pnpm work、pnpm pr:open 在没有 node_modules 的地方也要能认。

/** 谁在做：引擎（法国）或本机。和 shared 的 TASK_EXECUTORS 同一份取值（conventions 的测试钉着）。 */
export type BranchExecutor = 'engine' | 'local';

/** 本机做这张单的分支前缀：local/<单号>-。 */
export function localBranchPrefix(issue: number): string {
  return `local/${issue}-`;
}

const ISSUE_BRANCH = /^(fleet|local)\/(\d+)-/;

/** 分支名照固定前缀认出是哪条线、哪张单（fleet/<单号>- 是引擎，local/<单号>- 是本机）；认不出是 null。 */
export function issueOfBranch(ref: string): { executor: BranchExecutor; issue: number } | null {
  const m = ISSUE_BRANCH.exec(ref);
  if (!m?.[1] || !m[2]) return null;
  const issue = Number(m[2]);
  if (!Number.isSafeInteger(issue) || issue <= 0) return null;
  return { executor: m[1] === 'fleet' ? 'engine' : 'local', issue };
}
