// @vitest-environment happy-dom
// 定时任务页刷新条：点「刷新」再读一遍该页主查询 useJobs 的 refetch；读失败仍显示 LoadError（故意造出的失败放最后）。
import { cleanup, fireEvent, screen, waitFor } from '@testing-library/react';
import { afterEach, expect, test, vi } from 'vitest';
import { ApiError, useJobs } from '../api/client';
import { createMockApi } from '../api/mock/server';
import SchedulesPage from '../routes/schedules';
import { renderApp } from './harness';

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

// 主查询的 refetch 在观察者创建时就 bind 到实例上。先挂一次拿到原型，再换成计数，定时任务页新建的观察者才会走到这个计数。
function spyOnMainRefetch() {
  function Probe() {
    useJobs();
    return null;
  }
  const probe = renderApp(<Probe />);
  const observer = probe.qc.getQueryCache().find({ queryKey: ['jobs'] })?.observers[0];
  if (!observer) throw new Error('探针没有主查询');
  const refetch = vi.spyOn(Object.getPrototypeOf(observer), 'refetch');
  probe.unmount();
  return refetch;
}

test('点刷新按钮调用该页主查询的 refetch', async () => {
  const refetch = spyOnMainRefetch();
  const api = createMockApi({ live: false });
  const jobs = vi.spyOn(api, 'jobs');
  renderApp(<SchedulesPage />, { api });

  await waitFor(() => expect(screen.getByText(/最后更新/).textContent).toContain('刚刚'));
  expect(screen.queryByText('数据已过期')).toBeNull();

  const before = jobs.mock.calls.length;
  expect(before).toBeGreaterThan(0);
  refetch.mockClear();

  // 按钮会跟着读取状态重绘。可点判断和点击必须在同一轮，晚一点 isFetching 又会把点击吃掉。
  await waitFor(() => {
    const button = screen.getByRole('button', { name: '刷新' }) as HTMLButtonElement;
    expect(button.disabled).toBe(false);
    if (refetch.mock.calls.length === 0) fireEvent.click(button);
    expect(refetch).toHaveBeenCalledTimes(1);
  });
  await waitFor(() => expect(jobs.mock.calls.length).toBe(before + 1));
});

test('【故意造出的失败】定时任务没读成仍显示 LoadError', async () => {
  const api = createMockApi({ live: false });
  api.jobs = () => Promise.reject(new ApiError(500, 'internal', '后端出错了'));
  renderApp(<SchedulesPage />, { api });

  const alert = await screen.findByRole('alert');
  expect(alert.textContent).toContain('定时任务没读成');
  expect(alert.textContent).toContain('后端出错了');
  expect(screen.queryByText('还没有定时任务')).toBeNull();
});
