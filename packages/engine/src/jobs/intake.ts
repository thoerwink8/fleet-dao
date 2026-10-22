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
//   有一代在跑或已结束算派过，例外「重新派」：本机退回法国队列后没人接的行（stopped + engine、各代都结束、操作记录里最近一条退回晚于最后一代结束），
//   走完后面全部关卡和空位限制后起下一代 :rN+1；问不清抛错，不当成没派过）→ 历史失败不超过 2 次 →
//   前置没等完（#2783：正文里以「前置：」开头的那一行，认法只有一份，conventions 的 parsePrerequisites，本机 pnpm work queue 同用：
//   写的单号里还有开着的就不拉、原因写「等前置 #N」；写了日期的，北京时间到那天之前不拉、原因写「等到 <日期>」；
//   前置单开没开着读不到，按「等前置」算、记没查成。不留言、不贴「本机做」，前置合了下一轮自然拉。
//   前置单开没开着：先看这一轮读到的开着的单列表，不在里面的（关了的、PR）整个仓一次批量读，不一张单一次请求）→
//   正文没写 .github/workflows/ 路径（#1194：引擎的令牌推不了改工作流的提交，写了的贴一次「本机做」、
//   留一句话。有「已知的模块」一节时只看这一节列出的路径，其余段落里提到的不算；没有这一节的老单仍看场景、已知的模块、怎么算做完）→
//   没写改标准的路径（有「已知的模块」时同样只看这一节；没有这一节的老单仍看「已知的模块」和「怎么算做完」。清单是这个仓
//   档案里 standardPathsFile 指的那份，文件不在＝没有改标准路径；决定 0093：引擎的 PR 正文没有创始人原话，合并闸会永远判红；
//   写了的同样贴一次「本机做」、留一句话）→ 没被开着的 PR 的「需求」栏挂着（#1197：已经有人在做，同样贴一次「本机做」）→
//   交代齐不齐（四节齐，「怎么算做完」至少一条；
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
//   不算派过，这一轮会接手那一行再起（不另建一行）。本机领单不新起一代，所以本机领过又退回（租约到期、放手）的行也不算派过（重新派，
//   jobs/dispatch-standing.ts，#3461）：照样先改行再起，只是编号是下一代。
// - 本机退回来的单（接手或重新派）被后面哪一关挡住（法国接不了）：不能两边都没人做，贴回「本机做」、留言、报给本机（holdReturned）；
//   本机租约到期时退回之前也先照这些关卡试判一遍（franceVerdict），接不了的不摘标签（local-leases.ts）。
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
  parsePrerequisites,
  type StandardPath,
  sectionText,
  waitingUntil,
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
import { type parseRepoProfile, repoProfileGaps, safeParseRepoProfile } from '@fleet-dao/shared';
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
  intakeTierCost,
  MAX_ISSUE_FAILURES,
  MAX_STARTS_PER_HOUR,
  type OrderBook,
  type PickKey,
  pickDeficitRoundRobin,
  readOrderBook,
  serialOf,
  sortCandidates,
} from './intake-pick.ts';
import {
  type FranceVerdict,
  type LeaseNotice,
  type LocalLeaseDeps,
  sweepLocalLeases,
} from './local-leases.ts';
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
/** 结局和日志里最多列几张等前置的单。 */
const BLOCKED_SHOWN = 12;

