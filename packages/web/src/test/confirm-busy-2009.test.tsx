// @vitest-environment happy-dom
// 两个最危险的确认键接上忙态（#2009）：「确认发布」和「叫停」。后端慢的时候连点只发一次请求，
// 等的那段按钮转圈（aria-busy）、框关不掉；后端回了成功框才关。
import { act, cleanup, fireEvent, screen, waitFor, within } from '@testing-library/react';
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

import type { FleetApi } from '../api/client';
import { createMockApi, type MockApi } from '../api/mock/server';
import type { EnvResponse, Jobs, ReleaseCard } from '../api/types';
import { ActionButtons, targetOf } from '../components/task-actions';
import France from '../routes/france';
import { renderApp } from './harness';

beforeEach(() => {
  for (const f of [toast.success, toast.error, toast.info, toast.warning]) f.mockClear();
});
afterEach(cleanup);

function deferred() {
  let resolve: (v: unknown) => void = () => {};
  const promise = new Promise<unknown>((res) => {
    resolve = res;
  });
  return { promise, resolve };
}

const HEAD = `2005b290${'a'.repeat(32)}`;
const LIVE = `6896b3cb${'b'.repeat(32)}`;
const ASOF = '2026-10-07T10:00:00.000Z';

function envOk(): EnvResponse {
  const fact = <T,>(value: T) => ({ ok: true as const, value });
  return {
    name: { name: '法国' },
    asOf: ASOF,
    facts: {
      engine: fact({ state: 'on' }),
      version: fact({ current: LIVE, behind: 3, detail: '在用', problems: [] }),
      sessions: fact({ total: 0, byStage: {} }),
      pools: fact({ count: 0, running: 0, unread: 0, stale: 0 }),
      health: fact({ ok: true, total: 0, failing: [], notWired: [] }),
      schedule: fact({ status: 'fresh', lastSuccessAt: ASOF, outcome: 'ok' }),
    },
  };
}

function card(): ReleaseCard {
  return {
    mainline: {
      state: 'ok',
      commit: { sha: HEAD, short: HEAD.slice(0, 12), title: '刷新耗时表 (#1230)', at: ASOF },
      ci: { state: 'green' },
    },
    deployed: {
      state: 'ok',
      sha: LIVE,
      short: LIVE.slice(0, 12),
      title: '探针历史 (#1225)',
      titleWhy: null,
      deployedAt: ASOF,
      deployedAtWhy: null,
    },
    gap: { state: 'ahead', count: 1, prs: [{ number: 1230, title: '刷新耗时表' }], nonPr: 0 },
    lastDone: { state: 'unreadable', why: '测试里不读' },
    action: {
      state: 'ready',
      reasons: [],
      installed: true,
      last: { state: 'none', target: null, at: null, why: null, phase: null },
    },
    asOf: ASOF,
  };
}

describe('确认发布：后端慢时连点只发一次，等的时候转圈、框关不掉', () => {
  test('慢请求', async () => {
    const d = deferred();
    const calls: string[] = [];
    const inner = createMockApi({ live: false });
    const api = {
      ...inner,
      env: () => Promise.resolve(envOk()),
      jobs: () => Promise.resolve({ asOf: ASOF, jobs: [] } satisfies Jobs),
      franceReleaseCard: () => Promise.resolve(card()),
      // 弹窗一打开现跑预检（#2026）：给一份全过的，确认键才能点（假后端默认回「没接上」）
      francePreflight: () =>
        Promise.resolve({
          state: 'done' as const,
          command: '进程内读事实',
          code: 0,
          signal: null,
          stdout: '主线头和 CI：通过 绿\n',
          stderr: '',
          durationMs: 5,
          timedOut: false,
          truncated: false,
          asOf: ASOF,
        }),
      franceRelease: (sha: string) => {
        calls.push(sha);
        return d.promise.then(() => ({ requested: true, sha, at: ASOF }));
      },
    } as MockApi;
    renderApp(<France />, { api: api as unknown as FleetApi, route: '/france' });
    fireEvent.click(await screen.findByRole('button', { name: '发布到法国' }));
    const dialog = await screen.findByRole('alertdialog');
    const ok = within(dialog).getByRole('button', { name: '确认发布' });
    // 框里先现跑一遍预检（#2026），跑完没有卡住项确认键才能点
    await waitFor(() => expect(ok.hasAttribute('disabled')).toBe(false));
    fireEvent.click(ok);
    fireEvent.click(ok);
    await waitFor(() => expect(ok.getAttribute('aria-busy')).toBe('true'));
    fireEvent.click(ok);
    expect(calls).toEqual([HEAD]);
    fireEvent.click(within(dialog).getByRole('button', { name: '先不' }));
    expect(screen.queryByRole('alertdialog')).not.toBeNull();

    await act(async () => d.resolve(undefined));
    await waitFor(() => expect(screen.queryByRole('alertdialog')).toBeNull());
    expect(toast.success).toHaveBeenCalledTimes(1);
    expect(calls).toEqual([HEAD]);
  });
});

describe('叫停：后端慢时连点只发一次，成功才关', () => {
  test('慢请求', async () => {
    const d = deferred();
    const api = createMockApi({ live: false });
    const taskAction = vi.spyOn(api, 'taskAction').mockImplementation(() => d.promise as Promise<undefined>);
    const task = (await api.board('r-orbit')).tasks.find(
      (t) => t.state !== 'done' && t.state !== 'stopped' && t.state !== 'failed',
    );
    if (!task) throw new Error('没有还能操作的任务');
    renderApp(<ActionButtons target={targetOf(task)} />, { api });
    fireEvent.click(screen.getByRole('button', { name: '叫停' }));
    const dialog = await screen.findByRole('alertdialog');
    const ok = within(dialog).getByRole('button', { name: '叫停' });
    fireEvent.click(ok);
    fireEvent.click(ok);
    await waitFor(() => expect(ok.getAttribute('aria-busy')).toBe('true'));
    fireEvent.click(ok);
    fireEvent.keyDown(dialog, { key: 'Escape' });
    expect(screen.queryByRole('alertdialog')).not.toBeNull();
    expect(taskAction).toHaveBeenCalledTimes(1);

    await act(async () => d.resolve(undefined));
    await waitFor(() => expect(screen.queryByRole('alertdialog')).toBeNull());
    expect(toast.success).toHaveBeenCalledWith(`叫停：#${task.issueNumber}`, { description: undefined });
    expect(taskAction).toHaveBeenCalledExactlyOnceWith(task.id, { action: 'stop' });
  });
});
