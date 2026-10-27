// @vitest-environment happy-dom
// 数据概览：额度和本期估算两格；本期估算读不到写「没记」，不显示 $0；额度不是正常时多一行说明。
import { cleanup, render } from '@testing-library/react';
import { afterEach, expect, test } from 'vitest';
import { Overview, overviewSummary, spendMoney } from './overview';
import type { HomeHealth, HomeSpend } from './types';

afterEach(cleanup);

const QUOTA: HomeHealth['quota'] = { state: 'ok', detail: '3 块池都在限度内' };

function line() {
  return document.querySelector('[data-spend-line]');
}

test('读不到：写没记，悬停给原因，不显示 $0', () => {
  const spend: HomeSpend = { estimated: { state: 'unread', why: '有会话没报花费，本期估算算不全' } };
  expect(spendMoney(spend)).toBe('没记');
  render(<Overview quota={QUOTA} spend={spend} />);
  const el = line();
  expect(el?.textContent).toContain('额度');
  expect(el?.textContent).toContain('正常');
  expect(el?.textContent).toContain('本期估算');
  const money = document.querySelector('[data-spend-money]');
  expect(money?.textContent).toBe('没记');
  expect(money?.getAttribute('title')).toBe('有会话没报花费，本期估算算不全');
  expect(el?.textContent).not.toMatch(/\$0/);
  // 额度正常不另写说明
  expect(document.body.textContent).not.toContain('3 块池都在限度内');
});

test('老后端没给花费、额度没查成：都不冒充正常或 0', () => {
  render(<Overview quota={{ state: 'unknown', detail: '额度一次都还没读成' }} spend={undefined} />);
  const el = line();
  expect(el?.textContent).toContain('没查成');
  expect(document.querySelector('[data-spend-money]')?.textContent).toBe('没记');
  expect(el?.textContent).not.toMatch(/\$0/);
  expect(document.body.textContent).toContain('额度：额度一次都还没读成');
});

test('读到了：写出估算；额度紧时标橙并写是哪些池', () => {
  const spend: HomeSpend = { estimated: { state: 'ok', usd: 12.4 } };
  render(<Overview quota={{ state: 'tight', detail: '中转站快清零' }} spend={spend} />);
  expect(document.querySelector('[data-spend-money]')?.textContent).toBe('$12.40');
  expect(document.querySelector('[data-stat][data-tone="stall"]')?.textContent).toContain('紧');
  expect(document.body.textContent).toContain('额度：中转站快清零');
});

// 收起时的一行摘要（#3707 批次 3）：额度状态 + 本期估算；读不到照实写，不写 0
test('收起摘要：额度状态和本期估算都写出来；读不到写没记，不写 $0', () => {
  expect(overviewSummary(QUOTA, { estimated: { state: 'ok', usd: 12.4 } })).toBe(
    '额度 正常 · 本期估算 $12.40',
  );
  expect(overviewSummary({ state: 'tight', detail: '中转站快清零' }, undefined)).toBe(
    '额度 紧 · 本期估算 没记',
  );
  expect(overviewSummary({ state: 'unknown', detail: '额度一次都还没读成' }, undefined)).toBe(
    '额度 没查成 · 本期估算 没记',
  );
});
