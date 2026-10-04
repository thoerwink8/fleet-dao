import { describe, expect, it } from 'vitest';
import {
  clearedFailures,
  isLockedAt,
  nextFailureState,
  passwordNeedsUsername,
} from '../src/credentials-logic.ts';

const AT = Date.parse('2026-01-01T00:10:00.000Z');
const LOCK_MS = 15 * 60_000;
const PAST = '2026-01-01T00:00:00.000Z';
const FUTURE = '2026-01-01T00:20:00.000Z';

describe('密码登录失败锁定共用判断', () => {
  it('isLockedAt：锁到的时刻晚于此刻才算锁着，正好等于此刻已过期；没记锁到的不算', () => {
    expect(isLockedAt({ failedLogins: 0, lockedUntil: FUTURE }, AT)).toBe(true);
    expect(isLockedAt({ failedLogins: 0, lockedUntil: new Date(AT).toISOString() }, AT)).toBe(false);
    expect(isLockedAt({ failedLogins: 0, lockedUntil: PAST }, AT)).toBe(false);
    expect(isLockedAt({ failedLogins: 4 }, AT)).toBe(false);
  });

  it('没数到上限：次数加一、不锁', () => {
    expect(nextFailureState({ failedLogins: 0 }, AT, 5, LOCK_MS)).toEqual({
      failedLogins: 1,
      lockedUntil: undefined,
    });
    expect(nextFailureState({ failedLogins: 3 }, AT, 5, LOCK_MS)).toEqual({
      failedLogins: 4,
      lockedUntil: undefined,
    });
  });

  it('数到上限：锁住 lockMs、次数清零（maxFails=1 第一次就锁）', () => {
    const locked = new Date(AT + LOCK_MS).toISOString();
    expect(nextFailureState({ failedLogins: 4 }, AT, 5, LOCK_MS)).toEqual({
      failedLogins: 0,
      lockedUntil: locked,
    });
    expect(nextFailureState({ failedLogins: 0 }, AT, 1, LOCK_MS)).toEqual({
      failedLogins: 0,
      lockedUntil: locked,
    });
  });

  it('锁着的：什么都不动（锁期内的失败不累加、不延长）', () => {
    expect(nextFailureState({ failedLogins: 2, lockedUntil: FUTURE }, AT, 5, LOCK_MS)).toEqual({
      failedLogins: 2,
      lockedUntil: FUTURE,
    });
  });

  it('锁已过期：旧次数作废、这一次算第 1 次；过期后又数到上限照样锁', () => {
    expect(nextFailureState({ failedLogins: 4, lockedUntil: PAST }, AT, 5, LOCK_MS)).toEqual({
      failedLogins: 1,
      lockedUntil: undefined,
    });
    expect(nextFailureState({ failedLogins: 4, lockedUntil: PAST }, AT, 1, LOCK_MS).lockedUntil).toBe(
      new Date(AT + LOCK_MS).toISOString(),
    );
  });

  it('clearedFailures：次数清零、解锁', () => {
    expect(clearedFailures()).toEqual({ failedLogins: 0, lockedUntil: undefined });
  });

  it('passwordNeedsUsername：有密码没用户名才违反；只有用户名、都没有都不违反', () => {
    expect(passwordNeedsUsername({ passwordHash: 'h' })).toBe(true);
    expect(passwordNeedsUsername({ passwordHash: 'h', username: 'u' })).toBe(false);
    expect(passwordNeedsUsername({ username: 'u' })).toBe(false);
    expect(passwordNeedsUsername({})).toBe(false);
  });
});
