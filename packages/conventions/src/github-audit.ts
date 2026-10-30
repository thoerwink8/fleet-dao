// GitHub 对账（#654）：每天一轮（.github/workflows/github-audit.yml），随时也能手跑 pnpm github:audit。
// 查的是「GitHub 上的单子现在的样子有没有断」：开着的单没有类别标签、母单的子单都关了它还开着、子单挂在已关的母单下面、
// 母单标签和子单对不上、版本里程碑说明里的先后认不出、合并了的 PR 在「需求」栏 Refs 着它而它还开着（#995 拍 1 的 B，兜底：
// 合并时的自动收口 close-on-merge.ts 没收成、或当时还有别的 PR 挂着它的）。从前这些靠每天的关单对账、版本快照生成时顺带发现，那两样都删了
// （单子是需求唯一的家，关单证据在 pnpm issue:close 那一步查），只留这一道定时的；查出来的每一条都是要有人去修的，不是通知。
// 结果随单子开关、随时间变，所以不进 PR 的必过检查（#87），只在定时任务里跑，红了不挡任何 PR。
// 自动写两处：按唯一母单清单修复母子关系；清掉开着的版本里程碑先后段里已关或已挪走的号（#2393）。
// 改这里之前必须知道：
// - 读不到 GitHub、读回来认不出：一律是「没查成」（退出码 2），不当成「没有断裂」。
// - 每一条规则在 test/github-audit.test.ts 里有一个查得出的例子和一个不该报的例子。

import { whyLeave } from './close-on-merge.ts';
import { reconcileFamily } from './family-manifest.ts';
import type { Finding } from './findings.ts';
import { isFlowBranch } from './flow-branch.ts';
import type {
  GitHubFamilyReader,
  GitHubFamilyWriter,
  GitHubMilestoneWriter,
  GitHubReader,
  PlanIssue,
  PullBody,
} from './github-api.ts';
import { isKindLabel, MOTHER_LABEL } from './labels.ts';
import { parentField } from './parent-field.ts';
import { type Plan, PlanProblem, parseOrder, pruneOrder, readPlan } from './plan-view.ts';
import { issueColumnLinks } from './pr-columns.ts';
import { queryAxisProblems } from './query-axis.ts';
import { addDays, beijingDate, dueDateOf } from './version-cut.ts';

/** #2986 两轴约定落地主线后的新对象；历史存量按明确修复清单补，不擅自批量重分类。 */
const QUERY_AXIS_SINCE = Date.parse('2026-10-17T21:43:57Z');

function axisFindings(item: {
  number: number;
  labels: string[];
  createdAt: string;
  body?: string;
  milestone: string | null;
  isPr: boolean;
}): Finding[] {
  if (Date.parse(item.createdAt) < QUERY_AXIS_SINCE) return [];
  const problems = queryAxisProblems(item.labels);
  return problems.map((text, i) => ({
    issue: item.number,
    key: `query-axis:${item.number}:${i}:${text}`,
    text: `#${item.number} ${text}`,
  }));
}

export interface AuditResult {
  findings: Finding[];
  /** 没查成的几样（读不到 GitHub 等）：照样判红，不当成没有断裂。 */
  notQueried: string[];
  /** 这次查了多少：「0 条」才分得出是没问题还是根本没查。 */
  checked: { issues: number; versions: number };
  /** 这次顺手从版本先后里清掉的已关号（#2393）：哪个里程碑、清了哪几个。没清的版本不在里面。 */
  pruned: { milestone: string; removed: number[] }[];
  /** 这一轮读到的开着的单（对账红了开单时找同名的那张用）；没读到是 undefined。 */
  open: PlanIssue[] | undefined;
  /** 恰好一个开着的版本时它的里程碑号；否则 undefined。 */
  currentMilestone: number | undefined;
}

/**
 * writer 给了才会改里程碑说明（清先后里已关或已挪走的号）；不给就只读，不改。
 * 版本和先后读不到时不清（不拿读不到当成全关了），那一样已经记在 notQueried 里。
 */
