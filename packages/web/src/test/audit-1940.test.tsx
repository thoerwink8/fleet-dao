// @vitest-environment happy-dom
// 操作记录（#1940 起，#3533 改成表格）：一行一个主信息（谁做了什么）一个状态，低频操作收进展开行；
// 理由、出错在表格里放不下就截断，展开看全文；刷新在页头固定槽位。
import { cleanup, fireEvent, screen, waitFor, within } from '@testing-library/react';
import { afterEach, describe, expect, test } from 'vitest';
import { createMockApi } from '../api/mock/server';
import AuditPage from '../routes/audit';
import { renderApp } from './harness';

afterEach(cleanup);

const rowsOf = () => document.querySelectorAll('tr[data-row-key]');

describe('操作记录一行（#1940）', () => {
  test('展开行里有「只看这个对象」，点了就只看它，再点筛选钮取消', async () => {
    renderApp(<AuditPage />, { api: createMockApi({ live: false }), route: '/audit' });
    await screen.findAllByText('派了会话');
    const before = rowsOf().length;
    const first = rowsOf()[0] as HTMLElement;
    fireEvent.click(within(first).getByRole('button', { name: '展开' }));
    fireEvent.click(await screen.findByRole('button', { name: '只看这个对象' }));
    await waitFor(() => expect(rowsOf().length).toBeLessThan(before));
    const chip = screen.getByRole('button', { name: '不再只看这个对象' });
    expect(chip.textContent).toContain('只看');
    fireEvent.click(chip);
    await waitFor(() => expect(rowsOf().length).toBe(before));
  });

  test('没有改动只有理由的行也能展开看全文；没有改动就不出「看原始数据」', async () => {
    renderApp(<AuditPage />, { api: createMockApi({ live: false }), route: '/audit' });
    await screen.findAllByText('发了要拍板的提醒');
    const row = screen.getByText('发了要拍板的提醒').closest('tr') as HTMLElement;
    fireEvent.click(within(row).getByRole('button', { name: '展开' }));
    const detail = (await screen.findByText('要人拍板：要上线')).closest(
      '[data-audit-detail]',
    ) as HTMLElement;
    expect(detail).toBeTruthy();
    expect(within(detail).getByText('理由')).toBeTruthy();
    expect(within(detail).queryByText('看原始数据')).toBeNull();
  });

  test('刷新在页头固定槽位（Page 的 refresh），不是页面自己摆的', async () => {
    renderApp(<AuditPage />, { api: createMockApi({ live: false }), route: '/audit' });
    const button = await screen.findByRole('button', { name: '刷新' });
    expect(button.closest('[data-page-actions]')).not.toBeNull();
  });
});
