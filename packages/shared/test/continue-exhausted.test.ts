// 命令行和驾驶舱认引擎停住时写的那一句：继续次数用满（不再发）、总轮数到顶（#3603，要带原因才发）。
import { describe, expect, it } from 'vitest';
import { continueExhausted, continueNeedsReason, totalRoundsTitle } from '../src/continue-exhausted.ts';

describe('继续前认停住原因', () => {
  it('总轮数到顶：引擎写的标题（前面拼着原停下的标题）认得出，回带上限的提示', () => {
    const why = `动手 3 轮都没过；${totalRoundsTitle(6)}`;
    expect(why).toBe('动手 3 轮都没过；动手累计 6 轮仍没合，交还本机');
    expect(continueNeedsReason(why)).toContain('动手累计 6 轮仍没合');
    expect(continueNeedsReason(why)).toContain('要写明为什么');
    expect(continueNeedsReason(totalRoundsTitle(9))).toContain('9 轮');
  });

  it('别的停下不要原因；空、null 也不要', () => {
    expect(continueNeedsReason('动手 3 轮都没过')).toBeNull();
    expect(continueNeedsReason('已继续 3 次仍没过，交指挥官')).toBeNull();
    expect(continueNeedsReason('')).toBeNull();
    expect(continueNeedsReason(null)).toBeNull();
    expect(continueNeedsReason(undefined)).toBeNull();
  });

  it('继续次数用满照旧认得出，总轮数到顶不算用满', () => {
    expect(continueExhausted('已继续 3 次仍没过，交指挥官')).toBe(
      '继续次数已用满（3 次），继续无效；要重开用 redo',
    );
    expect(continueExhausted(totalRoundsTitle(6))).toBeNull();
  });
});
