// @vitest-environment happy-dom
// 思考档位页（#470、#1803）：一行一条「模型 × 路由」按家族分组，档位用下拉改、改完照库里的值显示；这家不认的档不进下拉，
// 配不了的写为什么；后端不认、别人刚改过就退回库里的值并写明原因；没接上、没读成都照实写，不画空表冒充「都没配」。
// 能配的按家族展开；配不了、未分类默认折叠（#1756）。
import { cleanup, fireEvent, screen, waitFor, within } from '@testing-library/react';
import { afterEach, beforeAll, describe, expect, test, vi } from 'vitest';
import { ApiError } from '../api/client';
import { createMockApi, type MockApi } from '../api/mock/server';
import type { RoutingEfforts } from '../api/types';
import EffortsPage from '../routes/efforts';
import { renderApp } from './harness';

afterEach(cleanup);

// happy-dom 没有 Radix 下拉要用的指针捕获和滚动
beforeAll(() => {
  Object.assign(Element.prototype, {
    hasPointerCapture: () => false,
    setPointerCapture: () => {},
    releasePointerCapture: () => {},
    scrollIntoView: () => {},
  });
});

const row = (routeId: string) => {
  const el = document.querySelector(`[data-route="${routeId}"]`);
  if (!(el instanceof HTMLElement)) throw new Error(`页面上没有路由 ${routeId}`);
  return el;
};

const trigger = (routeId: string) => within(row(routeId)).getByRole('combobox');

/** 这一行下拉现在显示的档位。 */
const shown = (routeId: string) => trigger(routeId).textContent;

/** 打开这一行的下拉，列出能选的几项。 */
const options = (routeId: string) => {
  fireEvent.pointerDown(trigger(routeId), { button: 0, ctrlKey: false, pointerType: 'mouse' });
  const names = screen.getAllByRole('option').map((o) => o.textContent);
  fireEvent.keyDown(document.activeElement ?? document.body, { key: 'Escape' });
  return names;
};

/** 改这一行的档位：开下拉、点一项。 */
const choose = (routeId: string, name: string) => {
  fireEvent.pointerDown(trigger(routeId), { button: 0, ctrlKey: false, pointerType: 'mouse' });
  fireEvent.click(screen.getByRole('option', { name }));
};

const opened = async () => {
  await screen.findAllByText('Opus 5.5');
};

/** 点开「配不了」折叠（默认不在 DOM 里画路由行）。 */
const openFixedFold = async () => {
  const btn = await screen.findByRole('button', { name: /配不了 \d+ 条/ });
  if (btn.getAttribute('aria-expanded') !== 'true') fireEvent.click(btn);
  return btn;
};

/** 种子上叠两条未分类（目录没厂家）：能配的 gpt-5.5-none-fast、claude-4-sonnet。 */
const withUncategorized = (): MockApi => {
  const api = createMockApi({ live: false });
  const base = api.routingEfforts.bind(api);
  api.routingEfforts = async () => {
    const data = await base();
    return {
      ...data,
      models: [
        ...data.models,
        {
          modelId: 'gpt-5.5-none-fast',
          displayName: 'gpt-5.5-none-fast',
          routes: [
            {
              routeId: 'r-uncat-gpt',
              channelId: 'ch-relay',
              channelName: '中转站',
              poolId: 'relay',
              hostId: 'mirasim',
              model: 'gpt-5.5-none-fast',
              enabled: true,
              choices: ['low', 'medium', 'high', 'xhigh', 'max'],
            },
          ],
        },
        {
          modelId: 'claude-4-sonnet',
          displayName: 'claude-4-sonnet',
          routes: [
            {
              routeId: 'r-uncat-claude',
              channelId: 'ch-claude',
              channelName: 'Claude 订阅',
              poolId: 'claude-a',
              hostId: 'claude-code',
              model: 'claude-4-sonnet',
              enabled: true,
              choices: ['low', 'medium', 'high', 'xhigh', 'max'],
            },
          ],
        },
      ],
    };
  };
  return api;
};

