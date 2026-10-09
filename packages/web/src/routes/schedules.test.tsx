// @vitest-environment happy-dom
// 定时任务页顶部摘要卡：说明要完整折行，不能单行省略（#1527）。
import { cleanup, screen } from '@testing-library/react';
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
