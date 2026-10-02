// @vitest-environment happy-dom
// 路由在线状态（#129）：换路由对话框里选不了的原因照探针写的说——还没探过的写「还没探过」，
// 离线的写「离线：原因」（太长的截断）。
import { describe, expect, test } from 'vitest';
import { createMockApi } from '../api/mock/server';
import type { Route, Routing } from '../api/types';
import { routeOptions } from '../components/task-actions';

describe('换路由对话框：选不了的原因照探针写的说', () => {
  const routing = async (map: (r: Route) => Route): Promise<Routing> => {
    const api = createMockApi({ live: false });
    const inner = api.routing;
    api.routing = async () => {
      const r = await inner();
      return { ...r, routes: r.routes.map(map) };
    };
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
