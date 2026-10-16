// real/segment-spawner.ts：三段无头会话的生产 Spawner（#632 S2-3）。
// 用假驱动（不起真执行体、不碰 sudo / systemd）：驱动报告怎么整理成 one-shot 的结局、路由和会话用户读不到时明确失败、
// 临时目录起前交给会话用户、收场后删（驱动抛错也删）、用量花费进 runs。每条失败路径故意造一次。

import { randomUUID } from 'node:crypto';
import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { buildSessionEnv, type RateLimitReading, type RunFacts, type SessionUser } from '@fleet-dao/adapters';
import {
  type Db,
  getRun,
  type RouteLaunchFacts,
  readRunTranscript,
  startRun,
  type TranscriptRow,
} from '@fleet-dao/db';
import { createTestDb, resetTestDb, TEST_DB_TIMEOUT_MS, type TestDb } from '@fleet-dao/db/testing';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import type { CarpoolRejection } from '../../src/jobs/carpool-outage.ts';
import type { CpuUsageDeps } from '../../src/real/cpu-usage.ts';
import type { HostDriver, HostReport, HostRunHooks, HostRunSpec, WiredHost } from '../../src/real/hosts.ts';
import type { MemoryPeakDeps } from '../../src/real/memory-peak.ts';
import {
  hostSegmentSpawner,
  MIRASIM_CPU_UNREAD,
  MIRASIM_MEMORY_UNREAD,
  outcomeOfReport,
  SEGMENT_WALL_MARGIN_MS,
} from '../../src/real/segment-spawner.ts';
import {
  DETACHED_MARK,
  readMirasimHandle,
  type SessionHandoff,
  sessionHandoff,
  writeMirasimHandle,
} from '../../src/real/session-handoff.ts';
import type { RunRecord } from '../../src/runner/not-wired.ts';
import { OneShotDetached, OneShotError, type OneShotInput, runOneShot } from '../../src/runner/one-shot.ts';

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
  effort: null,
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
  logs: string[];
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
    /** 给了就把会话流里读到的额度记到库里（路由查询照样走 routeFacts）。 */
    db?: Db;
    /** 拼车池上的会话没成：被拒的证据当场交给谁（#194）。 */
    onCarpoolRejection?: (rejection: CarpoolRejection) => void;
    /** 给了就采 scope 的内存峰值（#948）；readText 假的，不碰真 cgroup。 */
    memoryPeak?: MemoryPeakDeps;
    /** 给了就采 scope 的 CPU 秒数（#1980）；readText 假的，不碰真 cgroup。 */
    cpuUsage?: CpuUsageDeps;
    /** 会话过程记录（#1640）写到哪；不给就不记。 */
    transcriptWrite?: (runId: string, rows: TranscriptRow[]) => Promise<void>;
    /** 动手会话脱开引擎跑（#2238）。 */
    handoff?: SessionHandoff;
    /** 流里拿到会话号时的 runs 写回钩子。 */
    observeSessionId?: (runId: string, sessionId: string) => Promise<void>;
  } = {},
): Harness {
  const calls: Harness['calls'] = [];
  const adopted: Harness['adopted'] = [];
  const removed: string[] = [];
  const order: string[] = [];
  const recorded: RunRecord[] = [];
  const logs: string[] = [];
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
    ...(opts.db ? { db: opts.db } : {}),
    ...(opts.memoryPeak ? { memoryPeak: opts.memoryPeak } : {}),
    ...(opts.cpuUsage ? { cpuUsage: opts.cpuUsage } : {}),
    ...(opts.transcriptWrite ? { transcriptWrite: opts.transcriptWrite, transcriptFlushMs: 5 } : {}),
    ...(opts.onCarpoolRejection ? { onCarpoolRejection: opts.onCarpoolRejection } : {}),
    ...(opts.handoff ? { handoff: opts.handoff } : {}),
    ...(opts.observeSessionId ? { runs: { observeSessionId: opts.observeSessionId } } : {}),
    log: (message, fields) => void logs.push(`${message} ${JSON.stringify(fields ?? {})}`),
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
          async start() {
            order.push('start');
          },
          async record(r) {
            recorded.push(r);
          },
        },
        tmpDir: tmp,
      },
    );
  return { calls, adopted, removed, order, recorded, logs, spawn, run };
}

describe('hostSegmentSpawner · 会话号与花费', () => {
  it('流里拿到真会话号时立即交给 runs 写回，临时号不写', async () => {
    const observed: string[] = [];
    const h = harness({
      observeSessionId: async (_runId, sessionId) => {
        observed.push(sessionId);
      },
      driverRun: async (_spec, hooks) => {
        hooks.onSessionId?.('claude:real-1');
        hooks.onSessionId?.('mirasim-pending:run-1');
        return report({ sessionId: 'claude:real-1' });
      },
    });
    await h.run();
    expect(observed).toEqual(['claude:real-1']);
  });
});

