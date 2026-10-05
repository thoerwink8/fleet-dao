// 发布收尾里「核版本里程碑（打 tag 之前）」「关里程碑」两步：读 GitHub 上的里程碑、这张发布 PR 合并的时间，
// 照 publish-release-logic.ts 的 decideReleaseMilestone 判；close 那一步再真关，拿 GitHub 的回包核是不是真关了。
// 由 release-finalize.ts 按先后调；测试在 packages/conventions/test/release-milestone.test.ts。
// 改这里之前必须知道：
// - check 在打 tag 之前跑：版本号对不上里程碑时，tag、release 一样都还没动——这是这一步存在的全部意义，别挪到 tag 后面。
// - 判不了（读不到、认不出、对不上）一律抛，那一步记红、后面都不走；不许拿「跳」冒充已经关过了（#593 第一次发布前修的就是这个）。
// - close 之前先把里程碑里还开着的单搬走（#995 第 2 条，创始人 2026-10-05 拍）：v3 发布时这一步把 #10 关了，里面 17 张
//   开着的单跟着被关在关掉的里程碑里。搬到下一个版本（开着的 v<N> 里比这一版大的最小的那个），没有就搬「未排期」（清空
//   里程碑），每张加留言说明；搬不动（读、留言、改、回读核对任一失败）就抛、记红，**不关里程碑**——「单没搬走但里程碑照关」
//   正是这次出事的做法，别用「跳」放过去。
import type { MergedPull, MilestoneDetail, PlanIssue } from './github-api.ts';
import { milestoneVersion, nextVersion } from './labels.ts';
import { decideReleaseMilestone, isVersionTag } from './publish-release-logic.ts';

export type ReleaseMilestoneMode = 'check' | 'close';

/** 要用到的 GitHub 几样（github-api.ts 的 liveGitHub 都有；测试换替身）。 */
export interface ReleaseMilestoneGitHub {
  milestones(): Promise<readonly MilestoneDetail[]>;
  mergedPulls(head: string): Promise<readonly MergedPull[]>;
  closeMilestone(n: number): Promise<MilestoneDetail>;
  /** 这个里程碑里的 issue，开着的、关了的都要（不含 PR）。关之前搬走还开着的那几张要用。 */
  milestoneIssues(n: number): Promise<readonly PlanIssue[]>;
  /** 这张单上所有留言的正文（留言去重、重跑不重发用）。 */
  comments(n: number): Promise<readonly string[]>;
  /** 往这张单上留言（搬迁说明）。 */
  comment(n: number, body: string): Promise<void>;
  /** 改这张单挂的里程碑：number 挂过去，null 是未排期。回改完之后挂的编号（未排期是 null）。 */
  setIssueMilestone(n: number, milestone: number | null): Promise<number | null>;
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
  /** close：关了，GitHub 回包里是 closed。moved 是关之前搬走的还开着的单（搬了几张、搬到哪）。 */
  | { kind: 'closed'; milestone: MilestoneDetail; moved: MilestoneMove; note: string }
  /** check / close：这一版的里程碑在这次发布合并之后已经关了（重跑），不再动它。 */
  | { kind: 'already-closed'; milestone: MilestoneDetail; note: string };

/** 关之前搬走的单：搬了几张、搬到哪（number 是要搬去的版本里程碑；null 是未排期）。 */
export interface MilestoneMove {
  count: number;
  to: { number: number; title: string } | null;
}

/**
 * 关里程碑之前：把「<旧版本标题>」里还开着的单搬到下一个版本，「<新版本标题>」——没有下一个版本就搬未排期。
 * 这是自动的（#995 第 2 条），要接着做就继续做；不做就关了它。
 */
export function moveComment(fromTitle: string, toTitle: string | null): string {
  const where =
    toTitle === null
      ? '现在没有下一个版本，先放回「未排期」（没挂版本），等排上版本再接走'
      : `自动搬到了下一个版本「${toTitle}」`;
  return [
    `「${fromTitle}」这个版本关了，这张单还没做完，${where}。`,
    '这是发布收尾关版本里程碑时自动搬的（#995 第 2 条）；接着做就继续做，不做了就关掉它。',
  ].join('\n\n');
}

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

  // 关之前先把里头的单搬走（#995 第 2 条）：搬不动就抛、不关（下面 moveOpenIssues 里说清为什么）。
  const moved = await moveOpenIssues({ github, milestone: found, n, fail });

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
    moved,
    note: `里程碑「${after.title}」已关（${after.closedAt ?? '没给关掉的时间'}）${
      moved.count === 0
        ? '；里头没有还开着的单。'
        : `；关之前把里头 ${moved.count} 张还开着的单搬到了${
            moved.to === null ? '未排期（没有下一个版本）' : `「${moved.to.title}」`
          }。`
    }`,
  };
}

