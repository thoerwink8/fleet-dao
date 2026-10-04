// 任务工作流的动手会话（real/task-segment.ts，#632 S2-4b-2）：备树（真 git、本地镜像）→ 提示词 → 一次性会话（假驱动，
// 不起真执行体）→ 结局整理。每条没跑成、起不来、被叫停、内存放不下的路径故意造一次。
import { existsSync, mkdirSync, mkdtempSync, rmSync, utimesSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { RunFacts, SessionUser } from '@fleet-dao/adapters';
import type { RouteLaunchFacts } from '@fleet-dao/db';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { type PortContext, PortError } from '../../src/ports.ts';
import { localExec } from '../../src/real/exec.ts';
import type { HostDriver, HostReport, HostRunHooks, HostRunSpec, WiredHost } from '../../src/real/hosts.ts';
import { oneShotSessions } from '../../src/real/one-shot-sessions.ts';
import { createRunSegment, type RunSegmentDeps, sweepRunDirs } from '../../src/real/task-segment.ts';
import { NoSlotError, type RunRecord, type RunStart } from '../../src/runner/not-wired.ts';
import type { RunSegmentInput } from '../../src/task-contract.ts';
import { goodBrief } from '../task-script.ts';
import { fakeTrees, git, mirror } from './fixtures.ts';

const USER = 'fleet-agent-carpool' as SessionUser;
const REPO = { id: 'r1', owner: 'acme', name: 'demo', defaultBranch: 'main', testCommand: 'pnpm check' };
const BRANCH = 'fleet/12-t1a2b3c4d';
const TASK_ID = '5f0c2a8e-3b1d-4c6e-9a7f-1e2d3c4b5a69';

const route = (over: Partial<RouteLaunchFacts> = {}): RouteLaunchFacts => ({
  routeId: 'r1',
  channelId: 'claude-subscription',
  poolId: 'p1',
  modelId: 'claude-opus-5-5',
  hostId: 'claude-code',
  upstreamModel: null,
  runAsUser: USER,
  orgKind: null,
  effort: null,
  ...over,
});

const okFacts = (over: Partial<RunFacts> = {}): RunFacts => ({
  exitCode: 0,
  terminal: { isError: false, detail: 'done' },
  quotaExhausted: false,
  ...over,
});

const report = (over: Partial<HostReport> = {}): HostReport => ({
  hostId: 'claude-code',
  facts: okFacts(),
  usage: { inputTokens: 1200, outputTokens: 340 },
  sessionCostUsd: 0.42,
  actualModel: 'claude-opus-5-5',
  answer: '已提交：改了页面，测试过了',
  wallMs: 1000,
  stderrTail: '',
  ...over,
});

let root: string;
beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'fleet-task-segment-'));
});
afterEach(() => {
  rmSync(root, { recursive: true, force: true });
});

const ctx = (signal = new AbortController().signal, beats?: { n: number }): PortContext => ({
  signal,
  heartbeat: () => {
    if (beats) beats.n += 1;
  },
  attempt: 1,
  lastHeartbeat: undefined,
});

interface Rig {
  m: ReturnType<typeof mirror>;
  ft: ReturnType<typeof fakeTrees>;
  dir: string;
  recorded: RunRecord[];
  started: RunStart[];
  /** 每次开跑带给 runs.start 的预占编号（没带是 undefined）。 */
  startedWith: (string | undefined)[];
  /** 收场时放掉的预占编号。 */
  released: string[];
  specs: HostRunSpec[];
  run: ReturnType<typeof createRunSegment>;
  input: (over?: Partial<RunSegmentInput>) => RunSegmentInput;
}

