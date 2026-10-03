// real/segment-spawner.ts：三段无头会话的生产 Spawner（#632 S2-3）。
// 用假驱动（不起真执行体、不碰 sudo / systemd）：驱动报告怎么整理成 one-shot 的结局、路由和会话用户读不到时明确失败、
// 临时目录起前交给会话用户、收场后删（驱动抛错也删）、用量花费进 runs。每条失败路径故意造一次。

import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { RunFacts, SessionUser } from '@fleet-dao/adapters';
import type { RouteLaunchFacts } from '@fleet-dao/db';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { HostDriver, HostReport, HostRunHooks, HostRunSpec, WiredHost } from '../../src/real/hosts.ts';
import {
  hostSegmentSpawner,
  outcomeOfReport,
  SEGMENT_WALL_MARGIN_MS,
} from '../../src/real/segment-spawner.ts';
import type { RunRecord } from '../../src/runner/not-wired.ts';
import { OneShotError, type OneShotInput, runOneShot } from '../../src/runner/one-shot.ts';

const USER = 'fleet-agent-carpool' as SessionUser;
const RUN_ID = 'run-0001-aaaa';

const route = (over: Partial<RouteLaunchFacts> = {}): RouteLaunchFacts => ({
  routeId: 'r1',
  channelId: 'c1',
  poolId: 'p1',
  modelId: 'claude-opus-5-5',
  hostId: 'claude-code',
  upstreamModel: null,
  runAsUser: USER,
  orgKind: null,
  ...over,
});

/** 给的值是 undefined 就是「去掉这一项」（exactOptionalPropertyTypes 下不能把可选字段显式写成 undefined）。 */
function merge<T extends object>(base: T, over: { [K in keyof T]?: T[K] | undefined }): T {
  const out = { ...base } as Record<string, unknown>;
  for (const [k, v] of Object.entries(over)) {
    if (v === undefined) delete out[k];
    else out[k] = v;
  }
  return out as T;
}

const okFacts = (over: { [K in keyof RunFacts]?: RunFacts[K] | undefined } = {}): RunFacts =>
  merge<RunFacts>({ exitCode: 0, terminal: { isError: false, detail: 'done' }, quotaExhausted: false }, over);

const report = (over: { [K in keyof HostReport]?: HostReport[K] | undefined } = {}): HostReport =>
  merge<HostReport>(
    {
      hostId: 'claude-code',
      facts: okFacts(),
      usage: { inputTokens: 1200, outputTokens: 340, cacheReadTokens: 5000 },
      sessionCostUsd: 0.42,
      actualModel: 'claude-opus-5-5',
      answer: '已提交，改了 tier.ts',
      wallMs: 1000,
      stderrTail: '',
    },
    over,
  );

interface Harness {
  calls: { spec: HostRunSpec; hooks: HostRunHooks }[];
  adopted: { dir: string; user: SessionUser }[];
  removed: string[];
  order: string[];
  recorded: RunRecord[];
  spawn: ReturnType<typeof hostSegmentSpawner>;
  run: (
    input?: { [K in keyof OneShotInput]?: OneShotInput[K] | undefined },
    timeoutMinutes?: number,
  ) => ReturnType<typeof runOneShot>;
}

let tmp: string;
beforeEach(async () => {
  tmp = await mkdtemp(join(tmpdir(), 'fleet-segment-spawner-'));
});
afterEach(async () => {
  await rm(tmp, { recursive: true, force: true });
});

