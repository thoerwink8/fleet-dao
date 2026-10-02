// 「发布 vN」那一端的共用逻辑（packages/conventions/src/bin/publish-pr.ts、packages/web/src/routes/changelog.tsx、
// release.yml 入口过滤都在这份上）：
//   - classifyPullRequestClosed：release.yml 从 pull_request closed 事件来，只放行「合到 main、head 分支是 release/v<N>」的；其余场合
//     要么不动作（noop）、要么明确报错（error），不悄悄跑——「走了但什么都没干」和「这次关上的是错的」要分得开。
//   - publishReleasePlan：发起端算「这一版叫什么、head 是哪个分支」；发布 PR 的 head 分支名固定长 release/v<N>（发起端和收尾端共用一份正则）。
// 改这里之前必须知道：
// - 不查 GitHub、不读仓：这份只是纯判定。读 CHANGELOG 算版本、跑 gh 开 PR、拿到 head 分支名——都在 publish-actions.ts / publish-pr.ts。
// - 「对外发布」是人闸第四类（AGENTS.md）：这张 PR 由发起人开（publish-pr.ts 或驾驶舱按钮）、创始人点合并；
//   这份不放行任何「AI 替人合并发布 PR」的路径。

/** 发布 PR 的 head 分支名固定长这样：release/v<N>；release.yml 只放行它（#227 下半，0011 第 4 条）。 */
export const RELEASE_BRANCH_RE = /^release\/v(\d+)$/;

/**
 * release.yml 的入口过滤器：从 pull_request closed 事件来，要不要走。
 * - merged=true、base=main、head=release/v<N> → proceed（照走 tag → release → milestone → 飞书）。
 * - merged=false → noop：发布 PR 没合就关了，不算发布，不是错，不动作（不能让 Actions 红）。
 * - merged=true 但 base 或 head 不对 → error：明确失败；一个 release/v<N> 分支合到了别处、或一张不是发布 PR 的
 *   合进来却触发了这条链路，都是流程错——「悄悄跳过」会让人以为「已经发过一版了」。Actions 这一步红起来，人看得见。
 */
export type ReleaseTrigger =
  | { kind: 'proceed'; headBranch: string; version: `v${number}` }
  | { kind: 'noop'; why: string }
  | { kind: 'error'; message: string };

export function classifyPullRequestClosed(opts: {
  merged: boolean;
  headRef: string;
  baseRef: string;
}): ReleaseTrigger {
  if (!opts.merged) {
    return {
      kind: 'noop',
      why: '发布 PR 没合（merged=false）：这次关上不算发一版。',
    };
  }
  if (opts.baseRef !== 'main') {
    return {
      kind: 'error',
      message: `发布 PR 的 base 不是 main：「${opts.baseRef}」。发布一律合到 main；这张 PR 走了别的 base，不动作。`,
    };
  }
  const m = RELEASE_BRANCH_RE.exec(opts.headRef);
  if (!m || m[1] === undefined) {
    return {
      kind: 'error',
      message:
        `发布 PR 的 head 分支不是 release/v<N>：「${opts.headRef}」。` +
        `只放行 ${String(RELEASE_BRANCH_RE)}；这一下不动作。`,
    };
  }
  return {
    kind: 'proceed',
    headBranch: opts.headRef,
    version: `v${Number.parseInt(m[1], 10)}` as `v${number}`,
  };
}
