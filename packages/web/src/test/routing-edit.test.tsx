// @vitest-environment happy-dom
// 路由页调先后和开关（#1333，#1366 第二部分）：拖动、每行置顶 / 置底、聚焦后 Alt+上下键改先后（放下 / 点 / 按键就保存，失败回到原顺序）；
// 每条路由、每个模型、每个渠道各有开关，开关确认后才写；渠道关了，下面的路由显示「渠道已关」不能单独开；
// 停用账号池在额度页。池已经停着时，这条路由的开关锁住。选了远程环境整块置灰并写「去那台上操作」。
// 每行行尾「⋯」里有「上移一位」「下移一位」「置顶」「置底」（#1914 起收进菜单；用的还是 movePurposeModel / updateModelRoute 的 reorder，没有新接口）。
// #856 第 2 处：旧的 useUpdateChannel 仍不导出。新的渠道开关是 setChannelEnabled，不是那条已删的 PATCH。
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

import * as client from '../api/client';
import { ApiError } from '../api/client';
import { createMockApi } from '../api/mock/server';
import RoutingPage from '../routes/routing';
import { renderApp } from './harness';

/** 同一类提示的固定编号：连点时新的顶掉旧的，两次必须是这一个号。 */
const REORDER_SAVED_TOAST_ID = 'routing-reorder-saved';
const REORDER_FAILED_TOAST_ID = 'routing-reorder-failed';

beforeEach(() => {
  toast.success.mockClear();
  toast.error.mockClear();
});

afterEach(cleanup);

/** 写码用途下此刻画着的模型先后（显示名）。 */
const modelNames = () =>
  Array.from(document.querySelectorAll('li[data-model]')).map(
    (el) => el.querySelector('[data-row-name]')?.textContent,
  );

const modelRow = (modelId: string) => {
  const el = document.querySelector(`li[data-model="${modelId}"]`);
  if (!(el instanceof HTMLElement)) throw new Error(`页面上没有模型 ${modelId}`);
  return el;
};

const routeItem = (routeId: string) => {
  const el = document.querySelector(`[data-route="${routeId}"]`);
  if (!(el instanceof HTMLElement)) throw new Error(`页面上没有路由 ${routeId}`);
  return el;
};

const opened = async () => {
  await screen.findByRole('navigation', { name: '用途' });
  await waitFor(() => expect(document.querySelector('li[data-route]')).not.toBeNull());
};

const modelGrip = (modelId: string) => within(modelRow(modelId)).getByRole('button', { name: /^拖动 / });
const routeGrip = (routeId: string) => within(routeItem(routeId)).getByRole('button', { name: /^拖动 / });

/** 行尾「⋯」（路由页样板 #1914 起上移、下移、置顶、置底都在这里）。键盘 Enter 打开，不依赖 happy-dom 的指针事件。 */
const openRowMenu = async (row: HTMLElement) => {
  const trigger = within(row).getByRole('button', { name: /^更多操作：/ });
  trigger.focus();
  fireEvent.keyDown(trigger, { key: 'Enter' });
  return screen.findByRole('menu');
};

/** 在一行的「⋯」里点一项挪动（上移一位、下移一位、置顶、置底）。 */
const pickMove = async (row: HTMLElement, name: '上移一位' | '下移一位' | '置顶' | '置底') => {
  const menu = await openRowMenu(row);
  fireEvent.click(within(menu).getByRole('menuitem', { name }));
  await waitFor(() => expect(screen.queryByRole('menu')).toBeNull());
};

/** 一行「⋯」里某一项挪动是不是灰的（灰的写了原因）。看完把菜单关掉。 */
const moveDisabled = async (row: HTMLElement, name: '上移一位' | '下移一位' | '置顶' | '置底') => {
  const menu = await openRowMenu(row);
  const item = within(menu).getByRole('menuitem', { name });
  const off = item.getAttribute('data-disabled') !== null;
  fireEvent.keyDown(menu, { key: 'Escape' });
  await waitFor(() => expect(screen.queryByRole('menu')).toBeNull());
  return off;
};

