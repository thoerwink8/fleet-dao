// @vitest-environment happy-dom
// #856 第 1 处：暂停、继续、叫停、重做在真页面上点得到。
// 任务页（#820 片 3）和手机上看板列表都走 task-actions 那一份：点了发对的请求，后端拒了弹后端的原因。
import { cleanup, fireEvent, screen, waitFor, within } from '@testing-library/react';
import { Route, Routes } from 'react-router';
import { afterEach, describe, expect, test, vi } from 'vitest';

const { toast } = vi.hoisted(() => ({
  toast: Object.assign(vi.fn(), {
    success: vi.fn(),
    error: vi.fn(),
    info: vi.fn(),
    warning: vi.fn(),
  }),
}));
vi.mock('sonner', () => ({ toast, Toaster: () => null }));

import { ApiError } from '../api/client';
import { createMockApi } from '../api/mock/server';
import { BoardTree } from '../components/home/board/board-tree';
import type { HomeRunning } from '../components/home/types';
import { RemoteViewProvider } from '../components/node-notice';
import TaskPage from '../routes/task';
import { renderApp } from './harness';

afterEach(() => {
  cleanup();
  for (const f of [toast.success, toast.error]) f.mockClear();
});

const runningItem: HomeRunning = {
  issueNumber: 12,
  title: '登录页加手机验证码',
  repo: 'acme/orbit',
  segment: 'doing',
  waitingReason: 'nothing',
  taskSince: '2026-10-08T00:00:00.000Z',
  stageSince: '2026-10-08T01:00:00.000Z',
  worker: 'Opus 5.5',
  link: '/tasks/t-12',
  taskId: 't-12',
  state: 'running',
};

function openTask() {
  const api = createMockApi({ live: false });
  const taskAction = vi.spyOn(api, 'taskAction');
  renderApp(
    <Routes>
      <Route path="/tasks/:taskId" element={<TaskPage />} />
    </Routes>,
    { route: '/tasks/t-12', api },
  );
  return { taskAction };
}

const actionBox = async () => {
  await screen.findByRole('heading', { level: 1 });
  await waitFor(() => expect(document.querySelector('[data-task-actions]')).not.toBeNull());
  const box = document.querySelector('[data-task-actions]');
  if (!(box instanceof HTMLElement)) throw new Error('任务页上没有操作按钮');
  return box;
};

const confirm = async (name: string) => {
  const dialog = await screen.findByRole('alertdialog');
  fireEvent.click(within(dialog).getByRole('button', { name }));
};

describe('任务页上的暂停、继续、叫停、重做（#820 片 3，#856）', () => {
  test('点暂停、选「做完这一段再停」：发 {action:pause, mode:soft}', async () => {
    const { taskAction } = openTask();
    fireEvent.click(within(await actionBox()).getByRole('button', { name: '暂停' }));
    await confirm('做完这一段再停');
    await waitFor(() => expect(taskAction).toHaveBeenCalledWith('t-12', { action: 'pause', mode: 'soft' }));
  });

  test('【故意造出的失败】暂停被后端拒：弹「暂停没成功」和后端的原因，不弹成功', async () => {
    const { taskAction } = openTask();
    taskAction.mockRejectedValueOnce(new ApiError(409, 'already_paused', '这张单已经暂停了'));
    fireEvent.click(within(await actionBox()).getByRole('button', { name: '暂停' }));
    await confirm('做完这一段再停');
    await waitFor(() =>
      expect(toast.error).toHaveBeenCalledWith('暂停没成功', { description: '这张单已经暂停了' }),
    );
    expect(toast.success).not.toHaveBeenCalled();
  });

  test('先暂停，再点继续：发 {action:resume}', async () => {
    const { taskAction } = openTask();
    fireEvent.click(within(await actionBox()).getByRole('button', { name: '暂停' }));
    await confirm('做完这一段再停');
    await waitFor(() => expect(taskAction).toHaveBeenCalledWith('t-12', { action: 'pause', mode: 'soft' }));
    const resume = () =>
      within(document.querySelector('[data-task-actions]') as HTMLElement).getByRole('button', {
        name: '继续',
      });
    await waitFor(() => expect((resume() as HTMLButtonElement).disabled).toBe(false));
    fireEvent.click(resume());
    await waitFor(() => expect(taskAction).toHaveBeenCalledWith('t-12', { action: 'resume' }));
  });

  test('确认叫停：发 {action:stop}；接着重做：发 {action:redo}', async () => {
    const { taskAction } = openTask();
    fireEvent.click(within(await actionBox()).getByRole('button', { name: '叫停' }));
    await confirm('叫停');
    await waitFor(() => expect(taskAction).toHaveBeenCalledWith('t-12', { action: 'stop' }));
    fireEvent.click(within(await actionBox()).getByRole('button', { name: '重做' }));
    await confirm('重做');
    await waitFor(() => expect(taskAction).toHaveBeenCalledWith('t-12', { action: 'redo' }));
  });

  test('【故意造出的失败】叫停被后端拒：弹「叫停没成功」和后端的原因', async () => {
    const { taskAction } = openTask();
    taskAction.mockRejectedValueOnce(new ApiError(409, 'task_finished', '任务已经结束（done），不能再叫停'));
    fireEvent.click(within(await actionBox()).getByRole('button', { name: '叫停' }));
    await confirm('叫停');
    await waitFor(() =>
      expect(toast.error).toHaveBeenCalledWith('叫停没成功', {
        description: '任务已经结束（done），不能再叫停',
      }),
    );
    expect(toast.success).not.toHaveBeenCalled();
  });
});

