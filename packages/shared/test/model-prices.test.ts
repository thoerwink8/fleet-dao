// 按模型目录的单价估花费（驾驶舱改版 2026-10-07：「每个环节花费测不出来」）：执行体没报花费的一笔按 token × 单价估，
// 页面标「估算」；没有单价写「没有单价」、token 没读全写「估不了」，都不拿 0 顶。报了花费的照用报的，不另估。
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import {
  estimateCostUsd,
  MODEL_PRICES,
  type ModelPrice,
  modelPriceOf,
  NO_PRICE_MODELS,
  noPriceReasonOf,
} from '../src/model-prices.ts';
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
    const got = estimateCostUsd(FULL, 'no-such-model', undefined);
    expect(got).toEqual({ kind: 'noPrice', why: '模型目录里没有「no-such-model」的单价' });
    expect(got).not.toHaveProperty('usd');
  });

  it('【故意造出的失败】目录里明确写了没有按 token 单价的模型（Cursor Auto）：noPrice，写明原因，不给 0', () => {
    const got = estimateCostUsd(FULL, 'cursor-auto', modelPriceOf('cursor-auto'));
    expect(got.kind).toBe('noPrice');
    expect(got).toMatchObject({ why: expect.stringContaining('按每次实际路由到的那个模型的标价计费') });
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
    expect(modelPriceOf('cursor-auto')).toBeUndefined();
    // 验收默认模型 GPT 6 sol：沿用原先查到的价（输入 2、缓存输入 0.1、输出 10），不是第三方汇总
    expect(modelPriceOf('gpt-6-sol')).toMatchObject({
      inputPerMTok: 2,
      cacheReadPerMTok: 0.1,
      outputPerMTok: 10,
      source: 'https://developers.openai.com/api/docs/models/gpt-6-sol',
    });
    expect(modelPriceOf('gpt-6.1-sol')).toBeUndefined();
    expect(modelPriceOf('toString')).toBeUndefined();
    expect(noPriceReasonOf('toString')).toBeUndefined();
  });

  it('每一项的出处是官方页，不是第三方汇总（Grok 4.7 换成 xAI 官方页）', () => {
    const officialHosts = [
      'platform.claude.com',
      'developers.openai.com',
      'docs.x.ai',
      'platform.kimi.ai',
      'api-docs.deepseek.com',
      'docs.z.ai',
      'cursor.com',
    ];
    for (const [id, p] of Object.entries({ ...MODEL_PRICES, ...NO_PRICE_MODELS })) {
      const source = 'source' in p ? p.source : undefined;
      if (source === undefined) continue; // 没有官方页的（NO_PRICE_MODELS 里写「查不到官方价」的）不带出处
      expect(officialHosts, id).toContain(new URL(source).host);
    }
    expect(MODEL_PRICES['grok-4.7']?.source).toBe('https://docs.x.ai/developers/models');
    expect(MODEL_PRICES['grok-4.7']?.note).not.toContain('第三方');
  });

  it('新补的四家照官方页抄的数（输入 / 输出 / 缓存读 / 缓存写，美元每百万 token）', () => {
    const row = (id: string) => {
      const p = MODEL_PRICES[id];
      return p && [p.inputPerMTok, p.outputPerMTok, p.cacheReadPerMTok, p.cacheWritePerMTok];
    };
    expect(row('grok-4.7')).toEqual([2, 6, 0.5, 2]);
    expect(row('kimi-k3')).toEqual([3, 15, 0.3, 3]);
    expect(row('deepseek-flash')).toEqual([0.3, 1.2, 0.006, 0.3]);
    expect(row('glm-5.3-flash')).toEqual([0.15, 0.5, 0.03, 0.15]);
  });

  it('没有单价的项带原因和查价日期；原因写明白，不是空话', () => {
    for (const [id, n] of Object.entries(NO_PRICE_MODELS)) {
      expect(n.reason.length, id).toBeGreaterThan(10);
      expect(n.checkedAt, id).toMatch(/^\d{4}-\d{2}-\d{2}$/);
      expect(n.source === undefined || n.source.startsWith('https://'), id).toBe(true);
    }
  });
});

/** 模型目录（装进库的默认骨架）里会被派去跑三段会话的模型 id：出现在 judge 以外的用途里的（judge 只答判断题，不进三段流水）。 */
function catalogModelIds(): string[] {
  const raw = JSON.parse(readFileSync(new URL('../../db/routing.default.json', import.meta.url), 'utf8')) as {
    purposes?: Record<string, string[]>;
    models?: Record<string, unknown>;
  };
  if (!raw.models || Object.keys(raw.models).length === 0)
    throw new Error('routing.default.json 里读不到 models');
  if (!raw.purposes) throw new Error('routing.default.json 里读不到 purposes');
  const dispatched = new Set(
    Object.entries(raw.purposes)
      .filter(([purpose]) => purpose !== 'judge')
      .flatMap(([, ids]) => ids),
  );
  const ids = Object.keys(raw.models).filter((id) => dispatched.has(id));
  if (ids.length === 0) throw new Error('routing.default.json 里没有被派活的模型');
  return ids;
}

/** 目录里既没有单价、也没写「没有单价的原因」的模型；一个模型两边都写了也算错（说不清到底有没有价）。 */
function modelsWithoutPriceEntry(ids: readonly string[]): string[] {
  return ids.filter((id) => {
    const priced = modelPriceOf(id) !== undefined;
    const reasoned = noPriceReasonOf(id) !== undefined;
    return priced === reasoned;
  });
}

describe('单价表对得上模型目录', () => {
  it('目录里每个模型在单价表里都有一项：有价，或明确写了没有单价的原因', () => {
    const ids = catalogModelIds();
    // 只答判断题的 judge 模型不进三段流水，不要求有单价；被派活的模型一个不少
    expect(ids).not.toContain('jev-1.13');
    expect(ids).toEqual(expect.arrayContaining(['opus-5.5', 'kimi-k3', 'cursor-auto']));
    expect(modelsWithoutPriceEntry(ids)).toEqual([]);
  });

  it('目录配置（deploy/catalog.json）里的每个模型（除只答判断题的 Jev）也都有一项：有价，或写明没有单价的原因', () => {
    const catalog = JSON.parse(
      readFileSync(new URL('../../../deploy/catalog.json', import.meta.url), 'utf8'),
    ) as { models?: { id: string }[] };
    if (!catalog.models?.length) throw new Error('deploy/catalog.json 里读不到 models');
    const ids = catalog.models.map((m) => m.id).filter((id) => id !== 'jev-1.13');
    expect(ids).toEqual(expect.arrayContaining(['gpt-6-sol', 'glm-5.3', 'haiku-4.5', 'grok-4.6']));
    expect(modelsWithoutPriceEntry(ids)).toEqual([]);
  });

  it('【故意造出的失败】目录新加了模型、没补单价：这里红，点名是哪个', () => {
    expect(modelsWithoutPriceEntry([...catalogModelIds(), 'new-model-9'])).toEqual(['new-model-9']);
  });

  it('同一个模型不会既有单价又写没有单价的原因（说不清到底有没有价）', () => {
    expect(Object.keys(NO_PRICE_MODELS).filter((id) => id in MODEL_PRICES)).toEqual([]);
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
