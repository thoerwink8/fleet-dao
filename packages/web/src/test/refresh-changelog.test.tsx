// @vitest-environment happy-dom
// 更新日志页的刷新条：点刷新走该页主查询 useFranceReleasedCommits 的 refetch；读失败仍显示 LoadError，这条放最后。
import { cleanup, fireEvent, screen, waitFor } from '@testing-library/react';
import { afterEach, expect, test, vi } from 'vitest';
import { ApiError, keys, useFranceReleasedCommits } from '../api/client';
import { createMockApi } from '../api/mock/server';
import ChangelogPage from '../routes/changelog';
import { renderApp } from './harness';

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

// 主查询的 refetch 在观察者创建时就 bind 到实例上。先挂一次拿到原型，再换成计数，更新日志页新建的观察者才会走到这个计数。
function spyOnMainRefetch() {
  function Probe() {
    useFranceReleasedCommits();
    return null;
  }
  const probe = renderApp(<Probe />);
  const observer = probe.qc.getQueryCache().find({ queryKey: keys.franceReleasedCommits })?.observers[0];
  if (!observer) throw new Error('探针没有主查询');
  const refetch = vi.spyOn(Object.getPrototypeOf(observer), 'refetch');
  probe.unmount();
  return refetch;
}

test('点刷新按钮调用该页主查询的 refetch', async () => {
  const refetch = spyOnMainRefetch();
  const api = createMockApi({ live: false });
  const read = vi.spyOn(api, 'franceReleasedCommits');
  renderApp(<ChangelogPage />, { api });
  await waitFor(() => expect(screen.getByText(/最后更新/).textContent).toContain('刚刚'));
  expect(screen.queryByText('数据已过期')).toBeNull();

  const before = read.mock.calls.length;
  expect(before).toBeGreaterThan(0);
  refetch.mockClear();

  // 按钮会跟着读取状态重绘。可点判断和点击必须在同一轮，晚一点 isFetching 又会把点击吃掉。
  await waitFor(() => {
    const button = screen.getByRole('button', { name: '刷新' }) as HTMLButtonElement;
    expect(button.disabled).toBe(false);
    if (refetch.mock.calls.length === 0) fireEvent.click(button);
    expect(refetch).toHaveBeenCalledTimes(1);
  });
  await waitFor(() => expect(read.mock.calls.length).toBe(before + 1));
});

test('【故意造出的失败】已发布的提交没读成仍显示 LoadError', async () => {
  const api = createMockApi({ live: false });
  api.franceReleasedCommits = () => Promise.reject(new ApiError(500, 'internal', '后端出错了'));
  renderApp(<ChangelogPage />, { api });
  const alert = await screen.findByRole('alert');
  expect(alert.textContent).toContain('已发布的提交没读成');
  expect(alert.textContent).toContain('后端出错了');
  expect(alert.querySelector('button')?.textContent).toContain('重试');
  // 读失败不把刷新条拿掉：还能再读，并写明还没读到过。
  expect((screen.getByRole('button', { name: '刷新' }) as HTMLButtonElement).disabled).toBe(false);
  expect(screen.getByText('还没读到过')).toBeTruthy();
  expect(document.querySelector('[data-released-commits]')).toBeNull();
  expect(screen.queryByText('法国的发布历史里还没有发布记录')).toBeNull();
});
