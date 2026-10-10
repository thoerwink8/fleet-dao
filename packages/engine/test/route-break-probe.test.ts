// 任务在路由上断了当场排一次立即探测（#1636）：排的请求带单号和路由、10 分钟内同一条路由不重复排（人点的、自动的都算）、
// 排不成只记日志不抛。故意造出的失败：读记录抛、写记录抛（都回 failed，不往外抛）。
import { ROUTE_PROBE_ACTION, type RouteProbeAuditRow } from '@fleet-dao/shared';
import { describe, expect, it } from 'vitest';
import {
  ROUTE_BREAK_PROBE_DEDUPE_MS,
  type RouteBreakProbeDeps,
  scheduleRouteBreakProbe,
} from '../src/real/route-break-probe.ts';

const NOW = new Date('2026-10-10T10:00:00.000Z');
const ROUTE = 'mirasim-relay:deepseek-flash:mirasim';

const row = (
  action: string,
  after: unknown,
  at: Date,
  actorId = 'founder',
  ok = true,
): RouteProbeAuditRow => ({ at, action, actorId, after, ok, error: ok ? null : '没探成' });
const ago = (ms: number) => new Date(NOW.getTime() - ms);

function harness(rows: RouteProbeAuditRow[] = [], over: Partial<RouteBreakProbeDeps> = {}) {
  const requests: Parameters<RouteBreakProbeDeps['request']>[0][] = [];
  const logs: { level: string; message: string }[] = [];
  const deps: RouteBreakProbeDeps = {
    rows: async () => rows,
    request: async (r) => {
      requests.push(r);
    },
    now: () => NOW,
    log: (level, message) => logs.push({ level, message }),
    ...over,
  };
  return { deps, requests, logs };
}

describe('任务断链后排立即探测（scheduleRouteBreakProbe）', () => {
  it('排一次：请求只点那一条路由，带单号来源和「任务 #N 在这条路由上断了，自动探一次」', async () => {
    const h = harness();
    expect(await scheduleRouteBreakProbe(h.deps, { routeId: ROUTE, issueNumber: 1621 })).toBe('scheduled');
    expect(h.requests).toHaveLength(1);
    expect(h.requests[0]).toMatchObject({
      routeIds: [ROUTE],
      source: { kind: 'task-route-broken', issueNumber: 1621 },
      reason: '任务 #1621 在这条路由上断了，自动探一次',
      at: NOW,
    });
    expect(h.requests[0]?.requestId).toBeTruthy();
  });

  it('10 分钟里同一条路由第二次断：不再排（前一次还在排队）', async () => {
    const first = row(
      ROUTE_PROBE_ACTION.request,
      { requestId: 'a', routeIds: [ROUTE], source: { kind: 'task-route-broken', issueNumber: 1621 } },
      ago(60_000),
      'engine:route-probe-now',
    );
    const h = harness([first]);
    expect(await scheduleRouteBreakProbe(h.deps, { routeId: ROUTE, issueNumber: 1622 })).toBe('deduped');
    expect(h.requests).toHaveLength(0);
  });

  it('在探、刚探完（人点的）也算；点的是全部路由也算', async () => {
    const started = [
      row(ROUTE_PROBE_ACTION.request, { requestId: 'a', routeIds: [ROUTE] }, ago(120_000)),
      row(ROUTE_PROBE_ACTION.start, { requestId: 'a' }, ago(110_000), 'engine:route-probe-now'),
    ];
    expect(await scheduleRouteBreakProbe(harness(started).deps, { routeId: ROUTE, issueNumber: 1 })).toBe(
      'deduped',
    );
    const doneAt = ago(3 * 60_000);
    const finished = [
      row(ROUTE_PROBE_ACTION.request, { requestId: 'b', routeIds: null }, ago(5 * 60_000)),
      row(ROUTE_PROBE_ACTION.start, { requestId: 'b' }, ago(5 * 60_000 - 1000), 'engine:route-probe-now'),
      row(ROUTE_PROBE_ACTION.done, { requestId: 'b', results: [] }, doneAt, 'engine:route-probe-now'),
    ];
    expect(await scheduleRouteBreakProbe(harness(finished).deps, { routeId: ROUTE, issueNumber: 1 })).toBe(
      'deduped',
    );
  });

  it('别的路由排的、探完已超过 10 分钟的：照常排', async () => {
    const other = row(ROUTE_PROBE_ACTION.request, { requestId: 'o', routeIds: ['别的路由'] }, ago(1000));
    expect(await scheduleRouteBreakProbe(harness([other]).deps, { routeId: ROUTE, issueNumber: 1 })).toBe(
      'scheduled',
    );
    const old = [
      row(
        ROUTE_PROBE_ACTION.request,
        { requestId: 'c', routeIds: [ROUTE] },
        ago(ROUTE_BREAK_PROBE_DEDUPE_MS + 60_000),
      ),
      row(
        ROUTE_PROBE_ACTION.start,
        { requestId: 'c' },
        ago(ROUTE_BREAK_PROBE_DEDUPE_MS + 50_000),
        'engine:route-probe-now',
      ),
      row(
        ROUTE_PROBE_ACTION.done,
        { requestId: 'c', results: [] },
        ago(ROUTE_BREAK_PROBE_DEDUPE_MS + 40_000),
        'engine:route-probe-now',
      ),
    ];
    expect(await scheduleRouteBreakProbe(harness(old).deps, { routeId: ROUTE, issueNumber: 1 })).toBe(
      'scheduled',
    );
  });

  it('【故意造出的失败】读记录抛：只记 warn，不抛、不排', async () => {
    const h = harness([], {
      rows: async () => {
        throw new Error('库连不上');
      },
    });
    expect(await scheduleRouteBreakProbe(h.deps, { routeId: ROUTE, issueNumber: 1 })).toBe('failed');
    expect(h.requests).toHaveLength(0);
    expect(h.logs).toEqual([{ level: 'warn', message: expect.stringContaining('没成') }]);
  });

  it('【故意造出的失败】写记录抛：只记 warn，不抛', async () => {
    const h = harness([], {
      request: async () => {
        throw new Error('写不进库');
      },
    });
    expect(await scheduleRouteBreakProbe(h.deps, { routeId: ROUTE, issueNumber: 1 })).toBe('failed');
    expect(h.logs.map((l) => l.level)).toEqual(['warn']);
  });
});
