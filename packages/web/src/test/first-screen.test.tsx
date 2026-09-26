// @vitest-environment happy-dom
// 首屏的读取一轮发完：经香港转到法国的每个请求都要一趟往返（约 0.2 秒），前一个回来才发下一个，每多一轮就慢一趟。
// 假后端把请求一轮一轮地放：同一轮发出的一起回来。每个请求记下是第几轮发出的——页面一打开就发的算第 1 轮，
// 第 n 轮的回来之后才发的算第 n+1 轮。改之前看板要第 3 轮才发（登录 → 仓列表 → 看板）。
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { act, cleanup, render, screen } from '@testing-library/react';
import { MemoryRouter, Route, Routes } from 'react-router';
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';
import { ApiError, ApiProvider, type FleetApi } from '../api/client';
import { createMockApi } from '../api/mock/server';
import { ThemeProvider } from '../components/theme-provider';
import { TooltipProvider } from '../components/ui/tooltip';
import BoardPage from '../routes/board';
import OverviewPage from '../routes/overview';
import Shell from '../routes/shell';

// 画布依赖浏览器排版，测试环境里不跑；看板页自己发的读取照旧发
vi.mock('../board/board-canvas', () => ({ BoardCanvas: () => null }));

const HINT_KEY = 'fleet-dao.repo-ids';
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
                  <Route index element={<BoardPage />} />
                  <Route path="overview" element={<OverviewPage />} />
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
  test('看板（回访）：登录、仓列表、看板、路由、提醒都在第 1 轮；推送等确认登录后再连；没用到的额度、路由对话框不读', async () => {
    localStorage.setItem(HINT_KEY, JSON.stringify(REPOS));
    const w = waved();
    await open(w.api, '/');
    expect(screen.getByText('正在确认登录…')).toBeTruthy();
    expect(w.subscribed).toEqual([]);
    for (const call of ['me', 'repos', 'board:r-orbit', 'routing', 'notifications']) {
      expect([call, w.first(call)]).toEqual([call, 1]);
    }
    await w.release();
    expect(screen.queryByText('正在确认登录…')).toBeNull();
    expect(w.subscribed).toEqual([2]);
    await w.release();
    // 看板页用不到额度；换模型的对话框没打开也不读
    expect(w.called('pools')).toBe(false);
  });

  test('总览（回访）：各仓的看板、额度、操作记录也都在第 1 轮', async () => {
    localStorage.setItem(HINT_KEY, JSON.stringify(REPOS));
    const w = waved();
    await open(w.api, '/overview');
    for (const call of [
      'me',
      'repos',
      ...REPOS.map((r) => `board:${r}`),
      'pools',
      'audit',
      'notifications',
    ]) {
      expect([call, w.first(call)]).toEqual([call, 1]);
    }
  });

  test('头一回打开（本机没记过仓）：看板要等仓列表，第 2 轮；读到的仓记下来，下回就是第 1 轮', async () => {
    const w = waved();
    await open(w.api, '/');
    expect(w.first('me')).toBe(1);
    expect(w.first('repos')).toBe(1);
    expect(w.called('board:r-orbit')).toBe(false);
    await w.release();
    expect(w.first('board:r-orbit')).toBe(2);
    expect(JSON.parse(localStorage.getItem(HINT_KEY) ?? '[]')).toEqual(REPOS);
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