function rig(
  opts: {
    driverRun?: (spec: HostRunSpec, hooks: HostRunHooks, n: number) => Promise<HostReport>;
    route?: RouteLaunchFacts | null;
    deps?: Partial<RunSegmentDeps>;
  } = {},
): Rig {
  // 一个用例里可以起几套（各有各的镜像、树、落盘目录）
  const sub = mkdtempSync(join(root, 'rig-'));
  const m = mirror(sub);
  const ft = fakeTrees(join(sub, 'work'));
  const dir = ft.trees.treeFor(REPO, BRANCH);
  const recorded: RunRecord[] = [];
  const started: RunStart[] = [];
  const startedWith: (string | undefined)[] = [];
  const released: string[] = [];
  const specs: HostRunSpec[] = [];
  let n = 0;
  const driver = (hostId: WiredHost): HostDriver => ({
    hostId,
    userFrom: 'pool',
    canFork: hostId === 'claude-code',
    newSessionId: () => ({ id: '11111111-2222-4333-8444-555555555555', known: true }),
    async run(spec, hooks) {
      specs.push(spec);
      n += 1;
      return (opts.driverRun ?? (async () => report()))(spec, hooks, n);
    },
    loginFix: () => '去登录',
  });
  let ids = 0;
  const run = createRunSegment({
    tree: {
      gh: m.gh as never,
      trees: ft.trees,
      exec: localExec(),
      tmpDir: join(sub, 'engine-tmp'),
      gitBin: 'git',
      shBin: 'sh',
    },
    spawner: {
      routeFacts: async () => (opts.route === undefined ? route() : opts.route),
      drivers: {
        'claude-code': driver('claude-code'),
        'cursor-agent': driver('cursor-agent'),
        grok: driver('grok'),
        mirasim: driver('mirasim'),
      } as Record<WiredHost, HostDriver>,
      trees: ft.trees,
      baseEnv: { PATH: '/usr/bin' },
      resources: { memoryHighMb: 5888, memoryMaxMb: 6144, swapMaxMb: 0 },
    },
    runs: {
      async start(r, options) {
        started.push(r);
        startedWith.push(options?.reservationId);
      },
      async record(r) {
        recorded.push(r);
      },
    },
    reservations: {
      async release(id) {
        released.push(id);
      },
    },
    runsDir: join(sub, 'runs'),
    newRunId: () => {
      ids += 1;
      return `run-${String(ids).padStart(4, '0')}`;
    },
    sleep: async () => undefined,
    heartbeatEveryMs: 5,
    ...opts.deps,
  });
  const input = (over: Partial<RunSegmentInput> = {}): RunSegmentInput => ({
    schemaVersion: 1,
    taskId: TASK_ID,
    repo: REPO,
    issueNumber: 12,
    route: {
      routeId: 'r1',
      poolId: 'p1',
      modelId: 'claude-opus-5-5',
      family: 'claude',
      hostId: 'claude-code',
    },
    worktreePath: dir,
    branch: BRANCH,
    baseSha: m.head,
    brief: goodBrief(),
    tier: { tier: 'medium', effort: 'high', reason: '一个目录', modules: 1 } as never,
    feedback: [],
    timeoutMinutes: 5,
    ...over,
  });
  return { m, ft, dir, recorded, started, startedWith, released, specs, run, input };
}

/** 假会话干活：在树里写个文件并提交。 */
function commitInTree(spec: HostRunSpec, file = 'page.tsx'): void {
  writeFileSync(join(spec.cwd, file), 'export const Page = () => null;\n');
  git(spec.cwd, 'add', '.');
  git(spec.cwd, 'commit', '-q', '-m', `add ${file}`);
}

