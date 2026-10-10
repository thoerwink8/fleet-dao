// @vitest-environment happy-dom
// 定时任务页顶部摘要卡：说明要完整折行，不能单行省略（#1527）。
// 「上次跑成」和「N 分钟前开始」合成一列（#1753）。
import { cleanup, screen, within } from '@testing-library/react';
import { afterEach, describe, expect, test } from 'vitest';
import { renderApp } from '../test/harness';
import SchedulesPage from './schedules';

afterEach(cleanup);

const HINTS = ['跑了，但一个都没扫到，或有一部分没查成', '超过期望间隔没跑成，或从没跑成过'] as const;

const TRUNCATE = /(?:^|\s)(?:truncate|line-clamp-\S+|text-ellipsis|whitespace-nowrap)(?:\s|$)/;

function hintEl(text: string): HTMLElement {
  const el = screen.getByText(text);
  if (!(el instanceof HTMLElement)) throw new Error(`说明不是元素：${text}`);
  return el;
}

function statCard(label: string): HTMLElement {
  const span = screen.getAllByText(label, { exact: true }).find((el) => el.tagName === 'SPAN');
  const card = span?.closest('div.rounded-xl');
  if (!(card instanceof HTMLElement)) throw new Error(`找不到摘要卡：${label}`);
  return card;
}

describe('定时任务摘要卡', () => {
  test('说明完整可见，元素上没有单行省略', async () => {
    renderApp(<SchedulesPage />, { route: '/schedules' });
    await screen.findByRole('heading', { name: '定时任务' });
    for (const text of HINTS) {
      const el = hintEl(text);
      expect(el.textContent).toBe(text);
      expect(el.className).not.toMatch(TRUNCATE);
      expect(el.className).toContain('break-words');
    }
  });

  test('四张卡同一网格里撑满对齐，数字仍在标签下面', async () => {
    renderApp(<SchedulesPage />, { route: '/schedules' });
    await screen.findByRole('heading', { name: '定时任务' });
    const cards = ['定时任务', '上次失败', '上次没查全', '过期'].map(statCard);
    const parent = cards[0]?.parentElement;
    if (!parent) throw new Error('摘要卡没有父级');
    expect(parent.className).toContain('grid');
    expect(parent.className).toContain('items-stretch');
    expect(parent.className).toContain('grid-cols-2');
    expect(parent.className).toContain('md:grid-cols-4');
    for (const card of cards) {
      expect(card.parentElement).toBe(parent);
      expect(card.className).toContain('h-full');
      const value = card.querySelector('.num');
      const labelRow = card.firstElementChild;
      if (!labelRow || !(value instanceof Element)) throw new Error('摘要卡缺标签或数字');
      expect(labelRow.contains(value)).toBe(false);
      expect(labelRow.compareDocumentPosition(value) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    }
  });
});

describe('定时任务上次跑成列', () => {
  test('上次跑成和开始时间在同一列', async () => {
    renderApp(<SchedulesPage />, { route: '/schedules' });
    // 窄屏卡片和宽屏表格各有一份，等任意一份出来再盯表格那一列
    await screen.findAllByText('额度读取');
    const table = document.querySelector('table');
    if (!(table instanceof HTMLElement)) throw new Error('找不到表格');
    const heads = within(table)
      .getAllByRole('columnheader')
      .map((h) => h.textContent?.trim());
    expect(heads).toEqual(['任务', '周期', '上次运行', '上次跑成', '耗时']);

    const row = within(table).getByText('额度读取').closest('tr');
    if (!(row instanceof HTMLElement)) throw new Error('找不到额度读取那一行');
    const cells = within(row).getAllByRole('cell');
    const outcomeCell = cells[2];
    const successCell = cells[3];
    if (!outcomeCell || !successCell) throw new Error('列数不对');
    expect(successCell.textContent).toMatch(/开始/);
    expect(outcomeCell.textContent).not.toMatch(/开始/);
    // 主行是上次跑成（相对时间），副行是开始时间——同在一格里
    const block = successCell.querySelector('[data-last-success]');
    expect(block).toBeTruthy();
    expect(within(successCell).getByText(/开始/).closest('[data-last-success]')).toBe(block);
  });
});
