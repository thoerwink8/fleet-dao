// @vitest-environment happy-dom
// 路由页分块和长列表（#1366 第二部分）：「用途 / 模型目录 / 渠道」一次只显示一块；每块有搜索框和「只看已开启」；
// 行数超过 50 只画窗口里的行（造 300 行验）；拖到容器边缘时容器自动滚；Fable 的开关遵守决定 0033（页面只标，判在后端）。
import { cleanup, fireEvent, screen, waitFor, within } from '@testing-library/react';
import { afterEach, describe, expect, test, vi } from 'vitest';
import { createMockApi, type MockApi } from '../api/mock/server';
import type { RoutingLayerModel, RoutingLayerRoute, RoutingLayers } from '../api/types';
import RoutingPage from '../routes/routing';
import { renderApp } from './harness';

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

const fact = (verdict: 'live' | 'dead' | 'unknown', reason: string) => ({ verdict, reason });

function layerRoute(id: string, enabled: boolean): RoutingLayerRoute {
  return {
    routeId: id,
    channelId: 'ch-claude',
    channelName: 'Claude 订阅',
    poolId: 'claude-a',
    hostId: 'claude-code',
    enabled,
    verdict: 'live',
    connect: fact('live', '探针探通了'),
    quota: fact('live', '额度读数新、窗口有余'),
    ban: fact('live', '没有禁令、开关开着'),
    exhausted: [],
    inFlight: 0,
    reserved: 0,
    maxConcurrency: 2,
  };
}

/** n 个模型、每个一条路由；每第三个开着（n=300 时 100 个开着）。 */
function manyModels(n: number): RoutingLayerModel[] {
  return Array.from({ length: n }, (_, i) => {
    const pad = String(i).padStart(3, '0');
    return {
      modelId: `m-${pad}`,
      displayName: `Model ${pad}`,
      family: 'claude',
      verdict: 'live' as const,
      routes: [layerRoute(`r-${pad}`, i % 3 === 0)],
    };
  });
}

function withModels(n: number): MockApi {
  const layers: RoutingLayers = {
    asOf: new Date().toISOString(),
    purposes: [{ purpose: 'execute', version: 0, verdict: 'live', problems: [], models: manyModels(n) }],
  };
  const api = createMockApi({ live: false });
  return Object.assign(api, { routingLayers: async () => layers });
}

const rows = (selector: string) => Array.from(document.querySelectorAll(selector));
const rowIds = (selector: string, attr: string) => rows(selector).map((el) => el.getAttribute(attr));

describe('路由页分块：一次只显示一块', () => {
  test('默认是「用途」；点「模型目录」「渠道」换块，另外两块不在页面上；方向键在页签间走', async () => {
    renderApp(<RoutingPage />, { route: '/routing' });
    await screen.findByRole('navigation', { name: '用途' });
    const tabs = screen.getAllByRole('tab');
    expect(tabs.map((t) => t.textContent)).toEqual(['用途', '模型目录', '渠道']);
    expect(screen.getByRole('tab', { name: '用途' }).getAttribute('aria-selected')).toBe('true');
    expect(screen.queryByRole('list', { name: '目录里的模型' })).toBeNull();
    expect(screen.queryByRole('list', { name: '渠道列表' })).toBeNull();

    fireEvent.click(screen.getByRole('tab', { name: '模型目录' }));
    expect(await screen.findByRole('list', { name: '目录里的模型' })).toBeTruthy();
    expect(screen.getByRole('tab', { name: '模型目录' }).getAttribute('aria-selected')).toBe('true');
    expect(screen.queryByRole('navigation', { name: '用途' })).toBeNull();
    expect(screen.queryByRole('list', { name: '渠道列表' })).toBeNull();

    fireEvent.keyDown(screen.getByRole('tab', { name: '模型目录' }), { key: 'ArrowRight' });
    expect(await screen.findByRole('list', { name: '渠道列表' })).toBeTruthy();
    expect(screen.getByRole('tab', { name: '渠道' }).getAttribute('aria-selected')).toBe('true');
    expect(screen.queryByRole('list', { name: '目录里的模型' })).toBeNull();

    fireEvent.click(screen.getByRole('tab', { name: '用途' }));
    expect(await screen.findByRole('navigation', { name: '用途' })).toBeTruthy();
  });

  test('网址里的 ?tab= 决定进来看哪一块；写错了当「用途」', async () => {
    renderApp(<RoutingPage />, { route: '/routing?tab=channels' });
    expect(await screen.findByRole('list', { name: '渠道列表' })).toBeTruthy();
    cleanup();
    renderApp(<RoutingPage />, { route: '/routing?tab=nope' });
    expect(await screen.findByRole('navigation', { name: '用途' })).toBeTruthy();
  });
});

