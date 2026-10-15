// @vitest-environment happy-dom
// 思考档位（路由页「思考档位」页签）刷新：点「刷新」再读一遍档位；读失败仍显示 LoadError（故意造出的失败放最后）。
import { cleanup, fireEvent, screen, waitFor } from '@testing-library/react';
import { afterEach, expect, test, vi } from 'vitest';
import { ApiError } from '../api/client';
import { createMockApi } from '../api/mock/server';
import RoutingPage from '../routes/routing';
import { renderApp } from './harness';

afterEach(cleanup);

test('点刷新按钮调用该页主查询的 refetch', async () => {
  const api = createMockApi({ live: false });
  const read = vi.spyOn(api, 'routingEfforts');
  renderApp(<RoutingPage />, { api, route: '/routing?tab=efforts' });

  // 思考档位并进路由页的页签（#1914 第 5 轮）：刷新是页头的图标钮，最后更新时间在悬停和读屏里，按档位那份算
  await screen.findByRole('button', { name: '刷新' });
  await screen.findAllByText('Opus 5.5');
  await waitFor(() =>
    expect(screen.getByRole('button', { name: '刷新' }).getAttribute('aria-disabled')).toBe('false'),
  );
  const button = screen.getByRole('button', { name: '刷新' });
  const fresh = document.querySelector('[data-refresh-bar="dot"] [role="status"]');
  expect(fresh?.getAttribute('title')).toMatch(/最后更新/);
  expect(fresh?.getAttribute('title')).toContain('刚刚');
  expect(screen.queryByText('数据已过期')).toBeNull();

  const before = read.mock.calls.length;
  expect(before).toBeGreaterThan(0);
  fireEvent.click(button);
  await waitFor(() => expect(read.mock.calls.length).toBe(before + 1));
});

test('【故意造出的失败】思考档位没读成仍显示 LoadError', async () => {
  const api = createMockApi({ live: false });
  api.routingEfforts = () => Promise.reject(new ApiError(500, 'internal', '后端出错了'));
  renderApp(<RoutingPage />, { api, route: '/routing?tab=efforts' });

  const alert = await screen.findByRole('alert');
  expect(alert.textContent).toContain('思考档位没读成');
  expect(alert.textContent).toContain('后端出错了');
  expect(screen.queryByText('路由两层里一条路由都没有')).toBeNull();
});
