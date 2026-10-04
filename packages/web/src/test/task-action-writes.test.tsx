// @vitest-environment happy-dom
// 快捷操作（暂停、继续、叫停、换模型、回答追问）会改服务端状态：点了发什么请求、成功说什么、失败时必须把后端的原因
// 弹出来（toast.error），不吞错、不冒充成功；叫停先二次确认，选不了的路由点了不发请求，空回答不发请求。
import { act, cleanup, fireEvent, screen, waitFor, within } from '@testing-library/react';
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
import type {
  BoardSubtask,
  BoardTask,
  LivenessFact,
  RoutingLayerRoute,
  RoutingLayers,
  StageKind,
} from '../api/types';
import { type ActionTarget, targetOf, useTaskActions } from '../components/task-actions';
import { renderApp } from './harness';

beforeEach(() => {
  for (const f of [toast.success, toast.error, toast.info, toast.warning]) f.mockClear();
});
afterEach(cleanup);

const ACTIONS = ['pause', 'resume', 'stop', 'reroute', 'answer'] as const;

/** 每个快捷操作一个按钮，点了就 trigger（真页面的入口各处不同，这里只测操作本身）。 */
function Buttons({ target }: { target: ActionTarget }) {
  const { trigger } = useTaskActions();
  return (
    <div>
      {ACTIONS.map((a) => (
        <button key={a} type="button" onClick={() => trigger(a, target)}>
          do-{a}
        </button>
      ))}
    </div>
  );
}

const press = (action: (typeof ACTIONS)[number]) =>
  fireEvent.click(screen.getByRole('button', { name: `do-${action}` }));

async function board(api: MockApi): Promise<BoardTask[]> {
  return (await api.board('r-orbit')).tasks;
}

/** 看板上一个在跑的需求，对着它的某个在跑的子任务。 */
async function runningSub(api: MockApi): Promise<{ task: BoardTask; sub: BoardSubtask }> {
  for (const task of await board(api)) {
    const sub = task.subtasks.find((s) => s.activity);
    if (sub) return { task, sub };
  }
  throw new Error('假数据里没有在跑的子任务');
}

const live = (reason = '好着'): LivenessFact => ({ verdict: 'live', reason });
const dead = (reason: string): LivenessFact => ({ verdict: 'dead', reason });

function route(routeId: string, over: Partial<RoutingLayerRoute> = {}): RoutingLayerRoute {
  const r: RoutingLayerRoute = {
    routeId,
    channelId: 'relay',
    channelName: '中转站',
    poolId: 'relay',
    hostId: 'claude-code',
    enabled: true,
    verdict: 'live',
    connect: live('探针探通了'),
    quota: live('额度读数新、窗口有余'),
    ban: live('没有禁令、开关开着'),
    exhausted: [],
    inFlight: 0,
    reserved: 0,
    maxConcurrency: 2,
    ...over,
  };
  const facts = [r.connect.verdict, r.quota.verdict, r.ban.verdict];
  return { ...r, verdict: facts.includes('dead') ? 'dead' : 'live' };
}

/** 这个用途下：一条活的（r-ok）、一条开关关着的（r-off）。 */
function layers(stage: StageKind): RoutingLayers {
  return {
    asOf: '2026-09-25T10:00:00Z',
    purposes: [
      {
        purpose: stage,
        verdict: 'live',
        problems: [],
        models: [
          {
            modelId: 'opus-5.5',
            displayName: 'Opus 5.5',
            family: 'claude',
            verdict: 'live',
            routes: [route('r-ok'), route('r-off', { ban: dead('开关关着（这条路由在它的模型下关着）') })],
          },
        ],
      },
    ],
  };
}

/** 假后端：taskAction / answerAsk 用 spy 记下请求（默认成功）。 */
function backend() {
  const api = createMockApi({ live: false });
  const taskAction = vi.spyOn(api, 'taskAction').mockResolvedValue(undefined);
  const answerAsk = vi.spyOn(api, 'answerAsk').mockResolvedValue(undefined);
  return { api, taskAction, answerAsk };
}

const FAILED = new ApiError(409, 'task_finished', '任务已经结束（done），不能再暂停');

