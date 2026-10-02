// 任务工作流（#632 S2-4；specs/632-三段总调度/方案.md §五）对外的约定：输入输出、信号、查询、新增活动的入参和结果。
// 驾驶舱后端（发「继续」「放弃」、读状态）和引擎共用这一份；工作流和活动都从这里拿类型。
// 这里是工作流代码也会引入的文件：运行时只引 @temporalio/workflow 的 defineSignal / defineQuery，别的一律只写类型。
// 输入进了工作流历史：以后只许加可选字段，不许改老字段的意思。

import type { Repo } from '@fleet-dao/shared';
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

export { taskBranch } from './task-branch.ts';

export interface TaskWorkflowInput {
  schemaVersion: 1;
  /** 库里的 tasks.id。 */
  taskId: string;
  repo: Repo;
  issueNumber: number;
  title: string;
}

export type TaskPhase = 'brief' | 'implement' | 'ci' | 'verify' | 'merge' | 'parked' | 'done' | 'abandoned';

/** 在等什么（驾驶舱「在跑的」每张单显示卡在哪一环、在等谁）。 */
export interface TaskWait {
  kind: 'human' | 'slot' | 'quota' | 'ci' | 'merge' | 'retry';
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

/** 「继续」：停着等人的任务接着走。by 写谁点的，note 是留给下一个看的人的话。 */
export interface ContinueCommand {
  by: string;
  note?: string;
}

/** 「放弃」：工作流收尾退出（工作树存档后删，PR 和单子不动，由人处理）。 */
export interface AbandonCommand {
  by: string;
  reason: string;
}

export const taskContinueSignal = defineSignal<[ContinueCommand]>('taskContinue');
export const taskAbandonSignal = defineSignal<[AbandonCommand]>('taskAbandon');
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
}

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
}

/** 改到了哪些要人拍或要第二意见的路径。两个都空＝合并闸之外没有别的门。 */
export interface GuardedPaths {
  /** 改标准的路径（人闸第四类：要创始人同意才挂自动合并）。 */
  standards: string[];
  /** 先审后合的路径（合并闸要通过的第二意见）。 */
  highRisk: string[];
}

export interface CheckGuardedInput {
  schemaVersion: 1;
  taskId: string;
  repo: Repo;
  prNumber: number;
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
  /** 挂的时候发现已经合了。 */
  merged: boolean;
  why?: string;
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
  | { state: 'waiting'; detail: string };
