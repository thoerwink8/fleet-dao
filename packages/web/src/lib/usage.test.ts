// 用量怎么说给人听（#216）：每条「没读到」的说法都故意造一次没读到的数据，看它怎么说——
// 读到的照数写，读到一部分写「不全」，全没读到写「没读到」，不写 0；还在跑的不算没读到。
import { summarizeUsage } from '@fleet-dao/shared';
import { describe, expect, test } from 'vitest';
import type { Run } from '../api/types';
import { formatUsd } from './format';
import { costParts, groupParts, reading, runUsage, tokenParts, workParts } from './usage';

const T0 = Date.parse('2026-09-27T01:00:00.000Z');
const at = (minutes: number) => new Date(T0 + minutes * 60_000).toISOString();

/** 一次结束了的会话：四样 token、花费都读到（Claude 订阅，套餐内）。 */
function run(over: Partial<Run> = {}): Run {
  return {
    id: 'run-1',
    stage: 'execute',
    routeId: 'r-opus',
    modelName: 'Opus 5.5',
    whyRoute: '写码阶段排第一',
    queuedAt: at(0),
    startedAt: at(1),
    endedAt: at(11),
    outcome: 'ok',
    inputTokens: 1000,
    outputTokens: 500,
    cacheReadTokens: 30_000,
    cacheWriteTokens: 2000,
    costUsd: 0.25,
    billing: 'subscription',
    ...over,
  };
}

function without(r: Run, ...keys: (keyof Run)[]): Run {
  const copy: Record<string, unknown> = { ...r };
  for (const k of keys) delete copy[k];
  return copy as Run;
}

describe('一项合计的读数', () => {
  test('没有结束的会话是「还没有数」，不是没读到；全读到、读到一部分、全没读到分开', () => {
    expect(reading(0, 0, 0)).toEqual({ kind: 'none' });
    expect(reading(1500, 0, 2)).toEqual({ kind: 'full', value: 1500 });
    expect(reading(1500, 1, 2)).toEqual({ kind: 'partial', value: 1500, missing: 1 });
    expect(reading(0, 2, 2)).toEqual({ kind: 'missing', missing: 2 });
  });
});

describe('一次会话的用量（会话时间线）', () => {
  test('和任务合计同一个算法：四样都读到时写当量，细账放悬停提示', () => {
    const u = runUsage(run());
    expect(u).toEqual(summarizeUsage([{ ...run(), model: 'r-opus', modelName: 'Opus 5.5' }]).total);
    expect(tokenParts(u)).toEqual([
      expect.objectContaining({ key: 'equivalent', label: '当量', value: '9,000' }),
    ]);
    expect(tokenParts(u)[0]?.title).toContain('缓存读 3.0 万');
  });

  test('缓存读写没存下来（老会话、兜底补写的结局）：token 照数写，缓存写明没读到、折不成当量', () => {
    const parts = tokenParts(runUsage(without(run(), 'cacheReadTokens', 'cacheWriteTokens')));
    expect(parts).toEqual([
      expect.objectContaining({ key: 'tokens', value: '1,500', unit: 'token' }),
      { key: 'cache', missing: '缓存没读到，折不成当量' },
    ]);
  });

  test('没交终帧就断了（一样都没读到）：一句「token 和缓存都没读到」，不写 0 token', () => {
    const blank = without(
      run({ outcome: 'failed' }),
      'inputTokens',
      'outputTokens',
      'cacheReadTokens',
      'cacheWriteTokens',
      'costUsd',
    );
    const u = runUsage(blank);
    expect(tokenParts(u)).toEqual([{ key: 'tokens', missing: 'token 和缓存都没读到' }]);
    expect(costParts(u)).toEqual([expect.objectContaining({ label: '套餐内', missing: '花费没读到' })]);
    expect(JSON.stringify([...tokenParts(u), ...costParts(u)])).not.toMatch(/"value":"(0|\$0\.00)"/);
  });

  test('输入、输出只读到一样：token 写没读到，读到的那一样不单写', () => {
    const parts = tokenParts(runUsage(without(run(), 'outputTokens')));
    expect(parts[0]).toEqual({ key: 'tokens', missing: 'token 没读到' });
  });

  test('还在跑：用量等它结束才有，一段都不写（不算没读到）', () => {
    const u = runUsage(without(run(), 'endedAt', 'outcome', 'inputTokens', 'outputTokens'));
    expect(u.running).toBe(1);
    expect([...tokenParts(u), ...costParts(u), ...workParts(u)]).toEqual([]);
  });

  test('时刻认不出、倒着：时长写没读到，不写 0 秒', () => {
    for (const bad of [run({ endedAt: '不是时刻' }), run({ startedAt: at(20), endedAt: at(11) })]) {
      expect(workParts(runUsage(bad))).toEqual([{ key: 'work', missing: '时刻认不出，时长没读到' }]);
    }
  });
});

