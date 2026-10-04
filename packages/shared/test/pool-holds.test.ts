// 整池暂停的判法（#746）：读不到、认不出一律按暂停办，不当成能用；到期只标红，不撤；撤回、续期要写原因。
import { describe, expect, it } from 'vitest';
import {
  beijingDateOf,
  POOL_HOLDS_SETTING,
  PoolHoldSchema,
  poolHoldsView,
  resolvePoolHolds,
  reviewStatus,
  revocationProblem,
  SETTING_SCHEMAS,
} from '../src/index.ts';

const hold = (over: Record<string, unknown> = {}) => ({
  reason: '创始人要大用独享',
  decidedBy: '「法国暂时不用独享号」2026-09-27',
  revokeWhen: '创始人说可以用了',
  reviewBy: '2026-10-30',
  ...over,
});
const NOW = new Date('2026-10-05T04:00:00Z'); // 北京时间 2026-10-05 12:00

describe('开关的形状：缺一项写不进去', () => {
  it('四项齐全才过；每一项缺了、留空、多了不认识的字段、日期不是日历上的一天都不过', () => {
    expect(PoolHoldSchema.safeParse(hold()).success).toBe(true);
    for (const k of ['reason', 'decidedBy', 'revokeWhen', 'reviewBy']) {
      const without = { ...hold() } as Record<string, unknown>;
      delete without[k];
      expect(PoolHoldSchema.safeParse(without).success, `缺 ${k}`).toBe(false);
      expect(PoolHoldSchema.safeParse(hold({ [k]: '   ' })).success, `空白 ${k}`).toBe(false);
    }
    expect(PoolHoldSchema.safeParse(hold({ owner: '帅位' })).success).toBe(false);
    for (const bad of ['2026-02-30', '2026-13-01', '10/30', '2026-1-1', '明天']) {
      expect(PoolHoldSchema.safeParse(hold({ reviewBy: bad })).success, bad).toBe(false);
    }
  });

  it('设置页接口收的整份值：认得出的过、缺字段的拒收、空对象（全撤了）过', () => {
    const schema = SETTING_SCHEMAS[POOL_HOLDS_SETTING];
    expect(schema.safeParse({ 'claude-solo': hold() }).success).toBe(true);
    expect(schema.safeParse({}).success).toBe(true);
    expect(schema.safeParse({ 'claude-solo': hold({ revokeWhen: undefined }) }).success).toBe(false);
    expect(schema.safeParse(null).success).toBe(false);
    expect(schema.safeParse([]).success).toBe(false);
  });
});

describe('resolvePoolHolds：读不出按暂停办', () => {
  it('库里没有这一项 = 没有暂停；认得出的逐条列出', () => {
    expect(resolvePoolHolds(undefined, NOW)).toEqual({
      holds: [],
      problems: [],
      holdAll: false,
      heldPoolIds: [],
    });
    const f = resolvePoolHolds({ 'claude-solo': hold() }, NOW);
    expect(f.heldPoolIds).toEqual(['claude-solo']);
    expect(f.holds[0]).toMatchObject({ poolId: 'claude-solo', overdue: false, overdueDays: 0 });
  });

  it('【故意造出的失败】某个池那一项认不出（缺字段、日期假的、多字段）：这个池照样在暂停名单里，带原因；别的池不受影响', () => {
    const f = resolvePoolHolds(
      {
        a: hold(),
        b: hold({ reviewBy: undefined }),
        c: hold({ reviewBy: '2026-02-30' }),
        d: { ...hold(), extra: 1 },
      },
      NOW,
    );
    expect(f.heldPoolIds).toEqual(['a', 'b', 'c', 'd']);
    expect(f.holds.map((h) => h.poolId)).toEqual(['a']);
    expect(f.problems.map((p) => p.poolId)).toEqual(['b', 'c', 'd']);
    expect(f.problems[0]?.why).toContain('reviewBy');
    expect(f.holdAll).toBe(false);
  });

  it('【故意造出的失败】整份认不出（字符串、数组、null、数字）：所有池按暂停办（holdAll），不是没有暂停', () => {
    for (const bad of ['停', [], null, 7, true]) {
      const f = resolvePoolHolds(bad, NOW);
      expect(f.holdAll, JSON.stringify(bad)).toBe(true);
      expect(f.problems[0]).toMatchObject({ poolId: null });
      expect(f.holds).toEqual([]);
    }
  });
});