/** Opus 5.5 下此刻画着的路由先后。 */
const routeOrder = () =>
  Array.from(document.querySelectorAll('ol[aria-label="Opus 5.5 的路由"] > li')).map((li) =>
    li.getAttribute('data-route'),
  );

/** 默认只列开着的。要看关着的、或要按完整顺序调先后时先点开。 */
const showAllRoutes = async () => {
  const btn = await screen.findByRole('button', { name: '显示全部' });
  if (btn.getAttribute('aria-pressed') !== 'true') fireEvent.click(btn);
};

const BEFORE = ['Opus 5.5', 'Kimi k3', 'Cursor Auto', 'Opus 5'];

describe('路由页：调先后和开关', () => {
  test('每行有上移、下移、置顶、置底；模型行、每条路由都有开关，开着的亮着、关着的灭着', async () => {
    renderApp(<RoutingPage />, { route: '/routing?purpose=execute' });
    await opened();
    expect(modelNames()).toEqual(BEFORE);
    // 四个挪动收在行尾「⋯」里，行里不再并排四个箭头（#1914）
    expect(within(modelRow('kimi-k3')).queryByRole('button', { name: /^(上移|下移|置顶|置底) / })).toBeNull();
    const menu = await openRowMenu(modelRow('kimi-k3'));
    for (const name of ['上移一位', '下移一位', '置顶', '置底']) {
      expect(within(menu).getByRole('menuitem', { name })).toBeTruthy();
    }
    fireEvent.keyDown(menu, { key: 'Escape' });
    expect((modelGrip('opus-5.5') as HTMLButtonElement).disabled).toBe(false);
    expect(
      within(modelRow('opus-5.5'))
        .getByRole('switch', { name: 'Opus 5.5 的开关' })
        .getAttribute('aria-checked'),
    ).toBe('true');
    // 选中的 Opus 5.5 下三条：前两条开着、中转那条关着（关着的默认不列，点「显示全部」才出来）
    await showAllRoutes();
    expect(within(routeItem('r-ca-opus')).getByRole('switch').getAttribute('aria-checked')).toBe('true');
    expect(within(routeItem('r-rl-opus')).getByRole('switch').getAttribute('aria-checked')).toBe('false');
  });

  test('上移、下移：点一下挪一格并保存；已在最前的上移是灰的，点了不写', async () => {
    const { api } = renderApp(<RoutingPage />, { route: '/routing?purpose=execute' });
    const spy = vi.spyOn(api, 'movePurposeModel');
    await opened();
    expect(await moveDisabled(modelRow('opus-5.5'), '上移一位')).toBe(true);
    expect(spy).not.toHaveBeenCalled();

    await pickMove(modelRow('opus-5.5'), '下移一位');
    await waitFor(() => expect(modelNames()).toEqual(['Kimi k3', 'Opus 5.5', 'Cursor Auto', 'Opus 5']));
    expect(spy).toHaveBeenCalledExactlyOnceWith('execute', 'opus-5.5', {
      order: ['kimi-k3', 'opus-5.5', 'cursor-auto', 'opus-5'],
      expected: ['opus-5.5', 'kimi-k3', 'cursor-auto', 'opus-5'],
    });

    await waitFor(() => expect(modelGrip('opus-5.5').getAttribute('aria-disabled')).toBeNull());
    await pickMove(modelRow('opus-5.5'), '上移一位');
    await waitFor(() => expect(modelNames()).toEqual(BEFORE));
  });

  test('路由也有上移、下移：走 updateModelRoute 的 reorder', async () => {
    const { api } = renderApp(<RoutingPage />, { route: '/routing?purpose=execute' });
    const spy = vi.spyOn(api, 'updateModelRoute');
    await opened();
    await showAllRoutes();
    expect(routeOrder()).toEqual(['r-ca-opus', 'r-cb-opus', 'r-rl-opus']);
    await pickMove(routeItem('r-ca-opus'), '下移一位');
    await waitFor(() => expect(routeOrder()).toEqual(['r-cb-opus', 'r-ca-opus', 'r-rl-opus']));
    expect(spy).toHaveBeenCalledTimes(1);
    expect(spy.mock.calls[0]?.[2]).toMatchObject({ op: 'reorder' });
  });

  test('Alt+下键把模型下挪一格：直接带看到的顺序保存；不按 Alt 的方向键什么也不做', async () => {
    const { api } = renderApp(<RoutingPage />, { route: '/routing?purpose=execute' });
    const spy = vi.spyOn(api, 'movePurposeModel');
    await opened();
    expect(modelNames()).toEqual(BEFORE);

    fireEvent.keyDown(modelGrip('opus-5.5'), { key: 'ArrowDown' });
    expect(modelNames()).toEqual(BEFORE);
    expect(spy).not.toHaveBeenCalled();
    expect(screen.queryByRole('alertdialog')).toBeNull();

    fireEvent.keyDown(modelGrip('opus-5.5'), { key: 'ArrowDown', altKey: true });
    await waitFor(() => expect(modelNames()).toEqual(['Kimi k3', 'Opus 5.5', 'Cursor Auto', 'Opus 5']));
    expect(spy).toHaveBeenCalledExactlyOnceWith('execute', 'opus-5.5', {
      order: ['kimi-k3', 'opus-5.5', 'cursor-auto', 'opus-5'],
      expected: ['opus-5.5', 'kimi-k3', 'cursor-auto', 'opus-5'],
    });
    const layers = await api.routingLayers();
    expect(layers.purposes.find((p) => p.purpose === 'execute')?.models.map((m) => m.modelId)).toEqual([
      'kimi-k3',
      'opus-5.5',
      'cursor-auto',
      'opus-5',
    ]);
    const entry = (await api.audit()).items.find((a) => a.action === 'routing.order.move');
    expect(entry?.target).toBe('stage:execute');
  });

  test('Alt+End 置底、Alt+Home 置顶；在最前再按 Alt+上键不写', async () => {
    const { api } = renderApp(<RoutingPage />, { route: '/routing?purpose=execute' });
    const spy = vi.spyOn(api, 'movePurposeModel');
    await opened();
    fireEvent.keyDown(modelGrip('opus-5.5'), { key: 'ArrowUp', altKey: true });
    expect(spy).not.toHaveBeenCalled();
    fireEvent.keyDown(modelGrip('opus-5.5'), { key: 'End', altKey: true });
    await waitFor(() => expect(modelNames()).toEqual(['Kimi k3', 'Cursor Auto', 'Opus 5', 'Opus 5.5']));
    // 写完（保存中的按钮是灰的）才能再按
    await waitFor(() => expect(modelGrip('opus-5.5').getAttribute('aria-disabled')).toBeNull());
    fireEvent.keyDown(modelGrip('opus-5.5'), { key: 'Home', altKey: true });
    await waitFor(() => expect(modelNames()).toEqual(BEFORE));
    expect(spy).toHaveBeenCalledTimes(2);
  });

  test('置顶、置底：点一下就保存；已经在最前的置顶是灰的，点了不写', async () => {
    const { api } = renderApp(<RoutingPage />, { route: '/routing?purpose=execute' });
    const spy = vi.spyOn(api, 'movePurposeModel');
    await opened();

    expect(await moveDisabled(modelRow('opus-5.5'), '置顶')).toBe(true);
    expect(spy).not.toHaveBeenCalled();

    await pickMove(modelRow('cursor-auto'), '置顶');
    await waitFor(() => expect(modelNames()).toEqual(['Cursor Auto', 'Opus 5.5', 'Kimi k3', 'Opus 5']));
    expect(spy).toHaveBeenLastCalledWith('execute', 'cursor-auto', {
      order: ['cursor-auto', 'opus-5.5', 'kimi-k3', 'opus-5'],
      expected: ['opus-5.5', 'kimi-k3', 'cursor-auto', 'opus-5'],
    });

    await waitFor(() => expect(modelGrip('cursor-auto').getAttribute('aria-disabled')).toBeNull());
    await pickMove(modelRow('cursor-auto'), '置底');
    await waitFor(() => expect(modelNames()).toEqual(['Opus 5.5', 'Kimi k3', 'Opus 5', 'Cursor Auto']));
    expect(spy).toHaveBeenLastCalledWith('execute', 'cursor-auto', {
      order: ['opus-5.5', 'kimi-k3', 'opus-5', 'cursor-auto'],
      expected: ['cursor-auto', 'opus-5.5', 'kimi-k3', 'opus-5'],
    });
    expect(spy).toHaveBeenCalledTimes(2);
  });

  test('鼠标拖动只标落点，放下才保存', async () => {
    const { api } = renderApp(<RoutingPage />, { route: '/routing?purpose=execute' });
    const spy = vi.spyOn(api, 'movePurposeModel');
    await opened();
    const kimi = modelRow('kimi-k3');
    // happy-dom 把 window.DragEvent 设成普通 Event，构造时丢掉 clientY。换成带坐标的鼠标事件再拖。
    const view = kimi.ownerDocument.defaultView;
    if (view && (view.DragEvent as unknown) === view.Event) {
      view.DragEvent = class extends view.MouseEvent {} as unknown as typeof view.DragEvent;
    }
    const below = kimi.getBoundingClientRect().bottom + 1;
    fireEvent.dragStart(modelGrip('opus-5.5'));
    fireEvent.dragOver(kimi, { clientY: below });
    expect(kimi.getAttribute('data-drop')).toBe('after');
    expect(spy).not.toHaveBeenCalled();
    expect(modelNames()).toEqual(BEFORE);
    fireEvent.drop(kimi, { clientY: below });
    await waitFor(() => expect(modelNames()).toEqual(['Kimi k3', 'Opus 5.5', 'Cursor Auto', 'Opus 5']));
    expect(spy).toHaveBeenCalledExactlyOnceWith('execute', 'opus-5.5', {
      order: ['kimi-k3', 'opus-5.5', 'cursor-auto', 'opus-5'],
      expected: ['opus-5.5', 'kimi-k3', 'cursor-auto', 'opus-5'],
    });
  });

  test('连点改先后：已改先后和没改成各用固定提示编号，两次是同一个号', async () => {
    const { api } = renderApp(<RoutingPage />, { route: '/routing?purpose=execute' });
    await opened();

    await pickMove(modelRow('opus-5.5'), '下移一位');
    await waitFor(() => expect(toast.success).toHaveBeenCalledTimes(1));
    await waitFor(() => expect(modelGrip('opus-5.5').getAttribute('aria-disabled')).toBeNull());
    await pickMove(modelRow('kimi-k3'), '下移一位');
    await waitFor(() => expect(toast.success).toHaveBeenCalledTimes(2));
    await showAllRoutes();
    await waitFor(() => expect(routeGrip('r-ca-opus').getAttribute('aria-disabled')).toBeNull());
    await pickMove(routeItem('r-ca-opus'), '下移一位');
    await waitFor(() => expect(toast.success).toHaveBeenCalledTimes(3));
    for (const call of toast.success.mock.calls) {
      expect(call[0]).toBe('已改先后');
      expect(call[1]).toEqual({ id: REORDER_SAVED_TOAST_ID });
    }

    vi.spyOn(api, 'movePurposeModel').mockRejectedValue(
      new ApiError(409, 'conflict', '这个用途下模型的先后刚被别人改过，刷新后再改'),
    );
    await waitFor(() => expect(modelGrip('opus-5.5').getAttribute('aria-disabled')).toBeNull());
    await pickMove(modelRow('opus-5.5'), '下移一位');
    await waitFor(() => expect(toast.error).toHaveBeenCalledTimes(1));
    await waitFor(() => expect(modelGrip('opus-5.5').getAttribute('aria-disabled')).toBeNull());
    await pickMove(modelRow('opus-5.5'), '下移一位');
    await waitFor(() => expect(toast.error).toHaveBeenCalledTimes(2));
    for (const call of toast.error.mock.calls) {
      expect(call[0]).toBe('没改成');
      expect(call[1]).toMatchObject({ id: REORDER_FAILED_TOAST_ID });
    }
    expect(REORDER_FAILED_TOAST_ID).not.toBe(REORDER_SAVED_TOAST_ID);
  });

  test('【故意造出的失败】先后没保存成：回到原来的顺序，并弹出原因', async () => {
    const { api } = renderApp(<RoutingPage />, { route: '/routing?purpose=execute' });
    vi.spyOn(api, 'movePurposeModel').mockRejectedValue(
      new ApiError(409, 'conflict', '这个用途下模型的先后刚被别人改过，刷新后再改'),
    );
    await opened();
    fireEvent.keyDown(modelGrip('opus-5.5'), { key: 'ArrowDown', altKey: true });
    // 写的时候先按新顺序画着，失败再回去
    expect(modelNames()).toEqual(['Kimi k3', 'Opus 5.5', 'Cursor Auto', 'Opus 5']);
    await waitFor(() =>
      expect(toast.error).toHaveBeenCalledWith('没改成', {
        id: REORDER_FAILED_TOAST_ID,
        description: '这个用途下模型的先后刚被别人改过，刷新后再改',
      }),
    );
    await waitFor(() => expect(modelNames()).toEqual(BEFORE));
    expect(document.querySelector('ol[aria-label="模型"]')?.getAttribute('data-pending')).toBeNull();
  });

  test('Alt+上键把一条路由上挪：直接写整段新顺序', async () => {
    const { api } = renderApp(<RoutingPage />, { route: '/routing?purpose=execute' });
    const spy = vi.spyOn(api, 'updateModelRoute');
    await opened();
    await showAllRoutes();
    expect(routeOrder()).toEqual(['r-ca-opus', 'r-cb-opus', 'r-rl-opus']);
    fireEvent.keyDown(routeGrip('r-cb-opus'), { key: 'ArrowUp' });
    expect(spy).not.toHaveBeenCalled();
    fireEvent.keyDown(routeGrip('r-cb-opus'), { key: 'ArrowUp', altKey: true });
    await waitFor(() => expect(routeOrder()).toEqual(['r-cb-opus', 'r-ca-opus', 'r-rl-opus']));
    expect(spy).toHaveBeenCalledExactlyOnceWith('opus-5.5', 'r-cb-opus', {
      op: 'reorder',
      order: ['r-cb-opus', 'r-ca-opus', 'r-rl-opus'],
      expected: ['r-ca-opus', 'r-cb-opus', 'r-rl-opus'],
    });
  });

  test('路由也有置顶、置底：把中转那条置顶', async () => {
    const { api } = renderApp(<RoutingPage />, { route: '/routing?purpose=execute' });
    const spy = vi.spyOn(api, 'updateModelRoute');
    await opened();
    await showAllRoutes();
    await pickMove(routeItem('r-rl-opus'), '置顶');
    await waitFor(() => expect(routeOrder()).toEqual(['r-rl-opus', 'r-ca-opus', 'r-cb-opus']));
    expect(spy).toHaveBeenCalledExactlyOnceWith('opus-5.5', 'r-rl-opus', {
      op: 'reorder',
      order: ['r-rl-opus', 'r-ca-opus', 'r-cb-opus'],
      expected: ['r-ca-opus', 'r-cb-opus', 'r-rl-opus'],
    });
  });

  test('渠道开关：关一条、再开一条中转；确认前不写，写的时候带看到的开关，页面上「关着」跟着变', async () => {
    const { api } = renderApp(<RoutingPage />, { route: '/routing?purpose=execute' });
    const spy = vi.spyOn(api, 'updateModelRoute');
    await opened();
    await showAllRoutes();

    fireEvent.click(within(routeItem('r-cb-opus')).getByRole('switch'));
    const dialog = await screen.findByRole('alertdialog');
    expect(dialog.textContent).toContain('关闭 Opus 5.5 下的');
    expect(spy).not.toHaveBeenCalled();
    fireEvent.click(within(dialog).getByRole('button', { name: '关闭' }));
    await waitFor(() => expect(routeItem('r-cb-opus').textContent).toContain('关着'));
    expect(spy).toHaveBeenLastCalledWith('opus-5.5', 'r-cb-opus', {
      op: 'enable',
      enabled: false,
      expected: true,
    });

    fireEvent.click(within(routeItem('r-rl-opus')).getByRole('switch'));
    fireEvent.click(within(await screen.findByRole('alertdialog')).getByRole('button', { name: '开启' }));
    await waitFor(() =>
      expect(within(routeItem('r-rl-opus')).getByRole('switch').getAttribute('aria-checked')).toBe('true'),
    );
    expect(spy).toHaveBeenLastCalledWith('opus-5.5', 'r-rl-opus', {
      op: 'enable',
      enabled: true,
      expected: false,
    });
  });

  test('【故意造出的失败】渠道开关被后端拒：弹「没改成」和后端那句，开关还是原来的', async () => {
    const { api } = renderApp(<RoutingPage />, { route: '/routing?purpose=execute' });
    vi.spyOn(api, 'updateModelRoute').mockRejectedValue(
      new ApiError(409, 'conflict', '这条路由的开关刚被别人改过，刷新后再改'),
    );
    await opened();
    fireEvent.click(within(routeItem('r-cb-opus')).getByRole('switch'));
    const dialog = await screen.findByRole('alertdialog');
    fireEvent.click(within(dialog).getByRole('button', { name: '关闭' }));
    await waitFor(() =>
      expect(toast.error).toHaveBeenCalledWith('没改成', {
        id: REORDER_FAILED_TOAST_ID,
        description: '这条路由的开关刚被别人改过，刷新后再改',
      }),
    );
    expect(toast.success).not.toHaveBeenCalled();
    // 失败留在原处（#2012 的 onConfirm）：框里写原因，开关还是原来的
    expect(within(dialog).getByRole('alert').textContent).toContain('这条路由的开关刚被别人改过');
    fireEvent.click(within(dialog).getByRole('button', { name: '先不' }));
    await waitFor(() => expect(screen.queryByRole('alertdialog')).toBeNull());
    expect(within(routeItem('r-cb-opus')).getByRole('switch').getAttribute('aria-checked')).toBe('true');
  });

  test('模型开关：关掉 Opus 5.5，它下面每条路由都关，操作记录记 routing.model.enable', async () => {
    const { api } = renderApp(<RoutingPage />, { route: '/routing?purpose=execute' });
    const spy = vi.spyOn(api, 'setModelEnabled');
    await opened();
    fireEvent.click(within(modelRow('opus-5.5')).getByRole('switch', { name: 'Opus 5.5 的开关' }));
    const dialog = await screen.findByRole('alertdialog');
    expect(dialog.textContent).toContain('关闭模型「Opus 5.5」');
    expect(dialog.textContent).toContain('所有用途');
    expect(spy).not.toHaveBeenCalled();
    fireEvent.click(within(dialog).getByRole('button', { name: '关闭' }));
    await waitFor(() =>
      expect(
        within(modelRow('opus-5.5'))
          .getByRole('switch', { name: 'Opus 5.5 的开关' })
          .getAttribute('aria-checked'),
      ).toBe('false'),
    );
    await showAllRoutes();
    expect(within(routeItem('r-ca-opus')).getByRole('switch').getAttribute('aria-checked')).toBe('false');
    expect(within(routeItem('r-cb-opus')).getByRole('switch').getAttribute('aria-checked')).toBe('false');
    expect(spy).toHaveBeenCalledExactlyOnceWith('opus-5.5', {
      enabled: false,
      expectedEnabled: ['r-ca-opus', 'r-cb-opus'],
    });
    const layers = await api.routingLayers();
    const off = (purpose: string) =>
      layers.purposes
        .find((p) => p.purpose === purpose)
        ?.models.find((m) => m.modelId === 'opus-5.5')
        ?.routes.every((r) => r.enabled === false);
    expect(off('execute')).toBe(true);
    expect(off('ui')).toBe(true);
    const entry = (await api.audit()).items.find((a) => a.action === 'routing.model.enable');
    expect(entry?.target).toBe('model:opus-5.5');
  });

  test('渠道关了：下面的路由显示「渠道已关」，不能单独打开；别的渠道的路由还能开', async () => {
    const { api } = renderApp(<RoutingPage />, { route: '/routing?tab=channels' });
    const spy = vi.spyOn(api, 'setChannelEnabled');
    fireEvent.click(await screen.findByRole('switch', { name: '中转站 的开关' }));
    const dialog = await screen.findByRole('alertdialog');
    expect(dialog.textContent).toContain('关闭渠道「中转站」');
    expect(spy).not.toHaveBeenCalled();
    fireEvent.click(within(dialog).getByRole('button', { name: '关闭' }));
    // 选中中转站看它的路由：渠道已关，没有开关
    fireEvent.click(await screen.findByRole('button', { name: '查看 中转站 的路由' }));
    await showAllRoutes();
    await waitFor(() => expect(routeItem('r-rl-opus').textContent).toContain('渠道已关'));
    expect(within(routeItem('r-rl-opus')).queryByRole('switch')).toBeNull();
    expect(spy).toHaveBeenCalledExactlyOnceWith('ch-relay', { enabled: false, expected: true });
    const entry = (await api.audit()).items.find((a) => a.action === 'channel.disable');
    expect(entry?.target).toBe('channel:ch-relay');
    // 别的渠道的路由还有开关
    fireEvent.click(screen.getByRole('button', { name: '查看 Claude 订阅 的路由' }));
    await waitFor(() =>
      expect(within(routeItem('r-ca-opus')).getByRole('switch').getAttribute('aria-checked')).toBe('true'),
    );
  });

  test('额度页停用的池：只锁这个池的路由开关，菜单里没有暂停', async () => {
    const api = createMockApi({ live: false });
    await api.updateSetting('engine.poolHolds', {
      value: {
        'claude-a': {
          reason: '被封号',
          decidedBy: '创始人',
          revokeWhen: '创始人在额度页打开这个池',
        },
      },
      version: 0,
    });
    renderApp(<RoutingPage />, { api, route: '/routing?purpose=execute' });
    await opened();
    const row = routeItem('r-ca-opus');
    await waitFor(() => expect(row.textContent).toContain('池暂停'));
    expect((within(row).getByRole('switch') as HTMLButtonElement).disabled).toBe(true);
    expect((within(routeItem('r-cb-opus')).getByRole('switch') as HTMLButtonElement).disabled).toBe(false);
    const menu = await openRowMenu(row);
    expect(within(menu).queryByRole('menuitem', { name: /暂停账号池|撤回账号池|整池暂停/ })).toBeNull();
  });

  test('【故意造出的失败】选了远程环境（?node=）：整块置灰、写「去那台上操作」，拖动、置顶置底和开关都点不了', async () => {
    renderApp(<RoutingPage />, { route: '/routing?purpose=execute&node=wsl' });
    await opened();
    expect(screen.getByText(/去那台上操作/).textContent).toContain('去那台上操作');
    for (const b of screen.getAllByRole('button', { name: /^拖动 / })) {
      expect((b as HTMLButtonElement).disabled).toBe(true);
    }
    for (const sw of screen.getAllByRole('switch')) {
      expect((sw as HTMLButtonElement).disabled).toBe(true);
    }
    // 「⋯」里的置顶、置底、档位、移出也都是灰的，悬停写「去那台上操作」
    const modelMenu = await openRowMenu(modelRow('kimi-k3'));
    for (const item of within(modelMenu).getAllByRole('menuitem')) {
      expect(item.getAttribute('data-disabled')).not.toBeNull();
    }
    for (const item of within(modelMenu).getAllByRole('menuitemradio')) {
      expect(item.getAttribute('data-disabled')).not.toBeNull();
    }
    fireEvent.keyDown(modelMenu, { key: 'Escape' });
    await waitFor(() => expect(screen.queryByRole('menu')).toBeNull());
    await waitFor(() => expect(routeItem('r-ca-opus').querySelector('[data-row-menu]')).not.toBeNull());
    const routeMenu = await openRowMenu(routeItem('r-ca-opus'));
    expect(within(routeMenu).queryByRole('menuitem', { name: /暂停账号池/ })).toBeNull();
    for (const item of within(routeMenu).getAllByRole('menuitem')) {
      expect(item.getAttribute('data-disabled')).not.toBeNull();
    }
  });
});

describe('渠道总开关 useUpdateChannel（#856 第 2 处）', () => {
  test('有意撤掉：前端不再导出。页面上的渠道开关走 setChannelEnabled，不是这条旧接口', () => {
    expect('useUpdateChannel' in client).toBe(false);
    expect('useSetChannelEnabled' in client).toBe(true);
  });
});
