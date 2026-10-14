// @vitest-environment happy-dom
// 窄屏顶栏（#2215）：390 宽整排放不下（内容 438 宽，铃铛被截、头像在屏外）。手机顶栏只留仓名、总开关点、铃铛、账号，
// 搜索、环境切换、实时状态收进一个「更多」菜单；电脑顶栏不变。真实排版（有没有挤出屏外）由 e2e 02-home 量，这里钉结构。
import { cleanup, fireEvent, screen, waitFor } from '@testing-library/react';
import { Route, Routes } from 'react-router';
import { afterEach, describe, expect, test, vi } from 'vitest';
import { createMockApi } from '../api/mock/server';
import Shell from '../routes/shell';
import { renderApp } from './harness';

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
  localStorage.clear();
});

/** 假装屏宽：happy-dom 的 matchMedia 不认我们的断点，按宽度手算 min-width / max-width。 */
function viewport(width: number) {
  vi.spyOn(window, 'matchMedia').mockImplementation(
    (query: string) =>
      ({
        matches: [...query.matchAll(/\((min|max)-width:\s*(\d+)px\)/g)].every(([, kind, px]) =>
          kind === 'min' ? width >= Number(px) : width <= Number(px),
        ),
        media: query,
        onchange: null,
        addEventListener() {},
        removeEventListener() {},
        addListener() {},
        removeListener() {},
        dispatchEvent: () => false,
      }) as MediaQueryList,
  );
}

async function renderShell() {
  renderApp(
    <Routes>
      <Route element={<Shell />}>
        <Route index element={<p>正文</p>} />
      </Route>
    </Routes>,
    { api: createMockApi({ live: false }) },
  );
  await screen.findByText('正文');
  await waitFor(() => expect(screen.queryByText('正在确认登录…')).toBeNull());
  await waitFor(() =>
    expect(document.querySelector('header [data-env-switcher], header [data-topbar-more]')).toBeTruthy(),
  );
}

const headerNames = () =>
  [...document.querySelectorAll('header button, header a')].map((el) => el.getAttribute('aria-label') ?? '');

describe('手机顶栏只留要紧的', () => {
  for (const width of [390, 360, 320]) {
    test(`${width} 宽：顶栏里是仓名、总开关、更多、铃铛、账号，搜索、环境、实时不在顶栏`, async () => {
      viewport(width);
      await renderShell();
      const header = document.querySelector('header') as HTMLElement;
      expect(header.getAttribute('data-topbar')).toBe('phone');
      // 最多五个控件：再加就又挤出屏外了
      expect(headerNames().length).toBeLessThanOrEqual(5);
      expect(screen.getByRole('button', { name: '切换项目' })).toBeTruthy();
      expect(header.querySelector('[data-engine-master]')).toBeTruthy();
      expect(screen.getByRole('button', { name: /^提醒/ })).toBeTruthy();
      expect(screen.getByRole('button', { name: '我的账号' })).toBeTruthy();
      expect(header.querySelector('[data-env-switcher]')).toBeNull();
      expect(header.querySelector('[role="status"][data-live]')).toBeNull();
      expect(screen.queryByRole('button', { name: '搜索' })).toBeNull();
      // 仓名按钮能缩（不 shrink-0），否则它会把右边的铃铛、账号顶出屏外
      expect(screen.getByRole('button', { name: '切换项目' }).className).toContain('min-w-0');
      expect(screen.getByRole('button', { name: '切换项目' }).className).not.toMatch(/(^|\s)shrink-0/);
    });
  }

  test('点「更多」：有搜索、环境列表、实时状态；点搜索打开搜索面板', async () => {
    viewport(390);
    await renderShell();
    fireEvent.pointerDown(screen.getByRole('button', { name: /^搜索、环境、实时/ }), {
      button: 0,
      ctrlKey: false,
    });
    const menu = await screen.findByRole('menu');
    expect(menu.querySelector('[data-node-item="local"]')).toBeTruthy();
    expect(menu.textContent).toContain('打开法国页');
    expect(menu.querySelector('[data-live]')?.textContent).toMatch(/实时/);
    fireEvent.click(screen.getByRole('menuitem', { name: /搜任务、页面、操作/ }));
    expect(await screen.findByRole('dialog')).toBeTruthy();
  });
});

describe('电脑顶栏不变', () => {
  test('1366 宽：环境切换器、搜索、实时、铃铛、账号都还在顶栏，没有「更多」', async () => {
    viewport(1366);
    await renderShell();
    const header = document.querySelector('header') as HTMLElement;
    expect(header.getAttribute('data-topbar')).toBeNull();
    expect(header.querySelector('[data-env-switcher]')).toBeTruthy();
    expect(header.querySelector('[role="status"][data-live]')).toBeTruthy();
    expect(screen.getByRole('button', { name: '搜索' })).toBeTruthy();
    expect(screen.getByRole('button', { name: /^提醒/ })).toBeTruthy();
    expect(screen.getByRole('button', { name: '我的账号' })).toBeTruthy();
    expect(document.querySelector('header [data-topbar-more]')).toBeNull();
  });
});
