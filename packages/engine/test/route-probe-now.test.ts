// 驾驶舱的立即探测（驾驶舱改版 2026-10-07）：引擎看一眼操作记录，没人接手的就接手、照定时那一轮的探法探、写结论、回执。
// 故意造出的失败：读不到路由（回执写没探成）、接手记不上（不探）、路由不在了（gone）、探针自己抛（failed、不写成通）。
import type { RouteProbeTarget } from '@fleet-dao/db';
import { ROUTE_PROBE_ACTION, ROUTE_PROBE_REQUEST_TTL_MS, type RouteProbeAuditRow } from '@fleet-dao/shared';
import { describe, expect, it } from 'vitest';
import { conclude, type RouteProbeJobDeps } from '../src/jobs/route-probe.ts';
import {
  createProbeLock,
  type RouteProbeNowDeps,
  runRouteProbeRequests,
} from '../src/jobs/route-probe-now.ts';

const NOW = new Date('2026-10-07T07:00:00.000Z');

function target(over: Partial<RouteProbeTarget> = {}): RouteProbeTarget {
  return {
    routeId: 'mirasim-relay:deepseek-flash:mirasim',
    hostId: 'mirasim',
    channelId: 'mirasim',
    channelName: 'Mirasim 中转',
    billing: 'subscription',
    channelEnabled: true,
    poolId: 'mirasim-relay',
    runAsUser: null,
    orgKind: null,
    modelId: 'deepseek-flash',
    modelName: 'DeepSeek flash',
    upstreamModel: 'deepseek-flash',
    modelRetiredAt: null,
    inUse: true,
    alive: true,
    // 上一次刚探通：定时那一轮会「还没到再探的时候」照旧；人点的要真探
    previous: { state: 'ok', at: new Date(NOW.getTime() - 5 * 60_000), detail: '答上了：OK · 用时 7 秒' },
    ...over,
  };
}

const request = (requestId: string, routeIds: string[] | null, at = NOW): RouteProbeAuditRow => ({
  at,
  action: ROUTE_PROBE_ACTION.request,
  actorId: 'founder',
  after: { requestId, routeIds },
  ok: true,
  error: null,
});

function harness(
  rows: RouteProbeAuditRow[],
  targets: RouteProbeTarget[],
  over: Partial<RouteProbeJobDeps> = {},
) {
  const started: string[] = [];
  const done: Parameters<RouteProbeNowDeps['done']>[0][] = [];
  const saved: { routeId: string; state: string; detail: string }[] = [];
  let probes = 0;
  const probe: RouteProbeJobDeps = {
    targets: async () => targets,
    probers: {
      mirasim: async () => {
        probes += 1;
        return { kind: 'failed', detail: '本机到平台的网络不通或太慢，设备验证没能完成' };
      },
    },
    sessionOrg: async () => ({ ok: true, org: 'carpool' }),
    save: async (w) => {
      saved.push({ routeId: w.routeId, state: w.state, detail: w.detail });
      return 'saved';
    },
    runs: { start: async () => 1, finish: async () => {} },
    now: () => NOW,
    sleep: async () => {},
    log: () => {},
    ...over,
  };
  const deps: RouteProbeNowDeps = {
    rows: async () => rows,
    start: async (id) => {
      started.push(id);
    },
    done: async (input) => {
      done.push(input);
    },
    probe: () => probe,
    lock: createProbeLock(),
    now: () => NOW,
    log: () => {},
  };
  return { deps, started, done, saved, probes: () => probes };
}

