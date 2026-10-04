// 切之前逐个查账号状态（jobs/org-accounts.ts，创始人 2026-10-04 约 22:30 原话）：
// 「拼车切独享，需要考虑几个点，账号数量不固定；切之前检查每个账号状态，比如拼车被封了，或者独享被封了，账号池可用为 1 or 0
// 就不需要切了，如果为 0 渠道不可用」。0 个、1 个、多个；一个被封、全被封；读不到状态，每条分支各造一次。
import { describe, expect, it } from 'vitest';
import {
  type AccountRoster,
  type AccountStatus,
  type ApiOrgAccount,
  buildRoster,
  gateSwitch,
  judgeAccounts,
  type PoolAccount,
} from '../src/jobs/org-accounts.ts';

const NOW = new Date('2026-10-04T14:00:00.000Z');
const acct = (id: string, kind: 'carpool' | 'solo', status: AccountStatus = 'available'): PoolAccount => ({
  id,
  kind,
  status,
  why: `${id} ${status}`,
});
const roster = (accounts: PoolAccount[], readOk = true): AccountRoster => ({
  accounts,
  readOk,
  readWhy: readOk ? '' : '接口 503',
});

describe('账号数量不固定：按清单里实际有几个算，不写死一个拼车一个独享', () => {
  it('两个拼车 + 一个独享都可用：渠道正常，可用 3 个', () => {
    const v = judgeAccounts(roster([acct('c1', 'carpool'), acct('c2', 'carpool'), acct('s1', 'solo')]));
    expect(v.channel).toBe('ok');
    expect(v.availableCount).toBe(3);
    expect(v.byKind.carpool).toEqual({ total: 2, available: 2, unknown: 0 });
    expect(gateSwitch(v, 'carpool', 'solo')).toEqual({ ok: true });
  });

  it('一个拼车 + 三个独享：照样按实际个数', () => {
    const v = judgeAccounts(
      roster([acct('c1', 'carpool'), acct('s1', 'solo'), acct('s2', 'solo'), acct('s3', 'solo')]),
    );
    expect(v.availableCount).toBe(4);
    expect(v.byKind.solo.total).toBe(3);
  });
});

describe('可用数：多个、1 个、0 个', () => {
  it('拼车 1 个 + 独享 1 个都可用（正好 2 个）：有得选，能切', () => {
    const v = judgeAccounts(roster([acct('c1', 'carpool'), acct('s1', 'solo')]));
    expect(v.channel).toBe('ok');
    expect(gateSwitch(v, 'carpool', 'solo')).toEqual({ ok: true });
    expect(gateSwitch(v, 'solo', 'carpool')).toEqual({ ok: true });
  });

  it('【故意造出失败】独享被封、只剩拼车 1 个可用：不切，说明没得切，不静默', () => {
    const v = judgeAccounts(roster([acct('c1', 'carpool'), acct('s1', 'solo', 'banned')]));
    expect(v.channel).toBe('single');
    expect(v.availableCount).toBe(1);
    const gate = gateSwitch(v, 'carpool', 'solo');
    expect(gate).toMatchObject({ ok: false, kind: 'single' });
    expect(gate.ok ? '' : gate.why).toContain('没有可切的');
    expect(gate.ok ? '' : gate.why).toContain('独享账号被封');
  });

  it('【故意造出失败】拼车被封、只剩独享 1 个可用、当前还挂着拼车：不自动切，要人看（唯一可用的在另一边）', () => {
    const v = judgeAccounts(roster([acct('c1', 'carpool', 'banned'), acct('s1', 'solo')]));
    expect(v.channel).toBe('single');
    const gate = gateSwitch(v, 'carpool', 'solo');
    expect(gate).toMatchObject({ ok: false, kind: 'single' });
    expect(gate.ok ? '' : gate.why).toContain('要人看');
    expect(gate.ok ? '' : gate.why).toContain('拼车账号被封');
  });

  it('【故意造出失败】拼车、独享全被封（可用 0 个）：渠道不可用，不切', () => {
    const v = judgeAccounts(roster([acct('c1', 'carpool', 'banned'), acct('s1', 'solo', 'banned')]));
    expect(v.channel).toBe('unavailable');
    expect(v.availableCount).toBe(0);
    const gate = gateSwitch(v, 'carpool', 'solo');
    expect(gate).toMatchObject({ ok: false, kind: 'unavailable' });
    expect(gate.ok ? '' : gate.why).toContain('渠道不可用');
  });

  it('【故意造出失败】清单读成了、里面一个账号都没有（0 个账号）：渠道不可用', () => {
    const v = judgeAccounts(roster([]));
    expect(v.channel).toBe('unavailable');
    expect(v.availableCount).toBe(0);
  });

  it('到期、整池暂停也算不可用：和被封一样不数进可用', () => {
    const v = judgeAccounts(
      roster([acct('c1', 'carpool', 'unavailable'), acct('s1', 'solo', 'unavailable')]),
    );
    expect(v.channel).toBe('unavailable');
  });

  it('可用 ≥ 2 但切去的那一类里一个可用的都没有（两个拼车可用、独享被封）：不切，写明是目标那边没有', () => {
    const v = judgeAccounts(
      roster([acct('c1', 'carpool'), acct('c2', 'carpool'), acct('s1', 'solo', 'banned')]),
    );
    expect(v.channel).toBe('ok');
    const gate = gateSwitch(v, 'carpool', 'solo');
    expect(gate).toMatchObject({ ok: false, kind: 'no-target' });
    expect(gate.ok ? '' : gate.why).toContain('独享那边没有明确可用的账号');
  });
});