describe('暂停、继续：点了就发请求，成功、失败都有话说', () => {
  test('暂停：发 {action:pause}，成功提示里写明「停在干净的点」', async () => {
    const { api, taskAction } = backend();
    const task = (await board(api))[0];
    if (!task) throw new Error('没有任务');
    renderApp(<Buttons target={targetOf(task)} />, { api });
    press('pause');
    await waitFor(() => expect(toast.success).toHaveBeenCalledTimes(1));
    expect(taskAction).toHaveBeenCalledExactlyOnceWith(task.id, { action: 'pause' });
    expect(toast.success).toHaveBeenCalledWith(`暂停：#${task.issueNumber}`, {
      description: '当前会话停在干净的点，做完的已提交',
    });
    expect(toast.error).not.toHaveBeenCalled();
  });

  test('继续：发 {action:resume}，成功提示没有多余的说明', async () => {
    const { api, taskAction } = backend();
    const task = (await board(api))[0];
    if (!task) throw new Error('没有任务');
    renderApp(<Buttons target={targetOf(task)} />, { api });
    press('resume');
    await waitFor(() => expect(toast.success).toHaveBeenCalledTimes(1));
    expect(taskAction).toHaveBeenCalledExactlyOnceWith(task.id, { action: 'resume' });
    expect(toast.success).toHaveBeenCalledWith(`继续：#${task.issueNumber}`, { description: undefined });
  });

  test.each([
    ['pause', '暂停'],
    ['resume', '继续'],
  ] as const)(
    '【故意造出的失败】%s 被后端拒（409）：弹「%s没成功」和后端的原因，不弹成功',
    async (action, label) => {
      const { api, taskAction } = backend();
      taskAction.mockRejectedValueOnce(FAILED);
      const task = (await board(api))[0];
      if (!task) throw new Error('没有任务');
      renderApp(<Buttons target={targetOf(task)} />, { api });
      press(action);
      await waitFor(() => expect(toast.error).toHaveBeenCalledTimes(1));
      expect(toast.error).toHaveBeenCalledWith(`${label}没成功`, { description: FAILED.message });
      expect(toast.success).not.toHaveBeenCalled();
    },
  );

  test('【故意造出的失败】断网（不是 ApiError 的错误）也照实弹出来', async () => {
    const { api, taskAction } = backend();
    taskAction.mockRejectedValueOnce(new TypeError('Failed to fetch'));
    const task = (await board(api))[0];
    if (!task) throw new Error('没有任务');
    renderApp(<Buttons target={targetOf(task)} />, { api });
    press('pause');
    await waitFor(() =>
      expect(toast.error).toHaveBeenCalledWith('暂停没成功', { description: 'Failed to fetch' }),
    );
  });
});

