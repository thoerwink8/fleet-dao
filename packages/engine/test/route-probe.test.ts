// 路由探针（#129）的一轮：定探不探（插头没接、按量、下架、没阶段开着、会话用户挂着别的组织）、真探、没通隔一会儿再探、
// 写结论、记结局。读不到路由、写不进库、探针自己出错，每条路径都故意造一次，都不许记成 ok、也不许把路由写成在线。
import type { RouteProbeTarget, ScheduleResult } from '@fleet-dao/db';
import type { ProbeCheck } from '@fleet-dao/shared';
import { describe, expect, it } from 'vitest';
import {
  type ProbeAttempt,
  type Prober,
  planProbe,
  planScheduledProbe,
  ROUTE_PROBE_JOB,
  ROUTE_PROBE_RETRY_DELAY_MS,
  RouteProbeFailedError,
  type RouteProbeJobDeps,
  runRouteProbeJob,
} from '../src/jobs/route-probe.ts';

const NOW = new Date('2026-09-26T04:07:00.000Z');
/** 会话用户此刻挂的组织（真实现以会话用户跑 reclaude org list，认带 * 的那行的类型，real/session-org.ts）。 */
const ON_CARPOOL = { ok: true, org: 'carpool' } as const;
const ON_SOLO = { ok: true, org: 'solo' } as const;
const UNKNOWN = {
  ok: false,
  why: '以会话用户 fleet-agent-carpool 跑 reclaude org list：reclaude 报登录失效',
} as const;

function target(over: Partial<RouteProbeTarget> = {}): RouteProbeTarget {
  return {
    routeId: 'claude-carpool:opus-5.5:claude-code',
    hostId: 'claude-code',
    channelId: 'claude-sub',
    channelName: 'Claude 订阅',
    billing: 'subscription',
    channelEnabled: true,
    identityCheck: false,
    poolId: 'claude-carpool',
    runAsUser: 'fleet-agent-carpool',
    orgKind: 'carpool',
    modelId: 'opus-5.5',
    modelName: 'Opus 5.5',
    upstreamModel: 'claude-opus-5-5',
    modelRetiredAt: null,
    inUse: true,
    alive: false,
    lastRunAt: null,
    failStreak: 0,
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
  saved: {
    routeId: string;
    state: string;
    at: Date;
    detail: string;
    org: string | null;
    durationMs: number | null;
    requestText: string | null;
    responseText: string | null;
    check?: ProbeCheck | null;
  }[];
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
    sessionOrg: async () => ON_CARPOOL,
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
  const plan = (t: RouteProbeTarget) => planProbe(t, probers, t.orgKind === null ? null : ON_CARPOOL, NOW);

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
    expect('probe' in planProbe(solo, probers, ON_SOLO, NOW)).toBe(true);
    expect(planProbe(carpool, probers, ON_SOLO, NOW)).toMatchObject({
      state: 'skipped',
      detail: /会话用户现在挂的是独享组织：这时探拼车池，扣的是独享的额度/,
    });
  });

  it('会话用户挂的组织认不出（读不到、没有带 * 的行、类型认不出）：带组织类型的池一律不探、记没探成，写明原因；不拿拼车顶', () => {
    for (const t of [carpool, solo]) {
      expect(planProbe(t, probers, UNKNOWN, NOW)).toEqual({
        state: 'failed',
        detail: expect.stringContaining(`会话用户挂的组织认不出（${UNKNOWN.why}）`),
      });
      // 没读（调用方漏了）也一样，不当成挂着
      expect(planProbe(t, probers, null, NOW)).toMatchObject({ state: 'failed', detail: /认不出（没读）/ });
    }
    // 不是 Claude 订阅池（没有组织）的不受影响
    expect('probe' in planProbe(target({ orgKind: null }), probers, null, NOW)).toBe(true);
    // 先后照旧：插头没接、按量、下架、没阶段在用的照原来的原因说
    expect(planProbe(target({ inUse: false }), probers, UNKNOWN, NOW)).toMatchObject({ state: 'skipped' });
  });

  it('人拍了整池暂停的池不探，写明原因；不带这个标记的照探', () => {
    const held = { ...carpool, heldBySwitch: '324 账号被封' };
    expect(plan(held)).toMatchObject({ state: 'skipped', detail: /整池暂停（324 账号被封）：不探/ });
    expect('probe' in plan(carpool)).toBe(true);
  });
});

