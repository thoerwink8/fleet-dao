// 「发布 vN」PR 的发起：由 packages/conventions/src/bin/publish-pr.ts（CLI，`pnpm publish:pr`）唤起，驾驶舱 /changelog 的按钮只是提示入口；
// 本文件不含 I/O——只拼「要发什么」（版本号、head 分支、CHANGELOG.md 改完的新文本、正文），和「拿到什么算开成」（从 gh 输出认 PR 号）。
// 改这里之前必须知道：
// - 版本号取当前版本里程碑（releaseVersion），不从 CHANGELOG.md「上一版 +1」算：里程碑＝版本（AGENTS.md 本仓段），
//   两处各记一份版本号，一对不上就发错号（#593：更新日志里一版没发过，按 +1 第一张就叫 v1，开着的却是 v3）。
// - gh 没有身份直接抛错、不伪造 PR 号；这是「对外发布」人闸的最后一关，伪造成功等于把没发出去的当成发出去了。
// - 发布 PR 不能只换分支名不带提交：release.yml 只认 head=release/v<N>，但「head 没提交差于 main」 gh pr create 会失败
//   （第二意见 2026-10-02），所以发起 CLI 同时「改写 CHANGELOG.md：Unreleased 段收进 ## [vN] 标题」＋提交＋推——这样 head 分支上
//   有一个和 main 不一样的提交、PR 上能看见内容、发起人审起来也有东西看。
// - head 分支名的协议在 ./publish.ts 的 RELEASE_BRANCH_RE；这里只跟着它起名，不另写正则。
import { splitChangelog, UNRELEASED_HEADING, type Version } from '@fleet-dao/shared';
import { currentVersion, type MilestoneRef, milestoneVersion } from './labels.ts';
import { RELEASE_BRANCH_RE } from './publish.ts';

export interface PublishOptions {
  /** 已经推好的 head 分支名（默认拿当前分支，由调用方读）。必须是 release/v<N>，且 N 是当前版本里程碑的版本号。 */
  head?: string;
  /** 仓根 CHANGELOG.md 的当前内容（发布之前那份）。 */
  changelog: string;
  /** 仓里此刻开着的里程碑（GitHub 上现读，不只 v 开头的）：版本号从这里取。 */
  openMilestones: readonly MilestoneRef[];
  /** 「今天」（YYYY-MM-DD，UTC）；不给就读真钟。测试必须给：写死的日期遇上真钟，过了那天零点就红。 */
  today?: () => string;
}

