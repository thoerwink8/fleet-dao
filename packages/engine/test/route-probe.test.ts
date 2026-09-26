// 路由探针（#129）的一轮：定探不探（插头没接、按量、下架、没阶段开着、会话用户挂着别的组织）、真探、没通隔一会儿再探、
// 写结论、记结局。读不到路由、写不进库、探针自己出错，每条路径都故意造一次，都不许记成 ok、也不许把路由写成在线。
import { randomUUID } from 'node:crypto';
import type { RouteProbeTarget, ScheduleResult } from '@fleet-dao/db';
import { WorkflowFailedError } from '@temporalio/client';
import { ApplicationFailure } from '@temporalio/common';
import { describe, expect, it } from 'vitest';
import type { EngineJobs } from '../src/activities.ts';
import { type RouteProbeRun, WORKFLOW_TYPES } from '../src/contract.ts';
import { createFakeWorld } from '../src/fakes.ts';
import {
  type ProbeAttempt,
  type Prober,
  planProbe,
  ROUTE_PROBE_JOB,
  ROUTE_PROBE_RETRY_DELAY_MS,
  type RouteProbeJobDeps,
  runRouteProbeJob,
} from '../src/jobs/route-probe.ts';
import { useEnv, withWorker } from './helpers.ts';

const NOW = new Date('2026-09-26T04:07:00.000Z');

function target(over: Partial<RouteProbeTarget> = {}): RouteProbeTarget {
  return {
    routeId: 'claude-carpool:opus-5.5:claude-code',
    hostId: 'claude-code',
    channelId: 'claude-sub',
    channelName: 'Claude 订阅',
    billing: 'subscription',
    channelEnabled: true,
    poolId: 'claude-carpool',
    runAsUser: 'fleet-agent-carpool',
    orgKind: 'carpool',
    modelId: 'opus-5.5',
    modelName: 'Opus 5.5',
    upstreamModel: 'claude-opus-5-5',
    modelRetiredAt: null,
    inUse: true,
    alive: false,
    previous: null,
    ...over,
  };
}

const carpool = target();
const solo = target({ routeId: 'claude-solo:opus-5.5:claude-code', poolId: 'claude-solo', orgKind: 'solo' });
const mirasim = target({
  routeId: 'mirasim-relay:kimi-k3:mirasim',
  hostId: 'mirasim',
  channelId: 'mirasim',
  channelName: 'Mirasim 中转',
  poolId: 'mirasim-relay',
  runAsUser: null,
  orgKind: null,
  modelId: 'kimi-k3',
  modelName: 'Kimi k3',
  inUse: false,
});

interface Harness {
  deps: RouteProbeJobDeps;
  saved: { routeId: string; state: string; at: Date; detail: string }[];
  finished: { id: number; result: ScheduleResult }[];
  sleeps: number[];
  after: { routeId: string; attempt: ProbeAttempt }[];
  logs: string[];
}

function harness(targets: RouteProbeTarget[], probe: Prober, over: Partial<RouteProbeJobDeps> = {}): Harness {
  const saved: Harness['saved'] = [];
  const finished: Harness['finished'] = [];
  const sleeps: number[] = [];
  const after: Harness['after'] = [];
  const logs: string[] = [];
  const deps: RouteProbeJobDeps = {
    targets: async () => targets,
    probers: { 'claude-code': probe },
    liveOrg: 'carpool',
    save: async (w) => {
      saved.push(w);
      return 'saved';
    },
    afterProbe: async (t, attempt) => {
      after.push({ routeId: t.routeId, attempt });
    },
    runs: {
      async start() {
        return 11;
      },
      async finish(id, result) {
        finished.push({ id, result });
      },
    },
    now: () => NOW,
    sleep: async (ms) => {
      sleeps.push(ms);
    },
    log: (level, message) => logs.push(`${level}:${message}`),
    ...over,
  };
  return { deps, saved, finished, sleeps, after, logs };
}

const answered: Prober = async () => ({ kind: 'answered', detail: '答上了：OK · 用时 9 秒' });

