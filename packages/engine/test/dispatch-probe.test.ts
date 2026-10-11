// 派单前探测（#1409）：上一次结论超过 5 分钟才当场探；探不通换下一条；三条都不通就停下并写出每条结果。
// 按量计费不探。故意造出的失败放最后：探针自己抛，按不通记，不写成通。
import type { RouteProbeTarget } from '@fleet-dao/db';
import { describe, expect, it } from 'vitest';
import { probeAssignedRoute } from '../src/jobs/dispatch-probe.ts';
import { DISPATCH_PROBE_FRESH_MS, type RouteProbeJobDeps } from '../src/jobs/route-probe.ts';
import { createProbeLock } from '../src/jobs/route-probe-now.ts';
import {
  afterDispatchProbe,
  DISPATCH_PROBE_LIMIT,
  dispatchProbeLine,
  dispatchProbeStopText,
  EMPTY_DISPATCH_PROBE,
  withDispatchProbeNote,
} from '../src/workflows/task-support.ts';

const NOW = new Date('2026-10-09T08:00:00.000Z');
const FRESH_MS = 5 * 60_000;

function target(over: Partial<RouteProbeTarget> = {}): RouteProbeTarget {
  return {
    routeId: 'claude-pool:deepseek-flash:claude-code',
    hostId: 'claude-code',
    channelId: 'claude',
    channelName: 'Claude',
    billing: 'subscription',
    channelEnabled: true,
    identityCheck: false,
    poolId: 'mirasim-relay',
    runAsUser: null,
    orgKind: null,
    modelId: 'deepseek-flash',
    modelName: 'DeepSeek flash',
    upstreamModel: 'deepseek-flash',
    modelRetiredAt: null,
    inUse: true,
    alive: true,
    lastRunAt: null,
    failStreak: 0,
    previous: { state: 'ok', at: new Date(NOW.getTime() - 6 * 60_000), detail: '答上了：OK' },
    ...over,
  };
}

