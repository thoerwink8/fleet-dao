// @vitest-environment happy-dom
// 驾驶舱写请求按钮忙态第二期（#2012）：第一期（#2009）给公共 Button 加了 loading、给确认框确定键加了 onConfirm，
// 这一期把剩下只置灰（disabled={x.isPending}）的写请求按钮换成 loading，确认框的确定键换成 onConfirm。
// 每处一条：后端慢时按钮 aria-busy="true"（转圈、播报），连点只发一次请求。
import { act, cleanup, fireEvent, screen, waitFor, within } from '@testing-library/react';
import { Route, Routes } from 'react-router';
import { afterEach, describe, expect, test, vi } from 'vitest';

const { toast } = vi.hoisted(() => ({
  toast: Object.assign(vi.fn(), { success: vi.fn(), error: vi.fn(), info: vi.fn(), warning: vi.fn() }),
}));
vi.mock('sonner', () => ({ toast, Toaster: () => null }));

import type { FleetApi } from '../api/client';
import { createMockApi, type MockApi } from '../api/mock/server';
import type { EnvResponse, Jobs, ReleaseCard, TaskDetail, UpdateTaskRoutePinBody } from '../api/types';
import { Topbar } from '../components/shell/topbar';
import France from '../routes/france';
import QuotaPage from '../routes/quota';
import ResourcesPage from '../routes/resources';
import RoutingPage from '../routes/routing';
import RoutingStatus from '../routes/routing-status';
import SettingsPage from '../routes/settings';
import TaskPage from '../routes/task';
import { renderApp } from './harness';

afterEach(cleanup);

/** 一个能等到本轮测试手动放行的 Promise（后端慢下来）。 */
function deferred<T>() {
  let resolve: (v: T) => void = () => {};
  const promise = new Promise<T>((res) => {
    resolve = res;
  });
  return { promise, resolve };
}

/** 慢请求时按钮 aria-busy；同一帧里连点只发一次。 */
async function busyOnce(btn: HTMLElement, calls: { length: number }) {
  fireEvent.click(btn);
  fireEvent.click(btn);
  await waitFor(() => expect(btn.getAttribute('aria-busy')).toBe('true'));
  fireEvent.click(btn);
  expect(calls.length).toBe(1);
}

describe('导入仓库（设置页）', () => {
  test('「加进驾驶舱」：慢请求时 aria-busy，连点只发一次', async () => {
    const inner = createMockApi({ live: false });
    const d = deferred<unknown>();
    const calls: number[] = [];
    const api = {
      ...inner,
      importRepo: (githubId: number) => {
        calls.push(githubId);
        return d.promise;
      },
    } as unknown as MockApi;
    renderApp(<SettingsPage />, { api: api as unknown as FleetApi, route: '/settings' });
    // 导入仓库收在仓库卡头的入口里，点开才有这张表
    fireEvent.click(await screen.findByRole('button', { name: '导入仓库' }));
    const row = (await screen.findByText('thoerwink8/widgets')).closest('tr') as HTMLElement;
    const add = within(row).getByRole('button', { name: /加进驾驶舱/ });
    await busyOnce(add, calls);
    await act(async () => d.resolve({ created: true }));
  });
});