export interface PublishPlan {
  /** 这一版的版本号（v<N>）：当前版本里程碑的版本号（releaseVersion）。 */
  version: `v${number}`;
  /** 这一版对应的里程碑（当前版本那张）：合并之后 release.yml 关的就是它。 */
  milestone: MilestoneRef;
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
 * 这一版叫什么：当前版本里程碑的版本号——当前版本＝开着的 v<N> 里程碑里 N 最小的那张（labels.ts 的 currentVersion，
 * 和派活、闲置清理同一条规矩），开着几张 v<N> 都按这一条挑，不另立一套。
 * CHANGELOG.md 里已发的版本只拿来核：这一版已经收进标题了、或已经发到比它还新的版本，都明说不开。
 * 没有开着的版本里程碑也明说不开：不知道这一版叫什么，不拿「上一版 +1」猜。
 */
export function releaseVersion(
  openMilestones: readonly MilestoneRef[],
  released: readonly Version[],
): { version: `v${number}`; milestone: MilestoneRef; others: MilestoneRef[] } {
  const current = currentVersion(openMilestones);
  if (!current) {
    throw new Error(
      '开着的里程碑里没有版本里程碑（标题写成「v<N> 一句目标」的）：版本号取当前版本里程碑（里程碑＝版本），' +
        '一张都没有就不知道这一版叫什么——先在 GitHub 上把这一版的里程碑开出来，再重跑。',
    );
  }
  const version = `v${current.version}` as `v${number}`;
  const title = `「${current.milestone.title}」`;
  if (released.some((r) => r.version === version)) {
    throw new Error(
      `CHANGELOG.md 里已经有「## [${version}] - …」了：这一版已经收进标题、发布 PR 多半合过了，可当前版本里程碑${title}还开着。` +
        `收尾没走完的话去 Actions 手动重跑 release（workflow_dispatch，version=${version}），别再开一张发布 PR。`,
    );
  }
  const newer = released.filter((r) => Number(r.version.slice(1)) > current.version);
  if (newer.length > 0) {
    throw new Error(
      `CHANGELOG.md 里已经发到 ${newer.map((r) => r.version).join('、')} 了，比当前版本里程碑${title}（${version}）还新：` +
        '更新日志和里程碑对不上，先核一眼哪边错了，再重跑。',
    );
  }
  const others = openMilestones.filter(
    (m) => m.number !== current.milestone.number && milestoneVersion(m.title) !== undefined,
  );
  return { version, milestone: current.milestone, others };
}

/**
 * head 分支名里的版本号：release/v<N> → v<N>；不是这个模样就抛。release.yml 只放行 release/v<N>，
 * 分支不对的话 PR 合并之后工作流落不进 proceed——与其开一张注定红的 PR，不如这里就明说不开（第二意见 2026-10-02）。
 * expected 给了（已经知道这一版叫什么）就照它写出该切哪个分支。
 */
export function releaseBranchVersion(head: string, expected?: `v${number}`): `v${number}` {
  const how = expected
    ? `git switch -c release/${expected}`
    : 'git switch -c release/v<N>，N 是当前版本里程碑的版本号：GitHub 上开着的 v<N> 里程碑里 N 最小的那张';
  if (!head.trim()) {
    throw new Error(`没有 head 分支名：先切好发布分支（${how}），再跑 publish:pr。`);
  }
  const m = RELEASE_BRANCH_RE.exec(head);
  if (!m || m[1] === undefined) {
    throw new Error(
      `head 分支「${head}」不是 release/v<N> 的模样：release.yml 只放行 release/v<N>，这张 PR 合并之后工作流落不进 proceed。` +
        `先切到发布分支（${how}），再重跑 publish:pr。`,
    );
  }
  return `v${Number.parseInt(m[1], 10)}` as `v${number}`;
}

/**
 * 算「该怎么开这张发布 PR」。不 env、不 gh、不 fs；版本号取当前版本里程碑、用 head（或当前分支）核分支名、把
 * CHANGELOG.md 的 Unreleased 段改写成「## [vN] - 日期」。
 * CHANGELOG.md 认不出来（缺 Unreleased 段、格式漂了）直接抛出 splitChangelog 的错——发起人得先把 CHANGELOG.md 写好。
 * head 分支必须是 release/v<N>，且 N 就是当前版本里程碑的版本号。
 */
export function publishReleasePlan(options: PublishOptions): PublishPlan {
  const split = splitChangelog(options.changelog, options.today);
  const { version, milestone, others } = releaseVersion(options.openMilestones, split.released);
  const headBranch = options.head ?? '';
  const headVersion = releaseBranchVersion(headBranch, version);
  if (headVersion !== version) {
    throw new Error(
      `head 分支「${headBranch}」和当前版本里程碑「${milestone.title}」（${version}）对不上：分支名贴的是 ${headVersion}。` +
        `切到 release/${version}（git switch -c release/${version}）再重跑 publish:pr；要发的不是这一版的话，先在 GitHub 上把里程碑理清楚。`,
    );
  }
  const date = split.next.date;
  const nextChangelog = finalizeChangelog(options.changelog, { version, date });
  const body = [
    `# ${publishPrName(version)}`,
    '',
    `版本号取自当前版本里程碑「${milestone.title}」：合并这张 PR 就是发 ${version}（对外发布，由创始人点合并）。`,
    ...(others.length > 0
      ? [
          '',
          `还开着的别的版本里程碑：${others.map((m) => `「${m.title}」`).join('、')}——当前版本按开着的 v<N> 里 N 最小的那张算（和派活同一条规矩），这次只发 ${version}。`,
        ]
      : []),
    '',
    `CHANGELOG.md 的 Unreleased 段（随这张 PR 收进「## [${version}] - ${date}」发出去）：`,
    '',
    '```',
    split.section,
    '```',
    '',
    `合并之后由 .github/workflows/release.yml 接手：核对版本里程碑 → 打 ${version} tag → 建 GitHub release → 关里程碑「${milestone.title}」→ 推飞书。`,
  ].join('\n');
  const commitMessage = `发布 ${version}：CHANGELOG.md 的 Unreleased 段收进 ## [${version}] - ${date}`;
  return {
    version,
    milestone,
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