function harness(
  opts: {
    route?: RouteLaunchFacts | null;
    driverRun?: (spec: HostRunSpec, hooks: HostRunHooks) => Promise<HostReport>;
    userFrom?: HostDriver['userFrom'];
    unwired?: boolean;
  } = {},
): Harness {
  const calls: Harness['calls'] = [];
  const adopted: Harness['adopted'] = [];
  const removed: string[] = [];
  const order: string[] = [];
  const recorded: RunRecord[] = [];
  const driver = (hostId: WiredHost): HostDriver => ({
    hostId,
    userFrom: opts.userFrom ?? 'pool',
    canFork: hostId === 'claude-code',
    newSessionId: () => ({ id: '11111111-2222-4333-8444-555555555555', known: true }),
    async run(spec, hooks) {
      order.push('run');
      calls.push({ spec, hooks });
      return (opts.driverRun ?? (async () => report()))(spec, hooks);
    },
    loginFix: () => '去登录',
  });
  const drivers = {
    'claude-code': driver('claude-code'),
    'cursor-agent': driver('cursor-agent'),
    grok: driver('grok'),
    mirasim: driver('mirasim'),
  } as Record<WiredHost, HostDriver>;
  const spawn = hostSegmentSpawner({
    routeFacts: async () => (opts.route === undefined ? route() : opts.route),
    drivers,
    trees: {
      tmpFor: (runId) => `/var/lib/fleet-work/_tmp/${runId}`,
      async adopt(dir, user) {
        order.push('adopt');
        adopted.push({ dir, user });
      },
      async remove(dir) {
        order.push('remove');
        removed.push(dir);
        return { gone: false };
      },
    },
    baseEnv: { PATH: '/usr/bin', GITHUB_TOKEN: 'secret-should-not-pass' },
    resources: { memoryHighMb: 5888, memoryMaxMb: 6144, swapMaxMb: 0 },
  });
  const run: Harness['run'] = (input = {}, timeoutMinutes = 60) =>
    runOneShot(
      merge<OneShotInput>(
        {
          runId: RUN_ID,
          segment: 'manual',
          modelId: 'claude-opus-5-5',
          routeId: 'r1',
          prompt: '干这件事',
          cwd: '/var/lib/fleet-work/acme_demo/12-x',
          timeoutMinutes,
        },
        input,
      ),
      {
        spawn,
        runs: {
          async start() {},
          async record(r) {
            recorded.push(r);
          },
        },
        tmpDir: tmp,
      },
    );
  return { calls, adopted, removed, order, recorded, spawn, run };
}

describe('hostSegmentSpawner · 成功', () => {
  it('驱动报告 ok → one-shot 判 done；回答正文当 stdout；用量花费记进 runs', async () => {
    const h = harness();
    const r = await h.run();
    expect(r.outcome).toBe('done');
    expect(r.exitCode).toBe(0);
    expect(r.stdout).toBe('已提交，改了 tier.ts');
    expect(r.facts).toMatchObject({
      actualModel: 'claude-opus-5-5',
      quotaExhausted: false,
      reason: 'answered',
    });
    expect(h.recorded).toHaveLength(1);
    expect(h.recorded[0]).toMatchObject({
      runId: RUN_ID,
      segment: 'manual',
      outcome: 'done',
      inputTokens: 1200,
      outputTokens: 340,
      cacheReadTokens: 5000,
      costUsd: 0.42,
    });
    // 读不到的字段不写：没有缓存写入这一项，就不该出现 0
    expect(h.recorded[0]).not.toHaveProperty('cacheWriteTokens');
  });

  it('起驱动的参数：开新会话、一次性、不脱开引擎、干活的会话、思考档位原样传', async () => {
    const h = harness();
    await h.run({ effort: 'medium' });
    const { spec, hooks } = h.calls[0] ?? { spec: undefined, hooks: undefined };
    expect(spec).toMatchObject({
      runId: RUN_ID,
      user: USER,
      cwd: '/var/lib/fleet-work/acme_demo/12-x',
      prompt: '干这件事',
      model: 'claude-opus-5-5',
      effort: 'medium',
      purpose: 'work',
      testCommands: [],
      session: { mode: 'new', id: '11111111-2222-4333-8444-555555555555' },
      cgroup: {
        id: RUN_ID,
        user: USER,
        limits: { memoryHigh: '5888M', memoryMax: '6144M', memorySwapMax: '0' },
      },
    });
    expect(hooks).not.toHaveProperty('io'); // 不脱开引擎进程跑
    expect(hooks?.signal).toBeInstanceOf(AbortSignal);
  });

  it('上游模型串优先于目录里的模型 id', async () => {
    const h = harness({ route: route({ upstreamModel: 'claude-opus-5-5[1m]' }) });
    await h.run();
    expect(h.calls[0]?.spec.model).toBe('claude-opus-5-5[1m]');
  });

  it('环境：只抄白名单里的键，GitHub 凭据进不去；不发 fleet 通行证', async () => {
    const h = harness();
    await h.run();
    const env = h.calls[0]?.spec.env;
    expect(env).toMatchObject({ fleetApi: '', fleetToken: '', tmpDir: `/var/lib/fleet-work/_tmp/${RUN_ID}` });
    // 真正进会话环境的是 buildSessionEnv 过滤后的：这里确认传的是宿主环境的引用，由它去过滤
    expect(env?.base).toMatchObject({ PATH: '/usr/bin' });
  });

  it('驱动自己的总时长比 one-shot 的时限早一分钟到', async () => {
    const h = harness();
    await h.run({}, 30);
    expect(h.calls[0]?.spec.limits.wallClockMs).toBe(30 * 60_000 - SEGMENT_WALL_MARGIN_MS);
  });

  it('临时目录：起驱动前交给会话用户，收场后删', async () => {
    const h = harness();
    await h.run();
    expect(h.order).toEqual(['adopt', 'run', 'remove']);
    expect(h.adopted).toEqual([{ dir: `/var/lib/fleet-work/_tmp/${RUN_ID}`, user: USER }]);
    expect(h.removed).toEqual([`/var/lib/fleet-work/_tmp/${RUN_ID}`]);
  });
});

