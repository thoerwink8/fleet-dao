// @vitest-environment happy-dom
// 定时任务页顶部一条摘要，异常行置顶、结果写全（#1902）。
// 「上次跑成」和「N 分钟前开始」合成一列（#1753）。
import { cleanup, fireEvent, screen, within } from '@testing-library/react';
import { afterEach, describe, expect, test } from 'vitest';
import { ApiError } from '../api/client';
import { createMockApi } from '../api/mock/server';
import { rowTone } from '../components/job-row';
import { renderApp } from '../test/harness';
import SchedulesPage from './schedules';

afterEach(cleanup);

describe('定时任务摘要条（#1902）', () => {
  test('统计压成一条摘要：只列不是 0 的项，不再有四张统计卡', async () => {
    renderApp(<SchedulesPage />, { route: '/schedules' });
    await screen.findByText('额度读取');
    const summary = document.querySelector('[data-job-summary]') as HTMLElement;
    // 改成页顶标题块（#1914 样板）：第一行「N 个定时任务」，原来摘要条开头的「共 N 个定时任务」
    expect(summary.textContent).toMatch(/^\d+ 个定时任务/);
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
    // 原来是宽屏的「上次运行」列；改成两层行后，上次结果在名字下面那一行灰字（data-job-outcome），各宽度同一处
    const column = (r: HTMLElement) => r.querySelector('[data-job-outcome]');
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

describe('照路由页样板重做（标题块、一行一个状态）', () => {
  test('标题块三行：几个定时任务、最要紧的一句加状态、异常计数；三行都不折', async () => {
    renderApp(<SchedulesPage />, { route: '/schedules' });
    await screen.findByText('额度读取');
    const hero = document.querySelector('[data-schedules-hero]') as HTMLElement;
    const line = hero.querySelector('[data-hero-line]') as HTMLElement;
    // 假数据里夜间备份失败：结论写它和原因，状态「要处理」（红）
    expect(line.textContent).toContain('夜间备份上次失败');
    expect(line.querySelector('[data-tone="fail"]')?.textContent).toBe('要处理');
    expect(line.className).toContain('whitespace-nowrap');
    expect(hero.querySelector('[data-hero-text]')?.className).toContain('truncate');
    expect(hero.querySelector('[data-hero-notes]')?.className).toContain('truncate');
  });

  test('都正常时结论写「全部按期跑成」，灰字写最近跑成的一个', async () => {
    const api = createMockApi({ live: false });
    const all = await api.jobs();
    api.jobs = async () => ({ ...all, jobs: all.jobs.filter((j) => rowTone(j) === null) });
    renderApp(<SchedulesPage />, { api, route: '/schedules' });
    await screen.findByText('额度读取');
    const hero = document.querySelector('[data-schedules-hero]') as HTMLElement;
    expect(hero.querySelector('[data-hero-line]')?.textContent).toContain('全部按期跑成');
    expect(hero.querySelector('[data-tone="done"]')?.textContent).toBe('都正常');
    expect(hero.querySelector('[data-hero-notes]')?.textContent).toMatch(/^最近跑成：/);
  });

  test('一行只放一个状态：过期叠在失败、没查全后面，不另贴「过期」标签', async () => {
    renderApp(<SchedulesPage />, { route: '/schedules' });
    const backup = (await screen.findByText('夜间备份')).closest('li') as HTMLElement;
    const line = backup.querySelector('[data-row-name-line]') as HTMLElement;
    expect(line.querySelectorAll('[data-tone]').length).toBeGreaterThan(0);
    expect(line.querySelector('[data-variant="dot"]')?.textContent).toBe('失败，已过期');
    const quota = screen.getByText('额度读取').closest('li') as HTMLElement;
    expect(quota.querySelector('[data-variant="dot"]')?.textContent).toBe('按期');
    // 上次跑成的绝对时间在悬停里
    expect(quota.querySelector('[data-last-success-ago]')?.getAttribute('title')).toMatch(/^上次跑成：/);
  });

  test('【故意造出的失败】读成过、刷新失败：照旧画上一次读到的，顶上一条横幅带重试', async () => {
    const api = createMockApi({ live: false });
    renderApp(<SchedulesPage />, { api, route: '/schedules' });
    await screen.findByText('额度读取');
    api.jobs = () => Promise.reject(new ApiError(500, 'internal', '后端出错了'));
    fireEvent.click(screen.getByRole('button', { name: '刷新' }));
    const alert = await screen.findByRole('alert', {}, { timeout: 4000 });
    expect(alert.textContent).toContain('定时任务刷新没读成，下面是上一次读到的');
    expect(within(alert).getByRole('button', { name: '重试' })).toBeTruthy();
    expect(screen.getByText('额度读取')).toBeTruthy();
  });
});
