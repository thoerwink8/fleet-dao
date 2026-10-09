// 拉单（#632 S2-2；specs/632-三段总调度/方案.md §五）：每 5 分钟一轮，引擎自己到 GitHub 读「该做的单」，替掉 webhook 接活加认领。
// 一轮 = 记下开始 → 对每个开了「让 AI 接活」的仓：读开着的单 → 逐张准入 → 排序 → 按空位从前往后起任务工作流 → 把结局记进 schedule_runs。
// 拉单本身不动单子（不贴「在做」、不抢认领）。
// 引擎自己按依据挑单（#1336，母单 #1335，创始人 2026-10-08「让ai自己挑挺好的」「按推荐」）：不再看挂没挂当前版本，
// 未排期的单、别的版本的单和其余单一样进候选；挂版本原来是硬闸，现在是排序加分，「交给引擎」标签也只是同档内的加分。
// 开单时间在不在开关之后原来也是硬闸（#1336 去掉过），#1338 换了个说法放回来：老单要先被整理会话判过（见下面「整理待办」）。
//
// 准入（先便宜的再贵的，不用现读 GitHub 的都在前面；排序之前一律不多读一次这张单）：
//   作者在白名单里（公开仓陌生人能开单，白名单是唯一的门）→ 不是母单、没贴「本机做」（「本机做」和「交给引擎」一起贴时以「本机做」为准）→
//   还没派过（和点名派单共用 readDispatchStanding：没有任务行，或行是 queued/stopped 且 Temporal 里没有任何一代；
//   有一代在跑或已结束算派过。问不清抛错，不当成没派过）→ 历史失败不超过 2 次 → 正文没写 .github/workflows/ 路径（#1194：引擎的令牌推不了改工作流的提交，写了的贴一次「本机做」、
//   留一句话）→ 没被开着的 PR 的「需求」栏挂着（#1197：已经有人在做，同样贴一次「本机做」）→ 交代齐不齐（四节齐，「怎么算做完」至少一条；
//   缺则留一次言，不拉）→ 改动规模不是最重档（单子列的路径超过 50 个）。
// 整理待办（#1338，临时指挥官，jobs/groom.ts）：开单时间早于「让 AI 接活」打开那一刻的老单，只有贴了「整理过」（整理会话判为仍成立）或
// 「交给引擎」才进候选（指挥官 2026-10-08：#1342 发到法国后引擎第一轮拉了两张前提已过期的老单）；开关之后新开的单照旧不需要。
// 贴了「待补」（整理会话判过期）或「要人拍」的任何单都不进候选。每个仓走完以后，有从没整理过的老单，或有空位却一条都没起、待办里还有
// 候选，就叫一次整理（autoGroomWhy；6 小时间隔、每天 3 次、一次一个由 requestGroom 判）。
// 排序（intake-pick.ts 的 comparePick）：版本先后列表里的序号 → 挂当前版本的 → 规模小 → 同档里贴了「交给引擎」的 → 历史失败少 → 开单早。
// 巡检仓里 canary 开的那张（标题认法 isCanaryIssueTitle，不另贴标签）先于所有仓的普通单，不看上面这几档。
// 起之前才现读这张单（开着、不是 PR、母单子单和「本机做」再核一遍）：只对真有空位的那几张读，不为每张开着的单读一次。
// 空位 = 每轮最多 5 条、同时在跑最多 6 条、每小时最多起 20 条、熔断没停拉（最近 6 条结束的任务里失败过半就停，冷却 1 小时后放 1 条试探）。
// 巡检单不计入每小时那 20 条、也不占名额（#1364：名额满了把巡检单挤掉，巡检会把通的链报成断）；本轮条数、在跑、熔断和其余准入闸照旧。
// 母单子单、本机做、版本这几道的判法是 @fleet-dao/core 的 dispatch.ts 的纯函数（familyGate、localGate），这里只排顺序。
//
// 改这里之前必须知道：
// - 读不到的不当成没有：读仓里的单失败、白名单读不出、现读一张单失败、起工作流失败，都记进 unchecked，这一轮记 partial / failed，
//   不记 ok（没跑成 ≠ 没问题）。「开关都关着」是正常的空闲，不是没扫到：scanned 里算上受管的仓，免得看门狗把空闲当成故障。
// - 同一张单任何时候最多一条任务工作流：工作流编号定死（taskWorkflowId），起的时候由真实现用 REJECT_DUPLICATE；这里再用
//   readDispatchStanding 先挡一道，省得每 5 分钟为已经派出去的单多读一次 GitHub。有一代在跑或已结束的，重开也不会自己重来：
//   要再做，在驾驶舱点「重做」（jobs/redo.ts 另起一代）。只有任务行、Temporal 里没有任何一代、行还是 queued 或 stopped 的，
//   不算派过，这一轮会接手那一行再起（不另建一行）。
// - 交代不全的单只留一次言：留言的幂等键由缺的内容算出来，同一处缺法不会每 5 分钟再留一条；缺的变了才是新的一条。
// - 每轮最多起 MAX_STARTS_PER_ROUND 条、同时在跑的任务工作流不超过 MAX_RUNNING_TASKS 条、每小时最多起 MAX_STARTS_PER_HOUR 条：
//   开关刚打开、一堆单同时合格时，一批一批地起，不一次把机器的内存和额度吃满；没起的下一轮（5 分钟后）自然再来。
//   巡检单不进每小时这 20 条（本轮、在跑照样占）。库里数「一小时起了几条」时也把它剔出去（real/intake.ts）：
//   新建的数任务行建出时刻，接手没有工作流的老行另数这一小时里成功的 task.adopt（建出时刻已在这一小时的不重复数）。
// - 熔断（intake-pick.ts 的 decideBreaker）：最近 6 条结束的任务里失败 4 条以上就整个停拉；冷却 1 小时后只放 1 条试探，试探成功才恢复，
//   试探失败再冷却 1 小时。进入和恢复各推一条通知。状态在设置表 engine.intakeBreaker 一行；读不到、认不出，这一轮一张单都不拉。
// - 排序只在准入之后：先过完不用现读 GitHub 的关，排好序、有空位才现读这张单（screenPlan）再起，免得开着的老单每轮各读一次。
// - 别的环境的巡检仓不收（#1136）：foreignCanaries 列出的 owner/name 这一轮不读单、不起任务。名单读不到就整轮没跑成，
//   不拿空名单顶（那会把别人的巡检单拉进来）。没给这个函数 = 没有别的环境。

