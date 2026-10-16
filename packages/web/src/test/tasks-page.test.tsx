// @vitest-environment happy-dom
// 任务列表页（/tasks，#1639）：状态一排带数、点行进详情并能返回带回筛选、筛选写进地址栏、搜索、翻页、读不到写没读成、空的写没有符合的任务。
import { cleanup, fireEvent, screen, waitFor, within } from '@testing-library/react';
import { Route, Routes, useLocation } from 'react-router';
import { afterEach, describe, expect, test } from 'vitest';
import { ApiError, type FleetApi, TASK_LIST_PAGE_SIZE } from '../api/client';
import { createMockApi } from '../api/mock/server';
import type { TaskList, TaskListRow } from '../api/types';
import TaskPage from '../routes/task';
import TasksPage from '../routes/tasks';
import { renderApp } from './harness';

afterEach(cleanup);

function Where() {
  const loc = useLocation();
  return <output data-testid="where">{`${loc.pathname}${loc.search}`}</output>;
}

function open(route: string, api: FleetApi = createMockApi({ live: false })) {
  return renderApp(
    <>
      <Routes>
        <Route path="/tasks" element={<TasksPage />} />
        <Route path="/tasks/:taskId" element={<TaskPage />} />
        <Route path="/" element={<p>这里是主页</p>} />
      </Routes>
      <Where />
    </>,
    { route, api },
  );
}

const where = () => screen.getByTestId('where').textContent;
const tab = (name: string) => screen.getByRole('tab', { name: new RegExp(`^${name}`) });

function row(n: number, over: Partial<TaskListRow> = {}): TaskListRow {
  return {
    taskId: `t-${n}`,
    repoId: 'repo-1',
    repo: 'example/canary',
    issueNumber: n,
    title: `任务 ${n}`,
    state: 'running',
    group: 'running',
    segment: 'doing',
    model: 'Opus 5.5',
    createdAt: '2026-10-01T00:00:00.000Z',
    updatedAt: '2026-10-09T00:00:00.000Z',
    cost: { usd: 1.5 },
    prNumber: null,
    ...over,
  };
}

const counts = (over: Partial<TaskList['counts']> = {}): TaskList['counts'] => ({
  all: 0,
  running: 0,
  queued: 0,
  waiting: 0,
  done: 0,
  failed: 0,
  stopped: 0,
  ...over,
});

