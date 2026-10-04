// @vitest-environment happy-dom
// 演示版的界面：换成演示版的品牌（#brand → demo.tsx），按可见范围开关模块、收细节；数据层也挡一道。
import { cleanup, screen } from '@testing-library/react';
import { Route, Routes } from 'react-router';
import { afterEach, describe, expect, test, vi } from 'vitest';

vi.mock('#brand', async () => await import('../brand/demo'));

import { ApiError } from '../api/client';
import { createMockApi } from '../api/mock/server';
import { demoBlocked, visibleNav } from '../components/shell/nav';
import { SidebarNav } from '../components/shell/sidebar';
import NotificationsPage from '../routes/notifications';
import Shell from '../routes/shell';
import { renderApp } from '../test/harness';
import { loadDemoScope, setDemoScopeForTest } from './access';
import { createDemoApi } from './api';
import type { DemoDetail, DemoModule } from './scope';

afterEach(() => {
  cleanup();
  setDemoScopeForTest(null);
});

function scope(modules: DemoModule[], detail: DemoDetail = 'status', notice?: string) {
  setDemoScopeForTest({ scope: { v: 1, modules, detail }, source: 'link', ...(notice ? { notice } : {}) });
}

const demoApi = () => createDemoApi(createMockApi({ live: false }));

describe('演示版：模块开关', () => {
  test('导航只列开了的模块；占位页、发演示链接的页一律不列', () => {
    scope(['board', 'quota']);
    // 主页只在正式驾驶舱有（导航给它的没有 module），演示版里只有 /quota 列出来。
    expect(visibleNav().flatMap((g) => g.items.map((i) => i.to))).toEqual(['/quota']);
    expect(demoBlocked('/')).toBe(true);
    expect(demoBlocked('/schedules')).toBe(true);
    expect(demoBlocked('/demo-links')).toBe(true);
    expect(demoBlocked('/models')).toBe(true);
    // 路由页（#574）只在正式驾驶舱有：演示版不列、不渲染，读它的接口也回「没开放」
    expect(demoBlocked('/routing')).toBe(true);
    // 不是导航里的路径交给 404 页
    expect(demoBlocked('/no-such-page')).toBe(false);
  });

  test('侧栏照范围列，底部写明是假数据', async () => {
    scope(['board', 'quota']);
    renderApp(<SidebarNav />, { api: demoApi() });
    expect(screen.getByRole('link', { name: /额度/ })).toBeTruthy();
    expect(screen.queryByRole('link', { name: /定时任务/ })).toBeNull();
    expect(screen.queryByRole('link', { name: /演示版/ })).toBeNull();
    expect(screen.getByText('子午')).toBeTruthy();
    expect(screen.getByText('假数据（演示）')).toBeTruthy();
  });

  test('没开放的模块整页换成「没开放」，顶上有演示版横幅和链接的状态', async () => {
    scope(['board'], 'status', '这条演示链接已过期，下面按默认范围展示。');
    renderApp(
      <Routes>
        <Route element={<Shell />}>
          <Route path="schedules" element={<p>定时任务的页面</p>} />
        </Route>
      </Routes>,
      { api: demoApi(), route: '/schedules' },
    );
    expect(await screen.findByText('演示版没开放这一块')).toBeTruthy();
    expect(screen.queryByText('定时任务的页面')).toBeNull();
    expect(screen.getByText('演示版·全是假数据，操作不会有任何影响')).toBeTruthy();
    expect(screen.getByText('这条演示链接已过期，下面按默认范围展示。')).toBeTruthy();
    // 通知没开：顶栏没有提醒的铃铛
    expect(screen.queryByRole('button', { name: /提醒/ })).toBeNull();
  });

  test('开了的模块照常显示', async () => {
    scope(['board', 'schedules']);
    renderApp(
      <Routes>
        <Route element={<Shell />}>
          <Route path="schedules" element={<p>定时任务的页面</p>} />
        </Route>
      </Routes>,
      { api: demoApi(), route: '/schedules' },
    );
    expect(await screen.findByText('定时任务的页面')).toBeTruthy();
  });
});

