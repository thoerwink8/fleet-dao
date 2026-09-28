// PR 补贴：PR 缺类别标签、缺里程碑，有对应 issue 就照抄；没有有效的对应 issue（#448 起替掉 #425 那套「没有就只提醒」
// 的做法）按标题前缀猜类别（fix→缺陷、feat→需求、其余常见前缀→杂项）、挂当前版本。
// .github/workflows/pr-labels.yml 跑它；design 第七节「标签和里程碑不靠人记得贴」。
// PR 已有的不动；读、写 GitHub 出错一律判「没补成」（退出码 2），不当成没事；猜不出类别、算不出当前版本才只提醒。
import { readFileSync } from 'node:fs';
import type { GitHubPrLabeler, GitHubReader, IssueInfo, MilestoneInfo, PullInfo } from './github-api.ts';
import { currentVersion, isKindLabel, type KindLabel, type MilestoneRef } from './labels.ts';
import { ISSUE_COLUMN, linkedIssue } from './pr-columns.ts';

// 认 PR 挂了哪张单在 pr-columns.ts；这里照旧导出，老的引用不用改
export { ISSUE_COLUMN, linkedIssue };

/** PR 现在的样子（号、标题、正文、标签、里程碑）。 */
export type PrState = PullInfo;

/** 标题开头的常见前缀猜类别（约定式提交那一套）；认不出返回 undefined，不猜。 */
const TITLE_KIND_PATTERNS: readonly (readonly [RegExp, KindLabel])[] = [
  [/^fix(?:\([^)]*\))?!?:/i, '缺陷'],
  [/^feat(?:ure)?(?:\([^)]*\))?!?:/i, '需求'],
  [/^(?:docs|chore|test|refactor|style|perf|build|ci|std)(?:\([^)]*\))?!?:/i, '杂项'],
];

/** PR 标题开头的前缀猜类别（fix→缺陷、feat→需求、docs/chore/test/refactor/style/perf/build/ci/std→杂项）。 */
export function titlePrefixKind(title: string): KindLabel | undefined {
  const t = title.trim();
  for (const [pattern, kind] of TITLE_KIND_PATTERNS) {
    if (pattern.test(t)) return kind;
  }
  return undefined;
}

export interface LabelPlan {
  /** 对应的 issue 号；认不出是 undefined。 */
  issue: number | undefined;
  /** 要补的类别标签；不补是 undefined。 */
  addLabel: KindLabel | undefined;
  /** addLabel 是照抄对应 issue 的，还是没有有效的对应 issue、按标题前缀猜的；不补时是 undefined。 */
  labelSource: 'issue' | 'title' | undefined;
  /** 要补的里程碑名字；不补是 undefined。 */
  milestone: string | undefined;
  /** milestone 是照抄对应 issue 的，还是没有有效的对应 issue、挂的当前版本；不补时是 undefined。 */
  milestoneSource: 'issue' | 'current-version' | undefined;
  /** 补不上的提醒，每样一句话。 */
  notes: string[];
}

/**
 * 要补什么。`issue` 是读回来的对应 issue：号认不出时不用传；认出了号但 GitHub 上没有这个号，传 undefined。
 * `openMilestones` 是仓里现在还开着的里程碑（挂当前版本、算版本交接用同一份 currentVersion 判法）。
 * 只算、不读不写：读 GitHub 出错由调用方判失败，不走到这里。
 */
export function planLabels(
  pr: PrState,
  ref: number | undefined,
  issue: IssueInfo | undefined,
  openMilestones: readonly MilestoneRef[],
): LabelPlan {
  const needLabel = !pr.labels.some(isKindLabel);
  const needMilestone = pr.milestone === null;
  const plan: LabelPlan = {
    issue: ref,
    addLabel: undefined,
    labelSource: undefined,
    milestone: undefined,
    milestoneSource: undefined,
    notes: [],
  };
  if (!needLabel && !needMilestone) return plan;
  const missing = [needLabel ? '类别标签' : '', needMilestone ? '里程碑' : ''].filter(Boolean).join('、');
  const where = `PR #${pr.number} 缺${missing}`;

  if (ref === undefined || ref === pr.number || !issue || issue.isPr) {
    // 没有一张有效的对应 issue 可抄（没找到号、号是这个 PR 自己、号在 GitHub 上没有、号是个 PR）：
    // 按标题前缀猜类别、挂当前版本，猜不出才提醒手动贴（#448，替掉 #425 那套「没有就只提醒」）。
    const why =
      ref === undefined
        ? `正文「${ISSUE_COLUMN}」栏和标题里都没找到对应 issue 的 #号`
        : ref === pr.number
          ? '对应的号是这个 PR 自己'
          : !issue
            ? `对应的 #${ref} 在 GitHub 上没有这个号`
            : `对应的 #${ref} 是个 PR，不是 issue`;
    if (needLabel) {
      const guess = titlePrefixKind(pr.title);
      if (guess) {
        plan.addLabel = guess;
        plan.labelSource = 'title';
      } else {
        plan.notes.push(`${where}（${why}），标题看不出 fix/feat 这类常见前缀，请手动贴类别。`);
      }
    }
    if (needMilestone) {
      const current = currentVersion(openMilestones);
      if (current) {
        plan.milestone = current.milestone.title;
        plan.milestoneSource = 'current-version';
      } else {
        plan.notes.push(`${where}（${why}），现在也没有还开着的 v<N> 里程碑，请手动挂里程碑。`);
      }
    }
    return plan;
  }
  if (needLabel) {
    const kinds = issue.labels.filter(isKindLabel);
    const [only] = kinds;
    if (kinds.length === 1 && only) {
      plan.addLabel = only;
      plan.labelSource = 'issue';
    } else if (kinds.length === 0)
      plan.notes.push(`PR #${pr.number} 缺类别标签，对应的 #${ref} 自己也没有，请两边都贴上。`);
    else
      plan.notes.push(
        `对应的 #${ref} 有好几个类别标签（${kinds.join('、')}），不知道抄哪个，请给 PR #${pr.number} 手动贴一个。`,
      );
  }
  if (needMilestone) {
    if (issue.milestone === null)
      plan.notes.push(`PR #${pr.number} 缺里程碑，对应的 #${ref} 自己也没有，请两边都挂上。`);
    else {
      plan.milestone = issue.milestone;
      plan.milestoneSource = 'issue';
    }
  }
  return plan;
}

