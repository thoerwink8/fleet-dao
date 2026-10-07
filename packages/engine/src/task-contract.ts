// 任务工作流（#632 S2-4；specs/632-三段总调度/方案.md §五）对外的约定：输入输出、信号、查询、新增活动的入参和结果。
// 驾驶舱后端（发「继续」「放弃」、读状态）和引擎共用这一份；工作流和活动都从这里拿类型。
// 这里是工作流代码也会引入的文件：运行时只引 @temporalio/workflow 的 defineSignal / defineQuery，别的一律只写类型。
// 输入进了工作流历史：以后只许加可选字段，不许改老字段的意思。

import type { Repo, StageKind } from '@fleet-dao/shared';
import {
  type AbandonCommand,
  type ContinueCommand,
  type PauseCommand,
  type RouteWakeCommand,
  TASK_SIGNAL_NAMES,
} from '@fleet-dao/shared/task-signals';
import { defineQuery, defineSignal } from '@temporalio/workflow';
import type { FailureEvidence } from './failure/types.ts';
import type { RouteChoice } from './ports.ts';
import type { TaskBrief } from './runner/task-brief.ts';
import type { TierDecision } from './runner/tier.ts';

/** 动手最多几轮（CI 红了、没交付、验收没过都回动手重来一轮）。人点「继续」再给一整轮。 */
export const MAX_IMPLEMENT_ROUNDS = 3;
/** 验收最多几轮（默认 1 轮，最多 2 轮，specs/555）。 */
export const MAX_VERIFY_ROUNDS = 2;
/** 一轮动手的会话最长多少分钟（one-shot 默认也是 60）。 */
export const SEGMENT_MINUTES = 60;
/** 等合并时每次长轮询多少分钟（工作流一直轮到合并、关闭或人放弃）。 */
export const MERGE_POLL_MINUTES = 15;
/** 没有可用路由、或额度没读成时隔多久再选一次（秒）。 */
export const ROUTE_RETRY_SECONDS = 60;

/**
 * 三段里经选路的那几段各按哪个用途选（路由两层的用途）：动手按写码（工作流的 pick）；验收按审查（cold-verify-pick.ts 写了为什么
 * 不是 verify）。选路的战绩按它把 runs 里这一段的结局算到这个用途上（real/store-ports.ts）：两边读这一份，改一处两边一起变。
 * 对题还不经选路，不在这里。
 */
export const SEGMENT_STAGE = { manual: 'execute', verify: 'review' } as const satisfies Partial<
  Record<'scope' | 'manual' | 'verify', StageKind>
>;

export { taskBranch } from './task-branch.ts';

export interface TaskWorkflowInput {
  schemaVersion: 1;
  /** 库里的 tasks.id。 */
  taskId: string;
  repo: Repo;
  issueNumber: number;
  title: string;
}

export type TaskPhase =
  | 'brief'
  | 'implement'
  | 'ci'
  | 'verify'
  | 'merge'
  | 'parked'
  | 'paused'
  | 'done'
  | 'abandoned';

/** 在等什么（驾驶舱「在跑的」每张单显示卡在哪一环、在等谁）。 */
export interface TaskWait {
  kind: 'human' | 'slot' | 'quota' | 'ci' | 'merge' | 'retry' | 'paused';
  detail: string;
  /** ISO 时刻。 */
  since: string;
}

export interface TaskStatus {
  phase: TaskPhase;
  /** 白话：正在做什么。 */
  doing: string;
  /** 动手第几轮、验收第几轮（0＝还没到）。 */
  round: number;
  verifyRound: number;
  prNumber: number | null;
  waiting: TaskWait | null;
  /** 最近一次卡住的原因；顺利推进时是 null。 */
  lastProblem: string | null;
  tier: TierDecision | null;
}

export interface TaskRun {
  outcome: 'merged' | 'abandoned';
  prNumber: number | null;
  head: string | null;
  rounds: number;
  verifyRounds: number;
}

