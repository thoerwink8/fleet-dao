// @vitest-environment happy-dom
// 读不到的时候必须说「没读成」，不许用空列表、0 冒充「查了没事」（AGENTS.md 底线）。
// 这里对每条这样的路径故意造一次「读不到」：假后端的某个接口直接报错，看页面怎么说。
import { act, cleanup, fireEvent, screen, waitFor } from '@testing-library/react';
import { useEffect, useRef } from 'react';
import { Route, Routes } from 'react-router';
import { afterEach, describe, expect, test } from 'vitest';
import { ApiError, type FleetApi } from '../api/client';
import { createMockApi, type MockApi } from '../api/mock/server';
import { SidebarNav } from '../components/shell/sidebar';
import { Topbar } from '../components/shell/topbar';
import { targetOf, useTaskActions } from '../components/task-actions';
import AuditPage from '../routes/audit';
import ChannelsPage from '../routes/channels';
import NotificationsPage from '../routes/notifications';
import OverviewPage from '../routes/overview';
import SchedulesPage from '../routes/schedules';
import TaskDetailPage from '../routes/task-detail';
import TasksPage from '../routes/tasks';
import { renderApp } from './harness';

afterEach(cleanup);

const boom = () => Promise.reject(new ApiError(500, 'internal', '后端出错了'));

/** 一个假后端，指定的几个接口一律报错。 */
function failing(...methods: (keyof FleetApi)[]): MockApi {
  const api = createMockApi({ live: false });
  for (const m of methods) Object.assign(api, { [m]: boom });
  return api;
}

describe('读不到时照实说，不冒充「没有」', () => {
  test('通知中心：提醒没读成，不说「没有待处理的提醒」', async () => {
    renderApp(<NotificationsPage />, { api: failing('notifications') });
    expect(await screen.findByText(/提醒没读成/)).toBeTruthy();
    expect(screen.queryByText('没有待处理的提醒')).toBeNull();
  });

  test('任务清单：有仓的看板没读成，写明是哪个仓；全没读到时不说「没有符合条件的需求」', async () => {
    renderApp(<TasksPage />, { api: failing('board') });
    expect(await screen.findByText(/仓 .+ 的需求没读成/)).toBeTruthy();
    expect(screen.getByText('看板没读全，这里空着不代表没有需求')).toBeTruthy();
    expect(screen.queryByText('没有符合条件的需求')).toBeNull();
  });

  test('任务清单：只有一个仓没读成，别的仓照常列出，并点名缺了哪个', async () => {
    const api = createMockApi({ live: false });
    const board = api.board;
    api.board = (repoId) => (repoId === 'r-canary' ? boom() : board(repoId));
    renderApp(<TasksPage />, { api });
    expect(await screen.findByText(/仓 orbit-canary 的需求没读成/)).toBeTruthy();
    expect(await screen.findAllByText('登录页加手机验证码')).toBeTruthy();
  });

  test('总览：看板没读成时数字写「—」，不写 0', async () => {
    renderApp(<OverviewPage />, { api: failing('board') });
    expect(await screen.findByText(/的需求没读成/)).toBeTruthy();
    const stat = screen.getByText('在干活').closest('a');
    expect(stat?.textContent).toContain('—');
    expect(screen.queryByText('没有等你处理的事')).toBeNull();
    expect(screen.queryByText('现在没有会话在跑')).toBeNull();
  });

  test('定时任务：没读成时不说「还没有定时任务」，失败数写「—」', async () => {
    renderApp(<SchedulesPage />, { api: failing('jobs') });
    expect(await screen.findByText(/定时任务没读成/)).toBeTruthy();
    expect(screen.queryByText('还没有定时任务')).toBeNull();
    expect(screen.getByText('上次失败').closest('div')?.parentElement?.textContent).toContain('—');
  });

  test('操作记录：没读成时不说「没有符合条件的记录」', async () => {
    renderApp(<AuditPage />, { api: failing('audit') });
    expect(await screen.findByText(/操作记录没读成/)).toBeTruthy();
    expect(screen.queryByText('没有符合条件的记录')).toBeNull();
  });

  test('渠道与账号：账号池没读成时不说「这个渠道下还没有账号池」', async () => {
    renderApp(<ChannelsPage />, { api: failing('pools') });
    expect(await screen.findByText(/账号池没读成/)).toBeTruthy();
    expect((await screen.findAllByText('账号池没读到')).length).toBeGreaterThan(0);
    expect(screen.queryByText('这个渠道下还没有账号池')).toBeNull();
  });

  test('任务详情：日志没读成不说「还没有过程记录」；步骤没读成不说「还没报步骤清单」', async () => {
    renderApp(
      <Routes>
        <Route path="/tasks/:taskId" element={<TaskDetailPage />} />
      </Routes>,
      { api: failing('timeline', 'runSteps'), route: '/tasks/t-12?sub=t-12-b' },
    );
    expect(await screen.findByText(/日志没读成/)).toBeTruthy();
    expect(screen.queryByText('还没有过程记录')).toBeNull();
    expect(await screen.findByText(/步骤清单没读成/)).toBeTruthy();
    expect(screen.queryByText('这个会话还没报步骤清单。')).toBeNull();
  });

  test('顶栏的铃和侧栏角标：没读成显示「!」，不显示成 0 条', async () => {
    renderApp(
      <>
        <Topbar onMenu={() => undefined} onSearch={() => undefined} />
        <SidebarNav />
      </>,
      { api: failing('notifications', 'board') },
    );
    expect(await screen.findByRole('button', { name: '提醒没读成' })).toBeTruthy();
    await waitFor(() => expect(screen.getAllByTitle('没读成').length).toBe(2));
  });
});

/** 在测试里直接触发一个快捷操作（换模型、回答追问的对话框）。 */
function Trigger({ action }: { action: 'reroute' | 'answer' }) {
  const { trigger } = useTaskActions();
  const fired = useRef(false);
  useEffect(() => {
    if (fired.current) return;
    fired.current = true;
    trigger(action, {
      ...targetOf({
        id: 't-15',
        issueNumber: 15,
        title: '站内通知 7 天没读就再提醒一次',
        state: 'asking',
        priority: 3,
        requestedBy: 'u-lan',
        createdAt: '2026-09-25T00:00:00Z',
        progress: { done: 0, total: 0 },
        subtasks: [],
      }),
      activity: {
        runId: 'run-x',
        stage: 'plan',
        routeId: 'r-ca-opus',
        modelName: 'Opus 5.5',
        queued: false,
        since: '2026-09-25T00:00:00Z',
        text: 'Opus 5.5 正在写方案',
      },
    });
  }, [trigger, action]);
  return null;
}

describe('对话框里读不到也照实说', () => {
  test('回答追问：追问没读成，不说「没有待回答的追问」', async () => {
    renderApp(<Trigger action="answer" />, { api: failing('task') });
    expect(await screen.findByText(/追问没读成/)).toBeTruthy();
    expect(screen.queryByText('这个需求现在没有待回答的追问。')).toBeNull();
  });

  test('换模型：路由没读成，写明现在没法换', async () => {
    renderApp(<Trigger action="reroute" />, { api: failing('routing') });
    expect(await screen.findByText(/路由没读成，现在没法换/)).toBeTruthy();
    await act(async () => {
      fireEvent.keyDown(document.body, { key: 'Escape' });
    });
  });
});
