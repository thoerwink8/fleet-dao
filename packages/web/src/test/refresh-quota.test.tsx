// @vitest-environment happy-dom
// 额度页接共用刷新条（#1452）：点「刷新」再读一遍该页主查询；读失败仍显示 LoadError。
import { cleanup, fireEvent, screen, waitFor, within } from '@testing-library/react';
import { afterEach, expect, test, vi } from 'vitest';
import { ApiError } from '../api/client';
import { createMockApi } from '../api/mock/server';
import QuotaPage from '../routes/quota';
import { renderApp } from './harness';

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

test('点刷新按钮会再读一遍额度', async () => {
  const api = createMockApi({ live: false });
  const spy = vi.spyOn(api, 'pools');
  renderApp(<QuotaPage />, { api });
  const heading = await screen.findByRole('heading', { name: '额度' });
  const header = heading.closest('header');
  if (!(header instanceof HTMLElement)) throw new Error('标题不在页头');
  const button = within(header).getByRole('button', { name: '刷新' });
  await waitFor(() => expect(button.hasAttribute('disabled')).toBe(false));
  expect(header.textContent).toContain('最后更新');
  // 读完成的时刻经常比秒表新不到一秒。不能因此显示成「1 秒后」。
  expect(header.textContent).toContain('刚刚');
  expect(header.textContent).not.toContain('秒后');
  const calls = spy.mock.calls.length;
  expect(calls).toBeGreaterThan(0);
  fireEvent.click(button);
  // 点一次只再读一遍：主查询的 refetch 会再调 pools。
  await waitFor(() => expect(spy.mock.calls.length).toBe(calls + 1));
});

test('【故意造出的读失败】额度没读成时仍显示 LoadError', async () => {
  const api = createMockApi({ live: false });
  api.pools = () => Promise.reject(new ApiError(500, 'internal', '后端出错了'));
  renderApp(<QuotaPage />, { api });
  const alert = await screen.findByRole('alert');
  expect(alert.textContent).toContain('没查成');
  expect(alert.textContent).toContain('后端出错了');
  expect(alert.textContent).toContain('重试');
  const heading = screen.getByRole('heading', { name: '额度' });
  const header = heading.closest('header');
  if (!(header instanceof HTMLElement)) throw new Error('标题不在页头');
  expect(within(header).getByRole('button', { name: '刷新' })).toBeTruthy();
  expect(screen.queryByText('还没有账号池')).toBeNull();
});
