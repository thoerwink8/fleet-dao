// @vitest-environment happy-dom
// 定时任务页顶部一条摘要，异常行置顶、结果写全（#1902）。
// 「上次跑成」和「N 分钟前开始」合成一列（#1753）。
import { cleanup, fireEvent, screen, within } from '@testing-library/react';
import { afterEach, describe, expect, test } from 'vitest';
import { renderApp } from '../test/harness';
import SchedulesPage from './schedules';

afterEach(cleanup);

describe('定时任务摘要条（#1902）', () => {
  test('统计压成一条摘要：只列不是 0 的项，不再有四张统计卡', async () => {
    renderApp(<SchedulesPage />, { route: '/schedules' });
    await screen.findByText('额度读取');
    const summary = document.querySelector('[data-job-summary]') as HTMLElement;
    expect(summary.textContent).toMatch(/^共 \d+ 个定时任务/);
    expect(summary.textContent).toContain('上次失败');
    expect(summary.textContent).not.toMatch(/上次失败 0|没查全 0|过期 0/);
    // 没有「定时任务 / 上次失败 / 上次没查全 / 过期」四张独立的统计卡
    expect(screen.queryByText('上次没查全')).toBeNull();
  });

  test('异常行排在最前，上次结果写全不截断；正常行仍截断', async () => {
    renderApp(<SchedulesPage />, { route: '/schedules' });
    await screen.findByText('额度读取');
    const rows = [...document.querySelectorAll('[data-job-list] > li')] as HTMLElement[];
    const tones = rows.map((r) => (r.querySelector('[data-row-rail]') ? 'bad' : 'ok'));
    const firstOk = tones.indexOf('ok');
    expect(firstOk).toBeGreaterThan(0);
    expect(tones.slice(firstOk)).not.toContain('bad');
    const bad = rows[0] as HTMLElement;
    const column = (r: HTMLElement) => r.querySelector('[class~="md:block"][title]');
    expect(column(bad)?.className).not.toContain('truncate');
    const ok = rows[rows.length - 1] as HTMLElement;
    expect(column(ok)?.className).toContain('truncate');
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
