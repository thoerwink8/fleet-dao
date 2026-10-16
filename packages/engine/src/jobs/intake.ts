// 拉单（#632 S2-2；specs/632-三段总调度/方案.md §五）：每 5 分钟一轮，引擎自己到 GitHub 读「该做的单」，替掉 webhook 接活加认领。
// 一轮 = 记下开始 → 对每个开了「让 AI 接活」的仓：读开着的单 → 逐张准入 → 排序 → 按空位从前往后起任务工作流 → 把结局记进 schedule_runs。
// 拉单本身不动单子（不贴「在做」、不抢认领）。
// 引擎自己按依据挑单（#1336，母单 #1335，「让ai自己挑挺好的」「按推荐」）：不再看挂没挂当前版本，
// 未排期的单、别的版本的单和其余单一样进候选；挂版本原来是硬闸，现在是排序加分，「交给引擎」标签也只是同档内的加分。
// 开单时间在不在开关之后原来也是硬闸（#1336 去掉过），#1338 换了个说法放回来：老单要先被整理会话判过（见下面「整理待办」）。
//
// 准入（先便宜的再贵的，不用现读 GitHub 的都在前面；排序之前一律不多读一次这张单）：
//   作者在白名单里（公开仓陌生人能开单，白名单是唯一的门；本仓工作流用 GITHUB_TOKEN 开的单，作者是 github-actions[bot]，也算可信）→
//   不是母单、没贴「本机做」（「本机做」和「交给引擎」一起贴时以「本机做」为准）→
//   还没派过（和点名派单共用 readDispatchStanding：没有任务行，或行是 queued/stopped 且 Temporal 里没有任何一代；
//   有一代在跑或已结束算派过。问不清抛错，不当成没派过）→ 历史失败不超过 2 次 → 正文没写 .github/workflows/ 路径（#1194：引擎的令牌推不了改工作流的提交，写了的贴一次「本机做」、
//   留一句话。有「已知的模块」一节时只看这一节列出的路径，其余段落里提到的不算；没有这一节的老单仍看场景、已知的模块、怎么算做完）→
//   没写改标准的路径（有「已知的模块」时同样只看这一节；没有这一节的老单仍看「已知的模块」和「怎么算做完」。清单在
//   packages/conventions/standard-paths.json，决定 0093：引擎的 PR 正文没有创始人原话，合并闸会永远判红；写了的同样贴一次「本机做」、
//   留一句话）→ 没被开着的 PR 的「需求」栏挂着（#1197：已经有人在做，同样贴一次「本机做」）→ 交代齐不齐（四节齐，「怎么算做完」至少一条；
//   缺则留一次言，不拉）→「怎么算做完」没有要 diff 外证据的条目（截图、线上、现场、审计、看日志、飞书收到……，判据是 conventions 的
//   offDiffItems，和 pnpm issue:new、驾驶舱开单同一份，决定 0093：不是用 issue:new 开的单也在这里挡住；有就留一次言、不拉）→
//   改动规模不是最重档（单子列的路径超过 50 个）。
// 整理待办（#1338，临时指挥官，jobs/groom.ts）：开单时间早于「让 AI 接活」打开那一刻的老单，只有贴了「整理过」（整理会话判为仍成立）或
// 「交给引擎」才进候选（指挥官：#1342 发到法国后引擎第一轮拉了两张前提已过期的老单）；开关之后新开的单照旧不需要。
// 贴了「待补」（整理会话判过期）或「要人拍」的任何单都不进候选。每个仓走完以后，有从没整理过的老单，或有空位却一条都没起、待办里还有
// 候选，就叫一次整理（autoGroomWhy；6 小时间隔、每天 3 次、一次一个由 requestGroom 判）。
// 排序（intake-pick.ts 的 comparePick）：版本先后列表里的序号 → 挂当前版本的 → 规模小 → 同档里贴了「交给引擎」的 → 历史失败少 → 开单早。
// 起之前才现读这张单（开着、不是 PR、母单子单和「本机做」再核一遍）：只对真有空位的那几张读，不为每张开着的单读一次。
// 空位 = 每轮最多 5 条、同时在跑最多 6 条、每小时最多起 20 条、熔断没停拉（最近 6 条结束的任务里失败过半就停，冷却 1 小时后放 1 条试探）。
// 母单子单、本机做、版本、工作流机器人作者这几道的判法是 @fleet-dao/core 的 dispatch.ts 的纯函数（familyGate、localGate、
// isGithubActionsAuthor），这里只排顺序。
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
//   库里数「一小时起了几条」：新建的数任务行建出时刻，接手没有工作流的老行另数这一小时里成功的 task.adopt（建出时刻已在这一小时的不重复数）。
// - 熔断（intake-pick.ts 的 decideBreaker）：最近 6 条结束的任务里失败 4 条以上就整个停拉；冷却 1 小时后只放 1 条试探，试探成功才恢复，
//   试探失败再冷却 1 小时。进入和恢复各推一条通知。状态在设置表 engine.intakeBreaker 一行；读不到、认不出，这一轮一张单都不拉。
// - 排序只在准入之后：先过完不用现读 GitHub 的关，排好序、有空位才现读这张单（screenPlan）再起，免得开着的老单每轮各读一次。
// - 每轮记下每个开着开关的仓「过了准入、只因没空位没起」的单有几张（recordWaiting，设置表 engine.intakeWaiting）：
//   看门狗的「主线 N 小时没合 PR」报警（jobs/merge-stall.ts，决定 0093）拿它判这个仓有没有引擎可接的单。
//   单子读不到的仓不写进去（不拿 0 冒充）；写不进记没查成。

