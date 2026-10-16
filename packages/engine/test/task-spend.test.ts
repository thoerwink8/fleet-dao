// 单任务预算的折算（#2830）：taskSpend 活动把库里的四样原始 token 折成「折算 token」（缓存读乘 0.1，其余乘 1）。
// 折算只在活动里算；工作流判超没超读结果里的折算数，老结果没有这个字段就读原来的 tokens。
import { describe, expect, it } from 'vitest';
import { CACHE_READ_TOKEN_WEIGHT, DEFAULT_TASK_TOKEN_BUDGET } from '../src/limits.ts';
import { toTaskSpendResult } from '../src/task-spend.ts';

const M = 1_000_000;

const row = (over: Partial<Parameters<typeof toTaskSpendResult>[0]> = {}) => ({
  tokens: 0,
  runs: 1,
  unmetered: 0,
  estimated: 0,
  inputTokens: 0,
  outputTokens: 0,
  cacheReadTokens: 0,
  cacheWriteTokens: 0,
  ...over,
});

describe('toTaskSpendResult', () => {
  it('缓存读权重是 0.1；原始四样和合计原样带上，折算数只给缓存读打一折', () => {
    expect(CACHE_READ_TOKEN_WEIGHT).toBe(0.1);
    const r = toTaskSpendResult(
      row({
        tokens: 1000 + 500 + 30_000 + 2000,
        inputTokens: 1000,
        outputTokens: 500,
        cacheReadTokens: 30_000,
        cacheWriteTokens: 2000,
      }),
    );
    expect(r).toMatchObject({
      tokens: 33_500,
      inputTokens: 1000,
      outputTokens: 500,
      cacheReadTokens: 30_000,
      cacheWriteTokens: 2000,
      weighted: 6500,
      cacheReadWeight: 0.1,
    });
  });

  it('缓存读占大头（#2763 的形状：37.8M 里 36.8M 是缓存读）：折算后不超 37M 预算', () => {
    const r = toTaskSpendResult(
      row({
        tokens: 37_800_000,
        inputTokens: 600_000,
        outputTokens: 100_000,
        cacheReadTokens: 36_800_000,
        cacheWriteTokens: 300_000,
      }),
    );
    expect(r.tokens).toBeGreaterThan(DEFAULT_TASK_TOKEN_BUDGET);
    expect(r.weighted).toBe(600_000 + 100_000 + 300_000 + 3_680_000);
    expect(r.weighted ?? Number.POSITIVE_INFINITY).toBeLessThan(DEFAULT_TASK_TOKEN_BUDGET);
  });

  it('新输入占大头：折算后照旧超预算', () => {
    const r = toTaskSpendResult(
      row({ tokens: 38 * M, inputTokens: 36 * M, outputTokens: M, cacheReadTokens: M }),
    );
    expect(r.weighted ?? 0).toBeGreaterThan(DEFAULT_TASK_TOKEN_BUDGET);
  });

  it('估出来的下限按同一比例折：缓存读占大头的单，估的部分也跟着打折', () => {
    const r = toTaskSpendResult(
      row({ tokens: 10_000, estimated: 5000, inputTokens: 0, cacheReadTokens: 10_000, unmetered: 1 }),
    );
    expect(r).toMatchObject({ weighted: 1000, weightedEstimated: 500, estimated: 5000 });
  });

  it('什么都没花：折算是 0，估的也是 0，不除零', () => {
    expect(toTaskSpendResult(row())).toMatchObject({ weighted: 0, weightedEstimated: 0 });
  });
});