/**
 * 关里程碑之前，把里面还开着的单搬到下一个版本（开着的 v<N> 里比这一版大的最小的那个），没有下一个版本就搬未排期。
 * 每张单加一条留言说明为什么（带旧版本名和新版本名）。
 *
 * 改这里之前必须知道：
 * - 搬不动一律抛（读里程碑里的单、读留言、留言、改里程碑、回读核对任一失败）——那一步记红、**里程碑不关**。
 *   「单没搬走但里程碑照关」正是 v3 出事那次的做法（#995 第 2 条），别拿「跳」放过去。
 * - 顺序是「先留言、后搬」：留完言搬的时候挂了，留言已经记着它要搬去哪，补跑照留言去办；反过来（先搬后留言）
 *   留言挂掉时单已经不在这个里程碑里了，补跑找不到它，那条说明就永远丢了。
 * - 幂等：留言先按正文去过重（重跑不重发），搬完再回读「这个里程碑里还有没有开着的单」核一遍，不拿「没报错」当搬好了。
 */
async function moveOpenIssues(a: {
  github: ReleaseMilestoneGitHub;
  milestone: MilestoneDetail;
  n: number;
  fail: (why: string) => Error;
}): Promise<MilestoneMove> {
  const { github, milestone, n, fail } = a;

  let inside: readonly PlanIssue[];
  try {
    inside = await github.milestoneIssues(milestone.number);
  } catch (e) {
    throw fail(`读「${milestone.title}」里的单失败（关之前要把还开着的搬走）：${text(e)}`);
  }
  const open = inside.filter((i) => i.state === 'open').sort((x, y) => x.number - y.number);
  if (open.length === 0) return { count: 0, to: null };

  // 目标：开着的 v<N> 里比这一版大的最小的那个；没有就搬未排期（清空里程碑）。
  const target = nextVersion(
    (await safeMilestones(github, fail)).filter((m) => m.state === 'open'),
    n,
  );
  const to = target === null ? null : { number: target.milestone.number, title: target.milestone.title };

  for (const issue of open) {
    const body = moveComment(milestone.title, to?.title ?? null);
    let said: readonly string[];
    try {
      said = await github.comments(issue.number);
    } catch (e) {
      throw fail(`读 #${issue.number} 的留言失败（核搬走说明了没有）：${text(e)}`);
    }
    if (!said.some((c) => c.trim() === body.trim())) {
      try {
        await github.comment(issue.number, body);
      } catch (e) {
        throw fail(`在 #${issue.number} 上写搬走说明失败：${text(e)}`);
      }
    }
    let now: number | null;
    try {
      now = await github.setIssueMilestone(issue.number, to?.number ?? null);
    } catch (e) {
      throw fail(`把 #${issue.number} 搬到${to === null ? '未排期' : `「${to.title}」`}失败：${text(e)}`);
    }
    if (now !== (to?.number ?? null)) {
      throw fail(
        `#${issue.number} 改完之后 GitHub 回的是「${now === null ? '未排期' : `#${now}`}」，不是` +
          `${to === null ? '未排期' : `「${to.title}」（#${to.number}）`}：没搬成，不关里程碑。`,
      );
    }
  }

  // 回读核对：真搬干净了才关。还开着的单留在原里程碑里就是「搬走失败」，别让它跟着里程碑一起关掉。
  let left: readonly PlanIssue[];
  try {
    left = await github.milestoneIssues(milestone.number);
  } catch (e) {
    throw fail(`搬完之后回读「${milestone.title}」里的单失败：${text(e)}`);
  }
  const leftOpen = left.filter((i) => i.state === 'open');
  if (leftOpen.length > 0) {
    throw fail(
      `搬完之后「${milestone.title}」里还剩 ${leftOpen.length} 张还开着的单（${leftOpen
        .map((i) => `#${i.number}`)
        .join('、')}）：没搬干净，不关里程碑。`,
    );
  }
  return { count: open.length, to };
}

/** 再读一遍里程碑（找下一个版本用）；读不到就抛——不想在「算不出搬到哪」的时候瞎搬。 */
async function safeMilestones(
  github: ReleaseMilestoneGitHub,
  fail: (why: string) => Error,
): Promise<readonly MilestoneDetail[]> {
  try {
    return await github.milestones();
  } catch (e) {
    throw fail(`读 GitHub 上的里程碑失败（算下一个版本要用）：${text(e)}`);
  }
}

function text(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}
