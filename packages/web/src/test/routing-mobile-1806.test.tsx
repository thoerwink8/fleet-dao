// @vitest-environment happy-dom
// 路由、渠道状态两页在手机上的版面（#1806）：
// - 渠道状态：不到 lg（1024）只画列表，点一行从底部（手机）开详情抽屉，不再上下堆两栏。
// - 路由：每行的档位、上移、下移、置顶、置底、移出收进行尾一个「⋯」菜单，菜单项照旧走原来的接口；
//   #1914 起各宽度同一个样子，开关留在行里。
// - 页头右边那一排（状态胶囊、刷新）可以换行，不撑出屏幕；操作记录的 pre 自动换行。
// 真正的横向溢出（scrollWidth 大于 clientWidth）要有版面引擎才量得出：这里只能断言类名和 happy-dom 里量得出的 0；
// 真量宽度的在 e2e/specs/11-mobile-overflow.e2e.ts。
import { cleanup, fireEvent, screen, waitFor, within } from '@testing-library/react';
import { afterEach, describe, expect, test, vi } from 'vitest';
import { createMockApi } from '../api/mock/server';
import { Page } from '../components/layout/page';
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

  test('模型行：行里只有名字、状态、开关和「⋯」；菜单里有档位、上移、下移、置顶、置底、移出', async () => {
    mockPhone();
    renderApp(<RoutingPage />, { route: '/routing?purpose=execute' });
    await opened();
    const row = document.querySelector('li[data-model="opus-5.5"]') as HTMLElement;
    // 开关留在行里（#1914：各宽度同一个样子，开关是一行唯一的直接操作）；别的都不在行里
    expect(within(row).getByRole('switch', { name: 'Opus 5.5 的开关' })).toBeTruthy();
    expect(within(row).queryByRole('button', { name: /^上移 / })).toBeNull();
    expect(within(row).queryByRole('button', { name: /^把 .* 移出用途/ })).toBeNull();
    expect(within(row).queryByRole('combobox')).toBeNull();

    openMenu(within(row).getByRole('button', { name: /^更多操作：Opus 5.5/ }));
    const menu = await screen.findByRole('menu');
    const names = within(menu)
      .getAllByRole('menuitem')
      .map((el) => el.textContent);
    expect(names).toEqual(['上移一位', '下移一位', '置顶', '置底', '移出动手']);
    expect(within(menu).getAllByRole('menuitemradio')[0]?.textContent).toBe('不另配');
    // 菜单项够高：手机上 min-h-10（40px）
    for (const item of within(menu).getAllByRole('menuitem'))
      expect(classes(item)).toContain('max-md:min-h-10');
    for (const item of within(menu).getAllByRole('menuitemradio')) {
      expect(classes(item)).toContain('max-md:min-h-10');
    }
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

  test('点「上移一位」（第二行）同样走 movePurposeModel；点行里的模型开关先弹确认', async () => {
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

    await waitFor(() => expect(screen.queryByRole('menu')).toBeNull());
    const again = document.querySelector('li[data-model="cursor-auto"]') as HTMLElement;
    fireEvent.click(within(again).getByRole('switch', { name: 'Cursor Auto 的开关' }));
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

  test('模型下的路由行：开关在行里，菜单里有上移、下移、置顶、置底，点「下移一位」走 updateModelRoute 的 reorder', async () => {
    mockPhone();
    const api = createMockApi({ live: false });
    const spy = vi.spyOn(api, 'updateModelRoute');
    renderApp(<RoutingPage />, { route: '/routing?purpose=execute', api });
    await opened();
    // 默认只列开着的。没画出来的关着路由还在顺序里，这时不能调先后（点了不保存）。先显示全部。
    const showAll = await screen.findByRole('button', { name: '显示全部' });
    if (showAll.getAttribute('aria-pressed') !== 'true') fireEvent.click(showAll);
    const item = document.querySelector('[data-route="r-ca-opus"]') as HTMLElement;
    expect(within(item).getByRole('switch')).toBeTruthy();
    await waitFor(() => expect(item.querySelector('[data-row-menu]')).not.toBeNull());
    openMenu(within(item).getByRole('button', { name: /^更多操作：/ }));
    const menu = await screen.findByRole('menu');
    await waitFor(() =>
      expect(
        within(menu)
          .getAllByRole('menuitem')
          .map((el) => el.textContent),
      ).toEqual(['上移一位', '下移一位', '置顶', '置底']),
    );
    fireEvent.click(within(menu).getByRole('menuitem', { name: '下移一位' }));
    await waitFor(() => expect(spy).toHaveBeenCalledTimes(1));
    expect(spy.mock.calls[0]?.[2]).toMatchObject({ op: 'reorder' });
  });

  test('宽屏和手机同一个样子（#1914）：行里开关和「⋯」；「⋯」平时极淡占着位置、拖动柄平时藏着，悬停这一行才变实', async () => {
    renderApp(<RoutingPage />, { route: '/routing?purpose=execute' });
    await opened();
    const row = document.querySelector('li[data-model="opus-5.5"]') as HTMLElement;
    expect(within(row).getByRole('switch')).toBeTruthy();
    expect(within(row).queryByRole('button', { name: /^上移 / })).toBeNull();
    expect(within(row).queryByRole('button', { name: /^把 .* 移出用途/ })).toBeNull();
    const more = within(row).getByRole('button', { name: /^更多操作：Opus 5.5/ });
    const grip = within(row).getByRole('button', { name: /^拖动 / });
    // 「⋯」固定占位但极淡（右边不空一块，#1914 第 4 轮）；拖动柄浮在留白里，平时整个藏着
    expect(classes(more)).toEqual(
      expect.arrayContaining(['pointer-fine:opacity-40', 'pointer-fine:group-hover/row:opacity-100']),
    );
    expect(classes(grip)).toEqual(
      expect.arrayContaining(['pointer-fine:opacity-0', 'pointer-fine:group-hover/row:opacity-100']),
    );
    // 两行的行高取 row-tall（标准 48）
    expect(classes(row.querySelector('[data-row-frame]'))).toContain('min-h-row-tall');
    // 行框带 group/row，悬停才认得到这一行
    expect(classes(row.querySelector('[data-row-frame]'))).toContain('group/row');
  });

  test('路由行小字截断时不截掉「顺位第一条活的」：它排在小字最前面（#1916）', async () => {
    renderApp(<RoutingPage />, { route: '/routing?purpose=execute' });
    const meta = (await waitFor(() => {
      const el = document.querySelector('[data-route="r-ca-opus"] [data-route-meta]');
      if (!el) throw new Error('还没画路由行');
      return el;
    })) as HTMLElement;
    expect(classes(meta)).toEqual(expect.arrayContaining(['truncate', 'whitespace-nowrap']));
    expect(meta.firstElementChild?.textContent).toBe('顺位第一条活的');
    expect(meta.getAttribute('title')).toContain('顺位第一条活的');
  });

  test('用途标题块三行都不折（#1914 第 5 轮，创始人看 390 宽「变成 2 行了」）：结论短话截断、状态标签不收缩，灰字截断、整句在悬停', async () => {
    // 每个用途都看：首选活着、靠后备、不知道的结论都要放得进一行
    for (const purpose of ['execute', 'verify', 'judge', 'groom']) {
      cleanup();
      renderApp(<RoutingPage />, { route: `/routing?purpose=${purpose}` });
      const hero = (await waitFor(() => {
        const el = document.querySelector('[data-purpose-hero]');
        if (!el) throw new Error('标题块还没画');
        return el;
      })) as HTMLElement;
      expect(classes(hero.querySelector('h2'))).toContain('truncate');
      const line = hero.querySelector('[data-hero-line]') as HTMLElement;
      expect(classes(line)).toEqual(expect.arrayContaining(['whitespace-nowrap', 'min-w-0']));
      expect(classes(line)).not.toContain('flex-wrap');
      expect(classes(line.querySelector('[data-hero-text]'))).toEqual(
        expect.arrayContaining(['truncate', 'min-w-0']),
      );
      // 状态标签不让位：放不下时截断的是短话，不是标签掉到下一行
      expect(classes(line.querySelector('[data-status]')?.parentElement ?? null)).toContain('shrink-0');
      expect(
        line.getAttribute('title')?.startsWith(line.querySelector('[data-hero-text]')?.textContent ?? '?'),
      ).toBe(true);
      // 结论短话不再带括号里的路由名（那段挪到灰字行）
      expect(line.querySelector('[data-hero-text]')?.textContent).not.toContain('（');
      const notes = hero.querySelector('[data-hero-notes]');
      if (notes) {
        expect(classes(notes)).toContain('truncate');
        expect(notes.getAttribute('title')).toBe(notes.textContent);
      }
    }
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
    // #1940：改动明细改成点行尾展开钮才画（不再每行常驻一个 details）；先把有改动的行都展开，再量 pre
    // #3533：改成表格，行首的展开钮叫「展开」，原始数据是折叠（Collapse）里的 Text mono pre
    const expands = await screen.findAllByRole('button', { name: '展开' });
    for (const b of expands) fireEvent.click(b);
    await waitFor(() =>
      expect(document.querySelectorAll('[data-audit-detail] [aria-hidden]').length).toBeGreaterThan(0),
    );
    const pres = Array.from(document.querySelectorAll('[data-audit-detail] .font-mono.whitespace-pre-wrap'));
    expect(pres.length).toBeGreaterThan(0);
    for (const pre of pres) {
      expect(classes(pre)).toContain('whitespace-pre-wrap');
      expect(classes(pre)).toContain('break-words');
    }
  });
});
