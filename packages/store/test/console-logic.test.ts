import { describe, expect, it } from 'vitest';
import { isNotificationOpen, isSettingConflict, nextSettingVersion } from '../src/console-logic.ts';

describe('通知、设置共用判断', () => {
  it('isNotificationOpen：没处理才算开着', () => {
    expect(isNotificationOpen({})).toBe(true);
    expect(isNotificationOpen({ resolvedAt: '2026-01-01T00:00:00.000Z' })).toBe(false);
  });

  it('isSettingConflict：没有这条算第 0 版；版本不一样（多、少）都是冲突', () => {
    expect(isSettingConflict(undefined, 0)).toBe(false);
    expect(isSettingConflict(undefined, 1)).toBe(true);
    expect(isSettingConflict(2, 2)).toBe(false);
    expect(isSettingConflict(2, 1)).toBe(true);
    expect(isSettingConflict(2, 3)).toBe(true);
    expect(nextSettingVersion(2)).toBe(3);
    expect(nextSettingVersion(0)).toBe(1);
  });
});
