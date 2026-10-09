// @vitest-environment happy-dom
// 路由页刷新条：点「刷新」再读一遍该页主查询；读失败仍显示 LoadError（故意造出的失败放最后）。
import { cleanup, fireEvent, screen, waitFor } from '@testing-library/react';
import { afterEach, expect, test, vi } from 'vitest';
import { ApiError } from '../api/client';
import { createMockApi } from '../api/mock/server';
import RoutingPage from '../routes/routing';
import { renderApp } from './harness';

afterEach(cleanup);

test('点刷新按钮调用该页主查询的 refetch', async () => {
  const api = createMockApi({ live: false });
  const routingLayers = vi.spyOn(api, 'routingLayers');
  renderApp(<RoutingPage />, { api });

  const button = await screen.findByRole('button', { name: '刷新' });
  await waitFor(() => expect(button.hasAttribute('disabled')).toBe(false));
  expect(screen.getByText(/最后更新/)).toBeTruthy();
  expect(screen.queryByText('数据已过期')).toBeNull();

  const before = routingLayers.mock.calls.length;
  expect(before).toBeGreaterThan(0);
  fireEvent.click(button);
  await waitFor(() => expect(routingLayers.mock.calls.length).toBe(before + 1));
});

test('【故意造出的失败】路由两层没读成仍显示 LoadError', async () => {
  const api = createMockApi({ live: false });
  api.routingLayers = () => Promise.reject(new ApiError(500, 'internal', '后端出错了'));
  renderApp(<RoutingPage />, { api });

  const alert = await screen.findByRole('alert');
  expect(alert.textContent).toContain('路由两层没读成');
  expect(alert.textContent).toContain('后端出错了');
  expect(screen.queryByRole('navigation', { name: '用途' })).toBeNull();
});
