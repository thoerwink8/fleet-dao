// @vitest-environment happy-dom
// 快捷操作（暂停、继续、叫停、重做）会改服务端状态：点了发什么请求、成功说什么、失败时必须把后端的原因
// 弹出来（toast.error），不吞错、不冒充成功；叫停、暂停、重做先确认。
// 按钮就是页面上那一份 ActionButtons（任务页、看板侧边详情用它；手机列表的菜单另有 page-actions.test.tsx）。
import { cleanup, fireEvent, screen, waitFor, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';

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
import { createMockApi, type MockApi } from '../api/mock/server';
import type { BoardTask } from '../api/types';
import { ActionButtons, type ActionTarget, targetOf } from '../components/task-actions';
import { renderApp } from './harness';

beforeEach(() => {
  for (const f of [toast.success, toast.error, toast.info, toast.warning]) f.mockClear();
});
afterEach(cleanup);

const LABEL = { pause: '暂停', resume: '继续', stop: '叫停', redo: '重做' } as const;

/** 页面上的那一排按钮（做完、失败的不画；已叫停只画重做）。 */
function Buttons({ target }: { target: ActionTarget }) {
  return <ActionButtons target={target} />;
}

const press = (action: keyof typeof LABEL) =>
  fireEvent.click(screen.getByRole('button', { name: LABEL[action] }));

async function board(api: MockApi): Promise<BoardTask[]> {
  return (await api.board('r-orbit')).tasks;
}

/** 还能暂停 / 继续 / 叫停的一张（做完、叫停、失败的页面上不画这些按钮）。 */
async function liveTask(api: MockApi): Promise<BoardTask> {
  const task = (await board(api)).find(
    (t) => t.state !== 'done' && t.state !== 'stopped' && t.state !== 'failed',
  );
  if (!task) throw new Error('没有还能操作的任务');
  return task;
}

/** 假后端：taskAction 用 spy 记下请求（默认成功）。 */
function backend() {
  const api = createMockApi({ live: false });
  const taskAction = vi.spyOn(api, 'taskAction').mockResolvedValue(undefined);
  return { api, taskAction };
}

const FAILED = new ApiError(409, 'task_finished', '任务已经结束（done），不能再暂停');

/** 暂停先弹一个选择（做完这一段再停 / 立刻停下）：点其中一个。 */
const confirmPause = (name = '做完这一段再停') =>
  fireEvent.click(within(screen.getByRole('alertdialog')).getByRole('button', { name }));

describe('暂停（#820 片 3）：先选怎么停，再发请求', () => {
  const open = async () => {
    const { api, taskAction } = backend();
    const task = await liveTask(api);
    renderApp(<Buttons target={targetOf(task)} />, { api });
    press('pause');
    expect(await screen.findByText(`暂停 #${task.issueNumber}？`)).toBeTruthy();
    return { taskAction, task };
  };

  test('点暂停只弹选择，还没发请求；点「先不」关掉，仍然没发', async () => {
    const { taskAction, task } = await open();
    expect(taskAction).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole('button', { name: '先不' }));
    await waitFor(() => expect(screen.queryByText(`暂停 #${task.issueNumber}？`)).toBeNull());
    expect(taskAction).not.toHaveBeenCalled();
  });

  test('「做完这一段再停」：发 {action:pause, mode:soft}，提示写明手上这一段做完就停', async () => {
    const { taskAction, task } = await open();
    confirmPause();
    await waitFor(() => expect(toast.success).toHaveBeenCalledTimes(1));
    expect(taskAction).toHaveBeenCalledExactlyOnceWith(task.id, { action: 'pause', mode: 'soft' });
    expect(toast.success).toHaveBeenCalledWith(`暂停：#${task.issueNumber}`, {
      description: '手上这一段做完就停，不再起新会话',
    });
    expect(toast.error).not.toHaveBeenCalled();
  });

  test('「立刻停下」：发 {action:pause, mode:hard}，提示写明动手会话叫停、继续后接着干', async () => {
    const { taskAction, task } = await open();
    confirmPause('立刻停下');
    await waitFor(() => expect(toast.success).toHaveBeenCalledTimes(1));
    expect(taskAction).toHaveBeenCalledExactlyOnceWith(task.id, { action: 'pause', mode: 'hard' });
    expect(toast.success).toHaveBeenCalledWith(`暂停：#${task.issueNumber}`, {
      description: '动手的会话已叫停，树里留着的改动继续后接着干',
    });
  });

  test('【故意造出的失败】后端拒了（409 已经暂停）：弹「暂停没成功」和后端的原因，不弹成功', async () => {
    const { taskAction } = await open();
    taskAction.mockRejectedValueOnce(new ApiError(409, 'already_paused', '这张单已经暂停了'));
    confirmPause();
    await waitFor(() =>
      expect(toast.error).toHaveBeenCalledWith('暂停没成功', { description: '这张单已经暂停了' }),
    );
    expect(toast.success).not.toHaveBeenCalled();
  });
});

