// @vitest-environment happy-dom
// 演示版的界面：换成演示版的品牌（#brand → demo.tsx），按可见范围开关模块、收细节；数据层也挡一道。
import { cleanup, screen, waitFor } from '@testing-library/react';
import { Route, Routes } from 'react-router';
import { afterEach, describe, expect, test, vi } from 'vitest';

vi.mock('#brand', async () => await import('../brand/demo'));

import { ApiError } from '../api/client';
import { createMockApi } from '../api/mock/server';
import { demoBlocked, visibleNav } from '../components/shell/nav';
import { SidebarNav } from '../components/shell/sidebar';
import Shell from '../routes/shell';
import TaskDetailPage from '../routes/task-detail';
import { renderApp } from '../test/harness';
import { setDemoScopeForTest } from './access';
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
    expect(visibleNav().flatMap((g) => g.items.map((i) => i.to))).toEqual(['/', '/overview', '/quota']);
    expect(demoBlocked('/')).toBe(false);
    expect(demoBlocked('/dispatch')).toBe(true);
    expect(demoBlocked('/tasks/t-12')).toBe(true);
    expect(demoBlocked('/demo-links')).toBe(true);
    expect(demoBlocked('/models')).toBe(true);
    // 不是导航里的路径交给 404 页
    expect(demoBlocked('/no-such-page')).toBe(false);
  });

  test('侧栏照范围列，底部写明是假数据', async () => {
    scope(['board', 'dispatch']);
    renderApp(<SidebarNav />, { api: demoApi() });
    expect(screen.getByRole('link', { name: /调度台/ })).toBeTruthy();
    expect(screen.queryByRole('link', { name: /额度/ })).toBeNull();
    expect(screen.queryByRole('link', { name: /演示版/ })).toBeNull();
    expect(screen.getByText('子午')).toBeTruthy();
    expect(screen.getByText('假数据（演示）')).toBeTruthy();
  });

  test('没开放的模块整页换成「没开放」，顶上有演示版横幅和链接的状态', async () => {
    scope(['board'], 'status', '这条演示链接已过期，下面按默认范围展示。');
    renderApp(
      <Routes>
        <Route element={<Shell />}>
          <Route path="dispatch" element={<p>调度台的页面</p>} />
        </Route>
      </Routes>,
      { api: demoApi(), route: '/dispatch' },
    );
    expect(await screen.findByText('演示版没开放这一块')).toBeTruthy();
    expect(screen.queryByText('调度台的页面')).toBeNull();
    expect(screen.getByText('演示版·全是假数据，操作不会有任何影响')).toBeTruthy();
    expect(screen.getByText('这条演示链接已过期，下面按默认范围展示。')).toBeTruthy();
    // 通知没开：顶栏没有提醒的铃铛
    expect(screen.queryByRole('button', { name: /提醒/ })).toBeNull();
  });

  test('开了的模块照常显示', async () => {
    scope(['board', 'dispatch']);
    renderApp(
      <Routes>
        <Route element={<Shell />}>
          <Route path="dispatch" element={<p>调度台的页面</p>} />
        </Route>
      </Routes>,
      { api: demoApi(), route: '/dispatch' },
    );
    expect(await screen.findByText('调度台的页面')).toBeTruthy();
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
    ]) {
      const err = await call().catch((e: unknown) => e);
      expect(err).toBeInstanceOf(ApiError);
      expect((err as ApiError).code).toBe('demo_hidden');
    }
  });

  test('细节不到「过程」：时间线、步骤清单不给；看板标题按级别收', async () => {
    scope(['board', 'task'], 'titles');
    const api = demoApi();
    expect(((await api.timeline('t-12').catch((e: unknown) => e)) as ApiError).code).toBe('demo_hidden');
    const board = await api.board('r-orbit');
    expect(board.tasks.every((t) => !t.title.startsWith('需求 #'))).toBe(true);
    expect(board.tasks.flatMap((t) => t.subtasks).every((s) => s.touches.length === 0)).toBe(true);
    scope(['board'], 'status');
    expect((await api.board('r-orbit')).tasks.every((t) => t.title === `需求 #${t.issueNumber}`)).toBe(true);
  });

  test('只开调度台：操作记录只给改路由顺序的那几条（调度台的「最近改动」要用）', async () => {
    scope(['dispatch']);
    const res = await demoApi().audit();
    expect(res.items.length).toBeGreaterThan(0);
    expect(new Set(res.items.map((e) => e.action))).toEqual(new Set(['stage_policy.update']));
  });

  test('访客：不用登录，名字是访客', async () => {
    scope(['board']);
    const api = demoApi();
    expect(api.source).toBe('demo');
    expect((await api.me()).user.displayName).toBe('访客');
    expect(((await api.devLogin('u-lan').catch((e: unknown) => e)) as ApiError).code).toBe('demo_no_login');
  });
});

describe('演示版：任务详情按细节级别收', () => {
  test('只到标题：原话、步骤清单、日志都写「没开放」，标题照常', async () => {
    scope(['board', 'task'], 'titles');
    renderApp(
      <Routes>
        <Route path="tasks/:taskId" element={<TaskDetailPage />} />
      </Routes>,
      { api: demoApi(), route: '/tasks/t-12?sub=t-12-b' },
    );
    expect(await screen.findByText('登录页加手机验证码')).toBeTruthy();
    await waitFor(() => expect(screen.getByText('演示版没开放需求的原话')).toBeTruthy());
    expect(screen.getByText('演示版没开放步骤清单')).toBeTruthy();
    expect(screen.getAllByText('演示版没开放过程日志').length).toBeGreaterThan(0);
  });
});
