// @vitest-environment happy-dom
// 正式驾驶舱看得见的名字（#54）：登录页、标签页标题、启动画面、左上角都只写「驾驶舱」，不带仓名、GitHub 账号名和地址。
// 词表用打包扫描那一份（BUILTIN_TERMS）；「驾驶舱」是两边左上角都写的名字，不算。
import { cleanup, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, test } from 'vitest';
import { brand } from '#brand';
import { ApiError, type FleetApi } from '../api/client';
import { createMockApi } from '../api/mock/server';
import { BUILTIN_TERMS, scanText } from '../build/scan';
import { SidebarNav } from '../components/shell/sidebar';
import { HydrateFallback } from '../root';
import LoginPage from '../routes/login';
import { renderApp } from '../test/harness';

const TERMS = BUILTIN_TERMS.filter((t) => t !== '驾驶舱');

afterEach(cleanup);

/** 连真后端、还没登录：飞书登录配好了，开发免登也开着（登录页上的字最多的样子）。 */
function loggedOut(): FleetApi {
  return {
    ...createMockApi({ live: false }),
    source: 'http',
    authConfig: async () => ({ feishuAppId: 'cli_test', devLogin: true }),
    me: async () => {
      throw new ApiError(401, 'unauthenticated', '要先登录');
    },
  };
}

describe('正式驾驶舱：看得见的名字不带仓名', () => {
  test('先红：换名字之前的标题、左上角和 GitHub 外链都拦得住', () => {
    expect(scanText('旧标题', '登录 · fleet-dao 驾驶舱', TERMS).map((h) => h.term)).toEqual(['fleet', 'dao']);
    expect(scanText('旧左上角', 'fleet·dao', TERMS).map((h) => h.term)).toEqual(['fleet', 'dao']);
    expect(scanText('外链', '<a href="https://github.com/someone/x">', TERMS).map((h) => h.term)).toEqual([
      'github.com',
    ]);
  });

  test('登录页：字、链接、输入框提示都不带', async () => {
    renderApp(<LoginPage />, { api: loggedOut(), route: '/login' });
    expect(await screen.findByRole('link', { name: /用飞书登录/ })).toBeTruthy();
    expect(screen.getByRole('heading', { level: 1 }).textContent).toBe('登录驾驶舱');
    expect(screen.getByText('开发环境免登：填白名单里的用户编号')).toBeTruthy();
    expect(scanText('登录页', document.body.innerHTML, TERMS)).toEqual([]);
  });

  test('标签页标题：整站的和每一页的', () => {
    const pages = import.meta.glob<{ meta?: () => { title?: string }[] }>('../routes/*.tsx', { eager: true });
    const titles = [
      brand.title(),
      ...Object.values(pages).flatMap((page) => (page.meta?.() ?? []).map((m) => m.title ?? '')),
    ];
    expect(titles).toEqual(expect.arrayContaining(['驾驶舱', '登录 · 驾驶舱', '看板 · 驾驶舱']));
    expect(scanText('标签页标题', titles.join('\n'), TERMS)).toEqual([]);
  });

  test('启动画面只写「驾驶舱」', () => {
    expect(render(<HydrateFallback />).container.textContent).toBe('驾驶舱启动中…');
  });

  test('左上角只写一行「驾驶舱」', () => {
    renderApp(<SidebarNav />);
    expect(screen.getByText('驾驶舱').parentElement?.textContent).toBe('驾驶舱');
  });
});
