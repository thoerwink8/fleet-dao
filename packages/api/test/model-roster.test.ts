// 路由页接口附上渠道模型差集（#1302）。没接上、读不到都写明，不把两层打成 503，也不在没接上两层时多塞一块。
import { RoutingLayersResponse } from '@fleet-dao/shared';
import { describe, expect, it } from 'vitest';
import { harness } from './harness.ts';

async function layers(cookie: string, h: ReturnType<typeof harness>) {
  const res = await h.cockpit.request('/api/routing/layers', { headers: { cookie } });
  expect(res.status).toBe(200);
  return RoutingLayersResponse.parse(await res.json());
}

describe('路由页接口上的渠道模型差集', () => {
  it('两层没接上时不附差集，仍是原来那一句没接上', async () => {
    const h = harness();
    const { cookie } = await h.login();
    const body = await layers(cookie, h);
    expect(body.unavailable).toMatch(/^路由两层没接上：/);
    expect(body.modelRoster).toBeUndefined();
    expect(body.modelRosterUnavailable).toBeUndefined();
  });

  it('两层接上了、差集没接上：两层照回，差集写不能当成都对得上', async () => {
    const h = harness({ routingLayers: { read: async () => [] } });
    const { cookie } = await h.login();
    const body = await layers(cookie, h);
    expect(body.unavailable).toBeUndefined();
    expect(body.purposes).toEqual([]);
    expect(body.modelRoster).toBeUndefined();
    expect(body.modelRosterUnavailable).toContain('不能当成都对得上');
  });

  it('差集口子抛了：仍是 200，写没读成，两层还在', async () => {
    const h = harness({
      routingLayers: { read: async () => [] },
      modelRoster: {
        read: async () => {
          throw new Error('名册表不在');
        },
      },
    });
    const { cookie } = await h.login();
    const body = await layers(cookie, h);
    expect(body.modelRoster).toBeUndefined();
    expect(body.modelRosterUnavailable).toBe('渠道模型表没读成：名册表不在');
    expect(h.logs.some((l) => l.level === 'error' && l.message === '渠道模型表没读成')).toBe(true);
  });

  it('假的名册结果原样给页面：有新增、有失败', async () => {
    const h = harness({
      routingLayers: { read: async () => [] },
      modelRoster: {
        read: async () => ({
          missingFromCatalog: [
            {
              channelId: 'mirasim',
              channelName: 'Mirasim 中转',
              modelKey: 'kimi-k3',
              firstSeenAt: '2026-10-08T00:00:00.000Z',
              lastSeenAt: '2026-10-08T00:00:00.000Z',
            },
          ],
          goneRoutes: [],
          failed: [{ channelId: 'xai', channelName: 'Grok 订阅', code: 'no_credentials', message: '没登录' }],
          notYet: [],
        }),
      },
    });
    const { cookie } = await h.login();
    const body = await layers(cookie, h);
    expect(body.modelRosterUnavailable).toBeUndefined();
    expect(body.modelRoster?.missingFromCatalog.map((m) => m.modelKey)).toEqual(['kimi-k3']);
    expect(body.modelRoster?.failed[0]?.code).toBe('no_credentials');
  });
});