import { createHash } from 'node:crypto';
import {
  ENGINE_LABEL,
  GROOM_PENDING_LABEL,
  GROOMED_LABEL,
  HUMAN_DECISION_LABEL,
  issueColumnRefs,
  LOCAL_LABEL,
  parseMd,
  sectionText,
} from '@fleet-dao/conventions';
import {
  cleanBody,
  currentVersion,
  familyGate,
  type IssueFamily,
  type IssueMilestones,
  localGate,
  type MilestoneRef,
} from '@fleet-dao/core';
import type { ScheduleResult } from '@fleet-dao/db';
import { humanPart } from '@fleet-dao/github';
import { errMessage } from '@fleet-dao/shared/util';
import type { GithubWhitelist } from '@fleet-dao/store';
import { isTrusted } from '@fleet-dao/store';
import type { IntakeRun } from '../contract.ts';
import {
  type BriefProblem,
  describeBriefProblems,
  moduleRefsOf,
  readTaskBrief,
  type TaskBrief,
} from '../runner/task-brief.ts';
import { TIER_HEAVYWEIGHT_FILE_THRESHOLD } from '../runner/tier.ts';
import { isCanaryIssueTitle } from './canary.ts';
import { normalizeCanarySlug } from './canary-scope.ts';
import { type IssueTaskRow, readDispatchStanding, type TaskGenerationFacts } from './dispatch-standing.ts';
import type { ScheduleRunLog } from './github-reconcile.ts';
import { AUTO_GROOM_TEXT, autoGroomWhy, type GroomRequestOutcome } from './groom-request.ts';
import {
  type BreakerEvent,
  type BreakerFacts,
  decideBreaker,
  HOUR_MS,
  hasVisibleSignal,
  hourlyRemaining,
  MAX_ISSUE_FAILURES,
  MAX_STARTS_PER_HOUR,
  type OrderBook,
  type PickKey,
  readOrderBook,
  serialOf,
  sortCandidates,
} from './intake-pick.ts';
import { clip } from './reconcile-common.ts';

/** 登记进 scheduled_jobs 的那一行：一次都没跑过也列得出来（看门狗按登记表查）。 */
export const INTAKE_JOB = {
  id: 'intake',
  name: '引擎拉单（读该做的单，起任务工作流）',
  schedule: '每 5 分钟',
  // 连着三轮没跑成才算过期：单子晚 15 分钟被拉起没关系，偶尔一轮慢不报。
  expectEveryMinutes: 15,
} as const;

/**
 * 合并闸认冷验收的结论、冷验收的真活动也接上了没有（S2-5 的 #625 让合并闸认 cold-verify 提交状态，S2-5b 接上任务工作流的 coldVerify）。
 * 没接上之前拉单不起任务：任务工作流挂的自动合并不能绕过验收，而人手挂、别的路径挂要等合并闸那一层才拦得住；冷验收没接上，
 * 引擎自己的 PR 又永远得不到 cold-verify。S2-5b 把它改成 true。
 * 开着「让 AI 接活」的仓又碰上它是 false：这一轮记没跑成、一张单都不拉——开关开早了要看得见，不悄悄空转。
 * 改回 false 要同时改 intake.test.ts 里钉住它的那一条（故意的）。
 */
export const MERGE_GATE_REQUIRES_COLD_VERIFY = true;

export const INTAKE_EVERY_MINUTES = 5;
/** 和对账补漏（整点起每 15 分钟）、路由探针（7、22、37、52 分）、看门狗（4、9、14…分）、每小时对账（41 分）错开：每小时 3、8、13……分。 */
export const INTAKE_OFFSET_MINUTES = 3;
/** 每轮最多起几条任务工作流。 */
export const MAX_STARTS_PER_ROUND = 5;
/** 同时在跑的任务工作流最多几条（再多就等，不是丢）。 */
export const MAX_RUNNING_TASKS = 6;
export { MAX_ISSUE_FAILURES, MAX_STARTS_PER_HOUR } from './intake-pick.ts';
/** why 最长多少字：没查成的一条一句，太多了截断（总数照写）。 */
export const INTAKE_WHY_MAX = 1500;

export interface IntakeRepo {
  id: string;
  owner: string;
  name: string;
  defaultBranch: string;
  testCommand: string;
  /** 「让 AI 接活」打开的时刻（ISO）；null＝关着。现在只当开关用：不再拿它和开单时间比（#1336）。 */
  autoDispatchSince: string | null;
}

/** 仓里还开着的一个里程碑；description 是说明原文（版本里的先后写在 <!-- fleet:order --> 之间）。 */
export type IntakeMilestone = MilestoneRef & { description?: string };

/** 列表里读到的一张开着的单（不含 PR）。 */
export interface IntakeIssue {
  number: number;
  title: string;
  body: string;
  /** 开单人；账号删了是 null（认不出的人不在白名单里）。 */
  author: { login: string; id: number; type: string } | null;
  createdAt: string;
  labels: string[];
  milestone: MilestoneRef | null;
}

/** 这张单此刻的样子（GitHub 现读，@fleet-dao/github 的 readIssuePlan）：版本、母单子单、标签，加开没开着、是不是 PR。 */
export type IntakePlan = IssueMilestones & IssueFamily & { state: 'open' | 'closed'; pullRequest: boolean };

export type IntakeSkipReason =
  | 'created_at_unreadable'
  | 'untrusted_author'
  | 'mother_ticket'
  | 'sub_issue'
  | 'reserved_local'
  | 'already_dispatched'
  | 'too_many_failures'
  | 'pr_claimed'
  | 'needs_human'
  | 'groom_pending'
  | 'not_groomed'
  | 'touches_workflows'
  | 'brief_incomplete'
  | 'too_large'
  | 'pull_request'
  | 'closed'
  | 'round_cap'
  | 'at_capacity'
  | 'hourly_cap'
  | 'breaker_open'
  | 'already_exists';

/** 这几种是「没查成」不是「不该派」：记进 unchecked，这一轮不记 ok。 */
const UNREADABLE: ReadonlySet<IntakeSkipReason> = new Set(['created_at_unreadable']);

export interface IntakeSkip {
  reason: IntakeSkipReason;
  why: string;
}

/** 贴了「交给引擎」：排序时同一规模档里靠前（不再绕过任何一道闸）。名字只认 conventions 的 ENGINE_LABEL。 */
function handsToEngine(labels: readonly string[]): boolean {
  return labels.includes(ENGINE_LABEL);
}