export interface IntakeRepo {
  id: string;
  owner: string;
  name: string;
  defaultBranch: string;
  testCommand: string;
  /** 仓之间分名额的相对份额；旧档案或测试没给时按 1。 */
  weight?: number;
  /** 「让 AI 接活」打开的时刻（ISO）；null＝关着。现在只当开关用：不再拿它和开单时间比（#1336）。 */
  autoDispatchSince: string | null;
  /**
   * 库里的仓档案原文（只存显式写了的项）。给了就按缺项判就绪：缺一项就不拉，原因写明缺哪几项。
   * 不给是没接档案的旧调用（测试），不在这里挡。真装配总会带上。
   */
  profile?: unknown;
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
  | 'waiting_prerequisite'
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
  | 'already_exists'
  | 'toolchain_unready';

/** 这几种是「没查成」不是「不该派」：记进 unchecked，这一轮不记 ok。 */
const UNREADABLE: ReadonlySet<IntakeSkipReason> = new Set(['created_at_unreadable']);

export interface IntakeSkip {
  reason: IntakeSkipReason;
  why: string;
  /**
   * 前置单开没开着没查成。reason 仍是 waiting_prerequisite（拉单不派，也不当成已经关了），
   * 但和「日期没到 / 确知还开着」不是同一种事实：试判不能凭 reason 当成法国接得了。
   * 只在 judgePrerequisites 回 kind:'unchecked' 时置上，不看错误原文像不像失败。
   */
  prerequisiteUnread?: true;
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
 * 单正文里写到的第一个改标准的路径（清单是这个仓自己的那份）；没写回 null。
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
export function standardPathComment(path: string, rule: StandardPath, listFile?: string): string {
  const where = listFile ?? '这个仓的改标准路径清单';
  return [
    `引擎想拉起这张单，可正文里要动的 \`${path}\` 是改标准的路径（${where} 的 \`${rule.path}\`：${rule.why}）。`,
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
  /** 查法国这台机器是否有仓档案要求的工具；返回缺的工具名，不返回表示齐全。 */
  toolchainReady?(repo: IntakeRepo): Promise<readonly string[]>;
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
  /**
   * 这个仓自己的改标准路径清单。不给就读引擎自己带的那一份（只给没接装配的测试；真装配按档案去读目标仓）。
   * 读不到、认不出照抛：不当成「没有标准路径」。文件不在由装配收成空清单再传进来。
   */
  standardPaths?(repo: IntakeRepo): Promise<StandardPath[]>;
  /**
   * 一批单号（前置单，可能是 issue 也可能是 PR）此刻开没开着：一次批量读（整个仓每轮最多一次，只问不在「开着的单」列表里的）。
   * 读不到照抛；回来的结果里缺了哪个单号，那个单号按读不到算。都不当成「已经关了」。
   */
  prerequisiteStates(repo: IntakeRepo, numbers: readonly number[]): Promise<Map<number, 'open' | 'closed'>>;
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
  /** 熔断此刻的样子（按仓取最近结束的任务、熔断状态、试探那条的结局）。读不到、认不出照抛：不当成「正常」。 */
  breaker(repo: IntakeRepo): Promise<BreakerFacts>;
  /** 熔断状态变了：写库并推一条通知（trip 进入、recover 恢复；retrip 只重新计冷却、不再推）。写不成照抛：这一轮不拉。 */
  breakerChanged(input: { repo: IntakeRepo; event: BreakerEvent; at: Date; why: string }): Promise<void>;
  /** 近 24 小时各仓已经起过的加权工作量（任务行加动手段的档，不是没回填的设置流水）；读不到照抛，不拿 0 顶。不给时测试按空历史处理。 */
  repoWorkload?(since: Date): Promise<Record<string, number>>;
  /** 起任务工作流（编号定死、REJECT_DUPLICATE）：编号已经用过回 already_exists。 */
  start(input: {
    repo: IntakeRepo;
    issueNumber: number;
    title: string;
    /** 单子正文原样（建任务行的「原话」）。 */
    body: string;
    author: IntakeIssue['author'];
    tier?: 'fast' | 'medium' | 'heavyweight';
    /** 起第几代（`:rN`）。不给是第一代；退回法国队列后没人接的单（重新派）给已有代数 + 1。 */
    generation?: number;
  }): Promise<'started' | 'already_exists'>;
  /**
   * 法国接不了、单子留给本机时报给本机（驾驶舱通知）。同一个 key 只报一次（人处理掉了不再重开）。
   * 写不进照抛：这一轮这张单记没查成，下一轮重来。不给（测试）就不报。
   */
  notifyLocal?(input: {
    repo: IntakeRepo;
    issueNumber: number;
    key: string;
    title: string;
    body: string;
  }): Promise<void>;
  /**
   * 撤掉「留给本机」的提醒（notifyLocal 报的那些）：这个仓里开着、贴着「本机做」的单号在 keep 里，其余单号（单关了、或标签摘了）的提醒撤掉。
   * 写不进照抛：这一轮记没查成，下一轮重来。不给（测试）就不撤。
   */
  settleLocalKept?(input: { repo: IntakeRepo; keep: ReadonlySet<number> }): Promise<void>;
  /**
   * 这个仓里还开着的「本机退回的单、引擎接不了」提醒（key 是 intake-returned-blocked:…）对应的单号。读不到照抛：这一轮记没查成。
   * 和 unmarkLocal 一起给才生效：挡着的地方改好了，就自己摘掉「本机做」、撤提醒，不等人来摘。不给（测试）就不看。
   */
  keptReturned?(repo: IntakeRepo): Promise<number[]>;
  /** 摘「本机做」（没贴着不算错）。写不成照抛。 */
  unmarkLocal?(input: { repo: IntakeRepo; issueNumber: number }): Promise<void>;
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
  /**
   * 开着接活的仓因档案没就绪不拉单（#2839）：why 是原因（缺哪几项，或形状不对的那句）时推报警，why 是 null（档案齐了）时撤掉。
   * 写不进照抛，调用方只记日志、这一轮照常。不给（测试）就不报。
   */
  profileAlert?(input: { repo: IntakeRepo; why: string | null }): Promise<void>;
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
  unready: string[];
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
  /** 各仓熔断这一轮还允许起几条（正常是 Infinity，起一条减一）和为什么。 */
  breakerAllow: Map<string, number>;
  breakerWhy: Map<string, string>;
  /** 每个仓「过了准入、只因没空位没起」的有几张（仓编号 → 张数）；单子没读成的仓不在里面。 */
  waiting: Map<string, number>;
  /** 按仓留一份跳过原因，避免公平交错后把别的仓的原因算进整理触发。 */
  skippedByRepo: Map<string, Map<IntakeSkipReason, number>>;
  /** 最近一次跳过的原因和话：试判（法国接不接得了）时读它，不算数。 */
  lastSkip?: IntakeSkip | undefined;
  /** 档案缺项、这一轮不拉的仓（「仓：缺哪几项」）。不是没查成。 */
  notReady: string[];
  /** 这一轮在等前置的单：「仓#单号 等前置 #N」或「仓#单号 等到 <日期>」（写进结局和日志，驾驶舱里看得到是哪张等哪张）。 */
  blocked: string[];
}

function newTally(scanned: number): Tally {
  return {
    scanned,
    started: 0,
    commented: 0,
    skipped: new Map(),
    unready: [],
    unchecked: [],
    reposFailed: 0,
    reposOn: 0,
    running: 0,
    stalled: 0,
    workingAtStart: 0,
    hourStarted: 0,
    breakerAllow: new Map(),
    breakerWhy: new Map(),
    waiting: new Map(),
    skippedByRepo: new Map(),
    notReady: [],
    blocked: [],
  };
}

function skip(t: Tally, slug: string, issue: number, s: IntakeSkip): void {
  t.lastSkip = s;
  t.skipped.set(s.reason, (t.skipped.get(s.reason) ?? 0) + 1);
  const byRepo = t.skippedByRepo.get(slug) ?? new Map<IntakeSkipReason, number>();
  byRepo.set(s.reason, (byRepo.get(s.reason) ?? 0) + 1);
  t.skippedByRepo.set(slug, byRepo);
  if (UNREADABLE.has(s.reason)) t.unchecked.push(`${slug}#${issue}：没查成：${s.why}`);
  if (s.reason === 'waiting_prerequisite') t.blocked.push(`${slug}#${issue} ${s.why}`);
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

/** 本机退回来的单，法国这一关又接不了：留言里的话（拉单这边：放手或租约到期退回之后）。 */
export function returnedBlockedComment(blocked: IntakeSkip): string {
  return [
    `这张单是本机退回法国队列的，可引擎这边接不了：${blocked.why}（拉单这一关：${blocked.reason}）。`,
    '',
    `退回去只会两边都没人做，已把「${LOCAL_LABEL}」贴回，留给本机：要本机接着做，\`pnpm work claim\` 重新领；要引擎做，先把挡着的地方改好，再摘掉「${LOCAL_LABEL}」。`,
  ].join('\n');
}

/** 本机退回来的单被法国某一关挡住：报给本机（通知、留言、贴回「本机做」），记跳过。三步都幂等，哪步没成下一轮整件事重来。 */
async function holdReturned(
  deps: IntakeDeps,
  t: Tally,
  repo: IntakeRepo,
  issue: IntakeIssue,
  returnedAt: Date,
  blocked: IntakeSkip,
): Promise<void> {
  const slug = `${repo.owner}/${repo.name}`;
  const key = `intake-returned-blocked:${returnedAt.toISOString()}`;
  const body = returnedBlockedComment(blocked);
  await deps.notifyLocal?.({
    repo,
    issueNumber: issue.number,
    key,
    title: `${slug}#${issue.number} 本机退回的单，引擎接不了，留给本机做`,
    body,
  });
  const posted = await deps.comment({ repo, issueNumber: issue.number, key, body });
  await deps.markLocal({ repo, issueNumber: issue.number });
  if (posted.created) {
    t.commented += 1;
    deps.log(
      'info',
      `拉单：${slug}#${issue.number} 本机退回的单引擎接不了（${blocked.why}），已贴回「${LOCAL_LABEL}」并留言`,
      {
        reason: blocked.reason,
      },
    );
  }
  skip(t, slug, issue.number, blocked);
}

/**
 * 法国接不接得了这张单（本机租约到期、退回之前先判一次，#3461）：把「本机做」标签拿掉之后，照拉单的准入关卡试判一遍，不留言、不贴标签、不看「派出过没有」
 * （这张单的任务行此刻正是本机在做）。过了，或只是前置确知没等完（日期没到、前置单确知还开着，等完照拉）→ 接得了；别的关卡挡着 → 接不了，带原因。
 * 前置开没开着没查成也是 waiting_prerequisite，但不能当成接得了：那会摘「本机做」。也不是确知接不了。
 * 试判 tally 里只要有没查成（前置读失败，或开单时间认不出），出了这个函数那份 tally 就没了，所以这里照「读不到照抛」交回去。
 * 退回单（releaseReturned）和到期租约（sweepLocalLeases）都接这个抛错，记进外层 unchecked、不摘标签、不报成「法国接不了」。
 * 抛不抛只看有没有没查成的结构化记录，不看错误原文。已知在等（日期没到、前置确知还开着）没有这种记录，仍回可交还。
 */
async function franceVerdict(
  deps: IntakeDeps,
  repo: IntakeRepo,
  issue: IntakeIssue,
  ctx: Parameters<typeof admitIssue>[3],
  whitelist: GithubWhitelist,
  prClaims: () => Promise<Map<number, number>>,
): Promise<FranceVerdict> {
  const quiet: IntakeDeps = {
    ...deps,
    comment: async () => ({ created: false }),
    markLocal: async () => undefined,
    log: () => undefined,
  };
  const trial = newTally(0);
  const labels = issue.labels.filter((l) => l !== LOCAL_LABEL);
  const admitted = await admitIssue(quiet, repo, { ...issue, labels }, ctx, whitelist, prClaims, trial, {
    trial: true,
  });
  const blocked = trial.lastSkip;
  // 已知在等不会进 unchecked。前置缺项/抛错会置 prerequisiteUnread；开单时间认不出只进 unchecked。两种都不是可交还，也不是确知接不了。
  if (trial.unchecked.length > 0 || blocked?.prerequisiteUnread === true) {
    throw new Error(trial.unchecked.join('；') || blocked?.why || '试判有没查成的读取');
  }
  if (admitted) return { ok: true };
  if (!blocked) throw new Error('试判没挡住也没放行，没给出原因');
  if (blocked.reason === 'waiting_prerequisite') return { ok: true };
  return { ok: false, reason: blocked.reason, why: blocked.why };
}

/**
 * 本机退回来、引擎接不了而贴回「本机做」的单（holdReturned），挡着的地方后来改好了：「引擎接不了」这个条件就不成立，
 * 照准入关卡再试判一遍，过了、而且这张单此刻还是没人接的退回行（没被本机重新领走）→ 摘「本机做」，下一轮照常拉；返回摘掉的单号。
 * 还挡着、或已经有人接了的不动。摘标签写不成、试判读不到（含前置没查成，franceVerdict 抛错）记没查成，那张单照旧留着。
 * 派出状态问不清（readDispatchStanding 回 uncertain）同样记没查成、不摘：不能静默跳过，不然这一轮会记成 ok。
 */
async function releaseReturned(
  deps: IntakeDeps,
  repo: IntakeRepo,
  listed: { issues: readonly IntakeIssue[] },
  ctx: Parameters<typeof admitIssue>[3],
  whitelist: GithubWhitelist,
  prClaims: () => Promise<Map<number, number>>,
  t: Tally,
): Promise<Set<number>> {
  const released = new Set<number>();
  if (!deps.keptReturned || !deps.unmarkLocal) return released;
  const slug = `${repo.owner}/${repo.name}`;
  let kept: number[];
  try {
    kept = await deps.keptReturned(repo);
  } catch (err) {
    t.unchecked.push(`${slug}：读不到留给本机的提醒：${errMessage(err)}`);
    return released;
  }
  for (const number of kept) {
    const issue = listed.issues.find((i) => i.number === number);
    if (!issue?.labels.includes(LOCAL_LABEL)) continue;
    try {
      const standing = await readDispatchStanding(deps, repo, number);
      if (standing.kind === 'uncertain') {
        t.unchecked.push(`${slug}#${number}：${standing.why}`);
        continue;
      }
      if (standing.kind !== 'redispatch' && !(standing.kind === 'adopt' && standing.returnedAt)) continue;
      const verdict = await franceVerdict(deps, repo, issue, ctx, whitelist, prClaims);
      if (!verdict.ok) continue;
      await deps.unmarkLocal({ repo, issueNumber: number });
      released.add(number);
      deps.log(
        'info',
        `拉单：${slug}#${number} 挡着的地方改好了，已摘掉「${LOCAL_LABEL}」，下一轮照常拉`,
        {},
      );
    } catch (err) {
      t.unchecked.push(`${slug}#${number}：${errMessage(err)}`);
    }
  }
  return released;
}

/** 过了准入、等排序和空位的一张单。 */
interface Candidate {
  issue: IntakeIssue;
  brief: TaskBrief;
  key: PickKey;
  /** 重新派（退回法国队列后没人接的单）要起的代数；第一代不给。 */
  generation?: number;
}

/** 单子「已知的模块」里列了多少个不同的路径（超过 50 个算最重档，见 tier.ts）。 */
function listedModuleCount(brief: TaskBrief): number {
  return new Set(moduleRefsOf(brief.touches).refs.map((r) => r.path)).size;
}

/** 列表里就能判的几道（screenListed）加上作者在不在白名单。admitIssue 和批量读前置单之前圈单子都用它，口径一样。 */
function listedSkip(repo: IntakeRepo, issue: IntakeIssue, whitelist: GithubWhitelist): IntakeSkip | null {
  return screenListed({
    issue,
    trusted: isTrusted(issue.author, whitelist) || isGithubActionsAuthor(issue.author),
    autoDispatchSince: repo.autoDispatchSince,
  });
}

/**
 * 这张单的前置号进不进这一轮的批量读。列表里就能拉的单要读。只因「本机做」被挡下的也要读：
 * 退回单和到期租约的试判会先拿掉这张标签再判前置，批量结果里没有那个号就会变成缺项，分不清「确知还开着 / 已经关了」和「没查成」。
 * 作者不在白名单里时 listedSkip 先返回 untrusted_author，仍然不读，陌生人写一串号不会变成一次大查询。
 */
function prereqBatchEligible(repo: IntakeRepo, issue: IntakeIssue, whitelist: GithubWhitelist): boolean {
  const skip = listedSkip(repo, issue, whitelist);
  return skip === null || skip.reason === 'reserved_local';
}

const issueRefs = (numbers: readonly number[]) => numbers.map((n) => `#${n}`).join('、');

/** 前置判下来的样子：没有或都等完了（clear）、在等（waiting）、开没开着没查成（unchecked，不当成都关了）。 */
export type PrerequisiteVerdict =
  | { kind: 'clear' }
  | { kind: 'waiting'; why: string }
  | { kind: 'unchecked'; numbers: number[]; why: string };

/**
 * 前置（#2783）：正文里以「前置：」开头的那一行（conventions 的 parsePrerequisites，和 pnpm work queue 同一份认法）。
 * 日期没到：「等到 <日期>」，不用读任何东西。写了单号：还开着的就「等前置 #N」；开没开着读不到（整批读失败，或回来的结果缺了这个号），
 * 回 unchecked，不当成都关了。拉单（prerequisiteSkip）和点名派单（dispatch-issue.ts）共用这一份判法，读法各自给。
 * 正文不是文字（读不到）就抛：不当成「没写前置」（和 workflowPathIn 同一个口径）。
 */
export async function judgePrerequisites(
  body: unknown,
  now: Date,
  states: (numbers: readonly number[]) => Promise<Map<number, 'open' | 'closed'>>,
): Promise<PrerequisiteVerdict> {
  if (typeof body !== 'string')
    throw new Error(`单正文读不到（拿到的是 ${body === null ? 'null' : typeof body}）`);
  const pre = parsePrerequisites(body);
  const until = waitingUntil(pre, now);
  if (until !== null) return { kind: 'waiting', why: `等到 ${until}` };
  if (pre.issues.length === 0) return { kind: 'clear' };
  const open: number[] = [];
  try {
    const got = await states(pre.issues);
    for (const n of pre.issues) {
      const s = got.get(n);
      if (s === undefined) throw new Error(`前置单 #${n} 没读到状态`);
      if (s === 'open') open.push(n);
    }
  } catch (err) {
    return {
      kind: 'unchecked',
      numbers: pre.issues,
      why: `前置单 ${issueRefs(pre.issues)} 开没开着没查成，按等前置算（${errMessage(err)}）`,
    };
  }
  return open.length > 0 ? { kind: 'waiting', why: `等前置 ${issueRefs(open)}` } : { kind: 'clear' };
}

/** 拉单这一道：在等的不拉；没查成的按「等前置」算、记进这一轮的没查成。回 null＝没有前置、或前置都等完了。 */
async function prerequisiteSkip(
  deps: IntakeDeps,
  repo: IntakeRepo,
  issue: IntakeIssue,
  states: (numbers: readonly number[]) => Promise<Map<number, 'open' | 'closed'>>,
  t: Tally,
): Promise<IntakeSkip | null> {
  const verdict = await judgePrerequisites(issue.body, deps.now(), states);
  if (verdict.kind === 'clear') return null;
  if (verdict.kind === 'waiting') return { reason: 'waiting_prerequisite', why: verdict.why };
  t.unchecked.push(`${repo.owner}/${repo.name}#${issue.number}：${verdict.why}`);
  return {
    reason: 'waiting_prerequisite',
    why: `等前置 ${issueRefs(verdict.numbers)}（前置单状态没查成，按没关算）`,
    prerequisiteUnread: true,
  };
}

/**
 * 准入：一张开着的单过完不用现读 GitHub 的所有关，回候选；不拉的记原因（该留言、该贴「本机做」的当场做）回 null。
 * 排序要用的东西（版本里的序号、是不是当前版本、规模、失败次数、开单时刻）都在这里一起算好。
 */
async function admitIssue(
  deps: IntakeDeps,
  repo: IntakeRepo,
  issue: IntakeIssue,
  ctx: {
    current: number | undefined;
    book: OrderBook;
    rules: () => Promise<StandardPath[]>;
    moduleRoots?: readonly string[] | undefined;
    listFile?: string | undefined;
    prereqStates: (numbers: readonly number[]) => Promise<Map<number, 'open' | 'closed'>>;
  },
  whitelist: GithubWhitelist,
  prClaims: () => Promise<Map<number, number>>,
  t: Tally,
  /** trial：试判法国接不接得了（本机租约到期退回之前用，见 franceVerdict）：不看「派出过没有」，也不留言、不贴标签。 */
  opts: { trial?: boolean } = {},
): Promise<Candidate | null> {
  const slug = `${repo.owner}/${repo.name}`;
  const early = listedSkip(repo, issue, whitelist);
  if (early) {
    skip(t, slug, issue.number, early);
    return null;
  }
  // 重新派的单要起下一代；本机退回的行（接手或重新派）后面哪一关把它挡了，要把单留给本机，不能让它两边都没人做
  let generation: number | undefined;
  let returnedAt: Date | null = null;
  if (!opts.trial) {
    const standing = await readDispatchStanding(deps, repo, issue.number);
    if (standing.kind === 'uncertain') throw new Error(standing.why);
    if (standing.kind === 'dispatched') {
      skip(t, slug, issue.number, { reason: 'already_dispatched', why: '已经派出过' });
      return null;
    }
    if (standing.kind === 'redispatch') generation = standing.generation;
    if (standing.kind === 'redispatch' || standing.kind === 'adopt') returnedAt = standing.returnedAt ?? null;
  }
  /** 法国接不了的一关：本机退回来的行留给本机并报给本机，其余只记跳过。 */
  const cannotTake = async (s: IntakeSkip): Promise<null> => {
    if (returnedAt !== null) await holdReturned(deps, t, repo, issue, returnedAt, s);
    else skip(t, slug, issue.number, s);
    return null;
  };
  const failures = await deps.failures(repo, issue.number);
  if (failures > MAX_ISSUE_FAILURES) {
    return cannotTake({
      reason: 'too_many_failures',
      why: `这张单的任务已经失败过 ${failures} 次（上限 ${MAX_ISSUE_FAILURES}）：人看过原因后在驾驶舱点「重做」`,
    });
  }
  // 前置没等完：不拉，不留言、不贴「本机做」（前置合了下一轮自然拉）。排在改工作流、改标准、PR 挂单这些会贴「本机做」的关前面：
  // 前置没合的单不该先被永久留给本机（#2783）
  const waiting = await prerequisiteSkip(deps, repo, issue, ctx.prereqStates, t);
  if (waiting) {
    skip(t, slug, issue.number, waiting);
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
      comment: standardPathComment(standard.path, standard.rule, ctx.listFile),
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
    {
      repo: { owner: repo.owner, name: repo.name },
      issueNumber: issue.number,
      ...(ctx.moduleRoots ? { moduleRoots: ctx.moduleRoots } : {}),
    },
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
    return cannotTake({
      reason: 'brief_incomplete',
      why: brief.problems.map((p) => p.field).join('、'),
    });
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
    return cannotTake({
      reason: 'acceptance_off_diff',
      why: `「怎么算做完」要 diff 外证据：${offDiff.flatMap((h) => h.words).join('、')}`,
    });
  }

  // 规模：单子列的路径超过 50 个算最重档（tier.ts），改动面太大，引擎不拉
  const moduleCount = listedModuleCount(brief.brief);
  if (moduleCount > TIER_HEAVYWEIGHT_FILE_THRESHOLD) {
    return cannotTake({
      reason: 'too_large',
      why: `单子「已知的模块」列了 ${moduleCount} 处（超过 ${TIER_HEAVYWEIGHT_FILE_THRESHOLD}），规模是最重档：先拆小再交给引擎`,
    });
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
    ...(generation === undefined ? {} : { generation }),
  };
}

/**
 * 空位：每轮条数、同时在跑、每小时、熔断，哪一个先用完就按哪一个的原因不起。回 null＝还有位子。
 * 先看便宜的、说得最清楚的：本轮上限 → 在跑上限 → 每小时 → 熔断。
 */
function noRoom(deps: IntakeDeps, repo: IntakeRepo, t: Tally): IntakeSkip | null {
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
  if ((t.breakerAllow.get(repo.id) ?? 0) <= 0) {
    return {
      reason: 'breaker_open',
      why: t.breakerWhy.get(repo.id) ?? '这个仓的熔断状态认不出，保守停拉',
    };
  }
  return null;
}

/** 排好序之后，从前往后起：有空位才现读这张单再核一遍，核过了才起。起成了回 true。 */
async function startCandidate(deps: IntakeDeps, repo: IntakeRepo, c: Candidate, t: Tally): Promise<boolean> {
  const slug = `${repo.owner}/${repo.name}`;
  const { issue } = c;
  const full = noRoom(deps, repo, t);
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
    tier: c.brief.tier.tier,
    ...(c.generation === undefined ? {} : { generation: c.generation }),
  });
  if (got === 'already_exists') {
    skip(t, slug, issue.number, { reason: 'already_exists', why: '任务工作流的编号已经用过' });
    return false;
  }
  t.started += 1;
  t.running += 1;
  t.hourStarted += 1;
  t.breakerAllow.set(repo.id, (t.breakerAllow.get(repo.id) ?? 0) - 1);
  deps.log('info', `拉单：起了 ${slug}#${issue.number} 的任务工作流`, {
    tier: c.brief.tier.tier,
    why: c.brief.tier.reason,
    serial: c.key.serial,
    current: c.key.current,
    failures: c.key.failures,
  });
  return true;
}

/** 仓档案没就绪的提醒（#2839）：写不成只记日志，这一轮照常（提醒不当成没跑成）。 */
async function reportProfile(deps: IntakeDeps, repo: IntakeRepo, why: string | null): Promise<void> {
  if (!deps.profileAlert) return;
  try {
    await deps.profileAlert({ repo, why });
  } catch (err) {
    deps.log('warn', `拉单：${repo.owner}/${repo.name} 仓档案的提醒没写成（这一轮照常）`, {
      error: errMessage(err),
    });
  }
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
  let profile: ReturnType<typeof parseRepoProfile> | undefined;
  if (repo.profile !== undefined) {
    const gaps = repoProfileGaps(repo.profile);
    if (gaps.length > 0) {
      t.notReady.push(`${slug}：缺 ${gaps.join('、')}`);
      deps.log('info', `拉单：${slug} 仓档案没就绪，不拉单`, { missing: gaps });
      await reportProfile(deps, repo, `缺 ${gaps.join('、')}`);
      return null;
    }
    const parsed = safeParseRepoProfile(repo.profile);
    if (!parsed.ok) {
      t.notReady.push(`${slug}：${parsed.error}`);
      deps.log('info', `拉单：${slug} 仓档案没就绪，不拉单`, { error: parsed.error });
      await reportProfile(deps, repo, parsed.error);
      return null;
    }
    profile = parsed.profile;
    await reportProfile(deps, repo, null);
  }
  if (deps.toolchainReady) {
    let missing: readonly string[];
    try {
      missing = await deps.toolchainReady(repo);
    } catch (err) {
      t.reposFailed += 1;
      t.unchecked.push(`${slug}：仓档案工具链没查成：${errMessage(err)}`);
      return null;
    }
    if (missing.length > 0) {
      t.skipped.set('toolchain_unready', (t.skipped.get('toolchain_unready') ?? 0) + 1);
      t.unready.push(`${slug}：没就绪，缺工具链：${missing.join('、')}`);
      deps.log('info', `拉单：${slug} 没就绪，不拉单（缺工具链：${missing.join('、')}）`, {
        missingToolchain: missing,
      });
      return null;
    }
  }
  const skippedBefore = new Map(t.skippedByRepo.get(slug) ?? []);
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
  // 前置单开没开着（#2783）：在这一轮读到的开着的单列表里的，就是开着的，不用问；其余的（关了的、PR、不存在的）整个仓一次批量读，
  // 第一张走到这道关、写了这种前置的单才读，读一次（读失败的话，后面的单拿到的是同一个错，各自按「等前置」算、记没查成）。
  // 要问的单号圈列表里就能判过的单，再加上只因「本机做」被挡下的单（试判会拿掉这张标签再看前置，见 prereqBatchEligible）。
  // 日期还没到的不算。作者不在白名单里的不算：陌生人在正文里写一串号不会变成一次大查询。
  const openNow = new Set(listed.issues.map((i) => i.number));
  const toAsk = [
    ...new Set(
      listed.issues
        .filter((i) => typeof i.body === 'string' && prereqBatchEligible(repo, i, whitelist))
        .flatMap((i) => {
          const pre = parsePrerequisites(i.body);
          return waitingUntil(pre, deps.now()) === null ? pre.issues : [];
        })
        .filter((n) => !openNow.has(n)),
    ),
  ].sort((a, b) => a - b);
  let asked: Promise<Map<number, 'open' | 'closed'>> | undefined;
  const ctx = {
    current: currentVersion(listed.openMilestones)?.milestone.number,
    book,
    rules: () => {
      rules ??= deps.standardPaths ? deps.standardPaths(repo) : loadStandardPaths();
      return rules;
    },
    ...(profile ? { moduleRoots: profile.moduleRoots, listFile: profile.standardPathsFile } : {}),
    prereqStates: async (numbers: readonly number[]) => {
      const out = new Map<number, 'open' | 'closed'>();
      for (const n of numbers) if (openNow.has(n)) out.set(n, 'open');
      if (numbers.some((n) => !openNow.has(n))) {
        asked ??= deps.prerequisiteStates(repo, toAsk);
        const got = await asked;
        for (const n of numbers) {
          const s = got.get(n);
          if (!openNow.has(n) && s !== undefined) out.set(n, s);
        }
      }
      return out;
    },
  };

  // 本机领单到期的租约先收（决定 0096）：退回的单下一轮按「重新派」或「接手」接回。退回之前先按上面这些准入关卡判一次法国接不接得了（#3461），
  // 接不了的不摘「本机做」、不退回，报给本机。要用 ctx，所以放在它后面、准入循环前面。
  if (deps.localLeases) {
    const notify = deps.notifyLocal;
    const swept = await sweepLocalLeases(deps.localLeases, repo, {
      open: new Map(listed.issues.map((i) => [i.number, i.labels] as const)),
      prClaims,
      comment: (c) => deps.comment({ repo, ...c }),
      franceVerdict: async (issueNumber) => {
        const found = listed.issues.find((i) => i.number === issueNumber);
        if (!found) throw new Error(`开着的单列表里找不到 #${issueNumber}，判不了法国接不接得了`);
        return franceVerdict(deps, repo, found, ctx, whitelist, prClaims);
      },
      ...(notify ? { notify: (n: LeaseNotice) => notify({ repo, ...n }) } : {}),
      now: deps.now(),
      log: deps.log,
    });
    t.unchecked.push(...swept.unchecked);
  }

  // 挡着的地方改好了的退回单：先摘「本机做」，下面的提醒跟着撤
  const released = await releaseReturned(deps, repo, listed, ctx, whitelist, prClaims, t);
  // 这一轮贴上（或试着贴上）「本机做」的单：贴的那步写不成、或报给本机之后留言写不成，也算留着，别让下面撤提醒把刚报给本机的话撤了
  const labelled = new Set(
    listed.issues
      .filter((i) => i.labels.includes(LOCAL_LABEL) && !released.has(i.number))
      .map((i) => i.number),
  );
  const notifyKept = deps.notifyLocal;
  const tracked: IntakeDeps = {
    ...deps,
    markLocal: (input) => {
      labelled.add(input.issueNumber);
      return deps.markLocal(input);
    },
    ...(notifyKept
      ? {
          notifyLocal: (input) => {
            labelled.add(input.issueNumber);
            return notifyKept(input);
          },
        }
      : {}),
  };
  const admitted: Candidate[] = [];
  for (const issue of listed.issues) {
    t.scanned += 1;
    try {
      const c = await admitIssue(tracked, repo, issue, ctx, whitelist, prClaims, t);
      if (c) admitted.push(c);
    } catch (err) {
      // 这张单没处理成（读历史、留言、贴标签出错）：记下，别的单照做
      t.unchecked.push(`${slug}#${issue.number}：${errMessage(err)}`);
    }
  }
  // 「留给本机」的提醒跟着单子走：单关了、或「本机做」摘掉了（要引擎做的那一步），这条提醒的条件就不成立了，撤掉
  if (deps.settleLocalKept) {
    try {
      await deps.settleLocalKept({ repo, keep: labelled });
    } catch (err) {
      t.unchecked.push(`${slug}：留给本机的提醒没撤成：${errMessage(err)}`);
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

/** 每个仓分别读熔断；一个仓坏了或熔断，不影响别的仓继续吃自己的名额。 */
async function prepareBreaker(deps: IntakeDeps, repo: IntakeRepo, t: Tally): Promise<void> {
  const slug = `${repo.owner}/${repo.name}`;
  try {
    const at = deps.now();
    const verdict = decideBreaker(await deps.breaker(repo), at);
    if (verdict.event !== null) {
      await deps.breakerChanged({ repo, event: verdict.event, at, why: verdict.why });
      deps.log(
        verdict.event === 'recover' ? 'info' : 'warn',
        `拉单熔断：${slug} ${verdict.event}，${verdict.why}`,
      );
    }
    t.breakerAllow.set(repo.id, verdict.allow);
    t.breakerWhy.set(repo.id, verdict.why);
  } catch (err) {
    t.reposFailed += 1;
    t.breakerAllow.set(repo.id, 0);
    t.breakerWhy.set(repo.id, `这个仓的熔断状态读不到或写不进去：${errMessage(err)}`);
    t.unchecked.push(`${slug}：仓级熔断没查成（${errMessage(err)}）`);
  }
}

/** 「怎么算做完」要 diff 外证据、引擎不拉时留在单子上的话。 */
export function offDiffComment(hits: readonly OffDiffItem[]): string {
  return [
    '引擎想拉起这张单，可「怎么算做完」里有条目要 diff 外的证据，引擎做不出来，冷验收也验不过，先没派（命中的是哪一条、为什么见下方）：',
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
  const current = t.skippedByRepo.get(slug) ?? new Map<IntakeSkipReason, number>();
  const delta = (reason: IntakeSkipReason) => (current.get(reason) ?? 0) - (skippedBefore.get(reason) ?? 0);
  const why = autoGroomWhy({
    spare: noRoom(deps, repo, t) === null,
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

/** 各仓先准入，再按 deficit round robin 交错起；整理待办仍按仓判。 */
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

  for (const p of prepared) await prepareBreaker(deps, p.repo, t);

  const workload = deps.repoWorkload
    ? await deps.repoWorkload(new Date(deps.now().getTime() - 24 * HOUR_MS))
    : {};
  const totalCandidates = prepared.reduce((n, p) => n + p.admitted.length, 0);
  const order = pickDeficitRoundRobin(
    prepared.map((p) => ({
      repoId: p.repo.id,
      weight: p.repo.weight ?? 1,
      used: workload[p.repo.id] ?? 0,
      candidates: sortCandidates(p.admitted, (x) => x.key),
    })),
    totalCandidates,
    (c) => intakeTierCost(c.brief.tier.tier),
  );
  const startedByRepo = new Map<string, number>();
  const repoById = new Map(prepared.map((p) => [p.repo.id, p.repo] as const));
  for (const picked of order) {
    const repo = repoById.get(picked.repoId);
    if (!repo) continue;
    const started = await startOne(deps, repo, picked.item, t);
    if (started) startedByRepo.set(repo.id, (startedByRepo.get(repo.id) ?? 0) + 1);
  }

  for (const p of prepared) {
    t.waiting.set(p.repo.id, t.waiting.get(p.repo.id) ?? 0);
    const startedHere = startedByRepo.get(p.repo.id) ?? 0;
    await groomRepo(deps, p.repo, p.admitted, p.skippedBefore, startedHere, t);
  }
}

/** 有单挂在这个里程碑上才需要读它的先后（没单挂着的版本，先后认不出也不值得记）。 */
function milestoneNeedsOrder(m: MilestoneRef, issues: readonly IntakeIssue[]): boolean {
  return issues.some((i) => i.milestone?.number === m.number);
}

function summarize(t: Tally): string {
  const skipped = [...t.skipped].map(([reason, n]) => `${reason}×${n}`).join('、') || '无';
  const unready = t.unready.length > 0 ? `；没就绪：${t.unready.join('；')}` : '';
  const ready = t.notReady.length > 0 ? `；没就绪：${t.notReady.join('、')}` : '';
  // 等前置的单：写明是哪张等哪张（结局和日志里看得到，不用翻每张单）；太多了截断，总数在上面 waiting_prerequisite×N
  const shown = t.blocked.slice(0, BLOCKED_SHOWN);
  const blocked =
    shown.length === 0
      ? ''
      : `；等前置的单：${shown.join('、')}${t.blocked.length > shown.length ? `……（共 ${t.blocked.length} 张）` : ''}`;
  return `起了 ${t.started} 条，留言 ${t.commented} 条；开头在干活 ${t.workingAtStart} 条、停下等人 ${t.stalled} 条（不占名额）；没派的：${skipped}${unready}${ready}${blocked}`;
}

async function round(deps: IntakeDeps): Promise<ScheduleResult> {
  let repos: IntakeRepo[];
  try {
    repos = await deps.repos();
  } catch (err) {
    return { outcome: 'failed', why: `受管的仓读不到：${errMessage(err)}` };
  }
  if (repos.length === 0) return { outcome: 'unscanned', why: '库里没有受管的仓' };
  const t = newTally(repos.length);
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
    // 限速：读不到就不拉（不当成「一条没起」）。
    try {
      const at = deps.now();
      t.hourStarted = await deps.startedSince(new Date(at.getTime() - HOUR_MS));
    } catch (err) {
      return {
        outcome: 'failed',
        why: `最近一小时已起的条数读不到，这一轮一张单都没拉：${errMessage(err)}`,
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