describe('探不探（planProbe）', () => {
  const probers = { 'claude-code': answered };
  const plan = (t: RouteProbeTarget) => planProbe(t, probers, 'carpool', NOW);

  it('插头接上了、渠道开着、有阶段开着、会话用户挂着这个组织：探', () => {
    expect('probe' in plan(carpool)).toBe(true);
    // 不是 Claude 订阅池（没有组织）的也照探
    expect('probe' in plan(target({ orgKind: null }))).toBe(true);
  });

  it('插头还没接：记「插头还没接」（not_wired），不写成探过、离线', () => {
    expect(plan(mirasim)).toEqual({ state: 'not_wired', detail: expect.stringContaining('插头引擎还没接') });
  });

  it('按量计费：不探（探一次就是一笔账），哪怕插头接上了；插头没接的也照「按量不探」说，不说派不了', () => {
    expect(plan(target({ billing: 'metered' }))).toEqual({
      state: 'skipped',
      detail: expect.stringContaining('按量计费'),
    });
    // 判断阶段的 Jev：按量、执行方式是接口 + 自研外壳（会话插头没接）
    expect(plan(target({ billing: 'metered', hostId: 'api-shell' }))).toEqual({
      state: 'skipped',
      detail: expect.stringContaining('按量计费'),
    });
  });

  it('渠道下架、模型下架、没有阶段开着：不探，各写各的原因', () => {
    expect(plan(target({ channelEnabled: false }))).toMatchObject({ state: 'skipped', detail: /已下架/ });
    expect(plan(target({ modelRetiredAt: new Date(NOW.getTime() - 1) }))).toMatchObject({
      state: 'skipped',
      detail: /模型「Opus 5.5」已下架/,
    });
    // 下架时刻还没到：照探
    expect('probe' in plan(target({ modelRetiredAt: new Date(NOW.getTime() + 60_000) }))).toBe(true);
    expect(plan(target({ inUse: false }))).toMatchObject({ state: 'skipped', detail: /没有哪个阶段在用/ });
  });

  it('会话用户挂着拼车时，独享池的路由不探（探了扣的是拼车的额度）', () => {
    expect(plan(solo)).toMatchObject({ state: 'skipped', detail: /会话用户现在挂的是拼车组织/ });
    // 切过去以后反过来
    expect('probe' in planProbe(solo, probers, 'solo', NOW)).toBe(true);
    expect(planProbe(carpool, probers, 'solo', NOW)).toMatchObject({ state: 'skipped' });
  });
});

