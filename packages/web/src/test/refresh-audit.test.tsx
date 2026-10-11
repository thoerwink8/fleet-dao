// @vitest-environment happy-dom
// 操作记录页的刷新条（#1448）：点刷新走该页主查询 useAudit 的 refetch；读失败仍写没读成。
import { cleanup, fireEvent, screen, waitFor } from '@testing-library/react';
import { afterEach, expect, test, vi } from 'vitest';
import { ApiError } from '../api/client';
import { createMockApi } from '../api/mock/server';
import AuditPage from '../routes/audit';
import { renderApp } from './harness';

afterEach(cleanup);

test('点刷新按钮调用该页主查询的 refetch', async () => {
  const api = createMockApi({ live: false });
  const read = vi.spyOn(api, 'audit');
  renderApp(<AuditPage />, { api });
  const button = await screen.findByRole('button', { name: '刷新' });
  await waitFor(() => expect((button as HTMLButtonElement).disabled).toBe(false));
  expect(screen.getByText(/最后更新/).textContent).toContain('刚刚');
  const before = read.mock.calls.length;
  expect(before).toBeGreaterThan(0);
  fireEvent.click(button);
  await waitFor(() => expect(read.mock.calls.length).toBe(before + 1));
  expect(read.mock.calls.at(-1)?.[0]).toMatchObject({ cursor: undefined, limit: 50 });
});

test('【故意造出的失败】操作记录没读成仍显示 LoadError', async () => {
  const api = createMockApi({ live: false });
  api.audit = () => Promise.reject(new ApiError(500, 'internal', '后端出错了'));
  renderApp(<AuditPage />, { api });
  const alert = await screen.findByRole('alert');
  expect(alert.textContent).toContain('操作记录没读成');
  expect(alert.textContent).toContain('后端出错了');
  expect(screen.queryByText('没有符合条件的记录')).toBeNull();
});