describe('整理确认（设置页「指挥官整理待办」）', () => {
  test('「确认整理」：onConfirm 等结果——慢请求时转圈、连点只发一次、成功才关框', async () => {
    const api = createMockApi({ live: false });
    const version = (await api.settings()).settings.find((s) => s.key === 'engine.master')?.version ?? 0;
    await api.updateSetting('engine.master', { value: true, version });
    const d = deferred<void>();
    const calls: string[] = [];
    vi.spyOn(api, 'groomNow').mockImplementation((repoId: string) => {
      calls.push(repoId);
      return d.promise as never;
    });
    renderApp(<SettingsPage />, { api, route: '/settings' });
    const panel = await screen.findByTestId('groom-r-orbit');
    await waitFor(() =>
      expect(
        within(panel)
          .getByRole('button', { name: /让指挥官整理/ })
          .getAttribute('aria-disabled'),
      ).toBeNull(),
    );
    fireEvent.click(within(panel).getByRole('button', { name: /让指挥官整理/ }));
    const dialog = await screen.findByRole('alertdialog');
    const ok = within(dialog).getByRole('button', { name: '确认整理' });
    fireEvent.click(ok);
    fireEvent.click(ok);
    await waitFor(() => expect(ok.getAttribute('aria-busy')).toBe('true'));
    fireEvent.click(ok);
    expect(calls).toEqual(['r-orbit']);
    await act(async () => d.resolve());
    await waitFor(() => expect(screen.queryByRole('alertdialog')).toBeNull());
    expect(toast.success).toHaveBeenCalled();
  });

  test('【故意造出的失败】后端拒了：框留着写原因，确定键恢复能再点', async () => {
    const api = createMockApi({ live: false });
    const version = (await api.settings()).settings.find((s) => s.key === 'engine.master')?.version ?? 0;
    await api.updateSetting('engine.master', { value: true, version });
    vi.spyOn(api, 'groomNow').mockRejectedValueOnce(new Error('整理待办的记录没读成：库连不上'));
    renderApp(<SettingsPage />, { api, route: '/settings' });
    const panel = await screen.findByTestId('groom-r-orbit');
    await waitFor(() =>
      expect(
        within(panel)
          .getByRole('button', { name: /让指挥官整理/ })
          .getAttribute('aria-disabled'),
      ).toBeNull(),
    );
    fireEvent.click(within(panel).getByRole('button', { name: /让指挥官整理/ }));
    const dialog = await screen.findByRole('alertdialog');
    fireEvent.click(within(dialog).getByRole('button', { name: '确认整理' }));
    const alert = await within(dialog).findByRole('alert');
    expect(alert.textContent).toContain('整理待办的记录没读成：库连不上');
    expect(screen.queryByRole('alertdialog')).not.toBeNull();
    expect(within(dialog).getByRole('button', { name: '确认整理' }).getAttribute('aria-busy')).toBeNull();
  });
});

describe('单子页「用哪个模型」', () => {
  /** #12 动手指定 Kimi（和在跑的不一样）：露出「现在就换」那一条。 */
  const pinned = (inner: MockApi): MockApi =>
    ({
      ...inner,
      task: async (id: string) => {
        const d = await inner.task(id);
        return {
          ...d,
          routePins: {
            pins: [
              { segment: 'manual', modelId: 'kimi-k3', setBy: 'u-lan', setAt: new Date().toISOString() },
            ],
          },
        } satisfies TaskDetail;
      },
    }) as MockApi;

  const openTask = (route: string, api: FleetApi) =>
    renderApp(
      <Routes>
        <Route path="/tasks/:taskId" element={<TaskPage />} />
      </Routes>,
      { route, api },
    );

  test('「回到自动」：慢请求时 aria-busy，连点只发一次', async () => {
    const inner = createMockApi({ live: false });
    const d = deferred<unknown>();
    const calls: UpdateTaskRoutePinBody[] = [];
    const api = {
      ...inner,
      updateTaskRoutePin: (_taskId: string, body: UpdateTaskRoutePinBody) => {
        calls.push(body);
        return d.promise;
      },
    } as unknown as FleetApi;
    // 「用哪个模型」在「用量和模型」里，默认收起（#3228）
    openTask('/tasks/t-14?usage=open', api);
    await screen.findByRole('heading', { name: '用哪个模型' });
    const manual = document.querySelector('[data-pin-segment="manual"]') as HTMLElement;
    const back = within(manual).getByRole('button', { name: '回到自动' });
    await busyOnce(back, calls);
    await act(async () => d.resolve({ ok: true }));
  });

  test('「确认现在就换」：慢请求时 aria-busy，连点只发一次', async () => {
    const inner = createMockApi({ live: false });
    const d = deferred<unknown>();
    const calls: UpdateTaskRoutePinBody[] = [];
    const api = {
      ...pinned(inner),
      updateTaskRoutePin: (_taskId: string, body: UpdateTaskRoutePinBody) => {
        calls.push(body);
        return d.promise;
      },
    } as unknown as FleetApi;
    openTask('/tasks/t-12?usage=open', api);
    await screen.findByRole('heading', { name: '用哪个模型' });
    const manual = document.querySelector('[data-pin-segment="manual"]') as HTMLElement;
    fireEvent.click(await within(manual).findByRole('button', { name: '现在就换' }));
    const go = await within(manual).findByRole('button', { name: '确认现在就换' });
    await busyOnce(go, calls);
    await act(async () => d.resolve({ ok: true }));
  });
});