describe('hostSegmentSpawner · 内存峰值（#948）', () => {
  const FAKE_PEAK = (readText: MemoryPeakDeps['readText']): MemoryPeakDeps => ({
    readText,
    cgroupRoot: '/sys/fs/cgroup',
    slicePath: 'fleet.slice/fleet-agents.slice',
    intervalMs: 5,
  });
  const afterAWhile = () => new Promise((r) => setTimeout(r, 40));

  it('会话跑着时读到的最大那次进 runs.memory_peak_mb（向上取整成 MB）；读的是这个会话自己的 scope', async () => {
    const paths: string[] = [];
    let n = 0;
    const h = harness({
      memoryPeak: FAKE_PEAK(async (path) => {
        paths.push(path);
        n += 1;
        return String(n >= 3 ? 300 * 1024 * 1024 + 1 : 100 * 1024 * 1024);
      }),
      driverRun: async () => {
        await afterAWhile();
        return report();
      },
    });
    const r = await h.run();
    expect(r.outcome).toBe('done');
    expect(h.recorded[0]?.memoryPeakMb).toBe(301);
    expect(paths[0]).toBe(
      `/sys/fs/cgroup/fleet.slice/fleet-agents.slice/fleet-agent-${RUN_ID}.scope/memory.peak`,
    );
  });

  it('【故意造出的失败】峰值文件一直不在（没有 cgroup / scope 没建出来）：runs 那一列留空、不写 0，原因进日志和结局', async () => {
    const h = harness({
      memoryPeak: FAKE_PEAK(async () => {
        throw Object.assign(new Error('ENOENT: no such file'), { code: 'ENOENT' });
      }),
      driverRun: async () => {
        await afterAWhile();
        return report();
      },
    });
    const r = await h.run();
    expect(r.outcome).toBe('done');
    expect(h.recorded[0]).not.toHaveProperty('memoryPeakMb');
    expect(r.facts?.memoryPeakWhy).toContain('一直不在');
    expect(h.logs.join('\n')).toContain('会话内存峰值没读到');
  });

  it('【故意造出的失败】峰值文件在但认不出（不是数字、是 0、读不了）：同样留空、写明原因，不拿 0 或别的数顶', async () => {
    for (const bad of [
      async () => 'max\n',
      async () => '0\n',
      async () => {
        throw Object.assign(new Error('EACCES: permission denied'), { code: 'EACCES' });
      },
    ]) {
      const h = harness({
        memoryPeak: FAKE_PEAK(bad),
        driverRun: async () => {
          await afterAWhile();
          return report();
        },
      });
      const r = await h.run();
      expect(h.recorded[0]).not.toHaveProperty('memoryPeakMb');
      expect(r.facts?.memoryPeakWhy).toContain('内存峰值没读成');
    }
  });

  it('不给 memoryPeak（没有 cgroup 的开发机、别的测试）：不采、不记原因，那一列照旧留空', async () => {
    const h = harness();
    const r = await h.run();
    expect(h.recorded[0]).not.toHaveProperty('memoryPeakMb');
    expect(r.facts).not.toHaveProperty('memoryPeakWhy');
  });
});

describe('hostSegmentSpawner · CPU 秒数（#1980）', () => {
  const FAKE_CPU = (readText: CpuUsageDeps['readText']): CpuUsageDeps => ({
    readText,
    cgroupRoot: '/sys/fs/cgroup',
    slicePath: 'fleet.slice/fleet-agents.slice',
    intervalMs: 5,
  });
  const afterAWhile = () => new Promise((r) => setTimeout(r, 40));
  const stat = (usec: number) => `usage_usec ${usec}\nuser_usec 1\nsystem_usec 1\n`;

  it('收场时把 cpu.stat 的 usage_usec 折成秒写进 runs；读的是这个会话自己的 scope', async () => {
    const paths: string[] = [];
    const h = harness({
      cpuUsage: FAKE_CPU(async (path) => {
        paths.push(path);
        return stat(720_000_000);
      }),
      driverRun: async () => {
        await afterAWhile();
        return report();
      },
    });
    const r = await h.run();
    expect(r.outcome).toBe('done');
    expect(h.recorded[0]?.cpuSeconds).toBe(720);
    expect(paths[0]).toBe(
      `/sys/fs/cgroup/fleet.slice/fleet-agents.slice/fleet-agent-${RUN_ID}.scope/cpu.stat`,
    );
  });

  it('【故意造出的失败】cpu.stat 一直不在、或 usage_usec 是 0：runs 那一列留空、不写 0，原因进日志', async () => {
    for (const readText of [
      async () => {
        throw Object.assign(new Error('ENOENT: no such file'), { code: 'ENOENT' });
      },
      async () => stat(0),
    ]) {
      const h = harness({
        cpuUsage: FAKE_CPU(readText),
        driverRun: async () => {
          await afterAWhile();
          return report();
        },
      });
      const r = await h.run();
      expect(r.outcome).toBe('done');
      expect(h.recorded[0]).not.toHaveProperty('cpuSeconds');
      expect(h.recorded[0]?.cpuSeconds).not.toBe(0);
      expect(r.facts?.cpuWhy).toBeTruthy();
      expect(h.logs.join('\n')).toContain('会话 CPU 没读到');
    }
  });

  it('不给 cpuUsage：不采、不记原因，那一列留空', async () => {
    const h = harness();
    const r = await h.run();
    expect(h.recorded[0]).not.toHaveProperty('cpuSeconds');
    expect(r.facts).not.toHaveProperty('cpuWhy');
  });
});

