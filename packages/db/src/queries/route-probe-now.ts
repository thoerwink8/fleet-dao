// 立即探测（驾驶舱改版 2026-10-07）的三种操作记录：驾驶舱记「点了」、引擎记「接手」「探完」，都在 audit_log、target 是
// routing:probe。一次立即探测走到哪由 shared 的 foldRouteProbeRequests 从这些记录现算，这里只管读写那几行。
// 没加表：点击本来就要记操作记录，再存一份状态就是同一件事两本账。
import {
  ROUTE_PROBE_ACTION,
  ROUTE_PROBE_TARGET,
  type RouteProbeAuditRow,
  type RouteProbeResult,
  type RouteProbeSource,
} from '@fleet-dao/shared';
import { and, eq, gte } from 'drizzle-orm';
import type { Db } from '../client.ts';
import { auditLog } from '../schema/index.ts';
import { recordEngineAudit } from './session-org.ts';

/** 引擎记接手、探完时写的「谁」。 */
export const ROUTE_PROBE_NOW_ACTOR = 'engine:route-probe-now';

/** since 之后（含）routing:probe 的全部操作记录。读不到原样抛（调用方写「没查成」，不当没人点过）。 */
export async function routeProbeAuditRows(db: Db, since: Date): Promise<RouteProbeAuditRow[]> {
  const rows = await db
    .select({
      at: auditLog.at,
      action: auditLog.action,
      actorId: auditLog.actorId,
      after: auditLog.after,
      ok: auditLog.ok,
      error: auditLog.error,
    })
    .from(auditLog)
    .where(and(eq(auditLog.target, ROUTE_PROBE_TARGET), gte(auditLog.at, since)));
  return rows;
}

/** 引擎接手了一次立即探测。写不进原样抛。 */
export function recordRouteProbeStart(db: Db, requestId: string, at: Date): Promise<void> {
  return recordEngineAudit(db, {
    action: ROUTE_PROBE_ACTION.start,
    target: ROUTE_PROBE_TARGET,
    actorId: ROUTE_PROBE_NOW_ACTOR,
    after: { requestId },
    ok: true,
    at,
  });
}

/**
 * 引擎自己排一次立即探测（任务在路由上断了，#1636）：和驾驶舱点一下同一条记录（routing.probe.request），
 * 只是 actor 是引擎、after 里带 source 说明是谁要的。写不进原样抛。
 */
export function recordRouteProbeRequest(
  db: Db,
  input: { requestId: string; routeIds: string[]; source: RouteProbeSource; reason: string; at: Date },
): Promise<void> {
  return recordEngineAudit(db, {
    action: ROUTE_PROBE_ACTION.request,
    target: ROUTE_PROBE_TARGET,
    actorId: ROUTE_PROBE_NOW_ACTOR,
    after: { requestId: input.requestId, routeIds: input.routeIds, source: input.source },
    reason: input.reason,
    ok: true,
    at: input.at,
  });
}

/** 一次立即探测探完了：ok 带每条的结论；没跑成写 error（必填）。写不进原样抛。 */
export function recordRouteProbeDone(
  db: Db,
  input: { requestId: string; at: Date } & (
    | { ok: true; results: RouteProbeResult[] }
    | { ok: false; error: string; results: RouteProbeResult[] }
  ),
): Promise<void> {
  return recordEngineAudit(db, {
    action: ROUTE_PROBE_ACTION.done,
    target: ROUTE_PROBE_TARGET,
    actorId: ROUTE_PROBE_NOW_ACTOR,
    after: { requestId: input.requestId, results: input.results },
    ok: input.ok,
    ...(input.ok ? {} : { error: input.error }),
    at: input.at,
  });
}