describe('一轮里读会话用户挂的组织', () => {
  const cursorTarget = target({
    routeId: 'cursor:cursor-auto:cursor-agent',
    hostId: 'cursor-agent',
    channelId: 'cursor',
    poolId: 'cursor',
    runAsUser: null,
    orgKind: null,
  });

  it('挂着独享：独享池探通在线，拼车池不探、写明挂的是独享', async () => {
    const h = harness([carpool, solo], answered, { sessionOrg: async () => ON_SOLO });
    const run = await runRouteProbeJob(h.deps);
    expect(run).toMatchObject({ outcome: 'ok', scanned: 2, found: 1, online: [solo.routeId] });
    expect(h.saved.find((s) => s.routeId === carpool.routeId)).toMatchObject({
      state: 'skipped',
      detail: expect.stringContaining('会话用户现在挂的是独享组织'),
    });
  });

  it('认不出：Claude 订阅池都记没探成（不在线、写明原因），别的池照探；只在探带组织类型的池之前读', async () => {
    let reads = 0;
    const h = harness([carpool, solo, cursorTarget], answered, {
      probers: { 'claude-code': answered, 'cursor-agent': answered },
      sessionOrg: async () => {
        reads += 1;
        return UNKNOWN;
      },
    });
    const run = await runRouteProbeJob(h.deps);
    expect(run).toMatchObject({ outcome: 'ok', scanned: 3, found: 2, online: [cursorTarget.routeId] });
    for (const id of [carpool.routeId, solo.routeId]) {
      expect(h.saved.find((s) => s.routeId === id)).toMatchObject({
        state: 'failed',
        detail: expect.stringContaining(
          '会话用户挂的组织认不出（以会话用户 fleet-agent-carpool 跑 reclaude org list：reclaude 报登录失效）',
        ),
      });
    }
    expect(reads).toBe(2);
  });

  it('写结论时连那时挂的组织一起写：Claude 订阅池写读到的组织（没探的独享那条也写，选路靠它认出「那一轮没探它」），别的池写空（#335）', async () => {
    const h = harness([carpool, solo, cursorTarget], answered, {
      probers: { 'claude-code': answered, 'cursor-agent': answered },
    });
    await runRouteProbeJob(h.deps);
    expect(h.saved.map((s) => [s.routeId, s.state, s.org])).toEqual([
      [carpool.routeId, 'ok', 'carpool'],
      [solo.routeId, 'skipped', 'carpool'],
      [cursorTarget.routeId, 'ok', null],
    ]);
    // 认不出：写空，不拿哪个组织顶
    const unknown = harness([carpool], answered, { sessionOrg: async () => UNKNOWN });
    await runRouteProbeJob(unknown.deps);
    expect(unknown.saved[0]?.org).toBeNull();
  });

  it('【故意造出的失败】这会儿定不下来（读数刚变、引擎没切过号，#335）：Claude 订阅池这一轮不探、不写（不写成不在线，也不写成探了），结论照旧；别的池照探；这一轮记 partial、写明为什么', async () => {
    const onlineCarpool = target({ alive: true });
    const h = harness([onlineCarpool, solo, cursorTarget], answered, {
      probers: { 'claude-code': answered, 'cursor-agent': answered },
      sessionOrg: async () => ({
        ok: false,
        pending: true,
        why: '会话用户挂的组织和上一次读的不一样，引擎没切过号',
      }),
    });
    const run = await runRouteProbeJob(h.deps);
    expect(h.saved.map((s) => s.routeId)).toEqual([cursorTarget.routeId]);
    expect(run).toMatchObject({
      outcome: 'partial',
      scanned: 3,
      // 拼车上一轮在线：照旧在线；独享上一轮不在线：照旧不在线
      found: 1,
      online: [onlineCarpool.routeId, cursorTarget.routeId],
    });
    expect(run.why).toContain('会话用户挂的组织这会儿定不下来，Claude 订阅池的 2 条路由这一轮没探、结论照旧');
    expect(run.why).toContain('会话用户挂的组织和上一次读的不一样，引擎没切过号');
    expect(
      planProbe(solo, { 'claude-code': answered }, { ok: false, pending: true, why: '切号中' }, NOW),
    ).toEqual({
      unsettled: '会话用户挂的组织这会儿定不下来（切号中）：独享池这一轮不探，结论照旧',
    });
  });

  it('【故意造出的失败】只有 Claude 订阅池、组织又定不下来：一条都没写，也不记成没扫到或 ok——记 partial', async () => {
    const h = harness([carpool, solo], answered, {
      sessionOrg: async () => ({ ok: false, pending: true, why: '读数刚变' }),
    });
    const run = await runRouteProbeJob(h.deps);
    expect(h.saved).toEqual([]);
    expect(run).toMatchObject({ outcome: 'partial', scanned: 2, found: 2, online: [] });
  });

  it('真探把耗时、请求和响应交给写入；没探的这三样是空', async () => {
    const meter = target({ routeId: 'meter', billing: 'metered', orgKind: null, poolId: 'meter' });
    const h = harness([carpool, meter], async () => ({
      kind: 'answered',
      detail: '答上了：OK',
      durationMs: 1234,
      requestText: 'PING',
      responseText: 'OK',
    }));
    await runRouteProbeJob(h.deps);
    expect(h.saved.find((s) => s.routeId === carpool.routeId)).toMatchObject({
      state: 'ok',
      durationMs: 1234,
      requestText: 'PING',
      responseText: 'OK',
    });
    expect(h.saved.find((s) => s.routeId === 'meter')).toMatchObject({
      state: 'skipped',
      durationMs: null,
      requestText: null,
      responseText: null,
    });
  });

  it('降智检测的题和判的结果（#1637）原样交给写入；没真探的是空', async () => {
    const check = { question: '1+1？', expected: '2', answer: '3', passed: false, selfIdentity: 'x' };
    const meter = target({ routeId: 'meter', billing: 'metered', orgKind: null, poolId: 'meter' });
    const h = harness([carpool, meter], async () => ({ kind: 'failed', detail: '疑似降智', check }));
    await runRouteProbeJob(h.deps);
    expect(h.saved.find((s) => s.routeId === carpool.routeId)).toMatchObject({ state: 'failed', check });
    expect(h.saved.find((s) => s.routeId === 'meter')?.check ?? null).toBeNull();
  });

  it('读法自己抛了：按认不出记（写明原因），这一轮照样跑完', async () => {
    const h = harness([carpool], answered, {
      sessionOrg: async () => {
        throw new Error('帮手脚本起不来');
      },
    });
    expect(await runRouteProbeJob(h.deps)).toMatchObject({ outcome: 'ok', found: 1, online: [] });
    expect(h.saved[0]).toMatchObject({
      state: 'failed',
      detail: expect.stringContaining('会话用户挂的组织认不出（读会话用户挂的组织出错：帮手脚本起不来）'),
    });
  });
});