describe('顶栏提醒的「处理」', () => {
  test('慢请求时 aria-busy，连点只发一次', async () => {
    const api = createMockApi({ live: false });
    const d = deferred<void>();
    const calls: string[] = [];
    vi.spyOn(api, 'resolveNotification').mockImplementation((id: string) => {
      calls.push(id);
      return d.promise as never;
    });
    renderApp(<Topbar onSearch={() => {}} />, { api });
    fireEvent.click(await screen.findByRole('button', { name: /提醒/ }));
    await screen.findByText('待处理的提醒');
    // 弹出的提醒不止一条，每条都有一个「处理」；挑第一条验忙态
    const [resolve] = await screen.findAllByRole('button', { name: '处理' });
    if (!resolve) throw new Error('提醒里没有「处理」按钮');
    await busyOnce(resolve, calls);
    await act(async () => d.resolve());
  });
});

describe('发版预检（法国页）', () => {
  const HEAD = `2005b290${'a'.repeat(32)}`;
  const ASOF = '2026-10-07T10:00:00.000Z';

  test('慢请求时 aria-busy，连点只发一次', async () => {
    const d = deferred<unknown>();
    const calls: number[] = [];
    const inner = createMockApi({ live: false });
    const fact = <T,>(value: T) => ({ ok: true as const, value });
    const env = (): EnvResponse => ({
      name: { name: '法国' },
      asOf: ASOF,
      facts: {
        engine: fact({ state: 'on' }),
        version: fact({ current: HEAD, behind: 0, detail: '在用', problems: [] }),
        sessions: fact({ total: 0, byStage: {} }),
        pools: fact({ count: 0, running: 0, unread: 0, stale: 0 }),
        health: fact({ ok: true, total: 0, failing: [], notWired: [] }),
        schedule: fact({ status: 'fresh', lastSuccessAt: ASOF, outcome: 'ok' }),
      },
    });
    const card: ReleaseCard = {
      mainline: {
        state: 'ok',
        commit: { sha: HEAD, short: HEAD.slice(0, 12), title: '刷新耗时表 (#1230)', at: ASOF },
        ci: { state: 'green' },
      },
      deployed: {
        state: 'ok',
        sha: HEAD,
        short: HEAD.slice(0, 12),
        title: '刷新耗时表',
        titleWhy: null,
        deployedAt: ASOF,
        deployedAtWhy: null,
      },
      gap: { state: 'same' },
      lastDone: { state: 'unreadable', why: '测试里不读' },
      action: {
        state: 'ready',
        reasons: [],
        installed: true,
        last: { state: 'none', target: null, at: null, why: null, phase: null },
      },
      asOf: ASOF,
    };
    const api = {
      ...inner,
      env: () => Promise.resolve(env()),
      jobs: () => Promise.resolve({ asOf: ASOF, jobs: [] } satisfies Jobs),
      franceReleaseCard: () => Promise.resolve(card),
      francePreflight: () => {
        calls.push(1);
        return d.promise;
      },
    } as unknown as MockApi;
    renderApp(<France />, { api: api as unknown as FleetApi, route: '/france' });
    const probe = await screen.findByRole('button', { name: /发版预检/ });
    fireEvent.click(probe);
    fireEvent.click(probe);
    await waitFor(() => expect(probe.getAttribute('aria-busy')).toBe('true'));
    fireEvent.click(probe);
    expect(calls).toHaveLength(1);
    await act(async () => d.resolve({ ok: true }));
  });
});

describe('渠道状态页「全部立即探测」', () => {
  test('慢请求时 aria-busy，连点只发一次', async () => {
    const api = createMockApi({ live: false });
    const d = deferred<unknown>();
    const calls: number[] = [];
    vi.spyOn(api, 'routeProbeNow').mockImplementation(() => {
      calls.push(1);
      return d.promise as never;
    });
    renderApp(<RoutingStatus />, { route: '/routing/status?p=ch-claude', api });
    const probe = await screen.findByRole('button', { name: '全部立即探测' });
    fireEvent.click(probe);
    fireEvent.click(probe);
    await waitFor(() => expect(probe.getAttribute('aria-busy')).toBe('true'));
    fireEvent.click(probe);
    expect(calls).toHaveLength(1);
    await act(async () => d.resolve({ ok: true }));
  });
});

