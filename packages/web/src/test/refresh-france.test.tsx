// @vitest-environment happy-dom
// 法国页刷新条：点「刷新」再读一遍该页各块主查询的 refetch；读失败仍显示 LoadError（故意造出的失败放最后）。
import type { QueryClient } from '@tanstack/react-query';
import { cleanup, fireEvent, screen, waitFor } from '@testing-library/react';
import { afterEach, expect, test, vi } from 'vitest';
import { ApiError, useEnv } from '../api/client';
import { createMockApi } from '../api/mock/server';
import France from '../routes/france';
import { renderApp } from './harness';

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

/** 这一页自己拉的几块（假数据默认还有一台 wsl）。点刷新每块各走一次自己的 refetch。 */
const MAIN_QUERY_KEYS = [
  ['env'],
  ['nodes'],
  ['jobs'],
  ['france-release-state'],
  ['france-release-card'],
  ['node', 'wsl'],
] as const;

// 主查询的 refetch 在观察者创建时就 bind 到实例上。先挂一次拿到原型，再换成计数，法国页新建的观察者才会走到这个计数。
function spyOnPageRefetch() {
  function Probe() {
    useEnv();
    return null;
  }
  const probe = renderApp(<Probe />);
  const observer = probe.qc.getQueryCache().find({ queryKey: ['env'] })?.observers[0];
  if (!observer) throw new Error('探针没有主查询');
  const refetch = vi.spyOn(Object.getPrototypeOf(observer), 'refetch');
  probe.unmount();
  return refetch;
}

function spyOnMainFetches(qc: QueryClient) {
  return MAIN_QUERY_KEYS.map((queryKey) => {
    const query = qc.getQueryCache().find({ queryKey: [...queryKey], exact: true });
    if (!query) throw new Error(`没有主查询 ${queryKey.join('/')}`);
    return vi.spyOn(query, 'fetch');
  });
}

test('点刷新按钮，调用该页主查询的 refetch', async () => {
  const refetch = spyOnPageRefetch();
  const api = createMockApi({ live: false });
  const jobs = vi.spyOn(api, 'jobs');
  const view = renderApp(<France />, { api, route: '/france' });

  await waitFor(() => {
    expect(screen.getByText(/最后更新/).textContent).toContain('刚刚');
    expect((screen.getByRole('button', { name: '刷新' }) as HTMLButtonElement).disabled).toBe(false);
  });
  expect(screen.queryByText('数据已过期')).toBeNull();

  const fetches = spyOnMainFetches(view.qc);
  refetch.mockClear();
  const before = jobs.mock.calls.length;
  expect(before).toBeGreaterThan(0);

  // 按钮会跟着各块的读取状态重绘。可点判断和点击必须在同一轮，晚一点 isFetching 又会把点击吃掉。
  await waitFor(() => {
    const button = screen.getByRole('button', { name: '刷新' }) as HTMLButtonElement;
    expect(button.disabled).toBe(false);
    if (refetch.mock.calls.length === 0) fireEvent.click(button);
    expect(refetch).toHaveBeenCalledTimes(MAIN_QUERY_KEYS.length);
    for (const fetch of fetches) expect(fetch).toHaveBeenCalledTimes(1);
  });
  await waitFor(() => expect(jobs.mock.calls.length).toBe(before + 1));
});

test('最后更新以最旧的一块为准', async () => {
  const api = createMockApi({ live: false });
  const view = renderApp(<France />, { api, route: '/france' });
  await waitFor(() => expect(screen.getByText(/最后更新/).textContent).toContain('刚刚'));

  const jobs = view.qc.getQueryCache().find({ queryKey: ['jobs'], exact: true });
  if (!jobs) throw new Error('没有定时任务查询');
  const oldest = Date.now() - 10 * 60_000;
  jobs.setState({ ...jobs.state, dataUpdatedAt: oldest });

  await waitFor(() => expect(screen.getByText(/最后更新/).textContent).toContain('10 分钟前'));
  expect(screen.getByText('数据已过期')).toBeTruthy();
});

test('【故意造出的失败】定时任务没读成仍显示 LoadError', async () => {
  const api = createMockApi({ live: false });
  api.jobs = () => Promise.reject(new ApiError(500, 'internal', '后端出错了'));
  renderApp(<France />, { api, route: '/france' });

  const alert = await screen.findByRole('alert');
  expect(alert.textContent).toContain('定时任务没读成');
  expect(alert.textContent).toContain('后端出错了');
  expect(screen.getByRole('button', { name: '重试' })).toBeTruthy();
  expect(screen.queryByText('这台环境一个定时任务都没有。')).toBeNull();
});
