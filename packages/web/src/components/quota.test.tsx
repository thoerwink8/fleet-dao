// @vitest-environment happy-dom
import { cleanup, render, screen, within } from '@testing-library/react';
import { afterEach, describe, expect, test } from 'vitest';
import { createMockApi } from '../api/mock/server';
import type { QuotaWindowView } from '../api/types';
import QuotaPage from '../routes/quota';
import { renderApp } from '../test/harness';
import { QuotaCell } from './quota';

afterEach(cleanup);

const NOW = Date.parse('2026-09-25T10:00:00Z');
const at = (min: number) => new Date(NOW + min * 60_000).toISOString();

function cell(
  w: Omit<QuotaWindowView, 'stale' | 'label' | 'unit' | 'source'> &
    Partial<Pick<QuotaWindowView, 'stale' | 'label' | 'unit' | 'source'>>,
) {
  const full: QuotaWindowView = {
    stale: false,
    label: w.window,
    unit: 'percent',
    source: 'claude-usage',
    ...w,
  };
  const { container } = render(<QuotaCell w={full} now={NOW} />);
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
    expect(screen.getByText('42 分钟前').parentElement?.className).toContain('text-ink-stall');
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
      unit: 'usd',
      used: 12.5,
      limit: 20,
      resetsAt: at(20_000),
      reading: 'estimated',
      readAt: at(-2),
    });
    expect(screen.getByText('估算')).toBeTruthy();
    expect(screen.getByText('$12.50')).toBeTruthy();
  });

  test('拼车 5 小时美元上限（#76）：写已用和上限的金额、清零时刻、实读，悬停看得到读法 reclaude-carpool', () => {
    cell({
      window: '5h',
      label: 'carpool_5h_usd',
      unit: 'usd',
      used: 3.2,
      limit: 10,
      utilization: 0.32,
      resetsAt: at(90),
      reading: 'measured',
      source: 'reclaude-carpool',
      readAt: at(-3),
    });
    expect(screen.getByText('$3.20')).toBeTruthy();
    expect(screen.getByText('/ $10.00', { exact: false })).toBeTruthy();
    expect(screen.getByText('1 小时 30 分后')).toBeTruthy();
    const badge = screen.getByText('实读').closest('[data-source]') as HTMLElement;
    expect(badge.dataset.source).toBe('reclaude-carpool');
    expect(badge.title).toContain('reclaude-carpool');
  });

  test('没读到清零时间就直说', () => {
    cell({ window: 'points', utilization: 0.4, reading: 'measured', readAt: at(-1) });
    expect(screen.getByText('清零时间没读到')).toBeTruthy();
  });

  test('估算窗口写「前算」，不写「前读」', () => {
    const el = cell({
      window: 'month_usd',
      unit: 'usd',
      used: 12.5,
      limit: 20,
      reading: 'estimated',
      readAt: at(-2),
    });
    expect(el.textContent).toContain('前算');
    expect(el.textContent).not.toContain('前读');
    expect(el.textContent).toContain('按本机用量估算');
  });

  test('实读窗口写「前读」', () => {
    const el = cell({
      window: '5h',
      utilization: 0.4,
      reading: 'measured',
      readAt: at(-4),
    });
    expect(el.textContent).toContain('前读');
  });
});

describe('额度页摘要卡', () => {
  function card(title: string): HTMLElement {
    const heading = screen.getByText(title);
    const box = heading.closest('div.rounded-xl');
    if (!box) throw new Error(`找不到摘要卡：${title}`);
    return box as HTMLElement;
  }

  test('名字换行显示池名和窗口名，悬停是全文，不再单行截断', async () => {
    renderApp(<QuotaPage />, { api: createMockApi({ live: false }) });
    await screen.findByText('先用它');
    const hot = card('先用它');
    const name = within(hot).getByTitle('Claude 订阅 · claude-b · 5 小时窗');
    expect(name.className).not.toContain('truncate');
    expect(name.className).toContain('break-words');
    expect(name.textContent).toContain('Claude 订阅 · claude-b');
    expect(name.textContent).toContain('5 小时窗');
    const full = card('快用完');
    for (const item of within(full).getAllByTitle(/·/)) {
      expect(item.className).not.toContain('truncate');
      expect(item.className).toContain('break-words');
    }
    const stale = card('读数过期或没查成');
    for (const item of within(stale).getAllByTitle(/·/)) {
      expect(item.className).not.toContain('truncate');
    }
  });

  test('过期摘要里的估算窗口写「前算」，不写「前读」', async () => {
    renderApp(<QuotaPage />, { api: createMockApi({ live: false }) });
    await screen.findByText('读数过期或没查成');
    const stale = card('读数过期或没查成');
    expect(stale.textContent).toContain('前算');
    expect(stale.textContent).not.toContain('前读');
  });
});

describe('额度页金额和窄表', () => {
  test('周期美元金额完整显示，金额元素不带省略号截断', async () => {
    renderApp(<QuotaPage />, { api: createMockApi({ live: false }) });
    const used = await screen.findByText('$61.20');
    const amount = used.parentElement;
    expect(amount).toBeTruthy();
    expect(amount?.className ?? '').not.toContain('truncate');
    expect(amount?.textContent).toContain('$61.20');
    expect(amount?.textContent).toContain('/ $100');
    const cell = used.closest('div.rounded-lg');
    expect(cell).toBeTruthy();
    const badge = within(cell as HTMLElement).getByText('实读');
    expect(badge.closest('[data-source]')?.getAttribute('data-source')).toBe('relay-web');
    // 别的池：月度美元仍是金额，估算标记还在；百分比窗不改成美元。
    const month = screen.getByText('$12.50');
    expect(month.parentElement?.className ?? '').not.toContain('truncate');
    expect(month.parentElement?.textContent).toContain('/ $20.00');
    expect(screen.getAllByText('估算').length).toBeGreaterThan(0);
    expect(screen.getAllByText('18%').length).toBeGreaterThan(0);
  });

  test('额度表可以横向滚动时，边上有「向右滑动」提示', async () => {
    renderApp(<QuotaPage />, { api: createMockApi({ live: false }) });
    await screen.findByRole('columnheader', { name: '周期美元' });
    const hint = screen.getByText('向右滑动，看其余窗口');
    const matrix = hint.closest('.quota-matrix');
    expect(matrix).toBeTruthy();
    expect(matrix?.querySelector('table')).toBeTruthy();
    expect(matrix?.querySelector('.quota-scroll-fade')).toBeTruthy();
  });
});

describe('窗口格子小标题', () => {
  test('按模型组的周窗写出模型名，小标题换行，不再截成省略号', () => {
    const el = cell({
      window: '7d_model',
      scope: 'opus',
      utilization: 0.4,
      resetsAt: at(3000),
      reading: 'measured',
      readAt: at(-4),
    });
    const title = within(el).getByText('周窗 · 单模型 · opus');
    expect(title.textContent).toBe('周窗 · 单模型 · opus');
    expect(title.className).not.toContain('truncate');
    expect(title.className).toContain('break-words');
    expect(title.getAttribute('title')).toBe('上游原名：7d_model');
  });

  test('没有 scope 的普通窗口不渲染小标题', () => {
    const el = cell({
      window: '5h',
      utilization: 0.4,
      resetsAt: at(120),
      reading: 'measured',
      readAt: at(-4),
    });
    expect(el.querySelector('[title^="上游原名"]')).toBeNull();
    expect(el.textContent).not.toContain('5 小时窗');
  });
});
