// GitHub 对账（#654）：每天一轮（.github/workflows/github-audit.yml），随时也能手跑 pnpm github:audit。
// 查的是「GitHub 上的单子现在的样子有没有断」：开着的单没有类别标签、母单的子单都关了它还开着、子单挂在已关的母单下面、
// 母单标签和子单对不上、版本里程碑说明里的先后和实际对不上、合并了的 PR 在「需求」栏 Refs 着它而它还开着（#995 拍 1 的 B，兜底：
// 合并时的自动收口 close-on-merge.ts 没收成、或当时还有别的 PR 挂着它的）。从前这些靠每天的关单对账、版本快照生成时顺带发现，那两样都删了
// （单子是需求唯一的家，关单证据在 pnpm issue:close 那一步查），只留这一道定时的；查出来的每一条都是要有人去修的，不是通知。
// 结果随单子开关、随时间变，所以不进 PR 的必过检查（#87），只在定时任务里跑，红了不挡任何 PR。
// 改这里之前必须知道：
// - 读不到 GitHub、读回来认不出：一律是「没查成」（退出码 2），不当成「没有断裂」。
// - 每一条规则在 test/github-audit.test.ts 里有一个查得出的例子和一个不该报的例子。

import { whyLeave } from './close-on-merge.ts';
import type { Finding } from './findings.ts';
import { isFlowBranch } from './flow-branch.ts';
import type { GitHubReader, PlanIssue, PullBody } from './github-api.ts';
import { isKindLabel, MOTHER_LABEL } from './labels.ts';
import { PlanProblem, readPlan } from './plan-view.ts';
import { issueColumnLinks } from './pr-columns.ts';

/** 母单刚开、子单还没挂上的宽限：超过这么久还是空的才报。 */
const EMPTY_MOTHER_GRACE_MS = 24 * 3_600_000;

export interface AuditResult {
  findings: Finding[];
  /** 没查成的几样（读不到 GitHub 等）：照样判红，不当成没有断裂。 */
  notQueried: string[];
  /** 这次查了多少：「0 条」才分得出是没问题还是根本没查。 */
  checked: { issues: number; versions: number };
}

export async function auditGitHub(gh: GitHubReader, now: Date): Promise<AuditResult> {
  const findings: Finding[] = [];
  const notQueried: string[] = [];
  const checked = { issues: 0, versions: 0 };

  let open: PlanIssue[] | undefined;
  try {
    open = await gh.openIssues();
  } catch (e) {
    notQueried.push(`读不到开着的单（${message(e)}），单子本身的几条没核`);
  }
  if (open !== undefined) {
    checked.issues = open.length;
    findings.push(...kindFindings(open));
    const mothers = motherFindings(open, now);
    findings.push(...mothers.found);
    if (mothers.unknown.length > 0) {
      const shown = mothers.unknown.slice(0, 10).map((n) => `#${n}`);
      const what = `${shown.join('、')}${mothers.unknown.length > 10 ? ` 等 ${mothers.unknown.length} 张` : ''}`;
      notQueried.push(`接口没给 ${what} 的子单数，母单和子单对不对没核`);
    }
    try {
      findings.push(...mergedButOpenFindings(open, await gh.recentPulls()));
    } catch (e) {
      notQueried.push(`读不到最近的 PR（${message(e)}），合并了却还开着的单没核`);
    }
    try {
      findings.push(...(await orphanFindings(open, gh)));
    } catch (e) {
      notQueried.push(`读不到母单的状态（${message(e)}），挂在已关母单下面的子单没核`);
    }
  }

  try {
    const plan = await readPlan(gh);
    checked.versions = plan.open.length + plan.closed.length;
    for (const group of plan.loose) {
      for (const i of group.issues) {
        findings.push({
          issue: i.number,
          key: `loose:${i.number}:${group.milestone}`,
          text: `#${i.number} 开着，挂在「${group.milestone}」里却没排进先后：把它写进这个版本里程碑说明里 fleet:order 那段（它是子单就挂到母单下面），不做了就关掉`,
        });
      }
    }
  } catch (e) {
    if (e instanceof PlanProblem)
      findings.push({ issue: undefined, key: `plan:${e.message}`, text: e.message });
    else notQueried.push(`读不到版本和先后（${message(e)}），里程碑说明里的先后没核`);
  }
  return { findings, notQueried, checked };
}

/** 类别标签（需求、缺陷、杂项）恰好一个。 */
function kindFindings(open: readonly PlanIssue[]): Finding[] {
  const found: Finding[] = [];
  for (const i of open) {
    const kinds = i.labels.filter(isKindLabel);
    if (kinds.length === 1) continue;
    const text =
      kinds.length === 0
        ? `#${i.number} 没有类别标签：贴「需求」「缺陷」「杂项」里的一个（pnpm issue:new 开的单自带）`
        : `#${i.number} 贴了 ${kinds.length} 个类别标签（${kinds.join('、')}）：只留一个`;
    found.push({ issue: i.number, key: `kind:${i.number}:${kinds.join(',')}`, text });
  }
  return found;
}

/**
 * 母单和子单对得上：子单都关了的母单该关；有子单要贴「母单」标签；贴了标签却一直没有子单的摘掉。
 * 接口没给子单数的单（unknown）核不了，交回去记成「没查成」：不猜，也不当成没有断裂。
 */
