// @vitest-environment happy-dom
// 兜底轮询（#1799）：推送只覆盖部分表、也可能悄悄断开，所以主页和几个读页自己按钟重拉。
// 可见时主页 30 秒、读页 60 秒；推送不是 open 缩到 10 秒；页面在后台不拉；切回窗口重拉；卡片相对时间 30 秒走一次。
import { focusManager, QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { act, cleanup, render, renderHook, screen } from '@testing-library/react';
import type { ReactNode } from 'react';
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';
import { DoneCard } from '../components/home/done-card';
import {
  ApiProvider,
  DOWN_POLL_MS,
  type FleetApi,
  HOME_POLL_MS,
  type LiveStatus,
  READ_POLL_MS,
  useHome,
  useLiveSync,
  useNotifications,
  usePools,
  useTaskList,
} from './client';

const T0 = Date.parse('2026-10-10T08:00:00.000Z');

let setStatus: (s: LiveStatus) => void = () => {};
const reader = (name: string) => vi.fn(async () => ({ [name]: true }));
let api: {
  home: ReturnType<typeof vi.fn>;
  tasks: ReturnType<typeof vi.fn>;
  notifications: ReturnType<typeof vi.fn>;
  pools: ReturnType<typeof vi.fn>;
};

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(T0);
  api = {
    home: vi.fn(async () => ({
      decisions: [],
      running: [],
      done: [],
      health: {},
      flow: [],
    })),
    tasks: vi.fn(async () => ({ items: [], nextCursor: null, counts: {} })),
    notifications: reader('items'),
    pools: reader('pools'),
  };
});

afterEach(() => {
  cleanup();
  focusManager.setFocused(undefined);
  vi.useRealTimers();
});

function wrapper() {
  const qc = new QueryClient({
    defaultOptions: { queries: { staleTime: 5_000, refetchOnWindowFocus: false, retry: false } },
  });
  const fleet = {
    ...api,
    subscribe: (_l: unknown, onStatus?: (s: LiveStatus) => void) => {
      setStatus = (s) => onStatus?.(s);
      return () => {};
    },
  } as unknown as FleetApi;
  return ({ children }: { children: ReactNode }) => (
    <QueryClientProvider client={qc}>
      <ApiProvider api={fleet}>{children}</ApiProvider>
    </QueryClientProvider>
  );
}

/** 主页查询加推送接线（外壳里 useLiveSync 只挂一次，这里照样挂）。 */
function mountHome() {
  const view = renderHook(
    () => {
      useLiveSync(true);
      return useHome();
    },
    { wrapper: wrapper() },
  );
  return view;
}

const advance = (ms: number) => act(async () => void (await vi.advanceTimersByTimeAsync(ms)));

describe('主页兜底轮询', () => {
  test('推送是 open：可见时每 30 秒重拉一次，没到点不拉', async () => {
    mountHome();
    await advance(0);
    act(() => setStatus('open'));
    await advance(0);
    const before = api.home.mock.calls.length;
    await advance(HOME_POLL_MS - 1_000);
    expect(api.home.mock.calls.length).toBe(before);
    await advance(1_000);
    expect(api.home.mock.calls.length).toBe(before + 1);
    await advance(HOME_POLL_MS);
    expect(api.home.mock.calls.length).toBe(before + 2);
  });

  test('页面隐藏时不重拉；切回窗口重拉一次', async () => {
    mountHome();
    await advance(0);
    act(() => setStatus('open'));
    await advance(0);
    const before = api.home.mock.calls.length;
    act(() => focusManager.setFocused(false));
    await advance(HOME_POLL_MS * 3);
    expect(api.home.mock.calls.length).toBe(before);
    act(() => focusManager.setFocused(true));
    await advance(0);
    expect(api.home.mock.calls.length).toBe(before + 1);
  });

  test('推送状态 down：间隔变成 10 秒；回到 open 又是 30 秒', async () => {
    mountHome();
    await advance(0);
    act(() => setStatus('down'));
    await advance(0);
    let n = api.home.mock.calls.length;
    await advance(DOWN_POLL_MS);
    expect(api.home.mock.calls.length).toBe(n + 1);
    await advance(DOWN_POLL_MS);
    expect(api.home.mock.calls.length).toBe(n + 2);

    act(() => setStatus('open'));
    await advance(0);
    n = api.home.mock.calls.length;
    await advance(DOWN_POLL_MS * 2);
    expect(api.home.mock.calls.length).toBe(n);
    await advance(HOME_POLL_MS - DOWN_POLL_MS * 2);
    expect(api.home.mock.calls.length).toBe(n + 1);
  });
});

describe('其余读页 60 秒兜底', () => {
  test('任务列表、通知、额度（池）：open 时 60 秒各重拉一次，down 时 10 秒', async () => {
    renderHook(
      () => {
        useLiveSync(true);
        useTaskList({});
        useNotifications('open');
        usePools();
      },
      { wrapper: wrapper() },
    );
    await advance(0);
    act(() => setStatus('open'));
    await advance(0);
    const base = () => [api.tasks, api.notifications, api.pools].map((f) => f.mock.calls.length);
    const start = base();
    await advance(READ_POLL_MS - 1_000);
    expect(base()).toEqual(start);
    await advance(1_000);
    expect(base()).toEqual(start.map((n) => n + 1));

    act(() => setStatus('down'));
    await advance(0);
    const mid = base();
    await advance(DOWN_POLL_MS);
    expect(base()).toEqual(mid.map((n) => n + 1));
  });
});

describe('卡片相对时间跟着 30 秒钟走', () => {
  test('做完的卡片：合于 1 分钟前，钟走 60 秒后变成 2 分钟前，不靠重拉', async () => {
    render(
      <DoneCard
        item={
          {
            repo: 'o/r',
            prNumber: 7,
            title: '修一处',
            mergedAt: new Date(T0 - 60_000).toISOString(),
            link: undefined,
          } as never
        }
      />,
    );
    expect(screen.getByText(/合于 1 分钟前/)).toBeTruthy();
    await advance(60_000);
    expect(screen.getByText(/合于 2 分钟前/)).toBeTruthy();
    expect(api.home).not.toHaveBeenCalled();
  });
});
