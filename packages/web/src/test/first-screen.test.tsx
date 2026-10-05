// @vitest-environment happy-dom
// 首屏的读取一轮发完：经香港转到法国的每个请求都要一趟往返（约 0.2 秒），前一个回来才发下一个，每多一轮就慢一趟。
// 假后端把请求一轮一轮地放：同一轮发出的一起回来。每个请求记下是第几轮发出的——页面一打开就发的算第 1 轮，
// 第 n 轮的回来之后才发的算第 n+ 1 轮。
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { act, cleanup, render, screen } from '@testing-library/react';
import { MemoryRouter, Route, Routes } from 'react-router';
import { afterEach, beforeEach, describe, expect, test } from 'vitest';
import { ApiError, ApiProvider, type FleetApi } from '../api/client';
import { createMockApi } from '../api/mock/server';
import { ThemeProvider } from '../components/theme-provider';
import { TooltipProvider } from '../components/ui/tooltip';
import HomePage from '../routes/home';
import Shell from '../routes/shell';

const REPOS = ['r-orbit', 'r-canary', 'r-site'];

beforeEach(() => localStorage.clear());
afterEach(cleanup);

/** 假后端外面套一层：每个请求记名字和轮次，等 release() 才一起回。 */
function waved(inner: FleetApi = createMockApi({ live: false })) {
  const log: { call: string; wave: number }[] = [];
  const subscribed: number[] = [];
  let wave = 1;
  let held: (() => void)[] = [];
  const api = { ...inner } as FleetApi;
  for (const name of Object.keys(inner) as (keyof FleetApi)[]) {
    const fn = inner[name];
    if (typeof fn !== 'function' || name === 'subscribe') continue;
    Object.assign(api, {
      [name]: (...args: unknown[]) => {
        log.push({ call: name === 'board' ? `board:${String(args[0])}` : name, wave });
        const call = () => (fn as (...a: unknown[]) => unknown).apply(inner, args);
        return new Promise((resolve, reject) =>
          held.push(() => Promise.resolve().then(call).then(resolve, reject)),
        );
      },
    });
  }
  api.subscribe = (listener, onStatus) => {
    subscribed.push(wave);
    return inner.subscribe(listener, onStatus);
  };
  return {
    api,
    subscribed,
    /** 这个请求第一次是第几轮发出的；没发过是 undefined。 */
    first: (call: string) => log.find((l) => l.call === call)?.wave,
    called: (call: string) => log.some((l) => l.call === call),
    /** 放行已经发出的这一轮，等页面接着发下一轮。 */
    async release() {
      await act(async () => {
        const now = held;
        held = [];
        wave += 1;
        for (const r of now) r();
        for (let i = 0; i < 5; i++) await new Promise((r) => setTimeout(r, 0));
      });
    },
  };
}

async function open(api: FleetApi, route: string) {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false, staleTime: 5_000 } } });
  render(
    <MemoryRouter initialEntries={[route]}>
      <QueryClientProvider client={qc}>
        <ApiProvider api={api}>
          <ThemeProvider>
            <TooltipProvider>
              <Routes>
                <Route element={<Shell />}>
                  <Route index element={<HomePage />} />
                </Route>
              </Routes>
            </TooltipProvider>
          </ThemeProvider>
        </ApiProvider>
      </QueryClientProvider>
    </MemoryRouter>,
  );
  await act(async () => {
    for (let i = 0; i < 5; i++) await new Promise((r) => setTimeout(r, 0));
  });
}

describe('首屏：读取和确认登录一起发，一轮发完', () => {
  test('主页：登录、仓列表、主页、提醒都在第 1 轮；推送等确认登录后再连；不拉路由', async () => {
    const w = waved();
    await open(w.api, '/');
    expect(screen.getByText('正在确认登录…')).toBeTruthy();
    expect(w.subscribed).toEqual([]);
    for (const call of ['me', 'repos', 'home', 'notifications', 'nodes']) {
      expect([call, w.first(call)]).toEqual([call, 1]);
    }
    await w.release();
    expect(screen.queryByText('正在确认登录…')).toBeNull();
    expect(w.subscribed).toEqual([2]);
    await w.release();
    // 主页用不到路由（路由两层是换模型对话框用的，没打开也不读）
    expect(w.called('routing')).toBe(false);
    expect(w.called('routingLayers')).toBe(false);
  });

  test('顶栏的环境切换器不再为「切换仓」的计数去拉每个仓的看板：主页打开后一个看板都不读', async () => {
    const w = waved();
    await open(w.api, '/');
    await w.release();
    await w.release();
    for (const r of REPOS) expect(w.called('board:' + r)).toBe(false);
  });

  test('没登录：页面一直不露出来，推送不连，说要先登录', async () => {
    const inner = createMockApi({ live: false });
    inner.me = () => Promise.reject(new ApiError(401, 'unauthenticated', '没登录'));
    const w = waved(inner);
    await open(w.api, '/');
    await w.release();
    expect(screen.getByText('要先登录，正在跳到登录页…')).toBeTruthy();
    expect(screen.queryByText('正在确认登录…')).toBeNull();
    expect(w.subscribed).toEqual([]);
  });
});