describe('继续：点了就发请求，成功、失败都有话说', () => {
  test('继续：发 {action:resume}，成功提示没有多余的说明', async () => {
    const { api, taskAction } = backend();
    const task = await liveTask(api);
    renderApp(<Buttons target={targetOf(task)} />, { api });
    press('resume');
    await waitFor(() => expect(toast.success).toHaveBeenCalledTimes(1));
    expect(taskAction).toHaveBeenCalledExactlyOnceWith(task.id, { action: 'resume' });
    expect(toast.success).toHaveBeenCalledWith(`继续：#${task.issueNumber}`, { description: undefined });
  });

  test('【故意造出的失败】继续被后端拒（409）：弹「继续没成功」和后端的原因，不弹成功', async () => {
    const { api, taskAction } = backend();
    taskAction.mockRejectedValueOnce(FAILED);
    const task = await liveTask(api);
    renderApp(<Buttons target={targetOf(task)} />, { api });
    press('resume');
    await waitFor(() => expect(toast.error).toHaveBeenCalledTimes(1));
    expect(toast.error).toHaveBeenCalledWith('继续没成功', { description: FAILED.message });
    expect(toast.success).not.toHaveBeenCalled();
  });

  test('【故意造出的失败】断网（不是 ApiError 的错误）也照实弹出来', async () => {
    const { api, taskAction } = backend();
    taskAction.mockRejectedValueOnce(new TypeError('Failed to fetch'));
    const task = await liveTask(api);
    renderApp(<Buttons target={targetOf(task)} />, { api });
    press('resume');
    await waitFor(() =>
      expect(toast.error).toHaveBeenCalledWith('继续没成功', { description: 'Failed to fetch' }),
    );
  });
});

describe('叫停：先确认再发请求', () => {
  const open = async () => {
    const { api, taskAction } = backend();
    const task = await liveTask(api);
    renderApp(<Buttons target={targetOf(task)} />, { api });
    press('stop');
    expect(await screen.findByText(`叫停 #${task.issueNumber}？`)).toBeTruthy();
    return { api, taskAction, task };
  };

  test('点叫停只弹确认，还没发请求；点「先不」关掉，仍然没发', async () => {
    const { taskAction, task } = await open();
    expect(taskAction).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole('button', { name: '先不' }));
    await waitFor(() => expect(screen.queryByText(`叫停 #${task.issueNumber}？`)).toBeNull());
    expect(taskAction).not.toHaveBeenCalled();
    expect(toast.success).not.toHaveBeenCalled();
  });

  test('确认「叫停」：发 {action:stop}，提示叫停了', async () => {
    const { taskAction, task } = await open();
    fireEvent.click(within(screen.getByRole('alertdialog')).getByRole('button', { name: '叫停' }));
    await waitFor(() => expect(toast.success).toHaveBeenCalledTimes(1));
    expect(taskAction).toHaveBeenCalledExactlyOnceWith(task.id, { action: 'stop' });
    expect(toast.success).toHaveBeenCalledWith(`叫停：#${task.issueNumber}`, { description: undefined });
  });

  test('【故意造出的失败】确认后后端拒了：弹「叫停没成功」和原因，不弹成功', async () => {
    const { taskAction } = await open();
    taskAction.mockRejectedValueOnce(new ApiError(409, 'task_finished', '任务已经结束（done），不能再叫停'));
    fireEvent.click(within(screen.getByRole('alertdialog')).getByRole('button', { name: '叫停' }));
    await waitFor(() =>
      expect(toast.error).toHaveBeenCalledWith('叫停没成功', {
        description: '任务已经结束（done），不能再叫停',
      }),
    );
    expect(toast.success).not.toHaveBeenCalled();
  });
});

describe('重做：先说清旧工作树里没推上去的东西会丢掉，再发请求', () => {
  const stopped = (): ActionTarget => ({
    taskId: 't-stopped',
    issueNumber: 12,
    title: '重做这张',
    state: 'stopped',
  });

  test('点重做只弹确认，还没发请求；确认后发 {action:redo}', async () => {
    const { api, taskAction } = backend();
    const target = stopped();
    renderApp(<Buttons target={target} />, { api });
    press('redo');
    expect(await screen.findByText('重做 #12？')).toBeTruthy();
    expect(screen.getByText(/没推上去/)).toBeTruthy();
    expect(taskAction).not.toHaveBeenCalled();
    fireEvent.click(within(screen.getByRole('alertdialog')).getByRole('button', { name: '重做' }));
    await waitFor(() => expect(toast.success).toHaveBeenCalledTimes(1));
    expect(taskAction).toHaveBeenCalledExactlyOnceWith('t-stopped', { action: 'redo' });
    expect(toast.success).toHaveBeenCalledWith('重做：#12', {
      description: '新的一代已经起了。旧工作树里没推上去的东西不会跟着过来。',
    });
  });
});
