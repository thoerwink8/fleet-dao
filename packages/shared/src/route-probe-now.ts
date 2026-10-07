// 立即探测（驾驶舱改版，创始人 2026-10-07「渠道状态无法探测」）：驾驶舱点一下、引擎接手、探完回结论，三步各记一条操作记录
// （audit_log，target 一律 routing:probe）。一次立即探测现在走到哪不另存，读的时候从这三种记录现算：后端给页面看、引擎找没人接的，
// 都用这里同一份判法，两边不会各算各的。
// 改这里之前必须知道：
// - 点了太久没人接手（ROUTE_PROBE_REQUEST_TTL_MS）就作废，引擎也不再接：免得引擎停了一夜、一起来把隔夜点的全探一遍。
// - 接手了太久没回结果（ROUTE_PROBE_RUNNING_LIMIT_MS）当没探成：引擎多半中途重启了，不拿「探测中」一直挂着。
// - 认不出的记录（字段对不上）不当没有：数进 unreadable，调用方写日志、页面写明有几条没读懂。

import { z } from 'zod';
import { RouteProbeResultSchema } from './web-api/routing.ts';

export const ROUTE_PROBE_TARGET = 'routing:probe';
export const ROUTE_PROBE_ACTION = {
  request: 'routing.probe.request',
  start: 'routing.probe.start',
  done: 'routing.probe.done',
} as const;
/** 引擎多久看一眼有没有人点（毫秒）。 */
export const ROUTE_PROBE_POLL_MS = 5_000;
/** 点了这么久引擎还没接手：还在排队，但提醒一句（引擎回来照样接）。 */
export const ROUTE_PROBE_UNCLAIMED_WARN_MS = 60_000;
/** 点了这么久引擎还没接手：作废，引擎也不再接。 */
export const ROUTE_PROBE_REQUEST_TTL_MS = 10 * 60_000;
/** 引擎接手这么久还没回结果：当没探成。一条路由最多探两次、每次起一个会话，几分钟够了。 */
export const ROUTE_PROBE_RUNNING_LIMIT_MS = 20 * 60_000;
/** 页面上列最近多久点过的。 */
export const ROUTE_PROBE_LIST_WINDOW_MS = 24 * 60 * 60_000;

/** 操作记录里的一行，只取用得上的几样。 */
export interface RouteProbeAuditRow {
  at: Date;
  action: string;
  actorId: string;
  after: unknown;
  ok: boolean;
  error: string | null;
}

export type RouteProbeResult = z.infer<typeof RouteProbeResultSchema>;

/** 记录里 after 的三种形状。 */
export const RouteProbeRequestRecord = z.object({
  requestId: z.string().min(1),
  /** null = 全部路由。 */
  routeIds: z.array(z.string().min(1)).nullable(),
});
export const RouteProbeStartRecord = z.object({ requestId: z.string().min(1) });
export const RouteProbeDoneRecord = z.object({
  requestId: z.string().min(1),
  results: z.array(RouteProbeResultSchema),
});

export interface RouteProbeRequestView {
  requestId: string;
  requestedAt: string;
  by: string;
  routeIds?: string[];
  state: 'queued' | 'running' | 'done' | 'failed' | 'expired';
  startedAt?: string;
  finishedAt?: string;
  why?: string;
  results: RouteProbeResult[];
}

function minutes(ms: number): number {
  return Math.round(ms / 60_000);
}

/**
 * 把 routing:probe 的操作记录并成一次一次的立即探测，新的在前。rows 不要求有序。
 * 认不出的记录（after 对不上形状、开始 / 结束找不到对应的点击）数进 unreadable，不丢也不瞎拼。
 */
