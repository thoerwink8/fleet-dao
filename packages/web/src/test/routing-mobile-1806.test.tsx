// @vitest-environment happy-dom
// 路由、渠道状态两页在手机上的版面（#1806）：
// - 渠道状态：不到 lg（1024）只画列表，点一行从底部（手机）开详情抽屉，不再上下堆两栏。
// - 路由：每行的开关、上移、下移、置顶、置底、移出收进行尾一个「⋯」菜单，菜单项照旧走原来的接口。
// - 页头右边那一排（状态胶囊、刷新）可以换行，不撑出屏幕；操作记录的 pre 自动换行。
// 真正的横向溢出（scrollWidth 大于 clientWidth）要有版面引擎才量得出：这里只能断言类名和 happy-dom 里量得出的 0；
// 真量宽度的在 e2e/specs/11-mobile-overflow.e2e.ts。
import { cleanup, fireEvent, screen, waitFor, within } from '@testing-library/react';
import { afterEach, describe, expect, test, vi } from 'vitest';
import { createMockApi } from '../api/mock/server';
import { Page } from '../components/page';
import AuditPage from '../routes/audit';
import RoutingPage from '../routes/routing';
import RoutingStatus from '../routes/routing-status';
import { renderApp } from './harness';

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

const realMatchMedia = window.matchMedia.bind(window);

/** 手机宽度（390）：max-width 767 和 max-width 1023 都成立，min-width 的都不成立。 */
function mockPhone() {
  vi.spyOn(window, 'matchMedia').mockImplementation((query: string) => {
    const real = realMatchMedia(query);
    if (query === '(max-width: 767px)' || query === '(max-width: 1023px)') {
      return {
        matches: true,
        media: query,
        onchange: null,
        addEventListener() {},
        removeEventListener() {},
        addListener() {},
        removeListener() {},
        dispatchEvent() {
          return false;
        },
      } as MediaQueryList;
    }
    return real;
  });
}

const classes = (el: Element | null) => (el?.getAttribute('class') ?? '').split(/\s+/).filter(Boolean);

/** 打开一个 Radix 菜单：键盘 Enter 就能开，不依赖 happy-dom 的指针事件。 */
const openMenu = (trigger: HTMLElement) => {
  trigger.focus();
  fireEvent.keyDown(trigger, { key: 'Enter' });
};

describe('渠道状态页：手机只画列表，点一行开详情抽屉', () => {
  test('390 宽：列表在、详情不在；点一行后详情抽屉出现，关掉后又只剩列表', async () => {
    mockPhone();
    const { container } = renderApp(<RoutingStatus />, { route: '/routing/status' });
    const list = await screen.findByRole('list', { name: '渠道状态' });
    expect(list).toBeTruthy();
    // 详情不在：没有渠道标题（详情里的 h2）、没有「探这个渠道」、没有抽屉
    expect(screen.queryByRole('button', { name: '探这个渠道' })).toBeNull();
    expect(screen.queryByRole('dialog')).toBeNull();
    expect(document.querySelector('[data-channel-drawer]')).toBeNull();
    expect(screen.queryByRole('button', { name: /返回渠道列表/ })).toBeNull();
    // 主区没有横向溢出（happy-dom 没有版面，量出来都是 0；真量宽度在 e2e）
    const main = (container.firstElementChild ?? container) as HTMLElement;
    expect(main.scrollWidth).toBeLessThanOrEqual(main.clientWidth);

    const row = document.querySelector('[data-channel="ch-grok"]') as HTMLElement | null;
    expect(row).toBeTruthy();
    fireEvent.click(within(row as HTMLElement).getByRole('button'));
    const drawer = await screen.findByRole('dialog');
    expect(drawer.hasAttribute('data-channel-drawer')).toBe(true);
    // 手机从底部出来，不是右侧窄条
    expect(drawer.className).toContain('inset-x-0');
    expect(within(drawer).getByRole('button', { name: '探这个渠道' })).toBeTruthy();
    expect(within(drawer).getByRole('list', { name: 'Grok 的路由' })).toBeTruthy();

    fireEvent.click(within(drawer).getByRole('button', { name: '关闭' }));
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
    expect(screen.getByRole('list', { name: '渠道状态' })).toBeTruthy();
  });

  test('带 ?p= 进来（路由页的「原文、立即探测」链接）：手机上直接开着那个渠道的抽屉', async () => {
    mockPhone();
    renderApp(<RoutingStatus />, { route: '/routing/status?p=ch-grok' });
    const drawer = await screen.findByRole('dialog');
    expect(within(drawer).getByRole('list', { name: 'Grok 的路由' })).toBeTruthy();
  });

  test('宽屏（lg 以上）：列表和详情并排，没有抽屉', async () => {
    renderApp(<RoutingStatus />, { route: '/routing/status' });
    await screen.findByRole('list', { name: '渠道状态' });
    await waitFor(() => expect(screen.getByRole('button', { name: '探这个渠道' })).toBeTruthy());
    expect(screen.queryByRole('dialog')).toBeNull();
  });
});

