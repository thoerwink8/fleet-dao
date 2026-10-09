// @vitest-environment happy-dom
// 操作记录页接共用刷新条（#1448）：点「刷新」再读一遍该页主查询；读失败仍显示 LoadError。
import { cleanup, fireEvent, screen, waitFor, within } from '@testing-library/react';
import { afterEach, expect, test, vi } from 'vitest';
import { ApiError } from '../api/client';
import { createMockApi } from '../api/mock/server';
import AuditPage from '../routes/audit';
import { renderApp } from './harness';

afterEach(cleanup);

test('点刷新按钮会再读一遍操作记录', async () => {
  const api = createMockApi({ live: false });
  const spy = vi.spyOn(api, 'audit');
  renderApp(<AuditPage />, { api });
  const heading = await screen.findByRole('heading', { name: '操作记录' });
  const header = heading.closest('header');
  if (!(header instanceof HTMLElement)) throw new Error('标题不在页头');
  const button = within(header).getByRole('button', { name: '刷新' });
  await waitFor(() => expect(button.hasAttribute('disabled')).toBe(false));
  expect(header.textContent).toContain('最后更新');
  expect(header.textContent).toContain('刚刚');
  expect(header.textContent).not.toContain('秒后');
  const calls = spy.mock.calls.length;
  expect(calls).toBeGreaterThan(0);
  fireEvent.click(button);
  await waitFor(() => expect(spy.mock.calls.length).toBeGreaterThan(calls));
  const added = spy.mock.calls.slice(calls);
  expect(added.length).toBeGreaterThan(0);
  expect(added.every((c) => c[0]?.cursor === undefined && c[0]?.limit === 100)).toBe(true);
});

test('【故意造出的读失败】操作记录没读成时仍显示 LoadError', async () => {
  const api = createMockApi({ live: false });
  api.audit = () => Promise.reject(new ApiError(500, 'internal', '后端出错了'));
  renderApp(<AuditPage />, { api });
  const alert = await screen.findByRole('alert');
  expect(alert.textContent).toContain('操作记录没读成');
  expect(alert.textContent).toContain('后端出错了');
});