// 信号的名字和参数形状在 shared/task-signals.ts：驾驶舱后端发信号也从那里拿，两边不各拼一遍（#901）。
// 路由叫醒（RouteWakeCommand）只有引擎进程自己发（real/route-wake.ts），信号丢了也不会等超过 MAX_ROUTE_WAIT_SECONDS。
export type { AbandonCommand, ContinueCommand, PauseCommand, RouteWakeCommand };

export const taskContinueSignal = defineSignal<[ContinueCommand]>(TASK_SIGNAL_NAMES.continue);
export const taskAbandonSignal = defineSignal<[AbandonCommand]>(TASK_SIGNAL_NAMES.abandon);
export const taskRouteWakeSignal = defineSignal<[RouteWakeCommand]>(TASK_SIGNAL_NAMES.routeWake);
export const taskPauseSignal = defineSignal<[PauseCommand]>(TASK_SIGNAL_NAMES.pause);
export const taskStatusQuery = defineQuery<TaskStatus>('taskStatus');

// ---- 新增的活动（EngineActivities 里的「任务」一组）

export interface ReadTaskBriefInput {
  schemaVersion: 1;
  repo: Pick<Repo, 'owner' | 'name'>;
  issueNumber: number;
}

/** 起一段动手会话。runId 由活动自己起（每次尝试一个，进 runs 表的主键），工作流里不生成编号。 */
export interface RunSegmentInput {
  schemaVersion: 1;
  /** 库里的 tasks.id（runs 里这一段挂在这张单上，#216）。 */
  taskId: string;
  repo: Repo;
  issueNumber: number;
  route: RouteChoice;
  /** 这张单的工作树（会话用户的）。 */
  worktreePath: string;
  branch: string;
  /** 工作树从哪个提交起的：判「有没有真提交」用。 */
  baseSha: string;
  brief: TaskBrief;
  tier: TierDecision;
  /** 前几轮留下的返工意见（CI 失败日志、验收问题表、没产生提交），新一轮的会话要照着改。 */
  feedback: string[];
  timeoutMinutes: number;
  /**
   * 这一段上一次跑到一半被停下了（切号，#59）：为什么停的那一句。重跑时写进提示词——树里可能留着上一次的提交和没提交的改动，
   * 新会话接着干、别从头来。没被停过的不给。
   */
  interrupted?: string;
  /**
   * 这张单的 PR：第一轮动手时还没开（引擎在会话交付之后才开），不给；开了以后每一轮都给。只记账（runs.pr_number，#216），
   * 会话不看它。老历史里没有这个字段。
   */
  prNumber?: number;
}

/**
 * 动手会话被切号停下时的结局和原因码（#59）：失败分流 OS1 认它（不算失败、不记账、马上接着干），工作流切完在原分支上重跑这一段，
 * 提示词里带上 interrupted。和 runner/one-shot.ts 的结局 org_switch 是同一个词。
 */
export const ORG_SWITCH_CODE = 'org_switch';

/**
 * 单任务被人暂停（#820 片 3）：hard 暂停停下的动手会话，原因写这一句，重跑时和切号一样进提示词的 interrupted（树里留着上一次的东西，接着干）。
 * 借 org_switch 的位置：工作流这一侧当切号停下对待（不算失败、不记账、不换模型）；runs 表的结局不新增 paused（要改 CHECK 约束，方案 §要定的 4）。
 */
export const PAUSED_BY_HUMAN = '被人暂停';

/** 动手会话没跑成时给失败分流的证据（字段照 FailureEvidence，工作流补上 routeId 这些再交给分流）。 */
export type SegmentEvidence = Pick<
  FailureEvidence,
  'code' | 'message' | 'exitCode' | 'httpStatus' | 'resetsAt'
> & { quotaExhausted: boolean };

export type RunSegmentResult =
  | { ok: true; runId: string; answer: string; costUsd?: number; actualModel?: string }
  | { ok: false; runId: string | null; outcome: string; evidence: SegmentEvidence };

export interface ReadDeliveryInput {
  schemaVersion: 1;
  taskId: string;
  repo: Repo;
  worktreePath: string;
  baseSha: string;
}

