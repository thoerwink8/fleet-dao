// 按模型目录的单价估花费（驾驶舱改版 2026-10-07：「每个环节花费测不出来」）：执行体没报花费的一笔按 token × 单价估，
// 页面标「估算」；没有单价写「没有单价」、token 没读全写「估不了」，都不拿 0 顶。报了花费的照用报的，不另估。
import { describe, expect, it } from 'vitest';
import { estimateCostUsd, MODEL_PRICES, type ModelPrice, modelPriceOf } from '../src/model-prices.ts';
import { readSegmentRun, type SegmentRunFacts } from '../src/segment-runs.ts';
import { summarizeUsage } from '../src/usage.ts';

const PRICE: ModelPrice = {
  inputPerMTok: 2,
  outputPerMTok: 10,
  cacheReadPerMTok: 0.2,
  cacheWritePerMTok: 2.5,
  source: 'https://example.test/pricing',
  checkedAt: '2026-10-07',
};
const FULL = {
  inputTokens: 100_000,
  outputTokens: 20_000,
  cacheReadTokens: 1_000_000,
  cacheWriteTokens: 40_000,
};

describe('估一笔', () => {
  it('四样 token 都读到：输入 + 输出 + 缓存读 + 缓存写各乘单价相加（美元 / 百万 token）', () => {
    // 0.1×2 + 0.02×10 + 1×0.2 + 0.04×2.5 = 0.2 + 0.2 + 0.2 + 0.1
    expect(estimateCostUsd(FULL, 'm', PRICE)).toEqual({ kind: 'estimated', usd: 0.7 });
  });

  it('【故意造出的失败】目录里没有单价：noPrice，写明是哪个模型，不给 0', () => {
    const got = estimateCostUsd(FULL, 'kimi-k3', undefined);
    expect(got).toEqual({ kind: 'noPrice', why: '模型目录里没有「kimi-k3」的单价' });
    expect(got).not.toHaveProperty('usd');
  });

  it('【故意造出的失败】缓存读写没记到：noTokens 点名缺哪几样，不当成 0 算出一个偏小的数', () => {
    const got = estimateCostUsd({ inputTokens: 1, outputTokens: 1 }, 'm', PRICE);
    expect(got).toEqual({ kind: 'noTokens', why: '没读到缓存读、缓存写，估不了' });
  });

  it('目录里的每一项都带出处和查价日期；查不到的模型就是没有（不拿别家的价顶）', () => {
    for (const [id, p] of Object.entries(MODEL_PRICES)) {
      expect(p.source, id).toMatch(/^https:\/\//);
      expect(p.checkedAt, id).toMatch(/^\d{4}-\d{2}-\d{2}$/);
      expect(p.inputPerMTok, id).toBeGreaterThan(0);
    }
    expect(modelPriceOf('opus-5.5')).toBeDefined();
    // 验收默认模型 GPT 6.1 sol：官方模型页标的价（输入 2、缓存输入 0.1、输出 10），不是第三方汇总
    expect(modelPriceOf('gpt-6.1-sol')).toMatchObject({
      inputPerMTok: 2,
      cacheReadPerMTok: 0.1,
      outputPerMTok: 10,
      source: 'https://developers.openai.com/api/docs/models/gpt-6.1-sol',
    });
    expect(modelPriceOf('glm-5.3-flash')).toBeUndefined();
    expect(modelPriceOf('toString')).toBeUndefined();
  });
});

const run = (over: Partial<SegmentRunFacts>): SegmentRunFacts => ({
  id: 'r',
  segment: 'manual',
  model: 'm',
  modelName: 'M',
  tier: 'fast',
  startedAt: '2026-10-07T01:00:00Z',
  endedAt: '2026-10-07T01:10:00Z',
  outcome: 'done',
  matchedBy: 'task',
  ...FULL,
  ...over,
});
const ctx = { taskFinished: true, priceOf: (m: string) => (m === 'm' ? PRICE : undefined) };

describe('三段的一笔和合计', () => {
  it('没报花费的估一个；报了花费的不另估；在跑的、没起来的不估', () => {
    expect(readSegmentRun(run({}), ctx).estimate).toEqual({ kind: 'estimated', usd: 0.7 });
    expect(readSegmentRun(run({ costUsd: 1.5 }), ctx).estimate).toBeUndefined();
    expect(
      readSegmentRun(run({ endedAt: undefined, outcome: undefined }), { ...ctx, taskFinished: false })
        .estimate,
    ).toBeUndefined();
    const notStarted = run({
      outcome: 'spawn_failed',
      inputTokens: undefined,
      outputTokens: undefined,
      cacheReadTokens: undefined,
      cacheWriteTokens: undefined,
    });
    expect(readSegmentRun(notStarted, ctx).estimate).toBeUndefined();
  });

  it('合计按段、按模型分：估成了的几笔和钱、没有单价几笔、token 没读全几笔分开记；报了的照旧进 cost', () => {
    const views = [
      readSegmentRun(run({ id: 'a' }), ctx),
      readSegmentRun(run({ id: 'b', costUsd: 1.5, billing: 'metered' }), ctx),
      readSegmentRun(run({ id: 'c', model: 'kimi-k3', modelName: 'Kimi' }), ctx),
      readSegmentRun(run({ id: 'd', segment: 'verify', tier: undefined, cacheWriteTokens: undefined }), ctx),
    ];
    const u = summarizeUsage([], views);
    expect(u.total.estimate).toEqual({ runs: 1, usd: 0.7, noPrice: 1, noTokens: 1 });
    expect(u.total.cost.metered.usd).toBe(1.5);
    const manual = u.bySegment.find((s) => s.segment === 'manual');
    expect(manual?.estimate).toEqual({ runs: 1, usd: 0.7, noPrice: 1, noTokens: 0 });
    expect(manual?.byModel.find((m) => m.model === 'kimi-k3')?.estimate).toEqual({
      runs: 0,
      usd: 0,
      noPrice: 1,
      noTokens: 0,
    });
    expect(u.bySegment.find((s) => s.segment === 'verify')?.estimate.noTokens).toBe(1);
  });

  it('老流程的会话不估（记的是路由编号、对不上目录）：没报花费照旧记「没读到」', () => {
    const u = summarizeUsage(
      [
        {
          stage: 'execute',
          queuedAt: '2026-10-07T00:59:00Z',
          startedAt: '2026-10-07T01:00:00Z',
          endedAt: '2026-10-07T01:10:00Z',
          model: 'm',
          modelName: 'M',
          ...FULL,
        },
      ],
      [],
    );
    expect(u.total.estimate).toEqual({ runs: 0, usd: 0, noPrice: 0, noTokens: 0 });
    expect(u.total.missingCost).toBe(1);
  });
});