describe('一轮里带着切号（#157：探之前判、该切就切，探完核对）', () => {
  it('探之前切：这一轮探的就是切过去的组织；探完把真探了的结论交给核对', async () => {
    let live: typeof ON_CARPOOL | typeof ON_SOLO = ON_CARPOOL;
    const checked: { to: string | null; probed: unknown[] }[] = [];
    const h = harness([carpool, solo], answered, {
      sessionOrg: async () => live,
      orgSwitch: {
        now: async () => null,
        async before() {
          live = ON_SOLO;
          return 'solo';
        },
        async after(to, probed) {
          checked.push({ to, probed: [...probed] });
        },
      },
    });
    const run = await runRouteProbeJob(h.deps);
    expect(run).toMatchObject({ outcome: 'ok', online: [solo.routeId] });
    expect(checked).toEqual([
      {
        to: 'solo',
        probed: [
          {
            routeId: carpool.routeId,
            orgKind: 'carpool',
            state: 'skipped',
            detail: expect.stringContaining('会话用户现在挂的是独享组织'),
          },
          { routeId: solo.routeId, orgKind: 'solo', state: 'ok', detail: '答上了：OK · 用时 9 秒' },
        ],
      },
    ]);
  });

  it('没切：照样交给核对（to 是 null，看之前切完读回不在线的这一轮探通了没有）', async () => {
    const checked: (string | null)[] = [];
    const h = harness([carpool], answered, {
      orgSwitch: {
        now: async () => null,
        before: async () => null,
        async after(to) {
          checked.push(to);
        },
      },
    });
    await runRouteProbeJob(h.deps);
    expect(checked).toEqual([null]);
  });

  it('【故意造出的失败】切号那两步自己抛了：记日志，这一轮照探、照写', async () => {
    const h = harness([carpool], answered, {
      orgSwitch: {
        now: async () => null,
        before: async () => {
          throw new Error('库连不上');
        },
        after: async () => {
          throw new Error('又连不上');
        },
      },
    });
    expect(await runRouteProbeJob(h.deps)).toMatchObject({ outcome: 'ok', online: [carpool.routeId] });
    expect(h.logs).toContain('error:路由探针：切号这一步出错，这一轮不切');
    expect(h.logs).toContain('error:路由探针：切号的核对出错');
  });
});