describe('演示版：通知里谁在处理', () => {
  test('跟进单只写文字、不给外链（演示产物里出现 github.com 打包就拒）', async () => {
    scope(['notifications'], 'process');
    renderApp(<NotificationsPage />, { api: demoApi() });
    const handling = await screen.findAllByTestId('alert-handling');
    expect(handling.length).toBeGreaterThan(0);
    expect(screen.getByText('acme/orbit#17')).toBeTruthy();
    for (const row of handling) expect(row.querySelector('a')).toBeNull();
  });
});

describe('演示版：数据层', () => {
  test('没开放的模块直接回「没开放」，不给数据', async () => {
    scope(['board']);
    const api = demoApi();
    for (const call of [
      () => api.jobs(),
      () => api.notifications(),
      () => api.audit(),
      () => api.settings(),
      () => api.demoLinks(),
      // 路由两层（#574）：演示版没有这个模块，开了什么都不给
      () => api.routingLayers(),
      // 发布的版本号（#725）：/changelog 页不进演示版
      () => api.releaseVersion(),
    ]) {
      const err = await call().catch((e: unknown) => e);
      expect(err).toBeInstanceOf(ApiError);
      expect((err as ApiError).code).toBe('demo_hidden');
    }
  });

  test('细节不到「过程」：看板标题按级别收', async () => {
    scope(['board', 'task'], 'titles');
    const api = demoApi();
    const board = await api.board('r-orbit');
    expect(board.tasks.every((t) => !t.title.startsWith('需求 #'))).toBe(true);
    expect(board.tasks.flatMap((t) => t.subtasks).every((s) => s.touches.length === 0)).toBe(true);
    scope(['board'], 'status');
    expect((await api.board('r-orbit')).tasks.every((t) => t.title === `需求 #${t.issueNumber}`)).toBe(true);
  });

  test('没开操作记录：前端直回「没开放」，不给数据', async () => {
    scope(['board']);
    const err = await demoApi()
      .audit()
      .catch((e: unknown) => e);
    expect((err as ApiError).code).toBe('demo_hidden');
  });

  test('访客：不用登录，名字是访客', async () => {
    scope(['board']);
    const api = demoApi();
    expect(api.source).toBe('demo');
    expect((await api.me()).user.displayName).toBe('访客');
    expect(((await api.devLogin('u-lan').catch((e: unknown) => e)) as ApiError).code).toBe('demo_no_login');
  });
});

describe('演示版：本机记着的口令', () => {
  const KEY = 'meridian-demo.k';
  const TOKEN = 'B'.repeat(43);
  afterEach(() => {
    vi.unstubAllGlobals();
    localStorage.clear();
  });
  /** 带着本机记的口令打开一次；范围文件照 respond 回。 */
  const open = (respond: (url: string) => Response) => {
    localStorage.setItem(KEY, TOKEN);
    vi.stubGlobal('fetch', async (url: string | URL | Request) => respond(String(url)));
    setDemoScopeForTest(null);
    return loadDemoScope();
  };
  const notFound = () => new Response('not found', { status: 404 });

  test('没读成（网络一闪）：口令留着，下回打开再试', async () => {
    const r = await open(() => {
      throw new TypeError('Failed to fetch');
    });
    expect(r?.link).toBe('broken');
    expect(localStorage.getItem(KEY)).toBe(TOKEN);
  });

  test('链接作废（404）、过期了：忘掉本机记的口令', async () => {
    expect((await open(notFound))?.link).toBe('missing');
    expect(localStorage.getItem(KEY)).toBeNull();

    const old = { v: 1, modules: ['board'], detail: 'status', expiresAt: '2000-01-01T00:00:00Z' };
    const r = await open((url) =>
      url.endsWith('default.json')
        ? notFound()
        : new Response(JSON.stringify(old), { headers: { 'content-type': 'application/json' } }),
    );
    expect(r?.link).toBe('expired');
    expect(localStorage.getItem(KEY)).toBeNull();
  });
});
