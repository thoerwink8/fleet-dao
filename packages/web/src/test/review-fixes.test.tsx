// @vitest-environment happy-dom
// PR #13 审查意见的回归：用量没读到不冒充 0%、仓列表没读成不冒充「没有仓」、推送断了手机上也看得见。
// 每条都故意造一次「读不到」。
import { act, cleanup, render, screen, within } from '@testing-library/react';
import { afterEach, describe, expect, test, vi } from 'vitest';
import { ApiError, type FleetApi, type LiveStatus, useLiveSync } from '../api/client';
import { createMockApi, type MockApi } from '../api/mock/server';
import type { PoolView, QuotaWindowView } from '../api/types';
import { QuotaCell } from '../components/quota';
import { Topbar } from '../components/shell/topbar';
import { isNearlyExhausted, isUseItOrLoseIt, utilOf, windowLength, windowTitle } from '../lib/catalog';
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

  test('上游这次没报的窗（staleSince）：照样显示、注明，不算快用完', () => {
    const gone = noUsage({ utilization: 0.95, staleSince: at(-30) });
    expect(isNearlyExhausted(gone)).toBe(false);
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

  test('额度格写「用量没读到」、不高亮、不画成 0%', () => {
    const { container } = render(<QuotaCell w={noUsage()} now={NOW} />);
    const el = container.firstElementChild as HTMLElement;
    expect(screen.getByText('用量没读到')).toBeTruthy();
    expect(el.dataset.hot).toBeUndefined();
    expect(el.dataset.unknown).toBe('true');
    expect(container.textContent).not.toContain('0%');
    expect(container.textContent).not.toContain('，先用它');
  });

  test('额度页：没读到用量的窗列进「读数过期或没查成」，不进「先用它」', async () => {
    renderApp(<QuotaPage />, { api: withUnknownUsage(createMockApi({ live: false })) });
    const box = (await screen.findByText('读数过期或没查成')).closest('div.rounded-xl') as HTMLElement;
    expect(within(box).getAllByText('用量没读到').length).toBeGreaterThan(0);
    const hot = screen.getByText('先用它').closest('div.rounded-xl') as HTMLElement;
    expect(within(hot).getByText('没有')).toBeTruthy();
    expect(screen.queryByText('0%')).toBeNull();
  });
});

describe('额度格：上游说满了', () => {
  test('上游说满了却没给比例，写「已用满」、条画满，不算「用量没读到」', () => {
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

  // 顶栏原来的「切换仓」已被环境切换器取代（选了仓什么都不变，是死的），它那条「仓列表没读成」的用例随它删；
  // 环境切换器读不到远程环境列表时的写法在 node-switch.test.tsx。
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