import { createHash } from 'node:crypto';
import {
  describeOffDiff,
  ENGINE_LABEL,
  GROOM_PENDING_LABEL,
  GROOMED_LABEL,
  HUMAN_DECISION_LABEL,
  LOCAL_LABEL,
  loadStandardPaths,
  type MdDoc,
  matchesStandardPath,
  OFF_DIFF_REWRITE,
  type OffDiffItem,
  offDiffItems,
  parseMd,
  type StandardPath,
  sectionText,
} from '@fleet-dao/conventions';
import {
  cleanBody,
  currentVersion,
  familyGate,
  type IssueFamily,
  type IssueMilestones,
  isGithubActionsAuthor,
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
  asModuleRef,
  type BriefProblem,
  describeBriefProblems,
  moduleRefsOf,
  readTaskBrief,
  type TaskBrief,
} from '../runner/task-brief.ts';
import { TIER_HEAVYWEIGHT_FILE_THRESHOLD } from '../runner/tier.ts';
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
import { type LocalLeaseDeps, sweepLocalLeases } from './local-leases.ts';
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
  | 'touches_standard'
  | 'brief_incomplete'
  | 'acceptance_off_diff'
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
 * 临时指挥官整理待办贴的两个标签（#1338，决定 0097 把「要人拍」收成掏新钱、删了找不回又没备份）：「要人拍」和「待补」（判为过期或前提不成立，
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
 * （指挥官：#1342 发到法国后引擎第一轮就拉了两张前提已过期的老单）；开关之后新开的单照旧不需要。
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

// 开着的 PR 挂着哪些单、开 PR 前有没有别的 PR 挂着同一张单：认法在 conventions 的 pr-claims.ts（本机 pr:open、work claim 用同一份）
export { otherPrOnIssue, prClaimedIssues } from '@fleet-dao/conventions';

/** 单子已有 PR 在做、引擎不拉时留在单子上的话。 */
export function prClaimedComment(prNumber: number): string {
  return [
    `引擎想拉起这张单，可开着的 PR #${prNumber} 的「需求」栏已经挂着它，说明已有人在做，先没派。`,
    '',
    `已给这张单贴了「${LOCAL_LABEL}」，引擎以后不再拉它。要交给引擎做的话，另开一张新单（不要和现有 PR 重复）。`,
  ].join('\n');
}

/**
 * 没有「已知的模块」一节的老单，仍在这三节里认工作流路径（不含「原话」：创始人的原话里顺口提到路径不算这张单要改它）。
 * 有这一节时只看它（pathSections）。
 */
const WORKFLOW_SECTIONS = ['场景', '已知的模块', '怎么算做完'] as const;
// 整个目录（`.github/workflows`，不带末尾斜杠）也算：写的是「改那个目录」
const WORKFLOW_PATH = /\.github\/workflows(?:\/[\w.*-]*|(?![\w.-]))/;

/**
 * 有「已知的模块」一节时，路径只认这一节里写到的；没有这一节的老单用 fallback，不把「没写这一节」当成「没写路径」。
 * 一节在、但是空的，也算有这一节：别的段落里的路径不再算。
 */
function pathSections(doc: MdDoc, fallback: readonly string[]): readonly string[] {
  return sectionText(doc, '已知的模块') !== undefined ? ['已知的模块'] : fallback;
}