describe('思考档位页：看', () => {
  test('一行一条路由，按家族分组；配过的写配的那档，没配的写「默认（high）」；顶上数清', async () => {
    renderApp(<EffortsPage />, { route: '/efforts' });
    await opened();
    // 种子里 Grok 那条配了 medium，Opus 的 Claude Code 那条没配
    expect(shown('r-grok')).toBe('medium');
    expect(row('r-grok').textContent).toContain('medium');
    expect(shown('r-ca-opus')).toBe('默认');
    expect(row('r-ca-opus').textContent).toContain('默认（high）');
    // 关着的路由照样列出来，也能先配
    expect(row('r-rl-opus').textContent).toContain('关着');
    expect(screen.getByText(/条配了/).textContent).toMatch(/^1 条配了 · \d+ 条用默认 high · 4 条配不了$/);
    // 家族组头，Claude 排在 Grok 前
    const heads = screen
      .getAllByRole('button', { expanded: true })
      .map((b) => b.textContent ?? '')
      .filter((t) => /^(Claude|Grok|GPT)/.test(t));
    expect(heads.map((t) => t.replace(/\d.*$/, ''))).toEqual(['Claude', 'Grok']);
    // 不再有每行一排按钮
    expect(screen.queryAllByRole('radio')).toEqual([]);
  });

  test('组头可折叠：点一下收起这一家的行，再点展开', async () => {
    renderApp(<EffortsPage />, { route: '/efforts' });
    await opened();
    const head = screen.getByRole('button', { name: /^Grok/ });
    fireEvent.click(head);
    expect(head.getAttribute('aria-expanded')).toBe('false');
    expect(document.querySelector('[data-route="r-grok"]')).toBeNull();
    fireEvent.click(head);
    expect(row('r-grok')).toBeTruthy();
  });

  test('这家认哪几档就给哪几项：Claude Code 五档都有，Grok 没有 max', async () => {
    renderApp(<EffortsPage />, { route: '/efforts' });
    await opened();
    expect(options('r-ca-opus')).toEqual(['默认', 'low', 'medium', 'high', 'xhigh', 'max']);
    cleanup();
    renderApp(<EffortsPage />, { route: '/efforts' });
    await opened();
    expect(options('r-grok')).toEqual(['默认', 'low', 'medium', 'high', 'xhigh']);
  });

  test('配不了的没有下拉，写为什么：cursor 整串模型名、Codex 没接上、判断题外壳', async () => {
    renderApp(<EffortsPage />, { route: '/efforts' });
    await opened();
    await openFixedFold();
    expect(within(row('r-cursor')).queryAllByRole('combobox')).toEqual([]);
    // 同一句原因只在分组头写一次，行上不再重复「配不了：」
    expect(screen.getByText(/没有单独的档位参数，模型串 cursor-auto/)).toBeTruthy();
    expect(row('r-cursor').textContent).not.toContain('配不了：');
    expect(screen.getByText('引擎还没接上，起不了会话')).toBeTruthy();
    expect(screen.getByText('跑的是判断题小模型，不起会话')).toBeTruthy();
  });
});

