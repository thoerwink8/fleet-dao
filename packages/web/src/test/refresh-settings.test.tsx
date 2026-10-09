// @vitest-environment happy-dom
// 设置页刷新条：点「刷新」再读一遍该页主查询 useSettings 的 refetch；读失败仍显示 LoadError（故意造出的失败放最后）。
import { cleanup, fireEvent, screen, waitFor, within } from '@testing-library/react';
import { afterEach, expect, test, vi } from 'vitest';
import { ApiError } from '../api/client';
import { createMockApi } from '../api/mock/server';
import SettingsPage from '../routes/settings';
import { renderApp } from './harness';

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

test('点刷新按钮调用该页主查询的 refetch', async () => {
  const api = createMockApi({ live: false });
  const settings = vi.spyOn(api, 'settings');
  const view = renderApp(<SettingsPage />, { api });

  await waitFor(() => expect(screen.getByText(/最后更新/).textContent).toContain('刚刚'));
  expect(screen.queryByText('数据已过期')).toBeNull();

  const query = view.qc.getQueryCache().find({ queryKey: ['settings'] });
  if (!query) throw new Error('没有主查询');
  // useSettings().refetch 打到这条查询的 fetch。
  const refetch = vi.spyOn(query, 'fetch');
  const before = settings.mock.calls.length;
  expect(before).toBeGreaterThan(0);

  // 按钮会跟着别的查询重绘。可点判断和点击必须在同一轮，晚一点 isFetching 又会把点击吃掉。
  await waitFor(() => {
    const button = screen.getByRole('button', { name: '刷新' }) as HTMLButtonElement;
    expect(button.disabled).toBe(false);
    if (refetch.mock.calls.length === 0) fireEvent.click(button);
    expect(refetch).toHaveBeenCalledTimes(1);
  });
  await waitFor(() => expect(settings.mock.calls.length).toBe(before + 1));
});

test('【故意造出的失败】设置没读成仍显示 LoadError', async () => {
  const api = createMockApi({ live: false });
  api.settings = () => Promise.reject(new ApiError(500, 'internal', '后端出错了'));
  renderApp(<SettingsPage />, { api });

  await waitFor(() => {
    const run = document.getElementById('run');
    const notify = document.getElementById('notify');
    if (!run || !notify) throw new Error('设置页缺运行设置或提醒');
    expect(within(run).getByRole('alert').textContent).toContain('没查成：后端出错了');
    expect(within(run).getByRole('button', { name: '重试' })).toBeTruthy();
    expect(within(run).queryByText('同时跑的会话上限')).toBeNull();
    expect(within(notify).getByRole('alert').textContent).toContain('没查成：后端出错了');
  });
});