/**
 * 单正文里写到的第一个 `.github/workflows/` 路径；没写回 null。
 * 有「已知的模块」时只看这一节列出的路径，场景、怎么算做完、原话里提到的不算。没有这一节的老单仍看场景、已知的模块、怎么算做完。
 * 引擎的 GitHub 令牌不能推改了工作流的提交（workflows_permission），这种单拉了只会白烧一轮（#1186 烧了约 35 万输入 token）。
 * 正文不是文字（读不到）就抛：不当成「没写工作流路径」。正文是空的不在这里管（交代齐不齐那一道会留言）。
 */
export function workflowPathIn(body: unknown): string | null {
  if (typeof body !== 'string')
    throw new Error(`单正文读不到（拿到的是 ${body === null ? 'null' : typeof body}）`);
  const text = cleanBody(humanPart(body));
  if (!text) return null;
  const doc = parseMd('单正文', text);
  for (const name of pathSections(doc, WORKFLOW_SECTIONS)) {
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

/**
 * 没有「已知的模块」一节时，改标准的路径仍认这两节（场景、原话里顺口提到的路径不算）。
 * 有这一节时只看它（pathSections）。
 */
const STANDARD_SECTIONS = ['已知的模块', '怎么算做完'] as const;
// 没写进反引号的路径：只认仓里这几个顶层目录开头的（和 conventions 的 modulePaths 同一个口径，不补上级目录）
const BARE_PATH = /(?<![\w/.-])((?:packages|agents|docs|specs|deploy|scripts)\/[\w./*-]*[\w*/])/g;

/** 一条清单（目录、通配、单个文件）在什么前缀底下：目录是它自己，通配是第一个 * 之前的那段，单个文件是它自己。 */
function rulePrefix(rule: Pick<StandardPath, 'path'>): string {
  const star = rule.path.indexOf('*');
  return star < 0 ? rule.path : rule.path.slice(0, star);
}

/**
 * 单子写到的一个路径碰没碰这一条清单：文件按清单的匹配法判；目录（`agents/subagents/`、`agents/skills`）落在清单的目录里，
 * 或清单的东西在它底下，都算碰了（目录里改什么事先不知道，宁可多留给本机一张，不让引擎白烧一轮后卡在合并闸）。
 */
function refTouches(ref: { path: string; kind: 'file' | 'dir' }, rule: StandardPath): boolean {
  if (ref.kind === 'file') return matchesStandardPath(ref.path, rule);
  // 清单里单列的一个文件只认点名到它：列了它所在的目录（比如整个 packages/conventions/）不算
  if (!rule.path.endsWith('/') && !rule.path.includes('*')) return false;
  const dir = `${ref.path}/`;
  const prefix = rulePrefix(rule);
  return prefix.startsWith(dir) || dir.startsWith(prefix) || matchesStandardPath(dir, rule);
}

/**
 * 单正文里写到的第一个改标准的路径（清单在 packages/conventions/standard-paths.json）；没写回 null。
 * 有「已知的模块」时只看这一节列出的路径，怎么算做完、场景、原话里提到的不算。没有这一节的老单仍看「已知的模块」和「怎么算做完」。
 * 引擎开的 PR 正文里没有创始人原话，合并闸（merge-gate）碰了标准路径就判红，拉了只会做完卡在合并（决定 0093）。
 * 正文不是文字（读不到）就抛：不当成「没写」。
 */
export function standardPathIn(
  body: unknown,
  rules: readonly StandardPath[],
): { path: string; rule: StandardPath } | null {
  if (typeof body !== 'string')
    throw new Error(`单正文读不到（拿到的是 ${body === null ? 'null' : typeof body}）`);
  const text = cleanBody(humanPart(body));
  if (!text) return null;
  const doc = parseMd('单正文', text);
  for (const name of pathSections(doc, STANDARD_SECTIONS)) {
    const section = sectionText(doc, name) ?? '';
    const refs = [
      ...[...section.matchAll(/`([^`\n]+)`/g)].map((m) => asModuleRef(m[1] ?? '')),
      ...[...section.replace(/`[^`\n]*`/g, ' ').matchAll(BARE_PATH)].map((m) => asModuleRef(m[1] ?? '')),
    ].filter((r): r is NonNullable<typeof r> => r !== undefined);
    for (const ref of refs) {
      const rule = rules.find((r) => refTouches(ref, r));
      if (rule) return { path: ref.path, rule };
    }
  }
  return null;
}

/** 单子要改标准、引擎不拉时留在单子上的话。 */
export function standardPathComment(path: string, rule: StandardPath): string {
  return [
    `引擎想拉起这张单，可正文里要动的 \`${path}\` 是改标准的路径（清单 packages/conventions/standard-paths.json 的 \`${rule.path}\`：${rule.why}）。`,
    '改标准要创始人同意：PR 正文里得有他的原话，引擎开的 PR 没有，合并闸会一直判红，拉了只会做完卡在合并，先没派。',
    '',
    `已给这张单贴了「${LOCAL_LABEL}」，留给本机做（\`pnpm pr:open --founder-quote\` 带上原话），引擎以后不再拉它。`,
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
  /** 改标准的路径清单（standard-paths.json）；不给读引擎自己带的那一份。读不到、认不出照抛：不当成「没有标准路径」。 */
  standardPaths?(): Promise<StandardPath[]>;
  /** 给单子贴「本机做」标签（幂等）。 */
  markLocal(input: { repo: IntakeRepo; issueNumber: number }): Promise<void>;
  /** 读主线上的需求文档；文件不在回 null，读失败照抛。 */
  readSpecDoc(input: { repo: IntakeRepo; path: string }): Promise<{ content: string } | null>;
  /**
   * 现在没结束的任务工作流分两类：working＝真在干活的（占并发名额），stalled＝停下等人的（任务行状态 stalled，
   * 工作流没结束但不占会话，不占名额，#1776）。读不到照抛：不当成「一条没有」。
   */
  runningTasks(): Promise<number | { working: number; stalled: number }>;
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
   * 记下这一轮每个开着开关、单子读成了的仓里「过了准入、只因没空位没起」的单几张（键是仓的编号）。看门狗的「主线 N 小时没合 PR」
   * 报警读它（jobs/merge-stall.ts）。写不进照抛：这一轮记没查成。不给（测试）就不记。
   */
  recordWaiting?(input: { at: Date; byRepo: Record<string, number> }): Promise<void>;
  /** 本机领单的租约（决定 0096，local-leases.ts）：每个仓准入之前先收到期的。不给（测试）就不收。 */
  localLeases?: LocalLeaseDeps;
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
  /** 这一轮开头读到的在干活的条数（不含停下等人的），起一条加一。 */
  running: number;
  /** 这一轮开头读到的停下等人的条数（不占名额，只用来写日志和说明）。 */
  stalled: number;
  /** 开头读到的在干活条数（running 起一条加一，日志要的是开头的数）。 */
  workingAtStart: number;
  /** 这一轮开头读到的滚动一小时内已起的条数，起一条加一。 */
  hourStarted: number;
  /** 熔断这一轮还允许起几条（正常是 Infinity，起一条减一）和为什么。 */
  breakerAllow: number;
  breakerWhy: string;
  /** 每个仓「过了准入、只因没空位没起」的有几张（仓编号 → 张数）；单子没读成的仓不在里面。 */
  waiting: Map<string, number>;
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
  ctx: { current: number | undefined; book: OrderBook; rules: () => Promise<StandardPath[]> },
  whitelist: GithubWhitelist,
  prClaims: () => Promise<Map<number, number>>,
  t: Tally,
): Promise<Candidate | null> {
  const slug = `${repo.owner}/${repo.name}`;
  const early = screenListed({
    issue,
    trusted: isTrusted(issue.author, whitelist) || isGithubActionsAuthor(issue.author),
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
  // 要改标准（standard-paths.json 列的路径）：引擎的 PR 正文没有创始人原话，合并闸永远判红，不拉（决定 0093）。清单读不到就抛，记没查成
  const standard = standardPathIn(issue.body, await ctx.rules());
  if (standard !== null) {
    await holdForLocal(deps, t, repo, issue, {
      reason: 'touches_standard',
      why: `正文要动改标准的路径 ${standard.path}，引擎的 PR 过不了合并闸`,
      key: 'intake-touches-standard',
      comment: standardPathComment(standard.path, standard.rule),
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

  // 验收条要 diff 外证据（截图、线上、现场、审计……）：引擎做不出、冷验收验不过，不拉，留一次言（决定 0093）
  const offDiff = offDiffItems(brief.brief.acceptance);
  if (offDiff.length > 0) {
    const posted = await deps.comment({
      repo,
      issueNumber: issue.number,
      key: offDiffKey(offDiff),
      body: offDiffComment(offDiff),
    });
    if (posted.created) {
      t.commented += 1;
      deps.log('info', `拉单：${slug}#${issue.number} 的「怎么算做完」要 diff 外证据，已在单子上留言`, {
        words: offDiff.flatMap((h) => h.words),
      });
    }
    skip(t, slug, issue.number, {
      reason: 'acceptance_off_diff',
      why: `「怎么算做完」要 diff 外证据：${offDiff.flatMap((h) => h.words).join('、')}`,
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
  };
}

/**
 * 空位：每轮条数、同时在跑、每小时、熔断，哪一个先用完就按哪一个的原因不起。回 null＝还有位子。
 * 先看便宜的、说得最清楚的：本轮上限 → 在跑上限 → 每小时 → 熔断。
 */
function noRoom(deps: IntakeDeps, t: Tally): IntakeSkip | null {
  const maxStarts = deps.limits?.maxStartsPerRound ?? MAX_STARTS_PER_ROUND;
  const maxRunning = deps.limits?.maxRunningTasks ?? MAX_RUNNING_TASKS;
  const maxHourly = deps.limits?.maxStartsPerHour;
  if (t.started >= maxStarts) {
    return { reason: 'round_cap', why: `这一轮已经起了 ${maxStarts} 条，其余下一轮` };
  }
  if (t.running >= maxRunning) {
    return {
      reason: 'at_capacity',
      why: `在干活 ${t.running} 条、停下等人 ${t.stalled} 条（不占名额），在干活的已到上限 ${maxRunning}，等有空的`,
    };
  }
  const hourly = hourlyRemaining(t.hourStarted, maxHourly);
  if (hourly <= 0) {
    return {
      reason: 'hourly_cap',
      why: `最近一小时已经起了 ${t.hourStarted} 条（每小时最多 ${maxHourly ?? MAX_STARTS_PER_HOUR} 条），等滚出一小时`,
    };
  }
  if (t.breakerAllow <= 0) return { reason: 'breaker_open', why: t.breakerWhy };
  return null;
}

/** 排好序之后，从前往后起：有空位才现读这张单再核一遍，核过了才起。起成了回 true。 */
async function startCandidate(deps: IntakeDeps, repo: IntakeRepo, c: Candidate, t: Tally): Promise<boolean> {
  const slug = `${repo.owner}/${repo.name}`;
  const { issue } = c;
  const full = noRoom(deps, t);
  if (full) {
    skip(t, slug, issue.number, full);
    t.waiting.set(repo.id, (t.waiting.get(repo.id) ?? 0) + 1);
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
  t.hourStarted += 1;
  t.breakerAllow -= 1;
  deps.log('info', `拉单：起了 ${slug}#${issue.number} 的任务工作流`, {
    tier: c.brief.tier.tier,
    why: c.brief.tier.reason,
    serial: c.key.serial,
    current: c.key.current,
    failures: c.key.failures,
  });
  return true;
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
  // 本机领单到期的租约先收（决定 0096）：退回的单下一轮按「stopped 且没有任何一代」接手
  if (deps.localLeases) {
    const swept = await sweepLocalLeases(deps.localLeases, repo, {
      open: new Map(listed.issues.map((i) => [i.number, i.labels] as const)),
      prClaims,
      comment: (c) => deps.comment({ repo, ...c }),
      now: deps.now(),
      log: deps.log,
    });
    t.unchecked.push(...swept.unchecked);
  }
  // 版本里的先后和当前版本：排序用。先后认不出的版本，它的单算「没排进去」，原因只记日志（先后的对错归每天的 GitHub 对账管）
  const withOrder = listed.openMilestones.filter((m) => milestoneNeedsOrder(m, listed.issues));
  const { book, problems } = readOrderBook(
    withOrder.map((m) => ({ ...m, description: m.description ?? '' })),
  );
  if (problems.length > 0) {
    deps.log(
      'info',
      `拉单：${slug} 有版本的先后认不出，这些版本里的单排在没排进去的那档：${problems.join('；')}`,
      {
        problems,
      },
    );
  }
  // 改标准的路径清单：这一轮这个仓里第一张走到这道关的单才读，读一次
  let rules: Promise<StandardPath[]> | undefined;
  const ctx = {
    current: currentVersion(listed.openMilestones)?.milestone.number,
    book,
    rules: () => {
      rules ??= (deps.standardPaths ?? loadStandardPaths)();
      return rules;
    },
  };

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

/** 「怎么算做完」要 diff 外证据、引擎不拉时留在单子上的话。 */
export function offDiffComment(hits: readonly OffDiffItem[]): string {
  return [
    '引擎想拉起这张单，可「怎么算做完」里有条目要 diff 外的证据，引擎做不出来，冷验收也验不过，先没派：',
    '',
    describeOffDiff(hits),
    '',
    OFF_DIFF_REWRITE,
    '',
    `改好后约 ${INTAKE_EVERY_MINUTES} 分钟内引擎会自动再看一遍；同样的条目只留这一条话，改了才会再留。要本机做就贴「${LOCAL_LABEL}」。`,
  ].join('\n');
}

/** 留言的幂等键：由命中的条目算出来，同样的条目同一个键。 */
export function offDiffKey(hits: readonly OffDiffItem[]): string {
  const digest = createHash('sha256').update(describeOffDiff(hits)).digest('hex').slice(0, 12);
  return `intake-off-diff:${digest}`;
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
      delta('acceptance_off_diff') +
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
 * 各仓先准入，再起（仓按名单顺序，仓内按 comparePick）。整理待办按仓、在这个仓的单起完之后判。
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

  for (const p of prepared) {
    t.waiting.set(p.repo.id, t.waiting.get(p.repo.id) ?? 0);
    const startedBefore = t.started;
    for (const c of sortCandidates(p.admitted, (x) => x.key)) await startOne(deps, p.repo, c, t);
    const startedHere = t.started - startedBefore;
    await groomRepo(deps, p.repo, p.admitted, p.skippedBefore, startedHere, t);
  }
}

/** 有单挂在这个里程碑上才需要读它的先后（没单挂着的版本，先后认不出也不值得记）。 */
function milestoneNeedsOrder(m: MilestoneRef, issues: readonly IntakeIssue[]): boolean {
  return issues.some((i) => i.milestone?.number === m.number);
}

function summarize(t: Tally): string {
  const skipped = [...t.skipped].map(([reason, n]) => `${reason}×${n}`).join('、') || '无';
  return `起了 ${t.started} 条，留言 ${t.commented} 条；开头在干活 ${t.workingAtStart} 条、停下等人 ${t.stalled} 条（不占名额）；没派的：${skipped}`;
}

async function round(deps: IntakeDeps): Promise<ScheduleResult> {
  let repos: IntakeRepo[];
  try {
    repos = await deps.repos();
  } catch (err) {
    return { outcome: 'failed', why: `受管的仓读不到：${errMessage(err)}` };
  }
  if (repos.length === 0) return { outcome: 'unscanned', why: '库里没有受管的仓' };
  const t: Tally = {
    scanned: repos.length,
    started: 0,
    commented: 0,
    skipped: new Map(),
    unchecked: [],
    reposFailed: 0,
    reposOn: 0,
    running: 0,
    stalled: 0,
    workingAtStart: 0,
    hourStarted: 0,
    breakerAllow: Number.POSITIVE_INFINITY,
    breakerWhy: '',
    waiting: new Map(),
  };
  if (repos.some((r) => r.autoDispatchSince !== null)) {
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
      const counts = await deps.runningTasks();
      // 回单个数＝全算在干活（老写法）
      t.running = typeof counts === 'number' ? counts : counts.working;
      t.stalled = typeof counts === 'number' ? 0 : counts.stalled;
      t.workingAtStart = t.running;
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
    await intakeRepos(deps, repos, whitelist, t);
    if (deps.recordWaiting) {
      try {
        await deps.recordWaiting({ at: deps.now(), byRepo: Object.fromEntries(t.waiting) });
      } catch (err) {
        t.unchecked.push(`每个仓等空位的单数没记下（看门狗判不了有没有待做的单）：${errMessage(err)}`);
      }
    }
  }
  const found = t.started + t.commented;
  // 每种没派的原因各几张：日志一行，库里的结局（schedule_runs.why）同一句——found=0 时只有它分得开「没单」和「全被拦」
  const tally = summarize(t);
  deps.log('info', `拉单这一轮：${tally}`, { scanned: t.scanned, found });
  if (t.unchecked.length > 0) {
    const n = t.unchecked.length;
    const why = clip(
      `${n > 1 ? `${n} 处没查成：` : ''}${t.unchecked.join('；')}；这一轮${tally}`,
      INTAKE_WHY_MAX,
    );
    // 开着开关的仓全都没读成：这一轮等于没拉
    if (t.reposOn > 0 && t.reposFailed === t.reposOn)
      return { outcome: 'failed', why, scanned: t.scanned, found };
    return { outcome: 'partial', why, scanned: t.scanned, found };
  }
  return { outcome: 'ok', scanned: t.scanned, found, why: clip(tally, INTAKE_WHY_MAX) };
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