describe('一轮（runRouteProbeJob，不起 Temporal）', () => {
  it('探通的写 ok（在线），没探的写原因（不在线）；scanned、found 和写下的对得上', async () => {
    const h = harness([carpool, solo, mirasim], answered);
    const run = await runRouteProbeJob(h.deps);
    expect(run).toEqual({
      runId: 11,
      outcome: 'ok',
      scanned: 3,
      found: 2,
      online: ['claude-carpool:opus-5.5:claude-code'],
    });
    expect(h.saved.map((s) => [s.routeId, s.state])).toEqual([
      ['claude-carpool:opus-5.5:claude-code', 'ok'],
      ['claude-solo:opus-5.5:claude-code', 'skipped'],
      ['mirasim-relay:kimi-k3:mirasim', 'not_wired'],
    ]);
    expect(h.saved[0]?.detail).toBe('答上了：OK · 用时 9 秒');
    expect(h.saved.every((s) => s.at.getTime() === NOW.getTime())).toBe(true);
    expect(h.finished).toEqual([{ id: 11, result: { outcome: 'ok', scanned: 3, found: 2 } }]);
    // 只有真探了的才走 afterProbe（整池暂停的报警）
    expect(h.after.map((a) => a.routeId)).toEqual(['claude-carpool:opus-5.5:claude-code']);
    expect(h.sleeps).toEqual([]);
  });

  it('第一次没通（网络抖了一下）：隔一会儿再探一次，通了就在线，原因里记着第一次', async () => {
    let n = 0;
    const flaky: Prober = async () => {
      n += 1;
      return n === 1
        ? { kind: 'failed', detail: '进程退出（退出码 1），没有终帧：ECONNRESET' }
        : answered(carpool);
    };
    const h = harness([carpool], flaky);
    const run = await runRouteProbeJob(h.deps);
    expect(run).toMatchObject({ outcome: 'ok', scanned: 1, found: 0 });
    expect(h.sleeps).toEqual([ROUTE_PROBE_RETRY_DELAY_MS]);
    expect(h.saved[0]).toMatchObject({ state: 'ok', detail: expect.stringContaining('第一次没通：') });
  });

  it('连探两次都没通：写成离线、写明两次的原因（不许拿上一次的在线冒充）', async () => {
    const down: Prober = async () => ({ kind: 'failed', detail: '等了 150 秒进程还没第一帧' });
    const h = harness([target({ alive: true })], down);
    const run = await runRouteProbeJob(h.deps);
    expect(run).toMatchObject({ outcome: 'ok', scanned: 1, found: 1, online: [] });
    expect(h.saved[0]).toMatchObject({ state: 'failed', detail: expect.stringContaining('连探两次都没通') });
    expect(h.after[0]?.attempt.kind).toBe('failed');
  });

  it('要人修的整池问题（登录失效）：同一轮不再试，直接离线；afterProbe 拿到 poolHold 去报警', async () => {
    const loggedOut: Prober = async () => ({
      kind: 'failed',
      detail: '登录失效：Not logged in · Please run /login',
      poolHold: { title: '登录失效', body: '在法国上以 fleet-agent-carpool 重跑 reclaude login' },
    });
    const h = harness([carpool], loggedOut);
    await runRouteProbeJob(h.deps);
    expect(h.sleeps).toEqual([]);
    expect(h.saved[0]).toMatchObject({ state: 'failed', detail: expect.stringContaining('登录失效') });
    expect(h.after[0]?.attempt).toMatchObject({ kind: 'failed', poolHold: { title: '登录失效' } });
  });

  it('额度用满被拒：算通（在线），额度那一套去挡——不当成离线（离线在选路里是硬挡，任务会挂起等人）', async () => {
    const full: Prober = async () => ({ kind: 'quota', detail: '额度用满被拒：拼车 5 小时额度已用完' });
    const h = harness([carpool], full);
    const run = await runRouteProbeJob(h.deps);
    expect(run.online).toEqual([carpool.routeId]);
    expect(h.saved[0]).toMatchObject({ state: 'ok', detail: expect.stringContaining('额度用满') });
    expect(h.sleeps).toEqual([]);
  });

  it('探针自己抛错：按没探通记（离线、写明是探针出错），不让整轮垮掉', async () => {
    const broken: Prober = async () => {
      throw new Error('fleet-agent-scope 不在');
    };
    const h = harness([carpool, mirasim], broken);
    const run = await runRouteProbeJob(h.deps);
    expect(run).toMatchObject({ outcome: 'ok', scanned: 2, found: 2 });
    expect(h.saved[0]).toMatchObject({ state: 'failed', detail: expect.stringContaining('探针自己出错') });
    expect(h.saved[0]?.detail).toContain('fleet-agent-scope 不在');
  });

  it('原因太长：截断到能看的长度，不把整段报错原文塞进库', async () => {
    const noisy: Prober = async () => ({
      kind: 'failed',
      detail: `x${'很长的报错'.repeat(500)}`,
      poolHold: { title: 't', body: 'b' },
    });
    const h = harness([carpool], noisy);
    await runRouteProbeJob(h.deps);
    expect(h.saved[0]?.detail.length).toBeLessThanOrEqual(600);
    expect(h.saved[0]?.detail.endsWith('…')).toBe(true);
  });

  it('afterProbe（整池暂停的报警）写不进库：只记日志，结论照写', async () => {
    const h = harness([carpool], answered, {
      afterProbe: async () => {
        throw new Error('notifications 表锁住了');
      },
    });
    const run = await runRouteProbeJob(h.deps);
    expect(run.outcome).toBe('ok');
    expect(h.saved).toHaveLength(1);
    expect(h.logs.some((l) => l.startsWith('error:') && l.includes('报警没写进库'))).toBe(true);
  });

  it('读不到路由表：这一轮记 failed、抛 RouteProbeFailedError，一条都不写（不许留着上一轮的在线当没事）', async () => {
    const h = harness([], answered, {
      targets: async () => {
        throw new Error('连不上库');
      },
    });
    await expect(runRouteProbeJob(h.deps)).rejects.toMatchObject({
      name: 'RouteProbeFailedError',
      runId: 11,
      message: expect.stringContaining('连不上库'),
    });
    expect(h.finished[0]?.result).toMatchObject({
      outcome: 'failed',
      why: expect.stringContaining('读路由表没成'),
    });
    expect(h.saved).toEqual([]);
  });

  it('一条路由都没有：记 unscanned（没扫到 ≠ 没问题），不记 ok', async () => {
    const h = harness([], answered);
    const run = await runRouteProbeJob(h.deps);
    expect(run).toMatchObject({ outcome: 'unscanned', scanned: 0, found: 0 });
    expect(h.finished[0]?.result).toMatchObject({
      outcome: 'unscanned',
      why: expect.stringContaining('一条路由都没有'),
    });
  });

  it('有的结论写不进库：记 partial、写明哪几条，写进去的照数', async () => {
    const h = harness([carpool, mirasim], answered, {
      save: async (w) => {
        if (w.routeId === mirasim.routeId) throw new Error('约束 routes_probe_not_ok_has_detail');
        return 'saved';
      },
    });
    const run = await runRouteProbeJob(h.deps);
    expect(run).toMatchObject({ outcome: 'partial', scanned: 1, found: 0, online: [carpool.routeId] });
    expect(run.why).toContain(mirasim.routeId);
    expect(run.why).toContain('routes_probe_not_ok_has_detail');
  });

  it('一条都写不进库：记 failed、抛出（探了也等于没探）', async () => {
    const h = harness([carpool], answered, {
      save: async () => {
        throw new Error('库只读');
      },
    });
    await expect(runRouteProbeJob(h.deps)).rejects.toThrow('一条结论都没写进库');
    expect(h.finished[0]?.result.outcome).toBe('failed');
  });

  it('探的时候路由被删了：不算写进去，也不算出错；全被删了记 unscanned', async () => {
    const some = harness([carpool, mirasim], answered, {
      save: async (w) => (w.routeId === mirasim.routeId ? 'route_not_found' : 'saved'),
    });
    expect(await runRouteProbeJob(some.deps)).toMatchObject({ outcome: 'ok', scanned: 1, found: 0 });
    const all = harness([carpool], answered, { save: async () => 'route_not_found' });
    expect(await runRouteProbeJob(all.deps)).toMatchObject({ outcome: 'unscanned' });
  });

  it('记不上开始：原样抛出，不去探、不写（登记表上它会过期，看门狗看得见）', async () => {
    const h = harness([carpool], answered, {
      runs: {
        async start() {
          throw new Error('scheduled_jobs 里没登记 route-probe');
        },
        async finish() {},
      },
    });
    await expect(runRouteProbeJob(h.deps)).rejects.toThrow('没登记');
    expect(h.saved).toEqual([]);
  });

  it('记结局失败：原样抛出，不当成跑完了', async () => {
    const h = harness([carpool], answered, {
      runs: {
        async start() {
          return 1;
        },
        async finish() {
          throw new Error('库连不上');
        },
      },
    });
    await expect(runRouteProbeJob(h.deps)).rejects.toThrow('库连不上');
  });

  it('同时最多探两条（每条是一个真会话），结论按路由的顺序写', async () => {
    let running = 0;
    let peak = 0;
    const slow: Prober = async () => {
      running += 1;
      peak = Math.max(peak, running);
      await new Promise((r) => setTimeout(r, 10));
      running -= 1;
      return { kind: 'answered', detail: 'OK' };
    };
    const many = [1, 2, 3, 4].map((i) => target({ routeId: `r${i}`, poolId: `p${i}` }));
    const h = harness(many, slow);
    await runRouteProbeJob(h.deps);
    expect(peak).toBe(2);
    expect(h.saved.map((s) => s.routeId)).toEqual(['r1', 'r2', 'r3', 'r4']);
  });
});

