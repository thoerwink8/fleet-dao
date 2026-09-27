// 会话用量的汇总：按模型、按阶段、整张合计，折成输入当量。每条「读不到」的路径都故意造一次：缺哪一样就记一次没读到，
// 不当成 0 加进合计。
import { describe, expect, it } from 'vitest';
import {
  INPUT_EQUIVALENT_WEIGHTS,
  inputEquivalentOf,
  type RunUsageFacts,
  summarizeUsage,
} from '../src/usage.ts';
import { TaskUsageSchema } from '../src/web-api.ts';

const T0 = Date.parse('2026-09-27T01:00:00.000Z');
const at = (minutes: number) => new Date(T0 + minutes * 60_000).toISOString();

/** 一次正常结束的会话：排队 1 分钟、干活 10 分钟，四样 token 都有、花费也有（Claude 订阅，套餐内）。 */
function run(over: Partial<RunUsageFacts> = {}): RunUsageFacts {
  return {
    model: 'opus-5.5',
    modelName: 'Opus 5.5',
    billing: 'subscription',
    stage: 'execute',
    queuedAt: at(0),
    startedAt: at(1),
    endedAt: at(11),
    inputTokens: 1000,
    outputTokens: 500,
    cacheReadTokens: 30_000,
    cacheWriteTokens: 2000,
    costUsd: 0.25,
    ...over,
  };
}

function without(r: RunUsageFacts, ...keys: (keyof RunUsageFacts)[]): RunUsageFacts {
  const copy: Record<string, unknown> = { ...r };
  for (const k of keys) delete copy[k];
  return copy as RunUsageFacts;
}

describe('输入当量', () => {
  it('按 design 第十节折：输入 1、缓存写 1.25、缓存读 0.1、输出 5', () => {
    expect(INPUT_EQUIVALENT_WEIGHTS).toEqual({ input: 1, cacheWrite: 1.25, cacheRead: 0.1, output: 5 });
    // 1000 + 2000×1.25 + 30000×0.1 + 500×5 = 1000 + 2500 + 3000 + 2500
    expect(
      inputEquivalentOf({
        inputTokens: 1000,
        cacheWriteTokens: 2000,
        cacheReadTokens: 30_000,
        outputTokens: 500,
      }),
    ).toBe(9000);
  });

  it('四舍五入到整数，不带浮点尾巴（cursor 真跑夹具的一轮：缓存读 19968）', () => {
    // 12715 + 0 + 1996.8 + 890 = 15601.8
    expect(
      inputEquivalentOf({
        inputTokens: 12715,
        outputTokens: 178,
        cacheReadTokens: 19968,
        cacheWriteTokens: 0,
      }),
    ).toBe(15602);
    // 恰好 .5 的往上进：0.1 × 15 = 1.5（浮点乘出来是 1.5000000000000002，按整数算不受影响）
    expect(
      inputEquivalentOf({ inputTokens: 0, outputTokens: 0, cacheReadTokens: 15, cacheWriteTokens: 0 }),
    ).toBe(2);
  });

  it('四样缺一样就折不成：回 undefined，不拿 0 顶', () => {
    const full = { inputTokens: 10, outputTokens: 10, cacheReadTokens: 10, cacheWriteTokens: 10 };
    for (const key of Object.keys(full) as (keyof typeof full)[]) {
      const { [key]: _gone, ...rest } = full;
      expect(inputEquivalentOf(rest), key).toBeUndefined();
    }
    expect(inputEquivalentOf({})).toBeUndefined();
  });

  it('认不出的数（负数、小数、NaN、无穷）当成没读到', () => {
    for (const bad of [-1, 1.5, Number.NaN, Number.POSITIVE_INFINITY]) {
      expect(
        inputEquivalentOf({ inputTokens: 10, outputTokens: 10, cacheReadTokens: bad, cacheWriteTokens: 0 }),
        String(bad),
      ).toBeUndefined();
    }
  });
});

