// @vitest-environment happy-dom
// 操作记录照路由页样板重做（#1940）：一行一个主信息（谁做了什么）一个状态，次要操作收进常驻淡色「⋯」，
// 展开的明细在行下面（RowDetail，和名字对齐）；理由、出错在小字行里放不下截断，展开看全文；刷新在页头固定槽位。
import { cleanup, fireEvent, screen, waitFor, within } from '@testing-library/react';
import { afterEach, describe, expect, test } from 'vitest';
import { createMockApi } from '../api/mock/server';
import AuditPage from '../routes/audit';
import { renderApp } from './harness';

afterEach(cleanup);

const openMenu = (row: HTMLElement) => {
  const trigger = within(row).getByRole('button', { name: /^更多操作/ });
  trigger.focus();
  fireEvent.keyDown(trigger, { key: 'Enter' });
  return trigger;
};

describe('操作记录一行（#1940）', () => {
  test('每行有常驻淡色「⋯」（不是悬停才出现）；菜单里「只看这个对象的记录」点了就只看它，再点筛选钮取消', async () => {
    renderApp(<AuditPage />, { api: createMockApi({ live: false }), route: '/audit' });
    await screen.findAllByText('派了会话');
    const rows = Array.from(document.querySelectorAll<HTMLElement>('li[data-audit-row]'));
    for (const row of rows) {
      const trigger = within(row).getByRole('button', { name: /^更多操作/ });
      expect(trigger.className).toContain('pointer-fine:opacity-40');
      expect(trigger.className).not.toContain('pointer-fine:opacity-0');
    }
    const before = rows.length;
    const first = rows[0] as HTMLElement;
    openMenu(first);
    fireEvent.click(await screen.findByRole('menuitem', { name: '只看这个对象的记录' }));
    await waitFor(() => expect(document.querySelectorAll('li[data-audit-row]').length).toBeLessThan(before));
    const chip = screen.getByRole('button', { name: '不再只看这个对象' });
    expect(chip.textContent).toContain('只看');
    fireEvent.click(chip);
    await waitFor(() => expect(document.querySelectorAll('li[data-audit-row]').length).toBe(before));
  });

  test('理由在小字行里一行不折、整句在悬停里；没有改动只有理由的行也能展开看全文，明细缩进和名字对齐', async () => {
    renderApp(<AuditPage />, { api: createMockApi({ live: false }), route: '/audit' });
    await screen.findAllByText('发了要拍板的提醒');
    const row = screen.getByText('发了要拍板的提醒').closest('li[data-audit-row]') as HTMLElement;
    const meta = row.querySelector('[data-row-meta]') as HTMLElement;
    expect(meta.className).toContain('whitespace-nowrap');
    expect(meta.getAttribute('title')).toContain('理由：要人拍板：要上线');
    const expand = within(row).getByRole('button', { name: '看全文' });
    fireEvent.click(expand);
    const detail = row.querySelector('[data-row-detail]') as HTMLElement;
    expect(detail).toBeTruthy();
    expect(detail.className).toContain('pl-[calc(var(--spacing-section)+var(--spacing-row-indent))]');
    expect(within(detail).getByText('理由：要人拍板：要上线')).toBeTruthy();
    // 没有改动：不出「看原始数据」
    expect(within(detail).queryByText('看原始数据')).toBeNull();
  });

  test('刷新在页头固定槽位（Page 的 refresh），不是页面自己摆的', async () => {
    renderApp(<AuditPage />, { api: createMockApi({ live: false }), route: '/audit' });
    const button = await screen.findByRole('button', { name: '刷新' });
    expect(button.closest('[data-page-actions]')).not.toBeNull();
  });
});
