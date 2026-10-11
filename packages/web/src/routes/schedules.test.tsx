// @vitest-environment happy-dom
// 定时任务页顶部摘要卡：说明要完整折行，不能单行省略（#1527）。
// 「上次跑成」和「N 分钟前开始」合成一列（#1753）。
import { cleanup, fireEvent, screen, within } from '@testing-library/react';
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

describe('定时任务可展开的列表行（#1805）', () => {
  test('默认全部收起，点一行才展开明细，再点收起', async () => {
    renderApp(<SchedulesPage />, { route: '/schedules' });
    const name = await screen.findByText('额度读取');
    const row = name.closest('li');
    if (!(row instanceof HTMLElement)) throw new Error('找不到额度读取那一行');
    const toggle = within(row).getByRole('button');
    // 默认收起：明细（周期、上次跑成块）不在
    expect(toggle.getAttribute('aria-expanded')).toBe('false');
    expect(row.querySelector('[data-last-success]')).toBeNull();
    expect(row.querySelector('dl')).toBeNull();
    for (const li of document.querySelectorAll('[data-job-list] > li')) {
      expect(li.querySelector('button')?.getAttribute('aria-expanded')).toBe('false');
    }
    fireEvent.click(toggle);
    expect(toggle.getAttribute('aria-expanded')).toBe('true');
    expect(row.querySelector('dl')).toBeTruthy();
    fireEvent.click(toggle);
    expect(toggle.getAttribute('aria-expanded')).toBe('false');
    expect(row.querySelector('dl')).toBeNull();
  });

  test('一行就一行：状态点、名字、上次结果、上次跑成的相对时间；没有表格', async () => {
    renderApp(<SchedulesPage />, { route: '/schedules' });
    const row = (await screen.findByText('额度读取')).closest('li') as HTMLElement;
    expect(document.querySelector('table')).toBeNull();
    expect(row.querySelector('[aria-hidden].rounded-full')).toBeTruthy();
    expect(row.textContent).toContain('前');
  });

  test('上次跑成和开始时间在同一块（展开后）', async () => {
    renderApp(<SchedulesPage />, { route: '/schedules' });
    const row = (await screen.findByText('额度读取')).closest('li') as HTMLElement;
    fireEvent.click(within(row).getByRole('button'));
    const block = row.querySelector('[data-last-success]');
    expect(block).toBeTruthy();
    expect(within(block as HTMLElement).getByText(/开始/)).toBeTruthy();
  });

  test('失败的那一行带红色竖线和 data-outcome', async () => {
    renderApp(<SchedulesPage />, { route: '/schedules' });
    const row = (await screen.findByText('夜间备份')).closest('li') as HTMLElement;
    expect(row.dataset.outcome).toBe('failed');
    expect(row.querySelector('.w-rail.bg-st-fail')).toBeTruthy();
  });
});
