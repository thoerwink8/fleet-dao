// @vitest-environment happy-dom
// 外壳（#3509 照 Arco Pro 重写）：顶栏 60 横跨全宽、左菜单 220（<1280 收成 48 宽图标条）、手机底部四格；
// 最前面的「跳到正文」：第一个 Tab 停在它上面；激活后焦点落到正文区，下一跳才进正文里的控件。
import { cleanup, fireEvent, screen, waitFor, within } from '@testing-library/react';
import { Route, Routes } from 'react-router';
import { afterEach, describe, expect, test, vi } from 'vitest';
import { createMockApi } from '../api/mock/server';
import { activeMenu } from '../components/shell/nav';
import { renderApp } from '../test/harness';
import Shell from './shell';

afterEach(cleanup);

function Page() {
  return <button type="button">正文按钮</button>;
}

function renderShell(route = '/') {
  return renderApp(
    <Routes>
      <Route element={<Shell />}>
        <Route path="*" element={<Page />} />
      </Route>
    </Routes>,
    { api: createMockApi({ live: false }), route },
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

/** 链接或按钮上的名字，去掉计数角标（数字、99+、!）。 */
const label = (el: Element) => (el.textContent ?? '').replace(/\d+\+?|!/g, '');

/** Radix 的下拉在 happy-dom 里要 pointerdown 才开。 */
function openMenu(trigger: HTMLElement) {
  fireEvent.pointerDown(trigger, { button: 0, ctrlKey: false });
}

describe('菜单高亮（nav.ts 的 activeMenu）', () => {
  test('菜单项自己、它下面的页亮自己；不进菜单的页亮挂靠的那一项', () => {
    expect(activeMenu('/')).toBe('/');
    expect(activeMenu('/tasks/t-12')).toBe('/tasks');
    expect(activeMenu('/routing')).toBe('/routing');
    expect(activeMenu('/routing/status')).toBe('/routing');
    for (const p of ['/schedules', '/resources', '/changelog', '/audit', '/board', '/billing']) {
      expect(activeMenu(p), p).toBe('/france');
    }
    expect(activeMenu('/no-such-page')).toBeNull();
  });
});

describe('外壳按屏宽重排', () => {
  afterEach(() => {
    vi.restoreAllMocks();
    localStorage.clear();
  });

  test('1440 宽：左菜单八项（工作台、通知、任务、提需求；运维：法国、路由、额度；设置），定时任务这类低频页不进菜单', async () => {
    viewport(1440);
    renderShell();
    await settled();
    const nav = screen.getByRole('navigation', { name: '主导航' });
    expect([...nav.querySelectorAll('a')].map(label)).toEqual([
      '工作台',
      '通知',
      '任务',
      '提需求',
      '法国',
      '路由',
      '额度',
      '设置',
    ]);
    expect(nav.textContent).toContain('运维');
    for (const gone of ['定时任务', '资源', '发布记录', '操作记录', '渠道状态', '画布', '账单']) {
      expect(nav.textContent).not.toContain(gone);
    }
    // 选中项：浅蓝底、蓝字
    const home = within(nav).getByRole('link', { name: '工作台' });
    expect(home.getAttribute('aria-current')).toBe('page');
    expect(home.className).toContain('bg-brand-1');
    expect(home.className).toContain('text-brand-ink');
    // 顶栏横跨全宽：在左菜单外面、在它前面
    const header = document.querySelector('header') as HTMLElement;
    expect(header.contains(nav)).toBe(false);
    expect((header.compareDocumentPosition(nav) & Node.DOCUMENT_POSITION_FOLLOWING) !== 0).toBe(true);
  });

  test('在定时任务页亮「法国」，在渠道状态页亮「路由」', async () => {
    viewport(1440);
    const a = renderShell('/schedules');
    await settled();
    const nav = () => screen.getByRole('navigation', { name: '主导航' });
    expect(within(nav()).getByRole('link', { name: '法国' }).getAttribute('aria-current')).toBe('page');
    a.unmount();
    renderShell('/routing/status');
    await settled();
    expect(within(nav()).getByRole('link', { name: '路由' }).getAttribute('aria-current')).toBe('page');
    expect(within(nav()).getByRole('link', { name: '工作台' }).getAttribute('aria-current')).toBeNull();
  });

  test('⌘K 面板里搜得到菜单外的页：定时任务、资源、发布记录、操作记录、渠道状态、画布、账单', async () => {
    viewport(1440);
    renderShell();
    await settled();
    fireEvent.keyDown(window, { key: 'k', ctrlKey: true });
    const dialog = await screen.findByRole('dialog');
    for (const name of [
      '工作台',
      '法国',
      '定时任务',
      '资源',
      '发布记录',
      '操作记录',
      '渠道状态',
      '画布',
      '账单',
    ]) {
      expect(dialog.textContent, name).toContain(name);
    }
  });

  test('顶栏的搜索框点开就是 ⌘K 面板', async () => {
    viewport(1440);
    renderShell();
    await settled();
    fireEvent.click(screen.getByRole('button', { name: '搜索' }));
    expect(await screen.findByRole('dialog')).toBeTruthy();
  });

  test('390 宽：底部导航四格（工作台、通知、任务、更多），常驻左菜单不渲染', async () => {
    viewport(390);
    renderShell();
    await settled();
    const nav = screen.getByRole('navigation', { name: '底部导航' });
    expect([...nav.querySelectorAll('a, button')].map(label)).toEqual(['工作台', '通知', '任务', '更多']);
    expect(document.querySelector('aside')).toBeNull();
    expect(screen.queryByRole('navigation', { name: '主导航' })).toBeNull();
  });

  test('底部「更多」：法国、路由、额度、提需求、设置，和搜全部页面（打开 ⌘K 面板）', async () => {
    viewport(390);
    renderShell();
    await settled();
    openMenu(screen.getByRole('button', { name: /^更多/ }));
    const menu = await screen.findByRole('menu');
    for (const name of ['法国', '路由', '额度', '提需求', '设置']) expect(menu.textContent).toContain(name);
    fireEvent.click(within(menu).getByRole('menuitem', { name: /搜全部页面/ }));
    expect(await screen.findByRole('dialog')).toBeTruthy();
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
    expect(master.className).not.toMatch(/\bhidden\b/);
    expect(master.className).toContain('size-10');
    fireEvent.click(master);
    expect(await screen.findByText(/去法国页看开关/)).toBeTruthy();
    fireEvent.keyDown(document.activeElement ?? document.body, { key: 'Escape' });
    // 尺寸类：每个按钮在 <768 下是 size-10 / h-10 / h-14
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

  test('正文区 min-w-0 + overflow-x-hidden、page 底色：390、768 宽 main 的 scrollWidth 不大于 clientWidth', async () => {
    for (const width of [390, 768]) {
      viewport(width);
      const { unmount } = renderShell();
      await settled();
      const main = screen.getByRole('main');
      expect(main.className).toContain('min-w-0');
      expect(main.className).toContain('overflow-x-hidden');
      expect(main.className).toContain('bg-page');
      expect(main.scrollWidth).toBeLessThanOrEqual(main.clientWidth);
      unmount();
    }
  });

  test('768、1279 宽左菜单默认收成 48 宽图标条，1280 宽默认展开 220，没有底部导航', async () => {
    for (const width of [768, 1279]) {
      viewport(width);
      const view = renderShell();
      await settled();
      const aside = document.querySelector('aside') as HTMLElement;
      expect(aside.dataset.menu, String(width)).toBe('collapsed');
      expect(aside.className.split(' ')).toContain('w-12');
      // 收起时没有字，名字交给读屏
      expect(screen.getByRole('link', { name: '工作台' }).textContent).toBe('');
      expect(screen.queryByRole('navigation', { name: '底部导航' })).toBeNull();
      view.unmount();
      vi.restoreAllMocks();
    }
    viewport(1280);
    renderShell();
    await settled();
    const aside = document.querySelector('aside') as HTMLElement;
    expect(aside.dataset.menu).toBe('open');
    expect(aside.className.split(' ')).toContain('w-sidebar');
  });

  test('点底部的收起 / 展开：记在本地，刷新后照人选的', async () => {
    viewport(1440);
    const first = renderShell();
    await settled();
    fireEvent.click(screen.getByRole('button', { name: '收起菜单' }));
    expect(document.querySelector('aside')?.getAttribute('data-menu')).toBe('collapsed');
    expect(localStorage.getItem('fleet-dao.sidebar-collapsed')).toBe('true');
    first.unmount();
    renderShell();
    await settled();
    expect(document.querySelector('aside')?.getAttribute('data-menu')).toBe('collapsed');
    fireEvent.click(screen.getByRole('button', { name: '展开菜单' }));
    expect(document.querySelector('aside')?.getAttribute('data-menu')).toBe('open');
  });

  test('人手动展开过：768 宽也按人选的', async () => {
    viewport(768);
    localStorage.setItem('fleet-dao.sidebar-collapsed', 'false');
    renderShell();
    await settled();
    expect(document.querySelector('aside')?.getAttribute('data-menu')).toBe('open');
  });

  test('电脑顶栏：标志、仓切换、环境切换、搜索、引擎状态、铃铛、帮助、账号', async () => {
    viewport(1440);
    renderShell();
    await settled();
    const header = document.querySelector('header') as HTMLElement;
    await waitFor(() => expect(header.querySelector('[data-env-switcher]')).toBeTruthy());
    expect(within(header).getByRole('button', { name: '切换项目' })).toBeTruthy();
    expect(header.querySelector('[data-env-switcher="local"]')?.textContent).toContain('本台');
    expect(header.querySelector('[data-engine-master]')).toBeTruthy();
    expect(within(header).getByRole('button', { name: /^提醒/ })).toBeTruthy();
    expect(within(header).getByRole('button', { name: '帮助' })).toBeTruthy();
    expect(within(header).getByRole('button', { name: '我的账号' })).toBeTruthy();
  });
});

describe('选了远程环境', () => {
  afterEach(() => {
    vi.restoreAllMocks();
    localStorage.clear();
  });

  test('顶栏不显示铃铛；只在本台有的页整页明说、不渲染页面本体；工作台照常渲染', async () => {
    viewport(1440);
    const a = renderShell('/quota?node=wsl');
    expect(await screen.findByText(/这一页只看得到/)).toBeTruthy();
    expect(screen.queryByRole('button', { name: '正文按钮' })).toBeNull();
    expect(screen.queryByRole('button', { name: /^提醒/ })).toBeNull();
    // 菜单的「通知」也不挂本台的件数
    const nav = screen.getByRole('navigation', { name: '主导航' });
    expect(within(nav).getByRole('link', { name: '通知' }).textContent).toBe('通知');
    a.unmount();
    renderShell('/?node=wsl');
    await settled();
    expect(screen.queryByRole('button', { name: /^提醒/ })).toBeNull();
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
