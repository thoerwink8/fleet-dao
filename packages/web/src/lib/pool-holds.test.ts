// 设置页「整池暂停」的纯函数（#746）：校验新建表单、拼要存的整份值。
import { describe, expect, test } from 'vitest';
import type { PoolHoldFactView } from '../api/types';
import { draftProblem, EMPTY_DRAFT, withHold, withOwner, withoutHold, withReviewBy } from './pool-holds';

const full = {
  poolId: 'claude-solo',
  reason: '创始人要大用独享',
  decidedBy: '「先停」2026-10-05',
  revokeWhen: '创始人说可以用了',
  reviewBy: '2026-10-30',
  owner: '指挥官',
};
const fact = (poolId: string, reviewBy = '2026-10-30'): PoolHoldFactView => ({
  poolId,
  reason: 'r',
  decidedBy: 'd',
  revokeWhen: 'w',
  reviewBy,
  owner: '指挥官',
  overdue: false,
  overdueDays: 0,
});

describe('draftProblem', () => {
  test('齐全、日期是真的才过', () => {
    expect(draftProblem(full, [])).toBeNull();
  });

  test('【故意造出的失败】没选池、缺任一项、空白、假日期、已经有这个池：都不过，说清哪一项', () => {
    expect(draftProblem(EMPTY_DRAFT, [])).toBe('先选哪个账号池');
    expect(draftProblem({ ...full, reason: '' }, [])).toContain('为什么停');
    expect(draftProblem({ ...full, decidedBy: '   ' }, [])).toContain('谁拍的');
    expect(draftProblem({ ...full, revokeWhen: '' }, [])).toContain('什么条件下撤');
    expect(draftProblem({ ...full, reviewBy: '' }, [])).toContain('最迟复查日期');
    expect(draftProblem({ ...full, reviewBy: '2026-02-30' }, [])).toBe('最迟复查日期：日历上没有这一天');
    expect(draftProblem({ ...full, owner: '' }, [])).toContain('负责人');
    expect(draftProblem({ ...full, owner: '   ' }, [])).toContain('负责人');
    expect(draftProblem(full, ['claude-solo'])).toContain('已经有一条暂停');
  });
});

describe('拼要存的整份值', () => {
  test('新建带上已有的、去掉现算的字段；撤回只去掉那一个；续期只改那个池的复查日期', () => {
    const holds = [fact('a'), fact('b')];
    const created = withHold(holds, full);
    expect(Object.keys(created)).toEqual(['a', 'b', 'claude-solo']);
    expect(created.a).toEqual({
      reason: 'r',
      decidedBy: 'd',
      revokeWhen: 'w',
      reviewBy: '2026-10-30',
      owner: '指挥官',
    });
    expect(Object.keys(withoutHold(holds, 'a'))).toEqual(['b']);
    expect(withReviewBy(holds, 'b', '2027-01-01').b?.reviewBy).toBe('2027-01-01');
    expect(withReviewBy(holds, 'b', '2027-01-01').a?.reviewBy).toBe('2026-10-30');
    expect(withOwner(holds, 'a', '张三').a?.owner).toBe('张三');
    expect(withOwner(holds, 'a', '张三').b?.owner).toBe('指挥官');
  });
});
