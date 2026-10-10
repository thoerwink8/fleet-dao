// 任务在路由上断了，当场给那条路由排一次立即探测（#1636，创始人 2026-10-10「任务在断链后立刻探测一下」）。
// 和驾驶舱「立即探测」同一条路：写一条 routing.probe.request（引擎的 jobs/route-probe-now.ts 几秒内接手，忽略节奏）。
// 改这里之前必须知道：
// - 同一条路由 ROUTE_BREAK_PROBE_DEDUPE_MS 内已经有一次在排队、在探、刚探完（不管人点的还是自动的）就不再排：
//   一批任务同时在一条路由上断，只探一次。判法读现有的请求记录，不另建表。
// - 排不成（读写库抛）只记日志，不抛：它不能挡工作流换渠道接着干。调用方不用再包 try。
import { randomUUID } from 'node:crypto';
import {
  foldRouteProbeRequests,
  ROUTE_PROBE_REQUEST_TTL_MS,
  type RouteProbeAuditRow,
  type RouteProbeSource,
} from '@fleet-dao/shared';
import { errMessage } from '@fleet-dao/shared/util';

/** 同一条路由多久内排过、探过就不再排（毫秒）。 */
export const ROUTE_BREAK_PROBE_DEDUPE_MS = 10 * 60_000;

export interface RouteBreakProbeDeps {
  /** since 之后 routing:probe 的操作记录（真实现 @fleet-dao/db 的 routeProbeAuditRows）。 */
  rows(since: Date): Promise<RouteProbeAuditRow[]>;
  /** 写一条立即探测请求（真实现 @fleet-dao/db 的 recordRouteProbeRequest）。 */
  request(input: {
    requestId: string;
    routeIds: string[];
    source: RouteProbeSource;
    reason: string;
    at: Date;
  }): Promise<void>;
  now: () => Date;
  log: (level: 'info' | 'warn', message: string, fields?: Record<string, unknown>) => void;
}

/** 返回 'scheduled' 排了一次、'deduped' 10 分钟内已有、'failed' 没排成（已记日志）。永不抛。 */
export async function scheduleRouteBreakProbe(
  deps: RouteBreakProbeDeps,
  input: { routeId: string; issueNumber: number },
): Promise<'scheduled' | 'deduped' | 'failed'> {
  try {
    const now = deps.now();
    const since = new Date(now.getTime() - Math.max(ROUTE_BREAK_PROBE_DEDUPE_MS, ROUTE_PROBE_REQUEST_TTL_MS));
    const { requests } = foldRouteProbeRequests(await deps.rows(since), now);
    const recent = (iso: string) => now.getTime() - Date.parse(iso) < ROUTE_BREAK_PROBE_DEDUPE_MS;
    const covered = requests.some((r) => {
      if (r.routeIds && !r.routeIds.includes(input.routeId)) return false;
      if (r.state === 'queued' || r.state === 'running') return true;
      return r.state === 'done' && recent(r.finishedAt ?? r.requestedAt);
    });
    if (covered) {
      deps.log('info', '任务断链：这条路由刚排过或探过立即探测，不重复排', input);
      return 'deduped';
    }
    const requestId = randomUUID();
    await deps.request({
      requestId,
      routeIds: [input.routeId],
      source: { kind: 'task-route-broken', issueNumber: input.issueNumber },
      reason: `任务 #${input.issueNumber} 在这条路由上断了，自动探一次`,
      at: now,
    });
    deps.log('info', '任务断链：已排一次立即探测', { ...input, requestId });
    return 'scheduled';
  } catch (err) {
    deps.log('warn', '任务断链：排立即探测没成（不挡换渠道）', { ...input, error: errMessage(err) });
    return 'failed';
  }
}
