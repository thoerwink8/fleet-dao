/**
 * 通知、设置（调度台那一组）两套 Store 共用的纯判断。
 * 改这里之前必须知道：pg 版把同样的判断写在 SQL 里（`where version = expected`、表上的 CHECK），
 * 只能照这里的文字对着写；内存版直接调这里的函数。两边必须判得一样，契约测试（store-contract）管。
 */
import { randomUUID } from 'node:crypto';
import type { DecisionAnswer, DecisionExecution, DecisionOption } from '@fleet-dao/shared';

/** 通知还没处理才能处理。 */
export const isNotificationOpen = (n: { resolvedAt?: string | undefined }): boolean =>
  n.resolvedAt === undefined;

export type DecisionInput = {
  optionId?: string | undefined;
  text?: string | undefined;
  requestId?: string | undefined;
  expectedAnswerId?: string | null | undefined;
};

/** 同一请求身份不能换内容；失败重试沿原答案，不能吞下一次相同选择。 */
export function prepareDecisionAnswer(
  current: DecisionAnswer | null | undefined,
  options: readonly DecisionOption[] | null | undefined,
  input: DecisionInput,
  by: string,
  at: string,
): DecisionAnswer | 'unknown_option' | 'conflict' | 'in_flight' {
  if (input.requestId && input.expectedAnswerId === undefined) return 'conflict';
  const proposed = decisionAnswerOf(options, input, by, at);
  if (proposed === 'unknown_option') return proposed;
  const same = current?.by === by && current.optionId === proposed.optionId && current.text === proposed.text;
  if (input.requestId && current?.requestId === input.requestId) return same ? current : 'conflict';
  if (input.expectedAnswerId !== undefined && (current?.id ?? null) !== input.expectedAnswerId)
    return 'conflict';
  if (
    current?.attempt?.state === 'executing' ||
    current?.attempt?.state === 'queued' ||
    current?.attempt?.state === 'unknown'
  ) {
    return same && !input.requestId ? current : 'in_flight';
  }
  if (same && current?.id && (!current.attempt || current.attempt.state === 'failed') && !input.requestId)
    return current;
  return { ...proposed, id: randomUUID(), ...(input.requestId ? { requestId: input.requestId } : {}) };
}

export function claimDecisionAnswer(answer: DecisionAnswer | null | undefined, answerId: string, at: string) {
  if (!answer?.id || answer.id !== answerId) return { kind: 'stale' as const };
  if (answer.attempt?.state === 'executing' || answer.attempt?.state === 'unknown')
    return { kind: 'in_flight' as const };
  if (answer.attempt?.state === 'queued' || answer.attempt?.state === 'succeeded') {
    return answer.execution ? { kind: 'replay' as const, answer } : { kind: 'stale' as const };
  }
  const { execution: _old, ...rest } = answer;
  const claimed = { ...rest, attempt: { id: randomUUID(), state: 'executing' as const, at } };
  return { kind: 'claimed' as const, answer: claimed, claimId: claimed.attempt.id };
}

export function settledDecisionAnswer(answer: DecisionAnswer, execution: DecisionExecution): DecisionAnswer {
  if (!answer.attempt) throw new Error('没有执行归属，不能结算');
  return {
    ...answer,
    execution,
    attempt: {
      ...answer.attempt,
      state: execution.unknown
        ? 'unknown'
        : execution.queued
          ? 'queued'
          : execution.ok
            ? 'succeeded'
            : 'failed',
    },
  };
}

/**
 * 「要你拍」的答案（#1915）：点选项的，text 记那一项的字（编号不在这条的选项里回 unknown_option）；自己输入的记原文、不带编号。
 */
export function decisionAnswerOf(
  options: readonly DecisionOption[] | null | undefined,
  input: { optionId?: string | undefined; text?: string | undefined },
  by: string,
  at: string,
): DecisionAnswer | 'unknown_option' {
  if (input.optionId !== undefined) {
    const picked = options?.find((o) => o.id === input.optionId);
    if (!picked) return 'unknown_option';
    return { optionId: picked.id, text: picked.label, at, by };
  }
  const text = input.text?.trim() ?? '';
  if (!text) throw new Error('答案是空的：点一个选项或自己输入一段话');
  return { text, at, by };
}

/** 设置按版本改（乐观锁）：库里没有这条算第 0 版；期望的版本和现在的不一样就是冲突。 */
export const isSettingConflict = (currentVersion: number | undefined, expectedVersion: number): boolean =>
  (currentVersion ?? 0) !== expectedVersion;

/** 改成功之后的版本：期望的版本加一。 */
export const nextSettingVersion = (expectedVersion: number): number => expectedVersion + 1;
