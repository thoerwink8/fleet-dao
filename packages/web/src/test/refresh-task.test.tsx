// @vitest-environment happy-dom
// 任务详情页刷新条：点「刷新」再读一遍该页主查询 useTaskDetail 的 refetch；读失败仍显示 LoadError（故意造出的失败放最后）。
import { cleanup, fireEvent, screen, waitFor } from '@testing-library/react';
import { Route, Routes } from 'react-router';
import { afterEach, expect, test, vi } from 'vitest';
import { ApiError, type FleetApi, useTaskDetail } from '../api/client';
import { createMockApi } from '../api/mock/server';
import TaskPage from '../routes/task';
import { renderApp } from './harness';

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

function open(route: string, api?: FleetApi) {
  return renderApp(
    <Routes>
      <Route path="/tasks/:taskId" element={<TaskPage />} />
    </Routes>,
    { route, ...(api ? { api } : {}) },
  );
}

// 主查询的 refetch 在观察者创建时就 bind 到实例上。先挂一次拿到原型，再换成计数，任务页新建的观察者才会走到这个计数。
function spyOnMainRefetch() {
  function Probe() {
    useTaskDetail('t-c9');
    return null;
  }
  const probe = renderApp(<Probe />);
  const observer = probe.qc.getQueryCache().find({ queryKey: ['task', 't-c9'] })?.observers[0];
  if (!observer) throw new Error('探针没有主查询');
  const refetch = vi.spyOn(Object.getPrototypeOf(observer), 'refetch');
  probe.unmount();
  return refetch;
}

test('点刷新按钮调用该页主查询的 refetch', async () => {
  const refetch = spyOnMainRefetch();
  const api = createMockApi({ live: false });
  const read = vi.spyOn(api, 'task');
  open('/tasks/t-c9', api);
  // 读取中不再写 disabled（一写浏览器就把键盘焦点丢到 body），用 aria-disabled 判断还在不在读。
  await waitFor(() => {
    const button = screen.getByRole('button', { name: '刷新' }) as HTMLButtonElement;
    expect(button.getAttribute('aria-disabled')).not.toBe('true');
    expect(screen.getByText(/最后更新/).textContent).toContain('刚刚');
  });
  expect(screen.queryByText('数据已过期')).toBeNull();
  refetch.mockClear();
  const before = read.mock.calls.length;
  expect(before).toBeGreaterThan(0);
  fireEvent.click(screen.getByRole('button', { name: '刷新' }));
  expect(refetch).toHaveBeenCalledTimes(1);
  await waitFor(() => expect(read.mock.calls.length).toBe(before + 1));
});

test('【故意造出的失败】这张单没读成仍显示 LoadError', async () => {
  const api = createMockApi({ live: false });
  api.task = () => Promise.reject(new ApiError(500, 'internal', '后端出错了'));
  open('/tasks/t-c9', api);
  const alert = await screen.findByRole('alert', undefined, { timeout: 4000 });
  expect(alert.textContent).toContain('这张单没读成');
  expect(alert.textContent).toContain('后端出错了');
  expect(screen.getByRole('button', { name: '重试' })).toBeTruthy();
  expect(screen.queryByRole('heading', { name: '三段' })).toBeNull();
});
