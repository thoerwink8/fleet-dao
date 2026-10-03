// @vitest-environment happy-dom
// 通知中心每条提醒下面一行「谁在处理 · 链接 · 多久了」（design 15.3「谁在处理」）：后端现算，这里照着显示；
// 这一页算不出来（没接上、读不到）时照实写一句，不给每条编一个「没人在修」。
import { cleanup, screen, within } from '@testing-library/react';
import { afterEach, describe, expect, test } from 'vitest';
import { createMockApi } from '../api/mock/server';
import NotificationsPage from '../routes/notifications';
import { renderApp } from './harness';

afterEach(cleanup);

describe('通知中心：谁在处理', () => {
  test('PR 开着的写谁、跟进单的链接、多久了；没人在修的标出来', async () => {
    renderApp(<NotificationsPage />, { api: createMockApi({ live: false }) });
    const title = await screen.findByText('#17 子任务 A 停滞 22 分钟');
    const row = title.closest('li');
    if (!row) throw new Error('找不到这条提醒那一行');
    const handling = within(row).getByTestId('alert-handling');
    expect(within(handling).getByText('PR 开着')).toBeTruthy();
    // 「PR #16」页面上有两处：谁在处理那一格的文字、PR 的链接——都该在，所以按个数验，不用 getByText（命中多个会抛）。
    expect(within(handling).getAllByText('PR #16').length).toBe(2);
    expect(
      within(handling)
        .getByRole('link', { name: /PR #16/ })
        .getAttribute('href'),
    ).toBe('https://github.com/acme/orbit/pull/16');
    const link = within(handling).getByRole('link', { name: /acme\/orbit#17/ });
    expect(link.getAttribute('href')).toBe('https://github.com/acme/orbit/issues/17');
    expect(within(handling).getByText(/分钟/)).toBeTruthy();

    const other = (await screen.findByText('每小时对账没查成')).closest('li');
    if (!other) throw new Error('找不到这条提醒那一行');
    expect(within(within(other).getByTestId('alert-handling')).getByText('没人在修')).toBeTruthy();
  });

  test('【故意造出的失败】这一页谁在处理没算成：照实写一句，提醒照常列出、不编「没人在修」', async () => {
    const api = createMockApi({ live: false });
    const list = api.notifications;
    api.notifications = async (query) => {
      const page = await list(query);
      return {
        ...page,
        items: page.items.map(({ handling: _h, ...n }) => n),
        handlingProblem: '谁在处理没查成：statement timeout',
      };
    };
    renderApp(<NotificationsPage />, { api });
    expect(await screen.findByText(/谁在处理没查成：statement timeout/)).toBeTruthy();
    expect(screen.getByText('#17 子任务 A 停滞 22 分钟')).toBeTruthy();
    expect(screen.queryByTestId('alert-handling')).toBeNull();
    expect(screen.queryByText('没人在修')).toBeNull();
  });
});