describe('hostSegmentSpawner · Mirasim 不采本机 scope', () => {
  const FAKE_PEAK = (readText: MemoryPeakDeps['readText']): MemoryPeakDeps => ({
    readText,
    cgroupRoot: '/sys/fs/cgroup',
    slicePath: 'fleet.slice/fleet-agents.slice',
    intervalMs: 5,
  });
  const FAKE_CPU = (readText: CpuUsageDeps['readText']): CpuUsageDeps => ({
    readText,
    cgroupRoot: '/sys/fs/cgroup',
    slicePath: 'fleet.slice/fleet-agents.slice',
    intervalMs: 5,
  });

  it('起会话时不读 fleet-agent-<runId>.scope，也不读桥接的 mirasim-<随机>.scope；事实里写明记不到，不说没有 cgroup', async () => {
    const paths: string[] = [];
    const read = async (path: string) => {
      paths.push(path);
      return '999';
    };
    const h = harness({
      route: route({ hostId: 'mirasim' }),
      memoryPeak: FAKE_PEAK(read),
      cpuUsage: FAKE_CPU(read),
      driverRun: async () => report({ hostId: 'mirasim' }),
    });
    const r = await h.run();
    expect(r.outcome).toBe('done');
    // 采样路径跟实际起的 scope 对不上：桥接起的是 fleet-agent-mirasim-<随机>.scope，而且只是桥接进程。
    // 不采，不把桥接的数写成这一段的用量。
    expect(paths).toEqual([]);
    expect(h.calls[0]?.spec.cgroup.id).toBe(RUN_ID);
    expect(h.recorded[0]).not.toHaveProperty('memoryPeakMb');
    expect(h.recorded[0]).not.toHaveProperty('cpuSeconds');
    expect(r.facts).not.toHaveProperty('memoryPeakMb');
    expect(r.facts).not.toHaveProperty('cpuSeconds');
    expect(r.facts?.memoryPeakWhy).toBe(MIRASIM_MEMORY_UNREAD);
    expect(r.facts?.cpuWhy).toBe(MIRASIM_CPU_UNREAD);
    expect(r.facts?.memoryPeakWhy).not.toContain('没有 cgroup');
    expect(r.facts?.memoryPeakWhy).not.toContain('scope 没建出来');
    expect(r.facts?.cpuWhy).not.toContain('没有 cgroup');
    expect(r.facts?.cpuWhy).not.toContain('scope 没建出来');
    const logs = h.logs.join('\n');
    expect(logs).toContain('会话内存峰值没读到');
    expect(logs).toContain('会话 CPU 没读到');
    expect(logs).toContain(MIRASIM_MEMORY_UNREAD);
    expect(logs).toContain(MIRASIM_CPU_UNREAD);
    expect(logs).not.toContain('没有 cgroup');
    expect(logs).not.toContain('scope 没建出来');
    expect(logs).not.toContain(`fleet-agent-${RUN_ID}.scope`);
    const meta = JSON.parse(await readFile(join(tmp, RUN_ID, 'result.json'), 'utf8')) as {
      memoryPeakWhy?: string;
      cpuWhy?: string;
      memoryPeakMb?: number;
      cpuSeconds?: number;
    };
    expect(meta.memoryPeakWhy).toBe(MIRASIM_MEMORY_UNREAD);
    expect(meta.cpuWhy).toBe(MIRASIM_CPU_UNREAD);
    expect(meta.memoryPeakMb).toBeUndefined();
    expect(meta.cpuSeconds).toBeUndefined();
  });
});

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

  it('起驱动的参数：开新会话、一次性、不脱开引擎、干活的会话；分档给的档位原样交给驱动（路由没配就不给 effort）', async () => {
    const h = harness();
    await h.run({ effort: 'medium' });
    const { spec, hooks } = h.calls[0] ?? { spec: undefined, hooks: undefined };
    expect(spec).not.toHaveProperty('effort');
    expect(spec).toMatchObject({
      runId: RUN_ID,
      user: USER,
      cwd: '/var/lib/fleet-work/acme_demo/12-x',
      prompt: '干这件事',
      model: 'claude-opus-5-5',
      tierEffort: 'medium',
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

  it('路由配了思考档位：和分档给的一起原样交给驱动（合成哪一档由驱动的 applySessionEffort 定）', async () => {
    const h = harness({ route: route({ effort: 'xhigh' }) });
    await h.run({ effort: 'medium' });
    await h.run({ effort: undefined });
    expect(h.calls.map((c) => [c.spec.effort, c.spec.tierEffort])).toEqual([
      ['xhigh', 'medium'],
      ['xhigh', undefined],
    ]);
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

  it('指挥官会话（#2061）直接调 Spawner：带 resumeSessionId 就续那个会话（--resume），不带开新的；过程每一条交给调用方', async () => {
    const seen: string[] = [];
    const h = harness({
      driverRun: async (_spec, hooks) => {
        hooks.onTranscript?.(
          { at: 't', kind: 'tool_call', text: 'Read src/a.ts', tool: 'Read' },
          {} as never,
        );
        hooks.onTranscript?.({ at: 't', kind: 'assistant', text: '我读了' }, {} as never);
        return report();
      },
    });
    const base = {
      argv: [],
      cwd: '/w/intake',
      stdin: '接着聊',
      signal: new AbortController().signal,
      timeoutMs: 10 * 60_000,
      input: {
        runId: 'run-chat-1',
        segment: 'scope' as const,
        modelId: 'm',
        routeId: 'r1',
        prompt: 'p',
        cwd: '/w',
      },
    };
    await h.spawn({ ...base, resumeSessionId: 'sess-42', onTranscript: (e) => void seen.push(e.kind) });
    await h.spawn({ ...base, input: { ...base.input, runId: 'run-chat-2' } });
    expect(h.calls.map((c) => c.spec.session)).toEqual([
      { mode: 'resume', id: 'sess-42' },
      { mode: 'new', id: '11111111-2222-4333-8444-555555555555' },
    ]);
    expect(seen).toEqual(['tool_call', 'assistant']);
    // 会话真拿到的环境（buildSessionEnv 过滤后）没有 GitHub 令牌
    const env = buildSessionEnv(h.calls[0]?.spec.env as Parameters<typeof buildSessionEnv>[0]);
    expect(Object.keys(env).some((k) => /GITHUB|GH_TOKEN/i.test(k))).toBe(false);
  });

  it('【故意造出的失败】调用方的流抛错：只记日志，会话照样收场', async () => {
    const h = harness({
      driverRun: async (_spec, hooks) => {
        hooks.onTranscript?.({ at: 't', kind: 'assistant', text: 'x' }, {} as never);
        return report();
      },
    });
    const out = await h.spawn({
      argv: [],
      cwd: '/w',
      stdin: 's',
      signal: new AbortController().signal,
      timeoutMs: 60_000,
      input: { runId: 'run-chat-3', segment: 'scope', modelId: 'm', routeId: 'r1', prompt: 'p', cwd: '/w' },
      onTranscript: () => {
        throw new Error('页面断了');
      },
    });
    expect(out.exitCode).toBe(0);
    expect(h.logs.some((l) => l.includes('会话过程的流没交出去') && l.includes('页面断了'))).toBe(true);
  });

  it('驱动自己的总时长比 one-shot 的时限早一分钟到', async () => {
    const h = harness();
    await h.run({}, 30);
    expect(h.calls[0]?.spec.limits.wallClockMs).toBe(30 * 60_000 - SEGMENT_WALL_MARGIN_MS);
  });

  it('临时目录：起驱动前交给会话用户，收场后删', async () => {
    const h = harness();
    await h.run();
    expect(h.order).toEqual(['start', 'adopt', 'run', 'remove']);
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

  it('会话号带回去记进 runs（用量补记凭它补读，#1935）；起会话前的临时号不带', () => {
    const real = outcomeOfReport(report({ sessionId: 'claude:403c41e2-8629-410a-8d7a-d61f65add9be' }));
    expect(real.facts?.sessionId).toBe('claude:403c41e2-8629-410a-8d7a-d61f65add9be');
    const pending = outcomeOfReport(report({ sessionId: 'mirasim-pending:r-1' }));
    expect(pending.facts).not.toHaveProperty('sessionId');
  });

  it('执行体报告的本轮折算花费传进 runs，不把缺失花费写成 0', () => {
    expect(outcomeOfReport(report({ costUsd: 0.04253468 })).facts?.costUsd).toBe(0.04253468);
    expect(
      outcomeOfReport(report({ costUsd: undefined, sessionCostUsd: undefined })).facts,
    ).not.toHaveProperty('costUsd');
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
    expect(h.order).toEqual(['start', 'adopt', 'run', 'remove']);
  });
});

describe('hostSegmentSpawner · 会话流里读到的额度（#59：切号、选路靠它知道拼车用满了）', () => {
  const RESETS = '2026-10-02T18:00:00.000Z';
  const rejectedReading = {
    status: 'rejected',
    exhausted: true,
    rateLimitType: 'five_hour',
    resetsAt: RESETS,
    windows: [{ name: 'five_hour', utilization: 1, resetsAt: RESETS }],
    observedAt: '2026-10-02T13:00:00.000Z',
  } as RateLimitReading;
  /** 像插头那样：读到一帧额度就交给 onRateLimit，收场前等它交回的东西落定（adapters 的 CallbackGate）。 */
  const rejectedRun = async (_spec: HostRunSpec, hooks: HostRunHooks) => {
    await hooks.onRateLimit?.(rejectedReading);
    return report({
      facts: okFacts({ quotaExhausted: true, terminal: { isError: true, detail: 'usage limit reached' } }),
      resetsAt: RESETS,
    });
  };

  it('给了库：交回写库那一下，插头收场前等它落定（这一段交回「额度用满」时读数已经在库里，重新选路不会又派回这个池）', async () => {
    let commit: (value: unknown) => void = () => {};
    const writing = new Promise((resolve) => {
      commit = resolve;
    });
    // savePoolQuota 在一个事务里写：事务没落定，写库那一下就没落定
    const db = { transaction: () => writing } as unknown as Db;
    let saved = false;
    const h = harness({
      db,
      driverRun: async (spec, hooks) => {
        const pending = hooks.onRateLimit?.(rejectedReading);
        expect(pending).toBeInstanceOf(Promise);
        void (pending as Promise<unknown>).then(() => {
          saved = true;
        });
        await new Promise((r) => setTimeout(r, 10));
        expect(saved).toBe(false);
        commit({ written: 1, skippedAsOlder: 0, markedStale: 0, deleted: 0 });
        await pending;
        expect(saved).toBe(true);
        return rejectedRun(spec, {});
      },
    });
    const r = await h.run();
    expect(r.facts?.reason).toBe('quota_exhausted');
    expect(h.logs.join('\n')).not.toContain('没记上');
  });

  it('没给库：不接额度回调（读数没处记，不假装记过）', async () => {
    const h = harness({ driverRun: rejectedRun });
    await h.run();
    expect(h.calls[0]?.hooks.onRateLimit).toBeUndefined();
  });

  it('【故意造出的失败】额度记不进库：只记日志，这一段照样交回「额度用满」（不当成起不来、不改结局）', async () => {
    const broken = {} as unknown as Db;
    const h = harness({ db: broken, driverRun: rejectedRun });
    const r = await h.run();
    expect(r).toMatchObject({ outcome: 'failed', facts: { reason: 'quota_exhausted', resetsAt: RESETS } });
    expect(h.recorded[0]?.outcome).toBe('failed');
    expect(h.logs.join('\n')).toContain('一次性会话读到的额度没记上');
    expect(h.logs.join('\n')).toContain('"poolId":"p1"');
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

  it('路由配的思考档位这家不认（Grok 没有 max）、cursor 的整串模型名配不了 → 起不了，说清是哪条路由、为什么', async () => {
    await failsWith(
      harness({ route: route({ hostId: 'grok', upstreamModel: 'grok-4.7', effort: 'max' }) }),
      /路由 r1 配的思考档位起不了会话.*Grok 命令行 不支持思考档位（effort）max/,
    );
    await failsWith(
      harness({
        route: route({ hostId: 'cursor-agent', upstreamModel: 'gpt-5.6-luna-high', effort: 'high' }),
        userFrom: 'sole',
      }),
      /路由 r1 配的思考档位起不了会话.*Cursor Agent 不支持单独传思考档位/,
    );
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

describe('hostSegmentSpawner · 拼车被拒当场交给切号（#194）', () => {
  const rejectedReport = () =>
    report({
      facts: okFacts({
        quotaExhausted: true,
        terminal: { isError: true, detail: '拼车 5 小时额度已用完，约 120 分钟后重置' },
      }),
      resetsAt: '2099-01-01T00:00:00.000Z',
      httpStatus: 429,
    });

  it('拼车池上被拒：把证据（码、状态码、清零时刻、原文）当场交出去；会话结局照旧', async () => {
    const seen: CarpoolRejection[] = [];
    const h = harness({
      route: route({ orgKind: 'carpool' }),
      driverRun: async () => rejectedReport(),
      onCarpoolRejection: (r) => void seen.push(r),
    });
    const r = await h.run();
    expect(r.outcome).toBe('failed');
    expect(seen).toHaveLength(1);
    expect(seen[0]).toMatchObject({ code: 'quota_exhausted', httpStatus: 429 });
    expect(seen[0]?.resetsAt).toEqual(new Date('2099-01-01T00:00:00.000Z'));
    expect(seen[0]?.text).toContain('拼车 5 小时额度已用完');
  });

  it('【故意造出的失败】不是拼车池（独享、别家）的被拒不交；成功的不交；被我们杀掉的不交', async () => {
    const seen: CarpoolRejection[] = [];
    for (const [orgKind, driverRun] of [
      ['solo', async () => rejectedReport()],
      [null, async () => rejectedReport()],
      ['carpool', async () => report()],
      [
        'carpool',
        async () =>
          report({ facts: okFacts({ exitCode: null, killed: 'wall_clock_timeout', terminal: undefined }) }),
      ],
    ] as const) {
      const h = harness({
        route: route({ orgKind }),
        driverRun,
        onCarpoolRejection: (r) => void seen.push(r),
      });
      await h.run();
    }
    expect(seen).toEqual([]);
  });

  it('【故意造出的失败】交证据的那一步抛了：只记日志，会话结局照旧、不抛', async () => {
    const h = harness({
      route: route({ orgKind: 'carpool' }),
      driverRun: async () => rejectedReport(),
      onCarpoolRejection: () => {
        throw new Error('切号没接上');
      },
    });
    const r = await h.run();
    expect(r.outcome).toBe('failed');
    expect(h.logs.join(' ')).toContain('拼车被拒的证据没交给切号');
  });
});

describe('hostSegmentSpawner · 会话过程记录（#1640）', () => {
  const entry = (kind: 'assistant' | 'tool_call' | 'tool_result', text: string) => ({
    at: '2026-10-10T00:00:00.000Z',
    kind,
    text,
  });

  it('提示词记第一条，插头交来的接着记，收场前全写完；编号从 0 连续', async () => {
    const written: TranscriptRow[] = [];
    const h = harness({
      transcriptWrite: async (_id, rows) => void written.push(...rows),
      driverRun: async (_spec, hooks) => {
        hooks.onTranscript?.(entry('assistant', '我来改'), { seq: 0, replay: false });
        hooks.onTranscript?.(entry('tool_call', 'ls'), { seq: 1, replay: false });
        return report();
      },
    });
    const r = await h.run({ prompt: '干这件事' });
    expect(r.outcome).toBe('done');
    // 结局交回来的时候，过程已经全在库里（没有靠定时器碰巧写完）
    expect(written.map((w) => [w.seq, w.kind, w.text])).toEqual([
      [0, 'prompt', '干这件事'],
      [1, 'assistant', '我来改'],
      [2, 'tool_call', 'ls'],
    ]);
  });

  it('【故意造出的失败】写库抛错：只记日志，这一段的结局、回答、用量照旧', async () => {
    const h = harness({
      transcriptWrite: async () => {
        throw new Error('connection terminated');
      },
      driverRun: async (_spec, hooks) => {
        hooks.onTranscript?.(entry('assistant', '我来改'), { seq: 0, replay: false });
        return report();
      },
    });
    const r = await h.run();
    expect(r.outcome).toBe('done');
    expect(r.exitCode).toBe(0);
    expect(r.stdout).toBe('已提交，改了 tier.ts');
    expect(h.logs.join('\n')).toContain('会话过程记录');
    expect(h.recorded[0]).toMatchObject({ outcome: 'done' });
  });

  it('驱动抛错：结局照旧是失败，已攒的过程也写出去（出问题时最要看过程）', async () => {
    const written: TranscriptRow[] = [];
    const h = harness({
      transcriptWrite: async (_id, rows) => void written.push(...rows),
      driverRun: async (_spec, hooks) => {
        hooks.onTranscript?.(entry('assistant', '开了个头'), { seq: 0, replay: false });
        throw new Error('驱动炸了');
      },
    });
    await expect(h.run()).rejects.toThrow();
    expect(written.map((w) => w.kind)).toEqual(['prompt', 'assistant']);
  });

  it('不给写法也没有 db：不记，不影响任何事', async () => {
    const h = harness();
    const r = await h.run();
    expect(r.outcome).toBe('done');
    expect(h.calls[0]?.hooks.onTranscript).toBeUndefined();
  });
});

describe('提需求 / 临时指挥官：不经 runOneShot 起会话，过程记录也能落库', () => {
  let t: TestDb;
  beforeAll(async () => {
    t = await createTestDb();
  }, TEST_DB_TIMEOUT_MS);
  afterAll(() => t.close());
  beforeEach(async () => {
    await resetTestDb(t);
  });

  it('库里还没有 runs 行：提示词从 seq 0 起写进 run_transcript；锚点没有 route_id，收场就结束，不占池', async () => {
    const runId = randomUUID();
    const spawn = harness({
      db: t.db,
      driverRun: async (_spec, hooks) => {
        hooks.onTranscript?.(
          { at: '2026-10-15T09:50:00.000Z', kind: 'assistant', text: '我先看代码' },
          { seq: 0, replay: false },
        );
        return report();
      },
    }).spawn;
    await spawn({
      argv: [],
      cwd: '/w',
      stdin: '提需求：把导出改成按当前筛选',
      signal: new AbortController().signal,
      timeoutMs: 60_000,
      input: {
        runId,
        segment: 'scope',
        modelId: 'claude-opus-5-5',
        routeId: 'r1',
        prompt: '提需求：把导出改成按当前筛选',
        cwd: '/w',
      },
    });
    const page = await readRunTranscript(t.db, runId, { limit: 20 });
    expect(page.entries.map((e) => [e.seq, e.kind, e.text])).toEqual([
      [0, 'prompt', '提需求：把导出改成按当前筛选'],
      [1, 'assistant', '我先看代码'],
    ]);
    const row = await getRun(t.db, runId);
    expect(row).toMatchObject({
      segment: 'scope',
      model: 'claude-opus-5-5',
      routeId: null,
      taskId: null,
      outcome: 'done',
    });
    expect(row?.endedAt).toBeInstanceOf(Date);
  });

  it('三段会话已经有开跑行：不改那一行、也不替它收场，过程记录照样落在原来的编号上', async () => {
    const runId = randomUUID();
    await startRun(t.db, {
      id: runId,
      segment: 'manual',
      model: 'original-model',
      branch: 'keep-me',
      startedAt: new Date('2026-10-15T09:00:00.000Z'),
    });
    const spawn = harness({ db: t.db }).spawn;
    await spawn({
      argv: [],
      cwd: '/w',
      stdin: '动手的提示词',
      signal: new AbortController().signal,
      timeoutMs: 60_000,
      input: {
        runId,
        segment: 'manual',
        modelId: 'other-model',
        routeId: 'r1',
        prompt: '动手的提示词',
        cwd: '/w',
      },
    });
    const row = await getRun(t.db, runId);
    expect(row).toMatchObject({
      model: 'original-model',
      branch: 'keep-me',
      segment: 'manual',
      endedAt: null,
      outcome: null,
    });
    const page = await readRunTranscript(t.db, runId, { limit: 10 });
    expect(page.entries.map((e) => [e.seq, e.kind, e.text])).toEqual([[0, 'prompt', '动手的提示词']]);
  });
});

describe('hostSegmentSpawner · 脱开引擎跑、引擎重启后接回（#2238：发版不再停在跑的动手会话）', () => {
  /** 驱动跑着、直到被放手（io.release）或被叫停：放手以后这次调用永远不落定（和 detached.ts 一样）。 */
  const untilReleasedOrStopped = (spec: HostRunSpec, hooks: HostRunHooks): Promise<HostReport> =>
    new Promise((resolve) => {
      // 真驱动起会话前建好收发目录（detached.ts 的 prepareIo）
      if (hooks.io && !hooks.io.attach) mkdirSync(hooks.io.dir, { recursive: true });
      const stopped = () =>
        resolve(report({ facts: okFacts({ exitCode: null, killed: 'aborted' }), answer: '' }));
      // 进来前就叫停了（接回时时限早过了：0 毫秒的计时器可能先于驱动响）：当场收，不然这个假驱动一直等
      if (hooks.signal?.aborted) stopped();
      hooks.signal?.addEventListener('abort', stopped);
      void spec;
    });

  it('动手段（给了 detach）跑在命令行那几家上：收发目录交给驱动、放手信号接上；正常收场连收发目录一起删', async () => {
    const handoff = sessionHandoff(join(tmp, 'io'));
    const h = harness({ handoff });
    const got = await h.run({ detach: {} });
    expect(got.outcome).toBe('done');
    const io = h.calls[0]?.hooks.io;
    expect(io).toMatchObject({ dir: join(tmp, 'io', RUN_ID) });
    expect(io?.release).toBe(handoff.signal);
    expect(io).not.toHaveProperty('attach');
    expect(existsSync(join(tmp, 'io', RUN_ID))).toBe(false);
    expect(h.removed).toEqual([`/var/lib/fleet-work/_tmp/${RUN_ID}`]);
  });

  it('没给 detach（验收、整理、指挥官会话）：照旧走管道，不交收发目录，Mirasim 上的也一样', async () => {
    const handoff = sessionHandoff(join(tmp, 'io'));
    const plain = harness({ handoff });
    await plain.run();
    expect(plain.calls[0]?.hooks).not.toHaveProperty('io');
    const relay = harness({ handoff, route: route({ hostId: 'mirasim' }) });
    await relay.run();
    expect(relay.calls[0]?.hooks).not.toHaveProperty('io');
  });

  describe('Mirasim 上的动手段（#2815）', () => {
    const mirasimRoute = () => route({ hostId: 'mirasim' });
    /** 假的 Mirasim 驱动：会话在服务端跑着，直到放手信号响了才交回「放手」的报告（真插头断开连接、不发 stop）。 */
    const untilReleased = (_spec: HostRunSpec, hooks: HostRunHooks): Promise<HostReport> =>
      new Promise((resolve) => {
        if (hooks.io && !hooks.io.attach) mkdirSync(hooks.io.dir, { recursive: true });
        const letGo = () => resolve(report({ hostId: 'mirasim', detached: true }));
        if (hooks.io?.release?.aborted) letGo();
        hooks.io?.release?.addEventListener('abort', letGo, { once: true });
      });

    it('给了 detach：收发目录和放手信号交给驱动（和命令行那几家同一套），正常收场连目录一起删', async () => {
      const handoff = sessionHandoff(join(tmp, 'io'));
      const h = harness({ handoff, route: mirasimRoute() });
      const got = await h.run({ detach: {} });
      expect(got.outcome).toBe('done');
      const io = h.calls[0]?.hooks.io;
      expect(io).toMatchObject({ dir: join(tmp, 'io', RUN_ID) });
      expect(io?.release).toBe(handoff.signal);
      expect(io).not.toHaveProperty('attach');
      expect(existsSync(join(tmp, 'io', RUN_ID))).toBe(false);
    });

    it('引擎停机（放手信号）：驱动只放手不停会话，写上放手标记、临时目录和收发目录留着，交回 OneShotDetached，runs 那一行不收', async () => {
      const handoff = sessionHandoff(join(tmp, 'io'));
      const h = harness({ handoff, route: mirasimRoute(), driverRun: untilReleased });
      const running = h.run({ detach: {} });
      await vi.waitFor(() => expect(h.calls).toHaveLength(1));
      expect(handoff.leave('收到 SIGTERM')).toEqual([RUN_ID]);
      const err = await running.catch((e: unknown) => e);
      expect(err).toBeInstanceOf(OneShotDetached);
      expect(err).toMatchObject({ runId: RUN_ID, startedAt: expect.any(String) });
      // 没叫停：驱动的信号没响（叫停才会让插头发 stop）
      expect(h.calls[0]?.hooks.signal?.aborted).toBe(false);
      expect(existsSync(join(tmp, 'io', RUN_ID, DETACHED_MARK))).toBe(true);
      expect(h.removed).toEqual([]);
      expect(h.recorded).toEqual([]);
    });

    it('【故意造出的失败】叫停（总时长到顶这类，信号响）不走放手：驱动收到的是叫停信号，结局照旧是超时，不是放手', async () => {
      const handoff = sessionHandoff(join(tmp, 'io'));
      const stopped = (_spec: HostRunSpec, hooks: HostRunHooks): Promise<HostReport> =>
        new Promise((resolve) => {
          const done = () =>
            resolve(report({ hostId: 'mirasim', facts: okFacts({ exitCode: null, killed: 'aborted' }) }));
          if (hooks.signal?.aborted) done();
          hooks.signal?.addEventListener('abort', done);
        });
      const h = harness({ handoff, route: mirasimRoute(), driverRun: stopped });
      const startedAt = new Date(Date.now() - 61 * 60_000).toISOString();
      const got = await h.run({ detach: { attach: { startedAt } } }, 60);
      expect(got.outcome).toBe('timeout');
      expect(h.calls[0]?.hooks.signal?.aborted).toBe(true);
    });

    it('过程记录：放手时把写到第几条记进交接单；接回的记录员从那里接着编，订阅回的旧内容（replay）不重记', async () => {
      const handoff = sessionHandoff(join(tmp, 'io'));
      const dir = join(tmp, 'io', RUN_ID);
      const rows: { seq: number; text: string }[] = [];
      const transcriptWrite = async (_id: string, batch: TranscriptRow[]) => {
        for (const r of batch) rows.push({ seq: r.seq, text: r.text });
      };
      const entry = (text: string) => ({ at: '2026-10-16T09:00:00.000Z', kind: 'assistant' as const, text });
      const first = harness({
        handoff,
        route: mirasimRoute(),
        transcriptWrite,
        driverRun: async (spec, hooks) => {
          // 服务端接下：驱动写交接单（这里的假驱动替它写）
          writeMirasimHandle(dir, {
            runId: RUN_ID,
            sessionKey: 'claude:s1',
            acceptedAt: '2026-10-16T09:00:00Z',
          });
          hooks.onTranscript?.(entry('放手前的话'), { seq: 0, replay: false });
          return untilReleased(spec, hooks);
        },
      });
      const running = first.run({ detach: {} });
      await vi.waitFor(() => expect(first.calls).toHaveLength(1));
      handoff.leave('收到 SIGTERM');
      await running.catch(() => undefined);
      expect(rows.map((r) => [r.seq, r.text])).toEqual([
        [0, '干这件事'],
        [1, '放手前的话'],
      ]);
      expect(await readMirasimHandle(dir)).toMatchObject({ sessionKey: 'claude:s1', transcriptNext: 2 });

      const second = harness({
        handoff: sessionHandoff(join(tmp, 'io')),
        route: mirasimRoute(),
        transcriptWrite,
        driverRun: async (_spec, hooks) => {
          hooks.onTranscript?.(entry('放手前的话（重读）'), { seq: 0, replay: true });
          hooks.onTranscript?.(entry('接回后新长出来的'), { seq: 1, replay: false });
          return report({ hostId: 'mirasim' });
        },
      });
      const startedAt = new Date().toISOString();
      await second.run({ detach: { attach: { startedAt } } });
      expect(rows.slice(2).map((r) => [r.seq, r.text])).toEqual([[2, '接回后新长出来的']]);
    });

    it('接回：不交接临时目录，删掉放手标记，驱动按 attach 读交接目录，结局记回原来那一行', async () => {
      const handoff = sessionHandoff(join(tmp, 'io'));
      const dir = join(tmp, 'io', RUN_ID);
      mkdirSync(dir, { recursive: true });
      writeFileSync(join(dir, DETACHED_MARK), 'x');
      const h = harness({ handoff, route: mirasimRoute() });
      const startedAt = new Date(Date.now() - 5 * 60_000).toISOString();
      const got = await h.run({ detach: { attach: { startedAt } } });
      expect(got).toMatchObject({ outcome: 'done', startedAt });
      expect(h.calls[0]?.hooks.io).toMatchObject({ dir, attach: true });
      expect(h.adopted).toEqual([]);
      expect(h.recorded).toEqual([expect.objectContaining({ runId: RUN_ID, outcome: 'done', startedAt })]);
      expect(existsSync(dir)).toBe(false);
    });
  });

  it('引擎要走了（停机信号）：会话不停，写上放手标记、临时目录和收发目录都留着，one-shot 抛 OneShotDetached，runs 那一行不收', async () => {
    const handoff = sessionHandoff(join(tmp, 'io'));
    const h = harness({ handoff, driverRun: untilReleasedOrStopped });
    const running = h.run({ detach: {} });
    await vi.waitFor(() => expect(h.calls).toHaveLength(1));
    expect(handoff.leave('收到 SIGTERM')).toEqual([RUN_ID]);
    const err = await running.catch((e: unknown) => e);
    expect(err).toBeInstanceOf(OneShotDetached);
    expect(err).toMatchObject({ runId: RUN_ID, startedAt: expect.any(String) });
    // 会话没被叫停：驱动的信号没响
    expect(h.calls[0]?.hooks.signal?.aborted).toBe(false);
    expect(existsSync(join(tmp, 'io', RUN_ID, DETACHED_MARK))).toBe(true);
    expect(h.removed).toEqual([]);
    expect(h.recorded).toEqual([]);
  });

  it('接回：不交接临时目录、不开跑，删掉放手标记、驱动按 attach 从文件读回；结局照原来的起点记到同一行', async () => {
    const handoff = sessionHandoff(join(tmp, 'io'));
    const dir = join(tmp, 'io', RUN_ID);
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, DETACHED_MARK), 'x');
    const h = harness({ handoff });
    const startedAt = new Date(Date.now() - 5 * 60_000).toISOString();
    const got = await h.run({ detach: { attach: { startedAt } } });
    expect(got).toMatchObject({ outcome: 'done', startedAt });
    expect(h.calls[0]?.hooks.io).toMatchObject({ dir, attach: true });
    expect(h.order).toEqual(['run', 'remove']);
    expect(h.adopted).toEqual([]);
    expect(h.recorded).toEqual([expect.objectContaining({ runId: RUN_ID, outcome: 'done', startedAt })]);
    expect(existsSync(dir)).toBe(false);
  });

  it('【故意造出的失败】接回的会话早过了原来的时限：one-shot 当场按超时收它，不再给一整份时限', async () => {
    const handoff = sessionHandoff(join(tmp, 'io'));
    const h = harness({ handoff, driverRun: untilReleasedOrStopped });
    const startedAt = new Date(Date.now() - 61 * 60_000).toISOString();
    const got = await h.run({ detach: { attach: { startedAt } } }, 60);
    expect(got.outcome).toBe('timeout');
  });

  it('【故意造出的失败】要接回、可这个引擎没装收发目录：明确报起不来，不当成起了新会话', async () => {
    const h = harness();
    await expect(h.run({ detach: { attach: { startedAt: new Date().toISOString() } } })).rejects.toThrow(
      /接回会话 .* 没接成：这个引擎没装收发目录/,
    );
    expect(h.calls).toEqual([]);
  });
});