describe('备树', { timeout: 60_000 }, () => {
  it('第一轮：树还不存在，会话用户从镜像建树、检出任务分支、钉好主线；会话在这棵树里起，提示词里有交代和规矩', async () => {
    const r = rig({
      driverRun: async (spec) => {
        commitInTree(spec);
        return report();
      },
    });
    const beats = { n: 0 };
    const got = await r.run(r.input(), ctx(undefined, beats));
    expect(got).toMatchObject({
      ok: true,
      runId: 'run-0002',
      answer: '已提交：改了页面，测试过了',
      costUsd: 0.42,
    });

    // 树：在任务分支上，起点是镜像的主线头，主线钉在起点，提交身份是「干活的」机器人
    expect(git(r.dir, 'rev-parse', '--abbrev-ref', 'HEAD')).toBe(BRANCH);
    expect(git(r.dir, 'rev-parse', 'origin/main')).toBe(r.m.head);
    expect(git(r.dir, 'config', 'user.name')).toBe('fleet-agent[bot]');
    expect(r.ft.treeAdopts().map((a) => a.user)).toEqual([USER]);

    // 会话：在这棵树里起、新会话、点名的路由、提示词
    expect(r.specs).toHaveLength(1);
    const spec = r.specs[0] as HostRunSpec;
    expect(spec.cwd).toBe(r.dir);
    expect(spec.user).toBe(USER);
    expect(spec.session.mode).toBe('new');
    expect(spec.prompt).toContain('# 任务：给驾驶舱加状态');
    expect(spec.prompt).toContain(`分支 \`${BRANCH}\` 已经切好`);
    expect(spec.prompt).not.toContain('返工意见');
    expect(beats.n).toBeGreaterThan(0);

    // runs：开跑先留一行（带路由：切号靠它认出跑在哪个池），收场同一个编号一笔 done，渠道是路由的渠道，用量花费带上。
    // 两处都记到这张单名下（#216）：tasks.id、单号、派工档、任务工作流编号、分支；第一轮还没开 PR，PR 号不写（不拿 0 顶）
    const owner = {
      runId: 'run-0002',
      segment: 'manual',
      taskId: TASK_ID,
      issueNumber: 12,
      tier: 'medium',
      workflowId: 'task:acme/demo#12',
      branch: BRANCH,
    };
    expect(r.started).toEqual([expect.objectContaining({ ...owner, routeId: 'r1' })]);
    expect(r.started[0]).not.toHaveProperty('prNumber');
    expect(r.recorded).toHaveLength(1);
    expect(r.recorded[0]).toMatchObject({
      ...owner,
      outcome: 'done',
      model: 'claude-opus-5-5',
      channel: 'claude-subscription',
      routeId: 'r1',
      inputTokens: 1200,
      costUsd: 0.42,
    });
    expect(r.recorded[0]).not.toHaveProperty('prNumber');
  });

  it('开了 PR 以后的轮次：PR 号开跑、收场两处都记上（#216）', async () => {
    const r = rig({
      driverRun: async (spec) => {
        commitInTree(spec);
        return report();
      },
    });
    const got = await r.run(r.input({ prNumber: 77 }), ctx());
    expect(got.ok).toBe(true);
    expect(r.started).toEqual([expect.objectContaining({ taskId: TASK_ID, prNumber: 77 })]);
    expect(r.recorded).toEqual([expect.objectContaining({ taskId: TASK_ID, prNumber: 77, outcome: 'done' })]);
  });

  it('【故意造出的失败】派工档不在 tier.ts 那三档里：写进 runs 之前就报错，不起会话、一笔不记（不当库一时不通去重试）', async () => {
    const r = rig();
    const err = await r
      .run(r.input({ tier: { tier: 'turbo', effort: 'high', reason: '造的' } as never }), ctx())
      .catch((e: unknown) => e);
    expect(err).toBeInstanceOf(PortError);
    expect(err).toMatchObject({ code: 'SEGMENT_SPAWN_FAILED', retryable: false });
    expect((err as Error).message).toContain('记账的字段对不上 runs 的约束');
    expect((err as Error).message).toContain('tier');
    expect(r.specs).toHaveLength(0);
    expect(r.started).toHaveLength(0);
    expect(r.recorded).toHaveLength(0);
  });

  it('第二轮：树已经在（上一轮的提交还在），不再从镜像取；返工意见带进提示词', async () => {
    const r = rig({
      driverRun: async (spec, _h, n) => {
        commitInTree(spec, n === 1 ? 'a.tsx' : 'b.tsx');
        return report();
      },
    });
    await r.run(r.input(), ctx());
    const before = git(r.dir, 'rev-parse', 'HEAD');
    const bundlesBefore = r.m.calls.length;
    const second = await r.run(
      r.input({ baseSha: before, feedback: ['CI 红了：test (engine)\nFAIL task.test.ts'] }),
      ctx(),
    );
    expect(second.ok).toBe(true);
    expect(r.m.calls.length).toBe(bundlesBefore); // 没有再取包
    expect(existsSync(join(r.dir, 'a.tsx'))).toBe(true); // 上一轮的提交还在
    expect(existsSync(join(r.dir, 'b.tsx'))).toBe(true);
    expect(r.specs[1]?.prompt).toContain('1. CI 红了：test (engine)');
    expect(r.specs[1]?.prompt).toContain('FAIL task.test.ts');
  });

  it('【故意造出的失败】起点不是完整提交号 / 路由用不了：抛 PortError（不重试），不建树、不起会话、不记 runs', async () => {
    const bad = rig();
    await expect(bad.run(bad.input({ baseSha: 'abc' }), ctx())).rejects.toMatchObject({
      code: 'BAD_INPUT',
      retryable: false,
    });
    expect(bad.specs).toHaveLength(0);
    expect(bad.recorded).toHaveLength(0);

    const noRoute = rig({ route: null });
    const err = await noRoute.run(noRoute.input(), ctx()).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(PortError);
    expect(err).toMatchObject({ code: 'SEGMENT_ROUTE_UNUSABLE', retryable: false });
    expect((err as Error).message).toContain('库里没有路由');
    expect(noRoute.ft.adopts).toEqual([]); // 树都没碰
    expect(noRoute.specs).toHaveLength(0);
    expect(noRoute.recorded).toHaveLength(0);
  });
});

