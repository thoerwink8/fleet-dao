// @vitest-environment happy-dom
// 通知中心筛选条：提醒没读成时四个数写「—」，不拿 0 冒充「没有提醒」；真的一条都没有才写 0。
// 全部/待处理视图里日报默认收成一行，点开展开；日报标签页直接铺开。
import { cleanup, fireEvent, screen, waitFor, within } from '@testing-library/react';
import { afterEach, describe, expect, test } from 'vitest';
import { ApiError } from '../api/client';
import { createMockApi } from '../api/mock/server';
import type { Notification } from '../api/types';
import { renderApp } from '../test/harness';
import NotificationsPage from './notifications';

afterEach(cleanup);

const LABELS = ['全部', '要你拍', '卡住报警', '日报'] as const;

/** 筛选按钮上的计数（「全部 5」这种名字里的那一截）。带 aria-pressed，别跟列表里「日报 N 条」折叠行混。 */
function countOf(label: string): string {
  const button = screen
    .getAllByRole('button', { name: new RegExp(`^${label}\\s`) })
    .find((b) => b.getAttribute('aria-pressed') != null);
  if (!button) throw new Error(`${label} 没有筛选按钮`);
  const num = button.querySelector('.num');
  if (!num) throw new Error(`${label} 没有计数`);
  return num.textContent ?? '';
}

/** 级别筛选条上的「日报」按钮（不是列表里的折叠行）。 */
function dailyTab(): HTMLElement {
  const button = screen
    .getAllByRole('button', { name: /^日报\s/ })
    .find((b) => b.getAttribute('aria-pressed') != null);
  if (!button) throw new Error('没有日报筛选按钮');
  return button;
}

const ONE: Notification = {
  id: 'n-x',
  level: 'decision',
  title: '等你拍一件',
  body: '有一件要拍。',
  createdAt: '2026-10-10T00:00:00.000Z',
  deliveries: [],
};

const MIXED: Notification[] = [
  {
    id: 'n-decision',
    level: 'decision',
    title: '等你拍：发不发版',
    body: '要拍一发。',
    createdAt: '2026-10-10T12:00:00.000Z',
    deliveries: [],
  },
  {
    id: 'n-daily-1',
    level: 'daily',
    title: '今日日报甲',
    body: '合并了几条。',
    createdAt: '2026-10-10T11:00:00.000Z',
    deliveries: [],
  },
  {
    id: 'n-alert',
    level: 'alert',
    title: '卡住：测试没过',
    body: '有任务挂了。',
    createdAt: '2026-10-10T10:00:00.000Z',
    deliveries: [],
  },
  {
    id: 'n-daily-2',
    level: 'daily',
    title: '今日日报乙',
    body: '额度还剩一点。',
    createdAt: '2026-10-10T09:00:00.000Z',
    deliveries: [],
  },
];

describe('通知中心筛选条计数', () => {
  test('读失败显示 — 且有重试', async () => {
    // 四个数仍写 0，或点重试不再请求，这一条会红。
    const api = createMockApi({ live: false });
    let calls = 0;
    let fail = true;
    api.notifications = () => {
      calls += 1;
      if (fail) return Promise.reject(new ApiError(500, 'internal', '后端出错了'));
      return Promise.resolve({ items: [ONE] });
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
    api.notifications = () => Promise.resolve({ items: [] });
    renderApp(<NotificationsPage />, { api });

    expect(await screen.findByText('没有待处理的提醒')).toBeTruthy();
    expect(screen.getByText('要你拍板或有东西卡住时，这里和飞书会同时提醒。')).toBeTruthy();
    for (const label of LABELS) expect(countOf(label)).toBe('0');
    expect(screen.queryByText('—')).toBeNull();
    expect(screen.queryByRole('alert')).toBeNull();
  });
});

describe('通知中心日报折叠', () => {
  test('全部视图里日报默认折叠、点开后展开、日报标签页直接展开', async () => {
    // 全部里仍把日报一条条铺开、折叠后标题还露着、或日报页还出「日报 N 条」，这一条会红。
    const api = createMockApi({ live: false });
    api.notifications = () => Promise.resolve({ items: MIXED });
    renderApp(<NotificationsPage />, { api });

    expect(await screen.findByText('等你拍：发不发版')).toBeTruthy();
    expect(screen.getByText('卡住：测试没过')).toBeTruthy();
    // 标签计数口径不变：全部 4、要你拍 1、卡住报警 1、日报 2。
    expect(countOf('全部')).toBe('4');
    expect(countOf('要你拍')).toBe('1');
    expect(countOf('卡住报警')).toBe('1');
    expect(countOf('日报')).toBe('2');

    const fold = screen.getByRole('button', { name: /日报\s*2\s*条/ });
    expect(fold.getAttribute('aria-expanded')).toBe('false');
    expect(screen.queryByText('今日日报甲')).toBeNull();
    expect(screen.queryByText('今日日报乙')).toBeNull();

    fireEvent.click(fold);
    expect(fold.getAttribute('aria-expanded')).toBe('true');
    expect(screen.getByText('今日日报甲')).toBeTruthy();
    expect(screen.getByText('今日日报乙')).toBeTruthy();

    fireEvent.click(dailyTab());
    await waitFor(() => expect(screen.queryByRole('button', { name: /日报\s*\d+\s*条/ })).toBeNull());
    expect(screen.getByText('今日日报甲')).toBeTruthy();
    expect(screen.getByText('今日日报乙')).toBeTruthy();
    expect(screen.queryByText('等你拍：发不发版')).toBeNull();
    expect(screen.queryByText('卡住：测试没过')).toBeNull();
    // 切到日报页后计数仍按当前列表（仍是同一份 open 结果）算。
    expect(countOf('全部')).toBe('4');
    expect(countOf('日报')).toBe('2');
  });

  test('待处理视图同样折叠日报，要你拍和卡住报警仍在列表里', async () => {
    const api = createMockApi({ live: false });
    api.notifications = () => Promise.resolve({ items: MIXED });
    renderApp(<NotificationsPage />, { api, route: '/notifications' });

    const pending = await screen.findByRole('tab', { name: '待处理' });
    expect(pending.getAttribute('aria-selected')).toBe('true');
    const fold = await screen.findByRole('button', { name: /日报\s*2\s*条/ });
    expect(fold.getAttribute('aria-expanded')).toBe('false');
    expect(screen.getByText('等你拍：发不发版')).toBeTruthy();
    expect(screen.getByText('卡住：测试没过')).toBeTruthy();
    // 折叠行在动作项之后：先看到要你拍/报警，再是日报折叠。
    const actionTitle = screen.getByText('卡住：测试没过');
    expect(fold.compareDocumentPosition(actionTitle) & Node.DOCUMENT_POSITION_PRECEDING).toBeTruthy();
    expect(within(fold).getByText('2')).toBeTruthy();
  });
});