export interface LabelRun {
  /** 0 = 补完了或不用补（可能带提醒）；2 = 没补成（读、写 GitHub 出错，事件认不出），job 要红。 */
  code: 0 | 2;
  /** 做了什么、为什么没补成。 */
  lines: string[];
  /** 提醒（写进 job summary，不失败）。 */
  notes: string[];
}

export async function runPrLabels(opts: {
  eventPath: string | undefined;
  gh: GitHubReader & GitHubPrLabeler;
  /** 只说要补什么，不写 GitHub（本机试跑用）。 */
  dryRun?: boolean;
}): Promise<LabelRun> {
  const fail = (why: string): LabelRun => ({ code: 2, lines: [`没补成：${why}。`], notes: [] });
  if (!opts.eventPath)
    return fail('没有 GITHUB_EVENT_PATH（这条在 GitHub Actions 的 pull_request_target 事件里跑）');
  let number: unknown;
  try {
    const event: unknown = JSON.parse(readFileSync(opts.eventPath, 'utf8'));
    number = isObject(event) && isObject(event.pull_request) ? event.pull_request.number : undefined;
  } catch (e) {
    return fail(`事件文件 ${opts.eventPath} 读不出来（${message(e)}）`);
  }
  if (typeof number !== 'number') return fail('事件里没有 pull_request.number');

  // 事件里的是事件那一刻的样子，按 PR 现在的样子判（前后两个事件挨着跑时，后一个看得到前一个补的）。
  let pr: PrState;
  try {
    pr = await opts.gh.pull(number);
  } catch (e) {
    return fail(`读不到 PR #${number} 现在的样子（${message(e)}）`);
  }
  const ref = linkedIssue(pr.body, pr.title);
  let issue: IssueInfo | undefined;
  const needs = !pr.labels.some(isKindLabel) || pr.milestone === null;
  if (needs && ref !== undefined && ref !== pr.number) {
    try {
      issue = await opts.gh.issue(ref);
    } catch (e) {
      return fail(`读不到对应的 #${ref}（${message(e)}）`);
    }
  }
  // 里程碑列表现读一次、planLabels 和写的时候都用它：挂当前版本要算 currentVersion（只看还开着的），
  // 按名字找回里程碑号要看全部（issue 挂的里程碑可能已经关了，那正是版本交接要处理的断链，这里只管抄对不对）。
  let milestones: MilestoneInfo[] = [];
  if (needs) {
    try {
      milestones = await opts.gh.milestones();
    } catch (e) {
      return fail(message(e));
    }
  }
  const openMilestones = milestones.filter((m) => m.state === 'open');
  const plan = planLabels(pr, ref, issue, openMilestones);
  const lines: string[] = [];
  if (!plan.addLabel && !plan.milestone) {
    if (!needs) lines.push(`PR #${pr.number} 已有类别标签和里程碑，不用补。`);
    return { code: 0, lines, notes: plan.notes };
  }
  const dry = opts.dryRun ? '（试跑，没写）' : '';
  try {
    if (plan.addLabel) {
      if (!opts.dryRun) {
        const after = await opts.gh.addLabel(pr.number, plan.addLabel);
        if (!after.includes(plan.addLabel)) {
          return fail(
            `给 PR #${pr.number} 加了「${plan.addLabel}」，GitHub 回的标签里没有它（${after.join('、') || '空'}）`,
          );
        }
      }
      const via = plan.labelSource === 'issue' ? `照抄 #${ref}` : '按标题猜的';
      lines.push(`PR #${pr.number} 补上类别标签「${plan.addLabel}」（${via}）${dry}。`);
    }
    if (plan.milestone) {
      const title = plan.milestone;
      const found = milestones.find((m) => m.title === title);
      if (!found) return fail(`里程碑「${title}」在里程碑列表里找不到`);
      if (!opts.dryRun) {
        const after = await opts.gh.setMilestone(pr.number, found.number);
        if (after !== title) {
          return fail(`给 PR #${pr.number} 挂了「${title}」，GitHub 回的是「${after ?? '没挂'}」`);
        }
      }
      const via = plan.milestoneSource === 'issue' ? `照抄 #${ref}` : '挂当前版本';
      lines.push(`PR #${pr.number} 补上里程碑「${title}」（${via}）${dry}。`);
    }
  } catch (e) {
    return { code: 2, lines: [...lines, `没补成：${message(e)}。`], notes: plan.notes };
  }
  return { code: 0, lines, notes: plan.notes };
}

function message(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}

function isObject(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}