describe('叫停：先确认再发请求', () => {
  const open = async () => {
    const { api, taskAction } = backend();
    const task = (await board(api))[0];
    if (!task) throw new Error('没有任务');
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

describe('换模型：点哪条路由发哪条；选不了的不发', () => {
  const pick = async (index: number) => {
    await waitFor(() => expect(document.querySelectorAll('[cmdk-item]')).toHaveLength(2));
    const items = [...document.querySelectorAll('[cmdk-item]')];
    const item = items[index];
    if (!item) throw new Error(`没有第 ${index} 条候选`);
    fireEvent.click(item);
  };

  test('需求级：点活的那条，发 {action:reroute, routeId}，不带 subtaskId；对话框关掉、提示换成了', async () => {
    const { api, taskAction } = backend();
    const { task, sub } = await runningSub(api);
    const stage = sub.activity?.stage ?? 'execute';
    Object.assign(api, { routingLayers: async () => layers(stage) });
    const target: ActionTarget = {
      ...targetOf(task),
      activity: sub.activity,
    };
    renderApp(<Buttons target={target} />, { api });
    press('reroute');
    await pick(0);
    await waitFor(() => expect(toast.success).toHaveBeenCalledTimes(1));
    expect(taskAction).toHaveBeenCalledExactlyOnceWith(task.id, { action: 'reroute', routeId: 'r-ok' });
    expect(toast.success).toHaveBeenCalledWith(`换模型：#${task.issueNumber}`, { description: undefined });
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
  });

  test('子任务级：请求里带上 subtaskId，提示里写「子任务 X」', async () => {
    const { api, taskAction } = backend();
    const { task, sub } = await runningSub(api);
    Object.assign(api, { routingLayers: async () => layers(sub.activity?.stage ?? 'execute') });
    renderApp(<Buttons target={targetOf(task, sub)} />, { api });
    press('reroute');
    await pick(0);
    await waitFor(() => expect(taskAction).toHaveBeenCalledTimes(1));
    expect(taskAction).toHaveBeenCalledWith(task.id, {
      action: 'reroute',
      routeId: 'r-ok',
      subtaskId: sub.id,
    });
    await waitFor(() => expect(toast.success).toHaveBeenCalledTimes(1));
    expect(String(toast.success.mock.calls[0]?.[0])).toMatch(
      new RegExp(`^换模型：#${task.issueNumber} 子任务 [A-Z]$`),
    );
  });

  test('【故意造出的失败】选不了的那条（开关关着）：点了不发请求、没有提示', async () => {
    const { api, taskAction } = backend();
    const { task, sub } = await runningSub(api);
    Object.assign(api, { routingLayers: async () => layers(sub.activity?.stage ?? 'execute') });
    renderApp(<Buttons target={targetOf(task, sub)} />, { api });
    press('reroute');
    await pick(1);
    await act(async () => {
      await new Promise((r) => setTimeout(r, 20));
    });
    expect(taskAction).not.toHaveBeenCalled();
    expect(toast.success).not.toHaveBeenCalled();
    expect(toast.error).not.toHaveBeenCalled();
  });

  test('【故意造出的失败】后端拒了（路由不在线 422）：弹「换模型没成功」和原因，不弹成功', async () => {
    const { api, taskAction } = backend();
    taskAction.mockRejectedValueOnce(new ApiError(422, 'route_offline', '这条路由现在不在线'));
    const { task, sub } = await runningSub(api);
    Object.assign(api, { routingLayers: async () => layers(sub.activity?.stage ?? 'execute') });
    renderApp(<Buttons target={targetOf(task, sub)} />, { api });
    press('reroute');
    await pick(0);
    await waitFor(() =>
      expect(toast.error).toHaveBeenCalledWith('换模型没成功', { description: '这条路由现在不在线' }),
    );
    expect(toast.success).not.toHaveBeenCalled();
  });
});

describe('回答追问', () => {
  const OPTION = '发一条新消息';
  const open = async (api: MockApi) => {
    const task = (await board(api)).find((t) => t.state === 'asking');
    if (!task) throw new Error('假数据里没有在追问的需求');
    renderApp(<Buttons target={targetOf(task)} />, { api });
    press('answer');
    await screen.findByText(/再提醒时，要发一条新消息/);
    return task;
  };

  test('点选项：发 answerAsk(追问号, 选项原文)，提示回答了，请求之后重读任务详情', async () => {
    const { api, answerAsk } = backend();
    const taskRead = vi.spyOn(api, 'task');
    const task = await open(api);
    const before = taskRead.mock.calls.length;
    fireEvent.click(screen.getByRole('button', { name: new RegExp(OPTION) }));
    await waitFor(() => expect(toast.success).toHaveBeenCalledWith(`回答了 #${task.issueNumber} 的追问`));
    expect(answerAsk).toHaveBeenCalledExactlyOnceWith('ask-15-1', OPTION);
    await waitFor(() => expect(taskRead.mock.calls.length).toBeGreaterThan(before));
  });

  test('写一段话发出：请求里是去掉首尾空白的原文', async () => {
    const { api, answerAsk } = backend();
    await open(api);
    fireEvent.change(screen.getByPlaceholderText('或者直接写你的回答…'), {
      target: { value: '  顶上来，但别重排  ' },
    });
    fireEvent.click(screen.getByRole('button', { name: '发出回答' }));
    await waitFor(() => expect(answerAsk).toHaveBeenCalledTimes(1));
    expect(answerAsk).toHaveBeenCalledWith('ask-15-1', '顶上来，但别重排');
  });

  test('【故意造出的失败】什么都没写、或只有空白：发出回答点不了，硬提交也不发请求', async () => {
    const { api, answerAsk } = backend();
    await open(api);
    const send = screen.getByRole('button', { name: '发出回答' });
    expect(send).toHaveProperty('disabled', true);
    const box = screen.getByPlaceholderText('或者直接写你的回答…');
    fireEvent.change(box, { target: { value: '   ' } });
    expect(send).toHaveProperty('disabled', true);
    fireEvent.submit(box.closest('form') as HTMLFormElement);
    expect(answerAsk).not.toHaveBeenCalled();
  });

  test('【故意造出的失败】后端拒了（已经有人回答 409）：弹「回答没发出去」和原因，对话框还在、写的内容还在，不弹成功', async () => {
    const { api, answerAsk } = backend();
    answerAsk.mockRejectedValueOnce(new ApiError(409, 'already_answered', '这条追问已经有人回答了'));
    await open(api);
    const box = screen.getByPlaceholderText('或者直接写你的回答…');
    fireEvent.change(box, { target: { value: '顶上来' } });
    fireEvent.click(screen.getByRole('button', { name: '发出回答' }));
    await waitFor(() =>
      expect(toast.error).toHaveBeenCalledWith('回答没发出去', { description: '这条追问已经有人回答了' }),
    );
    expect(toast.success).not.toHaveBeenCalled();
    expect(screen.getByRole('dialog')).toBeTruthy();
    expect((screen.getByPlaceholderText('或者直接写你的回答…') as HTMLTextAreaElement).value).toBe('顶上来');
  });
});
