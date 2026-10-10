import { describe, expect, it } from 'vitest';
import type { PlanIssue } from '../src/github-api.ts';
import {
  checkLedger,
  countGeneral,
  countRepo,
  type Ledger,
  parseLedger,
  renderSlimIssue,
  SLIM_TITLE,
  slimDue,
  slimRun,
} from '../src/rules-budget.ts';

const ledger = (over: Partial<Ledger['general']> = {}, repo: Partial<Ledger['repo']> = {}): Ledger => ({
  threshold: { general: 150, repo: 300 },
  general: { chars: 1000, baseline: 1000, log: [], ...over },
  repo: { chars: 2000, baseline: 2000, log: [], ...repo },
});
const counts = { general: 1000, repo: 2000 };

describe('字数账对账', () => {
  it('字数和账一致、明细对得上：不报', () => {
    expect(checkLedger(ledger(), counts)).toEqual([]);
    const l = ledger({ chars: 1040, log: [{ date: '2026-10-10', delta: 40, why: 'x', ref: '#1' }] });
    expect(checkLedger(l, { general: 1040, repo: 2000 })).toEqual([]);
  });

  it('【故意造出的失败】改了规矩没记账：红，并写清「+N 字、为什么」', () => {
    const p = checkLedger(ledger(), { general: 1013, repo: 2000 });
    expect(p).toHaveLength(1);
    expect(p[0]).toMatch(/通用段/);
    expect(p[0]).toMatch(/\+13 字/);
    expect(p[0]).toMatch(/为什么/);
  });

  it('【故意造出的失败】明细 delta 之和和 chars - baseline 对不上：红', () => {
    const l = ledger({ chars: 1040, log: [{ date: '2026-10-10', delta: 30, why: 'x', ref: '#1' }] });
    const p = checkLedger(l, { general: 1040, repo: 2000 });
    expect(p.join('\n')).toMatch(/明细/);
  });

  it('本仓段删字没记账也红（负数写 -N）', () => {
    expect(checkLedger(ledger(), { general: 1000, repo: 1990 }).join()).toMatch(/-10 字/);
  });
});

describe('瘦身判定', () => {
  it('【超阈值不红】累计增长超阈值：对账不报，判定「该瘦身」', () => {
    const l = ledger({ chars: 1200, log: [{ date: '2026-10-10', delta: 200, why: 'x', ref: '#1' }] });
    expect(checkLedger(l, { general: 1200, repo: 2000 })).toEqual([]);
    const due = slimDue(l);
    expect(due.map((d) => d.section)).toEqual(['general']);
    expect(due[0]).toMatchObject({ growth: 200, over: 50, threshold: 150 });
  });

  it('刚好等于阈值不算超；没增长不瘦身', () => {
    expect(slimDue(ledger({ chars: 1150, baseline: 1000 }))).toEqual([]);
    expect(slimDue(ledger())).toEqual([]);
  });

  it('单正文写现字数、baseline、超了多少和三条减法', () => {
    const body = renderSlimIssue(slimDue(ledger({ chars: 1200, baseline: 1000 })));
    for (const s of ['1200', '1000', '超了 50', '别处已有的', '钩子', '并一处', 'baseline'])
      expect(body).toContain(s);
  });
});

describe('解析', () => {
  it('认不出的账本明确报错', () => {
    expect(() => parseLedger('{}')).toThrow(/账本/);
    expect(() => parseLedger('不是 json')).toThrow(/账本/);
  });
  it('认不出标记/标题明确报错，不当 0 字', () => {
    expect(() => countGeneral('# 没有标记')).toThrow(/认不出通用段标记/);
    expect(() => countRepo('# 没有标题')).toThrow(/认不出「## 本仓」标题/);
    expect(countGeneral('a通用段 开始bcd通用段 结束')).toBe('通用段 开始bcd'.length);
  });
});

describe('定时开瘦身单', () => {
  const grown = ledger({ chars: 1200, baseline: 1000 });
  const mk = (open: Partial<PlanIssue>[] = []) => {
    const created: { title: string; body: string; labels: string[] }[] = [];
    return {
      created,
      gh: {
        openIssues: async () => open as PlanIssue[],
        createIssue: async (title: string, body: string, labels: string[]) => {
          created.push({ title, body, labels });
          return 99;
        },
      },
    };
  };

  it('超阈值且没开着的：开一张', async () => {
    const m = mk();
    const r = await slimRun(grown, m.gh);
    expect(r).toEqual({ kind: 'opened', number: 99 });
    expect(m.created).toHaveLength(1);
    expect(m.created[0]?.title).toBe(SLIM_TITLE);
  });

  it('已开着一张：不再开', async () => {
    const m = mk([{ number: 5, title: SLIM_TITLE, isPr: false }]);
    expect(await slimRun(grown, m.gh)).toEqual({ kind: 'already', number: 5 });
    expect(m.created).toEqual([]);
  });

  it('没超阈值：不开', async () => {
    const m = mk();
    expect(await slimRun(ledger(), m.gh)).toEqual({ kind: 'none' });
    expect(m.created).toEqual([]);
  });
});
