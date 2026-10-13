// @vitest-environment happy-dom
// 发版卡卡住、失败后的三个按钮（#2027）：重试、恢复引擎开关、撤掉暂停。
// 每个按钮：后端说能点才出现；点了先弹确认框写明后果；确认键后端慢时转圈（aria-busy）、连点只发一次，成功才关；失败留在框里写原因。
import { act, cleanup, fireEvent, screen, waitFor, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';

const { toast } = vi.hoisted(() => ({
  toast: Object.assign(vi.fn(), { success: vi.fn(), error: vi.fn(), info: vi.fn(), warning: vi.fn() }),
}));
vi.mock('sonner', () => ({ toast, Toaster: () => null }));

import type { FleetApi } from '../api/client';
import { createMockApi, type MockApi } from '../api/mock/server';
import type { EnvResponse, Jobs, ReleaseCard } from '../api/types';
import France from '../routes/france';
import { renderApp } from './harness';

beforeEach(() => {
  for (const f of [toast.success, toast.error, toast.info, toast.warning]) f.mockClear();
});
afterEach(cleanup);

function deferred() {
  let resolve: (v: unknown) => void = () => {};
  let reject: (e: unknown) => void = () => {};
  const promise = new Promise<unknown>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

const HEAD = `2005b290${'a'.repeat(32)}`;
const LIVE = `6896b3cb${'b'.repeat(32)}`;
const ASOF = '2026-10-07T10:00:00.000Z';
type Action = ReleaseCard['action'];
type Recover = NonNullable<Action['recover']>;

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

const NONE: Recover = { retry: null, restore: null, abort: null };
const STUCK: Recover = {
  retry: { sha: HEAD, phase: '第 3 步「等收尾」' },
  restore: null,
  abort: {
    outcome: 'reopen',
    text: '还没动手发版：引擎总开关会开回暂停前的样子（开着），清掉暂停标记，这一趟记为撤销。',
  },
};
const RESTORE: Recover = { retry: null, restore: { target: '提交 2005b2909c4f' }, abort: null };
const PAUSED: Recover = {
  retry: null,
  restore: null,
  abort: { outcome: 'clear_marker', text: '只清掉留下来的暂停标记，引擎总开关不动。' },
};

function card(recover: Recover | undefined, last: Action['last']): ReleaseCard {
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
    action: { state: 'ready', reasons: [], installed: true, last, ...(recover ? { recover } : {}) },
    asOf: ASOF,
  };
}

const BLOCKED: Action['last'] = {
  state: 'blocked',
  target: '提交 2005b2909c4f',
  at: ASOF,
  why: '等了 30 分钟，法国还有 2 个会话在跑',
  phase: '第 3 步「等收尾」',
};
const FAILED: Action['last'] = {
  state: 'failed',
  target: '提交 2005b2909c4f',
  at: ASOF,
  why: '恢复没成：发版已经发出去了',
  phase: '第 7 步「恢复」',
};
const NOLAST: Action['last'] = { state: 'none', target: null, at: null, why: null, phase: null };

function api(c: ReleaseCard, recover: MockApi['franceReleaseRecover']) {
  const inner = createMockApi({ live: false });
  return {
    ...inner,
    env: () => Promise.resolve(envOk()),
    jobs: () => Promise.resolve({ asOf: ASOF, jobs: [] } satisfies Jobs),
    franceReleaseCard: () => Promise.resolve(c),
    franceReleaseRecover: recover,
  } as unknown as FleetApi;
}

describe('三个按钮什么时候出现', () => {
  test('后端说能点才出现：卡住给「重试」「撤掉暂停」，没成给「恢复引擎开关」，只剩标记给「撤掉暂停」；没有就一个都不画', async () => {
    const cases: [Recover | undefined, Action['last'], string[]][] = [
      [STUCK, BLOCKED, ['重试', '撤掉暂停']],
      [RESTORE, FAILED, ['恢复引擎开关']],
      [PAUSED, NOLAST, ['撤掉暂停']],
      [NONE, NOLAST, []],
      [undefined, NOLAST, []],
    ];
    for (const [recover, last, names] of cases) {
      const { unmount } = renderApp(<France />, {
        api: api(card(recover, last), () => Promise.reject(new Error('不该点'))),
        route: '/france',
      });
      await screen.findByRole('button', { name: '发布到法国' });
      const box = document.querySelector('[data-release-recover]');
      const got = [...(box?.querySelectorAll('button') ?? [])].map((b) => b.textContent);
      expect(got, JSON.stringify(recover)).toEqual(names);
      unmount();
    }
  });
});

for (const [kind, recover, last, opener, confirmName, needle] of [
  ['retry', STUCK, BLOCKED, '重试', '确认重试', '从这一步接着等会话收尾，往后照走，不从头暂停一遍'],
  ['restore', RESTORE, FAILED, '恢复引擎开关', '确认恢复', '按发版前记下的状态把它开回'],
  ['abort', STUCK, BLOCKED, '撤掉暂停', '确认撤掉', '引擎总开关会开回暂停前的样子'],
  ['abort', PAUSED, NOLAST, '撤掉暂停', '确认撤掉', '引擎总开关不动'],
] as const) {
  describe(`「${opener}」（${kind}）`, () => {
    test('点了先弹确认框写明后果；确认后发请求只带种类；后端慢时连点只发一次、确认键转圈（aria-busy）、框关不掉；成功才关并弹成功', async () => {
      const d = deferred();
      const calls: string[] = [];
      const a = api(card(recover, last), (k) => {
        calls.push(k);
        return d.promise.then(() => ({ requested: true as const, kind: k, at: ASOF }));
      });
      renderApp(<France />, { api: a, route: '/france' });
      const open = await screen.findByRole('button', { name: opener });
      fireEvent.click(open);
      const dialog = await screen.findByRole('alertdialog');
      expect(dialog.querySelector('[data-recover-body]')?.textContent).toContain(needle);
      expect(dialog.textContent).toContain('记一条操作记录');
      expect(calls).toEqual([]);

      const ok = within(dialog).getByRole('button', { name: confirmName });
      fireEvent.click(ok);
      fireEvent.click(ok);
      await waitFor(() => expect(ok.getAttribute('aria-busy')).toBe('true'));
      fireEvent.click(ok);
      expect(calls).toEqual([kind]);
      fireEvent.click(within(dialog).getByRole('button', { name: '先不' }));
      expect(screen.queryByRole('alertdialog')).not.toBeNull();

      await act(async () => d.resolve(undefined));
      await waitFor(() => expect(screen.queryByRole('alertdialog')).toBeNull());
      expect(toast.success).toHaveBeenCalledTimes(1);
      expect(calls).toEqual([kind]);
    });

    test('【故意造出的失败】后端回 409：框留在原处写原因、弹失败提示，确认键恢复能再点（不当成成功）', async () => {
      const a = api(card(recover, last), () => Promise.reject(new Error('现在没有可点的按钮：刷新页面再看')));
      renderApp(<France />, { api: a, route: '/france' });
      fireEvent.click(await screen.findByRole('button', { name: opener }));
      const dialog = await screen.findByRole('alertdialog');
      const ok = within(dialog).getByRole('button', { name: confirmName });
      fireEvent.click(ok);
      await waitFor(() => expect(within(dialog).getByRole('alert').textContent).toContain('刷新页面再看'));
      expect(screen.queryByRole('alertdialog')).not.toBeNull();
      expect(toast.error).toHaveBeenCalledTimes(1);
      expect(toast.success).not.toHaveBeenCalled();
      expect(ok.getAttribute('aria-busy')).not.toBe('true');
    });
  });
}

describe('假后端（dev:mock）：三个按钮点得动', () => {
  test('mockRelease 写 stuck：点「重试」后进入在走（时间线接着第 3 步），按钮消失', async () => {
    localStorage.setItem('mockRelease', 'stuck');
    try {
      const a = createMockApi({ live: false });
      const first = await a.franceReleaseCard();
      expect(first.action.last.state).toBe('blocked');
      expect(first.action.recover?.retry).not.toBeNull();
      await a.franceReleaseRecover('retry');
      const after = await a.franceReleaseCard();
      expect(after.action.last.state).toBe('running');
      expect(after.action.last.timeline?.phase).toBe(3);
      expect(after.action.recover).toEqual({ retry: null, restore: null, abort: null });
      await expect(a.franceReleaseRecover('retry')).rejects.toThrow();
    } finally {
      localStorage.removeItem('mockRelease');
    }
  });
});
