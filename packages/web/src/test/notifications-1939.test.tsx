// @vitest-environment happy-dom
// 通知中心照路由页样板重做观感（#1939）：列表上面一块结论（待处理 N 条 / 几件要你拍几个卡住加一个状态 / 一行灰字规则，三行不折）；
// 一条通知的谁在处理、灰字一行都不折；送到了是灰字、没送到才是红标签；主操作在内容旁边（md 起右上）。
import { cleanup, screen, within } from '@testing-library/react';
import { afterEach, describe, expect, test } from 'vitest';
import { createMockApi } from '../api/mock/server';
import NotificationsPage from '../routes/notifications';
import { renderApp } from './harness';

afterEach(cleanup);

const rowOf = (title: string) => screen.getByText(title).closest('li[data-notice-row]') as HTMLElement;

describe('通知中心结论块（#1939）', () => {
  test('待处理里有：subtitle 写待处理数，结论短话加一个状态，灰字一行规则；三行都不折', async () => {
    renderApp(<NotificationsPage />, { api: createMockApi({ live: false }), route: '/notifications' });
    const hero = await screen.findByTestId('pending-rule');
    const title = hero.querySelector('h2') as HTMLElement;
    expect(title.className).toContain('text-title');
    // 假数据 n-10 是看门狗的卡（决定 0093 主页三块），算进卡住的；n-11、n-12 是带动作的要你拍（#2353）
    expect(title.textContent).toBe('待处理 9 条');
    const line = hero.querySelector('[data-hero-line]') as HTMLElement;
    expect(line.textContent).toContain('4 件要你拍，5 个卡住');
    expect(line.querySelector('[data-tone="human"]')?.textContent).toBe('等你拍板');
    const notes = hero.querySelector('[data-hero-notes]') as HTMLElement;
    expect(notes.textContent).toBe('要你拍的和卡住的，处理了就从这里消失。');
    // 一行不折：容器 nowrap、会变长的截断，整句在悬停里
    for (const el of [title, line]) expect(el.className).toContain('whitespace-nowrap');
    expect(notes.className).toContain('truncate');
    expect(notes.getAttribute('title')).toBe(notes.textContent);
  });

  test('「连已处理的一起看」里没有结论块：那时接口的计数含已处理的，不是待处理数', async () => {
    renderApp(<NotificationsPage />, {
      api: createMockApi({ live: false }),
      route: '/notifications?status=all',
    });
    await screen.findByText('等你点头：发布 v2.3');
    expect(screen.queryByTestId('pending-rule')).toBeNull();
  });
});

describe('一条通知的观感（#1939）', () => {
  test('谁在处理、灰字一行都不折；整句在悬停里', async () => {
    renderApp(<NotificationsPage />, { api: createMockApi({ live: false }), route: '/notifications' });
    await screen.findByText('#17 子任务 A 停滞 22 分钟');
    const row = rowOf('#17 子任务 A 停滞 22 分钟');
    const handling = within(row).getByTestId('alert-handling');
    expect(handling.className).toContain('whitespace-nowrap');
    expect(handling.getAttribute('title')).toContain('PR #16 在处理');
    const meta = row.querySelector('[data-row-meta]') as HTMLElement;
    expect(meta.className).toContain('whitespace-nowrap');
    expect(meta.textContent).toContain('分钟前');
  });

  test('送到了是一截灰字（不是标签）；没送到是红标签', async () => {
    renderApp(<NotificationsPage />, { api: createMockApi({ live: false }), route: '/notifications' });
    await screen.findByText('每小时对账没查成');
    const ok = rowOf('#17 子任务 A 停滞 22 分钟').querySelector('[data-delivery="ok"]');
    expect(ok?.textContent).toBe('飞书已送到');
    expect(ok?.hasAttribute('data-tone')).toBe(false);
    const failed = Array.from(rowOf('每小时对账没查成').querySelectorAll('[data-tone="fail"]')).find(
      (e) => e.textContent === '飞书没送到',
    );
    expect(failed).toBeTruthy();
  });

  test('主操作在内容旁边、从顶对齐（md 起右上，不在高卡片里垂直居中）；手机上两个按钮平分一行', async () => {
    renderApp(<NotificationsPage />, { api: createMockApi({ live: false }), route: '/notifications' });
    await screen.findByText('等你点头：发布 v2.3');
    const actions = rowOf('等你点头：发布 v2.3').querySelector('[data-notice-actions]') as HTMLElement;
    expect(actions.parentElement?.className).toContain('md:items-start');
    expect(actions.parentElement?.className).not.toContain('md:items-center');
    for (const b of within(actions).getAllByRole('button')) expect(b.className).toContain('max-md:flex-1');
  });
});
