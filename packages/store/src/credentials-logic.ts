/**
 * 密码登录失败锁定两套 Store 共用的纯判断。
 * 改这里之前必须知道：pg 版把同样的规则写在一条 UPDATE 的 CASE 里（锁着的不动；锁已过期的从 0 数起；数到 maxFails 就锁住并清零），
 * 只能照这里的文字对着写；内存版直接调这里的函数。两边必须算出同样的（失败次数、锁到几点），契约测试（store-contract-credentials）管。
 */

export interface FailureState {
  failedLogins: number;
  /** 锁到什么时候（ISO）；没锁或不记了是 undefined。 */
  lockedUntil?: string | undefined;
}

/** 此刻还锁着：有锁到的时刻、而且晚于此刻（正好等于此刻算已过期）。 */
export function isLockedAt(state: FailureState, atMs: number): boolean {
  return state.lockedUntil !== undefined && Date.parse(state.lockedUntil) > atMs;
}

/**
 * 又失败了一次之后的状态：
 * - 锁着的：什么都不动（失败次数、锁到的时刻原样），锁期内的失败不累加；
 * - 锁已过期的：旧次数作废、这一次算第 1 次；
 * - 数到 maxFails：锁住 lockMs、次数清零；
 * - 其余：次数加一、不锁。
 */
export function nextFailureState(
  state: FailureState,
  atMs: number,
  maxFails: number,
  lockMs: number,
): FailureState {
  if (isLockedAt(state, atMs)) return { failedLogins: state.failedLogins, lockedUntil: state.lockedUntil };
  const count = (state.lockedUntil === undefined ? state.failedLogins : 0) + 1;
  return count >= maxFails
    ? { failedLogins: 0, lockedUntil: new Date(atMs + lockMs).toISOString() }
    : { failedLogins: count, lockedUntil: undefined };
}

/** 设了新用户名、新密码或登录成功：失败次数清零、解锁。 */
export const clearedFailures = (): FailureState => ({ failedLogins: 0, lockedUntil: undefined });

/** 有密码就得有用户名（库里的约束 users_password_needs_username）。 */
export const passwordNeedsUsername = (next: {
  passwordHash?: string | undefined;
  username?: string | undefined;
}) => next.passwordHash !== undefined && next.username === undefined;
