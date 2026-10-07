// 渠道状态页的「立即探测」（驾驶舱改版 2026-10-07）：点一下记一条操作记录，引擎接手、探完各记一条，读的时候现算走到哪。
// 故意造出的失败：引擎关着 409、引擎没连上 503、路由不存在 404、操作记录读不到 503（写明没读成，不拿空列表顶）。
import {
  ROUTE_PROBE_ACTION,
  ROUTE_PROBE_TARGET,
  RouteProbeNowResponse,
  RouteProbeStatusResponse,
} from '@fleet-dao/shared';
import { describe, expect, it } from 'vitest';
import { PublicHealthError } from '../src/health.ts';
import { errorCode, harness, write } from './harness.ts';

const PATH = '/api/routing/probe';
const engineOn = [{ name: 'engine', check: async () => {} }];

async function status(h: ReturnType<typeof harness>, cookie: string) {
  const res = await h.cockpit.request(PATH, { headers: { cookie } });
  expect(res.status).toBe(200);
  return RouteProbeStatusResponse.parse(await res.json());
}

describe('POST /api/routing/probe', () => {
  it('点单条：记一条 routing.probe.request（操作人是登录的人），读回是「排队」', async () => {
    const h = harness({ health: engineOn });
    const s = await h.login();
    const routeId = h.store.data.routes[0]?.id as string;
    const res = await h.cockpit.request(PATH, write('POST', s, { routeIds: [routeId] }));
    expect(res.status).toBe(200);
    const body = RouteProbeNowResponse.parse(await res.json());
    expect(body.request).toMatchObject({ state: 'queued', routeIds: [routeId], results: [] });
    expect(body.engine.state).toBe('on');

    const rows = h.store.data.audit.filter((a) => a.target === ROUTE_PROBE_TARGET);
    expect(rows.map((a) => [a.action, a.actor.kind, a.via])).toEqual([
      [ROUTE_PROBE_ACTION.request, 'user', 'cockpit'],
    ]);
    expect(rows[0]?.after).toEqual({ requestId: body.request.requestId, routeIds: [routeId] });

    const read = await status(h, s.cookie);
    expect(read.requests).toHaveLength(1);
    expect(read.requests[0]).toMatchObject({ requestId: body.request.requestId, state: 'queued' });
  });

  it('全部：routeIds 不给，记下的是 null，读回没有 routeIds', async () => {
    const h = harness({ health: engineOn });
    const s = await h.login();
    const body = RouteProbeNowResponse.parse(
      await (await h.cockpit.request(PATH, write('POST', s, {}))).json(),
    );
    expect(body.request.routeIds).toBeUndefined();
    const row = h.store.data.audit.find((a) => a.action === ROUTE_PROBE_ACTION.request);
    expect(row?.after).toEqual({ requestId: body.request.requestId, routeIds: null });
  });

  it('引擎接手、探完：读回 done，带每条的结论原文和耗时', async () => {
    const h = harness({ health: engineOn });
    const s = await h.login();
    const routeId = h.store.data.routes[0]?.id as string;
    const { request } = RouteProbeNowResponse.parse(
      await (await h.cockpit.request(PATH, write('POST', s, { routeIds: [routeId] }))).json(),
    );
    const engine = { kind: 'engine' as const, id: 'engine:route-probe-now' };
    await h.store.appendAudit({
      actor: engine,
      action: ROUTE_PROBE_ACTION.start,
      target: ROUTE_PROBE_TARGET,
      after: { requestId: request.requestId },
      via: 'engine',
      ok: true,
    });
    expect((await status(h, s.cookie)).requests[0]?.state).toBe('running');
    const result = {
      routeId,
      outcome: 'failed',
      detail: '连探两次都没通：本机到平台的网络不通或太慢，设备验证没能完成',
      at: h.clock.now.toISOString(),
      durationMs: 41_000,
    };
    await h.store.appendAudit({
      actor: engine,
      action: ROUTE_PROBE_ACTION.done,
      target: ROUTE_PROBE_TARGET,
      after: { requestId: request.requestId, results: [result] },
      via: 'engine',
      ok: true,
    });
    const read = await status(h, s.cookie);
    expect(read.requests[0]).toMatchObject({ state: 'done', results: [result] });
  });

  it('【故意造出的失败】引擎按配置没开：409 engine_off，不记成点过', async () => {
    const h = harness({ config: { engineOff: true } });
    const s = await h.login();
    const res = await h.cockpit.request(PATH, write('POST', s, {}));
    expect(res.status).toBe(409);
    expect(await errorCode(res)).toBe('engine_off');
    expect(h.store.data.audit.filter((a) => a.target === ROUTE_PROBE_TARGET)).toEqual([]);
  });

  it('【故意造出的失败】引擎没连上：503 engine_down，消息写明是没连上', async () => {
    const h = harness({
      health: [
        {
          name: 'engine',
          check: async () => {
            throw new PublicHealthError('engine_offline', '引擎不在线');
          },
        },
      ],
    });
    const s = await h.login();
    const res = await h.cockpit.request(PATH, write('POST', s, {}));
    expect(res.status).toBe(503);
    const body = (await res.json()) as { error: { code: string; message: string } };
    expect(body.error.code).toBe('engine_down');
    expect(body.error.message).toContain('没连上');
  });

  it('【故意造出的失败】路由不存在：404，不记', async () => {
    const h = harness({ health: engineOn });
    const s = await h.login();
    const res = await h.cockpit.request(PATH, write('POST', s, { routeIds: ['no-such-route'] }));
    expect(res.status).toBe(404);
    expect(h.store.data.audit.filter((a) => a.target === ROUTE_PROBE_TARGET)).toEqual([]);
  });
});

describe('GET /api/routing/probe', () => {
  it('没人点过：空列表，带引擎此刻在不在', async () => {
    const h = harness({ health: engineOn });
    const s = await h.login();
    const read = await status(h, s.cookie);
    expect(read.requests).toEqual([]);
    expect(read.engine).toEqual({ state: 'on' });
  });

  it('【故意造出的失败】操作记录读不到：503 route_probe_unreadable，写明没读成，不回空列表', async () => {
    const h = harness({ health: engineOn });
    const s = await h.login();
    h.store.listAudit = async () => {
      throw new Error('连不上库');
    };
    const res = await h.cockpit.request(PATH, { headers: { cookie: s.cookie } });
    expect(res.status).toBe(503);
    const body = (await res.json()) as { error: { code: string; message: string } };
    expect(body.error.code).toBe('route_probe_unreadable');
    expect(body.error.message).toContain('没读成');
    expect(body.error.message).toContain('连不上库');
  });

  it('点了 10 分钟引擎没接手：expired，写明作废的原因', async () => {
    const h = harness({ health: engineOn });
    const s = await h.login();
    await h.cockpit.request(PATH, write('POST', s, {}));
    h.clock.now = new Date(h.clock.now.getTime() + 11 * 60_000);
    const read = await status(h, s.cookie);
    expect(read.requests[0]?.state).toBe('expired');
    expect(read.requests[0]?.why).toContain('没接手');
  });
});
