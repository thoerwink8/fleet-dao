// @vitest-environment happy-dom
// 设置页「仓库」一节：每个项目的「合并方式」（强制 CI / 不强制 CI，#1877）。
// 切到不强制先确认；fleet-dao 自己的确认框多一段提示；切回不用确认；失败明说；显示的是读回来的值。
import { cleanup, fireEvent, screen, waitFor, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';

const { toast } = vi.hoisted(() => ({
  toast: Object.assign(vi.fn(), { success: vi.fn(), error: vi.fn(), info: vi.fn(), warning: vi.fn() }),
}));
vi.mock('sonner', () => ({ toast, Toaster: () => null }));

import { ApiError } from '../api/client';
import { createMockApi } from '../api/mock/server';
import SettingsPage from '../routes/settings';
import { renderApp } from '../test/harness';

beforeEach(() => {
  for (const f of [toast.success, toast.error, toast.info, toast.warning]) f.mockClear();
});
afterEach(cleanup);

const ORBIT = 'r-orbit';

const stateOf = (id: string) => screen.findByTestId(`ci-mode-state-${id}`);

describe('设置页：合并方式', () => {
  test('每个项目都显示当前合并方式，默认「强制 CI」', async () => {
    const api = createMockApi({ live: false });
    renderApp(<SettingsPage />, { api, route: '/settings' });
    for (const id of ['r-orbit', 'r-canary', 'r-site']) {
      const el = await stateOf(id);
      expect(el.textContent).toBe('强制 CI');
      expect(el.getAttribute('data-ci-mode')).toBe('required');
    }
  });

  test('切到不强制 CI 要先确认；确认后读回来的值显示出来，操作记录有一条', async () => {
    const api = createMockApi({ live: false });
    const spy = vi.spyOn(api, 'updateRepoCiMode');
    renderApp(<SettingsPage />, { api, route: '/settings' });
    const panel = await screen.findByTestId(`ci-mode-${ORBIT}`);
    fireEvent.click(within(panel).getByRole('button', { name: /切到不强制 CI/ }));
    const dialog = await screen.findByRole('alertdialog');
    // 点了切换只弹确认，还没写后端
    expect(spy).not.toHaveBeenCalled();
    expect(dialog.textContent).toContain('不等 CI、不做冷验收');
    expect(dialog.textContent).toContain('改到标准路径的照旧停下等人');
    expect(within(dialog).queryByTestId('ci-mode-self-warning')).toBeNull();
    fireEvent.click(within(dialog).getByRole('button', { name: '切到不强制 CI' }));
    await waitFor(() => expect(spy).toHaveBeenCalledWith(ORBIT, { ciMode: 'skip' }));
    await waitFor(async () => expect((await stateOf(ORBIT)).textContent).toBe('不强制 CI'));
    expect(toast.success).toHaveBeenCalledWith(expect.stringContaining('不强制 CI'));
    expect(screen.queryByRole('alertdialog')).toBeNull();
    // 别的项目不受影响
    expect((await stateOf('r-site')).textContent).toBe('强制 CI');
    const audit = await api.audit({});
    const entry = audit.items.find((e) => e.action === 'repo.ci_mode.set');
    expect(entry?.before).toEqual({ ciMode: 'required' });
    expect(entry?.after).toEqual({ ciMode: 'skip' });
  });

  test('点「先不」不写后端', async () => {
    const api = createMockApi({ live: false });
    const spy = vi.spyOn(api, 'updateRepoCiMode');
    renderApp(<SettingsPage />, { api, route: '/settings' });
    const panel = await screen.findByTestId(`ci-mode-${ORBIT}`);
    fireEvent.click(within(panel).getByRole('button', { name: /切到不强制 CI/ }));
    const dialog = await screen.findByRole('alertdialog');
    fireEvent.click(within(dialog).getByRole('button', { name: '先不' }));
    await waitFor(() => expect(screen.queryByRole('alertdialog')).toBeNull());
    expect(spy).not.toHaveBeenCalled();
    expect((await stateOf(ORBIT)).textContent).toBe('强制 CI');
  });

  test('切回强制 CI 不用确认', async () => {
    const api = createMockApi({ live: false });
    await api.updateRepoCiMode(ORBIT, { ciMode: 'skip' });
    const spy = vi.spyOn(api, 'updateRepoCiMode');
    renderApp(<SettingsPage />, { api, route: '/settings' });
    await waitFor(async () => expect((await stateOf(ORBIT)).textContent).toBe('不强制 CI'));
    const panel = await screen.findByTestId(`ci-mode-${ORBIT}`);
    fireEvent.click(within(panel).getByRole('button', { name: /切到强制 CI/ }));
    expect(screen.queryByRole('alertdialog')).toBeNull();
    await waitFor(() => expect(spy).toHaveBeenCalledWith(ORBIT, { ciMode: 'required' }));
    await waitFor(async () => expect((await stateOf(ORBIT)).textContent).toBe('强制 CI'));
  });

  test('fleet-dao 自己切到不强制 CI：确认框多一段提示', async () => {
    const api = createMockApi({ live: false });
    const repos = await api.repos();
    const dispatch = await api.repoDispatch();
    const self = {
      id: 'r-self',
      owner: 'someone',
      name: 'fleet-dao',
      defaultBranch: 'main',
      testCommand: 'pnpm check',
    };
    api.repos = async () => ({ repos: [...repos.repos, self] });
    api.repoDispatch = async () => ({
      repos: [
        ...dispatch.repos,
        { repoId: 'r-self', owner: 'someone', name: 'fleet-dao', on: false, ciMode: 'required' },
      ],
    });
    renderApp(<SettingsPage />, { api, route: '/settings' });
    const panel = await screen.findByTestId('ci-mode-r-self');
    fireEvent.click(within(panel).getByRole('button', { name: /切到不强制 CI/ }));
    const dialog = await screen.findByRole('alertdialog');
    const warn = within(dialog).getByTestId('ci-mode-self-warning');
    expect(warn.textContent).toContain('改规矩的 PR 也不再被 CI 把关');
    expect(warn.textContent).toContain('主线规则集若仍要求必过检查，GitHub 会拒绝合并');
    expect(warn.textContent).toContain('要同时改规则集');
  });

  test('切换失败：报错明说原因，显示仍是读回来的旧值，按钮没卡死', async () => {
    const api = createMockApi({ live: false });
    api.updateRepoCiMode = async () => {
      throw new ApiError(409, 'conflict', '主线规则集要求必过检查');
    };
    renderApp(<SettingsPage />, { api, route: '/settings' });
    const panel = await screen.findByTestId(`ci-mode-${ORBIT}`);
    fireEvent.click(within(panel).getByRole('button', { name: /切到不强制 CI/ }));
    const dialog = await screen.findByRole('alertdialog');
    fireEvent.click(within(dialog).getByRole('button', { name: '切到不强制 CI' }));
    await waitFor(() =>
      expect(toast.error).toHaveBeenCalledWith('没能切到「不强制 CI」', {
        description: expect.stringContaining('主线规则集要求必过检查'),
      }),
    );
    expect((await stateOf(ORBIT)).textContent).toBe('强制 CI');
    const btn = within(panel).getByRole('button', { name: /切到不强制 CI/ });
    await waitFor(() => expect((btn as HTMLButtonElement).disabled).toBe(false));
  });

  test('切换进行中按钮禁用，防连点', async () => {
    const api = createMockApi({ live: false });
    let release: () => void = () => {};
    const orig = api.updateRepoCiMode.bind(api);
    api.updateRepoCiMode = async (id, body) => {
      await new Promise<void>((r) => {
        release = r;
      });
      return orig(id, body);
    };
    renderApp(<SettingsPage />, { api, route: '/settings' });
    const panel = await screen.findByTestId(`ci-mode-${ORBIT}`);
    const btn = within(panel).getByRole('button', { name: /切到不强制 CI/ }) as HTMLButtonElement;
    fireEvent.click(btn);
    const dialog = await screen.findByRole('alertdialog');
    fireEvent.click(within(dialog).getByRole('button', { name: '切到不强制 CI' }));
    await waitFor(() => expect(btn.disabled).toBe(true));
    release();
    await waitFor(() => expect(btn.disabled).toBe(false));
  });
});
