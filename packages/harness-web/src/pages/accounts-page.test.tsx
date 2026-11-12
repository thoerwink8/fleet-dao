// @vitest-environment happy-dom
// #3925：设置页能选当前 agent 和档位；额度读不到就写读不到，不画假数。
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const h = vi.hoisted(() => {
  const card = (id: string, login: string, account: string, models: string[], modelsNote = '') => ({
    id,
    ready: login === '已登录',
    login,
    account,
    models,
    modelsNote,
    saved: [] as { id: string; label: string; active: boolean }[],
  });
  return {
    calls: [] as [string, string][],
    quota: {} as Record<string, string>,
    quotaFails: false,
    view: {
      agent: 'claude',
      tier: 'default',
      agents: [
        card('claude', '已登录', 'a@b.c', ['sonnet'], 'CLI 没有型号名单，这是别名'),
        card('grok', '已登录', 'g@x.ai', ['grok-4.7', 'grok-4.6']),
        card('codex', '未登录', '未登录', []),
        card('pi', '未登录', '未登录', []),
      ],
      relays: [] as { id: string; name: string; baseUrl: string; hasKey: boolean; models: string[] }[],
    },
  };
});

vi.mock('../lib/accounts', async () => {
  const actual = await vi.importActual<typeof import('../lib/accounts')>('../lib/accounts');
  return {
    ...actual,
    loadAccountsView: () => Promise.resolve(h.view),
    loadQuota: () => (h.quotaFails ? Promise.reject(new Error('超时')) : Promise.resolve(h.quota)),
    saveSelection: (agent: string, tier: string) => {
      h.calls.push([agent, tier]);
      h.view = { ...h.view, agent, tier };
      return Promise.resolve(h.view);
    },
    saveActive: () => Promise.resolve(h.view),
    createAccount: () => Promise.resolve(h.view),
    deleteAccount: () => Promise.resolve(h.view),
    createRelay: () => Promise.resolve(h.view),
    deleteRelay: () => Promise.resolve(h.view),
  };
});

const { AccountsPanel } = await import('./accounts-page');

beforeEach(() => {
  h.calls.length = 0;
  h.quota = {};
  h.quotaFails = false;
  h.view = { ...h.view, agent: 'claude', tier: 'default' };
});
afterEach(cleanup);

describe('模型与账号', () => {
  it('点 grok 和「深」把当前选择交出去', async () => {
    render(<AccountsPanel />);
    await waitFor(() => expect(screen.getByTestId('accounts-agent-grok')).toBeTruthy());
    fireEvent.click(screen.getByTestId('accounts-agent-grok'));
    await waitFor(() => expect(h.calls).toEqual([['grok', 'default']]));
    fireEvent.click(screen.getByTestId('accounts-tier-high'));
    await waitFor(() =>
      expect(h.calls).toEqual([
        ['grok', 'default'],
        ['grok', 'high'],
      ]),
    );
    expect(screen.getByTestId('accounts-tier-high').getAttribute('aria-pressed')).toBe('true');
  });

  it('未登录写出来，型号列出来；额度空着就是读不到，不补 0 或 100%', async () => {
    render(<AccountsPanel />);
    await waitFor(() => expect(screen.getByText('grok-4.7')).toBeTruthy());
    expect(screen.getByTestId('account-card-codex').textContent).toContain('未登录');
    expect(screen.getByTestId('account-card-pi').textContent).toContain('未登录');
    expect(screen.getByText('CLI 没有型号名单，这是别名')).toBeTruthy();
    expect(screen.getByTestId('quota-claude').textContent).toBe('额度 读不到');
    expect(screen.getByTestId('quota-grok').textContent).toBe('额度 读不到');
    expect(screen.queryByText('100%')).toBeNull();
    expect(screen.queryByText('0')).toBeNull();
  });

  it('有读数才显示；额度接口失败仍是读不到', async () => {
    h.quota = { grok: '7d 12/100' };
    const shown = render(<AccountsPanel />);
    await waitFor(() => expect(screen.getByTestId('quota-grok').textContent).toBe('额度 7d 12/100'));
    expect(screen.getByTestId('quota-claude').textContent).toBe('额度 读不到');
    expect(screen.queryByText('100%')).toBeNull();
    shown.unmount();

    h.quota = {};
    h.quotaFails = true;
    render(<AccountsPanel />);
    await waitFor(() => expect(screen.getByTestId('quota-grok').textContent).toBe('额度 读不到'));
  });
});
