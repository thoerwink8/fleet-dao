// @vitest-environment happy-dom
// PR #13 审查意见的回归：用量没读到不冒充 0%、仓列表没读成不冒充「没有仓」、推送断了手机上也看得见、
// 看板重拉失败保留旧画面。每条都故意造一次「读不到」。
import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { afterEach, describe, expect, test, vi } from 'vitest';
import { ApiError, type FleetApi, type LiveStatus, useLiveSync } from '../api/client';
import { createMockApi, type MockApi } from '../api/mock/server';
import type { PoolView, QuotaWindowView } from '../api/types';
import { QuotaCell } from '../components/quota';
import { CommandMenu } from '../components/shell/command-menu';
import { Topbar } from '../components/shell/topbar';
import { routeOptions } from '../components/task-actions';
import {
  headlineText,
  isNearlyExhausted,
  isUseItOrLoseIt,
  poolUsage,
  quotaHeadline,
  utilOf,
  windowLength,
  windowTitle,
} from '../lib/catalog';
import BoardPage from '../routes/board';
import ChannelsPage from '../routes/channels';
import DispatchPage from '../routes/dispatch';
import OverviewPage from '../routes/overview';
import QuotaPage from '../routes/quota';
import SettingsPage from '../routes/settings';
import { renderApp } from './harness';

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

const NOW = Date.parse('2026-09-25T10:00:00Z');
const at = (min: number) => new Date(NOW + min * 60_000).toISOString();
const boom = () => Promise.reject(new ApiError(500, 'internal', '后端出错了'));

/** 只报了清零时间的窗（Claude 只说「这是限制窗」时就这样）：用量没读到。 */
const noUsage = (w: Partial<QuotaWindowView> = {}): QuotaWindowView => ({
  window: '5h',
  label: '5h',
  unit: 'percent',
  source: 'claude-usage',
  resetsAt: at(20),
  reading: 'measured',
  readAt: at(-1),
  stale: false,
  ...w,
});

/** 把假后端所有账号池的额度窗都换成「用量没读到」。 */
function withUnknownUsage(api: MockApi): MockApi {
  const pools = api.pools.bind(api);
  api.pools = async () => {
    const res = await pools();
    return {
      ...res,
      pools: res.pools.map(
        (p): PoolView => ({
          ...p,
          quotaStatus: 'fresh',
          windows: [noUsage(), noUsage({ window: '7d', reading: 'estimated', used: 812, resetsAt: at(600) })],
        }),
      ),
    };
  };
  return api;
}

