// 渠道状态页的「立即探测」（驾驶舱改版，创始人 2026-10-07「渠道状态无法探测」）。
// 点一下 = 记一条操作记录（routing.probe.request，target routing:probe）；法国引擎每几秒看一眼操作记录，接手、探、回结论
// （engine/src/jobs/route-probe-now.ts）。一次立即探测现在走到哪不另存，读的时候从操作记录现算（shared 的 foldRouteProbeRequests，
// 引擎找没人接的也用它）。
// 改这里之前必须知道：
// - 引擎关着、没连上、没查成，点了也没人接：当场拒（409 / 503），写明是哪样，不记成点过、不让页面转「探测中」。
// - 读不到操作记录 → 503 写明没读成；认不出的记录数进 unreadable（日志里看得到），不拿空列表冒充「没人点过」。
// - 操作记录走 Store（真库、内存版同一份），不另开库连接。

import { randomUUID } from 'node:crypto';
import {
  foldRouteProbeRequests,
  ROUTE_PROBE_ACTION,
  ROUTE_PROBE_LIST_WINDOW_MS,
  ROUTE_PROBE_TARGET,
  type RouteProbeAuditRow,
  RouteProbeNowRequest,
  RouteProbeNowResponse,
  RouteProbeStatusResponse,
  WebRoutes,
} from '@fleet-dao/shared';
import { errMessage } from '@fleet-dao/shared/util';
import type { Context, Hono } from 'hono';
import type { Deps } from './deps.ts';
import { ApiError, readJson, reply } from './http.ts';
import type { Actor } from './ports.ts';
import type { CockpitEnv } from './session.ts';

/** 引擎此刻在不在（home-engine.ts 的 engineHealthProbe，主页「引擎」那一格同一份）。 */
type EngineState = { state: 'on' | 'off' | 'down' | 'unknown'; detail?: string | undefined };

/** 最多翻几页（每页 200 条）：一天点几百次不现实，翻满了明说没读全。 */
const MAX_PAGES = 5;

/** routing:probe 的操作记录，最近 ROUTE_PROBE_LIST_WINDOW_MS 之内的。读不到原样抛。 */
async function recentRows(deps: Deps, now: Date): Promise<RouteProbeAuditRow[]> {
  const since = now.getTime() - ROUTE_PROBE_LIST_WINDOW_MS;
  const rows: RouteProbeAuditRow[] = [];
  let cursor: string | undefined;
  for (let page = 0; page < MAX_PAGES; page += 1) {
    const got = await deps.store.listAudit({
      target: ROUTE_PROBE_TARGET,
      limit: 200,
      ...(cursor ? { cursor } : {}),
    });
    for (const item of got.items) {
      const at = new Date(item.at);
      if (at.getTime() < since) return rows;
      rows.push({
        at,
        action: item.action,
        actorId: item.actor.id,
        after: item.after,
        ok: item.ok,
        error: item.error ?? null,
      });
    }
    cursor = got.nextCursor;
    if (!cursor) return rows;
  }
  deps.log.warn('立即探测：操作记录超过翻页上限，只读了最近的', { pages: MAX_PAGES });
  return rows;
}

/** 引擎不在时点了没人接：每一种该怎么说。 */
function refuseWhenEngineAway(engine: EngineState): void {
  if (engine.state === 'on') return;
  const detail = engine.detail ? `（${engine.detail}）` : '';
  if (engine.state === 'off') {
    throw new ApiError(409, 'engine_off', `探不了：这台机器的引擎按配置没开${detail}，没人接这次探测`);
  }
  if (engine.state === 'down') {
    throw new ApiError(503, 'engine_down', `探不了：引擎没连上${detail}，点了也没人接，等引擎起来再点`);
  }
  throw new ApiError(503, 'engine_unknown', `探不了：没查成引擎在不在${detail}，不敢说点了会有人接`);
}

export function registerRouteProbeRoutes(
  app: Hono<CockpitEnv>,
  deps: Deps,
  actorOf: (c: Context<CockpitEnv>) => Actor,
  engineProbe: () => Promise<EngineState>,
): void {
  app.get(WebRoutes.routeProbeStatus.path, async (c) => {
    const now = deps.now();
    const [engine, rows] = await Promise.all([
      engineProbe(),
      recentRows(deps, now).catch((err: unknown) => {
        deps.log.error('立即探测：操作记录没读成', { error: errMessage(err) });
        throw new ApiError(503, 'route_probe_unreadable', `立即探测的记录没读成：${errMessage(err)}`);
      }),
    ]);
    const { requests, unreadable } = foldRouteProbeRequests(rows, now);
    if (unreadable > 0) deps.log.warn('立即探测：有操作记录认不出', { unreadable });
    return reply(c, RouteProbeStatusResponse, { asOf: now.toISOString(), engine, requests });
  });

  app.post(WebRoutes.routeProbeNow.path, async (c) => {
    const body = await readJson(c, RouteProbeNowRequest);
    const engine = await engineProbe();
    refuseWhenEngineAway(engine);
    if (body.routeIds) {
      const known = new Set((await deps.store.listRoutes()).map((r) => r.id));
      const missing = body.routeIds.filter((id) => !known.has(id));
      if (missing.length > 0)
        throw new ApiError(404, 'route_not_found', `没有这条路由：${missing.join('、')}`);
    }
    const requestId = randomUUID();
    const routeIds = body.routeIds ? [...new Set(body.routeIds)] : null;
    await deps.store.appendAudit({
      actor: actorOf(c),
      action: ROUTE_PROBE_ACTION.request,
      target: ROUTE_PROBE_TARGET,
      after: { requestId, routeIds },
      reason:
        body.reason ??
        (routeIds ? `驾驶舱上点了立即探测（${routeIds.length} 条）` : '驾驶舱上点了全部立即探测'),
      via: c.get('via'),
      ok: true,
    });
    return reply(c, RouteProbeNowResponse, {
      request: {
        requestId,
        requestedAt: deps.now().toISOString(),
        by: c.get('user').id,
        ...(routeIds ? { routeIds } : {}),
        state: 'queued',
        results: [],
      },
      engine,
    });
  });
}