describe('思考档位页：改', () => {
  test('改下拉就存：参数是那条路由和选的档、带上改之前看到的值，改完照库里的值显示；选「默认」清回没配', async () => {
    const { api } = renderApp(<EffortsPage />, { route: '/efforts' });
    const spy = vi.spyOn(api, 'updateRouteEffort');
    await opened();

    choose('r-ca-opus', 'xhigh');
    await waitFor(() => expect(shown('r-ca-opus')).toBe('xhigh'));
    await waitFor(() => expect(row('r-ca-opus').textContent).not.toContain('默认（high）'));
    expect(spy).toHaveBeenLastCalledWith('opus-5.5', 'r-ca-opus', { effort: 'xhigh', expected: null });
    expect((await api.routingEfforts()).models.find((m) => m.modelId === 'opus-5.5')?.routes[0]?.effort).toBe(
      'xhigh',
    );

    choose('r-grok', '默认');
    await waitFor(() => expect(shown('r-grok')).toBe('默认'));
    expect(spy).toHaveBeenLastCalledWith('grok-4.7', 'r-grok', { effort: null, expected: 'medium' });
  });

  test('选回已经显示的那一项不发请求', async () => {
    const { api } = renderApp(<EffortsPage />, { route: '/efforts' });
    const spy = vi.spyOn(api, 'updateRouteEffort');
    await opened();
    choose('r-grok', 'medium');
    choose('r-ca-opus', '默认');
    expect(spy).not.toHaveBeenCalled();
  });

  test('【故意造出的失败】后端不认（422）、别人刚改过（409）：退回库里的值，写明没改成和原因，不冒充改成了', async () => {
    const api: MockApi = createMockApi({ live: false });
    const reject = vi
      .spyOn(api, 'updateRouteEffort')
      .mockRejectedValueOnce(
        new ApiError(
          422,
          'effort_not_allowed',
          'claude-code 不支持思考档位（effort）max（只认 low / medium / high）',
        ),
      )
      .mockRejectedValueOnce(new ApiError(409, 'conflict', '这条路由的档位刚被别人改过，刷新后再改'));
    renderApp(<EffortsPage />, { api, route: '/efforts' });
    await opened();

    choose('r-ca-opus', 'max');
    const alert = await within(row('r-ca-opus')).findByRole('alert');
    expect(alert.textContent).toBe(
      '没改成：claude-code 不支持思考档位（effort）max（只认 low / medium / high）',
    );
    await waitFor(() => expect(shown('r-ca-opus')).toBe('默认'));

    choose('r-ca-opus', 'low');
    await waitFor(() =>
      expect(within(row('r-ca-opus')).getByRole('alert').textContent).toBe(
        '没改成：这条路由的档位刚被别人改过，刷新后再改',
      ),
    );
    await waitFor(() => expect(shown('r-ca-opus')).toBe('默认'));
    expect(reject).toHaveBeenCalledTimes(2);
  });
});

describe('【故意造出的失败】没接上、没读成：照实写，不画空表', () => {
  const withEfforts = (efforts: () => Promise<RoutingEfforts>): MockApi => {
    const api = createMockApi({ live: false });
    Object.assign(api, { routingEfforts: efforts });
    return api;
  };

  test('没接上（开发环境内存版）：整块写为什么', async () => {
    const api = withEfforts(async () => ({
      defaultEffort: 'high',
      models: [],
      unavailable:
        '思考档位没接上：这里是开发环境的内存版，没有路由两层那张表（routing_catalog），真库上才有',
    }));
    renderApp(<EffortsPage />, { api, route: '/efforts' });
    expect((await screen.findByRole('note')).textContent).toMatch(/^思考档位没接上：/);
    expect(document.querySelector('[data-route]')).toBeNull();
  });

  test('没读成：写「思考档位没读成」和原因', async () => {
    const api = withEfforts(async () => {
      throw new ApiError(503, 'routing_efforts_unreadable', 'column "effort" does not exist');
    });
    renderApp(<EffortsPage />, { api, route: '/efforts' });
    // 红字后面带一个「重试」按钮（LoadError，#902 D5），文字只比前面那句
    expect((await screen.findByRole('alert')).textContent).toBe(
      '思考档位没读成：column "effort" does not exist重试',
    );
  });

  test('一条路由都没有：写明空着、去看什么，不当成「都没配」', async () => {
    const api = withEfforts(async () => ({ defaultEffort: 'high', models: [] }));
    renderApp(<EffortsPage />, { api, route: '/efforts' });
    expect(await screen.findByText('路由两层里一条路由都没有')).toBeTruthy();
  });
});

