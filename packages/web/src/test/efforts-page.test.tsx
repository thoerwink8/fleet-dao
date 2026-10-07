// @vitest-environment happy-dom
// 思考档位页（#470）：每个模型下每条路一格，点一下就改、改完照库里的值显示；这家不认的档不给点，配不了的写为什么；
// 后端不认、别人刚改过就退回库里的值并写明原因；没接上、没读成都照实写，不画空表冒充「都没配」。
import { cleanup, fireEvent, screen, waitFor, within } from '@testing-library/react';
import { afterEach, describe, expect, test, vi } from 'vitest';
import { ApiError } from '../api/client';
import { createMockApi, type MockApi } from '../api/mock/server';
import type { RoutingEfforts } from '../api/types';
import EffortsPage from '../routes/efforts';
import { renderApp } from './harness';

afterEach(cleanup);

const row = (routeId: string) => {
  const el = document.querySelector(`[data-route="${routeId}"]`);
  if (!(el instanceof HTMLElement)) throw new Error(`页面上没有路由 ${routeId}`);
  return el;
};

/** 这一行亮着的那一格（单选：只有一个）。 */
const pressed = (routeId: string) =>
  within(row(routeId))
    .getAllByRole('radio')
    .filter((b) => b.getAttribute('aria-checked') === 'true')
    .map((b) => b.textContent);

const cells = (routeId: string) =>
  within(row(routeId))
    .getAllByRole('radio')
    .map((b) => b.textContent);

const opened = async () => {
  await screen.findByText('Opus 5.5');
};

describe('思考档位页：看', () => {
  test('每个模型一块、每条路一格；配过的亮着配的那档，没配的亮「默认」并写明起会话用 high；顶上数清', async () => {
    renderApp(<EffortsPage />, { route: '/efforts' });
    await opened();
    // 种子里 Grok 那条配了 medium，Opus 的 Claude Code 那条没配
    expect(pressed('r-grok')).toEqual(['medium']);
    expect(row('r-grok').textContent).toContain('起会话用 medium');
    expect(pressed('r-ca-opus')).toEqual(['默认']);
    expect(row('r-ca-opus').textContent).toContain('起会话用 high（没配，用默认）');
    // 关着的路由照样列出来，也能先配
    expect(row('r-rl-opus').textContent).toContain('关着');
    expect(screen.getByText(/条配了/).textContent).toMatch(/^1 条配了 · \d+ 条用默认 high · 3 条配不了$/);
  });

  test('这家认哪几档就给哪几格：Claude Code 五档都有，Grok 没有 max', async () => {
    renderApp(<EffortsPage />, { route: '/efforts' });
    await opened();
    expect(cells('r-ca-opus')).toEqual(['默认', 'low', 'medium', 'high', 'xhigh', 'max']);
    expect(cells('r-grok')).toEqual(['默认', 'low', 'medium', 'high', 'xhigh']);
  });

  test('配不了的不给格子，写为什么：cursor 整串模型名、Codex 没接上、判断题外壳', async () => {
    renderApp(<EffortsPage />, { route: '/efforts' });
    await opened();
    expect(within(row('r-cursor')).queryAllByRole('radio')).toEqual([]);
    expect(row('r-cursor').textContent).toContain(
      '配不了：没有单独的档位参数，模型串 cursor-auto 不带方括号（是上游目录里的整串，档位已经在名字里）',
    );
    expect(row('r-rl-gpt').textContent).toContain('配不了：引擎还没接上，起不了会话');
    expect(row('r-ds').textContent).toContain('配不了：跑的是判断题小模型，不起会话');
  });
});

describe('思考档位页：改', () => {
  test('点一格就改：带上改之前看到的值，改完照库里的值亮着；点「默认」清回没配', async () => {
    const { api } = renderApp(<EffortsPage />, { route: '/efforts' });
    const spy = vi.spyOn(api, 'updateRouteEffort');
    await opened();

    fireEvent.click(within(row('r-ca-opus')).getByRole('radio', { name: 'xhigh' }));
    await waitFor(() => expect(pressed('r-ca-opus')).toEqual(['xhigh']));
    await waitFor(() => expect(row('r-ca-opus').textContent).toContain('起会话用 xhigh'));
    expect(spy).toHaveBeenLastCalledWith('opus-5.5', 'r-ca-opus', { effort: 'xhigh', expected: null });
    expect((await api.routingEfforts()).models.find((m) => m.modelId === 'opus-5.5')?.routes[0]?.effort).toBe(
      'xhigh',
    );

    fireEvent.click(within(row('r-grok')).getByRole('radio', { name: '默认' }));
    await waitFor(() => expect(pressed('r-grok')).toEqual(['默认']));
    expect(spy).toHaveBeenLastCalledWith('grok-4.7', 'r-grok', { effort: null, expected: 'medium' });
  });

  test('点已经亮着的那格不发请求', async () => {
    const { api } = renderApp(<EffortsPage />, { route: '/efforts' });
    const spy = vi.spyOn(api, 'updateRouteEffort');
    await opened();
    fireEvent.click(within(row('r-grok')).getByRole('radio', { name: 'medium' }));
    fireEvent.click(within(row('r-ca-opus')).getByRole('radio', { name: '默认' }));
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

    fireEvent.click(within(row('r-ca-opus')).getByRole('radio', { name: 'max' }));
    const alert = await within(row('r-ca-opus')).findByRole('alert');
    expect(alert.textContent).toBe(
      '没改成：claude-code 不支持思考档位（effort）max（只认 low / medium / high）',
    );
    await waitFor(() => expect(pressed('r-ca-opus')).toEqual(['默认']));

    fireEvent.click(within(row('r-ca-opus')).getByRole('radio', { name: 'low' }));
    await waitFor(() =>
      expect(within(row('r-ca-opus')).getByRole('alert').textContent).toBe(
        '没改成：这条路由的档位刚被别人改过，刷新后再改',
      ),
    );
    await waitFor(() => expect(pressed('r-ca-opus')).toEqual(['默认']));
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

describe('思考档位页：先后（驾驶舱改版 2026-10-07）', () => {
  test('有路能配的模型排前面，一条都配不了的（cursor 整串、判断题小模型、没接上的）放最后，照列、写明为什么', async () => {
    renderApp(<EffortsPage />, { route: '/efforts' });
    await opened();
    const order = Array.from(document.querySelectorAll('[data-model]')).map((el) =>
      el.getAttribute('data-model'),
    );
    const fixedOnly = ['cursor-auto', 'deepseek-v4.1-flash', 'gpt-5.6-luna'];
    const firstFixed = order.findIndex((id) => fixedOnly.includes(id ?? ''));
    expect(firstFixed).toBeGreaterThan(0);
    // 配不了的都在能配的后面
    expect(order.slice(firstFixed).every((id) => fixedOnly.includes(id ?? ''))).toBe(true);
    expect(row('r-cursor').textContent).toContain('配不了');
  });
});
