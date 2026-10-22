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
import TaskPage from '../routes/task';
import { renderApp } from './harness';

afterEach(() => {
  cleanup();
  for (const f of [toast.success, toast.error]) f.mockClear();
});

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