describe('结局整理', { timeout: 60_000 }, () => {
  const failing = (facts: Partial<RunFacts>, over: Partial<HostReport> = {}) =>
    rig({ driverRun: async () => report({ facts: okFacts(facts), ...over }) });

  it('【故意造出的失败】额度用满：带回原因码、清零时刻、状态码，quotaExhausted 为真——失败分流照这些等', async () => {
    const r = failing(
      { quotaExhausted: true, terminal: { isError: true, detail: 'limit reached' }, exitCode: 1 },
      { resetsAt: '2026-10-03T01:00:00.000Z', httpStatus: 429, rawError: '5-hour limit reached' },
    );
    const got = await r.run(r.input(), ctx());
    expect(got).toMatchObject({
      ok: false,
      outcome: 'failed',
      evidence: {
        code: 'quota_exhausted',
        quotaExhausted: true,
        resetsAt: '2026-10-03T01:00:00.000Z',
        httpStatus: 429,
        exitCode: 1,
      },
    });
    expect((got as { evidence: { message: string } }).evidence.message).toContain('5-hour limit reached');
    expect(r.recorded[0]).toMatchObject({ outcome: 'failed' });
  });

  it('【故意造出的失败】模型对不上 / 没有终帧 / 终帧报错：原因码原样带回', async () => {
    const mismatch = failing({ mismatch: { kind: 'model', expected: 'opus', observed: 'sonnet' } });
    expect(await mismatch.run(mismatch.input(), ctx())).toMatchObject({
      ok: false,
      evidence: { code: 'model_mismatch' },
    });
    const noResult = rig({
      driverRun: async () => report({ facts: { exitCode: 0, quotaExhausted: false } }),
    });
    expect(await noResult.run(noResult.input(), ctx())).toMatchObject({
      ok: false,
      evidence: { code: 'no_result', quotaExhausted: false },
    });
    const agentError = failing({ terminal: { isError: true, detail: '工具调用被拒' } });
    expect(await agentError.run(agentError.input(), ctx())).toMatchObject({
      ok: false,
      evidence: { code: 'agent_error' },
    });
  });

  it('【故意造出的失败】会话超时（one-shot 的时限先到）：回 ok:false，原因码 wall_clock_timeout，runs 记 timeout', async () => {
    const r = rig({
      driverRun: (_spec, hooks) =>
        new Promise((_resolve, reject) => {
          (hooks.signal as AbortSignal).addEventListener('abort', () => reject(new Error('被杀了')), {
            once: true,
          });
        }),
    });
    const got = await r.run(r.input({ timeoutMinutes: 0.001 }), ctx()); // 60 毫秒
    expect(got).toMatchObject({ ok: false, outcome: 'timeout', evidence: { code: 'wall_clock_timeout' } });
    expect(r.recorded[0]).toMatchObject({ outcome: 'timeout' });
  });

  it('【故意造出的失败】叫停（工作流放弃）：会话被杀，活动抛出取消原因，不回「没跑成」', async () => {
    const stop = new AbortController();
    const r = rig({
      driverRun: (_spec, hooks) =>
        new Promise((_resolve, reject) => {
          (hooks.signal as AbortSignal).addEventListener('abort', () => reject(new Error('被杀了')), {
            once: true,
          });
          setTimeout(() => stop.abort(new Error('任务被放弃')), 30);
        }),
    });
    await expect(r.run(r.input(), ctx(stop.signal))).rejects.toThrow('任务被放弃');
  });

  it('【故意造出的失败】开跑那一行写不进 runs（库一时不通）：抛 PortError SEGMENT_RUNS_UNWRITABLE（可以重试），不起会话', async () => {
    const r = rig({
      deps: {
        runs: {
          async start() {
            throw new Error('runs 开跑那一行写入失败：connection refused');
          },
          async record() {
            throw new Error('没开跑，不该收场');
          },
        },
      },
    });
    const err = await r.run(r.input(), ctx()).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(PortError);
    expect(err).toMatchObject({ code: 'SEGMENT_RUNS_UNWRITABLE', retryable: true });
    expect((err as Error).message).toContain('connection refused');
    expect(r.specs).toHaveLength(0);
  });

  it('【故意造出的失败】驱动自己抛错（起不来）：抛 PortError SEGMENT_SPAWN_FAILED（不重试），不当成会话没跑成', async () => {
    const r = rig({
      driverRun: async () => {
        throw new Error('sudo 不让用');
      },
    });
    const err = await r.run(r.input(), ctx()).catch((e: unknown) => e);
    expect(err).toMatchObject({ code: 'SEGMENT_SPAWN_FAILED', retryable: false });
    expect((err as Error).message).toContain('sudo 不让用');
  });
});