describe('按一次的成本放慢（cursor-agent：探通了隔 2 小时再真探）', () => {
  const minutesAgo = (m: number) => new Date(NOW.getTime() - m * 60_000);
  const ok = (m: number) => ({ state: 'ok' as const, at: minutesAgo(m), detail: '答上了：OK · 用时 4 秒' });
  const cursor = (over: Partial<RouteProbeTarget> = {}) =>
    target({
      routeId: 'cursor:cursor-auto:cursor-agent',
      hostId: 'cursor-agent',
      channelId: 'cursor',
      channelName: 'Cursor 订阅',
      poolId: 'cursor',
      runAsUser: null,
      orgKind: null,
      modelId: 'cursor-auto',
      modelName: 'Cursor Auto',
      upstreamModel: 'auto',
      alive: true,
      previous: ok(30),
      ...over,
    });
  const probers = { 'claude-code': answered, 'cursor-agent': answered };
  const plan = (t: RouteProbeTarget) => planProbe(t, probers, t.orgKind === null ? null : ON_CARPOOL, NOW);

  it('上一次探通、还没到 2 小时：这一轮不探，结论照旧（写明为什么）', () => {
    expect(plan(cursor())).toEqual({
      kept: expect.stringContaining('隔 120 分钟再真探；上一次探通是 30 分钟前'),
    });
    // 差半轮以内算没到
    expect('kept' in plan(cursor({ previous: ok(112) }))).toBe(true);
  });

  it('到点了（差半轮以内也算）：探', () => {
    expect('probe' in plan(cursor({ previous: ok(113) }))).toBe(true);
    expect('probe' in plan(cursor({ previous: ok(300) }))).toBe(true);
  });

  it('上一次没通、没探过、按规矩没探、结论 ok 却不在线、结论的时刻在未来：每轮都探（没通的报错走不到模型，不扣用量）', () => {
    for (const previous of [
      { state: 'failed' as const, at: minutesAgo(10), detail: '没登录' },
      { state: 'skipped' as const, at: minutesAgo(10), detail: '没有阶段在用' },
      null,
    ]) {
      expect('probe' in plan(cursor({ previous, alive: false }))).toBe(true);
    }
    expect('probe' in plan(cursor({ alive: false }))).toBe(true);
    expect('probe' in plan(cursor({ previous: ok(-5) }))).toBe(true);
  });

  it('不放慢的执行方式（Claude Code）：上一次刚探通也每轮都探', () => {
    expect('probe' in plan(target({ alive: true, previous: ok(10) }))).toBe(true);
  });

  it('放慢只管该探的：没有阶段在用、渠道下架的照样写不探的原因（不在线）', () => {
    expect(plan(cursor({ inUse: false }))).toMatchObject({ state: 'skipped', detail: /没有哪个阶段在用/ });
    expect(plan(cursor({ channelEnabled: false }))).toMatchObject({ state: 'skipped' });
  });

  it('一轮：结论照旧的不写库、不起会话，算看过、算在线；scanned、found 照算', async () => {
    let calls = 0;
    const counting: Prober = async () => {
      calls += 1;
      return { kind: 'answered', detail: '答上了：OK · 用时 4 秒' };
    };
    const h = harness([carpool, cursor(), solo], counting, {
      probers: { 'claude-code': counting, 'cursor-agent': counting },
    });
    const run = await runRouteProbeJob(h.deps);
    expect(calls).toBe(1);
    expect(run).toMatchObject({
      outcome: 'ok',
      scanned: 3,
      found: 1,
      online: ['claude-carpool:opus-5.5:claude-code', 'cursor:cursor-auto:cursor-agent'],
    });
    expect(h.saved.map((s) => s.routeId)).toEqual([
      'claude-carpool:opus-5.5:claude-code',
      'claude-solo:opus-5.5:claude-code',
    ]);
    expect(h.after.map((a) => a.routeId)).toEqual(['claude-carpool:opus-5.5:claude-code']);
    expect(h.logs).toContain('info:路由探针：还没到再探的时候，结论照旧');
  });

  it('一轮里只有结论照旧的：记 ok（看过了、都在线），不记成一条都没扫到', async () => {
    const h = harness([cursor()], answered, { probers });
    const run = await runRouteProbeJob(h.deps);
    expect(run).toMatchObject({
      outcome: 'ok',
      scanned: 1,
      found: 0,
      online: ['cursor:cursor-auto:cursor-agent'],
    });
    expect(h.saved).toEqual([]);
    expect(h.finished).toEqual([{ id: 11, result: { outcome: 'ok', scanned: 1, found: 0 } }]);
  });

  it('结论照旧的之外、该写的一条都没写进库：照样记 failed（不拿照旧的那几条冒充这一轮跑成了）', async () => {
    const h = harness([cursor(), carpool], answered, {
      probers,
      save: async () => {
        throw new Error('库连不上');
      },
    });
    await expect(runRouteProbeJob(h.deps)).rejects.toThrow('一条结论都没写进库');
    expect(h.finished[0]?.result).toMatchObject({ outcome: 'failed' });
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
    expect(h.saved[0]?.detail).toContain('…');
    expect(h.saved[0]?.detail).toContain('退避中，下次约');
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

describe('路由探针的结局和登记', () => {
  it('一轮跑完：交回这一轮的结局（和记进 schedule_runs 的同一份）', async () => {
    const h = harness([carpool, mirasim], answered);
    const run = await runRouteProbeJob(h.deps);
    expect(run).toEqual({ runId: 11, outcome: 'ok', scanned: 2, found: 1, online: [carpool.routeId] });
    expect(h.finished).toHaveLength(1);
  });

  it('这一轮没跑成：抛 RouteProbeFailedError、带着原因（下一轮 15 分钟后照来）', async () => {
    const h = harness([], answered, {
      targets: async () => {
        throw new Error('连不上库');
      },
    });
    const err = await runRouteProbeJob(h.deps).then(
      () => null,
      (e: unknown) => e,
    );
    expect(err).toBeInstanceOf(RouteProbeFailedError);
    expect((err as Error).message).toContain('连不上库');
  });

  it('登记的名字、频率写的是「路由探针」、每 15 分钟', () => {
    expect(ROUTE_PROBE_JOB).toMatchObject({ id: 'route-probe', name: '路由探针', expectEveryMinutes: 45 });
  });
});

const UNUSED_ROUTE = '没有哪个阶段在用这条路由（挂着但关着的不算），不花额度去探；哪个阶段用上它，下一轮就探';

describe('省额度（#1424）：不通退避、健康路由前 2 位以外放慢', () => {
  const probers = { 'claude-code': answered, grok: answered, 'cursor-agent': answered };
  const minutesAgo = (m: number) => new Date(NOW.getTime() - m * 60_000);
  const failed = (streak: number, minutes: number) => ({
    state: 'failed' as const,
    at: minutesAgo(minutes),
    detail: `没通（连着不通 ${streak} 次）`,
  });
  const okAgo = (m: number) => ({ state: 'ok' as const, at: minutesAgo(m), detail: '答上了：OK' });
  const scheduled = (t: RouteProbeTarget) =>
    planScheduledProbe(t, probers, t.orgKind === null ? null : ON_CARPOOL, NOW);

  it('连着不通逐级拉长：1 次隔 15 分钟、2 次 30、3 次 60、4 次 120，没到点不探', () => {
    expect(scheduled(target({ alive: false, previous: failed(1, 5) }))).toMatchObject({
      backingOff: expect.stringMatching(/退避中，下次约 \d{2}:\d{2} 再探（连着不通 1 次）/),
    });
    // 差半轮以内算到点：1 次的间隔是 15 分钟，10 分钟前已经该探
    expect('probe' in scheduled(target({ alive: false, previous: failed(1, 10) }))).toBe(true);
    expect('backingOff' in scheduled(target({ alive: false, previous: failed(2, 20) }))).toBe(true);
    expect('probe' in scheduled(target({ alive: false, previous: failed(2, 23) }))).toBe(true);
    expect('backingOff' in scheduled(target({ alive: false, previous: failed(3, 40) }))).toBe(true);
    expect('probe' in scheduled(target({ alive: false, previous: failed(3, 53) }))).toBe(true);
    expect('backingOff' in scheduled(target({ alive: false, previous: failed(4, 100) }))).toBe(true);
    expect('probe' in scheduled(target({ alive: false, previous: failed(4, 113) }))).toBe(true);
  });

  it('退避封顶 240 分钟：第 5 次以后不再拉长', () => {
    expect('backingOff' in scheduled(target({ alive: false, previous: failed(5, 200) }))).toBe(true);
    expect('backingOff' in scheduled(target({ alive: false, previous: failed(9, 200) }))).toBe(true);
    expect('probe' in scheduled(target({ alive: false, previous: failed(9, 233) }))).toBe(true);
  });

  it('退避中的那一轮不探、不重写，结论里写明下次大约几点，算看过、算不在线', async () => {
    let calls = 0;
    const counting: Prober = async () => {
      calls += 1;
      return { kind: 'failed', detail: '不该探到' };
    };
    const down = target({ alive: false, previous: failed(2, 20) });
    const h = harness([down], counting);
    const run = await runRouteProbeJob(h.deps);
    expect(calls).toBe(0);
    expect(h.saved).toEqual([]);
    expect(run).toMatchObject({ outcome: 'ok', scanned: 1, found: 1, online: [] });
    expect(h.logs.some((l) => l.includes('退避中，下次约') && /下次约 \d{2}:\d{2} 再探/.test(l))).toBe(true);
  });

  it('探了又不通：结论带上退避那句，次数加一；到了封顶还是 240 分钟', async () => {
    const down: Prober = async () => ({ kind: 'failed', detail: '503 容量满' });
    const first = harness([target({ alive: false, previous: null })], down);
    await runRouteProbeJob(first.deps);
    expect(first.saved[0]?.detail).toContain('退避中，下次约 12:22 再探（连着不通 1 次）');
    expect(first.saved[0]?.detail).toContain('503 容量满');

    const again = harness([target({ alive: false, previous: failed(5, 233) })], down);
    await runRouteProbeJob(again.deps);
    expect(again.saved[0]?.detail).toContain('退避中，下次约 16:07 再探（连着不通 6 次）');
  });

  it('一次探通就回到原节奏：不再写退避，前 2 位隔 30 分钟后照旧探', async () => {
    const h = harness([target({ alive: false, probeRank: 1, previous: failed(4, 113) })], answered);
    await runRouteProbeJob(h.deps);
    expect(h.saved[0]).toMatchObject({ state: 'ok' });
    expect(h.saved[0]?.detail).not.toContain('退避中');
    const next = target({
      alive: true,
      probeRank: 1,
      previous: { state: 'ok', at: minutesAgo(35), detail: h.saved[0]?.detail ?? '' },
    });
    expect('probe' in scheduled(next)).toBe(true);
    const relapsed = harness(
      [target({ alive: true, previous: { state: 'ok', at: minutesAgo(35), detail: '答上了：OK' } })],
      async () => ({ kind: 'failed', detail: '又不通' }),
    );
    await runRouteProbeJob(relapsed.deps);
    expect(relapsed.saved[0]?.detail).toContain('连着不通 1 次');
  });

  it('前 2 位探通了隔 30 分钟才再真探：20 分钟前探通这一轮不探，35 分钟前探通这一轮探', () => {
    expect(scheduled(target({ alive: true, probeRank: 1, previous: okAgo(20) }))).toMatchObject({
      kept: expect.stringContaining('隔 30 分钟'),
    });
    expect(scheduled(target({ alive: true, probeRank: 2, previous: okAgo(20) }))).toMatchObject({
      kept: expect.stringContaining('隔 30 分钟'),
    });
    expect('probe' in scheduled(target({ alive: true, probeRank: 1, previous: okAgo(35) }))).toBe(true);
    // 差半轮以内算到点：30 分钟的间隔，23 分钟前已经该探
    expect('probe' in scheduled(target({ alive: true, probeRank: 2, previous: okAgo(23) }))).toBe(true);
    // 名次读不到：不当成排在后面，照前 2 位的原间隔（到期该探）
    expect('probe' in scheduled(target({ alive: true, previous: okAgo(40) }))).toBe(true);
  });

  it('前 2 位探通了，结论里写明隔 30 分钟再探；本来更慢的执行方式不写、不改短', async () => {
    const h = harness([target({ alive: true, probeRank: 1, previous: okAgo(40) })], answered);
    await runRouteProbeJob(h.deps);
    expect(h.saved[0]?.detail).toContain('用途前 2 位，隔 30 分钟再探');
    const grok = target({
      routeId: 'grok:grok-4.7:grok',
      hostId: 'grok',
      channelId: 'grok',
      poolId: 'grok',
      orgKind: null,
      modelId: 'grok-4.7',
      modelName: 'Grok 4.7',
      alive: true,
      probeRank: 1,
      previous: okAgo(30),
    });
    expect(scheduled(grok)).toMatchObject({ kept: expect.stringContaining('隔 120 分钟') });
  });

  it('排第 3 的这一轮不调探针，结论写成按需探测，附上一次真探的结果和时刻', async () => {
    let calls = 0;
    const counting: Prober = async () => {
      calls += 1;
      return { kind: 'answered', detail: '不该探到' };
    };
    const third = target({ alive: true, probeRank: 3, previous: okAgo(40) });
    expect(scheduled(third)).toMatchObject({
      onDemand: expect.stringContaining('不主动探，要派给它时先探一次'),
    });
    const h = harness([third], counting);
    const run = await runRouteProbeJob(h.deps);
    expect(calls).toBe(0);
    expect(h.saved).toHaveLength(1);
    expect(h.saved[0]).toMatchObject({ state: 'on_demand', durationMs: null });
    expect(h.saved[0]?.detail).toMatch(/上一次真探：通，\d{2}-\d{2} \d{2}:\d{2}/);
    // 按需的不算不在线：found 不加
    expect(run).toMatchObject({ outcome: 'ok', scanned: 1, found: 0 });
  });

  it('从没真探过、或上一次是没探的：按需探测写「还没真探过」；上一次不通的附不通的原因', () => {
    expect(scheduled(target({ alive: false, probeRank: 3, previous: null }))).toMatchObject({
      onDemand: expect.stringContaining('还没真探过'),
    });
    expect(scheduled(target({ alive: false, probeRank: 3, previous: failed(1, 30) }))).toMatchObject({
      onDemand: expect.stringContaining('上一次真探：不通'),
    });
  });

  it('不通还在退避里的，不论名次都先等退避到期，到期再转按需', () => {
    expect(scheduled(target({ alive: false, probeRank: 5, previous: failed(2, 20) }))).toMatchObject({
      backingOff: expect.stringContaining('退避中'),
    });
    // 退避 2 次 = 30 分钟，过了 53 分钟：到期，转按需（不探）
    expect('onDemand' in scheduled(target({ alive: false, probeRank: 5, previous: failed(2, 53) }))).toBe(
      true,
    );
    // 前 2 位的退避到期照探
    expect('probe' in scheduled(target({ alive: false, probeRank: 1, previous: failed(2, 53) }))).toBe(true);
  });

  it('上一次已经是按需：不重写（保住上一次真探的结果），按需的路由不算不在线', async () => {
    const was = {
      state: 'on_demand' as const,
      at: minutesAgo(15),
      detail: '不主动探，要派给它时先探一次。上一次真探：通，10-10 09:00',
    };
    expect(scheduled(target({ alive: false, probeRank: 4, previous: was }))).toEqual({
      onDemand: was.detail,
      rewrite: false,
    });
    const h = harness([target({ alive: false, probeRank: 4, previous: was })], answered);
    const run = await runRouteProbeJob(h.deps);
    expect(h.saved).toEqual([]);
    expect(run).toMatchObject({ outcome: 'ok', scanned: 1, found: 0 });
  });

  it('按需的路由挂着渠道失败标记（只有探通它才能恢复渠道）：不转按需，照探', () => {
    expect(
      'probe' in
        scheduled(target({ alive: false, probeRank: 5, restoresChannel: true, previous: failed(1, 30) })),
    ).toBe(true);
  });

  it('本来更慢的执行方式排在前 2 位：不改短（仍按 120 分钟）', () => {
    const cursorTop = target({
      routeId: 'cursor:cursor-auto:cursor-agent',
      hostId: 'cursor-agent',
      channelId: 'cursor',
      poolId: 'cursor',
      orgKind: null,
      modelId: 'cursor-auto',
      modelName: 'Cursor Auto',
      alive: true,
      probeRank: 2,
      previous: okAgo(60),
    });
    expect(scheduled(cursorTop)).toMatchObject({ kept: expect.stringContaining('隔 120 分钟') });
  });

  it('没启用、没被用途用上的路由不探，结论原话不变', () => {
    expect(scheduled(target({ inUse: false, probeRank: 9, previous: failed(5, 1) }))).toEqual({
      state: 'skipped',
      detail: UNUSED_ROUTE,
    });
    expect(planProbe(target({ inUse: false }), probers, ON_CARPOOL, NOW)).toEqual({
      state: 'skipped',
      detail: UNUSED_ROUTE,
    });
  });

  it('【故意造出的失败】读不到上一次探测时间：按到期该探，不跳过', () => {
    const unread = target({
      alive: false,
      probeRank: 1,
      previous: {
        state: 'failed',
        at: new Date(Number.NaN),
        detail: '没通（连着不通 8 次）',
      },
    });
    expect('probe' in scheduled(unread)).toBe(true);
    const unreadOk = target({
      alive: true,
      probeRank: 1,
      previous: { state: 'ok', at: new Date('不是时间'), detail: '答上了：OK' },
    });
    expect('probe' in scheduled(unreadOk)).toBe(true);
  });
});

describe('窗口一重置就补发一次最小请求（#49）', () => {
  it('组织 A 窗口已重置且这一轮没探过：补发一次；组织 B 本轮已探测：不重复发', async () => {
    const calls: string[] = [];
    const probe: Prober = async (t) => {
      calls.push(t.orgKind ?? '');
      return { kind: 'answered', detail: '答上了：OK' };
    };
    // 会话用户挂着拼车：拼车（B）这一轮会探；独享（A）按规矩不探。两个组织的窗口都已重置。
    const h = harness([solo, carpool], probe, {
      sessionOrg: async () => ON_CARPOOL,
      resetOrgs: async () => ['solo', 'carpool'],
    });
    await runRouteProbeJob(h.deps);
    expect(calls.filter((org) => org === 'solo')).toHaveLength(1);
    expect(calls.filter((org) => org === 'carpool')).toHaveLength(1);
  });
});
