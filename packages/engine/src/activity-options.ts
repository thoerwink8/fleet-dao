// 每个活动的超时、心跳、重试、叫停时等不等它收场：按活动类型分开设，唯一出处在这里（旧系统所有活动共用一个 74 分钟、
// 没有心跳，工人一重启丢掉的活动要干等 74 分钟才判死）。工作流按这张表给每个活动配代理，不许在调用处另写。

import type { ActivityOptions, RetryPolicy } from '@temporalio/common';
import type { CanaryInput } from './contract.ts';
import type { CanaryState, CanaryStepResult } from './jobs/canary.ts';
import type { Limits } from './limits.ts';
import type { EnginePorts } from './ports.ts';
import type { TaskBriefResult } from './runner/task-brief.ts';
import {
  type ArmAutoMergeInput,
  type ArmAutoMergeResult,
  type CheckGuardedInput,
  type ColdVerifyInput,
  type ColdVerifyResult,
  type DeliveryRead,
  type GuardedPaths,
  MERGE_POLL_MINUTES,
  type MergeWait,
  type ReadDeliveryInput,
  type ReadTaskBriefInput,
  type RunSegmentInput,
  type RunSegmentResult,
  SEGMENT_MINUTES,
  type WaitMergedInput,
} from './task-contract.ts';

type PortActivities = {
  [K in keyof EnginePorts]: (input: Parameters<EnginePorts[K]>[0]) => ReturnType<EnginePorts[K]>;
};

/** 工作流看到的活动：端口（EnginePorts）里的，加上引擎自己的。 */
export type EngineActivities = PortActivities & {
  /** 引擎自己的活动：全流程巡检开一张单（jobs/canary.ts 的 openCanaryRound）；没跑成的已经记进库，回的是结论。 */
  canaryOpen(input: CanaryInput): Promise<CanaryStepResult>;
  /**
   * 引擎自己的活动：全流程巡检看一回、判、记（jobs/canary.ts 的 checkCanaryRound）。状态包在 state 里：活动的计时按输入最外层的
   * taskId 记到任务上，巡检自己看的这几下不能记成巡检单的每步耗时（那是记账那一步要核的）。
   */
  canaryCheck(input: { schemaVersion: 1; state: CanaryState }): Promise<CanaryStepResult>;
  // —— 任务工作流（task-contract.ts；#632）要的活动：现读单子、起一次无头动手会话、读交付、冷验收、合并这几步 ——
  /** 现读单子和它指着的需求文档，拼出动手的交代（runner/task-brief.ts）。单子读不到抛错；缺栏回 problems。 */
  readTaskBrief(input: ReadTaskBriefInput): Promise<TaskBriefResult>;
  /** 起一次无头动手会话（one-shot）：会话没跑成回 ok:false 和证据，交给失败分流；起不来的基础设施问题抛错。 */
  runSegment(input: RunSegmentInput): Promise<RunSegmentResult>;
  /** 读会话交付的东西（工作树现在的头、比起点多几个提交、改了哪些文件）。读不到抛错，不回空。 */
  readDelivery(input: ReadDeliveryInput): Promise<DeliveryRead>;
  /** 合并之前的冷验收（换一个不同的族）。没能做出来回 unavailable，不当成没过。 */
  coldVerify(input: ColdVerifyInput): Promise<ColdVerifyResult>;
  /** 这个 PR 改到的文件里，哪些是改标准的路径（要创始人同意）、哪些是先审后合的路径。读不到抛错，不当成没碰到。 */
  checkGuarded(input: CheckGuardedInput): Promise<GuardedPaths>;
  /** 给 PR 挂上自动合并（squash，只合 expectedHead）。 */
  armAutoMerge(input: ArmAutoMergeInput): Promise<ArmAutoMergeResult>;
  /** 等 PR 合并（长轮询，到点回 waiting 由工作流再来一次）。 */
  waitMerged(input: WaitMergedInput): Promise<MergeWait>;
};

export type ActivityName = keyof EngineActivities;