describe('一张单按模型、按阶段、整张合计', () => {
  it('四样都读到的会话：token、当量、花费、排队和干活时长照加', () => {
    const u = summarizeUsage([run()]);
    expect(u.total).toEqual({
      runs: 1,
      running: 0,
      notStarted: 0,
      inputTokens: 1000,
      outputTokens: 500,
      missingTokens: 0,
      cacheReadTokens: 30_000,
      cacheWriteTokens: 2000,
      missingCache: 0,
      inputEquivalent: 9000,
      missingEquivalent: 0,
      costUsd: 0.25,
      missingCost: 0,
      cost: {
        metered: { runs: 0, usd: 0, missing: 0 },
        subscription: { runs: 1, usd: 0.25, missing: 0 },
        unknown: { runs: 0, usd: 0, missing: 0 },
      },
      queueMs: 60_000,
      runMs: 600_000,
      missingTime: 0,
    });
    // 后端按同一份定义校验返回：算出来的必须过得了
    expect(TaskUsageSchema.parse(u)).toEqual(u);
  });

  it('花费按计费方式分开加：按量是真花的钱，套餐内是折合价，没读到的各记各的', () => {
    const cursor = without(run({ model: 'cursor-auto', modelName: 'Cursor Auto' }), 'costUsd');
    const metered = run({ model: 'deepseek', modelName: 'DeepSeek', billing: 'metered', costUsd: 0.04 });
    const u = summarizeUsage([run(), cursor, metered]);
    expect(u.total.cost).toEqual({
      metered: { runs: 1, usd: 0.04, missing: 0 },
      subscription: { runs: 2, usd: 0.25, missing: 1 },
      unknown: { runs: 0, usd: 0, missing: 0 },
    });
    // 旧的两栏是三种的和
    expect(u.total).toMatchObject({ costUsd: 0.29, missingCost: 1 });
    expect(u.byModel.map((m) => [m.model, m.cost.metered.runs, m.cost.subscription.missing])).toEqual([
      ['opus-5.5', 0, 0],
      ['cursor-auto', 0, 1],
      ['deepseek', 1, 0],
    ]);
  });

  it('按量的会话没报花费：按量那一栏记没读到，不当成花了 $0', () => {
    const u = summarizeUsage([without(run({ billing: 'metered' }), 'costUsd')]);
    expect(u.total.cost.metered).toEqual({ runs: 1, usd: 0, missing: 1 });
    expect(u.total.missingCost).toBe(1);
  });

  it('渠道查不到（没给计费方式）、计费方式认不出：记进分不清，不猜成套餐内', () => {
    const lost = without(run(), 'billing');
    const odd = { ...run(), billing: 'prepaid' } as unknown as RunUsageFacts;
    const u = summarizeUsage([lost, odd, without(run(), 'billing', 'costUsd')]);
    expect(u.total.cost).toEqual({
      metered: { runs: 0, usd: 0, missing: 0 },
      subscription: { runs: 0, usd: 0, missing: 0 },
      unknown: { runs: 3, usd: 0.5, missing: 1 },
    });
  });

  it('各组的花费分开记账，互不串（每组一份新的空账）', () => {
    const u = summarizeUsage([run({ stage: 'plan' }), run({ stage: 'execute', billing: 'metered' })]);
    expect(u.byStage.map((s) => [s.stage, s.cost.subscription.runs, s.cost.metered.runs])).toEqual([
      ['plan', 1, 0],
      ['execute', 0, 1],
    ]);
    expect(u.total.cost.subscription.runs + u.total.cost.metered.runs).toBe(2);
  });

  it('只报 token 不报花费的渠道（cursor）：token 和当量照加，花费每次记没读到', () => {
    const cursor = without(run({ model: 'cursor-auto', modelName: 'Cursor Auto' }), 'costUsd');
    const u = summarizeUsage([cursor, cursor]);
    expect(u.byModel).toEqual([
      expect.objectContaining({
        model: 'cursor-auto',
        modelName: 'Cursor Auto',
        runs: 2,
        inputEquivalent: 18_000,
        missingEquivalent: 0,
        costUsd: 0,
        missingCost: 2,
      }),
    ]);
  });

  it('缓存读写没存下来的老会话：输入输出照加，缓存和当量记没读到，不当成 0 加进去', () => {
    const old = without(run(), 'cacheReadTokens', 'cacheWriteTokens');
    const u = summarizeUsage([old, run()]);
    expect(u.total).toMatchObject({
      runs: 2,
      inputTokens: 2000,
      outputTokens: 1000,
      missingTokens: 0,
      cacheReadTokens: 30_000,
      cacheWriteTokens: 2000,
      missingCache: 1,
      inputEquivalent: 9000,
      missingEquivalent: 1,
    });
  });

  it('缓存只读到一半（只有缓存读、没有缓存写）：整次记没读到，读到的那一半也不加', () => {
    const u = summarizeUsage([without(run(), 'cacheWriteTokens')]);
    expect(u.total).toMatchObject({
      cacheReadTokens: 0,
      cacheWriteTokens: 0,
      missingCache: 1,
      missingEquivalent: 1,
    });
  });

  it('终帧里一样用量都没有：token、缓存、当量、花费四项都记没读到', () => {
    const blank = without(
      run(),
      'inputTokens',
      'outputTokens',
      'cacheReadTokens',
      'cacheWriteTokens',
      'costUsd',
    );
    const u = summarizeUsage([blank]);
    expect(u.total).toMatchObject({
      runs: 1,
      inputTokens: 0,
      missingTokens: 1,
      missingCache: 1,
      inputEquivalent: 0,
      missingEquivalent: 1,
      missingCost: 1,
      missingTime: 0,
    });
  });

  it('输入、输出只读到一样：整次记没读到，不把读到的那一样单加进去', () => {
    const u = summarizeUsage([without(run(), 'outputTokens')]);
    expect(u.total).toMatchObject({
      inputTokens: 0,
      outputTokens: 0,
      missingTokens: 1,
      missingEquivalent: 1,
    });
  });

  it('进程没起来就结束的会话：记 notStarted，各项照记没读到；排队算到结束，干活按 0', () => {
    const never = without(
      run({ endedAt: at(3) }),
      'startedAt',
      'inputTokens',
      'outputTokens',
      'cacheReadTokens',
      'cacheWriteTokens',
      'costUsd',
    );
    const u = summarizeUsage([never]);
    expect(u.total).toMatchObject({
      runs: 1,
      notStarted: 1,
      missingTokens: 1,
      missingCache: 1,
      missingCost: 1,
      queueMs: 180_000,
      runMs: 0,
      missingTime: 0,
    });
  });

  it('还在跑的会话只记 running：用量还没出来，不进合计，也不算没读到', () => {
    const live = without(
      run(),
      'endedAt',
      'inputTokens',
      'outputTokens',
      'cacheReadTokens',
      'cacheWriteTokens',
    );
    const u = summarizeUsage([live, run()]);
    expect(u.total).toMatchObject({
      runs: 1,
      running: 1,
      missingTokens: 0,
      missingCache: 0,
      inputEquivalent: 9000,
    });
  });

  it('时刻认不出或倒着的：时长记没读到，不当成 0', () => {
    const u = summarizeUsage([
      run({ queuedAt: '不是时刻' }),
      run({ startedAt: at(20), endedAt: at(11) }),
      run({ endedAt: 'x' }),
    ]);
    expect(u.total).toMatchObject({ runs: 3, queueMs: 0, runMs: 0, missingTime: 3 });
  });

  it('花费认不出（负数、NaN）的记没读到', () => {
    const u = summarizeUsage([run({ costUsd: -0.1 }), run({ costUsd: Number.NaN }), run()]);
    expect(u.total).toMatchObject({ costUsd: 0.25, missingCost: 2 });
  });

  it('按模型、按阶段分组，按第一次出现的先后排', () => {
    const u = summarizeUsage([
      run({ stage: 'triage', model: 'sonnet-5', modelName: 'Sonnet 5' }),
      run({ stage: 'plan' }),
      run({ stage: 'execute' }),
      without(run({ stage: 'execute', model: 'cursor-auto', modelName: 'Cursor Auto' }), 'costUsd'),
    ]);
    expect(u.byModel.map((m) => [m.model, m.runs, m.missingCost])).toEqual([
      ['sonnet-5', 1, 0],
      ['opus-5.5', 2, 0],
      ['cursor-auto', 1, 1],
    ]);
    expect(u.byStage.map((s) => [s.stage, s.runs, s.inputEquivalent])).toEqual([
      ['triage', 1, 9000],
      ['plan', 1, 9000],
      ['execute', 2, 18_000],
    ]);
    expect(u.total).toMatchObject({ runs: 4, inputEquivalent: 36_000, costUsd: 0.75, missingCost: 1 });
  });

  it('一次会话都没有：合计全是 0 次，分组是空的', () => {
    expect(summarizeUsage([])).toEqual({
      total: expect.objectContaining({ runs: 0, running: 0, missingTokens: 0 }),
      byModel: [],
      byStage: [],
    });
  });
});
