// 发布收尾里「核版本里程碑（打 tag 之前）」「关里程碑」两步：读 GitHub 上的里程碑、这张发布 PR 合并的时间，
// 照 publish-release-logic.ts 的 decideReleaseMilestone 判；close 那一步再真关，拿 GitHub 的回包核是不是真关了。
// 由 release-finalize.ts 按先后调；测试在 packages/conventions/test/release-milestone.test.ts。
// 改这里之前必须知道：
// - check 在打 tag 之前跑：版本号对不上里程碑时，tag、release 一样都还没动——这是这一步存在的全部意义，别挪到 tag 后面。
// - 判不了（读不到、认不出、对不上）一律抛，那一步记红、后面都不走；不许拿「跳」冒充已经关过了（#593 第一次发布前修的就是这个）。
import type { MergedPull, MilestoneDetail } from './github-api.ts';
import { milestoneVersion } from './labels.ts';
import { decideReleaseMilestone, isVersionTag } from './publish-release-logic.ts';

export type ReleaseMilestoneMode = 'check' | 'close';

/** 要用到的 GitHub 三样（github-api.ts 的 liveGitHub 都有；测试换替身）。 */
export interface ReleaseMilestoneGitHub {
  milestones(): Promise<readonly MilestoneDetail[]>;
  mergedPulls(head: string): Promise<readonly MergedPull[]>;
  closeMilestone(n: number): Promise<MilestoneDetail>;
}

export interface ReleaseMilestoneOptions {
  mode: ReleaseMilestoneMode;
  /** 这一版的版本号（v<N>，release.yml 前面那步从 head 分支名或手动输入认出来的）。 */
  version: string;
  /** 发布 PR 合并的时间：pull_request 事件里带着；workflow_dispatch 手动补跑没有，要用时按 head=release/v<N> 查已合并的那张。 */
  mergedAt?: string | undefined;
  github: ReleaseMilestoneGitHub;
}

export type ReleaseMilestoneResult =
  /** check：开着的当前版本里程碑就是这一版的，发完关它。 */
  | { kind: 'will-close'; milestone: MilestoneDetail; note: string }
  /** close：关了，GitHub 回包里是 closed。 */
  | { kind: 'closed'; milestone: MilestoneDetail; note: string }
  /** check / close：这一版的里程碑在这次发布合并之后已经关了（重跑），不再动它。 */
  | { kind: 'already-closed'; milestone: MilestoneDetail; note: string };

export async function releaseMilestone(opts: ReleaseMilestoneOptions): Promise<ReleaseMilestoneResult> {
  const { mode, github } = opts;
  const where =
    mode === 'check'
      ? '打 tag 之前核版本里程碑没过（tag、release 都还没动）'
      : '关里程碑没关成（tag、release 前两步已经弄好了，里程碑没动）';
  const fail = (why: string) => new Error(`${where}：${why}`);
  const version = opts.version.trim();
  if (!isVersionTag(version)) throw fail(`版本号不是 v<N> 的模样：「${opts.version}」`);
  const n = Number(version.slice(1));

  let milestones: readonly MilestoneDetail[];
  try {
    milestones = await github.milestones();
  } catch (e) {
    throw fail(`读 GitHub 上的里程碑失败：${text(e)}`);
  }

  // 合并时间只在「开着的里没有这一版」时要用（判是不是这次发布关的）；用不着就不去查，少一处会挂的地方。
  let mergedAt = opts.mergedAt?.trim() || undefined;
  const openHasIt = milestones.some((m) => m.state === 'open' && milestoneVersion(m.title) === n);
  if (!openHasIt && mergedAt === undefined) {
    const head = `release/${version}`;
    let pulls: readonly MergedPull[];
    try {
      pulls = await github.mergedPulls(head);
    } catch (e) {
      throw fail(`查 head=${head} 已合并的 PR 失败：${text(e)}`);
    }
    // 和打 tag 那一步取 merge_commit_sha 的是同一张：GitHub 回的先后里第一张已合并的。
    const [pr] = pulls;
    if (!pr) {
      throw fail(
        `没找到 head=${head} 已合并的 PR：手动补跑填的 version 多半写错了，或这一版的发布 PR 用的不是 ${head} 这个分支名。`,
      );
    }
    mergedAt = pr.mergedAt;
  }

  const d = decideReleaseMilestone({ version, milestones, mergedAt });
  if (d.kind === 'error') throw fail(d.message);
  const found = d.milestone;
  if (d.kind === 'already-closed') return { kind: 'already-closed', milestone: found, note: d.why };
  if (mode === 'check') {
    return {
      kind: 'will-close',
      milestone: found,
      note: `${version} 对得上开着的当前版本里程碑「${found.title}」：发完关它。`,
    };
  }

  let after: MilestoneDetail;
  try {
    after = await github.closeMilestone(found.number);
  } catch (e) {
    throw fail(`关「${found.title}」失败：${text(e)}`);
  }
  if (after.number !== found.number || after.state !== 'closed') {
    throw fail(
      `关「${found.title}」之后 GitHub 回的是 #${after.number}「${after.title}」、状态 ${after.state}：没关上，不当成关了。`,
    );
  }
  return {
    kind: 'closed',
    milestone: after,
    note: `里程碑「${after.title}」已关（${after.closedAt ?? '没给关掉的时间'}）。`,
  };
}

function text(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}