export async function auditGitHub(
  gh: GitHubReader,
  now: Date,
  writer?: GitHubMilestoneWriter,
  family?: { reader: GitHubReader & GitHubFamilyReader; writer?: GitHubFamilyWriter },
): Promise<AuditResult> {
  const findings: Finding[] = [];
  const notQueried: string[] = [];
  const checked = { issues: 0, versions: 0 };
  const pruned: AuditResult['pruned'] = [];
  if (family) {
    const result = await reconcileFamily(family.reader, family.writer);
    findings.push(...result.findings);
    notQueried.push(...result.notQueried);
  }

  let open: PlanIssue[] | undefined;
  try {
    open = await gh.openIssues();
  } catch (e) {
    notQueried.push(`读不到开着的单（${message(e)}），单子本身的几条没核`);
  }
  if (open !== undefined) {
    checked.issues = open.length;
    findings.push(...kindFindings(open));
    for (const item of open) findings.push(...axisFindings(item));
    const family = await bodyFamilyFindings(open, gh);
    findings.push(...family.found);
    notQueried.push(...family.unknown);
    const mothers = motherFindings(open);
    findings.push(...mothers.found);
    if (mothers.unknown.length > 0) {
      const shown = mothers.unknown.slice(0, 10).map((n) => `#${n}`);
      const what = `${shown.join('、')}${mothers.unknown.length > 10 ? ` 等 ${mothers.unknown.length} 张` : ''}`;
      notQueried.push(`接口没给 ${what} 的子单数，母单和子单对不对没核`);
    }
    try {
      const pulls = await gh.recentPulls();
      findings.push(...mergedButOpenFindings(open, pulls), ...pullMilestoneFindings(pulls));
      if (now.getTime() >= QUERY_AXIS_SINCE) {
        for (const pull of pulls.filter((p) => p.state === 'open')) {
          try {
            const item = await gh.issue(pull.number);
            if (!item?.isPr) throw new Error('读不到 PR 标签或对象不是 PR');
            findings.push(...axisFindings(item));
          } catch (error) {
            notQueried.push(`PR #${pull.number} 查询轴没核：${message(error)}`);
          }
        }
      }
    } catch (e) {
      notQueried.push(`读不到最近的 PR（${message(e)}），合并了却还开着的单没核`);
    }
    try {
      findings.push(...(await orphanFindings(open, gh)));
    } catch (e) {
      notQueried.push(`读不到母单的状态（${message(e)}），挂在已关母单下面的子单没核`);
    }
  }

  // 开着却没排进先后的单不报：拉单、发版车本来就把没排进先后的排在后面照样拉（#2683 删了那一条）
  let plan: Plan | undefined;
  try {
    plan = await readPlan(gh);
    checked.versions = plan.open.length + plan.closed.length;
    const v = versionFindings(plan, now);
    findings.push(...v.found);
    notQueried.push(...v.unknown);
  } catch (e) {
    if (e instanceof PlanProblem)
      findings.push({ issue: undefined, key: `plan:${e.message}`, text: e.message });
    else notQueried.push(`读不到版本和先后（${message(e)}），里程碑说明里的先后没核`);
  }
  if (plan !== undefined && writer !== undefined) {
    await pruneClosedFromOrders(plan, writer, pruned, findings, notQueried);
  }
  const currentMilestone = plan?.open.length === 1 ? plan.open[0]?.milestone.number : undefined;
  return { findings, notQueried, checked, pruned, open, currentMilestone };
}

/**
 * 开着的版本的先后里有已关或已挪走的号：直接改掉说明（#2393，开单那一步清得到的是开单时的，这里兜住中间关掉的）。
 * 按「这个版本里开着的单」清（#2683）：挪去别的版本还开着的也清掉，不按全仓开着的单算。
 * 改回来的说明要再认一遍、先后恰好是我们要写的，不拿「接口回 200」当改好了。改不成记「没查成」；清光会留空先后的不动，出一条 finding。
 */
