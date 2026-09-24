// @vitest-environment happy-dom
import { cleanup, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, test } from 'vitest';
import type { QuotaWindowView } from '../api/types';
import { QuotaCell } from './quota';

afterEach(cleanup);

const NOW = Date.parse('2026-09-25T10:00:00Z');
const at = (min: number) => new Date(NOW + min * 60_000).toISOString();

function cell(w: Omit<QuotaWindowView, 'stale'> & { stale?: boolean }) {
  const { container } = render(<QuotaCell w={{ stale: false, ...w }} now={NOW} />);
  return container.firstElementChild as HTMLElement;
}

describe('额度格', () => {
  test('快清零还剩不少：高亮并提示先用它', () => {
    const el = cell({
      window: '5h',
      utilization: 0.18,
      resetsAt: at(38),
      reading: 'measured',
      readAt: at(-4),
    });
    expect(el.dataset.hot).toBe('true');
    expect(screen.getByText(/先用它/)).toBeTruthy();
    expect(screen.getByText('38 分钟后')).toBeTruthy();
  });

  test('离清零还早就不高亮', () => {
    const el = cell({
      window: '5h',
      utilization: 0.18,
      resetsAt: at(240),
      reading: 'measured',
      readAt: at(-4),
    });
    expect(el.dataset.hot).toBeUndefined();
  });

  test('读数过期（后端判的 stale）就不喊「先用它」：旧数不能当现值', () => {
    const el = cell({
      window: '5h',
      utilization: 0.18,
      resetsAt: at(38),
      reading: 'measured',
      readAt: at(-42),
      stale: true,
    });
    expect(el.dataset.hot).toBeUndefined();
    expect(el.dataset.stale).toBe('true');
    expect(screen.getByText('42 分钟前').parentElement?.className).toContain('text-st-stall');
  });

  test('用了九成以上：标「快用完」', () => {
    const el = cell({
      window: '7d',
      utilization: 0.93,
      resetsAt: at(3000),
      reading: 'measured',
      readAt: at(-4),
    });
    expect(el.dataset.full).toBe('true');
    expect(screen.getByText(/快用完了/)).toBeTruthy();
  });

  test('每个数都写明来源：估算的标「估算」，美元窗写金额', () => {
    cell({
      window: 'month_usd',
      used: 12.5,
      limit: 20,
      resetsAt: at(20_000),
      reading: 'estimated',
      readAt: at(-2),
    });
    expect(screen.getByText('估算')).toBeTruthy();
    expect(screen.getByText('$12.50')).toBeTruthy();
  });

  test('没读到清零时间就直说', () => {
    cell({ window: 'points', utilization: 0.4, reading: 'measured', readAt: at(-1) });
    expect(screen.getByText('清零时间没读到')).toBeTruthy();
  });
});