/** 会话交付的东西：工作树现在的头、比起点多了几个提交、改了哪些文件。读不到抛错，不回空。 */
export interface DeliveryRead {
  head: string;
  commits: number;
  changedFiles: string[];
  /**
   * 工作树里还有没提交的改动（含没加进 git 的新文件，不含 .gitignore 忽略的）。有就不算交付完：只有提交了的才会进 PR。
   * 真实现一定给；老历史里没有这个字段（当作没有）。
   */
  leftover?: string[];
}

export interface ColdVerifyInput {
  schemaVersion: 1;
  taskId: string;
  repo: Repo;
  issueNumber: number;
  prNumber: number;
  branch: string;
  baseSha: string;
  headSha: string;
  /** 「要什么」原文、「怎么算做完」逐条。 */
  what: string;
  howToFinish: string[];
  /** 写这张单的会话用过的路由的族（验收换一个不同的族）。 */
  authorFamilies: string[];
  round: 1 | 2;
}

export interface ColdVerifyResult {
  /** 验收有结论且通过。 */
  pass: boolean;
  /** 只有三种能挡：没做到验收条、弄坏了原有功能、安全或丢数据。 */
  problems: string[];
  notes?: string;
  round: 1 | 2;
  /**
   * 验收没能做出来（读不到 diff、没有别家的模型能用、冷调用没跑成）：不是「没过」，返工解决不了——有这个字段，
   * 工作流停下报人（等条件好了点「继续」重验），不回去让写代码的会话白改一轮。
   */
  unavailable?: string;
  /**
   * 这会儿验不了、但过一会儿再来就行（没空位、内存放不下、额度要等、引擎在停机发布）：不是没过，也不是做不出来。
   * 工作流隔 afterSeconds 秒再验一次，不算一轮、不停下报人。老历史里没有这个字段，当作没有。
   */
  retry?: { wait: 'slot' | 'quota'; reason: string; afterSeconds: number };
  /** 要验的头已经不是 PR 现在的头了（有人推过新提交）：现在的头。工作流停下等人看过，再对新的头重走一遍。老历史里没有这个字段。 */
  headMoved?: string;
}

/** 改到了哪些要人拍的路径。空＝除了 CI 和冷验收没有别的门。 */
export interface GuardedPaths {
  /** 改标准的路径（人闸第四类：要创始人同意才挂自动合并）。 */
  standards: string[];
}

export interface CheckGuardedInput {
  schemaVersion: 1;
  taskId: string;
  repo: Repo;
  prNumber: number;
  /**
   * 人已经看过、点过「继续」的路径（上一次 checkGuarded 回的原样条目）。活动在回的结果里把它们去掉，
   * 否则人批了之后再查一遍还是同样的结果，永远过不去。工作流只在批准那一刻的头还是现在的头时才传；
   * 头换了就不传（新的内容要重新批）。老历史里没有这个字段，当作没批过。
   */
  approved?: GuardedPaths;
}

export interface ArmAutoMergeInput {
  schemaVersion: 1;
  repo: Repo;
  prNumber: number;
  expectedHead: string;
}

export interface ArmAutoMergeResult {
  /** 自动合并挂上了（或本来就挂着）。 */
  armed: boolean;
  /** 挂的时候发现已经合了（或本来就满足合并条件、当场合了）。 */
  merged: boolean;
  /** merged 时的合并提交。 */
  mergeCommit?: string;
  why?: string;
  /** 挂的时候发现 PR 的头已经不是引擎验过、推上去的那个了（有人改过）：现在的头。老历史里没有这个字段。 */
  headMoved?: string;
}

export interface WaitMergedInput {
  schemaVersion: 1;
  repo: Repo;
  prNumber: number;
  expectedHead: string;
  minutes: number;
}

export type MergeWait =
  | { state: 'merged'; mergeCommit?: string }
  | { state: 'closed' }
  | { state: 'head_moved'; head: string }
  /** 自动合并被撤掉了（人撤的，或 GitHub 因为头变了撤的）：回去重新挂。 */
  | { state: 'unarmed' }
  | { state: 'waiting'; detail: string };
