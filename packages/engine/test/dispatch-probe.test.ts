// 派单前探测（#1409）：上一次结论超过 15 分钟才当场探；探不通换下一条；三条都不通就停下并写出每条结果。
// 按量计费不探。故意造出的失败放最后：探针自己抛，按不通记，不写成通。
import { readFileSync } from 'node:fs';
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
  isDispatchProbePassOnly,
  withDispatchProbeNote,
} from '../src/workflows/task-support.ts';

const NOW = new Date('2026-10-09T08:00:00.000Z');
/** 新鲜线 15 分钟（#1798 片 4）：不分执行方式，cursor、grok、mirasim 和 Claude 同一条线。 */
const FRESH_MS = 15 * 60_000;

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
    // 默认：上一次探通已经过了新鲜线（20 分钟前），派前会真探一次
    previous: { state: 'ok', at: new Date(NOW.getTime() - 20 * 60_000), detail: '答上了：OK' },
    ...over,
  };
}

function harness(targets: RouteProbeTarget[], over: Partial<RouteProbeJobDeps> = {}) {
  const saved: {
    routeId: string;
    state: string;
    detail: string;
    trigger?: string | null | undefined;
  }[] = [];
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
      saved.push({ routeId: w.routeId, state: w.state, detail: w.detail, trigger: w.trigger });
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
  it('15 分钟是常量，放在定时探针旁边', () => {
    expect(DISPATCH_PROBE_FRESH_MS).toBe(15 * 60_000);
    expect(DISPATCH_PROBE_LIMIT).toBe(3);
  });

  it('上一次探通还在 15 分钟内（含刚好 15 分钟）：不重复探、不改写结论', async () => {
    for (const age of [14 * 60_000, FRESH_MS]) {
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

  it('上一次结论已经超过 15 分钟：当场探，探通写进 routes 同一处，历史记 trigger 为 dispatch', async () => {
    for (const age of [FRESH_MS + 1, 20 * 60_000]) {
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
        { routeId: t.routeId, state: 'ok', detail: expect.stringContaining('答上了'), trigger: 'dispatch' },
      ]);
      expect(got).toMatchObject({ kind: 'pass', probed: true, label: t.modelId });
    }
  });

  // #2700：定时这一轮不复探探通了的路由，在线结论可以停几十小时（法国 cursor 那几条停了 47 小时）。选路不信旧的「在线」：
  // 派之前当场探，探不通写成不在线、不派这一条
  it('在线、结论 47 小时前的路由：派前当场探；探不通写成 failed、不派', async () => {
    const t = target({
      hostId: 'cursor-agent',
      previous: { state: 'ok', at: new Date(NOW.getTime() - 47 * 3_600_000), detail: '答上了：旧的' },
    });
    let probes = 0;
    const h = harness([t], {
      probers: {
        'cursor-agent': async () => {
          probes += 1;
          return { kind: 'failed', detail: '连不上' };
        },
      },
    });
    const got = await probeAssignedRoute(h.deps, createProbeLock(), { routeId: t.routeId, label: t.modelId });
    expect(probes).toBeGreaterThan(0);
    expect(h.saved).toEqual([
      { routeId: t.routeId, state: 'failed', detail: expect.stringContaining('连不上'), trigger: 'dispatch' },
    ]);
    expect(got).toMatchObject({ kind: 'fail' });
  });

  // 原来的按需探测 on_demand 已删（#1843）：迁移把剩下的行改成 skipped、原文「改版后等下一轮探」，派前照样探一次。
  it('没探的路由（上一次结论 skipped、alive 为 false）：派前探一次，探通就派，写回通', async () => {
    const t = target({
      alive: false,
      probeRank: 5,
      previous: {
        state: 'skipped',
        at: new Date(NOW.getTime() - 3 * 3_600_000),
        detail: '改版后等下一轮探',
      },
    });
    const h = harness([t]);
    const got = await probeAssignedRoute(h.deps, createProbeLock(), { routeId: t.routeId, label: t.modelId });
    expect(h.probes()).toBe(1);
    expect(got).toMatchObject({ kind: 'pass', probed: true });
    expect(h.saved).toEqual([
      { routeId: t.routeId, state: 'ok', detail: expect.stringContaining('答上了'), trigger: 'dispatch' },
    ]);
  });

  it('没探的路由探不通：记成不通（退避照现在的规矩），本轮换下一条', async () => {
    const t = target({
      alive: false,
      probeRank: 5,
      previous: {
        state: 'skipped',
        at: new Date(NOW.getTime() - 3_600_000),
        detail: '改版后等下一轮探',
      },
    });
    const h = harness([t], {
      probers: { 'claude-code': async () => ({ kind: 'failed', detail: '网络不通' }) },
    });
    const got = await probeAssignedRoute(h.deps, createProbeLock(), { routeId: t.routeId, label: t.modelId });
    expect(got).toMatchObject({ kind: 'fail', counted: true });
    expect(h.saved).toEqual([
      {
        routeId: t.routeId,
        state: 'failed',
        detail: expect.stringContaining('连着不通 1 次'),
        trigger: 'dispatch',
      },
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
      {
        routeId: t.routeId,
        state: 'failed',
        detail: expect.stringContaining('网络不通'),
        trigger: 'dispatch',
      },
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
    expect(isDispatchProbePassOnly('派前探测：grok-4.7 通')).toBe(true);
    expect(isDispatchProbePassOnly('  派前探测：deepseek-flash 通  ')).toBe(true);
    expect(isDispatchProbePassOnly('派前探测：glm-5.3-flash 不通，换到 deepseek-flash')).toBe(false);
    expect(isDispatchProbePassOnly('派前探测：glm 不通（网络不通）')).toBe(false);
    expect(isDispatchProbePassOnly('派前探测：候选都被挡住（额度）')).toBe(false);
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

  it('不分执行方式：mirasim 上一次探通超过 15 分钟，派前照样真探，探通写回', async () => {
    const t = target({
      routeId: 'mirasim-relay:glm-5.3-flash:mirasim',
      hostId: 'mirasim',
      modelId: 'glm-5.3-flash',
      previous: { state: 'ok', at: new Date(NOW.getTime() - 20 * 60_000), detail: '答上了：OK' },
    });
    let called = 0;
    const h = harness([t], {
      probers: {
        mirasim: async () => {
          called += 1;
          return { kind: 'answered', detail: '答上了：OK' };
        },
      },
    });
    const got = await probeAssignedRoute(h.deps, createProbeLock(), { routeId: t.routeId, label: t.modelId });
    expect(called).toBe(1);
    expect(h.saved).toEqual([
      { routeId: t.routeId, state: 'ok', detail: expect.stringContaining('答上了'), trigger: 'dispatch' },
    ]);
    expect(got).toMatchObject({ kind: 'pass', probed: true, label: 'glm-5.3-flash' });
  });

  it('返工：cursor-auto（cursor-agent）上一次 30 分钟前探通，派前真探，探通写回', async () => {
    const t = target({
      routeId: 'cursor:cursor-auto:cursor-agent',
      hostId: 'cursor-agent',
      channelId: 'cursor',
      channelName: 'Cursor 订阅',
      poolId: 'cursor',
      modelId: 'cursor-auto',
      modelName: 'Cursor Auto',
      upstreamModel: 'auto',
      previous: { state: 'ok', at: new Date(NOW.getTime() - 30 * 60_000), detail: '答上了：旧的' },
    });
    let called = 0;
    const h = harness([t], {
      probers: {
        'cursor-agent': async () => {
          called += 1;
          return { kind: 'answered', detail: '答上了：OK' };
        },
      },
    });
    const got = await probeAssignedRoute(h.deps, createProbeLock(), {
      routeId: t.routeId,
      label: 'cursor-auto',
    });
    expect(called).toBe(1);
    expect(h.saved).toEqual([
      { routeId: t.routeId, state: 'ok', detail: expect.stringContaining('答上了'), trigger: 'dispatch' },
    ]);
    expect(got).toMatchObject({ kind: 'pass', probed: true, label: 'cursor-auto' });
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

  it('grok-4.7 上一次探通 30 分钟前：派前照样真探（15 分钟新鲜线，不分执行方式）', async () => {
    const t = target({
      routeId: 'grok:grok-4.7:grok',
      hostId: 'grok',
      modelId: 'grok-4.7',
      modelName: 'Grok 4.7',
      probeRank: 9,
      previous: { state: 'ok', at: new Date(NOW.getTime() - 30 * 60_000), detail: '答上了：OK' },
    });
    let called = 0;
    const h = harness([t], {
      probers: {
        grok: async () => {
          called += 1;
          return { kind: 'answered', detail: '答上了：OK' };
        },
      },
    });
    const got = await probeAssignedRoute(h.deps, createProbeLock(), {
      routeId: t.routeId,
      label: 'grok-4.7',
    });
    expect(called).toBe(1);
    expect(h.saved).toEqual([
      { routeId: t.routeId, state: 'ok', detail: expect.stringContaining('答上了'), trigger: 'dispatch' },
    ]);
    expect(got).toMatchObject({ kind: 'pass', probed: true, label: 'grok-4.7' });
  });

  // 验收条 2：dispatch-probe 里没有 kept 分支（上一次探通未满 2 小时就按上一次放行的那一支）。
  // 钉住它的做法：四条执行方式（claude-code、cursor-agent、grok、mirasim）各造一条「20 分钟前探通」的路由，
  // 派前一律真探、结论一律写回带 trigger: dispatch。只要谁再按执行方式放行（kept 回来），这里就有命中的那条不真探。
  it('不论执行方式：四条路由都是 20 分钟前探通，派前一律真探、一律写回', async () => {
    const hosts = [
      { hostId: 'claude-code', routeId: 'claude:a:claude-code', modelId: 'a' },
      { hostId: 'cursor-agent', routeId: 'cursor:b:cursor-agent', modelId: 'b' },
      { hostId: 'grok', routeId: 'grok:c:grok', modelId: 'c' },
      { hostId: 'mirasim', routeId: 'mirasim-relay:d:mirasim', modelId: 'd' },
    ] as const;
    const targets = hosts.map((host) =>
      target({
        routeId: host.routeId,
        hostId: host.hostId,
        modelId: host.modelId,
        previous: { state: 'ok', at: new Date(NOW.getTime() - 20 * 60_000), detail: '答上了：OK' },
      }),
    );
    const called: string[] = [];
    const h = harness(targets, {
      probers: Object.fromEntries(
        hosts.map((host) => [
          host.hostId,
          async () => {
            called.push(host.hostId);
            return { kind: 'answered', detail: '答上了：OK' };
          },
        ]),
      ),
    });
    for (const host of hosts) {
      const got = await probeAssignedRoute(h.deps, createProbeLock(), {
        routeId: host.routeId,
        label: host.modelId,
      });
      expect(got).toMatchObject({ kind: 'pass', probed: true });
    }
    expect(called).toEqual(['claude-code', 'cursor-agent', 'grok', 'mirasim']);
    expect(h.saved.map((s) => s.trigger)).toEqual(['dispatch', 'dispatch', 'dispatch', 'dispatch']);
  });

  // 验收条 2：上面那条测试钉的是「行为」——四条路由都真探。行为对得上，源码里却仍可能留着一支按执行方式放行的旁路
  // （只是这几条用例没走到），单看行为分不出来。所以再读 dispatch-probe.ts 的源码文本钉一次「没有这一支」：
  // 它原先的样子是 planProbe 回 { kept: … } 时按上一次结论直接放行，靠 hostId / 探针原文分执行方式。这里断言裁判
  // 只剩 freshOk 一处、且只认时刻，执行方式那些词一个都不在。
  it('dispatch-probe.ts 里没有「按执行方式放行」那一支：不读 hostId、不读探针原文、裁判只有 freshOk', () => {
    const src = readFileSync(new URL('../src/jobs/dispatch-probe.ts', import.meta.url), 'utf8');
    // 读到了真源码：没有这个函数就是读错文件了，不能当「没有那一支」悄悄放过
    expect(src).toContain('export async function probeAssignedRoute');
    expect(src).toContain('function freshOk(');
    // 那一支的特征词一个都不许在：kept 分支、按执行方式分、从探针原文抠节奏
    expect(src).not.toMatch(/kept/);
    expect(src).not.toMatch(/hostId/);
    expect(src).not.toMatch(/probeDetail/);
    expect(src).not.toMatch(/hostEvery|routeProbeEveryMinutes|routeProbeStaleMinutes|probeCadence/);
    // 【故意造出的失败】把那一支的原文喂进来，上面这几条必须能命中——证明它们真在挑这个，不是恒真
    const keptBranch =
      "if ('kept' in plan) return pass(label, plan.kept, false);\nif (t.hostId === 'grok') {}";
    expect(keptBranch).toMatch(/kept/);
    expect(keptBranch).toMatch(/hostId/);
    // 真探只由一个函数放行：只认时刻的那一处
    expect(src.match(/function freshOk\(/g)?.length).toBe(1);
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
      {
        routeId: t.routeId,
        state: 'failed',
        detail: expect.stringContaining('探针自己出错'),
        trigger: 'dispatch',
      },
    ]);
    expect(got.detail).toContain('连探两次都没通');
    expect(got.detail).not.toContain('答上了');
  });
});