describe('outcomeOfReport · 【故意造出的失败】不是 ok 的，退出码就不是 0', () => {
  it('终帧报错、进程退出码却是 0 → 退出码 1，reason 是 agent_error', () => {
    const o = outcomeOfReport(
      report({ facts: okFacts({ exitCode: 0, terminal: { isError: true, detail: 'API Error 529' } }) }),
    );
    expect(o.exitCode).toBe(1);
    expect(o.killed).toBe(false);
    expect(o.facts).toMatchObject({ reason: 'agent_error', detail: 'API Error 529' });
    expect(o.stderr).toContain('API Error 529');
  });

  it('没有终帧 → 失败（no_result），带最后几句话', () => {
    const o = outcomeOfReport(
      report({
        facts: okFacts({ exitCode: 0, terminal: undefined, lastWords: '连接被重置' }),
        stderrTail: 'econnreset',
      }),
    );
    expect(o.exitCode).toBe(1);
    expect(o.facts?.reason).toBe('no_result');
    expect(o.stderr).toContain('连接被重置');
    expect(o.stderr).toContain('econnreset');
  });

  it('进程自己退出码非 0 → 保留它的退出码', () => {
    const o = outcomeOfReport(report({ facts: okFacts({ exitCode: 137, terminal: undefined }) }));
    expect(o.exitCode).toBe(137);
  });

  it('额度用满 → 失败，额度事实和清零时刻带回去', () => {
    const o = outcomeOfReport(
      report({
        facts: okFacts({ quotaExhausted: true, terminal: { isError: true, detail: 'limit' } }),
        resetsAt: '2026-10-02T18:00:00.000Z',
        httpStatus: 429,
      }),
    );
    expect(o.exitCode).toBe(1);
    expect(o.facts).toMatchObject({
      quotaExhausted: true,
      resetsAt: '2026-10-02T18:00:00.000Z',
      httpStatus: 429,
      reason: 'quota_exhausted',
    });
  });

  it('被我们的看守杀掉（总时长到顶）→ killed，退出码 null', () => {
    const o = outcomeOfReport(
      report({ facts: okFacts({ exitCode: null, killed: 'wall_clock_timeout', terminal: undefined }) }),
    );
    expect(o.killed).toBe(true);
    expect(o.exitCode).toBeNull();
    expect(o.facts?.reason).toBe('wall_clock_timeout');
  });

  it('模型对不上（点名的不是实际回话的）→ 失败，不当成功', () => {
    const o = outcomeOfReport(
      report({
        facts: okFacts({ mismatch: { kind: 'model', expected: 'opus', observed: 'sonnet' } }),
      }),
    );
    expect(o.exitCode).toBe(1);
    expect(o.facts?.reason).toBe('model_mismatch');
  });

  it('中转没查成 → 失败，原因码 relay_unknown 原样带回（调用方见到它停下报人，不重跑）', () => {
    const o = outcomeOfReport(report({ facts: okFacts({ relayUnknown: '账本没读成' }) }));
    expect(o.exitCode).toBe(1);
    expect(o.facts?.reason).toBe('relay_unknown');
  });

  it('起不来 → 失败（spawn_failed）', () => {
    const o = outcomeOfReport(
      report({ facts: { spawnError: 'reclaude 不在', quotaExhausted: false }, answer: undefined }),
    );
    expect(o.exitCode).toBe(1);
    expect(o.facts?.reason).toBe('spawn_failed');
    expect(o.stdout).toBe('');
  });
});

