// 路由探针（#129）的一轮：定探不探（插头没接、按量、下架、没阶段开着、会话用户挂着别的组织）、真探、没通隔一会儿再探、
// 写结论、记结局。读不到路由、写不进库、探针自己出错，每条路径都故意造一次，都不许记成 ok、也不许把路由写成在线。
import type { RouteProbeTarget, ScheduleResult } from '@fleet-dao/db';
import type { ProbeCheck } from '@fleet-dao/shared';
import { describe, expect, it } from 'vitest';
import {
  conclude,
  nextProbeAt,
  type ProbeAttempt,
  type Prober,
  planProbe,
  planScheduledProbe,
  probeTier,
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
    tier?: string | null;
    nextAt?: Date | null;
    failStreak?: number;
    trigger?: string | null;
    kind?: 'ping' | 'identity' | null;
  }[];
  /** 没到期的路由：只更新档和下次探测时刻（savePace）。 */
  savedPace: { routeId: string; tier: string; nextAt: Date | null }[];
  finished: { id: number; result: ScheduleResult }[];
  sleeps: number[];
  after: { routeId: string; attempt: ProbeAttempt }[];
  logs: string[];
}

function harness(targets: RouteProbeTarget[], probe: Prober, over: Partial<RouteProbeJobDeps> = {}): Harness {
  const saved: Harness['saved'] = [];
  const savedPace: Harness['savedPace'] = [];
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
    savePace: async (w) => {
      savedPace.push(w);
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
  return { deps, saved, savedPace, finished, sleeps, after, logs };
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

  it('身份题的题和判的结果（#1798）原样交给写入；没真探的是空', async () => {
    const check = {
      question: '日本首相？',
      expected: '高市早苗',
      answer: '石破茂',
      passed: false,
      selfIdentity: 'x',
    };
    const meter = target({ routeId: 'meter', billing: 'metered', orgKind: null, poolId: 'meter' });
    const h = harness([carpool, meter], async () => ({
      kind: 'failed',
      detail: '疑似换成旧模型',
      check,
      probeKind: 'identity' as const,
    }));
    await runRouteProbeJob(h.deps);
    expect(h.saved.find((s) => s.routeId === carpool.routeId)).toMatchObject({
      state: 'failed',
      check,
      kind: 'identity',
    });
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

describe('按活跃分三档（#1798 片 3）', () => {
  const probers = { 'claude-code': answered, grok: answered, 'cursor-agent': answered };
  const minutesAgo = (m: number) => new Date(NOW.getTime() - m * 60_000);
  const minutesLater = (m: number) => new Date(NOW.getTime() + m * 60_000);
  const failed = (streak: number, minutes: number) => ({
    state: 'failed' as const,
    at: minutesAgo(minutes),
    detail: `没通（连着不通 ${streak} 次）`,
  });
  const okAgo = (m: number) => ({ state: 'ok' as const, at: minutesAgo(m), detail: '答上了：OK' });
  const scheduled = (t: RouteProbeTarget) =>
    planScheduledProbe(t, probers, t.orgKind === null ? null : ON_CARPOOL, NOW);
  const cursorAuto = (over: Partial<RouteProbeTarget> = {}) =>
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
      ...over,
    });

  describe('档和下次探测时刻', () => {
    it('没有用途在用 = 不在用；名次前 2、渠道要靠它恢复、近 6 小时开跑过 = 活跃；其余在用 = 不活跃', () => {
      expect(probeTier(target({ inUse: false, probeRank: 1, restoresChannel: true }), NOW)).toBe('unused');
      expect(probeTier(target({ probeRank: 1 }), NOW)).toBe('active');
      expect(probeTier(target({ probeRank: 2 }), NOW)).toBe('active');
      expect(probeTier(target({ probeRank: 3 }), NOW)).toBe('idle');
      // 名次读不到不当成前 2
      expect(probeTier(target({ probeRank: null }), NOW)).toBe('idle');
      expect(probeTier(target({ probeRank: 5, restoresChannel: true }), NOW)).toBe('active');
      expect(probeTier(target({ probeRank: 5, lastRunAt: minutesAgo(5 * 60 + 59) }), NOW)).toBe('active');
      expect(probeTier(target({ probeRank: 5, lastRunAt: minutesAgo(6 * 60 + 1) }), NOW)).toBe('idle');
      expect(probeTier(target({ probeRank: 5, lastRunAt: null }), NOW)).toBe('idle');
    });

    it('下次探测：不在用没有；活跃 +60 分钟、不活跃 +1440 分钟；连着不通按退避档；没真探过一定已到期', () => {
      expect(nextProbeAt('unused', NOW, 0)).toBeNull();
      expect(nextProbeAt('unused', NOW, 3)).toBeNull();
      expect(nextProbeAt('active', NOW, 0)).toEqual(minutesLater(60));
      expect(nextProbeAt('idle', NOW, 0)).toEqual(minutesLater(1440));
      expect(nextProbeAt('active', NOW, 1)).toEqual(minutesLater(15));
      expect(nextProbeAt('idle', NOW, 3)).toEqual(minutesLater(60));
      expect(nextProbeAt('idle', NOW, 9)).toEqual(minutesLater(240));
      expect(nextProbeAt('idle', null, 0)?.getTime()).toBeLessThan(NOW.getTime());
    });
  });

  it('名次第 1：50 分钟前探通，定时这一轮不探（deferred）；65 分钟前探通，探', () => {
    expect(scheduled(target({ probeRank: 1, previous: okAgo(50) }))).toEqual({
      deferred: expect.stringContaining('隔 60 分钟再真探'),
    });
    expect('probe' in scheduled(target({ probeRank: 1, previous: okAgo(65) }))).toBe(true);
    // 差半轮以内算到点：60 分钟的间隔，53 分钟前已经该探；52 分钟前还没到
    expect('probe' in scheduled(target({ probeRank: 1, previous: okAgo(53) }))).toBe(true);
    expect('deferred' in scheduled(target({ probeRank: 1, previous: okAgo(52) }))).toBe(true);
  });

  it('名次第 5、近 6 小时没开跑：23 小时前探通不探，25 小时前探通探', () => {
    const idle = (m: number) => target({ probeRank: 5, lastRunAt: minutesAgo(7 * 60), previous: okAgo(m) });
    expect(scheduled(idle(23 * 60))).toEqual({ deferred: expect.stringContaining('隔 1440 分钟再真探') });
    expect('probe' in scheduled(idle(25 * 60))).toBe(true);
    // 名次读不到（null）也是不活跃：不再每轮都探
    expect('deferred' in scheduled(target({ probeRank: null, previous: okAgo(120) }))).toBe(true);
  });

  it('名次第 5、2 小时前开跑过：按活跃，60 分钟一探', () => {
    const ran = (m: number) => target({ probeRank: 5, lastRunAt: minutesAgo(120), previous: okAgo(m) });
    expect('deferred' in scheduled(ran(50))).toBe(true);
    expect('probe' in scheduled(ran(65))).toBe(true);
  });

  it('渠道被运行中失败标成 disabled、只有探通它才能恢复：排第 5 也按活跃档', () => {
    const restoring = (m: number) => target({ probeRank: 5, restoresChannel: true, previous: okAgo(m) });
    expect('deferred' in scheduled(restoring(50))).toBe(true);
    expect('probe' in scheduled(restoring(65))).toBe(true);
  });

  it('不分执行方式：cursor-agent 活跃路由也是 60 分钟（50 分钟前不探，65 分钟前探），不再是 120', () => {
    expect(scheduled(cursorAuto({ probeRank: 1, previous: okAgo(50) }))).toEqual({
      deferred: expect.stringContaining('隔 60 分钟'),
    });
    expect('probe' in scheduled(cursorAuto({ probeRank: 1, previous: okAgo(65) }))).toBe(true);
    const grok = target({ hostId: 'grok', orgKind: null, probeRank: 1, previous: okAgo(65) });
    expect('probe' in scheduled(grok)).toBe(true);
  });

  it('没真探过（没结论、上一次是没探、读不到时刻、时刻在未来）：到期该探', () => {
    for (const previous of [
      null,
      { state: 'skipped' as const, at: minutesAgo(10), detail: '没有阶段在用' },
      { state: 'on_demand' as const, at: minutesAgo(10), detail: '不主动探，要派给它时先探一次' },
      { state: 'ok' as const, at: new Date('不是时间'), detail: '答上了：OK' },
      okAgo(-5),
    ]) {
      expect('probe' in scheduled(target({ probeRank: 5, previous }))).toBe(true);
    }
  });

  it('连着不通逐级退避：1 次隔 15 分钟、2 次 30、3 次 60、4 次 120，没到点不探；档不同也一样', () => {
    expect(scheduled(target({ alive: false, previous: failed(1, 5) }))).toEqual({
      deferred: expect.stringMatching(/退避中，下次约 \d{2}:\d{2} 再探（连着不通 1 次）/),
    });
    // 差半轮以内算到点：1 次的间隔是 15 分钟，10 分钟前已经该探
    expect('probe' in scheduled(target({ alive: false, previous: failed(1, 10) }))).toBe(true);
    expect('deferred' in scheduled(target({ alive: false, previous: failed(2, 20) }))).toBe(true);
    expect('probe' in scheduled(target({ alive: false, previous: failed(2, 23) }))).toBe(true);
    expect('deferred' in scheduled(target({ alive: false, previous: failed(3, 40) }))).toBe(true);
    expect('probe' in scheduled(target({ alive: false, previous: failed(3, 53) }))).toBe(true);
    expect('deferred' in scheduled(target({ alive: false, probeRank: 1, previous: failed(4, 100) }))).toBe(
      true,
    );
    expect('probe' in scheduled(target({ alive: false, probeRank: 1, previous: failed(4, 113) }))).toBe(true);
  });

  it('连着不通 3 次（用 target.failStreak）：60 分钟后才探；列比原文准，原文没写次数的按 1 次', () => {
    const three = (m: number) => target({ failStreak: 3, previous: { ...failed(1, m), detail: '没通' } });
    expect('deferred' in scheduled(three(50))).toBe(true);
    expect('probe' in scheduled(three(65))).toBe(true);
    // 列是 0、原文也没写次数：算 1 次（15 分钟），不把「没写」当成可以一直不探
    expect('probe' in scheduled(target({ previous: { ...failed(1, 20), detail: '没通' } }))).toBe(true);
  });

  it('退避封顶 240 分钟：第 5 次以后不再拉长', () => {
    expect('deferred' in scheduled(target({ previous: failed(5, 200) }))).toBe(true);
    expect('deferred' in scheduled(target({ previous: failed(9, 200) }))).toBe(true);
    expect('probe' in scheduled(target({ previous: failed(9, 233) }))).toBe(true);
  });

  it('没有用途在用：不探（planProbe 的原话不变），不在用没有下次探测', async () => {
    expect(scheduled(target({ inUse: false, probeRank: 9, previous: failed(5, 1) }))).toEqual({
      state: 'skipped',
      detail: UNUSED_ROUTE,
    });
    expect(planProbe(target({ inUse: false }), probers, ON_CARPOOL, NOW)).toEqual({
      state: 'skipped',
      detail: UNUSED_ROUTE,
    });
    let calls = 0;
    const counting: Prober = async () => {
      calls += 1;
      return { kind: 'answered', detail: '不该探到' };
    };
    const h = harness([target({ inUse: false, probeRank: 9 })], counting);
    const run = await runRouteProbeJob(h.deps);
    expect(calls).toBe(0);
    expect(run).toMatchObject({ outcome: 'ok', scanned: 1, found: 1, online: [] });
    expect(h.saved).toHaveLength(1);
    expect(h.saved[0]).toMatchObject({
      state: 'skipped',
      detail: UNUSED_ROUTE,
      tier: 'unused',
      nextAt: null,
      failStreak: 0,
      trigger: 'scheduled',
    });
    expect(h.savedPace).toEqual([]);
  });

  it('一轮：没到期的不真探、不写结论，只更新档和下次探测时刻；算看过，在不在线照库里那样算', async () => {
    let calls = 0;
    const counting: Prober = async () => {
      calls += 1;
      return { kind: 'answered', detail: '答上了：OK · 用时 4 秒' };
    };
    const top = target({ probeRank: 1, alive: true, previous: okAgo(50) });
    const down = target({
      routeId: 'down',
      poolId: 'down',
      orgKind: null,
      probeRank: 1,
      alive: false,
      previous: failed(2, 20),
    });
    const due = target({ routeId: 'due', poolId: 'due', orgKind: null, previous: null });
    const h = harness([top, down, due], counting);
    const run = await runRouteProbeJob(h.deps);
    expect(calls).toBe(1);
    expect(run).toMatchObject({ outcome: 'ok', scanned: 3, found: 1, online: [top.routeId, 'due'] });
    expect(h.saved.map((s) => s.routeId)).toEqual(['due']);
    expect(h.after.map((a) => a.routeId)).toEqual(['due']);
    expect(h.savedPace).toEqual([
      { routeId: top.routeId, tier: 'active', nextAt: minutesLater(10) },
      { routeId: 'down', tier: 'active', nextAt: minutesLater(10) },
    ]);
    expect(h.logs).toContain('info:路由探针：还没到再探的时候，结论照旧');
  });

  it('一轮里只有没到期的：记 ok（看过了），不记成一条都没扫到；没接 savePace 的照样跑完', async () => {
    const h = harness([target({ probeRank: 1, alive: true, previous: okAgo(50) })], answered);
    const run = await runRouteProbeJob(h.deps);
    expect(run).toMatchObject({ outcome: 'ok', scanned: 1, found: 0, online: [carpool.routeId] });
    expect(h.saved).toEqual([]);
    expect(h.finished).toEqual([{ id: 11, result: { outcome: 'ok', scanned: 1, found: 0 } }]);
    const bare = harness([target({ probeRank: 1, alive: true, previous: okAgo(50) })], answered);
    delete bare.deps.savePace;
    expect(await runRouteProbeJob(bare.deps)).toMatchObject({ outcome: 'ok', scanned: 1 });
  });

  it('没到期的那条路由这一轮当中被删了（savePace 回 route_not_found）：不算看过；写节奏出错只记日志、结论照旧', async () => {
    const gone = harness([target({ probeRank: 1, alive: true, previous: okAgo(50) }), carpool], answered, {
      savePace: async () => 'route_not_found',
    });
    const run = await runRouteProbeJob(gone.deps);
    expect(run).toMatchObject({ outcome: 'ok', scanned: 1 });
    const broken = harness([target({ probeRank: 1, alive: true, previous: okAgo(50) })], answered, {
      savePace: async () => {
        throw new Error('库只读');
      },
    });
    expect(await runRouteProbeJob(broken.deps)).toMatchObject({ outcome: 'ok', scanned: 1, found: 0 });
    expect(broken.logs.some((l) => l.startsWith('error:') && l.includes('下次探测时刻没写进库'))).toBe(true);
  });

  it('没到期的说明里写明档和下次什么时候；退避中的写下次几点', () => {
    expect(scheduled(target({ probeRank: 1, previous: okAgo(50) }))).toEqual({
      deferred: '活跃档，探通了隔 60 分钟再真探；下次约 10 分钟后',
    });
    expect(scheduled(target({ previous: failed(2, 20) }))).toEqual({
      deferred: '退避中，下次约 12:17 再探（连着不通 2 次）',
    });
  });

  it('真探通了：failStreak 回 0，下次探测按档（活跃 +60、不活跃 +1440），定时这一轮写 trigger: scheduled', async () => {
    const h = harness(
      [
        target({ probeRank: 1, previous: failed(4, 113) }),
        target({ routeId: 'idle', poolId: 'idle', orgKind: null, probeRank: 5, previous: null }),
      ],
      answered,
    );
    await runRouteProbeJob(h.deps);
    expect(h.saved[0]).toMatchObject({
      state: 'ok',
      tier: 'active',
      nextAt: minutesLater(60),
      failStreak: 0,
      trigger: 'scheduled',
    });
    expect(h.saved[0]?.detail).not.toContain('退避中');
    expect(h.saved[1]).toMatchObject({
      state: 'ok',
      tier: 'idle',
      nextAt: minutesLater(1440),
      failStreak: 0,
    });
  });

  it('真探没通：failStreak 加一，下次探测按退避档，结论带退避那句；封顶还是 240 分钟', async () => {
    const down: Prober = async () => ({ kind: 'failed', detail: '503 容量满' });
    const first = harness([target({ alive: false, previous: null })], down);
    await runRouteProbeJob(first.deps);
    expect(first.saved[0]?.detail).toContain('退避中，下次约 12:22 再探（连着不通 1 次）');
    expect(first.saved[0]?.detail).toContain('503 容量满');
    expect(first.saved[0]).toMatchObject({ failStreak: 1, nextAt: minutesLater(15), trigger: 'scheduled' });

    const third = harness([target({ failStreak: 3, previous: failed(3, 65) })], down);
    await runRouteProbeJob(third.deps);
    expect(third.saved[0]).toMatchObject({ failStreak: 4, nextAt: minutesLater(120), tier: 'idle' });
    expect(third.saved[0]?.detail).toContain('连着不通 4 次');

    const again = harness([target({ alive: false, previous: failed(5, 233) })], down);
    await runRouteProbeJob(again.deps);
    expect(again.saved[0]?.detail).toContain('退避中，下次约 16:07 再探（连着不通 6 次）');
    expect(again.saved[0]).toMatchObject({ failStreak: 6, nextAt: minutesLater(240) });
  });

  it('通了之后又不通：从 1 次数起，下次隔 15 分钟', async () => {
    const relapsed = harness([target({ alive: true, probeRank: 1, previous: okAgo(65) })], async () => ({
      kind: 'failed',
      detail: '又不通',
    }));
    await runRouteProbeJob(relapsed.deps);
    expect(relapsed.saved[0]?.detail).toContain('连着不通 1 次');
    expect(relapsed.saved[0]).toMatchObject({ failStreak: 1, nextAt: minutesLater(15) });
  });

  it('没真探的结论（按规矩不探）带档、连着不通次数和 trigger，下次探测放到下一轮', async () => {
    const h = harness(
      [mirasim, solo, target({ probeRank: 1, previous: null, billing: 'metered' })],
      answered,
    );
    await runRouteProbeJob(h.deps);
    expect(h.saved.find((s) => s.routeId === mirasim.routeId)).toMatchObject({
      state: 'not_wired',
      tier: 'unused',
      nextAt: null,
      trigger: 'scheduled',
    });
    expect(h.saved.find((s) => s.routeId === solo.routeId)).toMatchObject({
      state: 'skipped',
      tier: 'idle',
      nextAt: NOW,
      failStreak: 0,
    });
    expect(h.saved.find((s) => s.routeId === carpool.routeId)).toMatchObject({
      state: 'skipped',
      tier: 'active',
      nextAt: NOW,
    });
  });

  it('派前、人点的探测（不走定时节奏）真探完也带档和下次探测，但不写 trigger', async () => {
    const h = harness([], answered);
    const c = await conclude(h.deps, target({ probeRank: 1, previous: okAgo(5) }));
    expect(c).toMatchObject({ state: 'ok', tier: 'active', nextAt: minutesLater(60), failStreak: 0 });
    expect(c.trigger).toBeUndefined();
    expect(c.deferred).toBeUndefined();
  });

  it('切号核对只看真探了的：没到期的不算读回', async () => {
    const checked: { routeId: string }[][] = [];
    const h = harness(
      [target({ probeRank: 1, alive: true, previous: okAgo(50) }), target({ routeId: 'due', poolId: 'due' })],
      answered,
      {
        orgSwitch: {
          now: async () => null,
          before: async () => null,
          async after(_to, probed) {
            checked.push(probed.map((p) => ({ routeId: p.routeId })));
          },
        },
      },
    );
    await runRouteProbeJob(h.deps);
    expect(checked).toEqual([[{ routeId: 'due' }]]);
  });

  it('【故意造出的失败】读不到上一次开跑时间（读路由表抛了）：这一轮记 failed，一条都不写、不更新节奏', async () => {
    const h = harness([], answered, {
      targets: async () => {
        throw new Error('读 lastRunAt 失败：runs 表连不上');
      },
    });
    await expect(runRouteProbeJob(h.deps)).rejects.toMatchObject({
      name: 'RouteProbeFailedError',
      message: expect.stringContaining('读 lastRunAt 失败'),
    });
    expect(h.finished[0]?.result).toMatchObject({
      outcome: 'failed',
      why: expect.stringContaining('读路由表没成：读 lastRunAt 失败'),
    });
    expect(h.saved).toEqual([]);
    expect(h.savedPace).toEqual([]);
  });

  it('【故意造出的失败】读不到上一次探测时间：按到期该探，不跳过', () => {
    const unread = target({
      alive: false,
      probeRank: 1,
      previous: { state: 'failed', at: new Date(Number.NaN), detail: '没通（连着不通 8 次）' },
    });
    expect('probe' in scheduled(unread)).toBe(true);
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