describe('模型目录：搜索、只看已开启、窗口化（300 个模型）', () => {
  test('只画窗口里的行，不是 300 行；总数写在筛选条上', async () => {
    renderApp(<RoutingPage />, { route: '/routing?tab=models', api: withModels(300) });
    await screen.findByRole('list', { name: '目录里的模型' });
    const drawn = rows('li[data-catalog]');
    expect(drawn.length).toBeGreaterThan(5);
    expect(drawn.length).toBeLessThan(30);
    // 300 个配进用途的，加上目录里没配进用途的
    expect(screen.getByText(/^共 3\d\d 个$/)).toBeTruthy();
    expect(drawn[0]?.getAttribute('data-catalog')).toBe('m-000');
  });

  test('滚下去窗口跟着走：画出靠后的行，靠前的卸掉', async () => {
    renderApp(<RoutingPage />, { route: '/routing?tab=models', api: withModels(300) });
    const list = await screen.findByRole('list', { name: '目录里的模型' });
    const box = list.parentElement as HTMLElement;
    expect(box.getAttribute('data-windowed')).toBe('true');
    fireEvent.scroll(box, { target: { scrollTop: 44 * 200 } });
    await waitFor(() => expect(rowIds('li[data-catalog]', 'data-catalog')).toContain('m-200'));
    expect(rowIds('li[data-catalog]', 'data-catalog')).not.toContain('m-000');
    expect(rows('li[data-catalog]').length).toBeLessThan(30);
  });

  test('搜索：只剩对得上的行，筛选条写「显示 N / 共 M 个」；搜不到写没有符合的', async () => {
    renderApp(<RoutingPage />, { route: '/routing?tab=models', api: withModels(300) });
    await screen.findByRole('list', { name: '目录里的模型' });
    fireEvent.change(screen.getByRole('searchbox', { name: '搜索模型' }), { target: { value: 'model 042' } });
    await waitFor(() => expect(rowIds('li[data-catalog]', 'data-catalog')).toEqual(['m-042']));
    expect(screen.getByText(/^显示 1 \/ 共 3\d\d 个$/)).toBeTruthy();
    fireEvent.change(screen.getByRole('searchbox', { name: '搜索模型' }), { target: { value: 'zzz-没有' } });
    expect(await screen.findByText('没有符合的模型：换个搜索词，或关掉「只看已开启」')).toBeTruthy();
    expect(rows('li[data-catalog]')).toHaveLength(0);
  });

  test('只看已开启：关着的和读不到开关的都不要；和搜索一起用', async () => {
    renderApp(<RoutingPage />, { route: '/routing?tab=models', api: withModels(300) });
    await screen.findByRole('list', { name: '目录里的模型' });
    const only = screen.getByRole('button', { name: '只看已开启' });
    expect(only.getAttribute('aria-pressed')).toBe('false');
    fireEvent.click(only);
    expect(only.getAttribute('aria-pressed')).toBe('true');
    // 每第三个开着：m-000、m-003 ……共 100 个
    await waitFor(() => expect(screen.getByText(/^显示 100 \/ 共 3\d\d 个$/)).toBeTruthy());
    const ids = rowIds('li[data-catalog]', 'data-catalog');
    expect(ids[0]).toBe('m-000');
    expect(ids[1]).toBe('m-003');
    for (const row of rows('li[data-catalog]')) {
      expect(
        within(row as HTMLElement)
          .getByRole('switch')
          .getAttribute('aria-checked'),
      ).toBe('true');
    }
    fireEvent.change(screen.getByRole('searchbox', { name: '搜索模型' }), { target: { value: 'model 01' } });
    // 搜索词按「每个词都要在名字或编号里出现」算：名字里有 01 的开着的是 012、015、018、201（Model 201）
    await waitFor(() =>
      expect(rowIds('li[data-catalog]', 'data-catalog')).toEqual(['m-012', 'm-015', 'm-018', 'm-201']),
    );
  });

  test('点一行，右边看它的路由；每个模型行有开关，点开关先弹确认，确认了才写', async () => {
    const { api } = renderApp(<RoutingPage />, { route: '/routing?tab=models' });
    const spy = vi.spyOn(api, 'setModelEnabled');
    await screen.findByRole('list', { name: '目录里的模型' });
    fireEvent.click(await screen.findByRole('button', { name: '查看 Kimi k3 的路由' }));
    expect(await screen.findByRole('list', { name: 'Kimi k3 的路由' })).toBeTruthy();
    const row = document.querySelector('li[data-catalog="kimi-k3"]') as HTMLElement;
    fireEvent.click(within(row).getByRole('switch', { name: 'Kimi k3 的开关' }));
    const dialog = await screen.findByRole('alertdialog');
    expect(dialog.textContent).toContain('模型「Kimi k3」');
    expect(spy).not.toHaveBeenCalled();
    fireEvent.click(within(dialog).getByRole('button', { name: /^(关闭|开启)$/ }));
    await waitFor(() => expect(spy).toHaveBeenCalledTimes(1));
  });

  test('没配进任何用途的模型也列出来，开关置灰并写原因，不画成开或关；Fable 标「仅创始人可开」', async () => {
    renderApp(<RoutingPage />, { route: '/routing?tab=models' });
    await screen.findByRole('list', { name: '目录里的模型' });
    const fable = (await waitFor(() => {
      const el = document.querySelector('li[data-catalog="fable-5.1"]');
      if (!el) throw new Error('目录里还没有 Fable');
      return el;
    })) as HTMLElement;
    expect(fable.textContent).toContain('仅创始人可开');
    const sw = within(fable).getByRole('switch', { name: 'Fable 5.1 的开关' }) as HTMLButtonElement;
    expect(sw.disabled).toBe(true);
    expect(sw.getAttribute('title')).toContain('还没配进任何用途');
    fireEvent.click(within(fable).getByRole('button', { name: '查看 Fable 5.1 的路由' }));
    expect((await screen.findByRole('note')).textContent).toContain('还没配进任何用途');
  });
});

