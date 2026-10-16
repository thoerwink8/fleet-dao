// 自测单独一档：限时是测试预算、tsc 预算、排队余量三者相加，有心跳，不重试。
// 建树仍是 setup（20 分钟、重试 3 次）。两档不要搅在一起。

import { describe, expect, it } from 'vitest';
import { ACTIVITY_PROFILE, activityOptions } from '../src/activity-options.ts';
import { DEFAULT_LIMITS } from '../src/limits.ts';
import {
  SELF_CHECK_ACTIVITY_MS,
  SELF_CHECK_QUEUE_MARGIN_MS,
  SELF_CHECK_TEST_MS,
  SELF_CHECK_TSC_MS,
} from '../src/self-check-budget.ts';

describe('selfCheck 活动档', () => {
  it('限时大于测试加 tsc 预算，由常量相加，有心跳，不重试', () => {
    const budget = SELF_CHECK_TEST_MS + SELF_CHECK_TSC_MS;
    expect(SELF_CHECK_QUEUE_MARGIN_MS).toBeGreaterThan(0);
    expect(SELF_CHECK_ACTIVITY_MS).toBe(budget + SELF_CHECK_QUEUE_MARGIN_MS);
    expect(SELF_CHECK_ACTIVITY_MS).toBeGreaterThan(budget);
    expect(ACTIVITY_PROFILE.selfCheck).toBe('selfCheck');

    const opts = activityOptions('selfCheck', DEFAULT_LIMITS);
    expect(opts.startToCloseTimeout).toBe(`${SELF_CHECK_ACTIVITY_MS / 1000} seconds`);
    expect(opts.heartbeatTimeout).toBe(`${DEFAULT_LIMITS.heartbeatSeconds} seconds`);
    expect(opts.retry?.maximumAttempts).toBe(1);

    const setup = activityOptions('createWorktree', DEFAULT_LIMITS);
    expect(setup.startToCloseTimeout).toBe('20 minutes');
    expect(setup.retry?.maximumAttempts).toBe(3);
  });
});
