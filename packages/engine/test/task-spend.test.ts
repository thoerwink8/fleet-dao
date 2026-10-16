// 单任务预算按输入当量算（#2859）：taskSpend 活动把库里的四样原始 token 用 shared 的 inputEquivalentOf 折成输入当量。
// 当量只在活动里算；工作流判超没超读结果里的 inputEquivalent，老结果没有这个字段就读原来的数。
import { describe, expect, it } from 'vitest';
import { DEFAULT_TASK_TOKEN_BUDGET } from '../src/limits.ts';
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
  it('预算上限 700 万（输入当量的 p95），原始四样和合计原样带上，当量按输入 1、缓存写 1.25、缓存读 0.1、输出 5', () => {
    expect(DEFAULT_TASK_TOKEN_BUDGET).toBe(7_000_000);
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
      inputEquivalent: 1000 + 2500 + 3000 + 2500,
    });
    expect(r).not.toHaveProperty('weighted');
    expect(r).not.toHaveProperty('cacheReadWeight');
  });

  it('输入当量 650 万不停、750 万停', () => {
    const under = toTaskSpendResult(row({ tokens: 6_500_000, inputTokens: 6_500_000 }));
    const over = toTaskSpendResult(row({ tokens: 7_500_000, inputTokens: 7_500_000 }));
    expect(under.inputEquivalent ?? Number.POSITIVE_INFINITY).toBeLessThanOrEqual(DEFAULT_TASK_TOKEN_BUDGET);
    expect(over.inputEquivalent ?? 0).toBeGreaterThan(DEFAULT_TASK_TOKEN_BUDGET);
  });

  it('输出贵：输出占大头的单当量比原始合计大', () => {
    const r = toTaskSpendResult(row({ tokens: 2 * M, outputTokens: 2 * M }));
    expect(r.inputEquivalent).toBe(10 * M);
  });

  it('估出来的下限按同一比例折', () => {
    const r = toTaskSpendResult(
      row({ tokens: 10_000, estimated: 5000, inputTokens: 0, cacheReadTokens: 10_000, unmetered: 1 }),
    );
    expect(r).toMatchObject({ inputEquivalent: 1000, inputEquivalentEstimated: 500, estimated: 5000 });
  });

  it('什么都没花：当量是 0，估的也是 0，不除零', () => {
    expect(toTaskSpendResult(row())).toMatchObject({ inputEquivalent: 0, inputEquivalentEstimated: 0 });
  });

  it('某一样读不到（折不成）：不给 inputEquivalent，不拿 0 顶，工作流退回原来的数', () => {
    const r = toTaskSpendResult(row({ tokens: 100, inputTokens: Number.NaN }));
    expect(r.inputEquivalent).toBeUndefined();
    expect(r.inputEquivalentEstimated).toBeUndefined();
  });
});
