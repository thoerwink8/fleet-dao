// @vitest-environment happy-dom
// 主页刷新条：点「刷新」再读一遍该页主查询 useHome 的 refetch；读失败仍显示 LoadError（故意造出的失败放最后）。
import { cleanup, fireEvent, screen, waitFor } from '@testing-library/react';
import { afterEach, expect, test, vi } from 'vitest';
import { ApiError, useHome } from '../api/client';
import { createMockApi } from '../api/mock/server';
import HomePage from '../routes/home';
import { renderApp } from './harness';

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

// 主查询的 refetch 在观察者创建时就 bind 到实例上。先挂一次拿到原型，再换成计数，主页新建的观察者才会走到这个计数。
function spyOnMainRefetch() {
  function Probe() {
    useHome();
    return null;
  }
  const probe = renderApp(<Probe />);
  const observer = probe.qc.getQueryCache().find({ queryKey: ['home'] })?.observers[0];
  if (!observer) throw new Error('探针没有主查询');
  const refetch = vi.spyOn(Object.getPrototypeOf(observer), 'refetch');
  probe.unmount();
  return refetch;
}

test('点刷新按钮，调用主页主查询的 refetch', async () => {
  const refetch = spyOnMainRefetch();
  const api = createMockApi({ live: false });
  const home = vi.spyOn(api, 'home');
  renderApp(<HomePage />, { api });
  // 读取中不写 disabled，等 aria-busy 变成 false 才是读完；disabled 一直是 false，会在读完前就点下去。
  await waitFor(() =>
    expect(screen.getByRole('button', { name: '刷新' }).getAttribute('aria-busy')).toBe('false'),
  );
  expect(screen.getByText(/最后更新/).textContent).toContain('刚刚');
  refetch.mockClear();
  const before = home.mock.calls.length;
  expect(before).toBeGreaterThan(0);
  fireEvent.click(screen.getByRole('button', { name: '刷新' }));
  expect(refetch).toHaveBeenCalledTimes(1);
  await waitFor(() => expect(home.mock.calls.length).toBe(before + 1));
});

test('【故意造出的失败】主页没读成：仍显示 LoadError', async () => {
  const api = createMockApi({ live: false });
  api.home = () => Promise.reject(new ApiError(500, 'internal', '后端出错了'));
  renderApp(<HomePage />, { api });
  const alert = await screen.findByRole('alert');
  expect(alert.textContent).toContain('主页没读成');
  expect(alert.textContent).toContain('后端出错了');
  expect(screen.getByRole('button', { name: '重试' })).toBeTruthy();
  expect(screen.queryByRole('button', { name: /要你拍的/ })).toBeNull();
});
