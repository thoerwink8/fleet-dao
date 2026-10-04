// @vitest-environment happy-dom
// 额度读取（#76）已经接上：额度页不再有「待实现」占位，真去读了、一次没读成的池只许说「没查成」，不许被占位盖掉、
// 不许画成「没用量」。路由在线状态（#129）的在线 / 离线 / 还没探过见 route-health.test.tsx。
import { cleanup, screen } from '@testing-library/react';
import { afterEach, describe, expect, test } from 'vitest';
import { createMockApi, type MockApi } from '../api/mock/server';
import QuotaPage from '../routes/quota';
import { renderApp } from './harness';

afterEach(cleanup);

/** 额度表里每个池都一次没读成过。 */
function neverRead(): MockApi {
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
    };
  };
  return api;
}

describe('真去读了、读失败的：照实说，没有待实现占位', () => {
  test('额度页：一次没读成过的池写「没查成」，页面上没有待实现占位', async () => {
    renderApp(<QuotaPage />, { api: neverRead() });
    expect((await screen.findAllByText('没查成')).length).toBeGreaterThan(0);
    expect(document.querySelector('[data-not-built]')).toBeNull();
    expect(screen.queryByText(/待实现/)).toBeNull();
  });
});