describe('渠道：搜索、只看已开启', () => {
  test('搜索只剩对得上的渠道；搜不到写没有符合的', async () => {
    renderApp(<RoutingPage />, { route: '/routing?tab=channels' });
    await screen.findByRole('list', { name: '渠道列表' });
    expect(rows('li[data-channel]')).toHaveLength(5);
    fireEvent.change(screen.getByRole('searchbox', { name: '搜索渠道' }), { target: { value: 'cursor' } });
    await waitFor(() => expect(rowIds('li[data-channel]', 'data-channel')).toEqual(['ch-cursor']));
    fireEvent.change(screen.getByRole('searchbox', { name: '搜索渠道' }), { target: { value: '没有这个' } });
    expect(await screen.findByText('没有符合的渠道：换个搜索词，或关掉「只看已开启」')).toBeTruthy();
  });

  test('只看已开启：关掉一个渠道后它从列表里消失，打开筛选前还在', async () => {
    const { api } = renderApp(<RoutingPage />, { route: '/routing?tab=channels' });
    await screen.findByRole('list', { name: '渠道列表' });
    fireEvent.click(screen.getByRole('switch', { name: 'DeepSeek 接口 的开关' }));
    fireEvent.click(within(await screen.findByRole('alertdialog')).getByRole('button', { name: '关闭' }));
    await waitFor(() =>
      expect(screen.getByRole('switch', { name: 'DeepSeek 接口 的开关' }).getAttribute('aria-checked')).toBe(
        'false',
      ),
    );
    expect(rows('li[data-channel]')).toHaveLength(5);
    fireEvent.click(screen.getByRole('button', { name: '只看已开启' }));
    await waitFor(() => expect(rows('li[data-channel]')).toHaveLength(4));
    expect(rowIds('li[data-channel]', 'data-channel')).not.toContain('ch-ds');
    expect((await api.routing()).channels.find((c) => c.id === 'ch-ds')?.enabled).toBe(false);
  });
});

