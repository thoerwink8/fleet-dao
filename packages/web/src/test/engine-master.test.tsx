// @vitest-environment happy-dom
// 引擎总开关（#1086）在页面上的三处：顶栏常驻的引擎状态、法国页「引擎」卡里能点的开关（二次确认、写设置 engine.master、带版本防覆盖、
// 显示谁什么时候改的）、设置页「仓库」一节写清和按项目开关的关系。选了远程环境只读、写明去那台上操作；读不到、远程快照没有这一格都如实写，
// 不画成开也不画成关。本台的状态读设置（/api/settings），顶栏不拉整份 /api/env。
import { cleanup, fireEvent, screen, waitFor, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';

const { toast } = vi.hoisted(() => ({
  toast: Object.assign(vi.fn(), { success: vi.fn(), error: vi.fn(), info: vi.fn(), warning: vi.fn() }),
}));
vi.mock('sonner', () => ({ toast, Toaster: () => null }));

import { ApiError, type FleetApi } from '../api/client';
import { createMockApi, type MockApi } from '../api/mock/server';
import type { Setting } from '../api/types';
import { EngineStatus } from '../components/shell/engine-status';
import France from '../routes/france';
import SettingsPage from '../routes/settings';
import { renderApp } from './harness';

beforeEach(() => {
  for (const f of [toast.success, toast.error, toast.info, toast.warning]) f.mockClear();
});
afterEach(cleanup);

/** 本台总开关的几种样子（设置里 engine.master 那一行）：没设过、开着、关着（谁什么时候关的）。 */
const NEVER: Setting | null = null;
const ON: Setting = {
  key: 'engine.master',
  value: true,
  version: 3,
  updatedAt: '2026-10-05T13:00:00.000Z',
  updatedBy: 'user:frank',
};
const OFF: Setting = { ...ON, value: false, version: 4, updatedBy: 'ops:engine' };

/** 假后端：只换掉 settings()（本台的总开关行由用例给，null = 从没设过）；没有远程环境。 */
function apiWith(row: Setting | null): MockApi {
  const inner = createMockApi({ live: false });
  const out = {
    settings: async () => {
      const base = await inner.settings();
      const rest = base.settings.filter((s) => s.key !== 'engine.master');
      return { settings: row ? [...rest, row] : rest };
    },
    nodes: async () => ({ ...(await inner.nodes()), nodes: [] }),
  };
  return { ...inner, ...out } as unknown as MockApi;
}

describe('顶栏的引擎状态（EngineStatus）', () => {
  test('关着写「总开关关着」、橙点；开着写「总开关开着」、绿点；从没设过按关', async () => {
    renderApp(<EngineStatus />, { api: apiWith(OFF) as unknown as FleetApi });
    const off = await screen.findByRole('button', { name: /总开关关着/ });
    expect(off.getAttribute('data-engine-master')).toBe('off');
    expect(off.querySelector('.bg-warn')).not.toBeNull();
    expect(off.textContent).toBe('总开关关着');
    cleanup();
    renderApp(<EngineStatus />, { api: apiWith(ON) as unknown as FleetApi });
    const on = await screen.findByRole('button', { name: /总开关开着/ });
    expect(on.getAttribute('data-engine-master')).toBe('on');
    // 开着是常态，画灰点（决定 0121 第 2 条）；绿只在强调态用。
    expect(on.querySelector('.bg-ink-3')).not.toBeNull();
    expect(on.querySelector('.bg-success')).toBeNull();
    cleanup();
    renderApp(<EngineStatus />, { api: apiWith(NEVER) as unknown as FleetApi });
    expect(await screen.findByRole('button', { name: /总开关关着/ })).toBeTruthy();
  });

  test('顶栏每一页都在，不能为它去拉整份 /api/env（每次要跑全套健康检查）：本台读设置', async () => {
    const api = apiWith(ON);
    let envReads = 0;
    const real = api.env.bind(api);
    api.env = async () => {
      envReads += 1;
      return real();
    };
    renderApp(<EngineStatus />, { api: api as unknown as FleetApi });
    await screen.findByRole('button', { name: /总开关开着/ });
    expect(envReads).toBe(0);
  });

  test('故意造出失败：设置读不到：写「总开关没查成」，不画成开也不画成关', async () => {
    const api = apiWith(ON);
    api.settings = async () => {
      throw new ApiError(500, 'internal', '库连不上（测试故意造的）');
    };
    renderApp(<EngineStatus />, { api: api as unknown as FleetApi });
    const badge = await screen.findByRole('button', { name: /总开关没查成/ });
    expect(badge.getAttribute('data-engine-master')).toBe('error');
    expect(badge.textContent).not.toContain('开着');
    expect(badge.textContent).not.toContain('关着');
  });
});

const toggle = (card: HTMLElement) => within(card).getByRole('switch', { name: '引擎总开关' });

describe('法国页的开关（EngineCard）', () => {
  test('关着：写状态和一句话，拨开关先弹二次确认，确认后按当前版本写设置 engine.master=true 并提示', async () => {
    const api = apiWith(NEVER);
    const update = vi.spyOn(api, 'updateSetting').mockResolvedValue({
      key: 'engine.master',
      value: true,
      version: 1,
    } as never);
    renderApp(<France />, { api: api as unknown as FleetApi, route: '/france' });
    const card = await screen.findByTestId('engine-master');
    await waitFor(() => expect(within(card).getByTestId('engine-master-state').textContent).toBe('关着'));
    expect(within(card).getByTestId('engine-master-note').textContent).toContain('默认关');
    expect(toggle(card).getAttribute('aria-checked')).toBe('false');
    fireEvent.click(toggle(card));
    // 二次确认：没点确认之前不写
    expect(update).not.toHaveBeenCalled();
    const dialog = await screen.findByRole('alertdialog');
    expect(within(dialog).getByText(/会花额度/)).toBeTruthy();
    fireEvent.click(within(dialog).getByRole('button', { name: '开启' }));
    await waitFor(() => expect(update).toHaveBeenCalledTimes(1));
    expect(update).toHaveBeenCalledWith(
      'engine.master',
      expect.objectContaining({ value: true, version: 0 }),
    );
    await waitFor(() => expect(toast.success).toHaveBeenCalledWith('已开启引擎总开关'));
  });

  test('开着：显示谁什么时候改的，开关是打开的，确认后带当前版本写 false', async () => {
    const api = apiWith(ON);
    const update = vi.spyOn(api, 'updateSetting').mockResolvedValue({
      key: 'engine.master',
      value: false,
      version: 4,
    } as never);
    renderApp(<France />, { api: api as unknown as FleetApi, route: '/france' });
    const card = await screen.findByTestId('engine-master');
    await waitFor(() => expect(within(card).getByTestId('engine-master-state').textContent).toBe('开着'));
    expect(within(card).getByTestId('engine-master-who').textContent).toContain('frank');
    expect(within(card).getByTestId('engine-master-who').textContent).toContain('打开');
    expect(toggle(card).getAttribute('aria-checked')).toBe('true');
    fireEvent.click(toggle(card));
    const dialog = await screen.findByRole('alertdialog');
    fireEvent.click(within(dialog).getByRole('button', { name: '关闭' }));
    await waitFor(() => expect(update).toHaveBeenCalledTimes(1));
    expect(update).toHaveBeenCalledWith(
      'engine.master',
      expect.objectContaining({ value: false, version: 3 }),
    );
  });

  test('点「先不」：什么都不写', async () => {
    const api = apiWith(NEVER);
    const update = vi.spyOn(api, 'updateSetting');
    renderApp(<France />, { api: api as unknown as FleetApi, route: '/france' });
    const card = await screen.findByTestId('engine-master');
    await waitFor(() => expect(within(card).getByTestId('engine-master-state').textContent).toBe('关着'));
    fireEvent.click(toggle(card));
    const dialog = await screen.findByRole('alertdialog');
    fireEvent.click(within(dialog).getByRole('button', { name: '先不' }));
    expect(update).not.toHaveBeenCalled();
  });

  test('故意造出失败：版本冲突（别人刚改过）：弹出后端的原因，不冒充成功', async () => {
    const api = apiWith(NEVER);
    vi.spyOn(api, 'updateSetting').mockRejectedValue(
      new ApiError(409, 'conflict', '这项设置刚被别人改过，刷新后再改'),
    );
    renderApp(<France />, { api: api as unknown as FleetApi, route: '/france' });
    const card = await screen.findByTestId('engine-master');
    await waitFor(() => expect(within(card).getByTestId('engine-master-state').textContent).toBe('关着'));
    fireEvent.click(toggle(card));
    const dialog = await screen.findByRole('alertdialog');
    fireEvent.click(within(dialog).getByRole('button', { name: '开启' }));
    await waitFor(() => expect(toast.error).toHaveBeenCalled());
    expect(toast.error.mock.calls[0]?.[0]).toBe('没能开启');
    expect(JSON.stringify(toast.error.mock.calls[0])).toContain('刷新后再改');
    // 框留着，里面也写着原因
    expect((await within(dialog).findByRole('alert')).textContent).toContain('刷新后再改');
    expect(toast.success).not.toHaveBeenCalled();
  });

  test('故意造出失败：设置读不到：写原因、不给开关（不知道现在是开是关就不让人拨）', async () => {
    const api = apiWith(ON);
    api.settings = async () => {
      throw new ApiError(500, 'internal', '库连不上（测试故意造的）');
    };
    renderApp(<France />, { api: api as unknown as FleetApi, route: '/france' });
    const card = await screen.findByTestId('engine-master');
    await waitFor(() => expect(within(card).getByTestId('engine-master-state').textContent).toBe('没读到'));
    expect(within(card).getByTestId('engine-master-note').textContent).toContain('库连不上');
    expect(within(card).queryByRole('switch')).toBeNull();
  });
});

describe('选了远程环境（?node=）：只读、写明去那台上操作', () => {
  /** 假后端自带一个叫 wsl 的远程环境；它的快照取自假库，这里把它的总开关事实换成用例给的。 */
  function remoteWith(masterFact: unknown): MockApi {
    const inner = createMockApi({ live: false });
    return {
      ...inner,
      node: async (id: string) => {
        const snap = await inner.node(id);
        const { master: _drop, ...rest } = snap.env.facts;
        return {
          ...snap,
          env: { ...snap.env, facts: masterFact === undefined ? rest : { ...rest, master: masterFact } },
        };
      },
    } as unknown as MockApi;
  }
  const fact = (on: boolean) => ({
    ok: true as const,
    value: { on, why: 'set' as const, detail: on ? '开着：引擎在接活' : '关着：不拉单' },
  });

  test('远程环境的快照里总开关开着：显示状态、开关置灰点不动，写明用 fleet-api engine on|off', async () => {
    const update = vi.fn();
    const api = remoteWith(fact(true));
    api.updateSetting = update;
    renderApp(<France />, { api: api as unknown as FleetApi, route: '/france?node=wsl' });
    const card = await screen.findByTestId('engine-master');
    await waitFor(() => expect(within(card).getByTestId('engine-master-state').textContent).toBe('开着'));
    const sw = toggle(card) as HTMLButtonElement;
    expect(sw.disabled).toBe(true);
    fireEvent.click(sw);
    expect(screen.queryByRole('alertdialog')).toBeNull();
    expect(update).not.toHaveBeenCalled();
    expect(within(card).getByTestId('engine-master-remote-note').textContent).toContain('fleet-api engine');
  });

  test('远程环境升级前推来的旧快照没有这一格：写「还不带引擎总开关」，不猜成开也不猜成关', async () => {
    renderApp(<France />, { api: remoteWith(undefined) as unknown as FleetApi, route: '/france?node=wsl' });
    const card = await screen.findByTestId('engine-master');
    await waitFor(() =>
      expect(within(card).getByTestId('engine-master-note').textContent).toContain('还不带'),
    );
    expect(within(card).getByTestId('engine-master-state').textContent).toBe('没读到');
    expect(within(card).queryByRole('switch')).toBeNull();
  });
});

describe('设置页「仓库」一节', () => {
  test('写清总开关和按项目「让 AI 接活」的关系，并给出总开关现在的状态', async () => {
    renderApp(<SettingsPage />, { api: apiWith(OFF) as unknown as FleetApi, route: '/settings' });
    const note = await screen.findByTestId('engine-master-relation');
    expect(note.textContent).toContain('总开关关＝全停');
    expect(note.textContent).toContain('只有这里接活开着的项目才派');
    await waitFor(() => expect(note.textContent).toContain('现在关着'));
  });
});
