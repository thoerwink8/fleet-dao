// 立即探测走到哪（foldRouteProbeRequests）：后端给页面看、引擎找没人接的都用这一份。
// 故意造出的失败：认不出的记录数进 unreadable（不丢、不瞎拼），接手太久没回结果当没探成。
import { describe, expect, it } from 'vitest';
import {
  foldRouteProbeRequests,
  ROUTE_PROBE_ACTION,
  ROUTE_PROBE_RUNNING_LIMIT_MS,
  ROUTE_PROBE_UNCLAIMED_WARN_MS,
  type RouteProbeAuditRow,
} from '../src/route-probe-now.ts';

const T0 = new Date('2026-10-07T07:00:00.000Z');
const at = (ms: number) => new Date(T0.getTime() + ms);
const row = (
  action: string,
  after: unknown,
  when = T0,
  ok = true,
  error: string | null = null,
): RouteProbeAuditRow => ({
  at: when,
  action,
  actorId: action === ROUTE_PROBE_ACTION.request ? 'founder' : 'engine:route-probe-now',
  after,
  ok,
  error,
});

describe('foldRouteProbeRequests', () => {
  it('点了 → 接手 → 探完：queued、running、done 一步一步变；新的在前', () => {
    const req = row(ROUTE_PROBE_ACTION.request, { requestId: 'a', routeIds: ['r1'] });
    expect(foldRouteProbeRequests([req], T0).requests[0]).toMatchObject({
      state: 'queued',
      routeIds: ['r1'],
    });
    const start = row(ROUTE_PROBE_ACTION.start, { requestId: 'a' }, at(1000));
    expect(foldRouteProbeRequests([req, start], at(2000)).requests[0]?.state).toBe('running');
    const result = {
      routeId: 'r1',
      outcome: 'ok',
      detail: '答上了：OK · 用时 9 秒',
      at: at(9000).toISOString(),
    };
    const done = row(ROUTE_PROBE_ACTION.done, { requestId: 'a', results: [result] }, at(9000));
    const later = row(ROUTE_PROBE_ACTION.request, { requestId: 'b', routeIds: null }, at(10_000));
    const { requests } = foldRouteProbeRequests([done, later, start, req], at(10_000));
    expect(requests.map((r) => [r.requestId, r.state])).toEqual([
      ['b', 'queued'],
      ['a', 'done'],
    ]);
    expect(requests[1]?.results).toEqual([result]);
    expect(requests[0]?.routeIds).toBeUndefined();
  });

  it('同一毫秒里记下的接手排在点击前面读回来，也认得出', () => {
    const req = row(ROUTE_PROBE_ACTION.request, { requestId: 'a', routeIds: null });
    const start = row(ROUTE_PROBE_ACTION.start, { requestId: 'a' });
    const { requests, unreadable } = foldRouteProbeRequests([start, req], T0);
    expect(unreadable).toBe(0);
    expect(requests[0]?.state).toBe('running');
  });

  it('等太久没人接手：先提醒、过了期限作废', () => {
    const req = row(ROUTE_PROBE_ACTION.request, { requestId: 'a', routeIds: null });
    const warn = foldRouteProbeRequests([req], at(ROUTE_PROBE_UNCLAIMED_WARN_MS + 1000)).requests[0];
    expect(warn).toMatchObject({ state: 'queued', why: expect.stringContaining('还没接手') });
    expect(foldRouteProbeRequests([req], at(11 * 60_000)).requests[0]?.state).toBe('expired');
  });

  it('【故意造出的失败】接手太久没回结果：failed，不一直挂「探测中」', () => {
    const req = row(ROUTE_PROBE_ACTION.request, { requestId: 'a', routeIds: null });
    const start = row(ROUTE_PROBE_ACTION.start, { requestId: 'a' });
    const got = foldRouteProbeRequests([req, start], at(ROUTE_PROBE_RUNNING_LIMIT_MS + 1)).requests[0];
    expect(got).toMatchObject({ state: 'failed', why: expect.stringContaining('没回结果') });
  });

  it('引擎说没探成：failed，原因原样', () => {
    const req = row(ROUTE_PROBE_ACTION.request, { requestId: 'a', routeIds: null });
    const done = row(
      ROUTE_PROBE_ACTION.done,
      { requestId: 'a', results: [] },
      at(1000),
      false,
      '读路由表没成：连不上库',
    );
    expect(foldRouteProbeRequests([req, done], at(2000)).requests[0]).toMatchObject({
      state: 'failed',
      why: '读路由表没成：连不上库',
    });
  });

  it('【故意造出的失败】认不出的记录数进 unreadable：形状不对、接手找不到点击、别的动作', () => {
    const { requests, unreadable } = foldRouteProbeRequests(
      [
        row(ROUTE_PROBE_ACTION.request, { requestId: '' }),
        row(ROUTE_PROBE_ACTION.start, { requestId: 'nobody' }),
        row('routing.probe.whatever', {}),
      ],
      T0,
    );
    expect(requests).toEqual([]);
    expect(unreadable).toBe(3);
  });
});
