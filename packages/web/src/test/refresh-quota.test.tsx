// @vitest-environment happy-dom
// 额度页刷新条：点刷新再读主查询；读失败仍显示 LoadError，这条放最后。
import { cleanup, fireEvent, screen, waitFor, within } from '@testing-library/react';
import { afterEach, expect, test, vi } from 'vitest';
import { ApiError, usePools } from '../api/client';
import { createMockApi } from '../api/mock/server';
import type { PoolView, QuotaWindowView } from '../api/types';
import QuotaPage from '../routes/quota';
import { renderApp } from './harness';

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

// 主查询的 refetch 在观察者创建时就 bind 到实例上。先挂一次拿到原型，再换成计数，额度页新建的观察者才会走到这个计数。
function spyOnMainRefetch() {
  function Probe() {
    usePools();
    return null;
  }
  const probe = renderApp(<Probe />);
  const observer = probe.qc.getQueryCache().find({ queryKey: ['pools'] })?.observers[0];
  if (!observer) throw new Error('探针没有主查询');
  const refetch = vi.spyOn(Object.getPrototypeOf(observer), 'refetch');
  probe.unmount();
  return refetch;
}

test('点刷新按钮，调用额度页主查询的 refetch', async () => {
  const refetch = spyOnMainRefetch();
  const api = createMockApi({ live: false });
  const pools = vi.spyOn(api, 'pools');
  renderApp(<QuotaPage />, { api });
  // 读取中不写 disabled，等 aria-busy 变成 false 才是读完；disabled 一直是 false，会在读完前就点下去。
  await waitFor(() =>
    expect(screen.getByRole('button', { name: '刷新' }).getAttribute('aria-busy')).toBeNull(),
  );
  refetch.mockClear();
  const before = pools.mock.calls.length;
  fireEvent.click(screen.getByRole('button', { name: '刷新' }));
  expect(refetch).toHaveBeenCalledTimes(1);
  await waitFor(() => expect(pools.mock.calls.length).toBe(before + 1));
});

test('【故意造出的失败】额度没读成：仍显示 LoadError', async () => {
  const api = createMockApi({ live: false });
  api.pools = () => Promise.reject(new ApiError(500, 'internal', '后端出错了'));
  renderApp(<QuotaPage />, { api });
  const alert = await screen.findByRole('alert');
  expect(alert.textContent).toContain('没查成');
  expect(alert.textContent).toContain('后端出错了');
  expect(screen.getByRole('button', { name: '重试' })).toBeTruthy();
  // 写明是哪一块没查成；页头说明和 ⓘ 照旧在（#1921）
  expect(alert.textContent).toContain('额度没查成');
  expect(screen.getByRole('button', { name: '这页是做什么的' })).toBeTruthy();
});

test('【故意造出的失败】读成过、刷新时失败：照旧画上一次的数，顶上横幅写没查成和原因，重试再读（#1921）', async () => {
  const api = createMockApi({ live: false });
  const real = api.pools.bind(api);
  renderApp(<QuotaPage />, { api });
  await waitFor(() => expect(document.querySelector('tr[data-row-key="claude-a"]')).toBeTruthy());
  api.pools = () => Promise.reject(new ApiError(503, 'pools_unreadable', '库连不上'));
  await waitFor(() =>
    expect(screen.getByRole('button', { name: '刷新' }).getAttribute('aria-busy')).toBeNull(),
  );
  fireEvent.click(screen.getByRole('button', { name: '刷新' }));
  const alert = await screen.findByRole('alert', {}, { timeout: 4000 });
  expect(alert.textContent).toContain('额度刷新没成，下面是');
  expect(alert.textContent).toContain('读到的：库连不上');
  // 看得到的没被清空：表和结论块都还在
  expect(document.querySelector('tr[data-row-key="claude-a"]')).toBeTruthy();
  expect(document.querySelector('[data-quota-hero]')).toBeTruthy();
  api.pools = real;
  fireEvent.click(within(alert).getByRole('button', { name: '重试' }));
  await waitFor(() => expect(screen.queryByRole('alert')).toBeNull(), { timeout: 4000 });
});

test('新旧两张周窗时旧的收起', async () => {
  // 相对页面 useNow() 的「现在」，避免写死的 ISO 在真时钟下两张都算过期
  const at = (min: number) => new Date(Date.now() + min * 60_000).toISOString();
  const win = (over: Partial<QuotaWindowView>): QuotaWindowView => ({
    window: '7d',
    label: '7d',
    unit: 'percent',
    source: 'claude-usage',
    utilization: 0.4,
    reading: 'measured',
    readAt: at(-4),
    stale: false,
    resetsAt: at(3_000),
    ...over,
  });
  const api = createMockApi({ live: false });
  const base = api.pools.bind(api);
  api.pools = async () => {
    const res = await base();
    const first = res.pools[0];
    if (!first) throw new Error('假后端没有账号池');
    const pool: PoolView = {
      ...first,
      id: 'claude-solo',
      windows: [
        win({
          label: '7d-old',
          utilization: 0.9,
          staleSince: at(-60),
          resetsAt: at(-100),
          readAt: at(-120),
        }),
        win({ label: '7d', utilization: 0.33, resetsAt: at(3_000), readAt: at(-4) }),
      ],
    };
    return { ...res, pools: [pool, ...res.pools.filter((p) => p.id !== pool.id)] };
  };
  renderApp(<QuotaPage />, { api });
  await waitFor(() => expect(document.querySelector('tr[data-row-key="claude-solo"]')).toBeTruthy());
  const tr = document.querySelector('tr[data-row-key="claude-solo"]');
  // 周窗：新读数仍是完整一行，旧的收成窗口名下一句「旧读数，已过期」
  expect(within(tr as HTMLElement).getByText('旧读数，已过期')).toBeTruthy();
  expect(within(tr as HTMLElement).getByText('33%')).toBeTruthy();
  // 过期那张不再单占一行（这个池只有一行，没有 90% 的数字）
  expect(
    [...document.querySelectorAll('[data-quota-matrix] tr[data-row-key^="claude-solo"]')].map((r) =>
      r.getAttribute('data-row-key'),
    ),
  ).toEqual(['claude-solo']);
  expect(within(tr as HTMLElement).queryByText('90%')).toBeNull();
});