describe('【故意造出失败】读不到状态：不当成可用', () => {
  it('清单没读成、库里又没有池可猜：不是「0 个账号」，是 unknown，不切、不标渠道不可用', () => {
    const v = judgeAccounts({ accounts: [], readOk: false, readWhy: '接口 503' });
    expect(v.channel).toBe('unknown');
    const gate = gateSwitch(v, 'carpool', 'solo');
    expect(gate).toMatchObject({ ok: false, kind: 'unknown' });
    expect(gate.ok ? '' : gate.why).toContain('读不到账号状态');
  });

  it('两个账号都读不到状态：不当成可用，也不标渠道不可用', () => {
    const v = judgeAccounts(roster([acct('c1', 'carpool', 'unknown'), acct('s1', 'solo', 'unknown')], false));
    expect(v.channel).toBe('unknown');
    expect(v.availableCount).toBe(0);
  });

  it('一个明确可用、另一个读不到：分不清是 1 个还是 2 个，判 unknown，不切', () => {
    const v = judgeAccounts(roster([acct('c1', 'carpool'), acct('s1', 'solo', 'unknown')]));
    expect(v.channel).toBe('unknown');
    expect(gateSwitch(v, 'carpool', 'solo').ok).toBe(false);
  });

  it('已经有 2 个明确可用，再多一个读不到的：不影响，照常（不能因为多一个读不到的就整个停切）', () => {
    const v = judgeAccounts(
      roster([acct('c1', 'carpool'), acct('s1', 'solo'), acct('s2', 'solo', 'unknown')]),
    );
    expect(v.channel).toBe('ok');
    expect(gateSwitch(v, 'carpool', 'solo')).toEqual({ ok: true });
  });

  it('切去的那一类全读不到状态：不切（目标没有明确可用的）', () => {
    const v = judgeAccounts(
      roster([acct('c1', 'carpool'), acct('c2', 'carpool'), acct('s1', 'solo', 'unknown')]),
    );
    expect(v.channel).toBe('ok');
    expect(gateSwitch(v, 'carpool', 'solo')).toMatchObject({ ok: false, kind: 'no-target' });
  });
});

