// 工作流共用的零件：活动代理、判断入口（判断出错也不判死）、失败信息提取。
// 这里是工作流代码，会被重放：改调度顺序（多调、少调、换顺序调活动或 decide）要用 patched()，见 test/replay.test.ts。
// #556-2：Fusion 时代的命令受理、暂停门、等待记账、挂起报警、跑一个阶段的会话和兜底梯，都跟着
// workflows/{fusion,requirement,subtask,merge-queue}.ts 和开 PR 前验证那块（verify.ts）一起删了；留的是 task.ts（#632）
// 用的这几样。

import {
  ActivityFailure,
  ApplicationFailure,
  ChildWorkflowFailure,
  isCancellation,
  log,
  proxyActivities,
  proxyLocalActivities,
  sleep,
  TemporalFailure,
  TimeoutFailure,
} from '@temporalio/workflow';
import {
  ACTIVITY_PROFILE,
  type ActivityName,
  activityOptions,
  type EngineActivities,
} from '../activity-options.ts';
import type { FailureInfo } from '../decisions/failure.ts';
import type { Decide, DecisionKind, DecisionMap } from '../decisions/index.ts';
import type { Limits } from '../limits.ts';

/** 流程判断：本地活动，结果进历史，重放时不重算。自己带几次重试；再不行由调用方按兜底梯走，不判死。 */
const { decide } = proxyLocalActivities<{ decide: Decide }>({
  startToCloseTimeout: '30 seconds',
  retry: { maximumAttempts: 3, initialInterval: '500 milliseconds', backoffCoefficient: 2 },
});

type In<K extends DecisionKind> = DecisionMap[K]['input'];
type Out<K extends DecisionKind> = DecisionMap[K]['output'];

/** 判断出错后的退避：15 秒起翻倍，封顶 10 分钟（和兜底梯的重试一样）。 */
function backoffSeconds(failuresSoFar: number): number {
  return Math.min(15 * 2 ** failuresSoFar, 600);
}

/**
 * 没有暂停、挂起可用的地方（开头解析上限、合并队列）调判断：出错就退避着一直试；连着出错到第 alertAfter 次时报一次警。
 * 判断出错多半是代码错了：修好换上新工人，下一次就接着走。
 */
export async function judgeRetrying<K extends DecisionKind>(
  kind: K,
  input: In<K>,
  stuck: { alertAfter: number; alert(message: string): Promise<void> } | null = null,
): Promise<Out<K>> {
  for (let failures = 0; ; failures += 1) {
    try {
      return await decide(kind, input);
    } catch (error) {
      if (isCancellation(error)) throw error;
      const message = failureOf(error, `decide:${kind}`).message;
      log.error('判断出错，退避后重试', { kind, failures: failures + 1, error: message });
      if (stuck && failures + 1 === stuck.alertAfter) await stuck.alert(message);
      await sleep(`${backoffSeconds(failures)} seconds`);
    }
  }
}

/** 开头解析上限（还没有上限，没法按兜底梯走）。resolveLimits 自己不会出错，出错只能是工人配错了。 */
export function limitsFor(partial: Partial<Limits> | undefined): Promise<Limits> {
  return judgeRetrying('limits', partial ?? {});
}

/** 给每个活动配上它自己的选项（那一档的超时与重试、叫停时等不等它收场），见 activity-options.ts。 */
export function activitiesFor(limits: Limits): EngineActivities {
  const out: Partial<Record<ActivityName, unknown>> = {};
  for (const name of Object.keys(ACTIVITY_PROFILE) as ActivityName[]) {
    out[name] = proxyActivities<EngineActivities>(activityOptions(name, limits))[name];
  }
  return out as EngineActivities;
}

export function iso(ms: number): string {
  return new Date(ms).toISOString();
}

/** 活动失败 → 失败分流要的结构化信息。只做提取，不做判断。 */
export function failureOf(error: unknown, source: string): FailureInfo {
  let cause: unknown = error;
  if ((cause instanceof ActivityFailure || cause instanceof ChildWorkflowFailure) && cause.cause)
    cause = cause.cause;
  if (cause instanceof ApplicationFailure) {
    return { source, code: cause.type ?? 'Error', message: cause.message, retryable: !cause.nonRetryable };
  }
  if (cause instanceof TimeoutFailure) {
    return {
      source,
      code: `TIMEOUT_${cause.timeoutType ?? 'UNKNOWN'}`,
      message: cause.message,
      retryable: true,
    };
  }
  if (cause instanceof TemporalFailure || cause instanceof Error) {
    return { source, code: cause.name, message: cause.message, retryable: null };
  }
  return { source, code: 'UNKNOWN', message: String(cause), retryable: null };
}

/** 活动失败里带的冲突文件名（PortError.details.conflictFiles）；没有就从原文「有冲突：a、b。」里拆。 */
export function conflictFilesOf(error: unknown, message: string): string[] {
  const fromDetails = fileList(detailRecord(error)?.conflictFiles);
  if (fromDetails.length > 0) return fromDetails;
  const matched = /(?:有冲突|真冲突)：([^。\n]+)/.exec(message);
  return fileList(matched?.[1]?.split('、'));
}

function detailRecord(error: unknown): { conflictFiles?: unknown } | undefined {
  let current: unknown = error;
  for (let depth = 0; depth < 4 && current !== null && typeof current === 'object'; depth += 1) {
    const record = current as { details?: unknown; cause?: unknown };
    const first = Array.isArray(record.details) ? record.details[0] : undefined;
    if (first !== null && typeof first === 'object') return first as { conflictFiles?: unknown };
    current = record.cause;
  }
  return undefined;
}

function fileList(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return value.map((item) => (typeof item === 'string' ? item.trim() : '')).filter((item) => item.length > 0);
}
