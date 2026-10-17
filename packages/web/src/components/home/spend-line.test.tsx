// @vitest-environment happy-dom
// 额度和钱一行：本期估算读不到写「没记」，不显示 $0。
import { cleanup, render } from '@testing-library/react';
import { afterEach, expect, test } from 'vitest';
import { SpendLine, spendMoney } from './spend-line';
import type { HomeHealth, HomeSpend } from './types';

afterEach(cleanup);

const QUOTA: HomeHealth['quota'] = { state: 'ok', detail: '3 块池都在限度内' };

function line() {
  return document.querySelector('[data-spend-line]');
}

test('读不到：写没记，不显示 $0', () => {
  const spend: HomeSpend = { estimated: { state: 'unread', why: '有会话没报花费，本期估算算不全' } };
  expect(spendMoney(spend)).toBe('没记');
  render(<SpendLine quota={QUOTA} spend={spend} />);
  const el = line();
  expect(el?.textContent).toContain('额度');
  expect(el?.textContent).toContain('正常');
  expect(el?.textContent).toContain('3 块池都在限度内');
  expect(el?.textContent).toContain('本期估算');
  expect(document.querySelector('[data-spend-money]')?.textContent).toBe('没记');
  expect(el?.textContent).not.toMatch(/\$0/);
});

test('老后端没给花费：同样写没记，不显示 $0', () => {
  render(<SpendLine quota={{ state: 'unknown', detail: '额度一次都还没读成' }} spend={undefined} />);
  const el = line();
  expect(el?.textContent).toContain('额度');
  expect(el?.textContent).toContain('没查成');
  expect(document.querySelector('[data-spend-money]')?.textContent).toBe('没记');
  expect(el?.textContent).not.toMatch(/\$0/);
});

test('读到了：写出估算，额度和钱仍在同一行', () => {
  const spend: HomeSpend = { estimated: { state: 'ok', usd: 12.4 } };
  render(<SpendLine quota={{ state: 'tight', detail: '中转站快清零' }} spend={spend} />);
  const el = line();
  expect(el?.textContent).toContain('额度');
  expect(el?.textContent).toContain('紧');
  expect(document.querySelector('[data-spend-money]')?.textContent).toBe('$12.40');
});
