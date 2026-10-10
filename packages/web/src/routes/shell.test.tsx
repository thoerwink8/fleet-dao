// @vitest-environment happy-dom
// 外壳最前面的「跳到正文」：第一个 Tab 停在它上面；激活后焦点落到正文区，下一跳才进正文里的控件。
import { cleanup, fireEvent, screen, waitFor } from '@testing-library/react';
import { Route, Routes } from 'react-router';
import { afterEach, describe, expect, test, vi } from 'vitest';
import { createMockApi } from '../api/mock/server';
import { renderApp } from '../test/harness';
import Shell from './shell';

afterEach(cleanup);

function Page() {
  return <button type="button">正文按钮</button>;
}

function renderShell() {
  return renderApp(
    <Routes>
      <Route element={<Shell />}>
        <Route index element={<Page />} />
      </Route>
    </Routes>,
    { api: createMockApi({ live: false }) },
  );
}

/** 文档顺序里 Tab 会停住的元素。tabindex 为负、藏起来的、关掉的浮层都不算。 */
function tabStops(): HTMLElement[] {
  const selector = [
    'a[href]',
    'button:not([disabled])',
    'input:not([disabled])',
    'select:not([disabled])',
    'textarea:not([disabled])',
    '[tabindex]',
  ].join(', ');
  return [...document.querySelectorAll<HTMLElement>(selector)].filter((el) => {
    if (el.tabIndex < 0) return false;
    if (el.hasAttribute('disabled')) return false;
    if (el.getAttribute('aria-hidden') === 'true') return false;
    if (el.closest('[hidden], [inert], [aria-hidden="true"]')) return false;
    return true;
  });
}

/** `from` 之后的下一个 Tab 停点（含它里面的控件）。 */
function tabAfter(from: Element): HTMLElement | undefined {
  return tabStops().find((el) => (from.compareDocumentPosition(el) & Node.DOCUMENT_POSITION_FOLLOWING) !== 0);
}

async function settled() {
  expect(await screen.findByRole('button', { name: '正文按钮' })).toBeTruthy();
  await waitFor(() => expect(screen.queryByText('正在确认登录…')).toBeNull());
}

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

describe('外壳按屏宽重排（#1801）', () => {
  afterEach(() => {
    vi.restoreAllMocks();
    localStorage.clear();
  });

  test('390 宽：底部导航四项（主页、任务、通知、更多），顶栏没有汉堡按钮，常驻侧栏不渲染', async () => {
    viewport(390);
    renderShell();
    await settled();
    const nav = screen.getByRole('navigation', { name: '底部导航' });
    expect(nav).toBeTruthy();
    // 通知项带待处理角标（数字），文字里先后是角标、名字
    const items = [...nav.querySelectorAll('a, button')].map((el) => el.textContent?.replace(/^\d+|^!/, ''));
    expect(items).toEqual(['主页', '任务', '通知', '更多']);
    expect(screen.queryByRole('button', { name: '打开导航' })).toBeNull();
    expect(document.querySelector('aside')).toBeNull();
  });

  test('「更多」打开原来的导航抽屉（全部页面都在里面）', async () => {
    viewport(390);
    renderShell();
    await settled();
    fireEvent.click(screen.getByRole('button', { name: /更多/ }));
    const dialog = await screen.findByRole('dialog');
    expect(dialog.textContent).toContain('渠道状态');
    expect(dialog.textContent).toContain('设置');
  });

  test('390 宽：顶栏有总开关状态点（点开是总开关卡片），顶栏和底部导航的按钮都不小于 40×40', async () => {
    viewport(390);
    renderShell();
    await settled();
    const master = await waitFor(() => {
      const el = document.querySelector('header [data-engine-master]');
      expect(el).toBeTruthy();
      return el as HTMLElement;
    });
    // 状态元素在、不是 hidden（手机上以前被 hidden sm:flex 藏掉）
    expect(master.className).not.toMatch(/\bhidden\b/);
    expect(master.className).toContain('size-10');
    fireEvent.click(master);
    expect(await screen.findByText(/去法国页看开关/)).toBeTruthy();
    fireEvent.keyDown(document.activeElement ?? document.body, { key: 'Escape' });
    // 尺寸类：每个按钮在 <768 下是 size-10 / h-10 / h-14，到 md 才缩回 32px
    const buttons = [
      ...document.querySelectorAll('header button, header a, [data-bottom-nav] a, [data-bottom-nav] button'),
    ].filter((el) => !el.className.includes('hidden'));
    expect(buttons.length).toBeGreaterThan(5);
    for (const el of buttons) {
      expect(el.className, el.getAttribute('aria-label') ?? el.textContent ?? '').toMatch(
        /\bsize-10\b|\bh-10\b|\bh-14\b/,
      );
    }
  });

  test('正文区 min-w-0 + overflow-x-hidden：390、768 宽主页 main 的 scrollWidth 不大于 clientWidth', async () => {
    for (const width of [390, 768]) {
      viewport(width);
      const { unmount } = renderShell();
      await settled();
      const main = screen.getByRole('main');
      expect(main.className).toContain('min-w-0');
      expect(main.className).toContain('overflow-x-hidden');
      expect(main.scrollWidth).toBeLessThanOrEqual(main.clientWidth);
      unmount();
    }
  });

  test('768 宽侧栏默认收成图标栏，1366 宽默认展开，没有底部导航', async () => {
    viewport(768);
    const small = renderShell();
    await settled();
    expect(document.querySelector('aside')?.className).toContain('w-sidebar-collapsed');
    expect(screen.queryByRole('navigation', { name: '底部导航' })).toBeNull();
    small.unmount();
    viewport(1366);
    renderShell();
    await settled();
    expect(document.querySelector('aside')?.className.split(' ')).toContain('w-sidebar');
    expect(document.querySelector('aside')?.className).not.toContain('w-sidebar-collapsed');
  });

  test('人手动展开过：768 宽也按人选的', async () => {
    viewport(768);
    localStorage.setItem('fleet-dao.sidebar-collapsed', 'false');
    renderShell();
    await settled();
    expect(document.querySelector('aside')?.className).not.toContain('w-sidebar-collapsed');
  });
});

describe('跳到正文', () => {
  test('第一个 Tab 停在跳到正文', async () => {
    renderShell();
    await settled();
    const link = screen.getByRole('link', { name: '跳到正文' });
    const main = screen.getByRole('main');
    expect(tabStops()[0]).toBe(link);
    expect((main.compareDocumentPosition(link) & Node.DOCUMENT_POSITION_PRECEDING) !== 0).toBe(true);
    link.focus();
    expect(document.activeElement).toBe(link);
  });

  test('激活后焦点进正文区', async () => {
    renderShell();
    await settled();
    const link = screen.getByRole('link', { name: '跳到正文' });
    const main = screen.getByRole('main');
    expect(main.tabIndex).toBe(-1);
    fireEvent.click(link);
    expect(document.activeElement).toBe(main);
    expect(tabAfter(main)).toBe(screen.getByRole('button', { name: '正文按钮' }));
  });
});
