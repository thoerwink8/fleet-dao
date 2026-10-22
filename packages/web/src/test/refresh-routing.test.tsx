// @vitest-environment happy-dom
// 路由页刷新条：点「刷新」再读一遍该页主查询；读失败仍显示 LoadError（故意造出的失败放最后）。
import { cleanup, fireEvent, screen, waitFor, within } from '@testing-library/react';
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

  await screen.findByRole('button', { name: '刷新' });
  // 加载骨架页和读好的页里刷新条不是同一个节点，等读完再取按钮，别拿着旧节点点。
  await waitFor(() =>
    expect(screen.getByRole('button', { name: '刷新' }).getAttribute('aria-disabled')).toBeNull(),
  );
  const button = screen.getByRole('button', { name: '刷新' });
  // 页头只留图标刷新（#1914），最后更新时间在悬停和读屏里
  const fresh = document.querySelector('[data-refresh-bar] [data-freshness]');
  expect(fresh?.getAttribute('title')).toMatch(/最后更新/);
  expect(fresh?.textContent).toMatch(/最后更新/);
  expect(screen.queryByText('数据已过期')).toBeNull();

  const before = routingLayers.mock.calls.length;
  expect(before).toBeGreaterThan(0);
  fireEvent.click(button);
  await waitFor(() => expect(routingLayers.mock.calls.length).toBe(before + 1));
});

test('【故意造出的失败】读成过、刷新时失败：照旧画上一次读到的，顶上横幅写没读成和原因，重试再读', async () => {
  const api = createMockApi({ live: false });
  const real = api.routingLayers.bind(api);
  renderApp(<RoutingPage />, { api, route: '/routing?purpose=execute' });
  await screen.findByRole('list', { name: '模型' });
  api.routingLayers = () => Promise.reject(new ApiError(503, 'routing_layers_unreadable', '库连不上'));
  await waitFor(() =>
    expect(screen.getByRole('button', { name: '刷新' }).getAttribute('aria-disabled')).toBeNull(),
  );
  fireEvent.click(screen.getByRole('button', { name: '刷新' }));
  const alert = await screen.findByRole('alert', {}, { timeout: 4000 });
  expect(alert.textContent).toContain('刷新没读成，下面是上一次读到的：库连不上');
  expect(screen.getByRole('list', { name: '模型' })).toBeTruthy();
  api.routingLayers = real;
  fireEvent.click(within(alert).getByRole('button', { name: '重试' }));
  await waitFor(() => expect(screen.queryByRole('alert')).toBeNull(), { timeout: 4000 });
});

test('【故意造出的失败】路由两层没读成仍显示 LoadError', async () => {
  const api = createMockApi({ live: false });
  api.routingLayers = () => Promise.reject(new ApiError(500, 'internal', '后端出错了'));
  renderApp(<RoutingPage />, { api });

  const alert = await screen.findByRole('alert');
  expect(alert.textContent).toContain('路由两层没读成');
  expect(alert.textContent).toContain('后端出错了');
  expect(screen.queryByRole('navigation', { name: '用途' })).toBeNull();
  // 重试就是再读这一页的主查询
  const before = vi.spyOn(api, 'routingLayers');
  fireEvent.click(screen.getByRole('button', { name: '重试' }));
  await waitFor(() => expect(before).toHaveBeenCalled());
});