describe('额度：用量没读到不当 0%', () => {
  test('只有清零时间、或只有已用没上限：用量是「不知道」，不参与高亮和「快用完」', () => {
    const onlyReset = noUsage();
    const onlyUsed = noUsage({ reading: 'estimated', used: 812 });
    for (const w of [onlyReset, onlyUsed]) {
      expect(utilOf(w)).toBeUndefined();
      expect(isUseItOrLoseIt(w, NOW)).toBe(false);
      expect(isNearlyExhausted(w)).toBe(false);
    }
    expect(utilOf(noUsage({ used: 3, limit: 4 }))).toBe(0.75);
    expect(utilOf(noUsage({ used: 3, limit: 0 }))).toBeUndefined();
  });

  test('上游新出的窗口（other）长度不知道：不喊「先用它」', () => {
    expect(windowLength.other).toBeUndefined();
    expect(isUseItOrLoseIt(noUsage({ window: 'other', utilization: 0.1, resetsAt: at(1) }), NOW)).toBe(false);
    expect(windowTitle({ window: 'other', label: 'auto_percent', scope: 'auto' })).toBe(
      'auto_percent · auto',
    );
    expect(windowTitle({ window: '7d_model', label: '7d_opus', scope: 'opus' })).toBe('周窗 · 单模型 · opus');
  });

  test('上游说已用满就算快用完（以上游为准），也不喊「先用它」', () => {
    const w = noUsage({ utilization: 0.4, upstreamStatus: 'limit_reached', resetsAt: at(10) });
    expect(isNearlyExhausted(w)).toBe(true);
    expect(isUseItOrLoseIt(w, NOW)).toBe(false);
  });

  test('上游这次没报的窗（staleSince）：照样显示、注明，不参与比较和报警', () => {
    const gone = noUsage({ utilization: 0.95, staleSince: at(-30) });
    expect(isNearlyExhausted(gone)).toBe(false);
    const u = poolUsage([gone, noUsage({ window: '7d', utilization: 0.2 })]);
    expect(u.tightest?.util).toBe(0.2);
    expect(u.unreported).toEqual([gone]);
    const { container } = render(<QuotaCell w={gone} now={NOW} />);
    expect(container.textContent).toContain('起没再报这个窗');
  });

  test('按单位写数：token 用万、美元带 $，超额照实写', () => {
    const { container } = render(
      <>
        <QuotaCell w={noUsage({ unit: 'tokens', used: 1_250_000, limit: 2_000_000 })} now={NOW} />
        <QuotaCell w={noUsage({ utilization: 1.12 })} now={NOW} />
      </>,
    );
    expect(container.textContent).toContain('125.0 万');
    expect(container.textContent).toContain('112%');
  });

  test('比谁最满时只比读到用量的窗，没读到的单独列出', () => {
    const u = poolUsage([
      noUsage(),
      noUsage({ window: '7d', utilization: 0.3 }),
      noUsage({ window: '7d_model' }),
    ]);
    expect(u.tightest?.util).toBe(0.3);
    expect(u.unknown.map((w) => w.window)).toEqual(['5h', '7d_model']);
    expect(poolUsage([noUsage()]).tightest).toBeUndefined();
  });

  test('额度格写「用量没读到」、不高亮、不画成 0%', () => {
    const { container } = render(<QuotaCell w={noUsage()} now={NOW} />);
    const el = container.firstElementChild as HTMLElement;
    expect(screen.getByText('用量没读到')).toBeTruthy();
    expect(el.dataset.hot).toBeUndefined();
    expect(el.dataset.unknown).toBe('true');
    expect(container.textContent).not.toContain('0%');
    expect(container.textContent).not.toContain('，先用它');
  });

  test('换模型的候选：池里用量全没读到时标「用量没读到」，不给 0%', async () => {
    const api = withUnknownUsage(createMockApi({ live: false }));
    const [routing, pools] = await Promise.all([api.routing(), api.pools()]);
    const { ordered, others } = routeOptions(routing, pools.pools, 'execute', undefined, NOW);
    const all = [...ordered, ...others];
    expect(all.length).toBeGreaterThan(0);
    for (const o of all) {
      expect(o.quota?.kind).toBe('unknown');
      expect(o.quota && headlineText(o.quota)).toBe('用量没读到');
    }
  });

  test('总览：没读到用量的窗不排进「最满」、不算「快清零」，底下写明有几个没读到', async () => {
    renderApp(<OverviewPage />, { api: withUnknownUsage(createMockApi({ live: false })) });
    expect(await screen.findByText(/个窗没排进来/)).toBeTruthy();
    const stat = screen.getByText('额度快清零').closest('a');
    expect(stat?.textContent).toContain('0');
    expect(screen.queryByText('0%')).toBeNull();
  });

  test('额度页：没读到用量的窗列进「读数过期或没查成」，不进「先用它」', async () => {
    renderApp(<QuotaPage />, { api: withUnknownUsage(createMockApi({ live: false })) });
    const box = (await screen.findByText('读数过期或没查成')).closest('div.rounded-xl') as HTMLElement;
    expect(within(box).getAllByText('用量没读到').length).toBeGreaterThan(0);
    const hot = screen.getByText('先用它').closest('div.rounded-xl') as HTMLElement;
    expect(within(hot).getByText('没有')).toBeTruthy();
    expect(screen.queryByText('0%')).toBeNull();
  });

  test('调度台：路由行写「用量没读到」，不写 0%', async () => {
    renderApp(<DispatchPage />, { api: withUnknownUsage(createMockApi({ live: false })) });
    expect((await screen.findAllByText('用量没读到')).length).toBeGreaterThan(0);
    expect(screen.queryByText('0%')).toBeNull();
  });
});

