// PR 补贴：PR 缺类别标签、缺里程碑，按对应 issue 照抄（创始人 2026-09-26：缺了不判红，由脚本补）。
// .github/workflows/pr-labels.yml 跑它；design 第七节「标签和里程碑不靠人记得贴」。
// PR 已有的不动；找不到对应 issue、issue 自己也没有，只提醒不失败。读、写 GitHub 出错一律判「没补成」（退出码 2），不当成没事。
import { readFileSync } from 'node:fs';
import type { GitHubPrLabeler, GitHubReader, IssueInfo, PullInfo } from './github-api.ts';
import { isKindLabel, type KindLabel } from './labels.ts';
import { prColumns } from './pr-fields.ts';

/** 正文里写对应 issue 的那一栏（.github/pull_request_template.md）。 */
export const ISSUE_COLUMN = '需求';

/**
 * PR 对应的 issue 号：先看正文「需求」栏里第一个 #号，没有再看标题里第一个 (#号)（全角括号也算）。
 * 「owner/仓#号」这种别的仓的不算。都没有返回 undefined。
 */
export function linkedIssue(body: string, title: string): number | undefined {
  const col = prColumns(body).get(ISSUE_COLUMN.toLowerCase());
  const fromBody = col && /(?<![\w/#])#(\d+)\b/.exec(col)?.[1];
  if (fromBody) return Number(fromBody);
  const fromTitle = /[(（]\s*#(\d+)\s*[)）]/.exec(title)?.[1];
  return fromTitle ? Number(fromTitle) : undefined;
}

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

/**
 * 要补什么。`issue` 是读回来的对应 issue：号认不出时不用传；认出了号但 GitHub 上没有这个号，传 undefined。
 * 只算、不读不写：读 GitHub 出错由调用方判失败，不走到这里。
 */
export function planLabels(pr: PrState, ref: number | undefined, issue: IssueInfo | undefined): LabelPlan {
  const needLabel = !pr.labels.some(isKindLabel);
  const needMilestone = pr.milestone === null;
  const plan: LabelPlan = { issue: ref, addLabel: undefined, milestone: undefined, notes: [] };
  if (!needLabel && !needMilestone) return plan;
  const missing = [needLabel ? '类别标签' : '', needMilestone ? '里程碑' : ''].filter(Boolean).join('、');
  const where = `PR #${pr.number} 缺${missing}`;
  if (ref === undefined) {
    plan.notes.push(
      `${where}，正文「${ISSUE_COLUMN}」栏和标题里都没找到对应 issue 的 #号，没法照抄，请手动贴。`,
    );
    return plan;
  }
  if (ref === pr.number || !issue || issue.isPr) {
    const why = ref === pr.number ? '是这个 PR 自己' : !issue ? 'GitHub 上没有这个号' : '是个 PR，不是 issue';
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
    if (issue.milestone === null)
      plan.notes.push(`PR #${pr.number} 缺里程碑，对应的 #${ref} 自己也没有，请两边都挂上。`);
    else plan.milestone = issue.milestone;
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
  const plan = planLabels(pr, ref, issue);
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
      lines.push(`PR #${pr.number} 补上类别标签「${plan.addLabel}」（照抄 #${ref}）${dry}。`);
    }
    if (plan.milestone) {
      const title = plan.milestone;
      const found = (await opts.gh.milestones()).find((m) => m.title === title);
      if (!found) return fail(`#${ref} 挂的里程碑「${title}」在里程碑列表里找不到`);
      if (!opts.dryRun) {
        const after = await opts.gh.setMilestone(pr.number, found.number);
        if (after !== title) {
          return fail(`给 PR #${pr.number} 挂了「${title}」，GitHub 回的是「${after ?? '没挂'}」`);
        }
      }
      lines.push(`PR #${pr.number} 补上里程碑「${title}」（照抄 #${ref}）${dry}。`);
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