describe('任务列表页', () => {
  test('渲染状态一排（带各自的数）、仓筛选、搜索框和行；读到的数和后端给的一致', async () => {
    const api = createMockApi({ live: false });
    const all = await api.tasks({ limit: 100 });
    open('/tasks', api);
    expect(await screen.findByText(all.items[0]?.title ?? '')).toBeTruthy();
    for (const [name, id] of [
      ['全部', 'all'],
      ['在跑', 'running'],
      ['排队', 'queued'],
      ['等人', 'waiting'],
      ['做完', 'done'],
      ['失败', 'failed'],
      ['叫停', 'stopped'],
    ] as const) {
      expect(tab(name).textContent).toBe(`${name}${all.counts[id]}`);
    }
    expect(screen.getByRole('combobox', { name: '按仓筛选' })).toBeTruthy();
    expect(screen.getByRole('searchbox')).toBeTruthy();
    expect(screen.getAllByRole('link').length).toBe(all.items.length);
    expect(screen.getByRole('button', { name: '刷新' })).toBeTruthy();
    // 刷新照路由页样板收成圆点图标钮（#1919）：「最后更新」从摊开的字挪进读屏和悬停
    expect(screen.getByRole('status', { name: /最后更新/ })).toBeTruthy();
    // 页头右上一句汇总：在跑几个，和「在跑」页签的数一致
    const summary = document.querySelector('[data-tasks-summary]') as HTMLElement;
    expect(summary.textContent).toContain(`${all.counts.running} 个在跑`);
  });

  test('一行一个主信息一个状态（#1919）：两行行高，标题一行、灰字一行写仓#单号和模型，一行里只有一个状态', async () => {
    const api = createMockApi({ live: false });
    api.tasks = async () => ({
      items: [row(1, { title: '甲单', prNumber: 7 })],
      counts: counts({ all: 1, running: 1 }),
    });
    open('/tasks', api);
    const link = (await screen.findByText('甲单')).closest('a') as HTMLElement;
    expect(link.className).toContain('min-h-row-tall');
    const meta = link.querySelector('[data-row-meta]') as HTMLElement;
    expect(meta.className).toContain('whitespace-nowrap');
    expect(meta.textContent).toContain('example/canary#1');
    expect(meta.textContent).toContain('Opus 5.5');
    expect(meta.textContent).toContain('PR #7');
    // StatusBadge 带 data-variant（里面的点只有 data-tone）
    expect(link.querySelectorAll('[data-tone][data-variant]').length).toBe(1);
  });

  test('刷新没读成：上一次的列表留着，顶上横幅写明是上一次的、带重试', async () => {
    const api = createMockApi({ live: false });
    let fail = false;
    api.tasks = async () => {
      if (fail) throw new ApiError(500, 'internal', '后端出错了');
      return { items: [row(1, { title: '留着的单' })], counts: counts({ all: 1, running: 1 }) };
    };
    open('/tasks', api);
    expect(await screen.findByText('留着的单')).toBeTruthy();
    fail = true;
    fireEvent.click(screen.getByRole('button', { name: '刷新' }));
    const alert = await screen.findByRole('alert', undefined, { timeout: 8000 });
    expect(alert.textContent).toContain('刷新没读成，下面是上一次读到的');
    expect(alert.textContent).toContain('后端出错了');
    expect(screen.getByText('留着的单')).toBeTruthy();
    fail = false;
    fireEvent.click(within(alert).getByRole('button', { name: '重试' }));
    await waitFor(() => expect(screen.queryByRole('alert')).toBeNull());
  }, 15000);

  test('点状态标签：只剩这一组、地址栏带上 ?status=；点「全部」清掉', async () => {
    const api = createMockApi({ live: false });
    const failed = await api.tasks({ status: 'failed', limit: 100 });
    open('/tasks', api);
    await screen.findByText(failed.items[0]?.title ?? '');
    fireEvent.click(tab('失败'));
    await waitFor(() => expect(where()).toBe('/tasks?status=failed'));
    await waitFor(() => expect(screen.getAllByRole('link').length).toBe(failed.items.length));
    expect(tab('失败').getAttribute('aria-selected')).toBe('true');
    fireEvent.click(tab('全部'));
    await waitFor(() => expect(where()).toBe('/tasks'));
  });

  test('地址栏带着筛选打开（刷新、返回都是这样进来的）：对应的标签选中、搜索框和仓都还原', async () => {
    const api = createMockApi({ live: false });
    const repo = (await api.repos()).repos[0];
    open(`/tasks?status=done&q=README&repo=${repo?.id}`, api);
    expect(tab('做完').getAttribute('aria-selected')).toBe('true');
    expect((screen.getByRole('searchbox') as HTMLInputElement).value).toBe('README');
    // 仓的列表读回来之前选项还没有，读回来后选中地址栏里的那个
    await waitFor(() =>
      expect((screen.getByRole('combobox', { name: '按仓筛选' }) as HTMLSelectElement).value).toBe(repo?.id),
    );
    expect(where()).toContain(`repo=${repo?.id}`);
  });

  test('搜索：停下后才去读，单号和标题都找得到，写进 ?q=；没有的写「没有符合的任务」并能清除筛选', async () => {
    const api = createMockApi({ live: false });
    open('/tasks', api);
    await screen.findAllByRole('link');
    const box = screen.getByRole('searchbox');
    fireEvent.change(box, { target: { value: '不存在的标题' } });
    expect(await screen.findByText('没有符合的任务', undefined, { timeout: 3000 })).toBeTruthy();
    expect(where()).toContain('q=');
    expect(screen.queryAllByRole('link')).toHaveLength(0);
    fireEvent.click(screen.getByRole('button', { name: '清除筛选' }));
    await waitFor(() => expect(where()).toBe('/tasks'));
    expect((await screen.findAllByRole('link')).length).toBeGreaterThan(0);
    expect((box as HTMLInputElement).value).toBe('');
  });

  test('点一行进 /tasks/:taskId，链接带着「从哪个列表来」；详情页「返回」回到列表并带回筛选', async () => {
    const api = createMockApi({ live: false });
    const failed = await api.tasks({ status: 'failed', limit: 100 });
    const target = failed.items[0];
    if (!target) throw new Error('假数据里没有失败的单');
    open('/tasks?status=failed', api);
    const link = (await screen.findByText(target.title)).closest('a');
    expect(link?.getAttribute('href')).toBe(
      `/tasks/${target.taskId}?from=${encodeURIComponent('/tasks?status=failed')}`,
    );
    if (!link) throw new Error('行不是链接');
    fireEvent.click(link);
    const back = await screen.findByRole('link', { name: /回任务列表/ });
    expect(where()).toContain(`/tasks/${target.taskId}`);
    fireEvent.click(back);
    await waitFor(() => expect(where()).toBe('/tasks?status=failed'));
    expect(tab('失败').getAttribute('aria-selected')).toBe('true');
  });

  test('详情页不是从列表进的：返回照旧回主页；from 不是站内列表地址也不信', async () => {
    open('/tasks/t-c9');
    const home = await screen.findByRole('link', { name: /回主页/ });
    expect(home.getAttribute('href')).toBe('/');
    cleanup();
    open(`/tasks/t-c9?from=${encodeURIComponent('https://evil.example/tasks')}`);
    expect((await screen.findByRole('link', { name: /回主页/ })).getAttribute('href')).toBe('/');
  });

  test('读不到：写「没读成」、原因和重试，不拿空列表冒充没有；重试读成了就出列表', async () => {
    const api = createMockApi({ live: false });
    const real = api.tasks.bind(api);
    let fail = true;
    api.tasks = (query) => (fail ? Promise.reject(new ApiError(500, 'internal', '后端出错了')) : real(query));
    open('/tasks', api);
    const alert = await screen.findByRole('alert');
    expect(alert.textContent).toContain('任务列表没读成');
    expect(alert.textContent).toContain('后端出错了');
    expect(screen.queryByText('没有符合的任务')).toBeNull();
    fail = false;
    fireEvent.click(within(alert).getByRole('button', { name: '重试' }));
    expect((await screen.findAllByRole('link')).length).toBeGreaterThan(0);
    expect(screen.queryByRole('alert')).toBeNull();
  });

  test('翻页：点「加载更多」读下一页并拼在后面，带上一页给的游标；到底了写共几张', async () => {
    const api = createMockApi({ live: false });
    const calls: (string | undefined)[] = [];
    const total = TASK_LIST_PAGE_SIZE + 5;
    api.tasks = async (query) => {
      calls.push(query?.cursor);
      const from = query?.cursor === undefined ? 0 : Number(query.cursor);
      const end = Math.min(from + TASK_LIST_PAGE_SIZE, total);
      return {
        items: Array.from({ length: end - from }, (_, i) => row(from + i + 1)),
        counts: counts({ all: total, running: total }),
        ...(end < total ? { nextCursor: String(end) } : {}),
      };
    };
    open('/tasks', api);
    expect(await screen.findByText('任务 1')).toBeTruthy();
    expect(screen.getAllByRole('link')).toHaveLength(TASK_LIST_PAGE_SIZE);
    expect(screen.queryByText('任务 31')).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: '加载更多' }));
    expect(await screen.findByText('任务 35')).toBeTruthy();
    expect(screen.getAllByRole('link')).toHaveLength(total);
    expect(calls).toEqual([undefined, String(TASK_LIST_PAGE_SIZE)]);
    expect(screen.queryByRole('button', { name: '加载更多' })).toBeNull();
    expect(screen.getByText(/已经到底/).textContent).toContain(String(total));
  });

  test('下一页没读成：列表留着，底下写没读成和重试', async () => {
    const api = createMockApi({ live: false });
    api.tasks = async (query) => {
      if (query?.cursor !== undefined) throw new ApiError(502, 'bad_gateway', '网关超时');
      return { items: [row(1), row(2)], counts: counts({ all: 5, running: 5 }), nextCursor: 'next' };
    };
    open('/tasks', api);
    expect(await screen.findByText('任务 1')).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: '加载更多' }));
    const alert = await screen.findByRole('alert');
    expect(alert.textContent).toContain('下一页没读成');
    expect(alert.textContent).toContain('网关超时');
    expect(screen.getByText('任务 2')).toBeTruthy();
  });

  test('一行里写清：状态、段、模型、花费（读不到留空、部分没读到标偏低）、PR 号；暂停的单写已暂停', async () => {
    const api = createMockApi({ live: false });
    api.tasks = async () => ({
      items: [
        row(1, { title: '正常的一张', prNumber: 39, cost: { usd: 2.28 } }),
        row(2, { title: '没花费数据', cost: { usd: null, note: '3 笔会话都没报花费' }, model: null }),
        row(3, { title: '花费偏低', cost: { usd: 0.4, note: '另有 1 笔会话没报花费，这个数偏低' } }),
        row(4, { title: '被暂停的', paused: '已暂停：先等等', group: 'waiting', segment: 'verifying' }),
      ],
      counts: counts({ all: 4, running: 2, waiting: 1 }),
    });
    open('/tasks', api);
    const find = async (title: string) => (await screen.findByText(title)).closest('a') as HTMLElement;
    const ok = within(await find('正常的一张'));
    expect(ok.getByText('PR #39')).toBeTruthy();
    expect(ok.getByText('$2.28')).toBeTruthy();
    expect(ok.getByText('Opus 5.5')).toBeTruthy();
    expect(ok.getByText('动手')).toBeTruthy();
    const none = within(await find('没花费数据'));
    expect(none.queryByText('没读到')).toBeNull();
    expect(none.getByText('没记模型')).toBeTruthy();
    expect(none.queryByText('$0.00')).toBeNull();
    expect(within(await find('花费偏低')).getByText('偏低')).toBeTruthy();
    const paused = within(await find('被暂停的'));
    expect(paused.getByText('已暂停')).toBeTruthy();
    expect(paused.getByText('验收')).toBeTruthy();
  });

  test('花费列整列都读不到：不画花费列；单元格里不再写「更新」「开单」两个字（#1902）', async () => {
    const api = createMockApi({ live: false });
    // 更新时间钉在两小时前：过了 7 天 formatAgo 会写成「M月D日」，这一格断言认的是相对时间
    const updatedAt = new Date(Date.now() - 2 * 60 * 60 * 1000).toISOString();
    api.tasks = async () => ({
      items: [
        row(1, { title: '甲单', cost: { usd: null, note: '没有会话' }, updatedAt }),
        row(2, { title: '乙单', cost: { usd: null, note: '没有会话' }, prNumber: 7, updatedAt }),
      ],
      counts: counts({ all: 2, running: 2 }),
    });
    open('/tasks', api);
    const a = (await screen.findByText('甲单')).closest('a') as HTMLElement;
    // 原来断言表头没有「花费」、有「更新」；#1919 起没有表头，改成：花费那一列整列不画，更新时间那一格还在
    expect(document.querySelector('[data-cost-col]')).toBeNull();
    expect(a.querySelector('[title^="开单"]')?.textContent).toMatch(/前|刚刚/);
    expect(document.querySelector('[data-cost-empty]')).toBeNull();
    expect(a.textContent).not.toContain('更新');
    expect(a.textContent).not.toContain('开单');
    // 开单时间还在，放进时间格的悬停
    expect(a.querySelector('[title^="开单"]')).not.toBeNull();
  });

  test('任务表有宽度上限（--container-task-table），行是 ListRow（行高走令牌），不再手写 py-3', async () => {
    open('/tasks');
    const link = (await screen.findAllByRole('link')).find((l) =>
      l.getAttribute('href')?.startsWith('/tasks/'),
    );
    expect(document.querySelector('[data-task-table]')?.className).toContain('max-w-task-table');
    expect(link?.className).toContain('min-h-row');
    expect(link?.className).not.toContain('py-3');
  });

  test('花费读不到的行不出现没读到、有表头', async () => {
    const api = createMockApi({ live: false });
    api.tasks = async () => ({
      items: [
        row(1, { title: '在跑有花费', cost: { usd: 0.8 } }),
        row(2, {
          title: '花费读不到',
          cost: { usd: null, note: '3 笔会话都没报花费' },
          state: 'stopped',
          group: 'stopped',
          segment: null,
        }),
        row(3, {
          title: '已结束没花费',
          cost: { usd: null, note: '没有会话' },
          state: 'done',
          group: 'done',
          segment: null,
        }),
      ],
      counts: counts({ all: 3, running: 1, stopped: 1, done: 1 }),
    });
    open('/tasks', api);
    await screen.findByText('在跑有花费');
    // 原来断言表头有「单」「状态」「花费」；#1919 起没有表头，改成：每一行都有标题、一个状态和花费那一格
    for (const title of ['在跑有花费', '花费读不到', '已结束没花费']) {
      const a = (await screen.findByText(title)).closest('a') as HTMLElement;
      expect(a.querySelectorAll('[data-tone][data-variant]').length).toBe(1);
      expect(a.querySelector('[data-cost-col]')).not.toBeNull();
    }
    expect(screen.queryByText('没读到')).toBeNull();
    const empty = (await screen.findByText('花费读不到')).closest('a');
    expect(empty?.querySelector('[data-cost-empty]')?.getAttribute('title')).toBe('3 笔会话都没报花费');
    const done = (await screen.findByText('已结束没花费')).closest('a');
    expect(done?.querySelector('[data-cost-empty]')?.getAttribute('title')).toBe('没有会话');
  });
});