describe('内存放不下新会话', { timeout: 60_000 }, () => {
  /** 读数：前 n 次放不下，之后放得下。 */
  function admission(blockedTimes: number) {
    let reads = 0;
    return {
      reads: () => reads,
      deps: {
        readText: async () => {
          reads += 1;
          // 高水位 10000M、预留 2048M：用了 9500M 放不下，1000M 放得下
          return String((reads <= blockedTimes ? 9500 : 1000) * 1024 * 1024);
        },
        cgroupRoot: '/sys/fs/cgroup',
        slicePath: 'fleet.slice/fleet-agents.slice',
        sliceHighMb: 10_000,
        reservePerSessionMb: 2048,
      },
    };
  }

  it('放不下就隔一会儿再试（不进失败分流），每次试换新执行编号；放得下了照常起', async () => {
    const adm = admission(2);
    const sleeps: number[] = [];
    const r = rig({
      deps: {
        memoryAdmission: adm.deps,
        sleep: async (ms) => {
          sleeps.push(ms);
        },
      },
      driverRun: async (spec) => {
        commitInTree(spec);
        return report();
      },
    });
    const got = await r.run(r.input(), ctx());
    expect(got.ok).toBe(true);
    expect(sleeps).toEqual([30_000, 30_000]);
    expect(r.recorded.map((x) => x.outcome)).toEqual(['admission_blocked', 'admission_blocked', 'done']);
    expect(new Set(r.recorded.map((x) => x.runId)).size).toBe(3);
    expect(r.specs).toHaveLength(1); // 前两次一个会话都没起
  });

  it('【故意造出的失败】一直放不下，等到顶：回 ok:false，原因码 memory_busy，一个会话都没起', async () => {
    const adm = admission(Number.POSITIVE_INFINITY);
    let clock = Date.parse('2026-10-02T12:00:00Z');
    const r = rig({
      deps: {
        memoryAdmission: adm.deps,
        now: () => new Date(clock),
        sleep: async (ms) => {
          clock += ms;
        },
        admissionWaitMs: 2 * 60_000,
      },
    });
    const got = await r.run(r.input(), ctx());
    expect(got).toMatchObject({ ok: false, outcome: 'admission_blocked', evidence: { code: 'memory_busy' } });
    expect(r.specs).toHaveLength(0);
    expect(r.recorded.every((x) => x.outcome === 'admission_blocked')).toBe(true);
  });

  it('【故意造出的失败】内存读数读不成（文件在、读坏了）：不派也不悄悄照派——抛 SEGMENT_SPAWN_FAILED', async () => {
    const r = rig({
      deps: {
        memoryAdmission: {
          readText: async () => '不是数字',
          cgroupRoot: '/sys/fs/cgroup',
          slicePath: 'fleet.slice/fleet-agents.slice',
          sliceHighMb: 10_000,
          reservePerSessionMb: 2048,
        },
      },
    });
    await expect(r.run(r.input(), ctx())).rejects.toMatchObject({ code: 'SEGMENT_SPAWN_FAILED' });
    expect(r.specs).toHaveLength(0);
  });
});

