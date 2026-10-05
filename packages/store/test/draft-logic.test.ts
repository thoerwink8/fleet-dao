import { describe, expect, it } from 'vitest';
import { isAwaitingOpen, isDraftConfirmed, judgeConfirm } from '../src/draft-logic.ts';

describe('飞书草稿共用判断', () => {
  it('judgeConfirm：已确认先于版本比（重复确认回 already，哪怕版本也旧了）', () => {
    expect(judgeConfirm({ status: 'confirmed', revision: 3 }, 3)).toBe('already');
    expect(judgeConfirm({ status: 'confirmed', revision: 3 }, 2)).toBe('already');
  });

  it('judgeConfirm：没确认且版本对不上 = changed（多一版、少一版都算），对上才 proceed', () => {
    expect(judgeConfirm({ status: 'open', revision: 3 }, 2)).toBe('changed');
    expect(judgeConfirm({ status: 'open', revision: 3 }, 4)).toBe('changed');
    expect(judgeConfirm({ status: 'open', revision: 3 }, 3)).toBe('proceed');
  });

  it('isDraftConfirmed：只有 confirmed 算', () => {
    expect(isDraftConfirmed('confirmed')).toBe(true);
    expect(isDraftConfirmed('open')).toBe(false);
  });

  it('isAwaitingOpen：确认了而且还没开出任务才算；没确认的、已经开了的都不算', () => {
    expect(isAwaitingOpen({ status: 'confirmed', hasTask: false })).toBe(true);
    expect(isAwaitingOpen({ status: 'confirmed', hasTask: true })).toBe(false);
    expect(isAwaitingOpen({ status: 'open', hasTask: false })).toBe(false);
    expect(isAwaitingOpen({ status: 'open', hasTask: true })).toBe(false);
  });
});
