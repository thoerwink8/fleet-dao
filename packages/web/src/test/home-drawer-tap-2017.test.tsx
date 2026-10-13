// @vitest-environment happy-dom
// 手机宽度下主页抽屉按钮的点击区不小于 44px（#2017）。happy-dom 不排版，这里钉高度类：
// 根字号在 <48rem 是 1（1rem = 16px），h-11 / min-h-11 / size-11 = 2.75rem = 44px。
import { cleanup, fireEvent, screen } from '@testing-library/react';
import { afterEach, expect, test, vi } from 'vitest';
import { HomeDrawer } from '../components/home/home-drawer';
import { renderApp } from './harness';

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

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

test('390 宽：横条、本机按钮、抽屉页签和关闭键都至少 44px', async () => {
  viewport(390);
  renderApp(
    <HomeDrawer decisions={[]} done={[]} remote={false} phone>
      <p>画布</p>
    </HomeDrawer>,
  );
  const strip = document.querySelector('[data-home-strip]');
  expect(strip?.className ?? '').toMatch(/\b(?:min-h-11|h-11)\b/);
  const local = document.querySelector('[data-local-button]');
  expect(local?.className ?? '').toMatch(/\bh-11\b/);
  expect(local?.className ?? '').not.toMatch(/\bh-8\b/);
  fireEvent.click(strip as HTMLElement);
  const tabs = await screen.findAllByRole('tab');
  expect(tabs.length).toBeGreaterThan(0);
  for (const tab of tabs) expect(tab.className).toMatch(/\bh-11\b/);
  const close = screen.getByRole('button', { name: '关闭' });
  expect(close.className).toMatch(/\bsize-11\b/);
});