describe('路由页写请求', () => {
  test('确认框的确定键（关模型开关）：慢请求时 aria-busy，连点只发一次，忙时框关不掉', async () => {
    const d = deferred<void>();
    const calls: unknown[] = [];
    const api = createMockApi({ live: false });
    vi.spyOn(api, 'setModelEnabled').mockImplementation((modelId: string, body: unknown) => {
      calls.push([modelId, body]);
      return d.promise as never;
    });
    renderApp(<RoutingPage />, { route: '/routing?purpose=execute', api });
    await screen.findByRole('navigation', { name: '用途' });
    const mkRow = document.querySelector('li[data-model="opus-5.5"]') as HTMLElement;
    fireEvent.click(within(mkRow).getByRole('switch'));
    const dialog = await screen.findByRole('alertdialog');
    const ok = within(dialog).getByRole('button', { name: '关闭' });
    fireEvent.click(ok);
    fireEvent.click(ok);
    await waitFor(() => expect(ok.getAttribute('aria-busy')).toBe('true'));
    fireEvent.click(ok);
    expect(calls).toHaveLength(1);
    fireEvent.click(within(dialog).getByRole('button', { name: '先不' }));
    expect(screen.queryByRole('alertdialog')).not.toBeNull();
    await act(async () => d.resolve());
    await waitFor(() => expect(screen.queryByRole('alertdialog')).toBeNull());
  });

  test('「登记」模型串：慢请求时 aria-busy，连点只发一次', async () => {
    const d = deferred<unknown>();
    const calls: unknown[] = [];
    const api = createMockApi({ live: false });
    vi.spyOn(api, 'registerChannelModel').mockImplementation((channelId: string, body: unknown) => {
      calls.push([channelId, body]);
      return d.promise as never;
    });
    renderApp(<RoutingPage />, { route: '/routing?tab=channels', api });
    await screen.findByRole('list', { name: '渠道列表' });
    fireEvent.click(screen.getByRole('button', { name: '查看 Claude 订阅 的路由' }));
    const form = await screen.findByRole('form', { name: '手工登记模型串' });
    fireEvent.change(within(form).getByRole('textbox', { name: '模型串' }), {
      target: { value: 'claude-sonnet-x' },
    });
    const submit = within(form).getByRole('button', { name: '登记' });
    fireEvent.click(submit);
    fireEvent.click(submit);
    await waitFor(() => expect(submit.getAttribute('aria-busy')).toBe('true'));
    fireEvent.click(submit);
    expect(calls).toHaveLength(1);
    await act(async () => d.resolve({ channelId: 'ch-claude', modelKey: 'claude-sonnet-x', version: 0 }));
  });

  test('「撤掉」模型串：慢请求时 aria-busy，连点只发一次', async () => {
    const d = deferred<unknown>();
    const calls: unknown[] = [];
    const api = createMockApi({ live: false });
    vi.spyOn(api, 'registerChannelModel').mockResolvedValue({
      channelId: 'ch-claude',
      modelKey: 'claude-sonnet-x',
      version: 0,
    } as never);
    vi.spyOn(api, 'revokeChannelModel').mockImplementation((channelId: string, body: unknown) => {
      calls.push([channelId, body]);
      return d.promise as never;
    });
    renderApp(<RoutingPage />, { route: '/routing?tab=channels', api });
    await screen.findByRole('list', { name: '渠道列表' });
    fireEvent.click(screen.getByRole('button', { name: '查看 Claude 订阅 的路由' }));
    const form = await screen.findByRole('form', { name: '手工登记模型串' });
    fireEvent.change(within(form).getByRole('textbox', { name: '模型串' }), {
      target: { value: 'claude-sonnet-x' },
    });
    fireEvent.click(within(form).getByRole('button', { name: '登记' }));
    const list = await screen.findByRole('list', { name: '已登记的模型串' });
    fireEvent.click(within(list).getByRole('button', { name: '撤掉 claude-sonnet-x' }));
    expect(calls).toHaveLength(0);
    const dialog = await screen.findByRole('alertdialog');
    const ok = within(dialog).getByRole('button', { name: '撤掉' });
    fireEvent.click(ok);
    fireEvent.click(ok);
    await waitFor(() => expect(ok.getAttribute('aria-busy')).toBe('true'));
    fireEvent.click(ok);
    expect(calls).toHaveLength(1);
    await act(async () => d.resolve({ channelId: 'ch-claude', modelKey: 'claude-sonnet-x', version: 1 }));
  });

  test('用途里「移出」确认键：慢请求时 aria-busy，连点只发一次', async () => {
    const d = deferred<unknown>();
    const calls: unknown[] = [];
    const api = createMockApi({ live: false });
    vi.spyOn(api, 'removePurposeModel').mockImplementation(
      (purpose: string, modelId: string, body: unknown) => {
        calls.push([purpose, modelId, body]);
        return d.promise as never;
      },
    );
    renderApp(<RoutingPage />, { route: '/routing?purpose=execute', api });
    await screen.findByRole('navigation', { name: '用途' });
    const mkRow = document.querySelector('li[data-model="kimi-k3"]') as HTMLElement;
    const trigger = within(mkRow).getByRole('button', { name: /^更多操作：/ });
    trigger.focus();
    fireEvent.keyDown(trigger, { key: 'Enter' });
    fireEvent.click(within(await screen.findByRole('menu')).getByRole('menuitem', { name: '移出动手' }));
    const dialog = await screen.findByRole('alertdialog');
    const ok = within(dialog).getByRole('button', { name: '移出' });
    fireEvent.click(ok);
    fireEvent.click(ok);
    await waitFor(() => expect(ok.getAttribute('aria-busy')).toBe('true'));
    fireEvent.click(ok);
    expect(calls).toHaveLength(1);
    await act(async () => d.resolve({ ok: true }));
  });
});

