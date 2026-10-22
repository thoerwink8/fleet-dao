// @vitest-environment happy-dom
// 定时任务页（#3509 改版：一张表，状态只一个，有问题筛选）。
// 业务规则不变：异常行排最前、上次结果写明（「查了 0 个问题」和「没查成」分开）、读失败不画成 0、读成过刷新失败照旧画上一次的并写明。
import { cleanup, fireEvent, screen, within } from '@testing-library/react';
import { afterEach, describe, expect, test } from 'vitest';
import { ApiError } from '../api/client';
import { createMockApi } from '../api/mock/server';
import { jobStatusKey, rowTone } from '../components/schedule-row';
import { renderApp } from '../test/harness';
import SchedulesPage from './schedules';

afterEach(cleanup);

/** 表里的数据行（不含表头和展开的明细行）。 */
function jobRows(): HTMLElement[] {
  return [...document.querySelectorAll('[data-job-list] tbody tr[data-row-key]')] as HTMLElement[];
}

const rowOf = (name: string) => screen.getByText(name).closest('tr') as HTMLElement;

describe('定时任务表', () => {
  test('一个区块一张表：区块头写总数和筛选，没有顶上的摘要块', async () => {
    renderApp(<SchedulesPage />, { route: '/schedules' });
    await screen.findByText('额度读取');
    expect(document.querySelector('table')).toBeTruthy();
    expect(document.querySelector('[data-schedules-hero]')).toBeNull();
    const group = screen.getByRole('group', { name: '筛选' });
    expect(within(group).getByRole('button', { name: '全部' })).toBeTruthy();
    expect(within(group).getByRole('button', { name: /^有问题 \d+$/ })).toBeTruthy();
  });

  test('异常行排在最前（失败第一），正常的在后面', async () => {
    renderApp(<SchedulesPage />, { route: '/schedules' });
    await screen.findByText('额度读取');
    const names = jobRows().map((r) => r.querySelector('[data-job]')?.getAttribute('data-outcome'));
    expect(names[0]).toBe('failed');
    const statuses = jobRows().map((r) => r.querySelector('[data-status]')?.getAttribute('data-status'));
    const firstFresh = statuses.indexOf('fresh');
    expect(firstFresh).toBeGreaterThan(0);
    // 第一个正常行之后没有失败、没查全的行
    expect(names.slice(firstFresh)).not.toContain('failed');
  });

  test('默认全部收起，点一行才展开明细，再点收起', async () => {
    renderApp(<SchedulesPage />, { route: '/schedules' });
    const row = (await screen.findByText('额度读取')).closest('tr') as HTMLElement;
    const toggle = within(row).getByRole('button');
    expect(toggle.getAttribute('aria-expanded')).toBe('false');
    expect(document.querySelector('[data-job-detail]')).toBeNull();
    fireEvent.click(toggle);
    expect(toggle.getAttribute('aria-expanded')).toBe('true');
    const detail = document.querySelector('[data-job-detail]') as HTMLElement;
    expect(detail.textContent).toContain('上次跑成');
    expect(detail.textContent).toContain('开始于');
    expect(detail.textContent).toContain('耗时');
    expect(detail.textContent).toContain('过期线');
    expect(detail.textContent).toContain('期望');
    fireEvent.click(toggle);
    expect(document.querySelector('[data-job-detail]')).toBeNull();
  });

  test('失败的那一行 data-outcome 是 failed，状态标红「失败」', async () => {
    renderApp(<SchedulesPage />, { route: '/schedules' });
    await screen.findByText('夜间备份');
    const row = rowOf('夜间备份');
    expect(row.querySelector('[data-job]')?.getAttribute('data-outcome')).toBe('failed');
    const badge = row.querySelector('[data-status="job:failed"]');
    expect(badge?.textContent).toBe('失败');
    expect(badge?.getAttribute('data-level')).toBe('error');
  });

  test('一行只放一个状态：失败又过期的只写「失败」，不拼「失败，已过期」；过期在展开的过期线里', async () => {
    renderApp(<SchedulesPage />, { route: '/schedules' });
    await screen.findByText('夜间备份');
    const backup = rowOf('夜间备份');
    expect(backup.querySelectorAll('[data-level]')).toHaveLength(1);
    expect(backup.textContent).not.toContain('已过期');
    fireEvent.click(within(backup).getByRole('button'));
    expect(document.querySelector('[data-job-detail]')?.textContent).toContain('现在已超过，算过期');
    const quota = rowOf('额度读取');
    expect(quota.querySelector('[data-status="job:fresh"]')?.textContent).toBe('按期');
    // 上次跑成的绝对时间在悬停里
    expect(quota.querySelector('[data-last-success-ago]')?.getAttribute('title')).toMatch(/^上次跑成：/);
  });

  test('状态判法：失败 > 没查全 > 过期 > 从没跑成 > 在跑 > 按期', async () => {
    const api = createMockApi({ live: false });
    const jobs = (await api.jobs()).jobs;
    const base = jobs.find((j) => rowTone(j) === null);
    if (!base?.lastRun) throw new Error('假数据里没有按期的任务');
    const withRun = (
      over: Partial<NonNullable<typeof base.lastRun>>,
      status: typeof base.status = 'fresh',
    ) => ({
      ...base,
      status,
      lastRun: { ...base.lastRun, ...over } as NonNullable<typeof base.lastRun>,
    });
    expect(jobStatusKey(withRun({ outcome: 'failed' }, 'overdue'))).toBe('job:failed');
    expect(jobStatusKey(withRun({ outcome: 'partial' }, 'overdue'))).toBe('job:partial');
    expect(jobStatusKey(withRun({ outcome: 'unscanned' }))).toBe('job:partial');
    expect(jobStatusKey(withRun({ outcome: 'ok' }, 'overdue'))).toBe('job:overdue');
    expect(jobStatusKey({ ...base, status: 'never', lastRun: undefined })).toBe('job:never');
    expect(jobStatusKey(withRun({ outcome: undefined, endedAt: undefined }))).toBe('job:running');
    expect(jobStatusKey(withRun({ outcome: 'ok' }))).toBe('job:fresh');
  });

  test('「有问题」筛选：只留失败、没查全、过期的；在跑的不算', async () => {
    renderApp(<SchedulesPage />, { route: '/schedules' });
    await screen.findByText('额度读取');
    const total = jobRows().length;
    const group = screen.getByRole('group', { name: '筛选' });
    fireEvent.click(within(group).getByRole('button', { name: /^有问题/ }));
    const rows = jobRows();
    expect(rows.length).toBeGreaterThan(0);
    expect(rows.length).toBeLessThan(total);
    for (const r of rows) {
      expect(r.querySelector('[data-status]')).toBeTruthy();
      expect(r.querySelector('[data-status="job:fresh"]')).toBeNull();
      expect(r.querySelector('[data-status="job:running"]')).toBeNull();
    }
    fireEvent.click(within(group).getByRole('button', { name: '全部' }));
    expect(jobRows()).toHaveLength(total);
  });

  test('【故意造出的失败】读成过、刷新失败：照旧画上一次读到的，顶上一条提示带重试', async () => {
    const api = createMockApi({ live: false });
    renderApp(<SchedulesPage />, { api, route: '/schedules' });
    await screen.findByText('额度读取');
    api.jobs = () => Promise.reject(new ApiError(500, 'internal', '后端出错了'));
    fireEvent.click(screen.getByRole('button', { name: '刷新' }));
    const alert = await screen.findByRole('alert', {}, { timeout: 4000 });
    expect(alert.textContent).toContain('定时任务刷新没成');
    expect(alert.textContent).toContain('下面是');
    expect(alert.textContent).toContain('后端出错了');
    expect(within(alert).getByRole('button', { name: '重试' })).toBeTruthy();
    expect(screen.getByText('额度读取')).toBeTruthy();
  });

  test('【故意造出的失败】从没读成：只写没读成和原因，不画表、不画 0', async () => {
    const api = createMockApi({ live: false });
    api.jobs = () => Promise.reject(new ApiError(500, 'internal', '后端出错了'));
    renderApp(<SchedulesPage />, { api, route: '/schedules' });
    const alert = await screen.findByRole('alert', {}, { timeout: 4000 });
    expect(alert.textContent).toContain('定时任务没读成');
    expect(document.querySelector('table')).toBeNull();
  });

  test('一个定时任务都没有：写「还没有定时任务」，不画表', async () => {
    const api = createMockApi({ live: false });
    const all = await api.jobs();
    api.jobs = async () => ({ ...all, jobs: [] });
    renderApp(<SchedulesPage />, { api, route: '/schedules' });
    expect(await screen.findByText('还没有定时任务')).toBeTruthy();
    expect(document.querySelector('table')).toBeNull();
  });
});