describe('花费分清按量、套餐内、分不清', () => {
  test('套餐内读到的是折合价，写「套餐内折合」，不写成按量', () => {
    expect(costParts(runUsage(run()))).toEqual([
      expect.objectContaining({ key: 'subscription', label: '套餐内折合', value: '$0.25' }),
    ]);
  });

  test('只报 token 的渠道（cursor 走订阅）：写「套餐内 · 花费没读到」，不说没花钱', () => {
    const parts = costParts(runUsage(without(run({ routeId: 'r-cursor' }), 'costUsd')));
    expect(parts).toEqual([
      expect.objectContaining({ key: 'subscription', label: '套餐内', missing: '花费没读到' }),
    ]);
  });

  test('按量读到的是真花的钱；按量没报花费写「按量 · 花费没读到」', () => {
    expect(costParts(runUsage(run({ billing: 'metered', costUsd: 0.04 })))).toEqual([
      expect.objectContaining({ key: 'metered', label: '按量', value: '$0.04' }),
    ]);
    expect(costParts(runUsage(without(run({ billing: 'metered' }), 'costUsd')))).toEqual([
      expect.objectContaining({ key: 'metered', label: '按量', missing: '花费没读到' }),
    ]);
  });

  test('渠道查不到（没有计费方式）：写「分不清按量、套餐内」，不猜成套餐内；花费也没读到就只写「花费没读到」', () => {
    expect(costParts(runUsage(without(run(), 'billing')))).toEqual([
      expect.objectContaining({ key: 'unknown', value: '$0.25', unit: '（分不清按量、套餐内）' }),
    ]);
    expect(costParts(runUsage(without(run(), 'billing', 'costUsd')))).toEqual([
      expect.objectContaining({ key: 'unknown', missing: '花费没读到' }),
    ]);
  });

  test('一组里有读到有没读到：照数写读到的，另写「不全」几次', () => {
    const u = summarizeUsage([
      { ...run(), model: 'opus', modelName: 'Opus 5.5' },
      { ...without(run(), 'costUsd', 'cacheReadTokens'), model: 'opus', modelName: 'Opus 5.5' },
    ]).total;
    expect(costParts(u)).toEqual([
      expect.objectContaining({ key: 'subscription', value: '$0.25', incomplete: 1 }),
    ]);
    expect(tokenParts(u)).toEqual([
      expect.objectContaining({ key: 'equivalent', value: '9,000', incomplete: 1 }),
    ]);
    expect(groupParts(u).map((p) => p.key)).toEqual(['work', 'equivalent', 'subscription']);
  });
});

describe('美元的写法', () => {
  test('不到一分的多写两位、再小的写「<$0.0001」，都不四舍五入成 $0.00', () => {
    expect(formatUsd(0.0038)).toBe('$0.0038');
    expect(formatUsd(0.00004)).toBe('<$0.0001');
    expect(formatUsd(0.25)).toBe('$0.25');
    expect(formatUsd(0)).toBe('$0.00');
    expect(formatUsd(120)).toBe('$120');
  });
});
