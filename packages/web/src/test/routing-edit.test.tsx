// @vitest-environment happy-dom
// 路由页调先后和开关（#1333）：拖动改先后（鼠标放下才保存，键盘方向键先预览、回车才保存，失败回到原顺序）；
// 每条路由、每个模型、每个渠道各有开关，开关确认后才写；渠道关了，下面的路由显示「渠道已关」不能单独开；
// 整池暂停在对应池旁边设和撤。选了远程环境整块置灰并写「去那台上操作」。
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
import RoutingPage from '../routes/routing';
import { renderApp } from './harness';

beforeEach(() => {
  toast.success.mockClear();
  toast.error.mockClear();
});

afterEach(cleanup);

/** 写码用途下此刻画着的模型先后（显示名）。 */
const modelNames = () =>
  Array.from(document.querySelectorAll('li[data-model]')).map(
    (el) => el.querySelector('.text-sm.font-semibold')?.textContent,
  );

const modelBlock = (modelId: string) => {
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
  await waitFor(() => expect(document.querySelector('li[data-model]')).not.toBeNull());
};

const modelHandle = (modelId: string) =>
  within(modelBlock(modelId)).getByRole('button', { name: /动手里的先后）$/ });

const routeHandle = (routeId: string) => within(routeItem(routeId)).getByRole('button', { name: /^拖动 / });

const routeOrder = () =>
  within(modelBlock('opus-5.5'))
    .getAllByRole('listitem')
    .map((li) => li.getAttribute('data-route'))
    .filter(Boolean);

