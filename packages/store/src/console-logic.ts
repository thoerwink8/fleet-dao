/**
 * 通知、设置（调度台那一组）两套 Store 共用的纯判断。
 * 改这里之前必须知道：pg 版把同样的判断写在 SQL 里（`where version = expected`、表上的 CHECK），
 * 只能照这里的文字对着写；内存版直接调这里的函数。两边必须判得一样，契约测试（store-contract）管。
 */

/** 通知还没处理才能处理。 */
export const isNotificationOpen = (n: { resolvedAt?: string | undefined }): boolean =>
  n.resolvedAt === undefined;

/** 设置按版本改（乐观锁）：库里没有这条算第 0 版；期望的版本和现在的不一样就是冲突。 */
export const isSettingConflict = (currentVersion: number | undefined, expectedVersion: number): boolean =>
  (currentVersion ?? 0) !== expectedVersion;

/** 改成功之后的版本：期望的版本加一。 */
export const nextSettingVersion = (expectedVersion: number): number => expectedVersion + 1;
