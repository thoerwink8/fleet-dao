// @vitest-environment happy-dom
// 还没做的功能整块显示「待实现」占位（阶段 + 单号），不许说成「没查成」「离线」；
// 反过来，真去读了、读失败的只许说「没查成」，不许被占位盖掉。两个方向各造一次。
import { cleanup, screen, waitFor } from '@testing-library/react';
import { afterEach, describe, expect, test } from 'vitest';
import { createMockApi, type MockApi } from '../api/mock/server';
import ChannelsPage from '../routes/channels';
import DispatchPage from '../routes/dispatch';
import QuotaPage from '../routes/quota';
import { renderApp } from './harness';

afterEach(cleanup);

const quotaMark = { what: '额度读数', phase: 'P3', issue: 76 };
const probeMark = { what: '路由在线状态', phase: 'P1', issue: 129 };

/** 额度表里每个池都一次没读成过；notWired 给了就是「额度读取还没做」。 */
function neverRead(notWired: boolean): MockApi {
  const api = createMockApi({ live: false });
  const pools = api.pools;
  api.pools = async () => {
    const r = await pools();
    return {
      ...r,
      pools: r.pools.map((p) => {
        const { lastReadOkAt: _last, dataAt: _data, ...rest } = p;
        return { ...rest, quotaStatus: 'unread' as const, windows: [] };
      }),
      ...(notWired ? { quotaNotWired: quotaMark } : {}),
    };
  };
  return api;
}

/** 每条路由都没人写过在线；notWired 给了就是「路由探针还没做」。 */
function neverProbed(api: MockApi, notWired: boolean): MockApi {
  const routing = api.routing;
  api.routing = async () => {
    const r = await routing();
    return {
      ...r,
      routes: r.routes.map((x) => ({ ...x, alive: false })),
      ...(notWired ? { routeProbeNotWired: probeMark } : {}),
    };
  };
  return api;
}

describe('还没做的：整块待实现，不说没查成、离线', () => {
  test('额度页：读取还没做时整块是占位（P3 · #76），不出现「没查成」', async () => {
    renderApp(<QuotaPage />, { api: neverRead(true) });
    expect(await screen.findByText(/这块还没做，排在 P3/)).toBeTruthy();
    expect(screen.getByText('#76')).toBeTruthy();
    expect(screen.queryByText(/没查成/)).toBeNull();
  });

  test('渠道页：额度读取、路由探针都还没做——顶上两块占位，池和路由上不写「没查成」「离线」', async () => {
    renderApp(<ChannelsPage />, { api: neverProbed(neverRead(true), true) });
    expect(await screen.findByText(/额度读数 · 待实现/)).toBeTruthy();
    expect(screen.getByText(/路由在线状态 · 待实现/)).toBeTruthy();
    await waitFor(() => expect(document.querySelectorAll('[data-quota]').length).toBe(0));
    expect(screen.queryByText(/没查成/)).toBeNull();
    expect(document.body.innerHTML).not.toContain('离线');
  });

  test('调度台：路由探针还没做时顶上是占位（P1 · #129），路由上不写「离线」', async () => {
    renderApp(<DispatchPage />, { api: neverProbed(neverRead(true), true) });
    expect(await screen.findByText(/路由在线状态 · 待实现/)).toBeTruthy();
    expect(screen.getAllByText('#129').length).toBeGreaterThan(0);
    await waitFor(() => expect(document.querySelectorAll('[data-quota]').length).toBe(0));
    expect(screen.queryByText('离线')).toBeNull();
    expect(screen.queryByText(/没查成/)).toBeNull();
  });
});

describe('真去读了、读失败的：照实说，不被占位盖掉', () => {
  test('额度页：读取器接上了、却一次没读成过——写「没查成」，没有待实现占位', async () => {
    renderApp(<QuotaPage />, { api: neverRead(false) });
    expect((await screen.findAllByText('没查成')).length).toBeGreaterThan(0);
    expect(document.querySelector('[data-not-built]')).toBeNull();
    expect(screen.queryByText(/待实现/)).toBeNull();
  });

  test('调度台：探针接上了、路由不在线——写「离线」，没有待实现占位', async () => {
    renderApp(<DispatchPage />, { api: neverProbed(createMockApi({ live: false }), false) });
    expect((await screen.findAllByText('离线')).length).toBeGreaterThan(0);
    expect(document.querySelector('[data-not-built]')).toBeNull();
  });
});
