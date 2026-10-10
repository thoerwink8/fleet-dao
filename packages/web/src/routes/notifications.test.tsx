// @vitest-environment happy-dom
// 通知中心筛选条：提醒没读成时四个数写「—」，不拿 0 冒充「没有提醒」；真的一条都没有才写 0。
import { cleanup, fireEvent, screen, waitFor } from '@testing-library/react';
import { afterEach, describe, expect, test } from 'vitest';
import { ApiError } from '../api/client';
import { createMockApi } from '../api/mock/server';
import type { Notification } from '../api/types';
import { SidebarNav } from '../components/shell/sidebar';
import { Topbar } from '../components/shell/topbar';
import { renderApp } from '../test/harness';
import NotificationsPage from './notifications';

afterEach(cleanup);

const LABELS = ['全部', '要你拍', '卡住报警', '日报'] as const;

/** 筛选按钮上的计数（「全部 5」这种名字里的那一截）。 */
function countOf(label: string): string {
  const button = screen.getByRole('button', { name: new RegExp(`^${label} `) });
  const num = button.querySelector('.num');
  if (!num) throw new Error(`${label} 没有计数`);
  return num.textContent ?? '';
}

const ONE: Notification = {
  id: 'n-x',
  level: 'decision',
  title: '等你拍一件',
  body: '有一件要拍。',
  createdAt: '2026-10-10T00:00:00.000Z',
  deliveries: [],
};

describe('通知中心筛选条计数', () => {
  test('读失败显示 — 且有重试', async () => {
    // 四个数仍写 0，或点重试不再请求，这一条会红。
    const api = createMockApi({ live: false });
    let calls = 0;
    let fail = true;
    api.notifications = () => {
      calls += 1;
      if (fail) return Promise.reject(new ApiError(500, 'internal', '后端出错了'));
      return Promise.resolve({ items: [ONE], counts: { decision: 1, alert: 0, daily: 0 } });
    };
    renderApp(<NotificationsPage />, { api });

    expect(await screen.findByRole('alert')).toBeTruthy();
    expect(screen.getByRole('alert').textContent).toContain('提醒没读成');
    expect(screen.getByRole('button', { name: '重试' })).toBeTruthy();
    for (const label of LABELS) expect(countOf(label)).toBe('—');
    expect(screen.queryByText('没有待处理的提醒')).toBeNull();

    const before = calls;
    fail = false;
    fireEvent.click(screen.getByRole('button', { name: '重试' }));
    await waitFor(() => expect(calls).toBeGreaterThan(before));
    await waitFor(() => expect(countOf('全部')).toBe('1'));
    expect(countOf('要你拍')).toBe('1');
    expect(countOf('卡住报警')).toBe('0');
    expect(countOf('日报')).toBe('0');
    expect(screen.queryByRole('alert')).toBeNull();
    expect(screen.getByText('等你拍一件')).toBeTruthy();
  });

  test('读成功无提醒显示 0', async () => {
    // 真的没有提醒时改成「—」，或空态文案变了，这一条会红。
    const api = createMockApi({ live: false });
    api.notifications = () => Promise.resolve({ items: [], counts: { decision: 0, alert: 0, daily: 0 } });
    renderApp(<NotificationsPage />, { api });

    expect(await screen.findByText('没有待处理的提醒')).toBeTruthy();
    expect(screen.getByText('要你拍板或有东西卡住时，这里和飞书会同时提醒。')).toBeTruthy();
    for (const label of LABELS) expect(countOf(label)).toBe('0');
    expect(screen.queryByText('—')).toBeNull();
    expect(screen.queryByRole('alert')).toBeNull();
  });
});

describe('通知数同一口径（#1745）', () => {
  /** 接口只取回前 2 条，但真实总数是 1 + 8 + 8 = 17。 */
  function truncatedApi() {
    const api = createMockApi({ live: false });
    const calls: number[] = [];
    api.notifications = (q) => {
      const limit = q?.limit ?? 0;
      calls.push(limit);
      const items = [ONE, { ...ONE, id: 'n-y', level: 'alert' as const, title: '卡住了' }].slice(0, limit);
      return Promise.resolve({
        items,
        nextCursor: 'more',
        counts: { decision: 1, alert: 8, daily: 8 },
      });
    };
    return { api, calls };
  }

  test('计数用接口总数，不拿这一页的条数封顶；待处理不含日报', async () => {
    // 计数改回数 items.length，会是 2 而不是 17，这一条会红。
    const { api } = truncatedApi();
    renderApp(<NotificationsPage />, { api });
    await waitFor(() => expect(countOf('全部')).toBe('17'));
    expect(countOf('要你拍')).toBe('1');
    expect(countOf('卡住报警')).toBe('8');
    expect(countOf('日报')).toBe('8');
    expect(screen.getByTestId('pending-rule').textContent).toContain('待处理 9 条');
    expect(screen.getByText(/只取回了最近/).textContent).toContain('共 17 条');
  });

  test('铃铛、侧栏角标、通知中心三处待处理同数，日报不算', async () => {
    // 任何一处改回数 items.length 或把日报算进去，这一条会红。
    const api = createMockApi({ live: false });
    api.notifications = () =>
      Promise.resolve({
        items: [ONE],
        nextCursor: 'more',
        counts: { decision: 1, alert: 8, daily: 8 },
      });
    renderApp(
      <>
        <Topbar onMenu={() => {}} onSearch={() => {}} />
        <SidebarNav />
        <NotificationsPage />
      </>,
      { api },
    );
    const bell = await screen.findByRole('button', { name: '提醒，9 条待处理' });
    expect(bell.textContent).toBe('9');
    const side = screen
      .getAllByRole('link')
      .find((a) => a.getAttribute('href')?.startsWith('/notifications'));
    expect(side?.textContent).toContain('9');
    await waitFor(() => expect(screen.getByTestId('pending-rule').textContent).toContain('待处理 9 条'));
    fireEvent.click(bell);
    expect((await screen.findByText('待处理的提醒')).parentElement?.textContent).toContain('9，另有日报 8');
  });

  test('只取了一部分时能往下翻：点「再多看」再要更多条', async () => {
    const { api, calls } = truncatedApi();
    renderApp(<NotificationsPage />, { api });
    const more = await screen.findByRole('button', { name: /再多看/ });
    const before = calls.length;
    fireEvent.click(more);
    await waitFor(() => expect(calls.length).toBeGreaterThan(before));
    expect(calls.at(-1)).toBeGreaterThan(calls[0] ?? 0);
  });
});
