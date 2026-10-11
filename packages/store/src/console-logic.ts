/**
 * 通知、设置（调度台那一组）两套 Store 共用的纯判断。
 * 改这里之前必须知道：pg 版把同样的判断写在 SQL 里（`where version = expected`、表上的 CHECK），
 * 只能照这里的文字对着写；内存版直接调这里的函数。两边必须判得一样，契约测试（store-contract）管。
 */
import type { DecisionAnswer, DecisionOption } from '@fleet-dao/shared';

/** 通知还没处理才能处理。 */
export const isNotificationOpen = (n: { resolvedAt?: string | undefined }): boolean =>
  n.resolvedAt === undefined;

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
