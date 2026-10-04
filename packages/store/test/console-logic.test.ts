import { describe, expect, it } from 'vitest';
import {
  askConstraintViolation,
  isAskOpen,
  isNotificationOpen,
  isSettingConflict,
  nextSettingVersion,
} from '../src/console-logic.ts';

describe('追问、通知、设置共用判断', () => {
  it('isAskOpen / isNotificationOpen：没回答、没处理才算开着（空字符串的回答也算回答过）', () => {
    expect(isAskOpen({})).toBe(true);
    expect(isAskOpen({ answer: '甲' })).toBe(false);
    expect(isAskOpen({ answer: '' })).toBe(false);
    expect(isNotificationOpen({})).toBe(true);
    expect(isNotificationOpen({ resolvedAt: '2026-01-01T00:00:00.000Z' })).toBe(false);
  });

  it('askConstraintViolation：合规回 undefined', () => {
    expect(
      askConstraintViolation({ options: ['甲', '乙'], recommended: '甲', scope: 'task', hold: undefined }),
    ).toBe(undefined);
    expect(
      askConstraintViolation({
        options: ['甲', '乙'],
        recommended: '乙',
        scope: 'hold',
        hold: { kind: 'x' },
      }),
    ).toBe(undefined);
  });

  it('【故意造出的失败】推荐的不在选项里：回原因，先于人闸判', () => {
    expect(
      askConstraintViolation({ options: ['甲'], recommended: '丙', scope: 'hold', hold: undefined }),
    ).toBe('推荐的「丙」不在选项里');
  });

  it('【故意造出的失败】人闸和范围对不上：范围是 hold 却没人闸、不是 hold 却带着人闸，都拒', () => {
    const base = { options: ['甲'], recommended: '甲' };
    expect(askConstraintViolation({ ...base, scope: 'hold', hold: undefined })).toBe(
      '人闸和提问的范围对不上',
    );
    expect(askConstraintViolation({ ...base, scope: 'task', hold: { kind: 'x' } })).toBe(
      '人闸和提问的范围对不上',
    );
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
