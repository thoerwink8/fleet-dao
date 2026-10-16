// @vitest-environment happy-dom
// 全程 / 三段标签（#2828）：列表、详情、首页在跑卡片有值才标，没有这个值不画、不猜。
import { cleanup, render, screen } from '@testing-library/react';
import { Route, Routes } from 'react-router';
import { afterEach, describe, expect, test } from 'vitest';
import type { FleetApi } from '../api/client';
import { createMockApi } from '../api/mock/server';
import type { TaskList, TaskListRow } from '../api/types';
import { FlowModeTag } from '../components/flow-mode-tag';
import { FarTicket } from '../components/home/board/nodes';
import { RunningCard } from '../components/home/running-card';
import { RunBlock } from '../components/home/today-blocks';
import type { HomeRunning } from '../components/home/types';
import TaskPage from '../routes/task';
import TasksPage from '../routes/tasks';
import { renderApp } from './harness';

afterEach(cleanup);

const tag = (mode: string) => document.querySelector(`[data-flow-mode="${mode}"]`);

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
    cost: {
      actual: 1.5,
      estimated: null,
      usd: 1.5,
      segments: 0,
      unreadSegments: 0,
      noPrice: 0,
    },
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

const card = (over: Partial<HomeRunning> = {}): HomeRunning => ({
  issueNumber: 77,
  title: '把看板切到本机',
  repo: 'acme/widgets',
  segment: 'doing',
  waitingReason: 'nothing',
  link: '/tasks/t-77',
  ...over,
});

describe('FlowModeTag', () => {
  test('全程、三段各标各的；没有值不画', () => {
    const view = render(<FlowModeTag mode="full" />);
    expect(tag('full')?.textContent).toBe('全程');
    view.rerender(<FlowModeTag mode="three" />);
    expect(tag('three')?.textContent).toBe('三段');
    expect(tag('full')).toBeNull();
    view.rerender(<FlowModeTag mode={undefined} />);
    expect(document.querySelector('[data-flow-mode]')).toBeNull();
    view.rerender(<FlowModeTag mode={null} />);
    expect(document.querySelector('[data-flow-mode]')).toBeNull();
  });
});

describe('任务列表', () => {
  test('有 flowMode 的行标全程或三段，没有的不标', async () => {
    const api = createMockApi({ live: false });
    api.tasks = async () => ({
      items: [
        row(1, { title: '全程单', flowMode: 'full' }),
        row(2, { title: '三段单', flowMode: 'three' }),
        row(3, { title: '老单' }),
      ],
      counts: counts({ all: 3, running: 3 }),
    });
    renderApp(<TasksPage />, { api, route: '/tasks' });
    expect(
      (await screen.findByText('全程单')).closest('a')?.querySelector('[data-flow-mode="full"]')?.textContent,
    ).toBe('全程');
    expect(
      screen.getByText('三段单').closest('a')?.querySelector('[data-flow-mode="three"]')?.textContent,
    ).toBe('三段');
    expect(screen.getByText('老单').closest('a')?.querySelector('[data-flow-mode]')).toBeNull();
  });
});

describe('任务详情', () => {
  test('有值才在结论行标；老单不标', async () => {
    const api = createMockApi({ live: false });
    const real = api.task.bind(api);
    api.task = async (id) => {
      const detail = await real(id);
      if (id === 't-12') return { ...detail, task: { ...detail.task, flowMode: 'full' } };
      return detail;
    };
    const open = (route: string) =>
      renderApp(
        <Routes>
          <Route path="/tasks/:taskId" element={<TaskPage />} />
        </Routes>,
        { route, api: api as FleetApi },
      );
    open('/tasks/t-12');
    expect(await screen.findByRole('heading', { level: 1, name: /登录页加手机验证码/ })).toBeTruthy();
    expect(tag('full')?.textContent).toBe('全程');
    cleanup();
    open('/tasks/t-c9');
    expect(await screen.findByRole('heading', { level: 1, name: /README 的时间改成北京时间/ })).toBeTruthy();
    expect(document.querySelector('[data-flow-mode]')).toBeNull();
  });
});

describe('首页在跑卡片', () => {
  test('RunningCard：有值才标', () => {
    renderApp(<RunningCard item={card({ flowMode: 'full' })} />);
    expect(tag('full')?.textContent).toBe('全程');
    cleanup();
    renderApp(<RunningCard item={card({ flowMode: 'three' })} />);
    expect(tag('three')?.textContent).toBe('三段');
    cleanup();
    renderApp(<RunningCard item={card()} />);
    expect(document.querySelector('[data-flow-mode]')).toBeNull();
  });

  test('主页「在跑的」一行：有值才标', async () => {
    renderApp(
      <RunBlock
        running={[
          card({ issueNumber: 1, title: '全程单', flowMode: 'full' }),
          card({ issueNumber: 2, title: '三段单', flowMode: 'three' }),
          card({ issueNumber: 3, title: '老单' }),
        ]}
      />,
    );
    const line = async (title: string) => (await screen.findByText(title)).closest('li');
    expect((await line('#1 全程单'))?.querySelector('[data-flow-mode="full"]')?.textContent).toBe('全程');
    expect((await line('#2 三段单'))?.querySelector('[data-flow-mode="three"]')?.textContent).toBe('三段');
    expect((await line('#3 老单'))?.querySelector('[data-flow-mode]')).toBeNull();
  });

  test('看板远档卡片：有值才标', () => {
    const view = render(<FarTicket tone="run" id="#12" title="登录页" flowMode="full" />);
    expect(tag('full')?.textContent).toBe('全程');
    view.rerender(<FarTicket tone="run" id="#13" title="老单" />);
    expect(document.querySelector('[data-flow-mode]')).toBeNull();
  });
});
