// 合并队列里一个条目的状态机：同步主线 → 在新头上重跑测试 → 带头约束合并 → 回读。红了、冲突了就退回。

import type { Limits } from '../limits.ts';
import type { Feedback, SyncResult } from './verify.ts';

export interface TestResult {
  passed: boolean;
  /** 测的是哪个头；和要合的头对不上不算数。 */
  head: string;
  summary: string;
}

export interface MergeOutcome {
  merged: boolean;
  mergeCommit?: string;
  reason?: string;
}

export interface MergeStepInput {
  withdrawn: boolean;
  sync: SyncResult | null;
  tests: TestResult | null;
  merge: MergeOutcome | null;
  /** 某一步的活动失败了（重试用完）。 */
  failed?: { step: string; message: string } | null | undefined;
}

export type ReturnReason = 'conflict' | 'tests-red' | 'tests-stale' | 'merge-failed' | 'infra';

export type MergeStep =
  | { next: 'sync' }
  | { next: 'test'; head: string }
  | { next: 'merge'; head: string }
  | { next: 'done'; result: 'merged'; mergeCommit: string }
  | { next: 'done'; result: 'returned'; reason: ReturnReason; detail: string; files: string[] }
  | { next: 'done'; result: 'dropped'; detail: string };

export function mergeStep(input: MergeStepInput): MergeStep {
  if (input.withdrawn) return { next: 'done', result: 'dropped', detail: '子任务撤回了' };
  if (input.failed) {
    return {
      next: 'done',
      result: 'returned',
      reason: 'infra',
      detail: `${input.failed.step} 失败：${input.failed.message}`,
      files: [],
    };
  }
  const { sync, tests, merge } = input;
  if (!sync) return { next: 'sync' };
  if (sync.state === 'conflict') {
    return {
      next: 'done',
      result: 'returned',
      reason: 'conflict',
      detail: '最新主线并进来有冲突',
      files: sync.conflictFiles,
    };
  }
  if (!tests) return { next: 'test', head: sync.head };
  if (tests.head !== sync.head) {
    return {
      next: 'done',
      result: 'returned',
      reason: 'tests-stale',
      detail: `测的头 ${tests.head} 不是要合的头 ${sync.head}`,
      files: [],
    };
  }
  if (!tests.passed) {
    return { next: 'done', result: 'returned', reason: 'tests-red', detail: tests.summary, files: [] };
  }
  if (!merge) return { next: 'merge', head: sync.head };
  if (merge.merged && merge.mergeCommit)
    return { next: 'done', result: 'merged', mergeCommit: merge.mergeCommit };
  return {
    next: 'done',
    result: 'returned',
    reason: 'merge-failed',
    detail: merge.reason ?? '合并没成功（回读不是已合并）',
    files: [],
  };
}

export interface MergeReturnInput {
  reason: ReturnReason;
  detail: string;
  files: string[];
  /** 这个子任务已经被退回过几次（不含这一次）。 */
  returnsSoFar: number;
  limits: Pick<Limits, 'mergeReturns'>;
}

export type MergeReturnDecision =
  | { action: 'rework'; feedback: Feedback[]; reason: string }
  | { action: 'requeue'; delaySeconds: number; reason: string }
  | { action: 'escalate'; reason: string; detail: string };

/** 退回之后：冲突、测试红交回主会话；基础设施失败不烦 AI，等一会儿原样重排；次数到了交帅位。 */
export function afterMergeReturn(input: MergeReturnInput): MergeReturnDecision {
  if (input.returnsSoFar >= input.limits.mergeReturns) {
    return {
      action: 'escalate',
      reason: `合并队列已经退回 ${input.returnsSoFar + 1} 次`,
      detail: `${input.reason}：${input.detail}`,
    };
  }
  if (input.reason === 'infra') {
    return {
      action: 'requeue',
      delaySeconds: 60 * 2 ** input.returnsSoFar,
      reason: `合并队列出错，稍后重排：${input.detail}`,
    };
  }
  const summary =
    input.reason === 'conflict'
      ? '合并前并最新主线有冲突，请解决'
      : input.reason === 'tests-red'
        ? '合并前在最新主线上重跑测试没过'
        : `合并没成功（${input.reason}）`;
  return {
    action: 'rework',
    feedback: [
      { kind: 'merge-return', summary, items: input.files.length > 0 ? input.files : [input.detail] },
    ],
    reason: `合并队列退回：${summary}`,
  };
}
