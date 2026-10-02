// 「发布 vN」PR 的发起：由 packages/conventions/src/bin/publish-pr.ts（CLI）和驾驶舱 /changelog 按钮唤起；
// 本文件不含 I/O——只拼「要发什么」（版本号、head 分支、正文），和「拿到什么算开成」（从 gh 输出认 PR 号）。
// 改这里之前必须知道：
// - 没拿到 GITHUB_TOKEN 直接抛错、不伪造 PR 号；这是「对外发布」人闸的最后一关，伪造成功等于把没发出去的当成发出去了。
// - head 分支（release/v<N>）由发起人自己推好再开 PR——这份 CLI 不改仓、不建分支、不提交。
// - head 分支名的协议在 ./publish.ts 的 RELEASE_BRANCH_RE；这里只跟着它起名，不另写正则。
import { splitChangelog } from '@fleet-dao/shared';

export interface PublishOptions {
  /** 已经推好的 head 分支名（默认拿当前分支，由调用方读）。 */
  head?: string;
  /** 仓根 CHANGELOG.md 的内容。 */
  changelog: string;
}

export interface PublishPlan {
  /** 这一版的版本号（v<N>），从 CHANGELOG.md Unreleased 段的「当前已发版本 +1」算出来。 */
  version: `v${number}`;
  /** 发布 PR 的 head 分支名；release.yml 靠它认是不是发布 PR（packages/conventions/src/publish.ts 的 RELEASE_BRANCH_RE）。 */
  headBranch: string;
  /** PR 标题（发布 vN）。 */
  title: string;
  /** PR 正文。 */
  body: string;
  /** PR base 分支名：发布一律合到 main。 */
  base: 'main';
}

/** PR 标题就是「发布 v<N>」。 */
export function publishPrName(version: `v${number}`): string {
  return `发布 ${version}`;
}

/**
 * 算「该怎么开这张发布 PR」。不 env、不 gh、不 fs；从 CHANGELOG.md 拿版本号、用 head（或当前分支）拼分支名。
 * CHANGELOG.md 认不出来（缺 Unreleased 段、格式漂了）直接抛出 splitChangelog 的错——发起人得先把 CHANGELOG.md 写好。
 */
export function publishReleasePlan(options: PublishOptions): PublishPlan {
  const split = splitChangelog(options.changelog);
  const version = split.next.version as `v${number}`;
  const headBranch = options.head ?? '';
  if (!headBranch.trim()) {
    throw new Error(
      '没有 head 分支名：发起人先推好一个分支，再把分支名传进来；这份 CLI 不改仓、不替你提交。',
    );
  }
  const body = [
    `# ${publishPrName(version)}`,
    '',
    'CHANGELOG.md 的 Unreleased 段（发这一版要贴出去的话）：',
    '',
    '```',
    split.section,
    '```',
    '',
    `合并之后由 .github/workflows/release.yml 接手：打 ${version} tag → 建 GitHub release → 关 milestone（若有）→ 推飞书。`,
    '',
    'Closes #227',
  ].join('\n');
  return {
    version,
    headBranch,
    title: publishPrName(version),
    body,
    base: 'main',
  };
}

/**
 * 从 gh pr create 的输出里认 PR 号。gh 正常时最后一行是 PR 地址（…/pull/<N>）；输出里认不出 PR 号直接抛错——
 * 「退出了但没拿到号」不能让发起人当「已经开了」。
 */
export function parseCreatedPr(stdout: string): { pr: number; url: string } {
  const url = stdout.trim().split('\n').pop()?.trim() ?? '';
  const m = /\/pull\/(\d+)$/.exec(url)?.[1];
  if (!m) {
    throw new Error(`gh pr create 退出码 0，可输出里认不出 PR 号：${stdout.slice(0, 200)}`);
  }
  return { pr: Number(m), url };
}