describe('切号停下这一段（#59）', { timeout: 60_000 }, () => {
  const WHY = '切号：会话用户从拼车组织切到独享组织，先停下，切完接着干';

  it('定了路由就登记；会话跑着时切号叫停：ok:false、结局和原因码都是 org_switch（不算失败），runs 收成 org_switch，收场就从登记里走', async () => {
    const sessions = oneShotSessions();
    let resolveStarted: () => void = () => {};
    const started = new Promise<void>((resolve) => {
      resolveStarted = resolve;
    });
    const r = rig({
      deps: { sessions },
      driverRun: async (spec, hooks) => {
        commitInTree(spec, 'half.tsx');
        resolveStarted();
        await new Promise<void>((resolve) => {
          (hooks.signal as AbortSignal).addEventListener('abort', () => resolve(), { once: true });
        });
        return report({ facts: { exitCode: null, killed: 'aborted', quotaExhausted: false } });
      },
    });
    const pending = r.run(r.input(), ctx());
    await started;
    // 跑在路由 r1 的池 p1 上：切号看得见它（编号是这一次的 runs 编号）
    expect(sessions.live(new Set(['p1']))).toEqual(['run-0002']);
    expect(sessions.stop(new Set(['p1', 'p2']), WHY)).toEqual(['run-0002']);
    const got = await pending;
    expect(got).toMatchObject({
      ok: false,
      runId: 'run-0002',
      outcome: 'org_switch',
      evidence: { code: 'org_switch' },
    });
    expect((got as { evidence: { message: string } }).evidence.message).toContain(WHY);
    expect(r.recorded).toEqual([expect.objectContaining({ runId: 'run-0002', outcome: 'org_switch' })]);
    expect(sessions.live(new Set(['p1']))).toEqual([]);
    // 停下之前提交的还在这棵树上（工作流在原分支上重跑这一段）
    expect(existsSync(join(r.dir, 'half.tsx'))).toBe(true);
  });

  it('等内存的时候切号叫停：不再等，不起会话，回 org_switch；停下时登记的编号就是随后记成 org_switch 的那一行；登记走掉', async () => {
    const sessions = oneShotSessions();
    let sleeping = false;
    const r = rig({
      deps: {
        sessions,
        memoryAdmission: {
          readText: async () => String(9500 * 1024 * 1024),
          cgroupRoot: '/sys/fs/cgroup',
          slicePath: 'fleet.slice/fleet-agents.slice',
          sliceHighMb: 10_000,
          reservePerSessionMb: 2048,
        },
        // 真睡：信号来了就醒
        sleep: (ms, signal) =>
          new Promise((resolve, reject) => {
            sleeping = true;
            if (signal.aborted) return reject(signal.reason);
            const timer = setTimeout(resolve, ms);
            signal.addEventListener(
              'abort',
              () => {
                clearTimeout(timer);
                reject(signal.reason);
              },
              { once: true },
            );
          }),
        admissionPollMs: 60_000,
      },
    });
    const pending = r.run(r.input(), ctx());
    // 第一次放不下、睡着等：这时切号
    for (let i = 0; i < 500 && !sleeping; i += 1) await new Promise((x) => setTimeout(x, 10));
    const stopped = sessions.stop(new Set(['p1']), WHY);
    const got = await pending;
    expect(got).toMatchObject({ ok: false, outcome: 'org_switch', evidence: { code: 'org_switch' } });
    expect(r.specs).toHaveLength(0);
    expect(r.recorded.map((x) => [x.runId, x.outcome])).toEqual([
      ['run-0002', 'admission_blocked'],
      ['run-0003', 'org_switch'],
    ]);
    expect(stopped).toEqual(['run-0003']);
    expect(sessions.live(new Set(['p1']))).toEqual([]);
  });

  it('建树那会儿就被切号叫停：树照样建完，不起会话，回 org_switch；停下时登记的编号就是记成 org_switch 的那一行', async () => {
    const sessions = oneShotSessions();
    let stopped: string[] = [];
    const r = rig({ deps: { sessions } });
    // 建树的第一步（看树归谁）那一刻切号
    const ownerOf = r.ft.trees.ownerOf;
    r.ft.trees.ownerOf = async (dir) => {
      if (stopped.length === 0) stopped = sessions.stop(new Set(['p1']), WHY);
      return ownerOf(dir);
    };
    const got = await r.run(r.input(), ctx());
    expect(got).toMatchObject({ ok: false, runId: 'run-0002', outcome: 'org_switch' });
    expect(stopped).toEqual(['run-0002']);
    expect(r.specs).toHaveLength(0);
    expect(r.started).toHaveLength(0);
    expect(r.recorded).toEqual([expect.objectContaining({ runId: 'run-0002', outcome: 'org_switch' })]);
    // 树建好了（重跑时接着用）
    expect(existsSync(join(r.dir, '.git'))).toBe(true);
    expect(sessions.live(new Set(['p1']))).toEqual([]);
  });

  it('上一次被切号停下的重跑：提示词里写着上一次为什么停、树里留着它的东西、接着干', async () => {
    const r = rig({
      driverRun: async (spec) => {
        commitInTree(spec);
        return report();
      },
    });
    const got = await r.run(r.input({ interrupted: `${WHY}（会话被停下）` }), ctx());
    expect(got.ok).toBe(true);
    const prompt = r.specs[0]?.prompt ?? '';
    expect(prompt).toContain('## 这一段上一次跑到一半被停下了');
    expect(prompt).toContain(WHY);
    expect(prompt).toContain('先看 git status、git log');
    // 没被停过的没有这一节
    const plain = rig({ driverRun: async () => report() });
    await plain.run(plain.input(), ctx());
    expect(plain.specs[0]?.prompt).not.toContain('上一次跑到一半被停下了');
  });
});

