// @vitest-environment happy-dom
// 额度页刷新条：点刷新再读主查询；读失败仍显示 LoadError，这条放最后。
import { cleanup, fireEvent, screen, waitFor } from '@testing-library/react';
import { afterEach, expect, test, vi } from 'vitest';
import { ApiError, usePools } from '../api/client';
import { createMockApi } from '../api/mock/server';
import QuotaPage from '../routes/quota';
import { renderApp } from './harness';

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

// 主查询的 refetch 在观察者创建时就 bind 到实例上。先挂一次拿到原型，再换成计数，额度页新建的观察者才会走到这个计数。
function spyOnMainRefetch() {
  function Probe() {
    usePools();
    return null;
  }
  const probe = renderApp(<Probe />);
  const observer = probe.qc.getQueryCache().find({ queryKey: ['pools'] })?.observers[0];
  if (!observer) throw new Error('探针没有主查询');
  const refetch = vi.spyOn(Object.getPrototypeOf(observer), 'refetch');
  probe.unmount();
  return refetch;
}

test('点刷新按钮，调用额度页主查询的 refetch', async () => {
  const refetch = spyOnMainRefetch();
  const api = createMockApi({ live: false });
  const pools = vi.spyOn(api, 'pools');
  renderApp(<QuotaPage />, { api });
  // 读取中不再写 disabled（一写浏览器就把键盘焦点丢到 body），用 aria-disabled 判断还在不在读。
  await waitFor(() =>
    expect(
      (screen.getByRole('button', { name: '刷新' }) as HTMLButtonElement).getAttribute('aria-disabled'),
    ).not.toBe('true'),
  );
  refetch.mockClear();
  const before = pools.mock.calls.length;
  fireEvent.click(screen.getByRole('button', { name: '刷新' }));
  expect(refetch).toHaveBeenCalledTimes(1);
  await waitFor(() => expect(pools.mock.calls.length).toBe(before + 1));
});

test('【故意造出的失败】额度没读成：仍显示 LoadError', async () => {
  const api = createMockApi({ live: false });
  api.pools = () => Promise.reject(new ApiError(500, 'internal', '后端出错了'));
  renderApp(<QuotaPage />, { api });
  const alert = await screen.findByRole('alert');
  expect(alert.textContent).toContain('没查成');
  expect(alert.textContent).toContain('后端出错了');
  expect(screen.getByRole('button', { name: '重试' })).toBeTruthy();
});