/** 把假后端所有账号池换成同一种额度状况。 */
function withPools(api: MockApi, patch: Pick<PoolView, 'quotaStatus' | 'windows'>): MockApi {
  const pools = api.pools.bind(api);
  api.pools = async () => {
    const res = await pools();
    return { ...res, pools: res.pools.map((p): PoolView => ({ ...p, ...patch })) };
  };
  return api;
}

describe('额度：一个池一句话，各页说法一致', () => {
  // Claude 撞到限额时就是这样：5 小时窗上游说满了、不给比例；周窗才用了一半。
  const halfAndFull: Pick<PoolView, 'quotaStatus' | 'windows'> = {
    quotaStatus: 'fresh',
    windows: [
      noUsage({ window: '7d', label: '7d', utilization: 0.5, resetsAt: at(3000) }),
      noUsage({ upstreamStatus: 'limit_reached', statusRaw: 'rejected' }),
    ],
  };
  const neverRead: Pick<PoolView, 'quotaStatus' | 'windows'> = { quotaStatus: 'unread', windows: [] };

  test('有窗上游说已用满：整个池说「已用满」（排在「用了一半」前面），不说 50%、不说「用量没读到」', async () => {
    const h = quotaHeadline(halfAndFull);
    expect(h.kind).toBe('full');
    expect(headlineText(h)).toBe('已用满');
    const u = poolUsage(halfAndFull.windows);
    expect(u.full).toHaveLength(1);
    expect(u.unknown).toEqual([]);
    expect(u.tightest?.util).toBe(0.5);

    const api = withPools(createMockApi({ live: false }), halfAndFull);
    const [routing, pools] = await Promise.all([api.routing(), api.pools()]);
    const { ordered } = routeOptions(routing, pools.pools, 'execute', undefined, NOW);
    expect(ordered.length).toBeGreaterThan(0);
    expect(new Set(ordered.map((o) => o.quota?.kind))).toEqual(new Set(['full']));

    renderApp(<DispatchPage />, { api });
    expect((await screen.findAllByText('已用满')).length).toBeGreaterThan(0);
    expect(screen.queryByText('50%')).toBeNull();
    cleanup();

    renderApp(<ChannelsPage />, { api: withPools(createMockApi({ live: false }), halfAndFull) });
    expect((await screen.findAllByText('已用满')).length).toBeGreaterThan(0);
    expect(screen.queryByText('用量没读到')).toBeNull();
    expect(screen.queryByText('50%')).toBeNull();
  });

  test('从没读成过的池：调度台、换模型、渠道页都写「额度没查成」，不是什么都不显示', async () => {
    expect(headlineText(quotaHeadline(neverRead))).toBe('额度没查成');
    // 额度表里查不到这个池，也一样说没查成；额度表本身还没读到时不下结论（对话框另有提示）。
    expect(quotaHeadline(undefined).kind).toBe('unread');

    const api = withPools(createMockApi({ live: false }), neverRead);
    const [routing, pools] = await Promise.all([api.routing(), api.pools()]);
    const { ordered } = routeOptions(routing, pools.pools, 'execute', undefined, NOW);
    expect(new Set(ordered.map((o) => o.quota?.kind))).toEqual(new Set(['unread']));
    expect(routeOptions(routing, undefined, 'execute', undefined, NOW).ordered.every((o) => !o.quota)).toBe(
      true,
    );

    renderApp(<DispatchPage />, { api });
    expect((await screen.findAllByText('额度没查成')).length).toBeGreaterThan(0);
    cleanup();

    renderApp(<ChannelsPage />, { api: withPools(createMockApi({ live: false }), neverRead) });
    expect((await screen.findAllByText('额度没查成')).length).toBeGreaterThan(0);
  });

  test('额度格：上游说满了却没给比例，写「已用满」、条画满，不算「用量没读到」', () => {
    const { container } = render(<QuotaCell w={noUsage({ upstreamStatus: 'limit_reached' })} now={NOW} />);
    const el = container.firstElementChild as HTMLElement;
    expect(el.dataset.full).toBe('true');
    expect(el.dataset.unknown).toBeUndefined();
    expect(screen.getByText('已用满')).toBeTruthy();
    expect(container.textContent).not.toContain('用量没读到');
  });
});