/**
 * 「本机做」这一道。只贴「本机做」用 localGate 的原话；又贴了「交给引擎」时以「本机做」为准，原因里写明冲突。
 * 母单、子单在这之前已经判过，这个标签绕不过那一道。
 */
function localSkip(labels: readonly string[]): IntakeSkip | null {
  const local = localGate({ labels });
  if (local.ok) return null;
  if (!handsToEngine(labels)) return { reason: local.reason, why: local.why };
  return {
    reason: 'reserved_local',
    why: `贴着「${LOCAL_LABEL}」又贴着「${ENGINE_LABEL}」：以「${LOCAL_LABEL}」为准，引擎不拉`,
  };
}

/**
 * 临时指挥官整理待办贴的两个标签（#1338）：「要人拍」（涉及改标准、删数据、花钱、workflows，要人先拍板）和「待补」（判为过期或前提不成立，
 * 建议关闭、等人看）。贴着任何一个，不管有没有贴「交给引擎」，引擎一律不拉。
 */
function groomHoldSkip(labels: readonly string[]): IntakeSkip | null {
  if (labels.includes(HUMAN_DECISION_LABEL)) {
    return { reason: 'needs_human', why: `贴着「${HUMAN_DECISION_LABEL}」：要人先拍板，摘掉标签才进候选` };
  }
  if (labels.includes(GROOM_PENDING_LABEL)) {
    return {
      reason: 'groom_pending',
      why: `贴着「${GROOM_PENDING_LABEL}」：整理待办的会话判它过期或前提不成立，等人看过、补好后摘掉标签`,
    };
  }
  return null;
}

/**
 * 开单时间早于「让 AI 接活」打开那一刻的老单，只有整理会话判为仍成立（贴了「整理过」）或明说交给引擎（「交给引擎」）才进候选
 * （指挥官 2026-10-08：#1342 发到法国后引擎第一轮就拉了两张前提已过期的老单）；开关之后新开的单照旧不需要。
 * since 认不出时不当成「不是老单」：按老单判（宁可不拉）。
 */
function oldIssueSkip(issue: IntakeIssue, since: string): IntakeSkip | null {
  const opened = Date.parse(issue.createdAt);
  const on = Date.parse(since);
  if (Number.isFinite(on) && opened >= on) return null;
  if (issue.labels.includes(GROOMED_LABEL) || issue.labels.includes(ENGINE_LABEL)) return null;
  return {
    reason: 'not_groomed',
    why: `开单（${issue.createdAt}）早于「让 AI 接活」打开（${since}），还没被整理会话判过仍成立：等整理（贴「${GROOMED_LABEL}」）或人贴「${ENGINE_LABEL}」`,
  };
}

/**
 * 只看列表里就有的东西能不能判掉（不再多读一次 GitHub）。回 null＝这一道都过了，往下走。
 * 判法的出处：开单时间读得出（排序要用它做最后一档，认不出算没查成，不猜）；作者白名单（公开仓唯一的门）；母单标签、本机做标签
 * （familyGate、localGate 里只靠标签的那部分；子单、挂了子单要多读一次，在 screenPlan）；整理待办贴的「要人拍」「待补」；
 * 老单要「整理过」或「交给引擎」（autoDispatchSince 给了才判）。
 * 不看「挂在当前版本上」（#1336）：别的版本、未排期的单和其余单一样进候选。
 */
export function screenListed(input: {
  issue: IntakeIssue;
  trusted: boolean;
  /** 「让 AI 接活」打开的时刻（ISO）；不给就不判老单。 */
  autoDispatchSince?: string | null | undefined;
}): IntakeSkip | null {
  const { issue } = input;
  if (!Number.isFinite(Date.parse(issue.createdAt))) {
    return {
      reason: 'created_at_unreadable',
      why: `开单时间认不出（${issue.createdAt}），排不了先后，不猜`,
    };
  }
  if (!input.trusted) return { reason: 'untrusted_author', why: '开单人不在白名单里' };
  const family = familyGate({ labels: issue.labels, parent: null, subIssues: 0 });
  if (!family.ok) return { reason: family.reason, why: family.why };
  const local = localSkip(issue.labels);
  if (local) return local;
  const hold = groomHoldSkip(issue.labels);
  if (hold) return hold;
  return input.autoDispatchSince ? oldIssueSkip(issue, input.autoDispatchSince) : null;
}

/**
 * 现读之后的最后一道（只对真有空位、马上要起的单读）：这个号开着、是 issue；母单子单、本机做按这一刻读到的再核一遍
 * （列表读到的可能早过时了）。版本不核了（#1336：挂哪个版本只影响排序）。
 */
export function screenPlan(plan: IntakePlan): IntakeSkip | null {
  if (plan.pullRequest) return { reason: 'pull_request', why: '这个号是 PR，不是 issue' };
  if (plan.state !== 'open') return { reason: 'closed', why: '这张单已经关了' };
  const family = familyGate(plan);
  if (!family.ok) return { reason: family.reason, why: family.why };
  return localSkip(plan.labels) ?? groomHoldSkip(plan.labels);
}

/**
 * 开着的 PR 的「需求」栏（Closes / Refs #号，同仓的）挂着哪些单：单号 → 挂着它的 PR 号（同一张单有几个 PR 挂，取号最小的）。
 * 认法是 conventions 的 issueColumnRefs（pr-open 拒开没挂单的 PR 用的同一份）。
 */
export function prClaimedIssues(pulls: readonly { number: number; body: string }[]): Map<number, number> {
  const claimed = new Map<number, number>();
  for (const pr of [...pulls].sort((a, b) => a.number - b.number)) {
    const { closes, refs } = issueColumnRefs(pr.body);
    for (const n of [...closes, ...refs]) {
      if (!claimed.has(n)) claimed.set(n, pr.number);
    }
  }
  return claimed;
}

/** 单子已有 PR 在做、引擎不拉时留在单子上的话。 */
export function prClaimedComment(prNumber: number): string {
  return [
    `引擎想拉起这张单，可开着的 PR #${prNumber} 的「需求」栏已经挂着它，说明已有人在做，先没派。`,
    '',
    `已给这张单贴了「${LOCAL_LABEL}」，引擎以后不再拉它。要交给引擎做的话，另开一张新单（不要和现有 PR 重复）。`,
  ].join('\n');
}

/** 单正文里认「要改工作流」的三节（不含「原话」：创始人的原话里顺口提到路径不算这张单要改它）。 */
const WORKFLOW_SECTIONS = ['场景', '已知的模块', '怎么算做完'] as const;
const WORKFLOW_PATH = /\.github\/workflows\/[\w.*-]*/;

