// @vitest-environment happy-dom
// 路由在线状态（#129）：调度台顶上是探针的真结论——在线几条、最近一次探测、每条在线 / 离线（原因）/ 还没探过；
// 还没探过的不说成离线，探针停了照实说「可能停了」，换路由对话框里选不了的原因照探针写的说。
import { cleanup, fireEvent, screen, waitFor } from '@testing-library/react';
import { afterEach, describe, expect, test } from 'vitest';
import { createMockApi, type MockApi } from '../api/mock/server';
import type { Route, Routing } from '../api/types';
import { routeOptions } from '../components/task-actions';
import { TIME } from '../lib/format';
import ChannelsPage from '../routes/channels';
import DispatchPage from '../routes/dispatch';
import { renderApp } from './harness';

afterEach(cleanup);

/** 把假后端路由表里的每条路由换个样子（探针的结论、在不在线）。 */
function withRoutes(map: (r: Route) => Route): MockApi {
  const api = createMockApi({ live: false });
  const routing = api.routing;
  api.routing = async () => {
    const r = await routing();
    return { ...r, routes: r.routes.map(map) };
  };
  return api;
}

const health = () => document.querySelector('[data-route-health]') as HTMLElement | null;
const rowsOf = (kind: string) =>
  document.querySelectorAll(`[data-route-health] [data-route-status="${kind}"]`);

describe('调度台顶上的路由在线状态', () => {
  test('照探针的结论：在线几条、最近一次探测；有真没探通的就展开，每条写在线 / 离线和原因', async () => {
    renderApp(<DispatchPage />);
    await screen.findByText('路由在线状态');
    const box = health();
    expect(box?.textContent).toContain('在线 7/11');
    expect(box?.textContent).toMatch(/最近一次探测 \d+ 分钟前/);
    expect(box?.textContent).toContain('每 15 分钟一轮');
    // 假数据里 Cursor 连探两次没通（标红）：默认展开
    expect(screen.getByRole('button', { name: /收起/ }).getAttribute('aria-expanded')).toBe('true');
    expect(rowsOf('online').length).toBe(7);
    expect(rowsOf('offline').length).toBe(4);
    expect(box?.textContent).toContain('连探两次都没通');
    expect(box?.textContent).toContain('按量计费的渠道不自动探');
    expect(document.querySelector('[data-not-built="129"]')).toBeNull();
  });

  test('收起、展开', async () => {
    renderApp(<DispatchPage />);
    fireEvent.click(await screen.findByRole('button', { name: /收起/ }));
    expect(rowsOf('online').length).toBe(0);
    fireEvent.click(screen.getByRole('button', { name: /看每条/ }));
    expect(rowsOf('online').length).toBe(7);
  });

  test('都在线、没有没探通的：默认收着，只看一行数', async () => {
    renderApp(<DispatchPage />, {
      api: withRoutes((r) => ({
        ...r,
        alive: true,
        probe: { state: 'ok', at: new Date(Date.now() - 3 * TIME.MIN).toISOString(), detail: '答上了：OK' },
      })),
    });
    await screen.findByText('路由在线状态');
    expect(health()?.textContent).toContain('在线 11/11');
    expect(screen.getByRole('button', { name: /看每条/ }).getAttribute('aria-expanded')).toBe('false');
    expect(rowsOf('online').length).toBe(0);
  });

  test('探针还没出过结论：每条「还没探过」，页面上哪儿都不说离线', async () => {
    renderApp(<DispatchPage />, {
      api: withRoutes((r) => {
        const { probe: _probe, ...rest } = r;
        return { ...rest, alive: false };
      }),
    });
    await screen.findByText('路由在线状态');
    expect(health()?.textContent).toContain('探针还没出过结论');
    expect(health()?.textContent).toContain('还没探过 11 条');
    // 一条在线的都没有：默认展开
    expect(rowsOf('unprobed').length).toBe(11);
    expect(rowsOf('offline').length).toBe(0);
    await waitFor(() => expect(screen.getAllByText(/^还没探过：/).length).toBeGreaterThan(0));
    expect(document.body.innerHTML).not.toContain('离线');
  });

  test('没探通的不拿默认值冒充在线：alive 是假的就写离线和原因', async () => {
    renderApp(<DispatchPage />, {
      api: withRoutes((r) =>
        r.id === 'r-ca-opus'
          ? {
              ...r,
              alive: false,
              probe: {
                state: 'failed',
                at: new Date(Date.now() - 2 * TIME.MIN).toISOString(),
                detail: '登录失效：Not logged in',
              },
            }
          : r,
      ),
    });
    await screen.findByText('路由在线状态');
    expect(health()?.textContent).toContain('在线 6/11');
    expect(health()?.textContent).toContain('登录失效：Not logged in');
    // 各阶段里的这条路由也写离线和原因
    expect(screen.getAllByText('离线：登录失效：Not logged in').length).toBeGreaterThan(0);
  });

  test('探针停了（结论都超过 45 分钟没更新）：照实说可能停了，不当成刚探过', async () => {
    const old = new Date(Date.now() - 2 * TIME.HOUR).toISOString();
    renderApp(<DispatchPage />, {
      api: withRoutes((r) => (r.probe ? { ...r, probe: { ...r.probe, at: old } } : r)),
    });
    await screen.findByText('路由在线状态');
    expect(health()?.textContent).toContain('探针可能停了');
    expect(health()?.textContent).toContain('最近一次探测 2 小时前');
    expect(screen.getAllByText('探测过期').length).toBeGreaterThan(0);
  });
});

