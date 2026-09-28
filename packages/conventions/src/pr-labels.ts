// PR 补贴：PR 缺类别标签、缺里程碑就补（创始人 2026-09-26：缺了不判红，由脚本补；#425）。
// .github/workflows/pr-labels.yml 跑它；design 第七节「标签和里程碑不靠人记得贴」。
// 挂了单的照抄那张单；不挂单的（认不出号，或认到的就是这个 PR 自己）按标题开头补类别、挂当前版本。
// PR 已有的不动。单自己未排期的不用当前版本填。补不上只提醒不失败。读、写 GitHub 出错一律判「没补成」（退出码 2），不当成没事。
import { readFileSync } from 'node:fs';
import type { GitHubPrLabeler, GitHubReader, IssueInfo, MilestoneInfo, PullInfo } from './github-api.ts';
import { isKindLabel, type KindLabel, milestoneVersion } from './labels.ts';
import { ISSUE_COLUMN, linkedIssue, PLAN_COLUMN, prColumns } from './pr-columns.ts';
import { planSaysUnscheduled } from './pr-fields.ts';

// 认 PR 挂了哪张单在 pr-columns.ts（合并闸认「认领对得上」也用它）；这里照旧导出，老的引用不用改
export { ISSUE_COLUMN, linkedIssue };

/** PR 现在的样子（号、标题、正文、标签、里程碑）。 */
export type PrState = PullInfo;

export interface LabelPlan {
  /** 对应的 issue 号；认不出是 undefined。 */
  issue: number | undefined;
  /** 要补的类别标签；不补是 undefined。 */
  addLabel: KindLabel | undefined;
  /** 要补的里程碑名字；不补是 undefined。 */
  milestone: string | undefined;
  /** 补不上的提醒，每样一句话。 */
  notes: string[];
}

/** 标题开头的类别：fix（可带范围、可带 !）是缺陷，feat 是需求，其余是杂项。不在开头的「请fix:」不算。 */
const KIND_PREFIX = /^\s*(fix|feat)\b(?:\([^)\n]*\))?!?:/i;

function kindFromTitle(title: string): KindLabel {
  const m = KIND_PREFIX.exec(title);
  if (!m?.[1]) return '杂项';
  return m[1].toLowerCase() === 'fix' ? '缺陷' : '需求';
}

/**
 * 当前版本的标题：还开着的 v<N> 里 N 最小的那个。和 core 的 currentVersion 同一条（这个包不依赖 core）。
 * 没有是 null。两个号一样时用列表里先出现的。
 */
export function currentVersionTitle(milestones: readonly MilestoneInfo[]): string | null {
  let best: { version: number; title: string } | null = null;
  for (const m of milestones) {
    if (m.state !== 'open') continue;
    const version = milestoneVersion(m.title);
    if (version === undefined) continue;
    if (best === null || version < best.version) best = { version, title: m.title };
  }
  return best?.title ?? null;
}

/**
 * 要补什么。`issue` 是读回来的对应 issue：号认不出时不用传；认出了号但 GitHub 上没有这个号，传 undefined。
 * `currentVersion` 是当前版本的标题（没有是 null）；只有不挂单、又缺里程碑、对应计划不是未排期时用。
 * 只算、不读不写：读 GitHub 出错由调用方判失败，不走到这里。
 */
