// @vitest-environment happy-dom
// 设置页「导入仓库」（#1989；#3533 起收在仓库卡头的入口里，点开是一张表，一行一个状态）：列出两个机器人已经装上的仓，
// 能加进驾驶舱、能移出。走假数据（mock api），不联网。
import { cleanup, fireEvent, screen, waitFor, within } from '@testing-library/react';
import { afterEach, describe, expect, test } from 'vitest';
import { createMockApi } from '../api/mock/server';
import SettingsPage from '../routes/settings';
import { renderApp } from './harness';

afterEach(cleanup);

/** 点仓库卡头的「导入仓库」，导入表就出来了。 */
async function openImport() {
  fireEvent.click(await screen.findByRole('button', { name: '导入仓库' }));
}

/** 导入表里这个仓的那一行（接进来之后仓库表里也有这个仓：只认带「加进 / 移出驾驶舱」按钮的那一行）。 */
function importRow(name: string): HTMLElement {
  return screen
    .getAllByText(name)
    .map((e) => e.closest('tr') as HTMLElement)
    .find((tr) => within(tr).queryByRole('button', { name: /驾驶舱/ })) as HTMLElement;
}

describe('设置页导入仓库（#1989）', () => {
  test('点开「导入仓库」才有这张表；列出机器人装上的仓，个人 / 组织写在仓名下面，不分两组', async () => {
    renderApp(<SettingsPage />, { api: createMockApi({ live: false }), route: '/settings' });
    expect(await screen.findByRole('button', { name: '导入仓库' })).toBeTruthy();
    expect(screen.queryByText('thoerwink8/widgets')).toBeNull();
    await openImport();
    expect(await screen.findByText('thoerwink8/widgets')).toBeTruthy();
    expect(screen.getByText('thoerwink8/notes')).toBeTruthy();
    expect(screen.getByText('adfx-studio/daihuo-workbench')).toBeTruthy();
    expect(screen.queryByRole('heading', { name: /个人仓/ })).toBeNull();
    expect(within(importRow('thoerwink8/widgets')).getByText(/个人/)).toBeTruthy();
    expect(within(importRow('adfx-studio/daihuo-workbench')).getByText(/组织/)).toBeTruthy();
    // 收起
    fireEvent.click(screen.getByRole('button', { name: '收起' }));
    expect(screen.queryByText('thoerwink8/widgets')).toBeNull();
  });

  test('点「加进驾驶舱」后这一行当场变成已导入（假后端也要刷新列表）；移出后变回去', async () => {
    renderApp(<SettingsPage />, { api: createMockApi({ live: false }), route: '/settings' });
    await openImport();
    await screen.findByText('thoerwink8/widgets');
    fireEvent.click(within(importRow('thoerwink8/widgets')).getByRole('button', { name: /加进驾驶舱/ }));
    await waitFor(() =>
      expect(
        within(importRow('thoerwink8/widgets')).getByRole('button', { name: /移出驾驶舱/ }),
      ).toBeTruthy(),
    );
    expect(within(importRow('thoerwink8/widgets')).queryByRole('button', { name: /^加进驾驶舱/ })).toBeNull();
    expect(within(importRow('thoerwink8/widgets')).getByText('已在驾驶舱')).toBeTruthy();

    fireEvent.click(within(importRow('thoerwink8/widgets')).getByRole('button', { name: /移出驾驶舱/ }));
    fireEvent.click(await screen.findByRole('button', { name: '移出' }));
    await waitFor(() =>
      expect(
        within(importRow('thoerwink8/widgets')).getByRole('button', { name: /加进驾驶舱/ }),
      ).toBeTruthy(),
    );
  });

  test('一行一个状态：已导入但机器人没装全的只写「未接入」，不再另贴「已在驾驶舱」和「App 没装全」', async () => {
    renderApp(<SettingsPage />, { api: createMockApi({ live: false }), route: '/settings' });
    await openImport();
    await screen.findByText('adfx-studio/daihuo-workbench');
    const row = importRow('adfx-studio/daihuo-workbench');
    expect(row.querySelectorAll('[data-status]')).toHaveLength(1);
    expect(within(row).getByText('未接入')).toBeTruthy();
    expect(within(row).queryByText('已在驾驶舱')).toBeNull();
    expect(within(row).queryByText('App 没装全')).toBeNull();
  });

  test('没装全、又不在驾驶舱的仓：给「加进驾驶舱」，不给一键授权', async () => {
    renderApp(<SettingsPage />, { api: createMockApi({ live: false }), route: '/settings' });
    await openImport();
    await screen.findByText('thoerwink8/widgets');
    const row = importRow('thoerwink8/notes');
    expect(within(row).getByRole('button', { name: /加进驾驶舱/ })).toBeTruthy();
    expect(within(row).queryByRole('link', { name: '一键授权' })).toBeNull();
    expect(within(row).getByText(/个人/)).toBeTruthy();
  });

  test('已在驾驶舱的仓：给「移出驾驶舱」而不是「加进」', async () => {
    renderApp(<SettingsPage />, { api: createMockApi({ live: false }), route: '/settings' });
    await openImport();
    await screen.findByText('adfx-studio/daihuo-workbench');
    const row = importRow('adfx-studio/daihuo-workbench');
    expect(within(row).getByRole('button', { name: /移出驾驶舱/ })).toBeTruthy();
    expect(within(row).queryByRole('button', { name: /^加进驾驶舱/ })).toBeNull();
  });

  test('已在驾驶舱但机器人没装全：标「未接入」，明说先去 GitHub 装，给缺的 App 和设置页直达链接；装全的仓没有这条', async () => {
    renderApp(<SettingsPage />, { api: createMockApi({ live: false }), route: '/settings' });
    await openImport();
    await screen.findByText('adfx-studio/daihuo-workbench');
    const row = importRow('adfx-studio/daihuo-workbench');
    expect(within(row).getByText('未接入')).toBeTruthy();
    // 提示条在表上面，写清先去 GitHub 装
    const notice = screen
      .getByText('先去 GitHub 把两个机器人装到这个仓')
      .closest('[role="status"]') as HTMLElement;
    expect(notice.textContent).toContain('adfx-studio/daihuo-workbench');
    // 这个仓只缺「引擎」：只给引擎的安装页，不给已装的「干活的」；链接在这一行的操作格里
    const hrefs = within(row)
      .getAllByRole('link')
      .map((a) => a.getAttribute('href'));
    expect(hrefs).toEqual([
      'https://github.com/apps/fleet-dao-engine/installations/new',
      'https://github.com/organizations/adfx-studio/settings/installations',
    ]);
    // 没导入的仓不画「未接入」
    expect(within(importRow('thoerwink8/notes')).queryByText('未接入')).toBeNull();
  });

  test('已归档的仓：加进按钮不可用，不给一键授权', async () => {
    renderApp(<SettingsPage />, { api: createMockApi({ live: false }), route: '/settings' });
    await openImport();
    await screen.findByText('some-org/shared-lib');
    const row = importRow('some-org/shared-lib');
    expect(within(row).queryByRole('link', { name: '一键授权' })).toBeNull();
    const add = within(row).getByRole('button', { name: /加进驾驶舱/ });
    expect(add.getAttribute('aria-disabled')).toBe('true');
    expect(add.getAttribute('title')).toBe('已归档：不再改动');
    expect(within(row).getByText('已归档')).toBeTruthy();
  });

  test('页面写明新项目走 pnpm project add，没有「连接 GitHub」', async () => {
    renderApp(<SettingsPage />, { api: createMockApi({ live: false }), route: '/settings' });
    await openImport();
    expect((await screen.findAllByText(/pnpm project add/)).length).toBeGreaterThan(0);
    expect(screen.queryByRole('button', { name: /连接 GitHub/ })).toBeNull();
    expect(screen.queryByRole('button', { name: '断开' })).toBeNull();
  });
});

describe('设置页导入列表没读成', () => {
  test('reason 写在页面上，不给连接按钮', async () => {
    const api = createMockApi({ live: false });
    api.importableRepos = async () => ({ repos: [], reason: '这台后端没接上 GitHub' });
    renderApp(<SettingsPage />, { api, route: '/settings' });
    await openImport();
    expect(await screen.findByText('这台后端没接上 GitHub')).toBeTruthy();
    expect(screen.queryByRole('button', { name: /连接 GitHub/ })).toBeNull();
    expect(screen.queryByText('thoerwink8/widgets')).toBeNull();
  });
});