describe('资源页「清理没用的工作树」', () => {
  test('慢请求时 aria-busy，连点只发一次', async () => {
    const inner = createMockApi({ live: false });
    const d = deferred<unknown>();
    const calls: unknown[] = [];
    const api = {
      ...inner,
      worktreeCleanup: (body: unknown) => {
        calls.push(body);
        return d.promise;
      },
    } as unknown as MockApi;
    renderApp(<ResourcesPage />, { api: api as unknown as FleetApi });
    const button = await waitFor(() => {
      const b = document.querySelector<HTMLButtonElement>('[data-cleanup-button]');
      if (!b || b.disabled) throw new Error('按钮还没好');
      return b;
    });
    fireEvent.click(button);
    expect(calls).toHaveLength(0);
    const dialog = await screen.findByRole('alertdialog');
    const ok = within(dialog).getByRole('button', { name: '确认清理' });
    fireEvent.click(ok);
    fireEvent.click(ok);
    await waitFor(() => expect(ok.getAttribute('aria-busy')).toBe('true'));
    fireEvent.click(ok);
    expect(calls).toHaveLength(1);
    await act(async () => d.resolve({ cleanups: [], inventory: null, unreadable: 0 }));
  });
});

describe('额度页暂停池', () => {
  test('「确认停用」：慢请求时 aria-busy，连点只写一次设置', async () => {
    const api = createMockApi({ live: false });
    const d = deferred<unknown>();
    const calls: unknown[] = [];
    vi.spyOn(api, 'updateSetting').mockImplementation((key: string, body: unknown) => {
      calls.push([key, body]);
      return d.promise as never;
    });
    renderApp(<QuotaPage />, { api });
    const sw = await screen.findByRole('switch', { name: 'claude-a 的开关' });
    await waitFor(() => expect(sw.getAttribute('aria-checked')).toBe('true'));
    fireEvent.click(sw);
    fireEvent.change(await screen.findByLabelText('原因'), { target: { value: '被封号' } });
    const confirm = screen.getByRole('button', { name: '确认停用' });
    fireEvent.click(confirm);
    fireEvent.click(confirm);
    await waitFor(() => expect(confirm.getAttribute('aria-busy')).toBe('true'));
    fireEvent.click(confirm);
    expect(calls).toHaveLength(1);
    await act(async () => d.resolve({ ok: true }));
  });
});