// 起工人、跑一轮在整包一起跑时可能超过默认的 5 秒（和「你好」工作流的用例同一个上限）。
describe('路由探针的工作流（真 Temporal 测试服务端）', { timeout: 60_000 }, () => {
  const env = useEnv();

  async function runOnce(jobs: EngineJobs | undefined): Promise<RouteProbeRun> {
    return withWorker(
      env(),
      createFakeWorld(),
      (taskQueue) =>
        env().client.workflow.execute(WORKFLOW_TYPES.routeProbe, {
          taskQueue,
          workflowId: `route-probe-${randomUUID()}`,
          args: [{ schemaVersion: 1 }],
        }),
      jobs ? { jobs } : {},
    );
  }

  async function failureOf(jobs: EngineJobs | undefined): Promise<ApplicationFailure> {
    const err = await runOnce(jobs).then(
      () => null,
      (e: unknown) => e,
    );
    expect(err).toBeInstanceOf(WorkflowFailedError);
    let cause = (err as WorkflowFailedError).cause;
    while (cause && !(cause instanceof ApplicationFailure)) cause = (cause as { cause?: Error }).cause;
    expect(cause).toBeInstanceOf(ApplicationFailure);
    return cause as ApplicationFailure;
  }

  it('一轮跑完：工作流交回这一轮的结局（和记进 schedule_runs 的同一份）', async () => {
    const h = harness([carpool, mirasim], answered);
    const run = await runOnce({ routeProbe: () => h.deps });
    expect(run).toEqual({ runId: 11, outcome: 'ok', scanned: 2, found: 1, online: [carpool.routeId] });
    expect(h.finished).toHaveLength(1);
  });

  it('这一轮没跑成：活动报 ROUTE_PROBE_FAILED（不重试，下一轮 15 分钟后照来）', async () => {
    const h = harness([], answered, {
      targets: async () => {
        throw new Error('连不上库');
      },
    });
    const failure = await failureOf({ routeProbe: () => h.deps });
    expect(failure.type).toBe('ROUTE_PROBE_FAILED');
    expect(failure.nonRetryable).toBe(true);
    expect(failure.message).toContain('连不上库');
  });

  it('假端口的工人（没装探针）接到这一轮：明确报 JOB_NOT_CONFIGURED，不回一个空的 ok', async () => {
    const failure = await failureOf(undefined);
    expect(failure.type).toBe('JOB_NOT_CONFIGURED');
    expect(failure.nonRetryable).toBe(true);
  });

  it('登记的名字、频率写的是「路由探针」、每 15 分钟', () => {
    expect(ROUTE_PROBE_JOB).toMatchObject({ id: 'route-probe', name: '路由探针', expectEveryMinutes: 45 });
  });
});