async function pruneClosedFromOrders(
  plan: Plan,
  writer: GitHubMilestoneWriter,
  pruned: AuditResult['pruned'],
  findings: Finding[],
  notQueried: string[],
): Promise<void> {
  for (const v of plan.open) {
    const m = v.milestone;
    const open = new Set(v.issues.filter((i) => i.state === 'open').map((i) => i.number));
    const cut = pruneOrder(m.description, open);
    if (!cut.ok) {
      findings.push({
        issue: undefined,
        key: `order-all-closed:${m.number}`,
        text: `里程碑「${m.title}」：${cut.problem}`,
      });
      continue;
    }
    if (cut.removed.length === 0) continue;
    try {
      const back = await writer.setMilestoneDescription(m.number, cut.description);
      const check = parseOrder(back.description);
      if (!check.ok || check.order.join() !== cut.order.join()) {
        throw new Error('改完回来的说明里先后和要写的对不上（可能改了一半），先打开看一眼');
      }
      pruned.push({ milestone: m.title, removed: cut.removed });
    } catch (e) {
      notQueried.push(
        `没改成里程碑「${m.title}」先后里已关的号（${message(e)}），#${cut.removed.join('、#')} 还在里面`,
      );
    }
  }
}

/**
 * 版本一周一版、到期自动收口（version-cut.ts，#2683）的兜底：开着的 v<N> 恰好一个、带到期日、过了到期日超过一天还没收口、
 * 已关的版本还挂着开着的单。收口任务没跑成、有人手工动了里程碑，这里每天报出来。
 */
function versionFindings(plan: Plan, now: Date): { found: Finding[]; unknown: string[] } {
  const found: Finding[] = [];
  const unknown: string[] = [];
  if (plan.open.length !== 1) {
    const list = plan.open.map((v) => `「${v.milestone.title}」`).join('') || '一个也没有';
    found.push({
      issue: undefined,
      key: `versions-open:${plan.open.map((v) => v.milestone.number).join(',')}`,
      text: `开着的 v<N> 版本该恰好一个，现在是 ${plan.open.length} 个（${list}）：多开的关掉（开着的单挪到留下的那个），一个都没有就等收口任务开一版或手动跑 .github/workflows/github-audit.yml 的 version-cut`,
    });
  }
  const [current] = plan.open;
  if (plan.open.length === 1 && current) {
    const due = dueDateOf(current.milestone);
    const title = current.milestone.title;
    if (due === undefined) unknown.push(`接口没给「${title}」的到期日（due_on），到没到期没核`);
    else if (due === null) {
      found.push({
        issue: undefined,
        key: `version-no-due:${current.milestone.number}`,
        text: `当前版本「${title}」没设到期日：在里程碑页上设一个（一周一版），不设就不会到期自动收口`,
      });
    } else if (beijingDate(now) > addDays(due, 1)) {
      found.push({
        issue: undefined,
        key: `version-overdue:${current.milestone.number}`,
        text: `当前版本「${title}」${due} 就到期了，过了一天多还没收口：看 .github/workflows/github-audit.yml 的 version-cut 任务为什么没收成，修好手动触发一次`,
      });
    }
  }
  for (const v of plan.closed) {
    const left = v.issues.filter((i) => i.state === 'open');
    if (left.length === 0) continue;
    found.push({
      issue: undefined,
      key: `closed-version-open:${v.milestone.number}:${left.map((i) => i.number).join(',')}`,
      text: `已关的版本「${v.milestone.title}」还挂着开着的单 ${left.map((i) => `#${i.number}`).join('、')}：收口任务每天会挪到当前版本；连着报就看它为什么没挪成`,
    });
  }
  return { found, unknown };
}

/** 开着的 PR 挂了里程碑（决定 0015：PR 不挂，里程碑页只数单子）。 */
function pullMilestoneFindings(pulls: readonly PullBody[]): Finding[] {
  return pulls
    .filter((p) => p.state === 'open' && typeof p.milestone === 'string')
    .map((p) => ({
      issue: undefined,
      key: `pr-milestone:${p.number}`,
      text: `开着的 PR #${p.number} 挂了里程碑「${p.milestone}」：PR 不挂里程碑（里程碑页只数单子），摘掉（gh pr edit ${p.number} --remove-milestone）`,
    }));
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
 * 母单和子单对得上：子单都关了的母单该关；有子单要贴「母单」标签。
 * 接口没给子单数的单（unknown）核不了，交回去记成「没查成」：不猜，也不当成没有断裂。
 */
function motherFindings(open: readonly PlanIssue[]): { found: Finding[]; unknown: number[] } {
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
        text: `#${i.number} 的 ${i.subIssues} 张子单都关了，它自己还开着：做完了就 pnpm issue:close ${i.number} --note "做成了什么"；还有活没拆成子单就补开子单`,
      });
    }
    if (i.subIssues > 0 && !isMother) {
      found.push({
        issue: i.number,
        key: `mother-label:${i.number}`,
        text: `#${i.number} 下面有 ${i.subIssues} 张子单，却没贴「${MOTHER_LABEL}」标签：贴上`,
      });
    }
  }
  return { found, unknown };
}