describe('手机上看板列表的操作菜单（#856 第 1 处）', () => {
  const openMenu = () => {
    fireEvent.pointerDown(screen.getByRole('button', { name: '#12 的操作' }), {
      button: 0,
      ctrlKey: false,
      pointerType: 'mouse',
    });
  };

  test('在跑的单：菜单里有暂停、叫停，不给继续', async () => {
    renderApp(<BoardTree running={[runningItem]} flow={[]} />);
    openMenu();
    const menu = await screen.findByRole('menu');
    expect(within(menu).getByRole('menuitem', { name: '暂停' })).toBeTruthy();
    expect(within(menu).queryByRole('menuitem', { name: '继续' })).toBeNull();
    expect(within(menu).getByRole('menuitem', { name: '叫停' })).toBeTruthy();
  });

  test('【故意造出的失败】继续被后端拒：弹「继续没成功」和后端的原因', async () => {
    const api = createMockApi({ live: false });
    const taskAction = vi
      .spyOn(api, 'taskAction')
      .mockRejectedValueOnce(new ApiError(409, 'task_finished', '任务已经结束（done），不能再继续'));
    renderApp(
      <BoardTree
        running={[{ ...runningItem, waitingReason: 'paused', paused: '已暂停：被人暂停（frank）' }]}
        flow={[]}
      />,
      { api },
    );
    openMenu();
    fireEvent.click(within(await screen.findByRole('menu')).getByRole('menuitem', { name: '继续' }));
    await waitFor(() =>
      expect(toast.error).toHaveBeenCalledWith('继续没成功', {
        description: '任务已经结束（done），不能再继续',
      }),
    );
    expect(taskAction).toHaveBeenCalledWith('t-12', { action: 'resume' });
    expect(toast.success).not.toHaveBeenCalled();
  });

  test('暂停着的单：菜单里没有「暂停」，有继续和叫停', async () => {
    renderApp(
      <BoardTree
        running={[{ ...runningItem, waitingReason: 'paused', paused: '已暂停：被人暂停（frank）' }]}
        flow={[]}
      />,
    );
    openMenu();
    const menu = await screen.findByRole('menu');
    expect(within(menu).queryByRole('menuitem', { name: '暂停' })).toBeNull();
    expect(within(menu).getByRole('menuitem', { name: '继续' })).toBeTruthy();
    expect(within(menu).getByRole('menuitem', { name: '叫停' })).toBeTruthy();
  });

  test('看远程快照、或快照里没有任务编号：不给操作菜单', () => {
    const { unmount } = renderApp(
      <RemoteViewProvider value={{ name: '本机 WSL' }}>
        <BoardTree running={[runningItem]} flow={[]} />
      </RemoteViewProvider>,
    );
    expect(screen.queryByRole('button', { name: '#12 的操作' })).toBeNull();
    unmount();
    const { taskId: _id, ...withoutId } = runningItem;
    renderApp(<BoardTree running={[withoutId]} flow={[]} />);
    expect(screen.queryByRole('button', { name: '#12 的操作' })).toBeNull();
  });
});