describe('用途里的模型清单：超过 50 个才出搜索和只看已开启，只画窗口里的行', () => {
  test('300 个模型：出搜索框，只画窗口里的行；不到 50 个的用途没有搜索框', async () => {
    renderApp(<RoutingPage />, { route: '/routing?purpose=execute', api: withModels(300) });
    await screen.findByRole('list', { name: '模型' });
    expect(screen.getByRole('searchbox', { name: '搜索模型' })).toBeTruthy();
    const drawn = rows('li[data-model]');
    expect(drawn.length).toBeGreaterThan(5);
    expect(drawn.length).toBeLessThan(30);
    expect(rowIds('li[data-model]', 'data-model')[0]).toBe('m-000');
    expect(drawn[0]?.getAttribute('aria-setsize')).toBe('300');
    cleanup();
    renderApp(<RoutingPage />, { route: '/routing?purpose=execute', api: withModels(40) });
    await screen.findByRole('list', { name: '模型' });
    expect(screen.queryByRole('searchbox', { name: '搜索模型' })).toBeNull();
    expect(rows('li[data-model]')).toHaveLength(40);
  });

  test('滚到底画出最后一个模型，第一个卸掉', async () => {
    renderApp(<RoutingPage />, { route: '/routing?purpose=execute', api: withModels(300) });
    const list = await screen.findByRole('list', { name: '模型' });
    fireEvent.scroll(list.parentElement as HTMLElement, { target: { scrollTop: 44 * 300 } });
    await waitFor(() => expect(rowIds('li[data-model]', 'data-model')).toContain('m-299'));
    expect(rowIds('li[data-model]', 'data-model')).not.toContain('m-000');
  });

  test('搜索和只看已开启在用途里也能用；筛选时只显示了一部分，先后点不动并写原因', async () => {
    renderApp(<RoutingPage />, { route: '/routing?purpose=execute', api: withModels(300) });
    await screen.findByRole('list', { name: '模型' });
    fireEvent.click(screen.getByRole('button', { name: '只看已开启' }));
    await waitFor(() => expect(screen.getByText('显示 100 / 共 300 个')).toBeTruthy());
    fireEvent.change(screen.getByRole('searchbox', { name: '搜索模型' }), { target: { value: 'model 03' } });
    // 名字里有 03 的开着的：003、030、033、036、039
    await waitFor(() =>
      expect(rowIds('li[data-model]', 'data-model')).toEqual(['m-003', 'm-030', 'm-033', 'm-036', 'm-039']),
    );
    const grip = within(document.querySelector('li[data-model="m-033"]') as HTMLElement).getByRole('button', {
      name: /^拖动 /,
    }) as HTMLButtonElement;
    expect(grip.disabled).toBe(true);
    expect(grip.getAttribute('title')).toContain('正在筛选');
    // 清掉筛选，又能调
    fireEvent.change(screen.getByRole('searchbox', { name: '搜索模型' }), { target: { value: '' } });
    fireEvent.click(screen.getByRole('button', { name: '只看已开启' }));
    await waitFor(() => expect(screen.getByText('共 300 个')).toBeTruthy());
    const back = within(document.querySelector('li[data-model="m-001"]') as HTMLElement).getByRole('button', {
      name: /^拖动 /,
    }) as HTMLButtonElement;
    expect(back.disabled).toBe(false);
  });
});

describe('拖到容器边缘时自动滚', () => {
  /** 手动推进的 requestAnimationFrame：一次 flush 跑掉排着的所有帧（它们又排下一帧）。 */
  function frames() {
    const queue = new Map<number, FrameRequestCallback>();
    let next = 0;
    vi.stubGlobal('requestAnimationFrame', (cb: FrameRequestCallback) => {
      next += 1;
      queue.set(next, cb);
      return next;
    });
    vi.stubGlobal('cancelAnimationFrame', (id: number) => queue.delete(id));
    return {
      pending: () => queue.size,
      flush(times = 1) {
        for (let i = 0; i < times; i++) {
          const batch = [...queue.values()];
          queue.clear();
          for (const cb of batch) cb(0);
        }
      },
    };
  }

  function boxAt(top: number, bottom: number) {
    vi.spyOn(HTMLElement.prototype, 'getBoundingClientRect').mockImplementation(function (this: HTMLElement) {
      const box = this.hasAttribute('data-sortable-box');
      const t = box ? top : 0;
      const b = box ? bottom : 0;
      return {
        top: t,
        bottom: b,
        left: 0,
        right: 800,
        width: 800,
        height: b - t,
        x: 0,
        y: t,
        toJSON: () => ({}),
      };
    });
  }

  async function ready() {
    const { container } = renderApp(<RoutingPage />, {
      route: '/routing?purpose=execute',
      api: withModels(300),
    });
    const list = await screen.findByRole('list', { name: '模型' });
    const box = list.parentElement as HTMLElement;
    // happy-dom 把 window.DragEvent 设成普通 Event，构造时丢掉 clientY。换成带坐标的鼠标事件再拖。
    const view = container.ownerDocument.defaultView;
    if (view && (view.DragEvent as unknown) === view.Event) {
      view.DragEvent = class extends view.MouseEvent {} as unknown as typeof view.DragEvent;
    }
    const grip = within(document.querySelector('li[data-model="m-001"]') as HTMLElement).getByRole('button', {
      name: /^拖动 /,
    });
    return { box, grip, row: document.querySelector('li[data-model="m-001"]') as HTMLElement };
  }

  test('指针在下沿附近：容器往下滚；回到中间不滚；到上沿附近往上滚；放下后不再滚', async () => {
    const raf = frames();
    boxAt(100, 540);
    const { box, grip, row } = await ready();
    expect(box.scrollTop).toBe(0);

    fireEvent.dragStart(grip);
    expect(raf.pending()).toBe(1);
    fireEvent.dragOver(row, { clientY: 535 });
    raf.flush(3);
    const down = box.scrollTop;
    expect(down).toBeGreaterThan(30);
    // 滚动之后窗口跟着走，画出靠后的行
    expect(rows('li[data-model]').length).toBeLessThan(40);

    fireEvent.dragOver(row, { clientY: 320 });
    raf.flush(3);
    expect(box.scrollTop).toBe(down);

    fireEvent.dragOver(row, { clientY: 105 });
    raf.flush(2);
    expect(box.scrollTop).toBeLessThan(down);

    const before = box.scrollTop;
    fireEvent.dragEnd(grip);
    fireEvent.dragOver(row, { clientY: 535 });
    raf.flush(3);
    expect(box.scrollTop).toBe(before);
    expect(raf.pending()).toBe(0);
  });

  test('正在拖的那行滚出窗口也不卸载', async () => {
    const raf = frames();
    boxAt(100, 540);
    const { box, grip, row } = await ready();
    fireEvent.dragStart(grip);
    fireEvent.dragOver(row, { clientY: 540 });
    raf.flush(40);
    expect(box.scrollTop).toBeGreaterThan(44 * 20);
    expect(rowIds('li[data-model]', 'data-model')).toContain('m-001');
    fireEvent.dragEnd(grip);
  });
});

