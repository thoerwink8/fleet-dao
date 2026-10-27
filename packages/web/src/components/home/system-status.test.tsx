// 系统状态收起时的一行摘要（#3707 批次 3）：流水线一句、中转和引擎进程各一个状态词，有没有异常一眼看得出。
// 状态词从字典取（R20），判法和正文那一行一致；读不到写「没查到」这类原话，不写成正常。
import { expect, test } from 'vitest';
import { systemSummary } from './system-status';
import type { HomeHealth } from './types';

const NOW = Date.parse('2026-10-17T03:00:00.000Z');
const TWO_HOURS_AGO = '2026-10-17T01:00:00.000Z';

const OK: HomeHealth = {
  quota: { state: 'ok', detail: '3 块池都在限度内' },
  routes: { state: 'ok', detail: '都通' },
  engine: { state: 'on' },
};

test('都正常：流水线在走、中转通、引擎进程运行中', () => {
  expect(systemSummary(OK, { state: 'moving' }, NOW)).toBe('流水线 在走 · 中转 正常 · 引擎进程 运行中');
});

test('有异常照实写：卡在合并、中转有不通、引擎没连上', () => {
  const health: HomeHealth = {
    quota: { state: 'ok', detail: '' },
    routes: { state: 'degraded', detail: '一条渠道探测连续失败' },
    engine: { state: 'down', detail: '探不到在线的工人' },
  };
  const line = systemSummary(
    health,
    { state: 'stuck', step: '合并', who: '法国引擎', since: TWO_HOURS_AGO },
    NOW,
  );
  expect(line).toBe('流水线 卡在合并，法国引擎在修 2 小时 · 中转 有不通 · 引擎进程 没连上');
});

test('没查成不冒充正常：流水线、中转、引擎都没读到', () => {
  const health: HomeHealth = {
    quota: { state: 'ok', detail: '' },
    routes: { state: 'unknown', detail: '' },
    engine: { state: 'unknown' },
  };
  expect(systemSummary(health, undefined, NOW)).toBe('流水线 没查成 · 中转 没读到 · 引擎进程 没读到');
});

test('引擎按配置关着写「已停用」，不标红', () => {
  expect(systemSummary({ ...OK, engine: { state: 'off' } }, { state: 'moving' }, NOW)).toContain(
    '引擎进程 已停用',
  );
});
