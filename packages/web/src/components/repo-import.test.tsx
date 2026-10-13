// @vitest-environment happy-dom
// 设置页「导入仓库」：个人仓和组织仓分开，标明 App 装了没、在不在驾驶舱；加进不打开自动派单，移出和一键授权记操作记录。
import { ORG_APP_APPROVAL_NOTE } from '@fleet-dao/shared';
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

import { createMockApi } from '../api/mock/server';
import SettingsPage from '../routes/settings';
import { renderApp } from '../test/harness';

const assign = vi.fn();

beforeEach(() => {
  toast.success.mockClear();
  toast.error.mockClear();
  assign.mockReset();
  vi.spyOn(window.location, 'assign').mockImplementation(assign);
});

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

function row(owner: string, name: string): HTMLElement {
  const el = document.querySelector(`[data-testid="github-repo-${owner}-${name}"]`);
  if (!el) throw new Error(`找不到 ${owner}/${name}`);
  return el as HTMLElement;
}

describe('设置页导入仓库', () => {
  test('个人仓和组织仓分开，写明属主、App 装了没、在不在驾驶舱', async () => {
    renderApp(<SettingsPage />, { api: createMockApi({ live: false }), route: '/settings' });
    await screen.findByTestId('github-repo-lan-notes');
    const panel = screen.getByTestId('repo-import');
    expect(panel.textContent).toContain('GitHub 账号');
    expect(panel.textContent).toContain('lan');
    const personal = within(panel).getByRole('list', { name: '个人仓' });
    const org = within(panel).getByRole('list', { name: '组织仓' });
    expect(personal.compareDocumentPosition(org) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    expect(within(personal).getByText('lan/notes')).toBeTruthy();
    expect(within(personal).getByText('lan/scratch')).toBeTruthy();
    expect(within(personal).queryByText(ORG_APP_APPROVAL_NOTE)).toBeNull();
    expect(within(org).getByText('acme/orbit')).toBeTruthy();
    expect(within(org).getByText('acme/widget')).toBeTruthy();
    const orgBlock = screen.getByTestId('github-org-repos');
    expect(within(orgBlock).getAllByText(ORG_APP_APPROVAL_NOTE).length).toBeGreaterThan(0);
    expect(within(row('lan', 'notes')).getByText('个人')).toBeTruthy();
    expect(within(row('lan', 'notes')).getByText('干活的已装')).toBeTruthy();
    expect(within(row('lan', 'notes')).getByText('引擎没装')).toBeTruthy();
    expect(within(row('lan', 'notes')).getByText('不在驾驶舱')).toBeTruthy();
    expect(within(row('acme', 'orbit')).getByText('组织')).toBeTruthy();
    expect(within(row('acme', 'orbit')).getByText('在驾驶舱')).toBeTruthy();
    expect(within(row('acme', 'orbit')).getByText('引擎已装')).toBeTruthy();
    expect(within(row('acme', 'widget')).getByText('干活的没装')).toBeTruthy();
    expect(within(row('lan', 'scratch')).getByText('没有管理权限')).toBeTruthy();
    expect(within(row('lan', 'scratch')).queryByRole('button', { name: '加进驾驶舱' })).toBeNull();
    expect(within(row('lan', 'scratch')).queryByRole('button', { name: '一键授权' })).toBeNull();
    expect(document.querySelectorAll('[data-section-note]')).toHaveLength(6);
    expect(within(document.getElementById('repos') as HTMLElement).queryAllByRole('alert')).toHaveLength(0);
    expect(panel.textContent).not.toContain('还没有仓');
  });

  test('加进驾驶舱不打开自动派单，移出没在用的仓，在用的仓移不出去', async () => {
    const api = createMockApi({ live: false });
    renderApp(<SettingsPage />, { api, route: '/settings' });
    const widget = await screen.findByTestId('github-repo-acme-widget');
    fireEvent.click(within(widget).getByRole('button', { name: '加进驾驶舱' }));
    await waitFor(() => expect(within(row('acme', 'widget')).getByText('在驾驶舱')).toBeTruthy());
    const dispatch = await api.repoDispatch();
    const added = dispatch.repos.find((repo) => repo.name === 'widget');
    expect(added?.on).toBe(false);
    const recorded = await api.audit();
    expect(
      recorded.items.some((item) => item.action === 'repo.import' && item.target === 'github:acme/widget'),
    ).toBe(true);
    expect(toast.success).toHaveBeenCalledWith('已把 acme/widget 加进驾驶舱，没有打开自动派单');

    fireEvent.click(within(row('acme', 'widget')).getByRole('button', { name: '移出驾驶舱' }));
    const dialog = await screen.findByRole('alertdialog');
    fireEvent.click(within(dialog).getByRole('button', { name: '确认移出' }));
    await waitFor(() => expect(within(row('acme', 'widget')).getByText('不在驾驶舱')).toBeTruthy());
    expect((await api.repos()).repos.some((repo) => repo.name === 'widget')).toBe(false);
    expect((await api.audit()).items.some((item) => item.action === 'repo.remove' && item.ok)).toBe(true);

    fireEvent.click(within(row('acme', 'orbit')).getByRole('button', { name: '移出驾驶舱' }));
    fireEvent.click(within(await screen.findByRole('alertdialog')).getByRole('button', { name: '确认移出' }));
    await waitFor(() => expect(toast.error).toHaveBeenCalledWith('没移出', expect.anything()));
    expect(screen.getByTestId('groom-r-orbit')).toBeTruthy();
    expect((await api.audit()).items.some((item) => item.action === 'repo.remove' && item.ok === false)).toBe(
      true,
    );
  });

  test('一键授权把两个 App 标成已装，并记两条操作记录', async () => {
    const api = createMockApi({ live: false });
    renderApp(<SettingsPage />, { api, route: '/settings' });
    const notes = await screen.findByTestId('github-repo-lan-notes');
    fireEvent.click(within(notes).getByRole('button', { name: '一键授权' }));
    await waitFor(() => expect(within(row('lan', 'notes')).getByText('引擎已装')).toBeTruthy());
    expect(within(row('lan', 'notes')).queryByRole('button', { name: '一键授权' })).toBeNull();
    const installs = (await api.audit()).items.filter((item) => item.action === 'repo.apps.install');
    expect(installs).toHaveLength(2);
    expect(installs.every((item) => item.ok && item.target === 'github:lan/notes')).toBe(true);
  });

  test('没连接时不把空列表说成没有仓；连接和装到别的账号只跳 GitHub', async () => {
    const api = createMockApi({ live: false, githubConnected: false });
    renderApp(<SettingsPage />, { api, route: '/settings' });
    const connect = await screen.findByRole('button', { name: '连接 GitHub' });
    expect(screen.queryByText('还没有仓')).toBeNull();
    expect(screen.queryByRole('button', { name: '加进驾驶舱' })).toBeNull();
    fireEvent.click(connect);
    await waitFor(() =>
      expect(assign).toHaveBeenCalledWith('https://github.com/login/oauth/authorize?state=mock'),
    );

    cleanup();
    assign.mockReset();
    const connected = createMockApi({ live: false });
    connected.connectGithub = async (purpose) => {
      if (purpose === 'install-account') {
        return { connected: true, redirect: 'https://evil.example/steal' };
      }
      return { connected: true };
    };
    renderApp(<SettingsPage />, { api: connected, route: '/settings' });
    fireEvent.click(await screen.findByRole('button', { name: '把 App 装到别的账号' }));
    await waitFor(() => expect(toast.error).toHaveBeenCalledWith('授权地址不在 GitHub'));
    expect(assign).not.toHaveBeenCalled();

    cleanup();
    const again = createMockApi({ live: false });
    renderApp(<SettingsPage />, { api: again, route: '/settings' });
    fireEvent.click(await screen.findByRole('button', { name: '把 App 装到别的账号' }));
    await waitFor(() =>
      expect(assign).toHaveBeenCalledWith(
        'https://github.com/apps/fleet-dao-agent/installations/new?state=mock',
      ),
    );
  });

  test('从 GitHub 回来的结果用提示说一声，不在仓库一节多一条红横幅', async () => {
    renderApp(<SettingsPage />, { api: createMockApi({ live: false }), route: '/settings?github=ok' });
    await screen.findByTestId('repo-import');
    await waitFor(() => expect(toast.success).toHaveBeenCalledWith('两个 App 已装上'));
    expect(within(document.getElementById('repos') as HTMLElement).queryAllByRole('alert')).toHaveLength(0);
  });

  test('GitHub 上一个仓都没列出来时，不写「还没有仓」', async () => {
    const api = createMockApi({ live: false });
    api.githubRepos = async () => ({ connected: true, githubLogin: 'lan', truncated: false, repos: [] });
    renderApp(<SettingsPage />, { api, route: '/settings' });
    const panel = await screen.findByTestId('repo-import');
    await waitFor(() => expect(panel.textContent).toContain('装过的仓才会出现'));
    expect(screen.queryByText('还没有仓')).toBeNull();
  });
});
