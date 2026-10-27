// 收起时的一行摘要（#3707 批次 3，决定 0121 第四条）：每块写清「几项、有没有异常」。
// 读不到照实写「没读成」「在读」，不写成「没有」；没有东西时照实写「没有」。
import { describe, expect, test } from 'vitest';
import { moreSummary } from '../france-more';
import type { RunRow, ShippedRow } from './today';
import { alarmSummary, askSummary, runSummary, shippedSummary } from './today-blocks';

const NOW = Date.parse('2026-10-17T03:00:00.000Z');

const row = (tone: RunRow['tone']): RunRow => ({
  key: `k-${tone}`,
  what: '一张单',
  who: '法国引擎',
  progress: '1/3',
  tone,
  stuck: '没卡',
  source: 'engine',
});

const shipped = (what: string | null, at: string): ShippedRow => ({
  key: at,
  what,
  whatWhy: null,
  short: 'abc1234',
  at,
  event: 'release',
  pr: null,
  carried: [],
  carriedKnown: true,
});

describe('要你拍的', () => {
  test('几件等你拍；没有就写没有', () => {
    expect(askSummary(0, false)).toBe('没有要你拍的');
    expect(askSummary(2, false)).toBe('2 件等你拍');
  });

  test('读不到写没读成、在读写在读，不写成没有', () => {
    expect(askSummary(undefined, false)).toBe('在读…');
    expect(askSummary(undefined, true)).toBe('没读成，展开看重试');
    // 读过一次、这次刷新失败：条数还留着，但照实说没读成
    expect(askSummary(2, true)).toBe('没读成，展开看重试');
  });
});

describe('在跑的任务', () => {
  test('几件在跑；都正常 / 有几件卡住或等你', () => {
    expect(runSummary([], 0)).toBe('现在没有在跑的单');
    expect(runSummary([row('run'), row('run')], 2)).toBe('2 件在跑 · 都正常');
    expect(runSummary([row('run'), row('fail')], 2)).toBe('2 件在跑 · 1 件卡住或等你');
    expect(runSummary([row('fail'), row('human')], 2)).toBe('2 件在跑 · 2 件卡住或等你');
  });
});

describe('卡住报警', () => {
  test('几件卡住；有没有没人接的、有没有谁在修没查成的', () => {
    expect(alarmSummary(0, false, 0, 0)).toBe('没有卡住报警');
    expect(alarmSummary(2, false, 0, 0)).toBe('2 件卡住');
    expect(alarmSummary(2, false, 1, 0)).toBe('2 件卡住 · 1 件还没人接');
    expect(alarmSummary(3, false, 1, 2)).toBe('3 件卡住 · 1 件还没人接 · 2 件谁在修没查成');
  });

  test('读不到写没读成、在读写在读，不写成没有', () => {
    expect(alarmSummary(undefined, false, 0, 0)).toBe('在读…');
    expect(alarmSummary(undefined, true, 0, 0)).toBe('没读成，展开看重试');
  });
});

describe('最近上线', () => {
  test('最近一版是什么、多久前；没有就写还没有', () => {
    expect(shippedSummary([], false, NOW)).toBe('还没有发布记录');
    expect(shippedSummary([shipped('修好登录', '2026-10-17T02:00:00.000Z')], false, NOW)).toBe(
      '最近一版 1 小时前：修好登录',
    );
  });

  test('标题没读到、整块没读成都照实写，不编', () => {
    expect(shippedSummary([shipped(null, '2026-10-17T02:00:00.000Z')], false, NOW)).toBe(
      '最近一版 1 小时前：标题没查成',
    );
    expect(shippedSummary([], true, NOW)).toBe('没读成，展开看重试');
  });
});

describe('法国的「更多」', () => {
  const jobs = (list: { lastRun?: { outcome: string } }[], extra: Record<string, unknown> = {}) =>
    ({ data: { jobs: list }, error: null, ...extra }) as never;

  test('几个定时任务、有没有失败，另有几个零散页入口', () => {
    expect(moreSummary(jobs([]))).toBe('没有定时任务 · 6 个入口');
    expect(moreSummary(jobs([{}, {}]))).toBe('定时任务 2 项，都正常 · 6 个入口');
    expect(moreSummary(jobs([{ lastRun: { outcome: 'failed' } }, {}]))).toBe(
      '定时任务 2 项，失败 1 · 6 个入口',
    );
  });

  test('读不到写没读到、在读写在读，不写成没有定时任务', () => {
    expect(moreSummary({ data: undefined, error: new Error('boom') } as never)).toBe(
      '定时任务没读到 · 6 个入口',
    );
    expect(moreSummary({ data: undefined, error: null } as never)).toBe('在读… · 6 个入口');
  });
});
