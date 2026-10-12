// @vitest-environment happy-dom
// 设置页每个仓的 CI 模式：读回来和选的一致，切换记录看得到；已有的仓默认强制。
// fleet-dao 改成不强制时写明它推规矩；名字只是像 fleet-dao 的不写。
import { cleanup, fireEvent, screen, waitFor, within } from '@testing-library/react';
import { afterEach, describe, expect, test } from 'vitest';
import { createMockApi } from '../api/mock/server';
import SettingsPage from '../routes/settings';
import { renderApp } from '../test/harness';

afterEach(cleanup);

const RULES = '各仓各机器的规矩';

describe('设置页 CI 模式', () => {
  test('已有的仓都是强制 CI；切成不强制后读回来一致，并看得到谁切的', async () => {
    renderApp(<SettingsPage />, { route: '/settings' });
    const orbit = await screen.findByTestId('ci-policy-r-orbit');
    expect(within(orbit).getByText('强制 CI')).toBeTruthy();
    for (const id of ['r-orbit', 'r-canary', 'r-site']) {
      expect(within(screen.getByTestId(`ci-policy-${id}`)).getByText('强制 CI')).toBeTruthy();
    }

    fireEvent.click(within(orbit).getByRole('button', { name: /改成不强制/ }));
    const dialog = await screen.findByRole('alertdialog');
    expect(dialog.textContent ?? '').not.toContain(RULES);
    expect(dialog.textContent ?? '').toContain('开完 PR 引擎直接合并');
    fireEvent.click(within(dialog).getByRole('button', { name: /改成不强制/ }));

    await waitFor(() => {
      expect(within(screen.getByTestId('ci-policy-r-orbit')).getByText('不强制 CI')).toBeTruthy();
    });
    const after = screen.getByTestId('ci-policy-r-orbit');
    expect(after.textContent ?? '').toContain('阿岚');
    expect(after.textContent ?? '').toContain('强制 CI → 不强制 CI');
    expect(within(screen.getByTestId('ci-policy-r-site')).getByText('强制 CI')).toBeTruthy();
  });

  test('仓名是 fleet-dao 时，改成不强制的确认里写明它推各仓各机器的规矩', async () => {
    const api = createMockApi({ live: false });
    api.state().repos.push({
      id: 'r-fleet',
      owner: 'acme',
      name: 'fleet-dao',
      defaultBranch: 'main',
      testCommand: 'pnpm check',
    });
    renderApp(<SettingsPage />, { api, route: '/settings' });
    const row = await screen.findByTestId('ci-policy-r-fleet');
    fireEvent.click(within(row).getByRole('button', { name: /改成不强制/ }));
    const dialog = await screen.findByRole('alertdialog');
    expect(dialog.textContent ?? '').toContain(RULES);
    expect(dialog.textContent ?? '').toContain('不再等检查');
  });

  test('仓名是 fleet-dao-canary 时不写那句规矩警告', async () => {
    const api = createMockApi({ live: false });
    api.state().repos.push({
      id: 'r-canary-dao',
      owner: 'acme',
      name: 'fleet-dao-canary',
      defaultBranch: 'main',
      testCommand: 'pnpm check',
    });
    renderApp(<SettingsPage />, { api, route: '/settings' });
    const row = await screen.findByTestId('ci-policy-r-canary-dao');
    fireEvent.click(within(row).getByRole('button', { name: /改成不强制/ }));
    const dialog = await screen.findByRole('alertdialog');
    expect(dialog.textContent ?? '').not.toContain(RULES);
    expect(dialog.textContent ?? '').toContain('改标准的路径仍要人点头');
  });
});
