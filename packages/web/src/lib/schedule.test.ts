import { describe, expect, test } from 'vitest';
import type { JobView } from '../api/types';
import { everyText, outcomeText } from './schedule';

const base: JobView = {
  id: 'job-patrol',
  name: '巡检',
  schedule: '0 */6 * * *',
  expectEveryMinutes: 360,
  status: 'never',
};
const started = '2026-09-25T09:00:00Z';
const ended = '2026-09-25T09:01:00Z';

describe('「查了 0 个问题」和「这次没查成」分开写', () => {
  test('跑成了、查到 0 条', () => {
    expect(
      outcomeText({ ...base, lastRun: { startedAt: started, endedAt: ended, outcome: 'ok', found: 0 } }),
    ).toBe('跑成了 · 查了，0 个问题');
  });

  test('跑成了、查到几条', () => {
    expect(
      outcomeText({ ...base, lastRun: { startedAt: started, endedAt: ended, outcome: 'ok', found: 3 } }),
    ).toBe('跑成了 · 查到 3 条');
  });

  test('写了扫了几个就照说', () => {
    expect(
      outcomeText({
        ...base,
        lastRun: { startedAt: started, endedAt: ended, outcome: 'ok', scanned: 12, found: 0 },
      }),
    ).toBe('跑成了 · 扫了 12 个，0 个问题');
  });

  test('只查了一部分（partial）：写明没查成的原因，不当「全查过没事」', () => {
    expect(
      outcomeText({
        ...base,
        lastRun: {
          startedAt: started,
          endedAt: ended,
          outcome: 'partial',
          scanned: 12,
          found: 0,
          why: '3 个仓的分支列表没读到',
        },
      }),
    ).toBe('只查了一部分 · 扫了 12 个，查到 0 条：3 个仓的分支列表没读到');
    expect(
      outcomeText({ ...base, lastRun: { startedAt: started, endedAt: ended, outcome: 'partial' } }),
    ).toBe('只查了一部分：没查成的原因没记下');
  });

  test('跑了但一个都没扫到：是「没查成」，不是「没问题」', () => {
    expect(
      outcomeText({
        ...base,
        lastRun: { startedAt: started, endedAt: ended, outcome: 'unscanned', why: 'GitHub 接口限流' },
      }),
    ).toBe('没查成：GitHub 接口限流');
  });

  test('失败写明原因；原因没记下也照说', () => {
    expect(
      outcomeText({
        ...base,
        lastRun: { startedAt: started, endedAt: ended, outcome: 'failed', why: '连接超时' },
      }),
    ).toBe('失败：连接超时');
    expect(outcomeText({ ...base, lastRun: { startedAt: started, endedAt: ended, outcome: 'failed' } })).toBe(
      '失败：原因没记下',
    );
  });

  test('还在跑、从没跑过，都不写成「没问题」', () => {
    expect(outcomeText({ ...base, lastRun: { startedAt: started } })).toBe('正在跑');
    expect(outcomeText(base)).toBe('还没跑过');
  });
});

describe('期望间隔说成人话', () => {
  test('分钟、小时、天', () => {
    expect(everyText(15)).toBe('每 15 分钟');
    expect(everyText(360)).toBe('每 6 小时');
    expect(everyText(1440)).toBe('每 1 天');
    expect(everyText(90)).toBe('每 90 分钟');
  });
});