describe('选路时预占的池的名额（#757）', { timeout: 60_000 }, () => {
  /** 选路交回的路由带着预占（和任务工作流一样原样交进来）。 */
  const reserved = (r: Rig, over: Partial<RunSegmentInput> = {}) =>
    r.input({ route: { ...r.input().route, reservationId: 'res-1' }, ...over });
  /** 父节点一直放不下新会话。 */
  const fullMemory = {
    readText: async () => String(9500 * 1024 * 1024),
    cgroupRoot: '/sys/fs/cgroup',
    slicePath: 'fleet.slice/fleet-agents.slice',
    sliceHighMb: 10_000,
    reservePerSessionMb: 2048,
  };

  it('开跑那一行带上预占（在那一下换成这一行）；收场照样放一次（开跑了的放了什么都不做）；不经选路的不带、不放', async () => {
    const r = rig({
      driverRun: async (spec) => {
        commitInTree(spec);
        return report();
      },
    });
    expect(await r.run(reserved(r), ctx())).toMatchObject({ ok: true });
    expect(r.startedWith).toEqual(['res-1']);
    expect(r.released).toEqual(['res-1']);

    const plain = rig({ driverRun: async () => report() });
    await plain.run(plain.input(), ctx());
    expect(plain.startedWith).toEqual([undefined]);
    expect(plain.released).toEqual([]);
  });

  it('内存放不下、隔一会儿再试：每次都带同一个预占去试，名额一直替这一段占着；等到顶交回 memory_busy，收场放掉', async () => {
    let clock = Date.parse('2026-10-02T12:00:00Z');
    const r = rig({
      deps: {
        memoryAdmission: fullMemory,
        now: () => new Date(clock),
        sleep: async (ms) => {
          clock += ms;
        },
        admissionWaitMs: 2 * 60_000,
      },
    });
    expect(await r.run(reserved(r), ctx())).toMatchObject({ ok: false, evidence: { code: 'memory_busy' } });
    expect(r.startedWith).toEqual([]);
    expect(r.released).toEqual(['res-1']);
  });

  it('【故意造出的失败】没开跑就收场——建树失败、路由用不了、等内存时被叫停：都把预占放掉，池不一直显得满', async () => {
    const bad = rig();
    await expect(bad.run(reserved(bad, { baseSha: 'abc' }), ctx())).rejects.toMatchObject({
      code: 'BAD_INPUT',
    });
    expect([bad.startedWith, bad.released]).toEqual([[], ['res-1']]);

    const noRoute = rig({ route: null });
    await expect(noRoute.run(reserved(noRoute), ctx())).rejects.toMatchObject({
      code: 'SEGMENT_ROUTE_UNUSABLE',
    });
    expect([noRoute.startedWith, noRoute.released]).toEqual([[], ['res-1']]);

    const stop = new AbortController();
    const abandoned = rig({
      deps: {
        memoryAdmission: fullMemory,
        sleep: async (_ms, signal) => {
          stop.abort(new Error('任务被放弃'));
          throw signal.reason;
        },
      },
    });
    await expect(abandoned.run(reserved(abandoned), ctx(stop.signal))).rejects.toThrow('任务被放弃');
    expect([abandoned.startedWith, abandoned.released]).toEqual([[], ['res-1']]);
  });

  it('【故意造出的失败】开跑时名额已经没了（预占过期、空位给了别的单，runs.start 抛 NoSlotError）：不起会话，抛 SEGMENT_NO_SLOT（可以重试，不当成 runs 写不进），预占照样放', async () => {
    const r = rig({
      deps: {
        runs: {
          async start() {
            throw new NoSlotError('池 claude-carpool 的名额满了（已经有 3 个，上限 3 个）');
          },
          async record() {
            throw new Error('没开跑，不该收场');
          },
        },
      },
    });
    const err = await r.run(reserved(r), ctx()).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(PortError);
    expect(err).toMatchObject({ code: 'SEGMENT_NO_SLOT', retryable: true });
    expect((err as Error).message).toContain('名额满了');
    expect(r.specs).toHaveLength(0);
    expect(r.released).toEqual(['res-1']);
  });

  it('【故意造出的失败】预占放不掉（库一时不通）：只记日志、写明放不掉，这一段的结局照旧（名额到点自己过期）', async () => {
    const logs: string[] = [];
    const r = rig({
      deps: {
        reservations: {
          async release() {
            throw new Error('connection refused');
          },
        },
        log: (message, fields) => logs.push(`${message} ${JSON.stringify(fields)}`),
      },
      driverRun: async () => report(),
    });
    expect(await r.run(reserved(r), ctx())).toMatchObject({ ok: true });
    expect(logs.filter((l) => l.includes('没放掉'))).toEqual([expect.stringContaining('connection refused')]);
  });
});

