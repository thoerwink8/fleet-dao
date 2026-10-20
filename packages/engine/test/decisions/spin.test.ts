// 空转判断（#3294 第 2 片）：额度超预算判的是空转不是钱。有进展的不判空转；同一原因连着失败、没有新提交的判空转。
import { describe, expect, it } from 'vitest';
import {
  commandsIn,
  judgeSpin,
  reworkSimilarity,
  SPIN_WINDOW,
  type SpinRound,
} from '../../src/decisions/spin.ts';

const round = (over: Partial<SpinRound> = {}): SpinRound => ({
  outcome: 'ci_red',
  head: null,
  addedLines: 100,
  reworkSummary: null,
  ...over,
});

describe('judgeSpin：有进展的单不判空转', () => {
  it('每个回合都有新提交、失败原因在变：没有空转', () => {
    const got = judgeSpin([
      round({
        outcome: 'ci_red',
        head: 'a1'.repeat(20),
        addedLines: 120,
        reworkSummary: 'CI 红：类型检查报 3 处错误',
      }),
      round({
        outcome: 'verify_rejected',
        head: 'b2'.repeat(20),
        addedLines: 260,
        reworkSummary: '冷验收：缺少对拒绝分支的测试',
      }),
      round({
        outcome: 'ci_red',
        head: 'c3'.repeat(20),
        addedLines: 340,
        reworkSummary: '单元测试 park-triage 第 4 例没过',
      }),
    ]);
    expect(got.enough).toBe(true);
    expect(got.signals).toEqual([]);
    expect(got.spinning).toBe(false);
    expect(got.summary).toContain('没有空转');
  });

  it('单条信号不够判：连着两轮 CI 红，但每轮都有新提交、改动行数在变、意见不一样', () => {
    const got = judgeSpin([
      round({
        outcome: 'verify_rejected',
        head: 'a'.repeat(40),
        addedLines: 10,
        reworkSummary: '验收：缺测试',
      }),
      round({ outcome: 'ci_red', head: 'b'.repeat(40), addedLines: 20, reworkSummary: '类型错误一处' }),
      round({
        outcome: 'ci_red',
        head: 'c'.repeat(40),
        addedLines: 30,
        reworkSummary: '覆盖率不够，补测试之外还有格式问题',
      }),
    ]);
    expect(got.spinning).toBe(false);
  });
});

describe('judgeSpin：空转', () => {
  it('同一原因连续失败、没有新提交：判空转', () => {
    const got = judgeSpin([
      round({ outcome: 'ci_red', head: 'a'.repeat(40) }),
      round({ outcome: 'ci_red', head: 'a'.repeat(40) }),
      round({ outcome: 'ci_red', head: 'a'.repeat(40) }),
    ]);
    expect(got.spinning).toBe(true);
    expect(got.signals.map((s) => s.kind).sort()).toEqual(['no_new_commit', 'same_outcome']);
  });

  it('没提交收场连着三轮：既是同一原因、又没有新提交', () => {
    const got = judgeSpin([
      round({ outcome: 'no_commit' }),
      round({ outcome: 'no_commit' }),
      round({ outcome: 'no_commit' }),
    ]);
    expect(got.spinning).toBe(true);
  });

  it('改动行数不再变也算没有新提交（头没记时）', () => {
    const got = judgeSpin([
      round({ outcome: 'verify_rejected', addedLines: 88 }),
      round({ outcome: 'verify_rejected', addedLines: 88 }),
      round({ outcome: 'verify_rejected', addedLines: 88 }),
    ]);
    expect(got.signals.map((s) => s.kind)).toContain('no_new_commit');
    expect(got.spinning).toBe(true);
  });

  it('返工意见基本重复 + 同一个命令反复失败：判空转（即使行数在变）', () => {
    const cmd = '`pnpm check`';
    const got = judgeSpin([
      round({
        outcome: 'ci_red',
        addedLines: 10,
        reworkSummary: `${cmd} 失败：packages/engine/src/a.ts(12,3) 类型不对`,
      }),
      round({
        outcome: 'verify_rejected',
        addedLines: 20,
        reworkSummary: `${cmd} 失败：packages/engine/src/a.ts(14,3) 类型不对`,
      }),
      round({
        outcome: 'other',
        addedLines: 30,
        reworkSummary: `${cmd} 失败：packages/engine/src/a.ts(15,3) 类型不对`,
      }),
    ]);
    const kinds = got.signals.map((s) => s.kind);
    expect(kinds).toContain('duplicate_rework');
    expect(kinds).toContain('repeated_command');
    expect(got.spinning).toBe(true);
  });

  it('只看最近 SPIN_WINDOW 个回合：早先的空转不连累后来有进展的', () => {
    const stuck = round({ outcome: 'ci_red', head: 'a'.repeat(40) });
    const progressing = [
      round({ outcome: 'verify_rejected', head: 'b'.repeat(40), addedLines: 1, reworkSummary: '第一件事' }),
      round({ outcome: 'ci_red', head: 'c'.repeat(40), addedLines: 2, reworkSummary: '完全不同的第二件事' }),
      round({ outcome: 'leftover', head: 'd'.repeat(40), addedLines: 3, reworkSummary: '又换了一件' }),
    ];
    expect(judgeSpin([stuck, stuck, stuck, ...progressing]).spinning).toBe(false);
  });
});

describe('judgeSpin：数据不够不硬判', () => {
  it(`不足 ${SPIN_WINDOW} 个回合：enough=false、不判空转，由调用方决定怎么办`, () => {
    const got = judgeSpin([round(), round()]);
    expect(got.enough).toBe(false);
    expect(got.spinning).toBe(false);
  });
});

describe('零件', () => {
  it('reworkSimilarity：忽略提交号和数字，意见相同接近 1，不同接近 0；空的不算相似', () => {
    expect(
      reworkSimilarity('CI 红：第 12 行类型错误 deadbeef1', 'CI 红：第 99 行类型错误 cafebabe2'),
    ).toBeGreaterThan(0.8);
    expect(reworkSimilarity('缺少测试', '文档里的错别字需要订正')).toBeLessThan(0.3);
    expect(reworkSimilarity('', '')).toBe(0);
  });

  it('commandsIn：认反引号里和独占一行的命令', () => {
    expect(commandsIn('跑 `pnpm check` 红了\nnpx vitest run packages/a\n别的话')).toEqual([
      'pnpm check',
      'npx vitest run packages/a',
    ]);
  });

  it('commandsIn：反引号外也认常见命令，包括 git', () => {
    expect(commandsIn('git status 失败\nnode scripts/check.mjs 失败')).toEqual([
      'git status 失败',
      'node scripts/check.mjs 失败',
    ]);
  });
});
