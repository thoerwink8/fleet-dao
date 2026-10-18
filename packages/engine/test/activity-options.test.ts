// 自测单独一档：限时是看目录、排队、测试执行、tsc、收尾各段上限相加，有心跳，不重试。
// 建树仍是 setup（20 分钟、重试 3 次）。两档不要搅在一起。

import { describe, expect, it } from 'vitest';
import { ACTIVITY_PROFILE, activityOptions } from '../src/activity-options.ts';
import { DEFAULT_LIMITS } from '../src/limits.ts';
import { KILL_SETTLE_MS } from '../src/real/exec.ts';
import {
  SELF_CHECK_ACTIVITY_MS,
  SELF_CHECK_CLEANUP_MS,
  SELF_CHECK_PROBE_MS,
  SELF_CHECK_QUEUE_MS,
  SELF_CHECK_RELEASE_MS,
  SELF_CHECK_TEST_MS,
  SELF_CHECK_TSC_MS,
} from '../src/self-check-budget.ts';

describe('selfCheck 活动档', () => {
  it('限时由各段上限相加，有心跳，不重试', () => {
    const segments = 2 * SELF_CHECK_PROBE_MS + SELF_CHECK_QUEUE_MS + SELF_CHECK_TEST_MS + SELF_CHECK_TSC_MS;
    expect(SELF_CHECK_ACTIVITY_MS).toBeGreaterThan(segments + SELF_CHECK_CLEANUP_MS);
    // 各段之外只留一分钟余量：不是单纯把总限时抬高
    expect(SELF_CHECK_ACTIVITY_MS - segments - SELF_CHECK_CLEANUP_MS).toBeLessThanOrEqual(60_000);
    expect(ACTIVITY_PROFILE.selfCheck).toBe('selfCheck');

    const opts = activityOptions('selfCheck', DEFAULT_LIMITS);
    expect(opts.startToCloseTimeout).toBe(`${SELF_CHECK_ACTIVITY_MS / 1000} seconds`);
    expect(opts.heartbeatTimeout).toBe(`${DEFAULT_LIMITS.heartbeatSeconds} seconds`);
    expect(opts.retry?.maximumAttempts).toBe(1);

    const setup = activityOptions('createWorktree', DEFAULT_LIMITS);
    expect(setup.startToCloseTimeout).toBe('20 minutes');
    expect(setup.retry?.maximumAttempts).toBe(3);
  });

  it('排队和执行各有上限、互不借用：排队 11 分钟之后测试仍有完整的 30 分钟，总限时比改前（72 分钟）短', () => {
    expect(SELF_CHECK_TEST_MS).toBe(30 * 60_000);
    // test:changed 自己等本机测试槽 15 分钟就退出 2：排队预算盖得住它，正常由它先退
    expect(SELF_CHECK_QUEUE_MS).toBeGreaterThan(15 * 60_000);
    expect(11 * 60_000).toBeLessThan(SELF_CHECK_QUEUE_MS);
    // 收尾盖得住五条命令（两次看目录、测试、受影响包、tsc）各自被杀后等管道关
    // 再加三次放名额、放锁，各有自己的上限
    expect(SELF_CHECK_CLEANUP_MS).toBeGreaterThanOrEqual(5 * KILL_SETTLE_MS + 3 * SELF_CHECK_RELEASE_MS);
    expect(SELF_CHECK_ACTIVITY_MS).toBeLessThan(72 * 60_000);
  });
});
