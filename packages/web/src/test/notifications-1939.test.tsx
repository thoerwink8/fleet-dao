// @vitest-environment happy-dom
// 通知中心照路由页样板重做观感（#1939；#3533 改成左列表右详情）：卡头一个「待处理 N」，数字在级别页签上；
// 一条通知的谁在处理在详情里、整句在悬停里；送到了是灰字、没送到才是红标签（列表行和详情里都有）；「处理了」「打开」在详情底部。
import { cleanup, screen, within } from '@testing-library/react';
import { afterEach, describe, expect, test } from 'vitest';
import { createMockApi } from '../api/mock/server';
import NotificationsPage from '../routes/notifications';
import { renderApp } from './harness';
import { listRow, openNotice } from './notice-helpers';

afterEach(cleanup);

describe('通知中心结论块（#1939）', () => {
  test('待处理里有：卡头一个「待处理 N」标签，要你拍、卡住报警的数字在级别页签上', async () => {
    renderApp(<NotificationsPage />, { api: createMockApi({ live: false }), route: '/notifications' });
    const hero = await screen.findByTestId('pending-rule');
    // 假数据 n-10 是看门狗的卡（决定 0093 主页三块），算进卡住的；n-11、n-12 是带动作的要你拍（#2353）
    expect(hero.textContent).toBe('待处理 9');
    expect(screen.getByRole('tab', { name: /^要你拍 4$/ })).toBeTruthy();
    expect(screen.getByRole('tab', { name: /^卡住报警 5$/ })).toBeTruthy();
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
  test('谁在处理在详情里，整句在悬停里；列表行灰字写类型和多久前', async () => {
    renderApp(<NotificationsPage />, { api: createMockApi({ live: false }), route: '/notifications' });
    const title = '#17 子任务 A 停滞 22 分钟';
    const listed = await listRow(title);
    expect(listed.textContent).toContain('卡住报警');
    expect(listed.textContent).toContain('分钟前');
    const row = await openNotice(title);
    const handling = within(row).getByTestId('alert-handling');
    expect(handling.querySelector('[title*="PR #16 在处理"]')).toBeTruthy();
  });

  test('送到了是一截灰字（不是标签）；没送到是红标签', async () => {
    renderApp(<NotificationsPage />, { api: createMockApi({ live: false }), route: '/notifications' });
    await screen.findByText('每小时对账没查成');
    const ok = (await openNotice('#17 子任务 A 停滞 22 分钟')).querySelector('[data-delivery="ok"]');
    expect(ok?.textContent).toBe('飞书已送到');
    expect(ok?.hasAttribute('data-tone')).toBe(false);
    // 没送到：列表行上一个红标签，详情里红标签后面写试了几次
    const listed = await listRow('每小时对账没查成');
    expect(
      Array.from(listed.querySelectorAll('[data-tone="fail"]')).find((e) => e.textContent === '飞书没送到'),
    ).toBeTruthy();
    const detail = await openNotice('每小时对账没查成');
    expect(
      Array.from(detail.querySelectorAll('[data-tone="fail"]')).find((e) => e.textContent === '飞书没送到'),
    ).toBeTruthy();
    expect(detail.textContent).toContain('试了');
  });

  test('详情底部：卡住报警有「处理了」「打开」；要你拍的只有「打开」', async () => {
    renderApp(<NotificationsPage />, { api: createMockApi({ live: false }), route: '/notifications' });
    await screen.findByText('等你点头：发布 v2.3');
    const ask = within(await openNotice('等你点头：发布 v2.3'));
    expect(ask.queryByRole('button', { name: '处理了' })).toBeNull();
    expect(ask.getByRole('link', { name: '打开' })).toBeTruthy();
    const alert = within(await openNotice('#17 子任务 A 停滞 22 分钟'));
    expect(alert.getByRole('button', { name: '处理了' })).toBeTruthy();
    expect(alert.getByRole('link', { name: '打开' })).toBeTruthy();
  });
});
