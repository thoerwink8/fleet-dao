// 每个活动的超时、心跳、重试：按活动类型分开设，唯一出处在这里（旧系统所有活动共用一个 74 分钟、没有心跳，
// 工人一重启丢掉的活动要干等 74 分钟才判死）。工作流按这张表给每个活动配代理，不许在调用处另写超时。

import type { ActivityOptions, RetryPolicy } from '@temporalio/common';
import type { MergeItem } from './contract.ts';
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
};

export type ActivityName = keyof EngineActivities;

/**
 * quick：毫秒到秒级的记账、选路由、报警——30 秒，丢了 1 分钟内重来。
 * git：推分支、开 PR、合并这类几秒到几分钟的——5 分钟，幂等，重试 3 次。
 * setup / watch / ci / tests：长活动——限时按活来，必须心跳，心跳超时 = 工人丢了。
 */
export type Profile = 'quick' | 'git' | 'setup' | 'watch' | 'ci' | 'tests';

export const ACTIVITY_PROFILE: Readonly<Record<ActivityName, Profile>> = {
  pickRoute: 'quick',
  recordTiming: 'quick',
  saveTaskState: 'quick',
  raiseAlert: 'quick',
  askHuman: 'quick',
  enqueueMerge: 'quick',
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
};

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
      return { startToCloseTimeout: '30 seconds', retry: retry(5, '1 second', '30 seconds') };
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
    case 'tests':
      return {
        startToCloseTimeout: `${limits.testsMinutes} minutes`,
        heartbeatTimeout,
        retry: retry(2, '5 seconds', '1 minute'),
      };
  }
}