/** 批量母子单按正文 parent 字段对账；原生关系仍然保留，不能拿字段覆盖掉冲突。 */
async function bodyFamilyFindings(open: readonly PlanIssue[], gh: GitHubReader) {
  const found: Finding[] = [];
  const unknown: string[] = [];
  const linked = new Set<number>();
  const cached = new Map<number, PlanIssue | undefined>(open.map((i) => [i.number, i]));
  let complete = true;
  for (const i of open) {
    if (i.parent !== undefined) linked.add(i.parent);
    if (i.body === undefined) {
      complete = false;
      unknown.push(`接口没给 #${i.number} 的正文，parent 字段和空母单没核`);
      continue;
    }
    const field = parentField(i.body);
    if (field.kind === 'none') continue;
    if (field.kind === 'invalid') {
      complete = false;
      found.push({
        issue: i.number,
        key: `parent-invalid:${i.number}`,
        text: `#${i.number} 的 parent 字段认不出：只留一行 parent: #<母单号>，号必须是正整数`,
      });
      continue;
    }
    linked.add(field.number);
    if (i.parent !== undefined && i.parent !== field.number) {
      found.push({
        issue: i.number,
        key: `parent-conflict:${i.number}:${field.number}:${i.parent}`,
        text: `#${i.number} 正文 parent 指向 #${field.number}，原生母单却是 #${i.parent}：核对后把两处关系改成同一张母单`,
      });
    }
    try {
      if (!cached.has(field.number)) cached.set(field.number, await gh.issue(field.number));
      const mother = cached.get(field.number);
      const problem =
        mother === undefined
          ? '在 GitHub 上查不到'
          : mother.isPr
            ? '是 PR，不是母单'
            : !mother.labels.includes(MOTHER_LABEL)
              ? `没有「${MOTHER_LABEL}」标签，不是母单`
              : mother.state === 'closed'
                ? '已经关了'
                : undefined;
      if (problem) {
        found.push({
          issue: i.number,
          key: `parent-orphan:${i.number}:${field.number}`,
          text: `#${i.number} 正文 parent 指向的 #${field.number} ${problem}：核对母单后修正 parent 字段和原生关系，或关掉不再做的子单`,
        });
      }
    } catch (e) {
      unknown.push(`读不到 #${i.number} 的 parent 母单 #${field.number}（${message(e)}），正文母子关系没核`);
    }
  }
  // 只对批量能力管理的母单立即报空；目录母单允许空清单，不按创建时间报警。
  if (complete) {
    for (const i of open) {
      if (
        i.labels.includes(MOTHER_LABEL) &&
        i.body !== undefined &&
        /<!-- fleet:issue-batch:[^\s<>]+:mother -->/.test(i.body) &&
        i.subIssues === 0 &&
        !linked.has(i.number)
      ) {
        found.push({
          issue: i.number,
          key: `family-empty:${i.number}`,
          text: `#${i.number} 是批量创建的母单，却没有任何子单：核对批量创建结果，补齐子单或关闭这张半截母单`,
        });
      }
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
      text: `#${i.number} 开着，但 PR #${p.number}「${p.title}」（${p.mergedAt}）合并了，它的「需求」栏 Refs 着这张单、没有别的 PR 还挂着它：做完了就 pnpm issue:close ${i.number} --note "做成了什么"；还没做完，请在那张 PR 的「需求」栏那一行写明「分片、关不了它」`,
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