/**
 * 单正文的场景、已知的模块、怎么算做完三节里写到的第一个 `.github/workflows/` 路径；没写回 null。
 * 引擎的 GitHub 令牌不能推改了工作流的提交（workflows_permission），这种单拉了只会白烧一轮（#1186 烧了约 35 万输入 token）。
 * 正文不是文字（读不到）就抛：不当成「没写工作流路径」。正文是空的不在这里管（交代齐不齐那一道会留言）。
 */
export function workflowPathIn(body: unknown): string | null {
  if (typeof body !== 'string')
    throw new Error(`单正文读不到（拿到的是 ${body === null ? 'null' : typeof body}）`);
  const text = cleanBody(humanPart(body));
  if (!text) return null;
  const doc = parseMd('单正文', text);
  for (const name of WORKFLOW_SECTIONS) {
    const hit = WORKFLOW_PATH.exec(sectionText(doc, name) ?? '');
    if (hit) return hit[0];
  }
  return null;
}

/** 单子要改工作流、引擎不拉时留在单子上的话。 */
export function workflowPathComment(path: string): string {
  return [
    `引擎想拉起这张单，可正文里写到了 \`${path}\`：引擎的 GitHub 令牌不能推改了 \`.github/workflows/\` 的提交（workflows_permission），拉了只会白烧一轮后卡在推送，先没派。`,
    '',
    `已给这张单贴了「${LOCAL_LABEL}」，留给本机做，引擎以后不再拉它。`,
  ].join('\n');
}

/** 交代不全时留在单子上的话。 */
export function incompleteComment(problems: readonly BriefProblem[]): string {
  return [
    '引擎想拉起这张单，可单子还缺东西，先没派：',
    '',
    describeBriefProblems(problems),
    '',
    `补齐后约 ${INTAKE_EVERY_MINUTES} 分钟内引擎会自动再看一遍；同一处缺法只留这一条话，缺的变了才会再留。`,
  ].join('\n');
}

/** 留言的幂等键：由缺的内容算出来，同一处缺法同一个键。 */
export function incompleteKey(problems: readonly BriefProblem[]): string {
  const digest = createHash('sha256').update(describeBriefProblems(problems)).digest('hex').slice(0, 12);
  return `intake-incomplete:${digest}`;
}

export interface IntakeDeps {
  /** 受管的仓（开关关着的也列出来：全关是正常的空闲，不是没扫到东西）。读不到照抛：这一轮记没跑成。 */
  repos(): Promise<IntakeRepo[]>;
  /**
   * 别的环境的巡检仓（owner/name，大小写无所谓）。这一轮不读这些仓的单（#1136）。
   * 不给 = 没有别的环境。读不到照抛：不当成「没有别人的仓」。
   */
  foreignCanaries?(): Promise<readonly string[]>;
  /** 作者白名单。读不到照抛：不当成「没有可信的人」。 */
  whitelist(): Promise<GithubWhitelist>;
  /** 这个仓开着的单加仓里还开着的里程碑（带说明原文，排序读版本里的先后）。读不到照抛。 */
  openIssues(repo: IntakeRepo): Promise<{ issues: IntakeIssue[]; openMilestones: IntakeMilestone[] }>;
  /** 这张单此刻的样子。读不到照抛。 */
  plan(repo: IntakeRepo, issueNumber: number): Promise<IntakePlan>;
  /**
   * 这张单的任务行。没有是 null。读不到照抛：不当成「没派过」。
   * 派出过没有不在这里判，和点名派单共用 readDispatchStanding。
   */
  issueTask(repo: IntakeRepo, issueNumber: number): Promise<IssueTaskRow | null>;
  /**
   * 这张单在 Temporal 里的各代。问不清回 ok:false，不许当成一代都没有。
   * 只有任务行存在时才会被问到。
   */
  taskGenerations(repo: IntakeRepo, issueNumber: number): Promise<TaskGenerationFacts>;
  /** 这个仓开着的 PR 的「需求」栏挂着的单（单号 → PR 号，见 prClaimedIssues）。读不到（含 PR 列表翻不完）照抛：不当成「没有 PR」。 */
  openPrClaims(repo: IntakeRepo): Promise<Map<number, number>>;
  /** 给单子贴「本机做」标签（幂等）。 */
  markLocal(input: { repo: IntakeRepo; issueNumber: number }): Promise<void>;
  /** 读主线上的需求文档；文件不在回 null，读失败照抛。 */
  readSpecDoc(input: { repo: IntakeRepo; path: string }): Promise<{ content: string } | null>;
  /** 现在在跑的任务工作流有几条。读不到照抛：不当成「一条没有」。 */
  runningTasks(): Promise<number>;
  /** 这张单历史上失败过几次（该单任务行的失败记录）。读不到照抛：不当成「没失败过」。 */
  failures(repo: IntakeRepo, issueNumber: number): Promise<number>;
  /** 从 since 起建出的任务行有几条（滚动一小时限速）。读不到照抛：不当成「一条没起」。 */
  startedSince(since: Date): Promise<number>;
  /** 熔断此刻的样子（最近结束的任务、熔断状态、试探那条的结局）。读不到、认不出照抛：不当成「正常」。 */
  breaker(): Promise<BreakerFacts>;
  /** 熔断状态变了：写库并推一条通知（trip 进入、recover 恢复；retrip 只重新计冷却、不再推）。写不成照抛：这一轮不拉。 */
  breakerChanged(input: { event: BreakerEvent; at: Date; why: string }): Promise<void>;
  /** 起任务工作流（编号定死、REJECT_DUPLICATE）：编号已经用过回 already_exists。 */
  start(input: {
    repo: IntakeRepo;
    issueNumber: number;
    title: string;
    /** 单子正文原样（建任务行的「原话」）。 */
    body: string;
    author: IntakeIssue['author'];
  }): Promise<'started' | 'already_exists'>;
  /** 在单子上留言（同一个键只留一条）；以前留过回 created: false。 */
  comment(input: {
    repo: IntakeRepo;
    issueNumber: number;
    key: string;
    body: string;
  }): Promise<{ created: boolean }>;
  /**
   * 叫一次临时指挥官整理待办（jobs/groom-request.ts 的 requestGroom，#1338）：拉单一轮走完一个仓，发现该叫了就调；被拒（间隔没到、
   * 次数用完、别的在做）是正常的，回 ok:false。写不进、读不到照抛：这一轮记没查成。不给（测试）就不叫。
   */
  groomRequest?(input: { repo: IntakeRepo; why: string }): Promise<GroomRequestOutcome>;
  /**
   * 这台引擎自己的巡检仓（owner/name，大小写无所谓）。巡检仓里标题是巡检单的那张不占每小时名额、排在所有候选最前；
   * 这个仓的里程碑只是没写先后标记时不打日志（写乱了照打）。不给、认不出 = 没有巡检仓，一张单都不豁免。
   */
  canaryRepo?: string | null;
  runs: ScheduleRunLog;
  now: () => Date;
  log: (level: 'info' | 'warn' | 'error', message: string, fields?: Record<string, unknown>) => void;
  /** 测试用：换掉每轮上限。 */
  limits?: { maxStartsPerRound?: number; maxRunningTasks?: number; maxStartsPerHour?: number };
  /** 测试用：换掉「合并闸认冷验收了没有」（默认 MERGE_GATE_REQUIRES_COLD_VERIFY）。 */
  gateLive?: boolean;
}

