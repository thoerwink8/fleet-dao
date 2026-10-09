// @vitest-environment happy-dom
// 通知中心接共用刷新条（#1449）：点「刷新」再读一遍该页主查询；读失败仍显示 LoadError。
import { cleanup, fireEvent, screen, waitFor } from '@testing-library/react';
import { afterEach, expect, test, vi } from 'vitest';
import { ApiError } from '../api/client';
import { createMockApi } from '../api/mock/server';
import NotificationsPage from '../routes/notifications';
import { renderApp } from './harness';

afterEach(cleanup);

test('点刷新按钮会调用该页主查询的 refetch', async () => {
  const api = createMockApi({ live: false });
  const notifications = vi.spyOn(api, 'notifications');
  const { qc } = renderApp(<NotificationsPage />, { api });
  const button = await screen.findByRole('button', { name: '刷新' });
  await waitFor(() => expect(button.hasAttribute('disabled')).toBe(false));
  const query = qc.getQueryCache().find({ queryKey: ['notifications', 'open'] });
  if (!query) throw new Error('通知页主查询不在缓存里');
  // useNotifications().refetch 走到这条 query.fetch，再进 api.notifications。
  const refetch = vi.spyOn(query, 'fetch');
  const calls = notifications.mock.calls.length;
  expect(calls).toBeGreaterThan(0);
  fireEvent.click(button);
  await waitFor(() => expect(refetch).toHaveBeenCalled());
  await waitFor(() => expect(notifications).toHaveBeenCalledTimes(calls + 1));
  expect(notifications).toHaveBeenLastCalledWith({ status: 'open', limit: 200 });
});

test('【故意造出的读失败】提醒没读成时仍显示 LoadError', async () => {
  const api = createMockApi({ live: false });
  api.notifications = () => Promise.reject(new ApiError(500, 'internal', '后端出错了'));
  renderApp(<NotificationsPage />, { api });
  const alert = await screen.findByRole('alert');
  expect(alert.textContent).toContain('提醒没读成');
  expect(alert.textContent).toContain('后端出错了');
});