function motherFindings(open: readonly PlanIssue[], now: Date): { found: Finding[]; unknown: number[] } {
  const found: Finding[] = [];
  const unknown: number[] = [];
  for (const i of open) {
    if (i.subIssues === undefined) {
      unknown.push(i.number);
      continue;
    }
    const isMother = i.labels.includes(MOTHER_LABEL);
    if (i.subIssues > 0 && i.subIssuesDone === i.subIssues) {
      found.push({
        issue: i.number,
        key: `mother-done:${i.number}`,
        text: `#${i.number} 的 ${i.subIssues} 张子单都关了，它自己还开着：做完了就 pnpm issue:close ${i.number}；还有活没拆成子单就补开子单`,
      });
    }
    if (i.subIssues > 0 && !isMother) {
      found.push({
        issue: i.number,
        key: `mother-label:${i.number}`,
        text: `#${i.number} 下面有 ${i.subIssues} 张子单，却没贴「${MOTHER_LABEL}」标签：贴上`,
      });
    }
    if (i.subIssues === 0 && isMother && now.getTime() - Date.parse(i.createdAt) > EMPTY_MOTHER_GRACE_MS) {
      found.push({
        issue: i.number,
        key: `mother-empty:${i.number}`,
        text: `#${i.number} 贴了「${MOTHER_LABEL}」标签，却一直没有子单：该有子单就挂上（pnpm issue:new --parent ${i.number}），本来就不是母单就摘掉标签`,
      });
    }
  }
  return { found, unknown };
}

/**
 * 有合并了的 PR 在「需求」栏 Refs 着它、它却还开着（#995 拍 1 的 B）：做完了没人关的候选，只出 finding、不动手关。
 * 条件和合并收口（close-on-merge.ts）一致，误报比漏报烦：
 * - 只看最近读到的 PR（RECENT_PULL_PAGES 页）；引擎任务流程的 PR 不看（它的单引擎自己关）；
 * - 只认 Refs（Closes 合并时 GitHub 自己关，开着多半是有人重开的）；那一行写了「分片、关不了它」的不算；
 * - 母单、「本机做」标签的、下面还有开着子单的不报；还有开着的 PR 的「需求」栏挂着它的不报（活还在做）。
 */
function mergedButOpenFindings(open: readonly PlanIssue[], pulls: readonly PullBody[]): Finding[] {
  const stillWorked = new Set<number>();
  /** 每张单：最近一张合并了、Refs 着它的 PR。 */
  const latest = new Map<number, PullBody>();
  for (const p of pulls) {
    const merged = p.mergedAt !== null;
    if (p.state === 'open') {
      for (const l of issueColumnLinks(p.body)) stillWorked.add(l.number);
    } else if (merged && !isFlowBranch(p.headRef)) {
      for (const l of issueColumnLinks(p.body)) {
        if (l.kind !== 'refs' || whyLeave(l, [])) continue;
        const prev = latest.get(l.number);
        if (!prev || (prev.mergedAt ?? '') < (p.mergedAt ?? '')) latest.set(l.number, p);
      }
    }
  }
  const found: Finding[] = [];
  for (const i of open) {
    const p = latest.get(i.number);
    if (!p || stillWorked.has(i.number)) continue;
    if (i.subIssues !== undefined && i.subIssues > (i.subIssuesDone ?? 0)) continue;
    if (whyLeave({ number: i.number, kind: 'refs', slice: false }, i.labels)) continue;
    found.push({
      issue: i.number,
      key: `merged-open:${i.number}:${p.number}`,
      text: `#${i.number} 开着，但 PR #${p.number}「${p.title}」（${p.mergedAt}）合并了，它的「需求」栏 Refs 着这张单、没有别的 PR 还挂着它：做完了就 pnpm issue:close ${i.number}；还没做完，请在那张 PR 的「需求」栏那一行写明「分片、关不了它」`,
    });
  }
  return found;
}

/** 开着的子单，母单已经关了（或查不到）：它在计划里藏在一张已关的单下面，没人会看到。 */
async function orphanFindings(open: readonly PlanIssue[], gh: GitHubReader): Promise<Finding[]> {
  const openNumbers = new Set(open.map((i) => i.number));
  const parentState = new Map<number, 'closed' | 'missing'>();
  const found: Finding[] = [];
  for (const i of open) {
    const parent = i.parent;
    if (parent === undefined || openNumbers.has(parent)) continue;
    let state = parentState.get(parent);
    if (state === undefined) {
      const p = await gh.issue(parent);
      // 开着的单都在 openNumbers 里；这里读回来还开着，说明读的两次之间有人刚重开了它，这一轮不报
      if (p !== undefined && p.state === 'open') continue;
      state = p === undefined ? 'missing' : 'closed';
      parentState.set(parent, state);
    }
    found.push({
      issue: i.number,
      key: `orphan:${i.number}:${parent}`,
      text: `#${i.number} 开着，它的母单 #${parent} ${state === 'closed' ? '已经关了' : '在 GitHub 上查不到'}：这张单还要做就把它从母单下面摘出来（母单页面上移除子议题）、挂到开着的母单或当独立单，不做了就关掉`,
    });
  }
  return found;
}

function message(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}