describe('到期：当天及以后标红，不自动撤', () => {
  it('北京日期按东八区算：UTC 还是 10-04 晚上 8 点半，北京已经是 10-05', () => {
    expect(beijingDateOf(new Date('2026-10-04T16:30:00Z'))).toBe('2026-10-05');
    expect(beijingDateOf(new Date('2026-10-04T15:59:00Z'))).toBe('2026-10-04');
  });

  it('复查日期当天算到期（0 天），之后几天算几天；前一天不算', () => {
    expect(reviewStatus('2026-10-06', NOW)).toEqual({ overdue: false, overdueDays: 0 });
    expect(reviewStatus('2026-10-05', NOW)).toEqual({ overdue: true, overdueDays: 0 });
    expect(reviewStatus('2026-10-01', NOW)).toEqual({ overdue: true, overdueDays: 4 });
    // 跨月跨年
    expect(reviewStatus('2025-12-31', new Date('2026-01-02T01:00:00Z'))).toEqual({
      overdue: true,
      overdueDays: 2,
    });
  });

  it('【故意造出的失败】到期没人复查：标 overdue，但还在暂停名单里（不自动撤）', () => {
    const f = resolvePoolHolds({ 'claude-solo': hold({ reviewBy: '2026-10-01' }) }, NOW);
    expect(f.holds[0]).toMatchObject({ overdue: true, overdueDays: 4 });
    expect(f.heldPoolIds).toEqual(['claude-solo']);
  });
});

describe('驾驶舱视图：旧提醒提示迁成开关，没读成不拿「没有」顶', () => {
  const alert = (poolId: string, over: Record<string, unknown> = {}) => ({
    dedupeKey: `pool-hold:${poolId}`,
    title: `账号池 ${poolId} 整池暂停：登录失效`,
    createdAt: '2026-10-01T00:00:00Z',
    ...over,
  });

  it('旧提醒列出来（已处理的、别的提醒不算）；这个池同时有开关就标 alsoSwitched', () => {
    const v = poolHoldsView(
      { value: { 'claude-solo': hold() }, version: 3 },
      {
        ok: true,
        alerts: [
          alert('claude-solo'),
          alert('claude-carpool'),
          alert('x', { resolvedAt: '2026-10-02T00:00:00Z' }),
          { dedupeKey: 'session-org:switch', title: '别的', createdAt: '2026-10-01T00:00:00Z' },
        ],
      },
      NOW,
    );
    expect(v.legacy.map((l) => [l.poolId, l.alsoSwitched])).toEqual([
      ['claude-solo', true],
      ['claude-carpool', false],
    ]);
    expect(v.version).toBe(3);
    expect(v.today).toBe('2026-10-05');
    expect(v.legacyProblem).toBeUndefined();
  });

  it('【故意造出的失败】旧提醒没读成：legacyProblem 写原因，legacy 为空但不冒充「没有」', () => {
    const v = poolHoldsView(undefined, { ok: false, why: '库连不上' }, NOW);
    expect(v.legacyProblem).toBe('库连不上');
    expect(v.legacy).toEqual([]);
    expect(v.version).toBe(0);
  });
});

describe('revocationProblem：撤回、续期必须写原因', () => {
  const before = { a: hold(), b: hold() };

  it('【故意造出的失败】撤掉一个池没写原因：拒；写了原因：过', () => {
    expect(revocationProblem(before, { a: hold() }, undefined)).toContain('b');
    expect(revocationProblem(before, { a: hold() }, '   ')).toContain('b');
    expect(revocationProblem(before, { a: hold() }, '创始人说可以用了')).toBeNull();
  });

  it('【故意造出的失败】改复查日期（续期）没写原因：拒；新建、没改动的不要原因', () => {
    expect(
      revocationProblem(before, { a: hold({ reviewBy: '2026-12-01' }), b: hold() }, undefined),
    ).toContain('a');
    expect(revocationProblem(before, { ...before, c: hold() }, undefined)).toBeNull();
    expect(revocationProblem(before, before, undefined)).toBeNull();
    expect(revocationProblem(undefined, { a: hold() }, undefined)).toBeNull();
    expect(revocationProblem(null, { a: hold() }, undefined)).toBeNull();
  });

  it('【故意造出的失败】改之前存着的值认不出（整份、某一项）：也要原因，不能悄悄换掉', () => {
    expect(revocationProblem('停', {}, undefined)).toContain('认不出');
    expect(revocationProblem({ a: hold({ reviewBy: undefined }) }, {}, undefined)).toContain('a');
    expect(revocationProblem({ a: hold({ reviewBy: undefined }) }, {}, '清掉坏项')).toBeNull();
  });
});