/** 这一轮没跑成：结局已经记进 schedule_runs，活动照样报失败，Temporal 里也看得见。 */
export class IntakeFailedError extends Error {
  readonly runId: number;
  constructor(runId: number, message: string) {
    super(message);
    this.name = 'IntakeFailedError';
    this.runId = runId;
  }
}

interface Tally {
  scanned: number;
  started: number;
  commented: number;
  skipped: Map<IntakeSkipReason, number>;
  unchecked: string[];
  /** 开着开关的仓里，列单子就失败了的有几个（全都失败＝这一轮没跑成）。 */
  reposFailed: number;
  reposOn: number;
  /** 这一轮开头读到的在跑条数，起一条加一。 */
  running: number;
  /** 这一轮开头读到的滚动一小时内已起的条数，起一条加一。 */
  hourStarted: number;
  /** 熔断这一轮还允许起几条（正常是 Infinity，起一条减一）和为什么。 */
  breakerAllow: number;
  breakerWhy: string;
  /** 别的环境的巡检仓，这一轮不读的有几个（#1136）。 */
  foreignSkipped: number;
}

function skip(t: Tally, slug: string, issue: number, s: IntakeSkip): void {
  t.skipped.set(s.reason, (t.skipped.get(s.reason) ?? 0) + 1);
  if (UNREADABLE.has(s.reason)) t.unchecked.push(`${slug}#${issue}：没查成：${s.why}`);
}

/**
 * 这张单引擎不该拉、要留给本机：先在单子上留一句话（幂等键只留一次），再贴「本机做」（幂等），下一轮起 localGate 就在列表里
 * 把它挡掉。先留言后贴标签：留言失败时标签没贴，下一轮整件事重来；标签失败时下一轮留言是幂等的，只重贴标签。
 */
async function holdForLocal(
  deps: IntakeDeps,
  t: Tally,
  repo: IntakeRepo,
  issue: IntakeIssue,
  hold: { reason: IntakeSkipReason; why: string; key: string; comment: string },
): Promise<void> {
  const slug = `${repo.owner}/${repo.name}`;
  const posted = await deps.comment({
    repo,
    issueNumber: issue.number,
    key: hold.key,
    body: hold.comment,
  });
  await deps.markLocal({ repo, issueNumber: issue.number });
  if (posted.created) {
    t.commented += 1;
    deps.log('info', `拉单：${slug}#${issue.number} 不拉（${hold.why}），已贴「${LOCAL_LABEL}」并留言`, {
      reason: hold.reason,
    });
  }
  skip(t, slug, issue.number, { reason: hold.reason, why: hold.why });
}

/** 过了准入、等排序和空位的一张单。 */
interface Candidate {
  issue: IntakeIssue;
  brief: TaskBrief;
  key: PickKey;
  /** 巡检仓里 canary 开的那张：排最前，不占每小时名额。其余闸已经在准入里过完。 */
  canary: boolean;
}

/** 这台引擎的巡检仓（大小写不论）。没配、认不出是 false。 */
function isCanaryRepo(repo: IntakeRepo, canaryRepo: string | null | undefined): boolean {
  const want = normalizeCanarySlug(canaryRepo);
  if (!want) return false;
  return normalizeCanarySlug(`${repo.owner}/${repo.name}`) === want;
}

/** 巡检仓里、标题和 canaryIssue 同一句。别的仓同标题、巡检仓里的普通单都不是。 */
function isCanaryTicket(
  repo: IntakeRepo,
  issue: IntakeIssue,
  canaryRepo: string | null | undefined,
): boolean {
  return isCanaryRepo(repo, canaryRepo) && isCanaryIssueTitle(issue.title);
}

/** 单子「已知的模块」里列了多少个不同的路径（超过 50 个算最重档，见 tier.ts）。 */
function listedModuleCount(brief: TaskBrief): number {
  return new Set(moduleRefsOf(brief.touches).refs.map((r) => r.path)).size;
}

/**
 * 准入：一张开着的单过完不用现读 GitHub 的所有关，回候选；不拉的记原因（该留言、该贴「本机做」的当场做）回 null。
 * 排序要用的东西（版本里的序号、是不是当前版本、规模、失败次数、开单时刻）都在这里一起算好。
 */