describe('hostSegmentSpawner · 经 runOneShot 的结局', () => {
  it('终帧报错 → one-shot 判 failed，runs 记 failed（不是 done）', async () => {
    const h = harness({
      driverRun: async () => report({ facts: okFacts({ terminal: { isError: true, detail: '上游 529' } }) }),
    });
    const r = await h.run();
    expect(r.outcome).toBe('failed');
    expect(h.recorded[0]?.outcome).toBe('failed');
    expect(r.facts?.reason).toBe('agent_error');
  });

  it('我们自己的信号触发（one-shot 超时）→ 驱动被杀、结局 timeout', async () => {
    const h = harness({
      driverRun: (_spec, hooks) =>
        new Promise((resolve) => {
          hooks.signal?.addEventListener('abort', () =>
            resolve(report({ facts: okFacts({ exitCode: null, killed: 'aborted', terminal: undefined }) })),
          );
        }),
    });
    const started = Date.now();
    const r = await h.run({}, 0.002); // 0.002 分钟 = 120 毫秒
    expect(Date.now() - started).toBeLessThan(5000);
    expect(r.outcome).toBe('timeout');
    expect(h.recorded[0]?.outcome).toBe('timeout');
  });

  it('驱动抛错 → 临时目录照样删，错误往上抛成 SPAWN_FAILED', async () => {
    const h = harness({
      driverRun: async () => {
        throw new Error('帮手脚本起不来');
      },
    });
    await expect(h.run()).rejects.toThrow(OneShotError);
    expect(h.order).toEqual(['adopt', 'run', 'remove']);
  });
});

const command = (): Parameters<ReturnType<typeof hostSegmentSpawner>>[0] => ({
  argv: [],
  cwd: '/w',
  stdin: 'p',
  signal: new AbortController().signal,
  input: { runId: RUN_ID, segment: 'manual', modelId: 'm', routeId: 'r1', prompt: 'p', cwd: '/w' },
  timeoutMs: 60_000,
});

describe('hostSegmentSpawner · 【故意造出的失败】读不到、认不出就明确失败，不落到默认执行体', () => {
  const failsWith = async (h: Harness, text: RegExp) => {
    await expect(h.run()).rejects.toThrow(text);
    expect(h.calls).toEqual([]); // 一次驱动都没起
    expect(h.adopted).toEqual([]); // 临时目录也没建
  };

  it('这一段没给路由编号', async () => {
    const h = harness();
    await expect(h.run({ routeId: undefined })).rejects.toThrow(/没给路由编号/);
    expect(h.calls).toEqual([]);
  });

  it('库里没有这条路由', async () => {
    await failsWith(harness({ route: null }), /库里没有路由 r1/);
  });

  it('执行方式引擎没接上', async () => {
    await failsWith(harness({ route: route({ hostId: 'codex' as never }) }), /还没接上/);
  });

  it('池没绑会话用户（Claude 池）→ 起不了，不瞎挑一个', async () => {
    await failsWith(harness({ route: route({ runAsUser: null }) }), /没定会话用户/);
  });

  it('资源上限不是非负整数 → 拒，不起驱动', async () => {
    let started = false;
    const driver: HostDriver = {
      hostId: 'claude-code',
      userFrom: 'pool',
      canFork: true,
      newSessionId: () => ({ id: '11111111-2222-4333-8444-555555555555', known: true }),
      run: async () => {
        started = true;
        return report();
      },
      loginFix: () => '',
    };
    const spawn = hostSegmentSpawner({
      routeFacts: async () => route(),
      drivers: { 'claude-code': driver } as unknown as Record<WiredHost, HostDriver>,
      trees: { tmpFor: () => '/x', adopt: async () => undefined, remove: async () => ({ gone: true }) },
      baseEnv: {},
      resources: { memoryHighMb: -1, memoryMaxMb: 6144, swapMaxMb: 0 },
    });
    await expect(spawn(command())).rejects.toThrow(/memoryHighMb/);
    expect(started).toBe(false);
  });

  it('没装路由查询 → 起不了（不拿空顶）', async () => {
    const spawn = hostSegmentSpawner({
      drivers: {} as Record<WiredHost, HostDriver>,
      trees: { tmpFor: () => '/x', adopt: async () => undefined, remove: async () => ({ gone: true }) },
      baseEnv: {},
      resources: { memoryHighMb: 1, memoryMaxMb: 2, swapMaxMb: 0 },
    });
    await expect(spawn(command())).rejects.toThrow(/没装路由查询/);
  });
});
