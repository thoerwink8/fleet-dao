// @vitest-environment happy-dom
// 主页抽屉「本机会话」一页（#1991）：在跑、刚停、超过阈值没动三态都画出来；
// 故意造出的失败：本机推不来了写「没上报」和上次收到在多久前，不画成 0 个会话；读不到写读不到。
import { cleanup, waitFor } from '@testing-library/react';
import { afterEach, expect, test } from 'vitest';
import { createMockApi } from '../api/mock/server';
import { LocalSessionsPanel } from '../components/home/local-sessions';
import { renderApp } from './harness';

afterEach(cleanup);

const text = () => document.querySelector('[data-local-sessions]')?.textContent ?? '';

test('三态都在：在跑、刚停、超过 15 分钟没动；只写仓、分支、工具名', async () => {
  renderApp(<LocalSessionsPanel />);
  await waitFor(() => expect(text()).toContain('创始人的电脑'));
  expect(text()).toContain('在上报');
  expect(text()).toContain('在跑');
  expect(text()).toContain('刚停');
  expect(text()).toContain('超过 15 分钟没动');
  expect(text()).toContain('thoerwink8/fleet-dao');
});

test('【故意造出的失败】9 分钟没推来：写没上报和上次收到在多久前，会话写「上次看到」', async () => {
  const api = createMockApi({ live: false });
  const now = Date.now();
  api.localSessions = async () => ({
    asOf: new Date(now).toISOString(),
    nodes: [
      {
        id: 'founder-pc',
        freshness: 'stale',
        machine: '创始人的电脑',
        receivedAt: new Date(now - 9 * 60_000).toISOString(),
        reportedAt: new Date(now - 9 * 60_000).toISOString(),
        problems: [],
        sessions: [
          {
            id: 's',
            repo: 'thoerwink8/fleet-dao',
            branch: 'main',
            worktree: null,
            subagent: false,
            startedAt: new Date(now - 60 * 60_000).toISOString(),
            lastSeenAt: new Date(now - 10 * 60_000).toISOString(),
            last: 'tool',
            lastTool: 'Bash',
            state: 'running',
            idleMs: 60_000,
          },
        ],
      },
    ],
  });
  renderApp(<LocalSessionsPanel />, { api });
  await waitFor(() => expect(text()).toContain('没上报'));
  expect(text()).toContain('上次收到是 9 分钟前');
  expect(text()).toContain('上次看到');
  expect(text()).not.toContain('在跑');
});

test('【故意造出的失败】从没推过：没上报，不画成 0 个会话', async () => {
  const api = createMockApi({ live: false });
  api.localSessions = async () => ({
    asOf: new Date().toISOString(),
    nodes: [{ id: 'founder-pc', freshness: 'never', sessions: [], problems: [] }],
  });
  renderApp(<LocalSessionsPanel />, { api });
  await waitFor(() => expect(text()).toContain('一次都没收到'));
  expect(text()).not.toContain('此刻没有会话');
});