async function admitIssue(
  deps: IntakeDeps,
  repo: IntakeRepo,
  issue: IntakeIssue,
  ctx: { current: number | undefined; book: OrderBook },
  whitelist: GithubWhitelist,
  prClaims: () => Promise<Map<number, number>>,
  t: Tally,
): Promise<Candidate | null> {
  const slug = `${repo.owner}/${repo.name}`;
  const early = screenListed({
    issue,
    trusted: isTrusted(issue.author, whitelist),
    autoDispatchSince: repo.autoDispatchSince,
  });
  if (early) {
    skip(t, slug, issue.number, early);
    return null;
  }
  const standing = await readDispatchStanding(deps, repo, issue.number);
  if (standing.kind === 'uncertain') throw new Error(standing.why);
  if (standing.kind === 'dispatched') {
    skip(t, slug, issue.number, { reason: 'already_dispatched', why: '已经派出过' });
    return null;
  }
  const failures = await deps.failures(repo, issue.number);
  if (failures > MAX_ISSUE_FAILURES) {
    skip(t, slug, issue.number, {
      reason: 'too_many_failures',
      why: `这张单的任务已经失败过 ${failures} 次（上限 ${MAX_ISSUE_FAILURES}）：人看过原因后在驾驶舱点「重做」`,
    });
    return null;
  }
  // 正文要改 .github/workflows/：引擎推不上去，不拉（#1194）。正文读不到就抛，这张单这一轮记没查成
  const workflowPath = workflowPathIn(issue.body);
  if (workflowPath !== null) {
    await holdForLocal(deps, t, repo, issue, {
      reason: 'touches_workflows',
      why: `正文写了 ${workflowPath}，引擎推不了改工作流的提交`,
      key: 'intake-touches-workflows',
      comment: workflowPathComment(workflowPath),
    });
    return null;
  }
  // 已有开着的 PR 的「需求」栏挂着它：有人在做，别并行再写一遍（#1197，#1182 就是这样和已合的 PR 撞车的）。读不到 PR 列表就抛，
  // 这张单这一轮不拉、记没查成，不当成「没有 PR」
  const prNumber = (await prClaims()).get(issue.number);
  if (prNumber !== undefined) {
    await holdForLocal(deps, t, repo, issue, {
      reason: 'pr_claimed',
      why: `已有 PR #${prNumber} 在做`,
      key: `intake-pr-claimed:${prNumber}`,
      comment: prClaimedComment(prNumber),
    });
    return null;
  }

  // 单子正文就用列表里读到的这份，不再读一遍；指着的需求文档要读主线上的
  const brief = await readTaskBrief(
    {
      readIssue: async () => ({
        number: issue.number,
        title: issue.title,
        body: issue.body,
        state: 'open',
      }),
      readSpecDoc: ({ path }) => deps.readSpecDoc({ repo, path }),
    },
    { repo: { owner: repo.owner, name: repo.name }, issueNumber: issue.number },
  );
  if (!brief.ok) {
    const posted = await deps.comment({
      repo,
      issueNumber: issue.number,
      key: incompleteKey(brief.problems),
      body: incompleteComment(brief.problems),
    });
    if (posted.created) {
      t.commented += 1;
      deps.log('info', `拉单：${slug}#${issue.number} 交代不全，已在单子上留言`, {
        problems: brief.problems.map((p) => p.field),
      });
    }
    skip(t, slug, issue.number, {
      reason: 'brief_incomplete',
      why: brief.problems.map((p) => p.field).join('、'),
    });
    return null;
  }

  // 规模：单子列的路径超过 50 个算最重档（tier.ts），改动面太大，引擎不拉
  const moduleCount = listedModuleCount(brief.brief);
  if (moduleCount > TIER_HEAVYWEIGHT_FILE_THRESHOLD) {
    skip(t, slug, issue.number, {
      reason: 'too_large',
      why: `单子「已知的模块」列了 ${moduleCount} 处（超过 ${TIER_HEAVYWEIGHT_FILE_THRESHOLD}），规模是最重档：先拆小再交给引擎`,
    });
    return null;
  }
  // 验收条看不看得见：只判结构（有没有代码、路径、文件名、引号里的界面文字、数字）。一条信号都没有是「拿不准」：照拉，只记一笔
  if (!hasVisibleSignal(brief.brief.acceptance)) {
    deps.log(
      'info',
      `拉单：${slug}#${issue.number} 的「怎么算做完」没认出路径、文件名或具体的现象，照拉（只记不拦）`,
      {
        acceptance: brief.brief.acceptance.length,
      },
    );
  }
  const created = Date.parse(issue.createdAt);
  return {
    issue,
    brief: brief.brief,
    key: {
      serial: serialOf(ctx.book, issue.milestone, issue.number),
      current:
        ctx.current !== undefined && issue.milestone !== null && issue.milestone.number === ctx.current,
      tierRank: brief.brief.tier.tier === 'fast' ? 0 : brief.brief.tier.tier === 'medium' ? 1 : 2,
      moduleCount,
      handed: handsToEngine(issue.labels),
      failures,
      createdAtMs: created,
    },
    canary: isCanaryTicket(repo, issue, deps.canaryRepo),
  };
}

/**
 * 空位：每轮条数、同时在跑、每小时、熔断，哪一个先用完就按哪一个的原因不起。回 null＝还有位子。
 * 先看便宜的、说得最清楚的：本轮上限 → 在跑上限 → 每小时 → 熔断。
 * hourlyExempt：巡检单不看每小时名额（本轮、在跑、熔断照旧）。
 */
function noRoom(deps: IntakeDeps, t: Tally, opts?: { hourlyExempt?: boolean }): IntakeSkip | null {
  const maxStarts = deps.limits?.maxStartsPerRound ?? MAX_STARTS_PER_ROUND;
  const maxRunning = deps.limits?.maxRunningTasks ?? MAX_RUNNING_TASKS;
  const maxHourly = deps.limits?.maxStartsPerHour;
  if (t.started >= maxStarts) {
    return { reason: 'round_cap', why: `这一轮已经起了 ${maxStarts} 条，其余下一轮` };
  }
  if (t.running >= maxRunning) {
    return { reason: 'at_capacity', why: `在跑的任务已经 ${t.running} 条（上限 ${maxRunning}），等有空的` };
  }
  if (!opts?.hourlyExempt) {
    const hourly = hourlyRemaining(t.hourStarted, maxHourly);
    if (hourly <= 0) {
      return {
        reason: 'hourly_cap',
        why: `最近一小时已经起了 ${t.hourStarted} 条（每小时最多 ${maxHourly ?? MAX_STARTS_PER_HOUR} 条），等滚出一小时`,
      };
    }
  }
  if (t.breakerAllow <= 0) return { reason: 'breaker_open', why: t.breakerWhy };
  return null;
}

/** 排好序之后，从前往后起：有空位才现读这张单再核一遍，核过了才起。起成了回 true。 */
async function startCandidate(deps: IntakeDeps, repo: IntakeRepo, c: Candidate, t: Tally): Promise<boolean> {
  const slug = `${repo.owner}/${repo.name}`;
  const { issue } = c;
  const full = noRoom(deps, t, { hourlyExempt: c.canary });
  if (full) {
    skip(t, slug, issue.number, full);
    return false;
  }
  const late = screenPlan(await deps.plan(repo, issue.number));
  if (late) {
    skip(t, slug, issue.number, late);
    return false;
  }
  const got = await deps.start({
    repo,
    issueNumber: issue.number,
    title: c.brief.title,
    body: issue.body,
    author: issue.author,
  });
  if (got === 'already_exists') {
    skip(t, slug, issue.number, { reason: 'already_exists', why: '任务工作流的编号已经用过' });
    return false;
  }
  t.started += 1;
  t.running += 1;
  // 巡检单不占每小时那 20 个名额：这一轮后面的普通单还能起满，下一轮库里数的时候也把它剔出去
  if (!c.canary) t.hourStarted += 1;
  t.breakerAllow -= 1;
  deps.log('info', `拉单：起了 ${slug}#${issue.number} 的任务工作流`, {
    tier: c.brief.tier.tier,
    why: c.brief.tier.reason,
    serial: c.key.serial,
    current: c.key.current,
    failures: c.key.failures,
    canary: c.canary,
  });
  return true;
}

