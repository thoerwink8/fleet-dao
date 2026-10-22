// @vitest-environment happy-dom
// 渠道状态页的刷新条：点「刷新」再读一遍该页主查询 useRouting；读失败仍显示 LoadError（故意造出的失败放最后）。
import { cleanup, fireEvent, screen, waitFor, within } from '@testing-library/react';
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
  // 刷新收成圆点版（页头右边已有一句汇总，#1922）：「最后更新」在悬停和读屏里，不再是摊开的一行字（原断言 getByText(/最后更新/)）
  const fresh = document.querySelector('[data-refresh-bar] [data-freshness]');
  expect(fresh?.getAttribute('title')).toMatch(/最后更新/);
  // 现在「最后更新」是摊开的一行灰字（全站同一种刷新条），读屏直接读得到
  expect(fresh?.textContent).toMatch(/最后更新/);
  expect(screen.queryByText('数据已过期')).toBeNull();

  const before = routing.mock.calls.length;
  expect(before).toBeGreaterThan(0);
  fireEvent.click(button);
  await waitFor(() => expect(routing.mock.calls.length).toBe(before + 1));
});

test('【故意造出的失败】读成过、刷新时失败：照旧画上一次的渠道，顶上横幅写没读成和原因，重试再读（#1922）', async () => {
  const api = createMockApi({ live: false });
  const real = api.routing.bind(api);
  renderApp(<RoutingStatus />, { api });
  await screen.findByRole('list', { name: '渠道状态' });
  api.routing = () => Promise.reject(new ApiError(503, 'routing_unreadable', '库连不上'));
  const button = screen.getByRole('button', { name: '刷新' });
  await waitFor(() => expect(button.getAttribute('aria-busy')).toBeNull());
  fireEvent.click(button);
  const alert = await screen.findByRole('alert', {}, { timeout: 4000 });
  expect(alert.textContent).toContain('渠道目录刷新没读成，下面是上一次读到的：库连不上');
  expect(screen.getByRole('list', { name: '渠道状态' })).toBeTruthy();
  api.routing = real;
  fireEvent.click(within(alert).getByRole('button', { name: '重试' }));
  await waitFor(() => expect(screen.queryByRole('alert')).toBeNull(), { timeout: 4000 });
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