describe('立即探测（runRouteProbeRequests）', () => {
  it('没人接手的：接手、真探（上一次刚探通也探）、写结论、回执带原文', async () => {
    const t = target();
    const h = harness([request('a', [t.routeId])], [t]);
    expect(await runRouteProbeRequests(h.deps)).toBe(1);
    expect(h.started).toEqual(['a']);
    // 没通隔一会儿再探一次：两次
    expect(h.probes()).toBe(2);
    expect(h.saved).toEqual([
      { routeId: t.routeId, state: 'failed', detail: expect.stringContaining('设备验证没能完成') },
    ]);
    expect(h.done).toHaveLength(1);
    expect(h.done[0]).toMatchObject({ requestId: 'a', ok: true });
    expect(h.done[0]?.results).toEqual([
      expect.objectContaining({ routeId: t.routeId, outcome: 'failed', durationMs: 0 }),
    ]);
  });

  it('已接手、已作废的不再接；全部 = 库里每一条', async () => {
    const a = target();
    const b = target({ routeId: 'mirasim-relay:glm-5.3-flash:mirasim', modelId: 'glm-5.3-flash' });
    const startedRow: RouteProbeAuditRow = {
      at: NOW,
      action: ROUTE_PROBE_ACTION.start,
      actorId: 'engine:route-probe-now',
      after: { requestId: 'old' },
      ok: true,
      error: null,
    };
    const h = harness(
      [
        request('old', null),
        startedRow,
        request('stale', null, new Date(NOW.getTime() - ROUTE_PROBE_REQUEST_TTL_MS - 1)),
        request('all', null),
      ],
      [a, b],
    );
    expect(await runRouteProbeRequests(h.deps)).toBe(1);
    expect(h.started).toEqual(['all']);
    expect(h.done[0]?.results.map((r) => r.routeId)).toEqual([a.routeId, b.routeId]);
  });

  it('没人点：不接、不探', async () => {
    const h = harness([], [target()]);
    expect(await runRouteProbeRequests(h.deps)).toBe(0);
    expect(h.probes()).toBe(0);
  });

  it('按量计费的照规矩不探：结论写明为什么（skipped），不写成通', async () => {
    const t = target({ billing: 'metered' });
    const h = harness([request('a', [t.routeId])], [t]);
    await runRouteProbeRequests(h.deps);
    expect(h.probes()).toBe(0);
    expect(h.done[0]?.results[0]).toMatchObject({
      outcome: 'skipped',
      detail: expect.stringContaining('按量计费'),
    });
    expect(h.done[0]?.results[0]?.durationMs).toBeUndefined();
  });

  it('没有用途在用的路由：立即探测照样真探（#1630），同一条走定时那一轮不探', async () => {
    const t = target({ inUse: false, previous: null });
    let calls = 0;
    const answering: Partial<RouteProbeJobDeps> = {
      probers: {
        mirasim: async () => {
          calls += 1;
          return { kind: 'answered', detail: '答上了：OK' };
        },
      },
    };
    const h = harness([request('a', [t.routeId])], [t], answering);
    await runRouteProbeRequests(h.deps);
    expect(calls).toBe(1);
    expect(h.done[0]?.results[0]).toMatchObject({ outcome: 'ok' });
    expect(h.saved).toEqual([{ routeId: t.routeId, state: 'ok', detail: expect.any(String) }]);

    calls = 0;
    const scheduled = await conclude(h.deps.probe(), t, { pace: true });
    expect(calls).toBe(0);
    expect(scheduled).toMatchObject({
      state: 'skipped',
      detail: expect.stringContaining('没有哪个阶段在用'),
    });
  });

  it('没用途在用、又是按量计费的：立即探测也不探', async () => {
    const t = target({ inUse: false, billing: 'metered' });
    const h = harness([request('a', [t.routeId])], [t]);
    await runRouteProbeRequests(h.deps);
    expect(h.probes()).toBe(0);
    expect(h.done[0]?.results[0]).toMatchObject({
      outcome: 'skipped',
      detail: expect.stringContaining('按量计费'),
    });
  });

  it('退避还没到点也照探：次数接着加，不从 1 重新数', async () => {
    const t = target({
      alive: false,
      previous: {
        state: 'failed',
        at: new Date(NOW.getTime() - 10 * 60_000),
        detail: '503 容量满。退避中，下次约 18:00 再探（连着不通 5 次）',
      },
    });
    const h = harness([request('a', [t.routeId])], [t]);
    expect(await runRouteProbeRequests(h.deps)).toBe(1);
    expect(h.probes()).toBe(2);
    expect(h.saved[0]?.detail).toContain('连着不通 6 次');
    expect(h.saved[0]?.detail).toContain('退避中，下次约');
    expect(h.saved[0]?.detail).not.toContain('连着不通 1 次');
  });

  it('【故意造出的失败】读不到路由表：回执 ok=false 写原因，不探', async () => {
    const t = target();
    const h = harness([request('a', [t.routeId])], [t], {
      targets: async () => {
        throw new Error('连不上库');
      },
    });
    await runRouteProbeRequests(h.deps);
    expect(h.probes()).toBe(0);
    expect(h.done[0]).toMatchObject({ ok: false, error: expect.stringContaining('读路由表没成：连不上库') });
  });

  it('【故意造出的失败】路由不在了：gone，不探', async () => {
    const h = harness([request('a', ['no-such'])], [target()]);
    await runRouteProbeRequests(h.deps);
    expect(h.probes()).toBe(0);
    expect(h.done[0]?.results).toEqual([expect.objectContaining({ routeId: 'no-such', outcome: 'gone' })]);
  });

  it('【故意造出的失败】接手记不上：抛，不探', async () => {
    const t = target();
    const h = harness([request('a', [t.routeId])], [t]);
    h.deps.start = async () => {
      throw new Error('写不进库');
    };
    await expect(runRouteProbeRequests(h.deps)).rejects.toThrow('写不进库');
    expect(h.probes()).toBe(0);
  });

  it('和定时那一轮共用一把锁：锁被占着时等它放开才探', async () => {
    const t = target();
    const h = harness([request('a', [t.routeId])], [t]);
    let release: () => void = () => {};
    const held = h.deps.lock.run(() => new Promise<void>((r) => (release = r)));
    const run = runRouteProbeRequests(h.deps);
    await new Promise((r) => setTimeout(r, 10));
    expect(h.started).toEqual(['a']);
    expect(h.probes()).toBe(0);
    release();
    await held;
    await run;
    expect(h.probes()).toBe(2);
  });
});