describe('buildRoster：接口的组织清单 + 整池暂停 → 账号清单', () => {
  const org = (
    id: string,
    kind: ApiOrgAccount['kind'],
    over: Partial<ApiOrgAccount> = {},
  ): ApiOrgAccount => ({
    id,
    kind,
    hasAssignedAccount: true,
    expiresAt: new Date(NOW.getTime() + 86_400_000),
    ...over,
  });
  const pools = [
    { poolId: 'claude-carpool', kind: 'carpool' as const, held: false },
    { poolId: 'claude-solo', kind: 'solo' as const, held: false },
  ];

  it('正常：每个组织一个账号，分到了账号、没到期 = 可用', () => {
    const r = buildRoster({
      api: { ok: true, accounts: [org('a', 'carpool'), org('b', 'solo')] },
      pools,
      now: NOW,
    });
    expect(r.readOk).toBe(true);
    expect(r.accounts.map((a) => a.status)).toEqual(['available', 'available']);
  });

  it('拼车组织没分到账号 = 被封；到期 = 不可用；回包没说分没分 = 读不到', () => {
    const r = buildRoster({
      api: {
        ok: true,
        accounts: [
          org('a', 'carpool', { hasAssignedAccount: false }),
          org('b', 'solo', { expiresAt: new Date(NOW.getTime() - 1) }),
          org('c', 'solo', { hasAssignedAccount: null }),
        ],
      },
      pools,
      now: NOW,
    });
    expect(r.accounts.map((a) => a.status)).toEqual(['banned', 'unavailable', 'unknown']);
  });

  it('没给到期日不算过期（只是少一条信息）', () => {
    const r = buildRoster({
      api: { ok: true, accounts: [org('a', 'solo', { expiresAt: null })] },
      pools,
      now: NOW,
    });
    expect(r.accounts[0]?.status).toBe('available');
  });

  it('这一类的池全部整池暂停着：这一类的账号都不可用；只暂停一部分池不算', () => {
    const held = buildRoster({
      api: { ok: true, accounts: [org('a', 'carpool'), org('b', 'solo')] },
      pools: [
        { poolId: 'claude-carpool', kind: 'carpool', held: false },
        { poolId: 'claude-solo', kind: 'solo', held: true },
      ],
      now: NOW,
    });
    expect(held.accounts.map((a) => a.status)).toEqual(['available', 'unavailable']);
    const some = buildRoster({
      api: { ok: true, accounts: [org('b', 'solo')] },
      pools: [
        { poolId: 'solo-1', kind: 'solo', held: true },
        { poolId: 'solo-2', kind: 'solo', held: false },
      ],
      now: NOW,
    });
    expect(some.accounts[0]?.status).toBe('available');
  });

  it('类型认不出的组织不数，也不当成可用', () => {
    const r = buildRoster({
      api: { ok: true, accounts: [org('a', 'other'), org('b', 'solo')] },
      pools,
      now: NOW,
    });
    expect(r.accounts).toHaveLength(1);
  });

  it('【故意造出失败】接口没读成：库里每个池变成一个读不到状态的账号，readOk=false 带原因，判出来是 unknown', () => {
    const r = buildRoster({ api: { ok: false, why: '网断' }, pools, now: NOW });
    expect(r.readOk).toBe(false);
    expect(r.readWhy).toBe('网断');
    expect(r.accounts.map((a) => a.status)).toEqual(['unknown', 'unknown']);
    expect(judgeAccounts(r).channel).toBe('unknown');
  });

  it('端到端：独享被封（没分到账号）、拼车正常 → 判出只剩 1 个可用，不切', () => {
    const r = buildRoster({
      api: { ok: true, accounts: [org('a', 'carpool'), org('b', 'solo', { hasAssignedAccount: false })] },
      pools,
      now: NOW,
    });
    const v = judgeAccounts(r);
    expect(v.channel).toBe('single');
    expect(gateSwitch(v, 'carpool', 'solo').ok).toBe(false);
  });
});