const classTokens = (el: Element) => (el.getAttribute('class') ?? '').split(/\s+/).filter(Boolean);

function expectTap(el: Element) {
  const tokens = classTokens(el);
  expect(tokens).toContain('min-h-9');
  expect(tokens).toContain('min-w-9');
}

/** 记下没被 mock 之前的 matchMedia。反复 mock 时不能再 bind 已经套上的 spy，否则非手机查询会递归。 */
const realMatchMedia = window.matchMedia.bind(window);

/** Tailwind 的 md 是 768px；手机宽度按 max-width: 767px。 */
function mockMobile() {
  vi.spyOn(window, 'matchMedia').mockImplementation((query: string) => {
    if (query === '(max-width: 767px)') {
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
    return realMatchMedia(query);
  });
}

describe('路由页手机宽度：行布局、热区、筛选、标记', () => {
  test('用途里的模型行：名字可换行，操作在下一行', async () => {
    renderApp(<RoutingPage />, { route: '/routing?purpose=execute' });
    await screen.findByRole('list', { name: '模型' });
    const row = document.querySelector('li[data-model="opus-5.5"]') as HTMLElement;
    const shell = row.firstElementChild as HTMLElement;
    expect(classTokens(shell)).toEqual(expect.arrayContaining(['flex-col', 'md:flex-row']));
    const name = row.querySelector('[data-row-name]') as HTMLElement;
    expect(name.textContent).toBe('Opus 5.5');
    expect(classTokens(name)).toContain('break-words');
    expect(classTokens(name)).not.toContain('truncate');
    const actions = row.querySelector('[data-row-actions]') as HTMLElement;
    expect(name.compareDocumentPosition(actions) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    expectTap(within(row).getByRole('button', { name: /^拖动 / }));
    expectTap(within(row).getByRole('button', { name: /^置顶 / }));
    expectTap(within(row).getByRole('button', { name: /^置底 / }));
    // 开关是小滑块，不撑成圆：可点的范围用伪元素往外扩
    expect(classTokens(within(row).getByRole('switch'))).toEqual(
      expect.arrayContaining(['relative', 'after:absolute', 'after:-inset-y-3']),
    );
    expectTap(within(row).getByRole('button', { name: /^上移 / }));
    expectTap(within(row).getByRole('button', { name: /^下移 / }));
    expectTap(within(row).getByRole('combobox'));
    expectTap(within(row).getByRole('button', { name: /移出用途/ }));
    const [pause] = await screen.findAllByRole('button', { name: /暂停账号池/ });
    expectTap(pause as HTMLElement);
  });

  test('手机宽度定高行加高，装得下两行', async () => {
    mockMobile();
    renderApp(<RoutingPage />, { route: '/routing?purpose=execute', api: withModels(60) });
    await screen.findByRole('list', { name: '模型' });
    const model = document.querySelector('li[data-model]') as HTMLElement;
    expect(model.style.height).toBe('80px');
    cleanup();
    mockMobile();
    renderApp(<RoutingPage />, { route: '/routing?tab=models', api: withModels(60) });
    await screen.findByRole('list', { name: '目录里的模型' });
    const catalog = document.querySelector('li[data-catalog]') as HTMLElement;
    expect(catalog.style.height).toBe('80px');
    cleanup();
    mockMobile();
    renderApp(<RoutingPage />, { route: '/routing?tab=channels' });
    await screen.findByRole('list', { name: '渠道列表' });
    const channel = document.querySelector('li[data-channel]') as HTMLElement;
    expect(channel.style.height).toBe('80px');
  });

  test('模型目录和渠道的第二行写出厂家、状态词、几条路几条活，不用 hidden 藏', async () => {
    renderApp(<RoutingPage />, { route: '/routing?tab=models' });
    await screen.findByRole('list', { name: '目录里的模型' });
    const grok = document.querySelector('li[data-catalog="grok-4.7"]') as HTMLElement;
    const shell = grok.firstElementChild as HTMLElement;
    expect(classTokens(shell)).toEqual(expect.arrayContaining(['flex-col', 'md:flex-row']));
    const vendor = grok.querySelector('[data-vendor]') as HTMLElement;
    const status = grok.querySelector('[data-status-word]') as HTMLElement;
    const summary = grok.querySelector('[data-route-summary]') as HTMLElement;
    expect(vendor.textContent).toBe('grok');
    expect(status.textContent).toMatch(/在线|故障|已关|已下架|暂时挡着|不知道|未探|池暂停|未被用途使用/);
    expect(summary.textContent).toMatch(/\d+ 条路，\d+ 条活/);
    for (const el of [vendor, status, summary]) {
      expect(classTokens(el)).not.toContain('hidden');
    }
    expect(grok.querySelector('[data-row-meta]')).toBeTruthy();

    cleanup();
    renderApp(<RoutingPage />, { route: '/routing?tab=channels' });
    await screen.findByRole('list', { name: '渠道列表' });
    const channel = document.querySelector('li[data-channel="ch-claude"]') as HTMLElement;
    expect(classTokens(channel.firstElementChild as HTMLElement)).toEqual(
      expect.arrayContaining(['flex-col', 'md:flex-row']),
    );
    const channelStatus = channel.querySelector('[data-status-word]') as HTMLElement;
    const channelSummary = channel.querySelector('[data-route-summary]') as HTMLElement;
    expect(channelStatus.textContent?.trim()).not.toBe('');
    expect(channelSummary.textContent).toMatch(/\d+ 条路，\d+ 条活/);
    expect(classTokens(channelStatus)).not.toContain('hidden');
    expect(classTokens(channelSummary)).not.toContain('hidden');
  });

  test('手机宽度点一行，详情滚进画面', async () => {
    mockMobile();
    renderApp(<RoutingPage />, { route: '/routing?tab=models' });
    await screen.findByRole('list', { name: '目录里的模型' });
    const catalogDetail = document.getElementById('routing-catalog-detail');
    expect(catalogDetail).toBeTruthy();
    const catalogScroll = vi.spyOn(catalogDetail as HTMLElement, 'scrollIntoView');
    fireEvent.click(screen.getByRole('button', { name: '查看 Kimi k3 的路由' }));
    expect(catalogScroll).toHaveBeenCalled();
    cleanup();

    mockMobile();
    renderApp(<RoutingPage />, { route: '/routing?tab=channels' });
    await screen.findByRole('list', { name: '渠道列表' });
    const channelDetail = document.getElementById('routing-channel-detail');
    expect(channelDetail).toBeTruthy();
    const channelScroll = vi.spyOn(channelDetail as HTMLElement, 'scrollIntoView');
    fireEvent.click(screen.getByRole('button', { name: '查看 Claude 订阅 的路由' }));
    expect(channelScroll).toHaveBeenCalled();
    cleanup();

    mockMobile();
    renderApp(<RoutingPage />, { route: '/routing?purpose=execute' });
    await screen.findByRole('list', { name: '模型' });
    const modelDetail = document.getElementById('routing-model-detail');
    expect(modelDetail).toBeTruthy();
    const modelScroll = vi.spyOn(modelDetail as HTMLElement, 'scrollIntoView');
    fireEvent.click(screen.getByRole('button', { name: '查看 Kimi k3 的路由' }));
    expect(modelScroll).toHaveBeenCalled();
  });

  test('筛选按下态、厂家选中态分得开，清除筛选回到全部', async () => {
    renderApp(<RoutingPage />, { route: '/routing?tab=models' });
    await screen.findByRole('list', { name: '目录里的模型' });
    const only = screen.getByRole('button', { name: '只看已开启' });
    const idleOnly = only.className;
    expect(only.getAttribute('aria-pressed')).toBe('false');
    fireEvent.click(only);
    expect(only.getAttribute('aria-pressed')).toBe('true');
    expect(only.className).not.toBe(idleOnly);
    expect(only.className).toContain('border-foreground');
    expect(only.className).toContain('bg-foreground/10');
    expect(idleOnly).not.toContain('bg-foreground/10');

    const discovered = screen.getByRole('button', { name: '新发现' });
    const idleDiscovered = discovered.className;
    fireEvent.click(discovered);
    expect(discovered.getAttribute('aria-pressed')).toBe('true');
    expect(discovered.className).not.toBe(idleDiscovered);
    expect(discovered.className).toContain('bg-foreground/10');
    expect(discovered.className).toContain('border-foreground');

    fireEvent.click(screen.getByRole('button', { name: '清除筛选' }));
    expect(only.getAttribute('aria-pressed')).toBe('false');
    expect(discovered.getAttribute('aria-pressed')).toBe('false');

    const vendor = screen.getByRole('combobox', { name: '按厂家筛选' }) as HTMLSelectElement;
    const idleVendor = vendor.className;
    fireEvent.change(vendor, { target: { value: 'grok' } });
    expect(vendor.className).not.toBe(idleVendor);
    expect(vendor.className).toContain('border-foreground');
    expect(vendor.className).toContain('bg-foreground/10');
    await waitFor(() => expect(screen.getByText(/^显示 1 \/ 共/)).toBeTruthy());

    fireEvent.click(screen.getByRole('button', { name: '清除筛选' }));
    await waitFor(() => expect(screen.getByText(/^共 \d+ 个$/)).toBeTruthy());
    expect(vendor.value).toBe('');
    expect(vendor.className).not.toContain('bg-foreground/10');
  });

  test('顶部说明折成一行「怎么用」，点开才展开（手机和桌面一样）', async () => {
    mockMobile();
    renderApp(<RoutingPage />, { route: '/routing' });
    await screen.findByRole('navigation', { name: '用途' });
    expect(screen.queryByText(/每个用途按顺序排哪些模型/)).toBeNull();
    const toggle = screen.getByRole('button', { name: '怎么用' });
    expect(toggle.getAttribute('aria-expanded')).toBe('false');
    fireEvent.click(toggle);
    expect(toggle.getAttribute('aria-expanded')).toBe('true');
    expect(screen.getByText(/每个用途按顺序排哪些模型/)).toBeTruthy();

    // 桌面也折起来：调整顺序的区域要占满页面主体高度，首屏留给顺序，不留给说明
    cleanup();
    vi.restoreAllMocks();
    renderApp(<RoutingPage />, { route: '/routing' });
    await screen.findByRole('navigation', { name: '用途' });
    expect(screen.queryByText(/每个用途按顺序排哪些模型/)).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: '怎么用' }));
    expect(screen.getByText(/每个用途按顺序排哪些模型/)).toBeTruthy();
  });

  test('手机宽度模型目录去掉内部定高滚动，行随页面滚；桌面仍是 440 高的窗口', async () => {
    mockMobile();
    renderApp(<RoutingPage />, { route: '/routing?tab=models', api: withModels(300) });
    const list = await screen.findByRole('list', { name: '目录里的模型' });
    const box = list.parentElement as HTMLElement;
    expect(classTokens(box)).toEqual(
      expect.arrayContaining(['h-auto', 'overflow-visible', 'md:h-routing-window', 'md:overflow-y-auto']),
    );
    expect(classTokens(box)).not.toContain('overflow-y-auto');
    expect(box.style.height).toBe('');
    expect(box.getAttribute('data-windowed')).toBeNull();
    expect(rows('li[data-catalog]').length).toBeGreaterThan(50);

    cleanup();
    vi.restoreAllMocks();
    renderApp(<RoutingPage />, { route: '/routing?tab=models', api: withModels(300) });
    const desktop = await screen.findByRole('list', { name: '目录里的模型' });
    const desktopBox = desktop.parentElement as HTMLElement;
    expect(desktopBox.getAttribute('data-windowed')).toBe('true');
    expect(desktopBox.style.height).toBe('440px');
    expect(classTokens(desktopBox)).toContain('overflow-y-auto');
    expect(rows('li[data-catalog]').length).toBeLessThan(30);
  });

  test('新发现、已下架、锁住三种标记颜色互不相同', async () => {
    const api = createMockApi({ live: false });
    const routing = api.routing.bind(api);
    api.routing = async () => {
      const base = await routing();
      const sample = base.routes[0];
      if (!sample) throw new Error('目录里没有路由');
      return {
        ...base,
        routes: [...base.routes, { ...sample, id: 'auto:ch-claude:extra', modelId: 'sonnet-5' }],
      };
    };
    renderApp(<RoutingPage />, { route: '/routing?tab=models', api });
    await screen.findByRole('list', { name: '目录里的模型' });
    const mark = (id: string, label: string) => {
      const row = document.querySelector(`li[data-catalog="${id}"]`);
      const el = [...(row?.querySelectorAll('[data-catalog-mark]') ?? [])].find(
        (node) => node.textContent === label,
      );
      if (!el) throw new Error(`没有标记 ${label}（${id}）`);
      return el.getAttribute('class') ?? '';
    };
    const discovered = await waitFor(() => mark('sonnet-5', '新发现'));
    const retired = mark('opus-5', '已下架');
    const locked = mark('gpt-5.6-luna', '锁住');
    expect(discovered).toMatch(/text-ink-done|text-ink-run/);
    expect(retired).toContain('text-ink-stop');
    expect(locked).toContain('text-ink-stall');
    expect(new Set([discovered, retired, locked]).size).toBe(3);
  });
});