describe('思考档位页：过滤（#1803）', () => {
  test('「只看配过的」打开后没配过的行不显示，关掉回来', async () => {
    renderApp(<EffortsPage />, { route: '/efforts' });
    await opened();
    expect(row('r-ca-opus')).toBeTruthy();
    const sw = screen.getByRole('switch', { name: '只看配过的' });
    fireEvent.click(sw);
    // 种子里只有 Grok 那条配过
    expect(document.querySelector('[data-route="r-ca-opus"]')).toBeNull();
    expect(row('r-grok')).toBeTruthy();
    expect(screen.queryByRole('button', { name: /配不了 \d+ 条/ })).toBeNull();
    fireEvent.click(sw);
    expect(row('r-ca-opus')).toBeTruthy();
  });

  test('搜索按模型名、渠道名、路由号筛行；一条都没有写明搜的是什么', async () => {
    renderApp(<EffortsPage />, { route: '/efforts' });
    await opened();
    const box = screen.getByRole('searchbox', { name: '搜索模型或渠道' });
    fireEvent.change(box, { target: { value: 'grok' } });
    expect(row('r-grok')).toBeTruthy();
    expect(document.querySelector('[data-route="r-ca-opus"]')).toBeNull();
    fireEvent.change(box, { target: { value: '没有这个' } });
    expect(screen.getByText(/^没有符合的路由/).textContent).toBe('没有符合的路由：「没有这个」');
  });
});

describe('思考档位页：折叠（#1756）', () => {
  test('默认只显示能配的路由，配不了和未分类折叠、点开可见', async () => {
    renderApp(<EffortsPage />, { api: withUncategorized(), route: '/efforts' });
    await opened();

    // 顶上能配的直接在
    expect(row('r-ca-opus')).toBeTruthy();
    expect(row('r-grok')).toBeTruthy();
    // 配不了、未分类默认不画路由行
    expect(document.querySelector('[data-route="r-cursor"]')).toBeNull();
    expect(document.querySelector('[data-route="r-uncat-gpt"]')).toBeNull();
    expect(document.querySelector('[data-route="r-uncat-claude"]')).toBeNull();

    const fixedBtn = screen.getByRole('button', { name: /配不了 4 条/ });
    expect(fixedBtn.getAttribute('aria-expanded')).toBe('false');
    const uncatBtn = screen.getByRole('button', { name: /未分类 2 条/ });
    expect(uncatBtn.getAttribute('aria-expanded')).toBe('false');

    fireEvent.click(fixedBtn);
    expect(fixedBtn.getAttribute('aria-expanded')).toBe('true');
    expect(row('r-cursor')).toBeTruthy();
    expect(row('r-rl-gpt')).toBeTruthy();
    expect(row('r-ds')).toBeTruthy();

    fireEvent.click(uncatBtn);
    expect(uncatBtn.getAttribute('aria-expanded')).toBe('true');
    expect(row('r-uncat-gpt')).toBeTruthy();
    expect(row('r-uncat-claude')).toBeTruthy();
    // 用人能读的名字，原始编号在标题悬停（行上 route 的 title 也可能是同一串，只认标题里的）
    // 模型名那格在行里排第一，路由号那格的悬停也可能是同一串
    expect(within(row('r-uncat-gpt')).getAllByTitle('gpt-5.5-none-fast')[0]?.textContent).toBe(
      'GPT 5.5 none fast',
    );
    expect(within(row('r-uncat-claude')).getAllByTitle('claude-4-sonnet')[0]?.textContent).toBe(
      'Claude 4 sonnet',
    );
    // 不把原始编号当模型名露出来
    expect(screen.queryByText('gpt-5.5-none-fast')).toBeNull();
  });

  test('有路能配的模型在顶上展开；配不了收进折叠，点开后照列', async () => {
    renderApp(<EffortsPage />, { route: '/efforts' });
    await opened();
    const order = Array.from(document.querySelectorAll('[data-model]')).map((el) =>
      el.getAttribute('data-model'),
    );
    expect(order).toContain('opus-5.5');
    expect(order).not.toContain('cursor-auto');
    expect(order).not.toContain('deepseek-v4.1-flash');
    expect(order).not.toContain('gpt-5.6-luna');
    await openFixedFold();
    expect(row('r-cursor')).toBeTruthy();
  });
});