describe('路由页：调先后和开关', () => {
  test('没有逐格上移下移；模型、渠道、每条路由都有开关，开着的亮着、关着的灭着', async () => {
    renderApp(<RoutingPage />, { route: '/routing?purpose=execute' });
    await opened();
    expect(modelNames()).toEqual(['Opus 5.5', 'Kimi k3', 'Cursor Auto', 'Opus 5']);
    expect(screen.queryByRole('button', { name: /上移$/ })).toBeNull();
    expect(screen.queryByRole('button', { name: /下移$/ })).toBeNull();
    expect((modelHandle('opus-5.5') as HTMLButtonElement).disabled).toBe(false);
    expect(
      within(modelBlock('opus-5.5'))
        .getByRole('switch', { name: 'Opus 5.5 的开关' })
        .getAttribute('aria-checked'),
    ).toBe('true');
    expect(screen.getByRole('switch', { name: '中转站 的开关' }).getAttribute('aria-checked')).toBe('true');
    // Opus 5.5 下三条：前两条开着、中转那条关着
    expect(within(routeItem('r-ca-opus')).getByRole('switch').getAttribute('aria-checked')).toBe('true');
    expect(within(routeItem('r-rl-opus')).getByRole('switch').getAttribute('aria-checked')).toBe('false');
  });

  test('键盘把模型下挪一格：方向键只改预览，回车才带看到的顺序保存', async () => {
    const { api } = renderApp(<RoutingPage />, { route: '/routing?purpose=execute' });
    const spy = vi.spyOn(api, 'movePurposeModel');
    await opened();
    const before = ['Opus 5.5', 'Kimi k3', 'Cursor Auto', 'Opus 5'];
    expect(modelNames()).toEqual(before);

    fireEvent.keyDown(modelHandle('opus-5.5'), { key: 'ArrowDown' });
    expect(modelNames()).toEqual(['Kimi k3', 'Opus 5.5', 'Cursor Auto', 'Opus 5']);
    expect(document.querySelector('ol[aria-label="模型"]')?.getAttribute('data-pending')).toBe('true');
    expect(spy).not.toHaveBeenCalled();
    expect(screen.queryByRole('alertdialog')).toBeNull();

    fireEvent.keyDown(modelHandle('opus-5.5'), { key: 'Escape' });
    expect(modelNames()).toEqual(before);
    expect(spy).not.toHaveBeenCalled();

    fireEvent.keyDown(modelHandle('opus-5.5'), { key: 'ArrowDown' });
    fireEvent.keyDown(modelHandle('opus-5.5'), { key: 'Enter' });
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

  test('鼠标拖动只标落点，放下才保存', async () => {
    const { api } = renderApp(<RoutingPage />, { route: '/routing?purpose=execute' });
    const spy = vi.spyOn(api, 'movePurposeModel');
    await opened();
    const kimi = modelBlock('kimi-k3');
    // happy-dom 把 window.DragEvent 设成普通 Event，构造时丢掉 clientY。换成带坐标的鼠标事件再拖。
    const view = kimi.ownerDocument.defaultView;
    if (view && (view.DragEvent as unknown) === view.Event) {
      view.DragEvent = class extends view.MouseEvent {} as unknown as typeof view.DragEvent;
    }
    const below = kimi.getBoundingClientRect().bottom + 1;
    fireEvent.dragStart(modelHandle('opus-5.5'));
    fireEvent.dragOver(kimi, { clientY: below });
    expect(kimi.getAttribute('data-drop')).toBe('after');
    expect(spy).not.toHaveBeenCalled();
    expect(modelNames()).toEqual(['Opus 5.5', 'Kimi k3', 'Cursor Auto', 'Opus 5']);
    fireEvent.drop(kimi, { clientY: below });
    await waitFor(() => expect(modelNames()).toEqual(['Kimi k3', 'Opus 5.5', 'Cursor Auto', 'Opus 5']));
    expect(spy).toHaveBeenCalledExactlyOnceWith('execute', 'opus-5.5', {
      order: ['kimi-k3', 'opus-5.5', 'cursor-auto', 'opus-5'],
      expected: ['opus-5.5', 'kimi-k3', 'cursor-auto', 'opus-5'],
    });
  });

  test('【故意造出的失败】先后没保存成：回到原来的顺序，并弹出原因', async () => {
    const { api } = renderApp(<RoutingPage />, { route: '/routing?purpose=execute' });
    vi.spyOn(api, 'movePurposeModel').mockRejectedValue(
      new ApiError(409, 'conflict', '这个用途下模型的先后刚被别人改过，刷新后再改'),
    );
    await opened();
    fireEvent.keyDown(modelHandle('opus-5.5'), { key: 'ArrowDown' });
    expect(modelNames()).toEqual(['Kimi k3', 'Opus 5.5', 'Cursor Auto', 'Opus 5']);
    fireEvent.keyDown(modelHandle('opus-5.5'), { key: 'Enter' });
    await waitFor(() =>
      expect(toast.error).toHaveBeenCalledWith('没改成', {
        description: '这个用途下模型的先后刚被别人改过，刷新后再改',
      }),
    );
    expect(modelNames()).toEqual(['Opus 5.5', 'Kimi k3', 'Cursor Auto', 'Opus 5']);
    expect(document.querySelector('ol[aria-label="模型"]')?.getAttribute('data-pending')).toBeNull();
  });

  test('键盘把一条路由上挪：回车才写整段新顺序', async () => {
    const { api } = renderApp(<RoutingPage />, { route: '/routing?purpose=execute' });
    const spy = vi.spyOn(api, 'updateModelRoute');
    await opened();
    expect(routeOrder()).toEqual(['r-ca-opus', 'r-cb-opus', 'r-rl-opus']);
    fireEvent.keyDown(routeHandle('r-cb-opus'), { key: 'ArrowUp' });
    expect(routeOrder()).toEqual(['r-cb-opus', 'r-ca-opus', 'r-rl-opus']);
    expect(spy).not.toHaveBeenCalled();
    fireEvent.keyDown(routeHandle('r-cb-opus'), { key: 'Enter' });
    await waitFor(() => expect(routeOrder()).toEqual(['r-cb-opus', 'r-ca-opus', 'r-rl-opus']));
    expect(spy).toHaveBeenCalledExactlyOnceWith('opus-5.5', 'r-cb-opus', {
      op: 'reorder',
      order: ['r-cb-opus', 'r-ca-opus', 'r-rl-opus'],
      expected: ['r-ca-opus', 'r-cb-opus', 'r-rl-opus'],
    });
  });

  test('渠道开关：关一条、再开一条中转；确认前不写，写的时候带看到的开关，页面上「关着」跟着变', async () => {
    const { api } = renderApp(<RoutingPage />, { route: '/routing?purpose=execute' });
    const spy = vi.spyOn(api, 'updateModelRoute');
    await opened();

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
    fireEvent.click(within(await screen.findByRole('alertdialog')).getByRole('button', { name: '关闭' }));
    await waitFor(() =>
      expect(toast.error).toHaveBeenCalledWith('没改成', {
        description: '这条路由的开关刚被别人改过，刷新后再改',
      }),
    );
    expect(toast.success).not.toHaveBeenCalled();
    expect(within(routeItem('r-cb-opus')).getByRole('switch').getAttribute('aria-checked')).toBe('true');
  });

  test('模型开关：关掉 Opus 5.5，它下面每条路由都关，操作记录记 routing.model.enable', async () => {
    const { api } = renderApp(<RoutingPage />, { route: '/routing?purpose=execute' });
    const spy = vi.spyOn(api, 'setModelEnabled');
    await opened();
    fireEvent.click(within(modelBlock('opus-5.5')).getByRole('switch', { name: 'Opus 5.5 的开关' }));
    const dialog = await screen.findByRole('alertdialog');
    expect(dialog.textContent).toContain('关闭模型「Opus 5.5」');
    expect(dialog.textContent).toContain('所有用途');
    expect(spy).not.toHaveBeenCalled();
    fireEvent.click(within(dialog).getByRole('button', { name: '关闭' }));
    await waitFor(() =>
      expect(
        within(modelBlock('opus-5.5'))
          .getByRole('switch', { name: 'Opus 5.5 的开关' })
          .getAttribute('aria-checked'),
      ).toBe('false'),
    );
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
    const { api } = renderApp(<RoutingPage />, { route: '/routing?purpose=execute' });
    const spy = vi.spyOn(api, 'setChannelEnabled');
    await opened();
    fireEvent.click(screen.getByRole('switch', { name: '中转站 的开关' }));
    const dialog = await screen.findByRole('alertdialog');
    expect(dialog.textContent).toContain('关闭渠道「中转站」');
    expect(spy).not.toHaveBeenCalled();
    fireEvent.click(within(dialog).getByRole('button', { name: '关闭' }));
    await waitFor(() => expect(routeItem('r-rl-opus').textContent).toContain('渠道已关'));
    expect(within(routeItem('r-rl-opus')).queryByRole('switch')).toBeNull();
    expect(within(routeItem('r-ca-opus')).getByRole('switch').getAttribute('aria-checked')).toBe('true');
    expect(spy).toHaveBeenCalledExactlyOnceWith('ch-relay', { enabled: false, expected: true });
    const entry = (await api.audit()).items.find((a) => a.action === 'channel.disable');
    expect(entry?.target).toBe('channel:ch-relay');
  });

  test('整池暂停：没填完不能设；设了只锁这个池的路由；没写原因撤不掉', async () => {
    const { api } = renderApp(<RoutingPage />, { route: '/routing?purpose=execute' });
    const spy = vi.spyOn(api, 'updateSetting');
    await opened();
    const row = routeItem('r-ca-opus');
    const pause = await within(row).findByRole('button', { name: '暂停账号池 claude-a' });
    fireEvent.click(pause);
    const confirm = within(row).getByRole('button', { name: '确认暂停' });
    expect((confirm as HTMLButtonElement).disabled).toBe(true);
    fireEvent.click(confirm);
    expect(spy).not.toHaveBeenCalled();

    fireEvent.change(within(row).getByLabelText('为什么停'), { target: { value: '324 账号被封' } });
    fireEvent.change(within(row).getByLabelText('谁拍的'), { target: { value: '创始人 2026-10-08' } });
    fireEvent.change(within(row).getByLabelText('什么条件下撤'), { target: { value: '账号解封' } });
    fireEvent.change(within(row).getByLabelText('最迟复查日期'), { target: { value: '2026-12-01' } });
    expect((within(row).getByRole('button', { name: '确认暂停' }) as HTMLButtonElement).disabled).toBe(false);
    fireEvent.click(within(row).getByRole('button', { name: '确认暂停' }));
    await waitFor(() => expect(row.textContent).toContain('整池暂停'));
    expect((within(row).getByRole('switch') as HTMLButtonElement).disabled).toBe(true);
    expect((within(routeItem('r-cb-opus')).getByRole('switch') as HTMLButtonElement).disabled).toBe(false);

    fireEvent.click(within(row).getByRole('button', { name: '撤回账号池 claude-a 的整池暂停' }));
    const revoke = within(row).getByRole('button', { name: '确认撤回' });
    expect((revoke as HTMLButtonElement).disabled).toBe(true);
    fireEvent.click(revoke);
    expect((within(row).getByRole('switch') as HTMLButtonElement).disabled).toBe(true);

    fireEvent.change(within(row).getByLabelText('撤回原因'), { target: { value: '账号解封了' } });
    fireEvent.click(within(row).getByRole('button', { name: '确认撤回' }));
    await waitFor(() => expect((within(row).getByRole('switch') as HTMLButtonElement).disabled).toBe(false));
    expect(row.textContent).not.toContain('整池暂停');
  });

  test('【故意造出的失败】选了远程环境（?node=）：整块置灰、写「去那台上操作」，拖动和开关都点不了', async () => {
    renderApp(<RoutingPage />, { route: '/routing?purpose=execute&node=wsl' });
    await opened();
    expect(screen.getByRole('note').textContent).toContain('去那台上操作');
    await waitFor(() =>
      expect(screen.getAllByRole('button', { name: /^暂停账号池 / }).length).toBeGreaterThan(0),
    );
    for (const b of screen.getAllByRole('button', { name: /^拖动 / })) {
      expect((b as HTMLButtonElement).disabled).toBe(true);
    }
    for (const b of screen.getAllByRole('button', { name: /^暂停账号池 / })) {
      expect((b as HTMLButtonElement).disabled).toBe(true);
    }
    for (const sw of screen.getAllByRole('switch')) {
      expect((sw as HTMLButtonElement).disabled).toBe(true);
    }
  });
});

describe('渠道总开关 useUpdateChannel（#856 第 2 处）', () => {
  test('有意撤掉：前端不再导出。页面上的渠道开关走 setChannelEnabled，不是这条旧接口', () => {
    expect('useUpdateChannel' in client).toBe(false);
    expect('useSetChannelEnabled' in client).toBe(true);
  });
});