describe('调整顺序：关着的行置灰写「已跳过」，实际顺位只数开着的', () => {
  function withSkipped(models: RoutingLayerModel[]): MockApi {
    const layers: RoutingLayers = {
      asOf: new Date().toISOString(),
      purposes: [{ purpose: 'execute', version: 0, verdict: 'live', problems: [], models }],
    };
    const api = createMockApi({ live: false });
    return Object.assign(api, { routingLayers: async () => layers });
  }

  const slotOf = (modelId: string) =>
    document.querySelector(`li[data-model="${modelId}"] [data-slot-state]`) as HTMLElement;

  test('开着的写实际第几位（跳过关着的），关着的写「关着，已跳过」，没有路由的写「没有可用路由，已跳过」', async () => {
    // manyModels：每第三个开着（m-000、m-003 开着）；再加一个没有路由的
    const models = [
      ...manyModels(6),
      { modelId: 'm-empty', displayName: 'Empty', verdict: 'dead' as const, routes: [] },
    ];
    renderApp(<RoutingPage />, { route: '/routing?purpose=execute', api: withSkipped(models) });
    await screen.findByRole('list', { name: '模型' });
    expect(slotOf('m-000').textContent).toBe('实际第 1 位');
    expect(slotOf('m-001').textContent).toBe('关着，已跳过');
    expect(slotOf('m-002').textContent).toBe('关着，已跳过');
    // 配置里排第 4，前面两个关着，实际第 2 位
    expect(slotOf('m-003').textContent).toBe('实际第 2 位');
    expect(slotOf('m-004').getAttribute('data-slot-state')).toBe('off');
    expect(slotOf('m-empty').textContent).toBe('没有可用路由，已跳过');
    // 配置序号照旧写着
    expect(document.querySelector('li[data-model="m-003"] [data-position]')?.textContent).toBe('4');
    // 关着的名字置灰
    const greyed = document.querySelector('li[data-model="m-001"] button[aria-pressed]') as Element;
    expect(classTokens(greyed)).toContain('opacity-60');
    const summary = document.querySelector('[data-order-summary="ok"]')?.textContent;
    expect(summary).toContain('开着的 2 个模型');
    expect(summary).toContain('跳过 5 个');
  });

  test('故意造出失败：一个模型都不能派时，不写顺位，写「无可用」', async () => {
    const off = manyModels(3).map((m) => ({ ...m, routes: m.routes.map((r) => ({ ...r, enabled: false })) }));
    renderApp(<RoutingPage />, { route: '/routing?purpose=execute', api: withSkipped(off) });
    await screen.findByRole('list', { name: '模型' });
    expect(document.querySelector('[data-order-summary="none"]')?.textContent).toContain('无可用');
    expect(document.body.textContent).not.toMatch(/实际第 \d+ 位/);
    for (const m of off) expect(slotOf(m.modelId).textContent).toBe('关着，已跳过');
  });

  test('路由层：模型下关着的路由写「关着，已跳过」，开着的写实际第几位', async () => {
    const model: RoutingLayerModel = {
      modelId: 'm-x',
      displayName: 'Mx',
      family: 'claude',
      verdict: 'live',
      routes: [layerRoute('r-a', false), layerRoute('r-b', true), layerRoute('r-c', true)],
    };
    renderApp(<RoutingPage />, { route: '/routing?purpose=execute', api: withSkipped([model]) });
    await screen.findByRole('list', { name: '模型' });
    const slot = (id: string) =>
      document.querySelector(`li[data-route="${id}"] [data-slot-state]`) as HTMLElement;
    await waitFor(() => expect(slot('r-a')).toBeTruthy());
    expect(slot('r-a').textContent).toBe('关着，已跳过');
    expect(slot('r-b').textContent).toBe('实际第 1 位');
    expect(slot('r-c').textContent).toBe('实际第 2 位');
  });
});