/** 巡检仓只是没写先后标记时不记（这个仓不需要先后列表）。写乱了、别的仓缺标记，照旧记。 */
const MISSING_ORDER_MARK = '说明里没有先后标记';

function orderProblemsToLog(
  repo: IntakeRepo,
  problems: readonly string[],
  canaryRepo: string | null | undefined,
): string[] {
  if (!isCanaryRepo(repo, canaryRepo)) return [...problems];
  return problems.filter((p) => !p.includes(MISSING_ORDER_MARK));
}

interface PreparedRepo {
  repo: IntakeRepo;
  admitted: Candidate[];
  skippedBefore: Map<IntakeSkipReason, number>;
}

/** 第一段：列单、记先后、准入。不起任务。开关关着、单子读不到回 null。 */
async function prepareRepo(
  deps: IntakeDeps,
  repo: IntakeRepo,
  whitelist: GithubWhitelist,
  t: Tally,
): Promise<PreparedRepo | null> {
  const slug = `${repo.owner}/${repo.name}`;
  if (repo.autoDispatchSince === null) return null;
  t.reposOn += 1;
  const skippedBefore = new Map(t.skipped);
  let listed: Awaited<ReturnType<IntakeDeps['openIssues']>>;
  try {
    listed = await deps.openIssues(repo);
  } catch (err) {
    t.reposFailed += 1;
    t.unchecked.push(`${slug}：开着的单读不到（${errMessage(err)}）`);
    return null;
  }
  // 开着的 PR 的挂单表：这一轮这个仓里第一张走到这道关的单才读，读一次（读失败的话，后面的单拿到的是同一个错，各自记没查成）
  let claims: Promise<Map<number, number>> | undefined;
  const prClaims = () => {
    claims ??= deps.openPrClaims(repo);
    return claims;
  };
  // 版本里的先后和当前版本：排序用。先后认不出的版本，它的单算「没排进去」，原因只记日志（先后的对错归每天的 GitHub 对账管）
  const withOrder = listed.openMilestones.filter((m) => milestoneNeedsOrder(m, listed.issues));
  const { book, problems } = readOrderBook(
    withOrder.map((m) => ({ ...m, description: m.description ?? '' })),
  );
  const logged = orderProblemsToLog(repo, problems, deps.canaryRepo);
  if (logged.length > 0) {
    deps.log(
      'info',
      `拉单：${slug} 有版本的先后认不出，这些版本里的单排在没排进去的那档：${logged.join('；')}`,
      {
        problems: logged,
      },
    );
  }
  const ctx = { current: currentVersion(listed.openMilestones)?.milestone.number, book };

  const admitted: Candidate[] = [];
  for (const issue of listed.issues) {
    t.scanned += 1;
    try {
      const c = await admitIssue(deps, repo, issue, ctx, whitelist, prClaims, t);
      if (c) admitted.push(c);
    } catch (err) {
      // 这张单没处理成（读历史、留言、贴标签出错）：记下，别的单照做
      t.unchecked.push(`${slug}#${issue.number}：${errMessage(err)}`);
    }
  }
  return { repo, admitted, skippedBefore };
}

async function startOne(deps: IntakeDeps, repo: IntakeRepo, c: Candidate, t: Tally): Promise<boolean> {
  try {
    return await startCandidate(deps, repo, c, t);
  } catch (err) {
    t.unchecked.push(`${repo.owner}/${repo.name}#${c.issue.number}：${errMessage(err)}`);
    return false;
  }
}

/** 该不该叫一次临时指挥官整理待办（#1338）。只判触发条件，6 小时间隔、每日次数、锁、总开关由 requestGroom 判。 */
async function groomRepo(
  deps: IntakeDeps,
  repo: IntakeRepo,
  admitted: readonly Candidate[],
  skippedBefore: Map<IntakeSkipReason, number>,
  startedHere: number,
  t: Tally,
): Promise<void> {
  if (!deps.groomRequest) return;
  const slug = `${repo.owner}/${repo.name}`;
  const delta = (reason: IntakeSkipReason) => (t.skipped.get(reason) ?? 0) - (skippedBefore.get(reason) ?? 0);
  const why = autoGroomWhy({
    spare: noRoom(deps, t) === null,
    started: startedHere,
    backlog:
      delta('brief_incomplete') +
      delta('too_large') +
      delta('too_many_failures') +
      (admitted.length - startedHere),
    ungroomedOld: delta('not_groomed'),
  });
  if (why === null) return;
  try {
    const got = await deps.groomRequest({ repo, why: AUTO_GROOM_TEXT[why] });
    if (got.ok) {
      deps.log('info', `拉单：${slug} 叫了一次整理待办（${AUTO_GROOM_TEXT[why]}）`, {
        requestId: got.requestId,
        remainingAfter: got.remainingAfter,
      });
    }
  } catch (err) {
    t.unchecked.push(`${slug}：叫整理待办没成（${errMessage(err)}）`);
  }
}

/**
 * 各仓先准入，再起。巡检单先于所有仓的普通单（普通仓按名单顺序，仓内仍按 comparePick）；
 * 它不占每小时名额。整理待办仍按仓、在这个仓的普通单起完之后判。
 */
async function intakeRepos(
  deps: IntakeDeps,
  pulling: readonly IntakeRepo[],
  whitelist: GithubWhitelist,
  t: Tally,
): Promise<void> {
  const prepared: PreparedRepo[] = [];
  for (const repo of pulling) {
    const one = await prepareRepo(deps, repo, whitelist, t);
    if (one) prepared.push(one);
  }

  const canaryStarted = new Map<string, number>();
  const canaries = prepared.flatMap((p) =>
    p.admitted.filter((c) => c.canary).map((c) => ({ repo: p.repo, c })),
  );
  for (const item of sortCandidates(canaries, (x) => x.c.key)) {
    if (await startOne(deps, item.repo, item.c, t)) {
      canaryStarted.set(item.repo.id, (canaryStarted.get(item.repo.id) ?? 0) + 1);
    }
  }

  for (const p of prepared) {
    const startedBefore = t.started;
    const normals = sortCandidates(
      p.admitted.filter((c) => !c.canary),
      (x) => x.key,
    );
    for (const c of normals) await startOne(deps, p.repo, c, t);
    const startedHere = t.started - startedBefore + (canaryStarted.get(p.repo.id) ?? 0);
    await groomRepo(deps, p.repo, p.admitted, p.skippedBefore, startedHere, t);
  }
}

