// @vitest-environment happy-dom
// 设置页每个仓的 CI 模式：表里一格写现在的模式，展开区里有说明、切换按钮和最近几次谁切的；已有的仓默认强制。
// fleet-dao 改成不强制时写明它推规矩；名字只是像 fleet-dao 的不写。
import { cleanup, fireEvent, screen, waitFor, within } from '@testing-library/react';
import { afterEach, describe, expect, test } from 'vitest';
import { createMockApi } from '../api/mock/server';
import SettingsPage from '../routes/settings';
import { renderApp } from '../test/harness';

afterEach(cleanup);

const RULES = '各仓各机器的规矩';

/** 点开这个仓那一行的展开区，返回里面的 CI 模式块。 */
async function openCi(id: string): Promise<HTMLElement> {
  const row = await waitFor(() => {
    const r = document.querySelector(`tr[data-row-key="${id}"]`);
    if (!(r instanceof HTMLElement)) throw new Error(`还没画出 ${id} 这一行`);
    return r;
  });
  const toggle = within(row).getByRole('button', { name: /^(展开|收起)$/ });
  if (toggle.getAttribute('aria-expanded') !== 'true') fireEvent.click(toggle);
  return await screen.findByTestId(`ci-policy-${id}`);
}

describe('设置页 CI 模式', () => {
  test('已有的仓都是强制 CI；切成不强制后读回来一致，并看得到谁切的', async () => {
    renderApp(<SettingsPage />, { route: '/settings' });
    const orbit = await openCi('r-orbit');
    for (const id of ['r-orbit', 'r-canary', 'r-site']) {
      await waitFor(() => expect(screen.getByTestId(`ci-policy-state-${id}`).textContent).toBe('强制 CI'));
    }

    fireEvent.click(within(orbit).getByRole('button', { name: /改成不强制/ }));
    const dialog = await screen.findByRole('alertdialog');
    expect(dialog.textContent ?? '').not.toContain(RULES);
    expect(dialog.textContent ?? '').toContain('开完 PR 引擎直接合并');
    fireEvent.click(within(dialog).getByRole('button', { name: /改成不强制/ }));

    await waitFor(() => {
      expect(screen.getByTestId('ci-policy-state-r-orbit').textContent).toBe('不强制 CI');
    });
    const after = screen.getByTestId('ci-policy-r-orbit');
    expect(after.textContent ?? '').toContain('阿岚');
    expect(after.textContent ?? '').toContain('强制 CI → 不强制 CI');
    expect(screen.getByTestId('ci-policy-state-r-site').textContent).toBe('强制 CI');
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
    const row = await openCi('r-fleet');
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
    const row = await openCi('r-canary-dao');
    fireEvent.click(within(row).getByRole('button', { name: /改成不强制/ }));
    const dialog = await screen.findByRole('alertdialog');
    expect(dialog.textContent ?? '').not.toContain(RULES);
    expect(dialog.textContent ?? '').toContain('改标准的路径仍要人点头');
  });
});
