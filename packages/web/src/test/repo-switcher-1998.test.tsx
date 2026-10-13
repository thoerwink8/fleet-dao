// @vitest-environment happy-dom
// 顶栏「切换项目」下拉（#1998）：常驻「现在看的是哪个仓」，点开列出所有仓、点一下切过去；
// 下拉底部两行常驻入口（从 GitHub 加仓 / 管理项目）跳到设置页「仓库」那一节。
// 要钉住的：切仓改了当前仓（记在浏览器本地）、选中的打勾、一个仓都没有时不空白、
// 下拉关着的时候不拉每个仓的看板（首屏不付费，first-screen.test 也守着一条）。
import { cleanup, fireEvent, screen, waitFor, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, test } from 'vitest';
import { createMockApi } from '../api/mock/server';
import { RepoSwitcher } from '../components/shell/repo-switcher';
import { renderApp } from './harness';

beforeEach(() => localStorage.clear());
afterEach(cleanup);

const switcher = () => screen.getByRole('button', { name: '切换项目' });

async function openSwitcher() {
  fireEvent.keyDown(switcher(), { key: 'Enter' });
  return screen.findByRole('menu');
}

describe('顶栏切换项目（#1998）', () => {
  test('常驻显示当前仓的名字；下拉关着时里面的内容不在页面上', async () => {
    renderApp(<RepoSwitcher />, { api: createMockApi({ live: false }), route: '/' });
    await waitFor(() => expect(switcher().textContent).toContain('orbit'));
    expect(screen.queryByText('切换项目（看板按项目显示）')).toBeNull();
  });

  test('点开列出所有接进来的仓', async () => {
    renderApp(<RepoSwitcher />, { api: createMockApi({ live: false }), route: '/' });
    await waitFor(() => expect(switcher()).toBeTruthy());
    const menu = await openSwitcher();
    expect(within(menu).getByText('切换项目（看板按项目显示）')).toBeTruthy();
    expect(within(menu).getByText('orbit')).toBeTruthy();
  });

  test('点另一个仓：切过去、记进浏览器本地', async () => {
    const api = createMockApi({ live: false });
    api.repos = async () => ({
      repos: [
        { id: 'r-orbit', owner: 'acme', name: 'orbit', defaultBranch: 'main', testCommand: 'pnpm check' },
        { id: 'r-tools', owner: 'acme', name: 'tools', defaultBranch: 'main', testCommand: 'pnpm check' },
      ],
    });
    renderApp(<RepoSwitcher />, { api, route: '/' });
    await waitFor(() => expect(switcher()).toBeTruthy());
    const menu = await openSwitcher();
    fireEvent.click(within(menu).getByText('tools'));
    await waitFor(() => expect(switcher().textContent).toContain('tools'));
    expect(localStorage.getItem('fleet-dao.repo')).toContain('r-tools');
  });

  test('底部两行入口：从 GitHub 加仓 / 管理项目', async () => {
    renderApp(<RepoSwitcher />, { api: createMockApi({ live: false }), route: '/' });
    await waitFor(() => expect(switcher()).toBeTruthy());
    const menu = await openSwitcher();
    expect(within(menu).getByText('从 GitHub 加仓')).toBeTruthy();
    expect(within(menu).getByText('管理项目（加 / 移出）')).toBeTruthy();
  });

  test('一个仓都没有：下拉里写「还没有接进来的项目」，不空白', async () => {
    const api = createMockApi({ live: false });
    api.repos = async () => ({ repos: [] });
    renderApp(<RepoSwitcher />, { api, route: '/' });
    await waitFor(() => expect(switcher()).toBeTruthy());
    const menu = await openSwitcher();
    expect(within(menu).getByText('还没有接进来的项目')).toBeTruthy();
  });
});
