// @vitest-environment happy-dom
// 设置页「导入仓库」（#1989）：列出本人 GitHub 上看得见的仓，个人/组织分开，能加进驾驶舱、能断开。
// 走假数据（mock api），不联网。
import { cleanup, fireEvent, screen, waitFor, within } from '@testing-library/react';
import { afterEach, describe, expect, test } from 'vitest';
import { createMockApi } from '../api/mock/server';
import SettingsPage from '../routes/settings';
import { renderApp } from './harness';

afterEach(cleanup);

describe('设置页导入仓库（#1989）', () => {
  test('连上 GitHub 后列出本人的仓，个人仓和组织仓分开', async () => {
    renderApp(<SettingsPage />, { api: createMockApi({ live: false }), route: '/settings' });
    // 等到「导入仓库」那一块出现
    await screen.findByText('导入仓库');
    expect(await screen.findByText('thoerwink8/widgets')).toBeTruthy();
    expect(screen.getByText('thoerwink8/notes')).toBeTruthy();
    expect(screen.getByText('adfx-studio/daihuo-workbench')).toBeTruthy();
    expect(screen.getByRole('heading', { name: /个人仓/ })).toBeTruthy();
    expect(screen.getByRole('heading', { name: /组织的仓/ })).toBeTruthy();
  });

  test('点「加进驾驶舱」后这一行当场变成已导入（假后端也要刷新列表）；移出后变回去', async () => {
    renderApp(<SettingsPage />, { api: createMockApi({ live: false }), route: '/settings' });
    await screen.findByText('thoerwink8/widgets');
    // 接进来之后项目列表里也会出现这个仓：只认带「加进 / 移出驾驶舱」按钮的那一行（导入列表里的）
    const rowOf = () =>
      screen
        .getAllByText('thoerwink8/widgets')
        .map((e) => e.closest('li') as HTMLElement)
        .find((li) => within(li).queryByRole('button', { name: /驾驶舱/ })) as HTMLElement;
    fireEvent.click(within(rowOf()).getByRole('button', { name: /加进驾驶舱/ }));
    await waitFor(() => expect(within(rowOf()).getByRole('button', { name: /移出驾驶舱/ })).toBeTruthy());
    expect(within(rowOf()).queryByRole('button', { name: /^加进驾驶舱/ })).toBeNull();
    expect(within(rowOf()).getByText('已在驾驶舱')).toBeTruthy();

    fireEvent.click(within(rowOf()).getByRole('button', { name: /移出驾驶舱/ }));
    fireEvent.click(await screen.findByRole('button', { name: '移出' }));
    await waitFor(() => expect(within(rowOf()).getByRole('button', { name: /加进驾驶舱/ })).toBeTruthy());
  });

  test('窄屏：已导入行的徽章只留给读屏、状态写进第二行小字，仓名不被两个按钮挤没（#2211）', async () => {
    renderApp(<SettingsPage />, { api: createMockApi({ live: false }), route: '/settings' });
    await screen.findByText('adfx-studio/daihuo-workbench');
    const row = screen.getByText('adfx-studio/daihuo-workbench').closest('li') as HTMLElement;
    const badge = within(row).getByText('已在驾驶舱');
    expect(badge.closest('[class~="max-md:sr-only"]')).toBeTruthy();
    const meta = row.querySelector('[data-row-meta]') as HTMLElement;
    expect(meta.querySelector('[class~="md:hidden"]')?.textContent).toContain('已在驾驶舱');
  });

  test('没装全、又不在驾驶舱的仓：给「加进驾驶舱」，不给一键授权', async () => {
    renderApp(<SettingsPage />, { api: createMockApi({ live: false }), route: '/settings' });
    await screen.findByText('thoerwink8/widgets');
    const row = screen.getByText('thoerwink8/notes').closest('li') as HTMLElement;
    expect(within(row).getByRole('button', { name: /加进驾驶舱/ })).toBeTruthy();
    expect(within(row).queryByRole('link', { name: '一键授权' })).toBeNull();
    expect(within(row).getByText(/个人/)).toBeTruthy();
  });

  test('已在驾驶舱的仓：给「移出驾驶舱」而不是「加进」', async () => {
    renderApp(<SettingsPage />, { api: createMockApi({ live: false }), route: '/settings' });
    await screen.findByText('adfx-studio/daihuo-workbench');
    const row = screen.getByText('adfx-studio/daihuo-workbench').closest('li') as HTMLElement;
    expect(within(row).getByRole('button', { name: /移出驾驶舱/ })).toBeTruthy();
    expect(within(row).queryByRole('button', { name: /^加进驾驶舱/ })).toBeNull();
  });

  test('已在驾驶舱但机器人没装全：标「未接入」，明说先去 GitHub 装，给缺的 App 和设置页直达链接；装全的仓没有这条', async () => {
    renderApp(<SettingsPage />, { api: createMockApi({ live: false }), route: '/settings' });
    await screen.findByText('adfx-studio/daihuo-workbench');
    const row = screen.getByText('adfx-studio/daihuo-workbench').closest('li') as HTMLElement;
    expect(within(row).getByText('未接入')).toBeTruthy();
    // 横幅在行后面（同一个列表容器里），按文字找
    const notice = screen
      .getByText('先去 GitHub 把两个机器人装到这个仓')
      .closest('[role="status"]') as HTMLElement;
    expect(within(notice).getByText('先去 GitHub 把两个机器人装到这个仓')).toBeTruthy();
    // 这个仓只缺「引擎」：只给引擎的安装页，不给已装的「干活的」
    const hrefs = within(notice)
      .getAllByRole('link')
      .map((a) => a.getAttribute('href'));
    expect(hrefs).toEqual([
      'https://github.com/apps/fleet-dao-engine/installations/new',
      'https://github.com/organizations/adfx-studio/settings/installations',
    ]);
    // 没导入的仓不画「未接入」
    const notes = screen.getByText('thoerwink8/notes').closest('li') as HTMLElement;
    expect(within(notes).queryByText('未接入')).toBeNull();
  });

  test('已归档的仓：加进按钮不可用，不给一键授权', async () => {
    renderApp(<SettingsPage />, { api: createMockApi({ live: false }), route: '/settings' });
    await screen.findByText('some-org/shared-lib');
    const row = screen.getByText('some-org/shared-lib').closest('li') as HTMLElement;
    expect(within(row).queryByRole('link', { name: '一键授权' })).toBeNull();
    expect((within(row).getByRole('button', { name: /加进驾驶舱/ }) as HTMLButtonElement).disabled).toBe(
      true,
    );
    expect(within(row).getByText('已归档')).toBeTruthy();
  });

  test('页面写明新项目走 pnpm project add，没有「连接 GitHub」', async () => {
    renderApp(<SettingsPage />, { api: createMockApi({ live: false }), route: '/settings' });
    await screen.findByText('导入仓库');
    expect(await screen.findByText(/pnpm project add/)).toBeTruthy();
    expect(screen.queryByRole('button', { name: /连接 GitHub/ })).toBeNull();
    expect(screen.queryByRole('button', { name: '断开' })).toBeNull();
  });
});

describe('设置页导入列表没读成', () => {
  test('reason 写在页面上，不给连接按钮', async () => {
    const api = createMockApi({ live: false });
    api.importableRepos = async () => ({ repos: [], reason: '这台后端没接上 GitHub' });
    renderApp(<SettingsPage />, { api, route: '/settings' });
    await screen.findByText('导入仓库');
    expect(await screen.findByText('这台后端没接上 GitHub')).toBeTruthy();
    expect(screen.queryByRole('button', { name: /连接 GitHub/ })).toBeNull();
    expect(screen.queryByText('thoerwink8/widgets')).toBeNull();
  });
});
