// @vitest-environment happy-dom
// 定时任务页接共用刷新条（#1454）：点「刷新」再读一遍该页主查询；读失败仍显示 LoadError。
import { cleanup, fireEvent, screen, waitFor, within } from '@testing-library/react';
import { afterEach, expect, test, vi } from 'vitest';
import { ApiError } from '../api/client';
import { createMockApi } from '../api/mock/server';
import SchedulesPage from '../routes/schedules';
import { renderApp } from './harness';

afterEach(cleanup);

test('点刷新按钮会再读一遍定时任务', async () => {
  const api = createMockApi({ live: false });
  const spy = vi.spyOn(api, 'jobs');
  renderApp(<SchedulesPage />, { api });
  const heading = await screen.findByRole('heading', { name: '定时任务' });
  const header = heading.closest('header');
  if (!(header instanceof HTMLElement)) throw new Error('标题不在页头');
  const button = within(header).getByRole('button', { name: '刷新' });
  await waitFor(() => expect(button.hasAttribute('disabled')).toBe(false));
  expect(header.textContent).toContain('最后更新');
  const calls = spy.mock.calls.length;
  expect(calls).toBeGreaterThan(0);
  fireEvent.click(button);
  await waitFor(() => expect(spy.mock.calls.length).toBeGreaterThan(calls));
});

test('【故意造出的读失败】定时任务没读成时仍显示 LoadError', async () => {
  const api = createMockApi({ live: false });
  api.jobs = () => Promise.reject(new ApiError(500, 'internal', '后端出错了'));
  renderApp(<SchedulesPage />, { api });
  const alert = await screen.findByRole('alert');
  expect(alert.textContent).toContain('定时任务没读成');
  expect(alert.textContent).toContain('后端出错了');
  expect(alert.textContent).toContain('重试');
});
