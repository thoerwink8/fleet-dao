// 独享这一类现在是什么状态（real/carpool-yield.ts 的 soloStateOf）：只有「清单读成了、独享列出了账号、一个明确 available 的都没有、
// 也没有读不到状态的」才算全封；其余读不到的一律 unknown，不动现状。
import { describe, expect, it } from 'vitest';
import type { AccountRoster, PoolAccount } from '../../src/jobs/org-accounts.ts';
import { soloStateOf } from '../../src/real/carpool-yield.ts';

const acc = (kind: 'carpool' | 'solo', status: PoolAccount['status'], i = 0): PoolAccount => ({
  id: `${kind}-${i}`,
  kind,
  status,
  why: status,
});
const roster = (accounts: PoolAccount[], readOk = true): AccountRoster => ({
  accounts,
  readOk,
  readWhy: readOk ? '' : '网断了',
});

describe('soloStateOf', () => {
  it('独享被封、到期都算不可用：全封', () => {
    expect(soloStateOf(roster([acc('carpool', 'available'), acc('solo', 'banned')])).state).toBe('down');
    expect(soloStateOf(roster([acc('carpool', 'available'), acc('solo', 'unavailable')])).state).toBe('down');
    expect(soloStateOf(roster([acc('solo', 'banned', 1), acc('solo', 'unavailable', 2)])).state).toBe('down');
  });

  it('独享有一个明确可用就是 up', () => {
    expect(soloStateOf(roster([acc('solo', 'banned', 1), acc('solo', 'available', 2)])).state).toBe('up');
  });

  it('读不到：清单没读成、独享有账号 unknown、独享一个账号都没列，都是 unknown', () => {
    expect(soloStateOf(roster([], false)).state).toBe('unknown');
    expect(soloStateOf(roster([acc('solo', 'unknown')], false)).state).toBe('unknown');
    expect(soloStateOf(roster([acc('solo', 'banned', 1), acc('solo', 'unknown', 2)])).state).toBe('unknown');
    expect(soloStateOf(roster([acc('carpool', 'available')])).state).toBe('unknown');
  });
});