describe('路由页：不到 1024 宽每行的操作收进「⋯」菜单', () => {
  const opened = async () => {
    await screen.findByRole('navigation', { name: '用途' });
    await waitFor(() => expect(document.querySelector('li[data-route]')).not.toBeNull());
  };

  test('模型行：菜单里有关闭、上移、下移、置顶、置底、移出；行里不再有一排小按钮', async () => {
    mockPhone();
    renderApp(<RoutingPage />, { route: '/routing?purpose=execute' });
    await opened();
    const row = document.querySelector('li[data-model="opus-5.5"]') as HTMLElement;
    expect(within(row).queryByRole('switch')).toBeNull();
    expect(within(row).queryByRole('button', { name: /^上移 / })).toBeNull();
    expect(within(row).queryByRole('button', { name: /^把 .* 移出用途/ })).toBeNull();

    openMenu(within(row).getByRole('button', { name: /^更多操作：Opus 5.5/ }));
    const menu = await screen.findByRole('menu');
    const names = within(menu)
      .getAllByRole('menuitem')
      .map((el) => el.textContent);
    expect(names).toEqual(['关闭这个模型', '上移一位', '下移一位', '置顶', '置底', '移出动手']);
    // 菜单项够高：min-h-10（40px）
    for (const item of within(menu).getAllByRole('menuitem')) expect(classes(item)).toContain('min-h-10');
    // 排头的上移、置顶是灰的，写了原因
    const up = within(menu).getByRole('menuitem', { name: '上移一位' });
    expect(up.getAttribute('data-disabled')).not.toBeNull();
    expect(up.getAttribute('title')).toBe('已经在最前');
  });

  test('点「下移一位」走原来的 movePurposeModel，带看到的旧顺序', async () => {
    mockPhone();
    const api = createMockApi({ live: false });
    const spy = vi.spyOn(api, 'movePurposeModel');
    renderApp(<RoutingPage />, { route: '/routing?purpose=execute', api });
    await opened();
    const row = document.querySelector('li[data-model="opus-5.5"]') as HTMLElement;
    openMenu(within(row).getByRole('button', { name: /^更多操作：Opus 5.5/ }));
    fireEvent.click(await screen.findByRole('menuitem', { name: '下移一位' }));
    await waitFor(() => expect(spy).toHaveBeenCalledTimes(1));
    expect(spy).toHaveBeenCalledWith('execute', 'opus-5.5', {
      order: ['kimi-k3', 'opus-5.5', 'cursor-auto', 'opus-5'],
      expected: ['opus-5.5', 'kimi-k3', 'cursor-auto', 'opus-5'],
    });
  });

  test('点「上移一位」（第二行）同样走 movePurposeModel；点「关闭这个模型」先弹确认', async () => {
    mockPhone();
    const api = createMockApi({ live: false });
    const spy = vi.spyOn(api, 'movePurposeModel');
    renderApp(<RoutingPage />, { route: '/routing?purpose=execute', api });
    await opened();
    const row = document.querySelector('li[data-model="kimi-k3"]') as HTMLElement;
    openMenu(within(row).getByRole('button', { name: /^更多操作：Kimi k3/ }));
    fireEvent.click(await screen.findByRole('menuitem', { name: '上移一位' }));
    await waitFor(() => expect(spy).toHaveBeenCalledTimes(1));
    expect(spy.mock.calls[0]?.[2]).toMatchObject({ order: ['kimi-k3', 'opus-5.5', 'cursor-auto', 'opus-5'] });

    const again = document.querySelector('li[data-model="cursor-auto"]') as HTMLElement;
    openMenu(within(again).getByRole('button', { name: /^更多操作：Cursor Auto/ }));
    fireEvent.click(await screen.findByRole('menuitem', { name: /^(关闭|开启)这个模型$/ }));
    expect(await screen.findByRole('alertdialog')).toBeTruthy();
  });

  test('点「移出动手」弹确认，确认后走 removePurposeModel', async () => {
    mockPhone();
    const api = createMockApi({ live: false });
    const spy = vi.spyOn(api, 'removePurposeModel');
    renderApp(<RoutingPage />, { route: '/routing?purpose=execute', api });
    await opened();
    const row = document.querySelector('li[data-model="opus-5"]') as HTMLElement;
    openMenu(within(row).getByRole('button', { name: /^更多操作：Opus 5（/ }));
    fireEvent.click(await screen.findByRole('menuitem', { name: '移出动手' }));
    const dialog = await screen.findByRole('alertdialog');
    expect(spy).not.toHaveBeenCalled();
    fireEvent.click(within(dialog).getByRole('button', { name: '移出' }));
    await waitFor(() => expect(spy).toHaveBeenCalledTimes(1));
  });

  test('模型下的路由行：菜单里有开关、上移、下移，点「下移一位」走 updateModelRoute 的 reorder', async () => {
    mockPhone();
    const api = createMockApi({ live: false });
    const spy = vi.spyOn(api, 'updateModelRoute');
    renderApp(<RoutingPage />, { route: '/routing?purpose=execute', api });
    await opened();
    const item = document.querySelector('[data-route="r-ca-opus"]') as HTMLElement;
    expect(within(item).queryByRole('switch')).toBeNull();
    openMenu(within(item).getByRole('button', { name: /^更多操作：/ }));
    const menu = await screen.findByRole('menu');
    expect(
      within(menu)
        .getAllByRole('menuitem')
        .map((el) => el.textContent),
    ).toEqual(['关闭这条路由', '上移一位', '下移一位', '置顶', '置底']);
    fireEvent.click(within(menu).getByRole('menuitem', { name: '下移一位' }));
    await waitFor(() => expect(spy).toHaveBeenCalledTimes(1));
    expect(spy.mock.calls[0]?.[2]).toMatchObject({ op: 'reorder' });
  });

  test('宽屏不变：开关、上移、下移、置顶、置底、移出各自一个按钮，没有「⋯」', async () => {
    renderApp(<RoutingPage />, { route: '/routing?purpose=execute' });
    await opened();
    const row = document.querySelector('li[data-model="opus-5.5"]') as HTMLElement;
    expect(within(row).getByRole('switch')).toBeTruthy();
    expect(within(row).getByRole('button', { name: /^上移 / })).toBeTruthy();
    expect(within(row).getByRole('button', { name: /^把 .* 移出用途/ })).toBeTruthy();
    expect(within(row).queryByRole('button', { name: /^更多操作/ })).toBeNull();
  });
});

describe('页头和操作记录不撑出屏幕', () => {
  test('页头右边那一排：窄屏可以换行（max-w-full），不是 shrink-0 撑出屏幕；lg 起才不收缩（中间宽度整排掉到标题下面，不把标题挤成一列）', () => {
    renderApp(
      <Page title="路由" actions={<span>胶囊</span>}>
        内容
      </Page>,
    );
    const actions = screen.getByText('胶囊').parentElement;
    expect(classes(actions)).toContain('max-w-full');
    expect(classes(actions)).toContain('flex-wrap');
    expect(classes(actions)).not.toContain('shrink-0');
    expect(classes(actions)).toContain('lg:shrink-0');
  });

  test('操作记录里「之前 / 之后」的 pre 自动换行', async () => {
    const api = createMockApi({ live: false });
    renderApp(<AuditPage />, { route: '/audit', api });
    await waitFor(() => expect(document.querySelectorAll('details').length).toBeGreaterThan(0));
    const pres = Array.from(document.querySelectorAll('details pre'));
    expect(pres.length).toBeGreaterThan(0);
    for (const pre of pres) {
      expect(classes(pre)).toContain('whitespace-pre-wrap');
      expect(classes(pre)).toContain('break-words');
    }
  });
});