describe('仓列表没读成，不冒充「没有仓」', () => {
  function reposFail(): MockApi {
    const api = createMockApi({ live: false });
    api.repos = boom;
    return api;
  }

  test('设置页：写「仓列表没读成」，不写「还没有仓」', async () => {
    renderApp(<SettingsPage />, { api: reposFail() });
    expect(await screen.findByText(/仓列表没读成/)).toBeTruthy();
    expect(screen.queryByText('还没有仓')).toBeNull();
  });

  test('设置页：真读到一个空列表才说「还没有仓」', async () => {
    const api = createMockApi({ live: false });
    api.repos = async () => ({ repos: [] });
    renderApp(<SettingsPage />, { api });
    expect(await screen.findByText('还没有仓')).toBeTruthy();
  });

  test('⌘K：说明仓列表没读成、搜不到需求', async () => {
    renderApp(<CommandMenu open onOpenChange={() => {}} />, { api: reposFail() });
    expect(await screen.findByText(/仓列表没读成，这里搜不到任何需求/)).toBeTruthy();
  });

  test('顶栏的仓切换：写「仓列表没读成」，不是一直转圈', async () => {
    renderApp(<Topbar onMenu={() => {}} onSearch={() => {}} />, { api: reposFail() });
    expect(await screen.findByText('仓列表没读成')).toBeTruthy();
  });
});

describe('推送断了：顶栏照实说，手机上也看得见', () => {
  function LiveSync() {
    useLiveSync();
    return null;
  }

  test('后端把推送关掉（等着重连）：显示「推送断了」，文字不藏起来', async () => {
    const api = createMockApi({ live: false });
    let report: ((s: LiveStatus) => void) | undefined;
    api.subscribe = ((_l, onStatus) => {
      report = onStatus;
      return () => {};
    }) as FleetApi['subscribe'];
    renderApp(
      <>
        <LiveSync />
        <Topbar onMenu={() => {}} onSearch={() => {}} />
      </>,
      { api },
    );
    act(() => report?.('down'));
    const text = await screen.findByText('推送断了');
    expect(text.className).not.toContain('sr-only');
    const indicator = text.closest('[role="status"]') as HTMLElement;
    expect(indicator.className).not.toMatch(/(^|\s)hidden(\s|$)/);
    act(() => report?.('open'));
    expect(await screen.findByText('实时')).toBeTruthy();
  });
});

describe('看板重拉失败：保留上次的画面', () => {
  test('读成过之后重拉失败：树还在，上面一条「看板刷新没成」；重试成功提示消失', async () => {
    // 手机宽度走树形列表（画布依赖浏览器排版，测试环境里不跑）。
    vi.spyOn(window, 'matchMedia').mockImplementation(
      (q: string) =>
        ({
          matches: q.includes('max-width'),
          media: q,
          addEventListener() {},
          removeEventListener() {},
        }) as unknown as MediaQueryList,
    );
    const api = createMockApi({ live: false });
    const board = api.board.bind(api);
    let fail = false;
    api.board = (repoId) => (fail ? boom() : board(repoId));
    const { qc } = renderApp(<BoardPage />, { api });
    const title = (await screen.findAllByText('登录页加手机验证码'))[0];
    expect(title).toBeTruthy();
    fail = true;
    await act(() => qc.refetchQueries({ queryKey: ['board'] }).catch(() => {}));
    expect(await screen.findByText('看板刷新没成')).toBeTruthy();
    expect(screen.getAllByText('登录页加手机验证码').length).toBeGreaterThan(0);
    fail = false;
    fireEvent.click(screen.getByRole('button', { name: '重试' }));
    await waitFor(() => expect(screen.queryByText('看板刷新没成')).toBeNull());
    expect(screen.getAllByText('登录页加手机验证码').length).toBeGreaterThan(0);
  });
});