export function foldRouteProbeRequests(
  rows: readonly RouteProbeAuditRow[],
  now: Date,
): { requests: RouteProbeRequestView[]; unreadable: number } {
  let unreadable = 0;
  // 点击先收、再收接手和探完：同一毫秒里记下的几条，读回的先后不一定是写的先后
  const rank = (action: string) => (action === ROUTE_PROBE_ACTION.request ? 0 : 1);
  const sorted = [...rows].sort((a, b) => rank(a.action) - rank(b.action) || a.at.getTime() - b.at.getTime());
  const byId = new Map<
    string,
    {
      requestedAt: Date;
      by: string;
      routeIds: string[] | null;
      startedAt?: Date;
      done?: { at: Date; ok: boolean; error: string | null; results: RouteProbeResult[] };
    }
  >();
  for (const row of sorted) {
    if (row.action === ROUTE_PROBE_ACTION.request) {
      const parsed = RouteProbeRequestRecord.safeParse(row.after);
      if (!parsed.success || byId.has(parsed.data.requestId)) {
        unreadable += 1;
        continue;
      }
      byId.set(parsed.data.requestId, {
        requestedAt: row.at,
        by: row.actorId,
        routeIds: parsed.data.routeIds,
      });
    } else if (row.action === ROUTE_PROBE_ACTION.start) {
      const parsed = RouteProbeStartRecord.safeParse(row.after);
      const req = parsed.success ? byId.get(parsed.data.requestId) : undefined;
      if (!req) {
        unreadable += 1;
        continue;
      }
      req.startedAt ??= row.at;
    } else if (row.action === ROUTE_PROBE_ACTION.done) {
      // 没跑成的那一条可能不带 results（after 里只有 requestId）：按空结果收
      const parsed = RouteProbeDoneRecord.safeParse(row.after);
      const id = parsed.success
        ? parsed.data.requestId
        : RouteProbeStartRecord.safeParse(row.after).data?.requestId;
      const req = id === undefined ? undefined : byId.get(id);
      if (!req || (row.ok && !parsed.success)) {
        unreadable += 1;
        continue;
      }
      req.done = {
        at: row.at,
        ok: row.ok,
        error: row.error,
        results: parsed.success ? parsed.data.results : [],
      };
    } else {
      unreadable += 1;
    }
  }

  const t = now.getTime();
  const requests = [...byId.entries()].map(([requestId, r]): RouteProbeRequestView => {
    const base = {
      requestId,
      requestedAt: r.requestedAt.toISOString(),
      by: r.by,
      ...(r.routeIds ? { routeIds: r.routeIds } : {}),
      ...(r.startedAt ? { startedAt: r.startedAt.toISOString() } : {}),
    };
    if (r.done) {
      return {
        ...base,
        state: r.done.ok ? 'done' : 'failed',
        finishedAt: r.done.at.toISOString(),
        ...(r.done.ok ? {} : { why: r.done.error ?? '引擎说没探成，没写原因' }),
        results: r.done.results,
      };
    }
    if (r.startedAt) {
      const age = t - r.startedAt.getTime();
      if (age > ROUTE_PROBE_RUNNING_LIMIT_MS) {
        return {
          ...base,
          state: 'failed',
          why: `引擎 ${minutes(age)} 分钟前接手，到现在没回结果（多半中途重启了）：这一次没探成，再点一次`,
          results: [],
        };
      }
      return { ...base, state: 'running', results: [] };
    }
    const waited = t - r.requestedAt.getTime();
    if (waited > ROUTE_PROBE_REQUEST_TTL_MS) {
      return {
        ...base,
        state: 'expired',
        why: `点了 ${minutes(waited)} 分钟引擎都没接手，作废了：引擎没在跑，或还没发到带「立即探测」的版本`,
        results: [],
      };
    }
    return {
      ...base,
      state: 'queued',
      ...(waited > ROUTE_PROBE_UNCLAIMED_WARN_MS
        ? {
            why: `已经 ${Math.round(waited / 1000)} 秒引擎还没接手：引擎可能停着、正卡在别的事上，或还没发到带「立即探测」的版本`,
          }
        : {}),
      results: [],
    };
  });
  requests.sort((a, b) => b.requestedAt.localeCompare(a.requestedAt));
  return { requests, unreadable };
}
