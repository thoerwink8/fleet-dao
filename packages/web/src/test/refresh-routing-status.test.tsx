// @vitest-environment happy-dom
// 渠道状态页的刷新条：点「刷新」再读一遍该页主查询 useRouting；读失败仍显示 LoadError（故意造出的失败放最后）。
import { cleanup, fireEvent, screen, waitFor } from '@testing-library/react';
import { afterEach, expect, test, vi } from 'vitest';
import { ApiError } from '../api/client';
import { createMockApi } from '../api/mock/server';
import RoutingStatus from '../routes/routing-status';
import { renderApp } from './harness';

afterEach(cleanup);

test('点刷新按钮调用该页主查询的 refetch', async () => {
  const api = createMockApi({ live: false });
  const routing = vi.spyOn(api, 'routing');
  renderApp(<RoutingStatus />, { api });

  const button = await screen.findByRole('button', { name: '刷新' });
  await waitFor(() => expect(button.hasAttribute('disabled')).toBe(false));
  expect(screen.getByText(/最后更新/)).toBeTruthy();
  expect(screen.queryByText('数据已过期')).toBeNull();

  const before = routing.mock.calls.length;
  expect(before).toBeGreaterThan(0);
  fireEvent.click(button);
  await waitFor(() => expect(routing.mock.calls.length).toBe(before + 1));
});

test('【故意造出的失败】渠道目录没读成仍显示 LoadError', async () => {
  const api = createMockApi({ live: false });
  api.routing = () => Promise.reject(new ApiError(500, 'internal', '后端出错了'));
  renderApp(<RoutingStatus />, { api });

  const alert = await screen.findByRole('alert');
  expect(alert.textContent).toContain('渠道目录没读成');
  expect(alert.textContent).toContain('后端出错了');
  expect(screen.queryByRole('list', { name: '渠道状态' })).toBeNull();
});
