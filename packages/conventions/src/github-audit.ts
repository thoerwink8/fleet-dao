// GitHub 对账（#654）：每天一轮（.github/workflows/github-audit.yml），随时也能手跑 pnpm github:audit。
// 查的是「GitHub 上的单子现在的样子有没有断」：开着的单没有类别标签、母单的子单都关了它还开着、子单挂在已关的母单下面、
// 母单标签和子单对不上、版本里程碑说明里的先后和实际对不上。从前这些靠每天的关单对账、版本快照生成时顺带发现，那两样都删了
// （单子是需求唯一的家，关单证据在 pnpm issue:close 那一步查），只留这一道定时的；查出来的每一条都是要有人去修的，不是通知。
// 结果随单子开关、随时间变，所以不进 PR 的必过检查（#87），只在定时任务里跑，红了不挡任何 PR。
// 改这里之前必须知道：
// - 读不到 GitHub、读回来认不出：一律是「没查成」（退出码 2），不当成「没有断裂」。
// - 每一条规则在 test/github-audit.test.ts 里有一个查得出的例子和一个不该报的例子。
import type { Finding } from './findings.ts';
import type { GitHubReader, PlanIssue } from './github-api.ts';
import { isKindLabel, MOTHER_LABEL } from './labels.ts';
import { PlanProblem, readPlan } from './plan-view.ts';

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
    findings.push(...kindFindings(open), ...motherFindings(open, now));
    try {
      findings.push(...(await orphanFindings(open, gh)));
    } catch (e) {
      notQueried.push(`读不到母单的状态（${message(e)}），挂在已关母单下面的子单没核`);
    }
  }

  try {
    const plan = await readPlan(gh);
    checked.versions = plan.open.length + plan.closed.length;
    for (const note of plan.notes) findings.push({ issue: undefined, key: `plan-note:${note}`, text: note });
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

/** 母单和子单对得上：子单都关了的母单该关；有子单要贴「母单」标签；贴了标签却一直没有子单的摘掉。 */
function motherFindings(open: readonly PlanIssue[], now: Date): Finding[] {
  const found: Finding[] = [];
  for (const i of open) {
    // 接口没给子单数：不猜
    if (i.subIssues === undefined) continue;
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
