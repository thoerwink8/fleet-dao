import { describe, expect, it } from 'vitest';
import {
  ENGINE_MASTER_RELEASE_GRACE_MS,
  engineMasterOffWithinReleaseGrace,
  isReleaseStuckMasterOff,
} from '../src/web-api/engine-master-stuck.ts';
import { ENGINE_MASTER_DISABLE, ENGINE_MASTER_ENABLE } from '../src/web-api/engine-switch.ts';

const NOW = new Date('2026-10-10T08:00:00.000Z');

describe('isReleaseStuckMasterOff（#1732）', () => {
  it('开着不算卡住', () => {
    expect(
      isReleaseStuckMasterOff({
        masterOn: true,
        latest: {
          action: ENGINE_MASTER_DISABLE,
          reason: '发版前暂停（x）',
          at: new Date(NOW.getTime() - ENGINE_MASTER_RELEASE_GRACE_MS - 1),
        },
        now: NOW,
        releaseInFlight: false,
      }),
    ).toBe(false);
  });

  it('发版还在走不算卡住', () => {
    expect(
      isReleaseStuckMasterOff({
        masterOn: false,
        latest: {
          action: ENGINE_MASTER_DISABLE,
          reason: '发版前暂停（x）',
          at: new Date(NOW.getTime() - ENGINE_MASTER_RELEASE_GRACE_MS - 1),
        },
        now: NOW,
        releaseInFlight: true,
      }),
    ).toBe(false);
  });

  it('宽限内不算卡住', () => {
    expect(
      isReleaseStuckMasterOff({
        masterOn: false,
        latest: {
          action: ENGINE_MASTER_DISABLE,
          reason: '发版前暂停（release-train）',
          at: new Date(NOW.getTime() - 10 * 60_000),
        },
        now: NOW,
        releaseInFlight: false,
      }),
    ).toBe(false);
  });

  it('发版前暂停关上、过了宽限、没开回：卡住', () => {
    expect(
      isReleaseStuckMasterOff({
        masterOn: false,
        latest: {
          action: ENGINE_MASTER_DISABLE,
          reason: '发版前暂停（驾驶舱点击发布，目标 abcdef012345）',
          at: new Date(NOW.getTime() - ENGINE_MASTER_RELEASE_GRACE_MS - 1),
        },
        now: NOW,
        releaseInFlight: false,
      }),
    ).toBe(true);
  });

  it('有意关（原因不含发版前暂停）不自动当卡住', () => {
    expect(
      isReleaseStuckMasterOff({
        masterOn: false,
        latest: {
          action: ENGINE_MASTER_DISABLE,
          reason: '今晚先停派活，明天再说',
          at: new Date(NOW.getTime() - ENGINE_MASTER_RELEASE_GRACE_MS - 1),
        },
        now: NOW,
        releaseInFlight: false,
      }),
    ).toBe(false);
  });

  it('最近一笔是打开：不算卡住', () => {
    expect(
      isReleaseStuckMasterOff({
        masterOn: false,
        latest: {
          action: ENGINE_MASTER_ENABLE,
          reason: '发版后恢复',
          at: new Date(NOW.getTime() - ENGINE_MASTER_RELEASE_GRACE_MS - 1),
        },
        now: NOW,
        releaseInFlight: false,
      }),
    ).toBe(false);
  });
});

describe('engineMasterOffWithinReleaseGrace', () => {
  it('暂停标记或发版车在走：在宽限里', () => {
    expect(
      engineMasterOffWithinReleaseGrace({
        pauseActive: true,
        trainRunning: false,
        lastReleaseAt: null,
        now: NOW,
      }),
    ).toBe(true);
    expect(
      engineMasterOffWithinReleaseGrace({
        pauseActive: false,
        trainRunning: true,
        lastReleaseAt: null,
        now: NOW,
      }),
    ).toBe(true);
  });

  it('刚写过发布历史：在宽限里；太久了不在', () => {
    expect(
      engineMasterOffWithinReleaseGrace({
        pauseActive: false,
        trainRunning: false,
        lastReleaseAt: new Date(NOW.getTime() - 10 * 60_000),
        now: NOW,
      }),
    ).toBe(true);
    expect(
      engineMasterOffWithinReleaseGrace({
        pauseActive: false,
        trainRunning: false,
        lastReleaseAt: new Date(NOW.getTime() - ENGINE_MASTER_RELEASE_GRACE_MS - 1),
        now: NOW,
      }),
    ).toBe(false);
  });
});
