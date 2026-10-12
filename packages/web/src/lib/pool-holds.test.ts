// 额度页停用开关的纯函数：原因必填、复查日期可不填、封号只是显示。
import { describe, expect, test } from 'vitest';
import type { PoolHoldFactView, PoolHolds } from '../api/types';
import {
  legacyRowStatus,
  pauseProblem,
  poolSettingUnread,
  SWITCH_DECIDED_BY,
  SWITCH_REVOKE_WHEN,
  withoutHold,
  withPause,
} from './pool-holds';

const fact = (poolId: string, reviewBy?: string): PoolHoldFactView => ({
  poolId,
  reason: 'r',
  decidedBy: 'd',
  revokeWhen: 'w',
  owner: '指挥官',
  overdue: false,
  overdueDays: 0,
  ...(reviewBy ? { reviewBy } : {}),
});

describe('pauseProblem', () => {
  test('有原因、日期空着或是真日子才过', () => {
    expect(pauseProblem('被封号', '')).toBeNull();
    expect(pauseProblem('被封号', '2026-12-01')).toBeNull();
  });

  test('【故意造出的失败】没写原因、日期不是日历上的一天：不过', () => {
    expect(pauseProblem('', '')).toBe('先写一句原因');
    expect(pauseProblem('   ', '2026-12-01')).toBe('先写一句原因');
    expect(pauseProblem('被封号', '2026-02-30')).toContain('复查日期');
    expect(pauseProblem('被封号', '明天')).toContain('复查日期');
  });
});

describe('withPause', () => {
  test('没填复查日期就不写入；谁拍的和撤回条件代填；别的池留着', () => {
    const next = withPause([fact('relay', '2026-10-30')], 'claude-a', { reason: '被封号', reviewBy: '' });
    expect(next['claude-a']).toEqual({
      reason: '被封号',
      decidedBy: SWITCH_DECIDED_BY,
      revokeWhen: SWITCH_REVOKE_WHEN,
    });
    expect(next.relay?.reviewBy).toBe('2026-10-30');
    expect(next.relay?.owner).toBe('指挥官');
    const dated = withPause([], 'claude-a', { reason: '被封号', reviewBy: '2026-12-01' });
    expect(dated['claude-a']?.reviewBy).toBe('2026-12-01');
    expect(Object.keys(withoutHold([fact('a'), fact('b')], 'a'))).toEqual(['b']);
  });
});

describe('legacyRowStatus', () => {
  test('封号和登录失效都写成封号；别的取冒号后面', () => {
    expect(legacyRowStatus('账号池 claude-a 整池暂停：登录失效')).toBe('封号');
    expect(legacyRowStatus('账号池 claude-a 整池暂停：封号')).toBe('封号');
    expect(legacyRowStatus('账号池 relay 整池暂停：欠费')).toBe('欠费');
    expect(legacyRowStatus('账号池 cursor-pro 整池暂停：设备被撤销')).toBe('设备被撤销');
  });
});

describe('poolSettingUnread', () => {
  const base = {
    holds: [],
    problems: [],
    holdAll: false,
    legacy: [],
    version: 0,
    today: '2026-10-12',
    asOf: '2026-10-12T00:00:00.000Z',
  } satisfies PoolHolds;

  test('还在读不算没查成；查询失败、整份认不出、这一项认不出算', () => {
    expect(poolSettingUnread(undefined, false, 'claude-a')).toBe(false);
    expect(poolSettingUnread(undefined, true, 'claude-a')).toBe(true);
    expect(poolSettingUnread({ ...base, holdAll: true }, false, 'claude-a')).toBe(true);
    expect(
      poolSettingUnread({ ...base, problems: [{ poolId: 'claude-a', why: '认不出' }] }, false, 'claude-a'),
    ).toBe(true);
    expect(
      poolSettingUnread({ ...base, problems: [{ poolId: 'claude-a', why: '认不出' }] }, false, 'relay'),
    ).toBe(false);
  });
});