describe('渠道页的路由', () => {
  test('每个渠道数在线几条；离线的划掉、悬停写原因；还没探过的不划掉、不说离线', async () => {
    renderApp(<ChannelsPage />, {
      api: withRoutes((r) => {
        if (r.id !== 'r-ca-opus5') return r;
        const { probe: _probe, ...rest } = r;
        return { ...rest, alive: false };
      }),
    });
    await screen.findByText('Claude 订阅');
    await waitFor(() => expect(document.querySelectorAll('[data-route-status]').length).toBe(11));
    const cursor = document.querySelector('[data-route-status="offline"][title*="连探两次都没通"]');
    expect(cursor?.className).toContain('line-through');
    const unprobed = document.querySelector('[data-route-status="unprobed"]');
    expect(unprobed?.className).not.toContain('line-through');
    expect(unprobed?.getAttribute('title')).toContain('还没探过');
    expect(unprobed?.getAttribute('title')).not.toContain('离线');
    // Claude 订阅：r-ca-opus、r-cb-opus、r-ca-sonnet 在线，r-ca-opus5 还没探过
    const claude = screen.getByText('Claude 订阅').closest('section');
    expect(claude?.textContent).toContain('路由 3/4 在线');
  });
});

describe('换路由对话框：选不了的原因照探针写的说', () => {
  const routing = async (map: (r: Route) => Route): Promise<Routing> => {
    const api = withRoutes(map);
    return api.routing();
  };

  test('还没探过的写「还没探过」，离线的写「离线：原因」（太长的截断）', async () => {
    const long = `连探两次都没通：${'很长的报错'.repeat(30)}`;
    const r = await routing((x) => {
      if (x.id === 'r-ca-opus') {
        const { probe: _probe, ...rest } = x;
        return { ...rest, alive: false };
      }
      if (x.id === 'r-cb-opus')
        return { ...x, alive: false, probe: { state: 'failed', at: new Date().toISOString(), detail: long } };
      return x;
    });
    const { ordered } = routeOptions(r, undefined, 'plan', undefined, Date.now());
    const byId = new Map(ordered.map((o) => [o.id, o]));
    expect(byId.get('r-ca-opus')?.blocked).toBe('还没探过');
    const blocked = byId.get('r-cb-opus')?.blocked ?? '';
    expect(blocked.startsWith('离线：连探两次都没通')).toBe(true);
    expect(blocked.endsWith('…')).toBe(true);
    expect(blocked.length).toBeLessThanOrEqual('离线：'.length + 60);
    // 在线的选得了
    expect(byId.get('r-rl-opus')?.blocked).toBeUndefined();
  });
});