function harness(targets: RouteProbeTarget[], over: Partial<RouteProbeJobDeps> = {}) {
  const saved: { routeId: string; state: string; detail: string }[] = [];
  let probes = 0;
  const deps: RouteProbeJobDeps = {
    targets: async () => targets,
    probers: {
      'claude-code': async () => {
        probes += 1;
        return { kind: 'answered', detail: '答上了：OK' };
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
  return { deps, saved, probes: () => probes, setProbes: (n: number) => (probes = n) };
}

describe('派前探测', () => {
  it('5 分钟是常量，放在定时探针旁边', () => {
    expect(DISPATCH_PROBE_FRESH_MS).toBe(FRESH_MS);
    expect(DISPATCH_PROBE_LIMIT).toBe(3);
  });

  it('上一次探通还在 5 分钟内（含刚好 5 分钟）：不重复探、不改写结论', async () => {
    for (const age of [4 * 60_000, FRESH_MS]) {
      const t = target({
        previous: { state: 'ok', at: new Date(NOW.getTime() - age), detail: '答上了：OK' },
      });
      const h = harness([t]);
      const got = await probeAssignedRoute(h.deps, createProbeLock(), {
        routeId: t.routeId,
        label: t.modelId,
      });
      expect(h.probes()).toBe(0);
      expect(h.saved).toEqual([]);
      expect(got).toMatchObject({ kind: 'pass', probed: false, label: t.modelId });
    }
  });

  it('上一次结论已经超过 5 分钟：当场探，探通写进 routes 同一处', async () => {
    for (const age of [FRESH_MS + 1, 6 * 60_000]) {
      const t = target({
        previous: { state: 'ok', at: new Date(NOW.getTime() - age), detail: '答上了：旧的' },
      });
      const h = harness([t]);
      const got = await probeAssignedRoute(h.deps, createProbeLock(), {
        routeId: t.routeId,
        label: t.modelId,
      });
      expect(h.probes()).toBe(1);
      expect(h.saved).toEqual([
        { routeId: t.routeId, state: 'ok', detail: expect.stringContaining('答上了') },
      ]);
      expect(got).toMatchObject({ kind: 'pass', probed: true, label: t.modelId });
    }
  });

  it('按需探测的路由（上一次结论 on_demand、alive 为 false）：派前探一次，探通就派，写回通（#1635）', async () => {
    const t = target({
      alive: false,
      probeRank: 5,
      previous: {
        state: 'on_demand',
        at: new Date(NOW.getTime() - 3 * 3_600_000),
        detail: '不主动探，要派给它时先探一次。上一次真探：通，10-09 08:00',
      },
    });
    const h = harness([t]);
    const got = await probeAssignedRoute(h.deps, createProbeLock(), { routeId: t.routeId, label: t.modelId });
    expect(h.probes()).toBe(1);
    expect(got).toMatchObject({ kind: 'pass', probed: true });
    expect(h.saved).toEqual([{ routeId: t.routeId, state: 'ok', detail: expect.stringContaining('答上了') }]);
  });

  it('按需探测的路由探不通：记成不通（退避照现在的规矩），本轮换下一条', async () => {
    const t = target({
      alive: false,
      probeRank: 5,
      previous: {
        state: 'on_demand',
        at: new Date(NOW.getTime() - 3_600_000),
        detail: '不主动探，要派给它时先探一次。还没真探过',
      },
    });
    const h = harness([t], {
      probers: { 'claude-code': async () => ({ kind: 'failed', detail: '网络不通' }) },
    });
    const got = await probeAssignedRoute(h.deps, createProbeLock(), { routeId: t.routeId, label: t.modelId });
    expect(got).toMatchObject({ kind: 'fail', counted: true });
    expect(h.saved).toEqual([
      { routeId: t.routeId, state: 'failed', detail: expect.stringContaining('连着不通 1 次') },
    ]);
  });

  it('探不通：记成不通，本轮换下一条', async () => {
    const t = target({ previous: null, modelId: 'glm-5.3-flash' });
    const h = harness([t], {
      probers: {
        'claude-code': async () => {
          h.setProbes(h.probes() + 1);
          return { kind: 'failed', detail: '网络不通' };
        },
      },
    });
    const got = await probeAssignedRoute(h.deps, createProbeLock(), { routeId: t.routeId, label: t.modelId });
    expect(got.kind).toBe('fail');
    if (got.kind !== 'fail') return;
    expect(got.counted).toBe(true);
    expect(h.saved).toEqual([
      { routeId: t.routeId, state: 'failed', detail: expect.stringContaining('网络不通') },
    ]);
    const decided = afterDispatchProbe(EMPTY_DISPATCH_PROBE, {
      label: got.label,
      detail: got.detail,
      passed: false,
      counted: got.counted,
    });
    expect(decided.action).toBe('pick');
    expect(dispatchProbeLine(decided.round.fails, 'deepseek-flash')).toBe(
      '派前探测：glm-5.3-flash 不通，换到 deepseek-flash',
    );
    expect(
      withDispatchProbeNote(['上一轮没提交', '派前探测：旧的 通'], dispatchProbeLine([], 'deepseek-flash')),
    ).toEqual(['上一轮没提交', '派前探测：deepseek-flash 通']);
  });

  it('三条都探不通：停下，并写出每条结果；没真探的不占这 3 条', () => {
    let round = EMPTY_DISPATCH_PROBE;
    const rows = [
      { label: 'glm-5.3-flash', detail: '网络不通' },
      { label: 'deepseek-flash', detail: '登录失效' },
      { label: 'kimi', detail: '上游超时' },
    ];
    let action: 'dispatch' | 'pick' | 'stop' = 'pick';
    for (const row of rows) {
      const decided = afterDispatchProbe(round, { ...row, passed: false, counted: true });
      round = decided.round;
      action = decided.action;
    }
    expect(action).toBe('stop');
    expect(round.probed).toBe(3);
    const text = dispatchProbeStopText(round, '剩下的都被禁令挡住');
    expect(text).toContain(
      '派前探测：glm-5.3-flash 不通（网络不通）；deepseek-flash 不通（登录失效）；kimi 不通（上游超时）',
    );
    expect(text).toContain('本轮已当场探 3 条，不再往下探');
    expect(text).toContain('其余候选：剩下的都被禁令挡住');
    expect(text).toContain('不起会话，等探针探通后再继续');
    const soft = afterDispatchProbe(EMPTY_DISPATCH_PROBE, {
      label: '按规矩没探',
      detail: '组织认不出',
      passed: false,
      counted: false,
    });
    expect(soft.action).toBe('pick');
    expect(soft.round.probed).toBe(0);
  });

  it('按量计费的路由不探，也不把「不探」写成不通', async () => {
    const t = target({ billing: 'metered', previous: null });
    const h = harness([t]);
    const got = await probeAssignedRoute(h.deps, createProbeLock(), { routeId: t.routeId, label: t.modelId });
    expect(h.probes()).toBe(0);
    expect(h.saved).toEqual([]);
    expect(got).toMatchObject({ kind: 'pass', probed: false });
  });

  it('放慢的执行方式上一次探通还没到再探的时候：不探、不改写，按上一次结论派', async () => {
    const t = target({
      routeId: 'mirasim-relay:glm-5.3-flash:mirasim',
      hostId: 'mirasim',
      modelId: 'glm-5.3-flash',
      previous: { state: 'ok', at: new Date(NOW.getTime() - 6 * 60_000), detail: '答上了：OK' },
    });
    let called = 0;
    const h = harness([t], {
      probers: {
        mirasim: async () => {
          called += 1;
          return { kind: 'answered', detail: '不该探到' };
        },
      },
    });
    const got = await probeAssignedRoute(h.deps, createProbeLock(), { routeId: t.routeId, label: t.modelId });
    expect(called).toBe(0);
    expect(h.saved).toEqual([]);
    expect(got).toMatchObject({ kind: 'pass', probed: false, label: 'glm-5.3-flash' });
  });

  it('组织这会儿定不下来，且没有探通的上一次结论：不当成通，不改写', async () => {
    for (const previous of [
      null,
      { state: 'failed' as const, at: new Date(NOW.getTime() - 6 * 60_000), detail: '上次没通' },
    ]) {
      const t = target({
        orgKind: 'carpool',
        alive: false,
        previous,
      });
      const h = harness([t], {
        sessionOrg: async () => ({ ok: false, pending: true, why: '切号中' }),
      });
      const got = await probeAssignedRoute(h.deps, createProbeLock(), {
        routeId: t.routeId,
        label: t.modelId,
      });
      expect(h.probes()).toBe(0);
      expect(h.saved).toEqual([]);
      expect(got.kind).toBe('fail');
      if (got.kind !== 'fail') return;
      expect(got.counted).toBe(false);
      expect(got.detail).not.toContain('答上了');
    }
  });

  it('组织这会儿定不下来，上一次探通：不探、不改写，按上一次结论派', async () => {
    const t = target({
      orgKind: 'carpool',
      alive: true,
      previous: { state: 'ok', at: new Date(NOW.getTime() - 6 * 60_000), detail: '答上了：OK' },
    });
    const h = harness([t], {
      sessionOrg: async () => ({ ok: false, pending: true, why: '切号中' }),
    });
    const got = await probeAssignedRoute(h.deps, createProbeLock(), { routeId: t.routeId, label: t.modelId });
    expect(h.probes()).toBe(0);
    expect(h.saved).toEqual([]);
    expect(got).toMatchObject({ kind: 'pass', probed: false });
  });

  it('组织认不出：该探却探不了，当不通且不把路由写成不在线', async () => {
    const t = target({
      orgKind: 'carpool',
      alive: true,
      previous: { state: 'ok', at: new Date(NOW.getTime() - 6 * 60_000), detail: '答上了：OK' },
    });
    const h = harness([t], {
      sessionOrg: async () => ({ ok: false, why: '输出认不出' }),
    });
    const got = await probeAssignedRoute(h.deps, createProbeLock(), { routeId: t.routeId, label: t.modelId });
    expect(h.probes()).toBe(0);
    expect(h.saved).toEqual([]);
    expect(got.kind).toBe('fail');
    if (got.kind !== 'fail') return;
    expect(got.counted).toBe(false);
    expect(got.detail).toContain('认不出');
  });

  it('按量计费、上一次结论是不通：不探、不改写，按上一次结论不派', async () => {
    const t = target({
      billing: 'metered',
      alive: false,
      previous: { state: 'failed', at: new Date(NOW.getTime() - 6 * 60_000), detail: '上次没通' },
    });
    const h = harness([t]);
    const got = await probeAssignedRoute(h.deps, createProbeLock(), { routeId: t.routeId, label: t.modelId });
    expect(h.probes()).toBe(0);
    expect(h.saved).toEqual([]);
    expect(got.kind).toBe('fail');
    if (got.kind !== 'fail') return;
    expect(got.counted).toBe(false);
    expect(got.detail).toContain('上次没通');
    const decided = afterDispatchProbe(EMPTY_DISPATCH_PROBE, {
      label: got.label,
      detail: got.detail,
      passed: false,
      counted: got.counted,
    });
    expect(decided.action).toBe('pick');
    expect(decided.round.probed).toBe(0);
  });

  it('按量计费、上一次结论不是通（skipped）：不探、不改写，不派', async () => {
    const t = target({
      billing: 'metered',
      alive: false,
      previous: {
        state: 'skipped',
        at: new Date(NOW.getTime() - 6 * 60_000),
        detail: '按量计费的渠道不自动探',
      },
    });
    const h = harness([t]);
    const got = await probeAssignedRoute(h.deps, createProbeLock(), { routeId: t.routeId, label: t.modelId });
    expect(h.probes()).toBe(0);
    expect(h.saved).toEqual([]);
    expect(got.kind).toBe('fail');
  });

  it('一条都没探到，候选一开始就被挡：停下通知写出每条原因', () => {
    const blocked =
      '第 1 条 glm-5.3-flash：不在线（探活或熔断判的）；第 2 条 deepseek-flash：不在线（探活或熔断判的）';
    const text = dispatchProbeStopText(EMPTY_DISPATCH_PROBE, blocked);
    expect(text.startsWith('派前探测：')).toBe(true);
    expect(text).toContain(blocked);
    expect(text).toContain('不起会话，等探针探通后再继续');
    expect(text).not.toContain('本轮已当场探 3 条');
    expect(text).not.toContain('派前探测：。');
  });

  it('探针探通但结论写不进 routes：按不通，不起会话', async () => {
    const t = target();
    const h = harness([t], {
      save: async () => {
        throw new Error('库写不进去');
      },
    });
    const got = await probeAssignedRoute(h.deps, createProbeLock(), {
      routeId: t.routeId,
      label: t.modelId,
    });
    expect(got.kind).toBe('fail');
    expect(got.kind).not.toBe('pass');
    if (got.kind !== 'fail') return;
    expect(got.counted).toBe(true);
    expect(got.detail).toContain('没写进库');
    expect(got.detail).toContain('库写不进去');
    expect(h.probes()).toBe(1);
    expect(h.saved).toEqual([]);
  });

  it('放慢的 grok-4.7 上一次探通还在 2 小时里：派前不探，按上一次结论派（通）', async () => {
    const t = target({
      routeId: 'grok:grok-4.7:grok',
      hostId: 'grok',
      modelId: 'grok-4.7',
      modelName: 'Grok 4.7',
      probeRank: 9,
      previous: { state: 'ok', at: new Date(NOW.getTime() - 70 * 60_000), detail: '答上了：OK' },
    });
    let called = 0;
    const h = harness([t], {
      probers: {
        grok: async () => {
          called += 1;
          return { kind: 'answered', detail: '不该探到' };
        },
      },
    });
    const got = await probeAssignedRoute(h.deps, createProbeLock(), {
      routeId: t.routeId,
      label: 'grok-4.7',
    });
    expect(called).toBe(0);
    expect(h.saved).toEqual([]);
    expect(got).toMatchObject({ kind: 'pass', probed: false, label: 'grok-4.7' });
  });

  it('【故意造出的失败】探测本身抛错：按不通处理，不写成通', async () => {
    const t = target({ previous: null });
    let probes = 0;
    const h = harness([t], {
      probers: {
        'claude-code': async () => {
          probes += 1;
          throw new Error('插头炸了');
        },
      },
    });
    const got = await probeAssignedRoute(h.deps, createProbeLock(), { routeId: t.routeId, label: t.modelId });
    expect(got.kind).toBe('fail');
    expect(got.kind).not.toBe('pass');
    if (got.kind !== 'fail') return;
    expect(got.counted).toBe(true);
    expect(probes).toBe(2);
    expect(h.saved).toEqual([
      { routeId: t.routeId, state: 'failed', detail: expect.stringContaining('探针自己出错') },
    ]);
    expect(got.detail).toContain('连探两次都没通');
    expect(got.detail).not.toContain('答上了');
  });
});
