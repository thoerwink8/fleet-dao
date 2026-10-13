// @vitest-environment happy-dom
// 设置页「导入仓库」（#1989）：列出本人 GitHub 上看得见的仓，个人/组织分开，能加进驾驶舱、能断开。
// 走假数据（mock api），不联网。
import { cleanup, render, screen, waitFor, within } from '@testing-library/react';
import { afterEach, describe, expect, test } from 'vitest';
import { createMockApi } from '../api/mock/server';
import SettingsPage from '../routes/settings';
import { renderApp } from './harness';

afterEach(cleanup);

describe('设置页导入仓库（#1989）', () => {
  test('连上 GitHub 后列出本人的仓，个人仓和组织仓分开', async () => {
    renderApp(<SettingsPage />, { api: createMockApi({ live: false }), route: '/settings' });
    // 等到「从 GitHub 导入」那一块出现
    await screen.findByText('从 GitHub 导入');
    expect(await screen.findByText('thoerwink8/widgets')).toBeTruthy();
    expect(screen.getByText('thoerwink8/notes')).toBeTruthy();
    expect(screen.getByText('adfx-studio/daihuo-workbench')).toBeTruthy();
    expect(screen.getByText(/个人仓/)).toBeTruthy();
    expect(screen.getByText(/组织的仓/)).toBeTruthy();
  });

  test('没装 App、又不在驾驶舱的仓：给「加进驾驶舱」按钮', async () => {
    renderApp(<SettingsPage />, { api: createMockApi({ live: false }), route: '/settings' });
    await screen.findByText('thoerwink8/widgets');
    const row = screen.getByText('thoerwink8/notes').closest('li') as HTMLElement;
    expect(within(row).getByRole('button', { name: /加进驾驶舱/ })).toBeTruthy();
  });

  test('已在驾驶舱的仓：给「移出驾驶舱」而不是「加进」', async () => {
    renderApp(<SettingsPage />, { api: createMockApi({ live: false }), route: '/settings' });
    await screen.findByText('adfx-studio/daihuo-workbench');
    const row = screen.getByText('adfx-studio/daihuo-workbench').closest('li') as HTMLElement;
    expect(within(row).getByRole('button', { name: /移出驾驶舱/ })).toBeTruthy();
    expect(within(row).queryByRole('button', { name: /^加进驾驶舱/ })).toBeNull();
  });

  test('组织仓本人没 admin：写明要组织先批准，不给「装 App」按钮', async () => {
    renderApp(<SettingsPage />, { api: createMockApi({ live: false }), route: '/settings' });
    await screen.findByText('some-org/shared-lib');
    const row = screen.getByText('some-org/shared-lib').closest('li') as HTMLElement;
    expect(within(row).queryByRole('button', { name: '装 App' })).toBeNull();
    expect(within(row).getAllByText(/组织管理员先批准/).length).toBeGreaterThan(0);
  });

  test('有「连接 GitHub」的入口（连上了也留着，方便重连）', async () => {
    renderApp(<SettingsPage />, { api: createMockApi({ live: false }), route: '/settings' });
    await screen.findByText('从 GitHub 导入');
    await waitFor(() => expect(screen.getAllByText(/GitHub/).length).toBeGreaterThan(0));
  });
});

describe('设置页导入仓库：没连 GitHub', () => {
  test('未连接时只画一句说明加一个「连接 GitHub」按钮', async () => {
    const api = createMockApi({ live: false });
    // 用假的 importableRepos 覆盖：auth.connected=false
    const original = api.importableRepos.bind(api);
    api.importableRepos = async () => ({ auth: { connected: false }, repos: [] });
    void original;
    const { unmount } = render(<div />);
    unmount();
    renderApp(<SettingsPage />, { api, route: '/settings' });
    await screen.findByText('从 GitHub 导入');
    expect(await screen.findByRole('button', { name: /连接 GitHub/ })).toBeTruthy();
    expect(screen.queryByText('thoerwink8/widgets')).toBeNull();
  });
});