/**
 * quick：毫秒到秒级的记账、选路由、报警——30 秒，丢了 1 分钟内重来。
 * git：推分支、开 PR、合并这类几秒到几分钟的——5 分钟，幂等，重试 3 次。
 * setup / ci：长活动——限时按活来，必须心跳，心跳超时 = 工人丢了。
 * job：全流程巡检的开单、看一回——10 分钟，不重试：开单没成的已经记进库、回的是结论，看一回连着没成的由工作流数着（CANARY_CHECK_FAILURE_LIMIT）。
 * 别的定时任务（对账、探针、读额度、看门狗……）不是活动了（#1072）：引擎的定时器直接跑，一轮的限时在 jobs/engine-timers.ts。
 * segment：一次无头会话（动手、冷验收）——限时是会话最长时间加一刻钟收尾，必须心跳；只试一次：会话贵又不幂等，
 * 活动失败怎么办（重试、换路由、挂起）由工作流按失败分流定，不在 Temporal 这一层自动再起一遍。
 * poll：长轮询（等合并）——一次最多 MERGE_POLL_MINUTES 分钟加余量，必须心跳；工人丢了重试没有副作用（只读）。
 */
export type Profile = 'quick' | 'git' | 'setup' | 'ci' | 'job' | 'segment' | 'poll';

export const ACTIVITY_PROFILE: Readonly<Record<ActivityName, Profile>> = {
  pickRoute: 'quick',
  recordTiming: 'quick',
  saveTaskState: 'quick',
  raiseAlert: 'quick',
  authorFamilies: 'quick',
  removeWorktree: 'git',
  pushBranch: 'git',
  openPr: 'git',
  syncMainline: 'git',
  closeIssue: 'git',
  createWorktree: 'setup',
  waitCi: 'ci',
  canaryOpen: 'job',
  canaryCheck: 'job',
  readTaskBrief: 'git',
  runSegment: 'segment',
  readDelivery: 'git',
  coldVerify: 'segment',
  checkGuarded: 'git',
  armAutoMerge: 'git',
  waitMerged: 'poll',
};

/** quick 一档（含排进合并队列、撤出）一次尝试的限时。合并队列的空闲收工时长不能比它短（limits.ts 的下限）。 */
export const QUICK_TIMEOUT_SECONDS = 30;

/** 重试也治不好的错误码：直接交给失败分流。 */
export const NON_RETRYABLE_CODES: readonly string[] = [
  'NEEDS_HUMAN',
  'AUTH_REQUIRED',
  'PERMISSION_DENIED',
  'WORKFLOWS_PERMISSION',
  'INVALID_INPUT',
];

function retry(maximumAttempts: number, initialInterval: string, maximumInterval: string): RetryPolicy {
  return {
    maximumAttempts,
    initialInterval,
    maximumInterval,
    backoffCoefficient: 2,
    nonRetryableErrorTypes: [...NON_RETRYABLE_CODES],
  };
}

export function profileOptions(profile: Profile, limits: Limits): ActivityOptions {
  const heartbeatTimeout = `${limits.heartbeatSeconds} seconds`;
  switch (profile) {
    case 'quick':
      return {
        startToCloseTimeout: `${QUICK_TIMEOUT_SECONDS} seconds`,
        retry: retry(5, '1 second', '30 seconds'),
      };
    case 'git':
      return { startToCloseTimeout: '5 minutes', retry: retry(3, '5 seconds', '1 minute') };
    case 'setup':
      // 建树 + 装依赖。
      return {
        startToCloseTimeout: '20 minutes',
        heartbeatTimeout,
        retry: retry(3, '5 seconds', '1 minute'),
      };
    case 'ci':
      return {
        startToCloseTimeout: `${limits.ciMinutes} minutes`,
        heartbeatTimeout,
        retry: retry(3, '5 seconds', '1 minute'),
      };
    case 'job':
      return { startToCloseTimeout: '10 minutes', retry: retry(1, '1 second', '1 second') };
    case 'segment':
      return {
        startToCloseTimeout: `${SEGMENT_MINUTES + 15} minutes`,
        heartbeatTimeout,
        retry: retry(1, '1 second', '1 second'),
      };
    case 'poll':
      return {
        startToCloseTimeout: `${MERGE_POLL_MINUTES + 5} minutes`,
        heartbeatTimeout,
        retry: retry(3, '5 seconds', '1 minute'),
      };
  }
}

/** 一个活动的完整选项：它那一档的超时、心跳、重试。 */
export function activityOptions(name: ActivityName, limits: Limits): ActivityOptions {
  return profileOptions(ACTIVITY_PROFILE[name], limits);
}