describe('落盘目录清理', () => {
  it('清理：超过期限的执行目录删，新的留；目录不在回 0；删不掉只记日志不抛', async () => {
    const dir = join(root, 'runs');
    mkdirSync(join(dir, 'old'), { recursive: true });
    mkdirSync(join(dir, 'young'), { recursive: true });
    writeFileSync(join(dir, 'stray.txt'), 'x');
    const now = new Date('2026-10-04T12:00:00Z');
    utimesSync(join(dir, 'old'), new Date('2026-10-01T00:00:00Z'), new Date('2026-10-01T00:00:00Z'));
    utimesSync(join(dir, 'young'), new Date('2026-10-04T11:00:00Z'), new Date('2026-10-04T11:00:00Z'));
    const logs: string[] = [];
    expect(await sweepRunDirs(dir, now, 24 * 3600_000, (m) => logs.push(m))).toBe(1);
    expect(existsSync(join(dir, 'old'))).toBe(false);
    expect(existsSync(join(dir, 'young'))).toBe(true);
    expect(existsSync(join(dir, 'stray.txt'))).toBe(true); // 不是目录不碰
    expect(await sweepRunDirs(join(root, 'nope'), now, 1, (m) => logs.push(m))).toBe(0);
    expect(logs).toEqual([]);
    // 路径其实是个文件：读不了目录，记日志、不抛
    expect(await sweepRunDirs(join(dir, 'stray.txt'), now, 1, (m) => logs.push(m))).toBe(0);
    expect(logs[0]).toContain('读不了');
  });
});
