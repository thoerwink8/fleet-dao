// @vitest-environment happy-dom
// 路由页上调先后和开关（母单 #1089 第二片）：每个用途下的模型、每个模型下的渠道各有「上移 / 下移」，渠道有开关；
// 点之前二次确认（取消就什么都不写）、确认了带「我看到的顺序」写后端，页面按库里现在的顺序重排；
// 别人先改了（409）退回库里的顺序；已在最上 / 最下的键置灰；选了远程环境（本机 WSL 的快照）整块置灰并写「去那台上操作」。
// #856 第 2 处：渠道这一级的总开关 useUpdateChannel 是有意撤掉的（#972），页面上的渠道开关就是这里每条路由的开关。
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

/** 模型头上的「上移 / 下移」：整行的按钮里按名字结尾认（名字里带这个模型和用途）。 */
const modelButton = (modelId: string, dir: '上移' | '下移') =>
  within(modelBlock(modelId).firstElementChild as HTMLElement).getByRole('button', {
    name: new RegExp(`动手里的先后） ${dir}$`),
  });

const routeButton = (routeId: string, dir: '上移' | '下移') =>
  within(routeItem(routeId)).getByRole('button', { name: new RegExp(`${dir}$`) });

describe('路由页：调先后和开关', () => {
  test('写码的模型：最上面那个上移置灰、最下面那个下移置灰；每条渠道有开关，开着的亮着、关着的灭着', async () => {
    renderApp(<RoutingPage />, { route: '/routing?purpose=execute' });
    await opened();
    expect(modelNames()).toEqual(['Opus 5.5', 'Kimi k3', 'Cursor Auto', 'Opus 5']);
    expect((modelButton('opus-5.5', '上移') as HTMLButtonElement).disabled).toBe(true);
    expect((modelButton('opus-5.5', '下移') as HTMLButtonElement).disabled).toBe(false);
    expect((modelButton('opus-5', '下移') as HTMLButtonElement).disabled).toBe(true);
    // Opus 5.5 下三条：前两条开着、中转那条关着
    expect(within(routeItem('r-ca-opus')).getByRole('switch').getAttribute('aria-checked')).toBe('true');
    expect(within(routeItem('r-rl-opus')).getByRole('switch').getAttribute('aria-checked')).toBe('false');
    expect((routeButton('r-ca-opus', '上移') as HTMLButtonElement).disabled).toBe(true);
    expect((routeButton('r-rl-opus', '下移') as HTMLButtonElement).disabled).toBe(true);
  });

  test('模型下移：先弹确认写清「从什么顺序变成什么顺序」，取消什么都不写；确认才写，带看到的顺序，页面按新顺序重排', async () => {
    const { api } = renderApp(<RoutingPage />, { route: '/routing?purpose=execute' });
    const spy = vi.spyOn(api, 'movePurposeModel');
    await opened();

    fireEvent.click(modelButton('opus-5.5', '下移'));
    const dialog = await screen.findByRole('alertdialog');
    expect(dialog.textContent).toContain('把「Opus 5.5」在「动手」里下移一位？');
    expect(dialog.textContent).toContain(
      '从「Opus 5.5 → Kimi k3 → Cursor Auto → Opus 5」变成「Kimi k3 → Opus 5.5 → Cursor Auto → Opus 5」',
    );
    fireEvent.click(within(dialog).getByRole('button', { name: '先不' }));
    await waitFor(() => expect(screen.queryByRole('alertdialog')).toBeNull());
    expect(spy).not.toHaveBeenCalled();
    expect(modelNames()).toEqual(['Opus 5.5', 'Kimi k3', 'Cursor Auto', 'Opus 5']);

    fireEvent.click(modelButton('opus-5.5', '下移'));
    fireEvent.click(within(await screen.findByRole('alertdialog')).getByRole('button', { name: '下移' }));
    await waitFor(() => expect(modelNames()).toEqual(['Kimi k3', 'Opus 5.5', 'Cursor Auto', 'Opus 5']));
    expect(spy).toHaveBeenCalledExactlyOnceWith('execute', 'opus-5.5', {
      direction: 'down',
      expected: ['opus-5.5', 'kimi-k3', 'cursor-auto', 'opus-5'],
    });
    // 选路读的那份（假后端的路由两层）也变了，写进操作记录
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

  test('渠道上移 / 下移：Opus 5.5 下第二条上移，写库后页面里那一块的渠道按新顺序排', async () => {
    const { api } = renderApp(<RoutingPage />, { route: '/routing?purpose=execute' });
    const spy = vi.spyOn(api, 'updateModelRoute');
    await opened();
    const order = () =>
      within(modelBlock('opus-5.5'))
        .getAllByRole('listitem')
        .map((li) => li.getAttribute('data-route'))
        .filter(Boolean);
    expect(order()).toEqual(['r-ca-opus', 'r-cb-opus', 'r-rl-opus']);

    fireEvent.click(routeButton('r-cb-opus', '上移'));
    const dialog = await screen.findByRole('alertdialog');
    expect(dialog.textContent).toContain('渠道先后不分用途');
    fireEvent.click(within(dialog).getByRole('button', { name: '上移' }));
    await waitFor(() => expect(order()).toEqual(['r-cb-opus', 'r-ca-opus', 'r-rl-opus']));
    expect(spy).toHaveBeenCalledExactlyOnceWith('opus-5.5', 'r-cb-opus', {
      op: 'move',
      direction: 'up',
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

  test('【故意造出的失败】别人先改了（409）：弹窗关掉、页面还是库里现在的顺序，不当改成了', async () => {
    const { api } = renderApp(<RoutingPage />, { route: '/routing?purpose=execute' });
    vi.spyOn(api, 'movePurposeModel').mockRejectedValue(
      new ApiError(409, 'conflict', '这个用途下模型的先后刚被别人改过，刷新后再改'),
    );
    await opened();
    fireEvent.click(modelButton('opus-5.5', '下移'));
    fireEvent.click(within(await screen.findByRole('alertdialog')).getByRole('button', { name: '下移' }));
    await waitFor(() => expect(screen.queryByRole('alertdialog')).toBeNull());
    expect(modelNames()).toEqual(['Opus 5.5', 'Kimi k3', 'Cursor Auto', 'Opus 5']);
    expect((await api.audit()).items.some((a) => a.action === 'routing.order.move')).toBe(false);
  });

  test('【故意造出的失败】选了远程环境（?node=）：整块置灰、写「去那台上操作」，上移 / 下移 / 开关都点不了', async () => {
    renderApp(<RoutingPage />, { route: '/routing?purpose=execute&node=wsl' });
    await opened();
    expect(screen.getByRole('note').textContent).toContain('去那台上操作');
    for (const b of screen.getAllByRole('button', { name: /(上移|下移)$/ })) {
      expect((b as HTMLButtonElement).disabled).toBe(true);
    }
    for (const sw of screen.getAllByRole('switch')) {
      expect((sw as HTMLButtonElement).disabled).toBe(true);
    }
  });
});

describe('渠道总开关 useUpdateChannel（#856 第 2 处）', () => {
  test('有意撤掉：前端不再导出。页面上的渠道开关是路由页每条路由的开关，不是这条旧接口', () => {
    expect('useUpdateChannel' in client).toBe(false);
  });
});
