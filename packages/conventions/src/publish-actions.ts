// 「发布 vN」PR 的发起：由 packages/conventions/src/bin/publish-pr.ts（CLI）和驾驶舱 /changelog 按钮唤起；
// 本文件不含 I/O——只拼「要发什么」（版本号、head 分支、CHANGELOG.md 改完的新文本、正文），和「拿到什么算开成」（从 gh 输出认 PR 号）。
// 改这里之前必须知道：
// - 没拿到 GITHUB_TOKEN 直接抛错、不伪造 PR 号；这是「对外发布」人闸的最后一关，伪造成功等于把没发出去的当成发出去了。
// - 发布 PR 不能只换分支名不带提交：release.yml 只认 head=release/v<N>，但「head 没提交差于 main」 gh pr create 会失败
//   （第二意见 2026-10-02），所以发起 CLI 同时「改写 CHANGELOG.md：Unreleased 段收进 ## [vN] 标题」＋提交＋推——这样 head 分支上
//   有一个和 main 不一样的提交、PR 上能看见内容、发起人审起来也有东西看。
// - head 分支名的协议在 ./publish.ts 的 RELEASE_BRANCH_RE；这里只跟着它起名，不另写正则。
import { splitChangelog, UNRELEASED_HEADING } from '@fleet-dao/shared';
import { RELEASE_BRANCH_RE } from './publish.ts';

export interface PublishOptions {
  /** 已经推好的 head 分支名（默认拿当前分支，由调用方读）。必须是 release/v<N>，且 N 和 CHANGELOG.md 算出来的版本一致。 */
  head?: string;
  /** 仓根 CHANGELOG.md 的当前内容（发布之前那份）。 */
  changelog: string;
  /** 「今天」（YYYY-MM-DD，UTC）；不给就读真钟。测试必须给：写死的日期遇上真钟，过了那天零点就红。 */
  today?: () => string;
}

export interface PublishPlan {
  /** 这一版的版本号（v<N>），从 CHANGELOG.md Unreleased 段的「当前已发版本 +1」算出来。 */
  version: `v${number}`;
  /** 这一版的日期（YYYY-MM-DD，UTC）。 */
  date: string;
  /** 发布 PR 的 head 分支名；release.yml 靠它认是不是发布 PR（packages/conventions/src/publish.ts 的 RELEASE_BRANCH_RE）。 */
  headBranch: string;
  /** PR 标题（发布 vN）。 */
  title: string;
  /** PR 正文。 */
  body: string;
  /** PR base 分支名：发布一律合到 main。 */
  base: 'main';
  /**
   * 发起人要把 CHANGELOG.md 改成这份再提交：Unreleased 段收进「## [vN] - YYYY-MM-DD」标题、
   * Unreleased 段重置成一段「还没有」。CLI 拿到这份替代原文再 commit、push、开 PR。
   */
  nextChangelog: string;
  /** 提交信息（发布 vN 就是这一版的版本说明）。 */
  commitMessage: string;
}

/** PR 标题就是「发布 v<N>」。 */
export function publishPrName(version: `v${number}`): string {
  return `发布 ${version}`;
}

/**
 * 把 CHANGELOG.md 的 Unreleased 段收进「## [v<N>] - YYYY-MM-DD」标题，Unreleased 重置成「还没有」。
 * 格式钉死：标题行照 packages/shared/src/changelog.ts 的 HEADING_LINE 的长法，正文原样搬。
 * Unreleased 空的话直接抛错——发起前要把这一版要写的话写好。
 */
export function finalizeChangelog(changelog: string, opts: { version: `v${number}`; date: string }): string {
  const split = splitChangelog(changelog);
  if (!split.hasContent || split.section.trim().length === 0) {
    throw new Error(
      `CHANGELOG.md 的 Unreleased 段是空的、没东西可发：先把这一版要写的话写进 ${UNRELEASED_HEADING} 段，再跑发起脚本。`,
    );
  }
  const lines = changelog.replace(/\r\n?/g, '\n').split('\n');
  const start = lines.findIndex((l) => l.trim() === UNRELEASED_HEADING);
  if (start === -1) throw new Error(`CHANGELOG.md 缺 ${UNRELEASED_HEADING}`);
  const heading = `## [${opts.version}] - ${opts.date}`;
  // 找到 Unreleased 段正文结束的位置：下一个 ## 或文件尾
  let end = lines.length;
  for (let i = start + 1; i < lines.length; i++) {
    if ((lines[i] ?? '').trim().startsWith('## ')) {
      end = i;
      break;
    }
  }
  const before = lines.slice(0, start + 1);
  const after = lines.slice(end);
  return [...before, '', '还没有', '', heading, '', split.section, '', ...after].join('\n');
}

/**
 * 算「该怎么开这张发布 PR」。不 env、不 gh、不 fs；从 CHANGELOG.md 拿版本号、用 head（或当前分支）拼分支名、把
 * CHANGELOG.md 的 Unreleased 段改写成「## [vN] - 日期」。
 * CHANGELOG.md 认不出来（缺 Unreleased 段、格式漂了）直接抛出 splitChangelog 的错——发起人得先把 CHANGELOG.md 写好。
 * head 分支必须长得像 release/v<N>，且 N 就是 CHANGELOG.md 算出来的版本号：release.yml 只放行 release/v<N>，
 * 分支不对的话 PR 开出来合并之后工作流落不进 proceed；与其开了一张注定红的 PR，不如 CLI 这里就明说不开（第二意见 2026-10-02）。
 */
export function publishReleasePlan(options: PublishOptions): PublishPlan {
  const split = splitChangelog(options.changelog, options.today);
  const version = split.next.version as `v${number}`;
  const headBranch = options.head ?? '';
  if (!headBranch.trim()) {
    throw new Error(
      '没有 head 分支名：发起人先推好一个分支，再把分支名传进来；这份 CLI 不改仓、不替你提交。',
    );
  }
  const m = RELEASE_BRANCH_RE.exec(headBranch);
  if (!m || m[1] === undefined) {
    throw new Error(
      `head 分支「${headBranch}」不是 release/v<N> 的模样：release.yml 只放行 release/v<N>，这张 PR 合并之后工作流落不进 proceed。` +
        `先切一个 release/${version} 分支（git switch -c release/${version}），再重跑 publish-pr。`,
    );
  }
  if (`v${Number.parseInt(m[1], 10)}` !== version) {
    throw new Error(
      `head 分支「${headBranch}」和 CHANGELOG.md 算出来的版本（${version}）对不上：` +
        `CHANGELOG.md Unreleased 段准备发的是 ${version}，分支名却贴的是 v${Number.parseInt(m[1], 10)}。` +
        `要么改 CHANGELOG.md、要么换个对得上的分支（release/${version}）。`,
    );
  }
  const date = split.next.date;
  const nextChangelog = finalizeChangelog(options.changelog, { version, date });
  const body = [
    `# ${publishPrName(version)}`,
    '',
    'CHANGELOG.md 的 Unreleased 段（随这张 PR 收进 ## [vN] - 日期 标题发出去）：',
    '',
    '```',
    split.section,
    '```',
    '',
    `合并之后由 .github/workflows/release.yml 接手：打 ${version} tag → 建 GitHub release → 关 milestone（若有）→ 推飞书。`,
    '',
    'Closes #227',
  ].join('\n');
  const commitMessage = `发布 ${version}：CHANGELOG.md 的 Unreleased 段收进 ## [${version}] - ${date}`;
  return {
    version,
    date,
    headBranch,
    title: publishPrName(version),
    body,
    base: 'main',
    nextChangelog,
    commitMessage,
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