/** 有单挂在这个里程碑上才需要读它的先后（没单挂着的版本，先后认不出也不值得记）。 */
function milestoneNeedsOrder(m: MilestoneRef, issues: readonly IntakeIssue[]): boolean {
  return issues.some((i) => i.milestone?.number === m.number);
}

function summarize(t: Tally): string {
  const skipped = [...t.skipped].map(([reason, n]) => `${reason}×${n}`).join('、') || '无';
  const foreign = t.foreignSkipped > 0 ? `；别的环境的巡检仓跳过 ${t.foreignSkipped} 个` : '';
  return `起了 ${t.started} 条，留言 ${t.commented} 条；没派的：${skipped}${foreign}`;
}

async function round(deps: IntakeDeps): Promise<ScheduleResult> {
  let repos: IntakeRepo[];
  try {
    repos = await deps.repos();
  } catch (err) {
    return { outcome: 'failed', why: `受管的仓读不到：${errMessage(err)}` };
  }
  if (repos.length === 0) return { outcome: 'unscanned', why: '库里没有受管的仓' };
  let foreign = new Set<string>();
  if (deps.foreignCanaries) {
    try {
      foreign = new Set((await deps.foreignCanaries()).map((s) => s.toLowerCase()));
    } catch (err) {
      return {
        outcome: 'failed',
        why: `各环境的巡检仓名单读不到，这一轮一张单都没拉：${errMessage(err)}`,
        scanned: repos.length,
      };
    }
  }
  // 别人的巡检仓不读（#1136）。普通项目仓、自己的巡检仓照拉。
  const pulling = repos.filter((r) => !foreign.has(`${r.owner}/${r.name}`.toLowerCase()));
  const t: Tally = {
    scanned: repos.length,
    started: 0,
    commented: 0,
    skipped: new Map(),
    unchecked: [],
    reposFailed: 0,
    reposOn: 0,
    running: 0,
    hourStarted: 0,
    breakerAllow: Number.POSITIVE_INFINITY,
    breakerWhy: '',
    foreignSkipped: repos.length - pulling.length,
  };
  if (pulling.some((r) => r.autoDispatchSince !== null)) {
    if (!(deps.gateLive ?? MERGE_GATE_REQUIRES_COLD_VERIFY)) {
      return {
        outcome: 'failed',
        why: '「让 AI 接活」开着，但合并闸还没认冷验收的结论（S2-5，#625）：这一轮一张单都没拉。把项目的开关关掉，或等 S2-5 合进来',
        scanned: repos.length,
      };
    }
    let whitelist: GithubWhitelist | undefined;
    try {
      whitelist = await deps.whitelist();
      t.running = await deps.runningTasks();
    } catch (err) {
      return {
        outcome: 'failed',
        why: `白名单或在跑的任务数读不到，这一轮一张单都没拉：${errMessage(err)}`,
        scanned: repos.length,
      };
    }
    // 限速和熔断：读不到就不拉（不当成「一条没起」「没失败过」），状态变了先写库、推通知再拉
    try {
      const at = deps.now();
      t.hourStarted = await deps.startedSince(new Date(at.getTime() - HOUR_MS));
      const verdict = decideBreaker(await deps.breaker(), at);
      if (verdict.event !== null) {
        await deps.breakerChanged({ event: verdict.event, at, why: verdict.why });
        deps.log(verdict.event === 'recover' ? 'info' : 'warn', `拉单熔断：${verdict.event}，${verdict.why}`);
      }
      t.breakerAllow = verdict.allow;
      t.breakerWhy = verdict.why;
    } catch (err) {
      return {
        outcome: 'failed',
        why: `最近一小时已起的条数或熔断状态读不到（或状态写不进去），这一轮一张单都没拉：${errMessage(err)}`,
        scanned: repos.length,
      };
    }
    await intakeRepos(deps, pulling, whitelist, t);
  }
  const found = t.started + t.commented;
  deps.log('info', `拉单这一轮：${summarize(t)}`, { scanned: t.scanned, found });
  if (t.unchecked.length > 0) {
    const n = t.unchecked.length;
    const why = clip(`${n > 1 ? `${n} 处没查成：` : ''}${t.unchecked.join('；')}`, INTAKE_WHY_MAX);
    // 开着开关的仓全都没读成：这一轮等于没拉
    if (t.reposOn > 0 && t.reposFailed === t.reposOn)
      return { outcome: 'failed', why, scanned: t.scanned, found };
    return { outcome: 'partial', why, scanned: t.scanned, found };
  }
  return { outcome: 'ok', scanned: t.scanned, found };
}

/**
 * 跑一轮。记开始就失败（库连不上、没登记）：原样抛出，这一轮在库里没有记录——登记表上它会过期，看门狗照样看得见。
 * 没跑成：记成 failed 再抛 IntakeFailedError。记结局失败：原样抛出。
 */
export async function runIntakeJob(deps: IntakeDeps): Promise<IntakeRun> {
  const runId = await deps.runs.start(INTAKE_JOB.id, deps.now());
  let result: ScheduleResult;
  try {
    result = await round(deps);
  } catch (err) {
    result = { outcome: 'failed', why: `拉单没跑成：${errMessage(err)}` };
  }
  await deps.runs.finish(runId, result, deps.now());
  const run: IntakeRun = {
    runId,
    outcome: result.outcome,
    scanned: result.outcome === 'unscanned' ? 0 : (result.scanned ?? 0),
    found: result.outcome === 'unscanned' ? 0 : (result.found ?? 0),
    ...('why' in result ? { why: result.why } : {}),
  };
  const fields = { runId, outcome: run.outcome, scanned: run.scanned, found: run.found, why: run.why };
  if (run.outcome === 'failed') {
    deps.log('error', '拉单这一轮没跑成', fields);
    throw new IntakeFailedError(runId, run.why ?? '拉单没跑成');
  }
  if (run.outcome !== 'ok') deps.log('warn', '拉单这一轮没查全', fields);
  return run;
}