export function planLabels(
  pr: PrState,
  ref: number | undefined,
  issue: IssueInfo | undefined,
  extra?: { currentVersion?: string | null },
): LabelPlan {
  const needLabel = !pr.labels.some(isKindLabel);
  const needMilestone = pr.milestone === null;
  const self = ref === pr.number;
  const plan: LabelPlan = {
    issue: self ? undefined : ref,
    addLabel: undefined,
    milestone: undefined,
    notes: [],
  };
  if (!needLabel && !needMilestone) return plan;
  const unscheduled = planSaysUnscheduled(prColumns(pr.body).get(PLAN_COLUMN));
  if (ref === undefined || self) {
    if (needLabel) plan.addLabel = kindFromTitle(pr.title);
    if (needMilestone && !unscheduled) {
      const version = extra?.currentVersion?.trim() || null;
      if (version) plan.milestone = version;
      else plan.notes.push(`PR #${pr.number} 缺里程碑，没有对应的单，也没有还开着的 v 版本，没挂。`);
    }
    return plan;
  }
  const missing = [needLabel ? '类别标签' : '', needMilestone ? '里程碑' : ''].filter(Boolean).join('、');
  const where = `PR #${pr.number} 缺${missing}`;
  if (!issue || issue.isPr) {
    const why = !issue ? 'GitHub 上没有这个号' : '是个 PR，不是 issue';
    plan.notes.push(`${where}，对应的 #${ref} ${why}，没法照抄，请手动贴。`);
    return plan;
  }
  if (needLabel) {
    const kinds = issue.labels.filter(isKindLabel);
    const [only] = kinds;
    if (kinds.length === 1 && only) plan.addLabel = only;
    else if (kinds.length === 0)
      plan.notes.push(`PR #${pr.number} 缺类别标签，对应的 #${ref} 自己也没有，请两边都贴上。`);
    else
      plan.notes.push(
        `对应的 #${ref} 有好几个类别标签（${kinds.join('、')}），不知道抄哪个，请给 PR #${pr.number} 手动贴一个。`,
      );
  }
  if (needMilestone) {
    if (issue.milestone !== null) plan.milestone = issue.milestone;
    else if (!unscheduled)
      plan.notes.push(`PR #${pr.number} 缺里程碑，对应的 #${ref} 自己也没有，请两边都挂上。`);
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
  const unlinked = ref === undefined || ref === pr.number;
  if (needs && ref !== undefined && ref !== pr.number) {
    try {
      issue = await opts.gh.issue(ref);
    } catch (e) {
      return fail(`读不到对应的 #${ref}（${message(e)}）`);
    }
  }
  // 不挂单且要挂当前版本才读里程碑列表。读失败先停，不写一半。对应计划写了未排期的不读。
  let knownMilestones: MilestoneInfo[] | undefined;
  let currentVersion: string | null = null;
  const needVersion =
    needs && unlinked && pr.milestone === null && !planSaysUnscheduled(prColumns(pr.body).get(PLAN_COLUMN));
  if (needVersion) {
    try {
      knownMilestones = await opts.gh.milestones();
    } catch (e) {
      return fail(`读不到里程碑列表（${message(e)}）`);
    }
    currentVersion = currentVersionTitle(knownMilestones);
  }
  const plan = planLabels(pr, ref, issue, { currentVersion });
  const lines: string[] = [];
  if (!plan.addLabel && !plan.milestone) {
    if (!needs) lines.push(`PR #${pr.number} 已有类别标签和里程碑，不用补。`);
    return { code: 0, lines, notes: plan.notes };
  }
  const dry = opts.dryRun ? '（试跑，没写）' : '';
  const copied = !unlinked;
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
      const why = copied ? `照抄 #${ref}` : '按标题开头，没有对应的单';
      lines.push(`PR #${pr.number} 补上类别标签「${plan.addLabel}」（${why}）${dry}。`);
    }
    if (plan.milestone) {
      const title = plan.milestone;
      const list = knownMilestones ?? (await opts.gh.milestones());
      const found = list.find((m) => m.title === title);
      if (!found) {
        const whose = copied ? `#${ref} 挂的里程碑` : '要挂的里程碑';
        return fail(`${whose}「${title}」在里程碑列表里找不到`);
      }
      if (!opts.dryRun) {
        const after = await opts.gh.setMilestone(pr.number, found.number);
        if (after !== title) {
          return fail(`给 PR #${pr.number} 挂了「${title}」，GitHub 回的是「${after ?? '没挂'}」`);
        }
      }
      const why = copied ? `照抄 #${ref}` : '没有对应的单，挂当前版本';
      lines.push(`PR #${pr.number} 补上里程碑「${title}」（${why}）${dry}。`);
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
