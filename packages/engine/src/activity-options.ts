// 每个活动的超时、心跳、重试、叫停时等不等它收场：按活动类型分开设，唯一出处在这里（旧系统所有活动共用一个 74 分钟、
// 没有心跳，工人一重启丢掉的活动要干等 74 分钟才判死）。工作流按这张表给每个活动配代理，不许在调用处另写。

import type { Repo } from '@fleet-dao/shared';
import type { ActivityOptions, RetryPolicy } from '@temporalio/common';
import type { GitHubReconcileInput, GitHubReconcileRun, MergeItem } from './contract.ts';
import type { Limits } from './limits.ts';
import type { EnginePorts, StartSessionInput, StartSessionResult } from './ports.ts';

type PortActivities = {
  [K in Exclude<keyof EnginePorts, 'startSession'>]: (
    input: Parameters<EnginePorts[K]>[0],
  ) => ReturnType<EnginePorts[K]>;
};

/** 工作流看到的活动。startSession 不带通行证：通行证由 worker 在活动里现签（见 activities.ts）。 */
export type EngineActivities = PortActivities & {
  startSession(input: StartSessionInput): Promise<StartSessionResult>;
  /** 引擎自己的活动：经 Temporal 客户端 signalWithStart 把条目排进这个仓的合并队列。 */
  enqueueMerge(input: { item: MergeItem; limits: Partial<Limits> }): Promise<void>;
  /**
   * 引擎自己的活动：撤出信号直接发不出去（队列没在跑）时，经 signalWithStart 送去——顺手把队列拉起来，
   * 让它记下撤回、挡住晚到的排队（排队的那一下可能还在路上）。
   */
  withdrawMerge(input: {
    repo: Repo;
    itemId: string;
    subtaskWorkflowId: string;
    limits: Partial<Limits>;
  }): Promise<void>;
  /** 引擎自己的活动：对账补漏跑一轮，结局记进 schedule_runs（jobs/github-reconcile.ts）。 */
  reconcileGitHub(input: GitHubReconcileInput): Promise<GitHubReconcileRun>;
};

export type ActivityName = keyof EngineActivities;

/**
 * quick：毫秒到秒级的记账、选路由、报警——30 秒，丢了 1 分钟内重来。
 * git：推分支、开 PR、合并这类几秒到几分钟的——5 分钟，幂等，重试 3 次。
 * setup / watch / ci / tests：长活动——限时按活来，必须心跳，心跳超时 = 工人丢了。
 * job：定时任务的一轮——10 分钟，不重试：每次尝试都记一行 schedule_runs，没跑成的等下一轮（间隔 15 分钟），不在这一轮里补。
 */
export type Profile = 'quick' | 'git' | 'setup' | 'watch' | 'ci' | 'tests' | 'job';

export const ACTIVITY_PROFILE: Readonly<Record<ActivityName, Profile>> = {
  pickRoute: 'quick',
  recordTiming: 'quick',
  saveTaskState: 'quick',
  raiseAlert: 'quick',
  askHuman: 'quick',
  requestApproval: 'quick',
  enqueueMerge: 'quick',
  withdrawMerge: 'quick',
  startSession: 'git',
  stopSession: 'git',
  removeWorktree: 'git',
  pushBranch: 'git',
  openPr: 'git',
  syncMainline: 'git',
  mergePr: 'git',
  updateIssueProgress: 'git',
  closeIssue: 'git',
  writeSpecDoc: 'git',
  createWorktree: 'setup',
  awaitSession: 'watch',
  waitCi: 'ci',
  runTests: 'tests',
  reconcileGitHub: 'job',
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
    case 'watch':
      // 会话本身在工人外面跑；看守丢了就重新接上（接不上会回 SESSION_LOST），所以可以重试。
      return {
        startToCloseTimeout: `${limits.sessionMinutes} minutes`,
        heartbeatTimeout,
        retry: retry(3, '2 seconds', '30 seconds'),
      };
    case 'ci':
      return {
        startToCloseTimeout: `${limits.ciMinutes} minutes`,
        heartbeatTimeout,
        retry: retry(3, '5 seconds', '1 minute'),
      };
    case 'job':
      return { startToCloseTimeout: '10 minutes', retry: retry(1, '1 second', '1 second') };
    case 'tests':
      return {
        startToCloseTimeout: `${limits.testsMinutes} minutes`,
        heartbeatTimeout,
        retry: retry(2, '5 seconds', '1 minute'),
      };
  }
}

/**
 * 叫停时要等服务端给出结论（活动做完，或者判它超时）才往下走的活动。
 * 不设的活动按 SDK 的实际默认 TRY_CANCEL：叫停时工作流当场往下走，不等活动（1.24 的文档注释说默认是
 * WAIT_CANCELLATION_COMPLETED，不对——不设就编码成 0 = TRY_CANCEL）。
 * 排进合并队列要等：排队的那一下通常在这期间落地，收尾再撤出就撤得掉。它不心跳、收不到叫停，最多等到这次尝试的限时
 * （30 秒，叫停之后服务端不再重试）；服务端判超时时代码可能还卡着、事后才发——那一下由队列记下的撤回挡回去
 * （workflows/subtask.ts 的 sendWithdraw）。
 */
export const WAIT_FOR_CANCEL: readonly ActivityName[] = ['enqueueMerge'];

/** 一个活动的完整选项：它那一档的超时、心跳、重试，加上叫停时等不等它收场。 */
export function activityOptions(name: ActivityName, limits: Limits): ActivityOptions {
  const options = profileOptions(ACTIVITY_PROFILE[name], limits);
  return WAIT_FOR_CANCEL.includes(name)
    ? { ...options, cancellationType: 'WAIT_CANCELLATION_COMPLETED' }
    : options;
}
