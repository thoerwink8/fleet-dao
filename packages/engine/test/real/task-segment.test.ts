// 任务工作流的动手会话（real/task-segment.ts，#632 S2-4b-2）：备树（真 git、本地镜像）→ 提示词 → 一次性会话（假驱动，
// 不起真执行体）→ 结局整理。每条没跑成、起不来、被叫停、内存放不下的路径故意造一次。
import {
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  utimesSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { type RunFacts, type SessionUser, SUBAGENTS_DIR } from '@fleet-dao/adapters';
import type { ChannelAttemptWrite, RouteLaunchFacts } from '@fleet-dao/db';
import { beforeEach, describe, expect, it, onTestFinished, vi } from 'vitest';
import { createEngineDrain, waitDrained } from '../../src/drain.ts';
import { type PortContext, PortError } from '../../src/ports.ts';
import { localExec } from '../../src/real/exec.ts';
import type { HostDriver, HostReport, HostRunHooks, HostRunSpec, WiredHost } from '../../src/real/hosts.ts';
import { oneShotSessions } from '../../src/real/one-shot-sessions.ts';
import { prepareSegmentTree } from '../../src/real/segment-tree.ts';
import { DETACHED_MARK, type SessionHandoff, sessionHandoff } from '../../src/real/session-handoff.ts';
import { readSubagentGuard } from '../../src/real/subagents-file.ts';
import { createRunSegment, type RunSegmentDeps, sweepRunDirs } from '../../src/real/task-segment.ts';
import { NoSlotError, type RunRecord, type RunStart } from '../../src/runner/not-wired.ts';
import { type RunSegmentInput, SEGMENT_DETACHED } from '../../src/task-contract.ts';
import { goodBrief } from '../task-script.ts';
import { fakeTrees, git, mirror } from './fixtures.ts';
import { gitIn, isolatedGitEnv, isolatedUserExec, repoStamp } from './isolated-git.ts';

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
  // 删这一用例自己建的目录，不读模块上的 root：后一个用例的 beforeEach 会把 root 换掉，
  // 前一个用例若还在收场，就会把别人正在用的目录删掉。
  const mine = root;
  onTestFinished(() => {
    rmSync(mine, { recursive: true, force: true });
  });
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
  /** 每一次起会话的尝试（channel_attempts）。 */
  attempts: ChannelAttemptWrite[];
  specs: HostRunSpec[];
  run: ReturnType<typeof createRunSegment>;
  input: (over?: Partial<RunSegmentInput>) => RunSegmentInput;
}

function rig(
  opts: {
    driverRun?: (spec: HostRunSpec, hooks: HostRunHooks, n: number) => Promise<HostReport>;
    route?: RouteLaunchFacts | null;
    routeFacts?: (routeId: string) => Promise<RouteLaunchFacts | null>;
    deps?: Partial<RunSegmentDeps>;
    /** 动手会话脱开引擎跑（#2238）。 */
    handoff?: SessionHandoff;
    /** 备树时跑 git 的执行器；不给就用本机的。 */
    exec?: ReturnType<typeof localExec>;
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
  const attempts: ChannelAttemptWrite[] = [];
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
      exec: opts.exec ?? localExec(),
      tmpDir: join(sub, 'engine-tmp'),
      gitBin: 'git',
      shBin: 'sh',
    },
    spawner: {
      routeFacts: opts.routeFacts ?? (async () => (opts.route === undefined ? route() : opts.route)),
      drivers: {
        'claude-code': driver('claude-code'),
        'cursor-agent': driver('cursor-agent'),
        grok: driver('grok'),
        mirasim: driver('mirasim'),
      } as Record<WiredHost, HostDriver>,
      trees: ft.trees,
      baseEnv: { PATH: '/usr/bin' },
      resources: { memoryHighMb: 5888, memoryMaxMb: 6144, swapMaxMb: 0 },
      ...(opts.handoff ? { handoff: opts.handoff } : {}),
    },
    runs: {
      // 接回夹具模拟已有旧 runs 行；真实缺行与来源保存由 runs-writer 真库回归覆盖。
      async readSource() {
        return { workflowId: null, temporalRunId: null };
      },
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
    attempts: {
      async record(a) {
        attempts.push(a);
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
  return { m, ft, dir, recorded, started, startedWith, released, attempts, specs, run, input };
}

/** 假会话干活：在树里写个文件并提交。 */
function commitInTree(spec: HostRunSpec, file = 'page.tsx'): void {
  writeFileSync(join(spec.cwd, file), 'export const Page = () => null;\n');
  git(spec.cwd, 'add', '.');
  git(spec.cwd, 'commit', '-q', '-m', `add ${file}`);
}

/** 不靠计时：先确认正式读口已进入，再取消并释放它。 */
function preparationBarrier() {
  let enter: () => void = () => undefined;
  let release: () => void = () => undefined;
  const entered = new Promise<void>((resolve) => {
    enter = resolve;
  });
  const blocked = new Promise<void>((resolve) => {
    release = resolve;
  });
  return {
    entered,
    release,
    async wait() {
      enter();
      await blocked;
    },
  };
}

describe('取消后不再开始新的准备动作', { timeout: 60_000 }, () => {
  it('入口已经取消时不读路由、不认领树、不起会话', async () => {
    const lookup = vi.fn(async () => route());
    const r = rig({ routeFacts: lookup });
    const stop = new AbortController();
    const reason = new Error('取消先于入口');
    stop.abort(reason);
    await expect(r.run(r.input(), ctx(stop.signal))).rejects.toBe(reason);
    expect(lookup).not.toHaveBeenCalled();
    expect(r.ft.adopts).toEqual([]);
    expect(r.specs).toEqual([]);
  });

  it.each(['return', 'throw'] as const)('路由慢读之后取消（%s），原取消不变成配置失败', async (finish) => {
    const gate = preparationBarrier();
    const r = rig({
      routeFacts: async () => {
        await gate.wait();
        if (finish === 'throw') throw new Error('迟到路由错误');
        return route();
      },
    });
    const stop = new AbortController();
    const reason = new Error('路由读期间取消');
    const pending = r.run(r.input(), ctx(stop.signal));
    const checked = expect(pending).rejects.toBe(reason);
    await gate.entered;
    stop.abort(reason);
    gate.release();
    await checked;
    expect(r.ft.adopts).toEqual([]);
    expect(existsSync(r.dir)).toBe(false);
    expect(r.started).toEqual([]);
    expect(r.specs).toEqual([]);
  });

  it.each(['return', 'throw'] as const)('ownerOf 慢读之后取消（%s），不再 adopt 或写树', async (finish) => {
    const r = rig();
    const gate = preparationBarrier();
    vi.spyOn(r.ft.trees, 'ownerOf').mockImplementation(async () => {
      await gate.wait();
      if (finish === 'throw') throw new Error('迟到属主错误');
      return null;
    });
    const stop = new AbortController();
    const reason = new Error('属主读期间取消');
    const pending = r.run(r.input(), ctx(stop.signal));
    const checked = expect(pending).rejects.toBe(reason);
    await gate.entered;
    stop.abort(reason);
    gate.release();
    await checked;
    expect(r.ft.adopts).toEqual([]);
    expect(existsSync(r.dir)).toBe(false);
    expect(r.specs).toEqual([]);
  });

  it('读取提交身份时取消，已建的空目录保留，但不再取包或运行 Git', async () => {
    const commands = vi.fn(localExec());
    const r = rig({ exec: commands });
    const gate = preparationBarrier();
    vi.spyOn(r.m.gh, 'commitIdentity').mockImplementation(async () => {
      await gate.wait();
      return { name: 'probe', email: 'probe@localhost' };
    });
    const stop = new AbortController();
    const reason = new Error('提交身份读期间取消');
    const checked = expect(r.run(r.input(), ctx(stop.signal))).rejects.toBe(reason);
    await gate.entered;
    const adoptedBeforeCancel = [...r.ft.adopts];
    stop.abort(reason);
    gate.release();
    await checked;
    expect(r.ft.adopts).toEqual(adoptedBeforeCancel);
    expect(existsSync(join(r.dir, '.git'))).toBe(false);
    expect(r.m.calls).toEqual([]);
    expect(commands).not.toHaveBeenCalled();
    expect(r.specs).toEqual([]);
  });

  it('已有树的主线读取期间取消，不再补写主线引用或发下一条 Git 命令', async () => {
    const gate = preparationBarrier();
    const baseExec = localExec();
    let block = false;
    const afterCancel: string[][] = [];
    const stop = new AbortController();
    const r = rig({
      exec: async (command) => {
        if (stop.signal.aborted) afterCancel.push(command.argv);
        const result = await baseExec(command);
        if (block && command.argv.some((arg) => arg === 'refs/remotes/origin/main^{commit}')) {
          await gate.wait();
        }
        return result;
      },
    });
    await r.run(r.input(), ctx());
    git(r.dir, 'update-ref', '-d', 'refs/remotes/origin/main');
    const env = isolatedGitEnv(root, root);
    const before = repoStamp(env, r.dir);
    const starts = r.specs.length;
    block = true;
    const reason = new Error('Git 读期间取消');
    const checked = expect(r.run(r.input(), ctx(stop.signal))).rejects.toBe(reason);
    await gate.entered;
    stop.abort(reason);
    gate.release();
    await checked;
    expect(repoStamp(env, r.dir)).toEqual(before);
    expect(afterCancel).toEqual([]);
    expect(r.specs).toHaveLength(starts);
  });

  it('子代理设置清单慢读后取消，不写 settings，也不启动驱动', async () => {
    const gate = preparationBarrier();
    const r = rig({
      route: route({ hostId: 'mirasim' }),
      deps: {
        subagentGuard: async () => {
          await gate.wait();
          return { names: [], isolated: [] };
        },
      },
    });
    const stop = new AbortController();
    const reason = new Error('设置读期间取消');
    const checked = expect(r.run(r.input(), ctx(stop.signal))).rejects.toBe(reason);
    await gate.entered;
    const before = repoStamp(isolatedGitEnv(root, root), r.dir);
    stop.abort(reason);
    gate.release();
    await checked;
    expect(existsSync(join(r.dir, '.claude/settings.local.json'))).toBe(false);
    expect(repoStamp(isolatedGitEnv(root, root), r.dir)).toEqual(before);
    expect(r.specs).toEqual([]);
  });

  it('Spawner 的第二次路由读期间取消，不再认领临时目录或启动驱动', async () => {
    const gate = preparationBarrier();
    let reads = 0;
    const r = rig({
      routeFacts: async () => {
        reads += 1;
        if (reads === 2) await gate.wait();
        return route();
      },
    });
    const stop = new AbortController();
    const reason = new Error('Spawner 路由读期间取消');
    const checked = expect(r.run(r.input(), ctx(stop.signal))).rejects.toBe(reason);
    await gate.entered;
    const adopted = [...r.ft.adopts];
    stop.abort(reason);
    gate.release();
    await checked;
    expect(r.ft.adopts).toEqual(adopted);
    expect(r.ft.adopts.every((entry) => !entry.dir.startsWith(r.ft.tmpBase))).toBe(true);
    expect(r.specs).toEqual([]);
  });
});

describe('备树', { timeout: 60_000 }, () => {
  it('第一轮：树还不存在，会话用户从镜像建树、检出任务分支、钉好主线；会话在这棵树里起，提示词里有交代和规矩', async () => {
    const r = rig({
      driverRun: async (spec) => {
        commitInTree(spec);
        return report();
      },
    });
    const beats = { n: 0 };
    const got = await r.run(r.input(), {
      ...ctx(undefined, beats),
      workflowId: 'task:acme/demo#12',
      temporalRunId: 'execution-manual',
    });
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
      temporalRunId: 'execution-manual',
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

  it('选路那句为什么派它，开跑和收场都带着', async () => {
    const why = '主力档，强级在前；opus 难单一段过 2/4';
    const r = rig({
      driverRun: async (spec) => {
        commitInTree(spec);
        return report();
      },
    });
    const base = r.input();
    const got = await r.run(r.input({ route: { ...base.route, why } }), ctx());
    expect(got.ok).toBe(true);
    expect(r.started[0]?.routeWhy).toBe(why);
    expect(r.recorded[0]?.routeWhy).toBe(why);
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

  it('续会话（决定 0088）：带了会话号就用 resume 起那个号，提示词只补被打断的原因和返工意见，不重述交代', async () => {
    const r = rig({
      driverRun: async (spec) => {
        commitInTree(spec);
        return report();
      },
    });
    const got = await r.run(
      r.input({
        resumeSessionId: 'aaaaaaaa-1111-4222-8333-444444444444',
        interrupted: '被人暂停（frank）：发版',
        feedback: ['CI 红了：test (engine)'],
      }),
      ctx(),
    );
    expect(got.ok).toBe(true);
    const spec = r.specs[0] as HostRunSpec;
    expect(spec.session).toEqual({ mode: 'resume', id: 'aaaaaaaa-1111-4222-8333-444444444444' });
    expect(spec.prompt).toContain('打断了（被人暂停（frank）：发版）');
    expect(spec.prompt).toContain('CI 红了：test (engine)');
    expect(spec.prompt).not.toContain('# 任务：给驾驶舱加状态');
  });

  it('首轮预载（决定 0093）：「已知的模块」列的文件以会话用户从树里读出来放进提示词；不在的照实写；续会话不再给', async () => {
    const r = rig({
      driverRun: async (spec) => {
        commitInTree(spec);
        return report();
      },
    });
    const brief = {
      ...goodBrief(),
      touches: ['`a.ts`：要改的常量', '`src/new-file.ts`', '`packages/web/src/pages/`'],
    };
    expect((await r.run(r.input({ brief }), ctx())).ok).toBe(true);
    const prompt = r.specs[0]?.prompt ?? '';
    expect(prompt).toContain('## 已给你的文件（别再读）');
    // Windows 的检出可能是 CRLF：只认内容，不认换行符
    expect(prompt).toMatch(/### `a\.ts`\n```\nexport const a = 1;\r?\n```/);
    expect(prompt).toContain('`src/new-file.ts`：工作树里没有这个文件');
    expect(prompt).not.toContain('### `packages/web/src/pages/`');
    expect(prompt.indexOf('## 已给你的文件')).toBeLessThan(prompt.indexOf('## 怎么干'));

    const resumed = rig({
      driverRun: async (spec) => {
        commitInTree(spec);
        return report();
      },
    });
    await resumed.run(
      resumed.input({ brief, resumeSessionId: 'aaaaaaaa-1111-4222-8333-444444444444' }),
      ctx(),
    );
    expect(resumed.specs[0]?.prompt).not.toContain('已给你的文件');
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

describe('每次起会话的尝试落库（channel_attempts，#1118）', { timeout: 60_000 }, () => {
  it('跑成：记一行，带 run 编号、单、模型、路由、渠道和起止；没有错误类型', async () => {
    const r = rig({
      driverRun: async (spec) => {
        commitInTree(spec);
        return report();
      },
    });
    await r.run(r.input(), ctx());
    expect(r.attempts).toHaveLength(1);
    expect(r.attempts[0]).toMatchObject({
      runId: 'run-0002',
      taskId: TASK_ID,
      modelId: 'claude-opus-5-5',
      routeId: 'r1',
      channelId: 'claude-subscription',
    });
    expect(r.attempts[0]).not.toHaveProperty('errorType');
    expect(r.attempts[0]?.endedAt.getTime()).toBeGreaterThanOrEqual(r.attempts[0]?.startedAt.getTime() ?? 0);
  });

  it('【故意造出的失败】没跑成（额度用满）：记一行，错误类型是会话的原因码，带原文摘要', async () => {
    const r = rig({
      driverRun: async () =>
        report({
          facts: okFacts({
            quotaExhausted: true,
            terminal: { isError: true, detail: 'limit reached' },
            exitCode: 1,
          }),
          rawError: '5-hour limit reached',
        }),
    });
    await r.run(r.input(), ctx());
    expect(r.attempts).toHaveLength(1);
    expect(r.attempts[0]).toMatchObject({ runId: 'run-0002', errorType: 'quota_exhausted' });
    expect(r.attempts[0]?.message).toContain('5-hour limit reached');
  });

  it('【故意造出的失败】会话起不来（驱动抛错）：照样记一行，错误类型 spawn_failed，抛出的错不变', async () => {
    const r = rig({
      driverRun: async () => {
        throw new Error('sudo 不让用');
      },
    });
    await expect(r.run(r.input(), ctx())).rejects.toMatchObject({ code: 'SEGMENT_SPAWN_FAILED' });
    expect(r.attempts).toHaveLength(1);
    expect(r.attempts[0]).toMatchObject({ errorType: 'spawn_failed', channelId: 'claude-subscription' });
    expect(r.attempts[0]?.message).toContain('sudo 不让用');
  });

  it('【故意造出的失败】开跑那一行写不进 runs：会话没起、没轮到渠道，不记尝试', async () => {
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
    await expect(r.run(r.input(), ctx())).rejects.toMatchObject({ code: 'SEGMENT_RUNS_UNWRITABLE' });
    expect(r.attempts).toHaveLength(0);
  });

  it('【故意造出的失败】尝试写不进库：只记日志（写明哪条路由、为什么），会话的结局照常交回，不让跑成的会话白跑', async () => {
    const logs: { message: string; fields?: Record<string, unknown> | undefined }[] = [];
    const r = rig({
      driverRun: async (spec) => {
        commitInTree(spec);
        return report();
      },
      deps: {
        attempts: {
          async record() {
            throw new Error('connection refused');
          },
        },
        log: (message, fields) => logs.push({ message, fields }),
      },
    });
    const got = await r.run(r.input(), ctx());
    expect(got.ok).toBe(true);
    const note = logs.find((l) => l.message.includes('channel_attempts'));
    expect(note?.fields).toMatchObject({ routeId: 'r1', error: 'connection refused' });
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

describe('发布排空看得见动手会话（#957）', { timeout: 60_000 }, () => {
  const DEADLINE = '到了发布宽限的截止';
  const aborted = (signal: AbortSignal) =>
    new Promise<void>((resolve) => {
      if (signal.aborted) return resolve();
      signal.addEventListener('abort', () => resolve(), { once: true });
    });
  /** 起一段会话、等它进了「在跑」。 */
  async function startedSegment(over: Parameters<typeof rig>[0] = {}) {
    const drain = createEngineDrain();
    const sessions = oneShotSessions({ drain });
    let resolveStarted: () => void = () => {};
    const started = new Promise<void>((resolve) => {
      resolveStarted = resolve;
    });
    const r = rig({
      ...over,
      deps: { sessions, ...over.deps },
      driverRun:
        over.driverRun ??
        (async (_spec, hooks) => {
          resolveStarted();
          await aborted(hooks.signal as AbortSignal);
          return report({ facts: { exitCode: null, killed: 'aborted', quotaExhausted: false } });
        }),
    });
    const pending = r.run(r.input(), ctx());
    // 先挂上，不让没人接的拒绝报成未处理
    pending.catch(() => undefined);
    await started;
    return { drain, sessions, r, pending };
  }

  it('动手会话在跑时，排空报「还有 1 个」（带阶段、单、在跑）；到截止停下它，这一段交回 org_switch，清单走空，排空 empty', async () => {
    const { drain, sessions, pending } = await startedSegment();
    expect(drain.inFlight()).toEqual([
      expect.objectContaining({ runId: 'run-0002', stage: 'execute', taskId: TASK_ID, phase: 'running' }),
    ]);
    // 发布来了、已经过了截止：排空照在途清单等；停会话（drain-control 到点调的那一路）
    drain.cordon({ source: 'release', since: 'x', until: new Date(0).toISOString(), why: '发布 aaaa' });
    const seen: number[] = [];
    const ended = await waitDrained(drain, {
      stopSessions: (why) => sessions.drainStop(why),
      forced: () => false,
      pollMs: 5,
      onTick: (waiting) => seen.push(waiting.length),
    });
    expect(seen[0]).toBe(1);
    expect(ended).toEqual({ end: 'empty', left: [] });
    expect(await pending).toMatchObject({
      ok: false,
      outcome: 'org_switch',
      evidence: { code: 'org_switch' },
    });
    expect(drain.inFlight()).toEqual([]);
  });

  it('没到截止：排空不放行（waitDrained 一直等，只报「还有 1 个」），会话没被动', async () => {
    const { drain, sessions } = await startedSegment();
    drain.cordon({
      source: 'release',
      since: 'x',
      until: new Date(Date.now() + 3_600_000).toISOString(),
      why: '发布',
    });
    let stopCalls = 0;
    let ticks = 0;
    const waiting = waitDrained(drain, {
      stopSessions: (why) => {
        stopCalls += 1;
        return sessions.drainStop(why);
      },
      forced: () => ticks >= 3,
      pollMs: 5,
      onTick: () => {
        ticks += 1;
      },
    });
    expect(await waiting).toMatchObject({
      end: 'forced',
      left: [expect.objectContaining({ stage: 'execute' })],
    });
    expect(stopCalls).toBe(0);
    expect(drain.inFlight()).toHaveLength(1);
    sessions.drainStop(DEADLINE);
  });

  it('【故意造出的失败】会话抛错、被叫停、没起会话：登记一定撤掉，不泄漏成永远排不空', async () => {
    // 抛错：驱动自己炸了
    const drain = createEngineDrain();
    const sessions = oneShotSessions({ drain });
    const thrown = rig({
      deps: { sessions },
      driverRun: async () => {
        throw new Error('驱动炸了');
      },
    });
    await expect(thrown.run(thrown.input(), ctx())).rejects.toBeDefined();
    expect(drain.inFlight()).toEqual([]);

    // 工作流放弃（ctx.signal 响了）
    const stop = new AbortController();
    const d2 = createEngineDrain();
    const s2 = oneShotSessions({ drain: d2 });
    const abandoned = rig({
      deps: { sessions: s2 },
      driverRun: async (_spec, hooks) => {
        stop.abort(new Error('任务被放弃'));
        await aborted(hooks.signal as AbortSignal);
        return report({ facts: { exitCode: null, killed: 'aborted', quotaExhausted: false } });
      },
    });
    await expect(abandoned.run(abandoned.input(), ctx(stop.signal))).rejects.toBeDefined();
    expect(d2.inFlight()).toEqual([]);

    // 路由用不了：还没起会话就抛
    const d3 = createEngineDrain();
    const noRoute = rig({ route: null, deps: { sessions: oneShotSessions({ drain: d3 }) } });
    await expect(noRoute.run(noRoute.input(), ctx())).rejects.toMatchObject({
      code: 'SEGMENT_ROUTE_UNUSABLE',
    });
    expect(d3.inFlight()).toEqual([]);
  });

  it('已经在排空时才轮到这一段：不起会话（没动 Spawner），回 org_switch，登记走掉', async () => {
    const drain = createEngineDrain();
    drain.cordon({
      source: 'release',
      since: 'x',
      until: new Date(Date.now() + 600_000).toISOString(),
      why: '发布 aaaa',
    });
    const r = rig({ deps: { sessions: oneShotSessions({ drain }) } });
    const got = await r.run(r.input(), ctx());
    expect(got).toMatchObject({ ok: false, outcome: 'org_switch', evidence: { code: 'org_switch' } });
    expect((got as { evidence: { message: string } }).evidence.message).toContain('要发新版本');
    expect(r.specs).toHaveLength(0);
    expect(drain.inFlight()).toEqual([]);
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

describe('子代理（#1641）：树里的本地设置和提示词那一句', { timeout: 60_000 }, () => {
  const GUARD = { names: ['fleet-builder', 'fleet-scout'], isolated: ['fleet-builder'] };
  const mirasimRoute = (over: Partial<RouteLaunchFacts> = {}) =>
    route({ hostId: 'mirasim', modelId: 'deepseek-flash', upstreamModel: 'deepseek-flash', ...over });
  const settingsOf = (dir: string) =>
    JSON.parse(readFileSync(join(dir, '.claude', 'settings.local.json'), 'utf8')) as {
      env: Record<string, string>;
      permissions: { deny: string[] };
    };

  it('Mirasim 的会话：建好树后、起会话之前，树里有 settings.local.json；非 Claude 模型挡全部子代理，并发上限 2', async () => {
    let seen: ReturnType<typeof settingsOf> | undefined;
    const r = rig({
      route: mirasimRoute(),
      deps: { subagentGuard: async () => GUARD },
      driverRun: async (spec) => {
        seen = settingsOf(spec.cwd);
        commitInTree(spec);
        return report({ hostId: 'mirasim' });
      },
    });
    await r.run(r.input(), ctx());
    expect(seen).toEqual({
      env: { CLAUDE_CODE_MAX_CONCURRENT_SUBAGENTS: '2' },
      permissions: { deny: ['Agent(fleet-builder)', 'Agent(fleet-scout)'] },
    });
  });

  it('Mirasim 的会话、Claude 模型：只挡带 isolation 的', async () => {
    let seen: ReturnType<typeof settingsOf> | undefined;
    const r = rig({
      route: mirasimRoute({ modelId: 'claude-sonnet-5-5', upstreamModel: 'claude-sonnet-5-5' }),
      deps: { subagentGuard: async () => GUARD },
      driverRun: async (spec) => {
        seen = settingsOf(spec.cwd);
        commitInTree(spec);
        return report({ hostId: 'mirasim' });
      },
    });
    await r.run(r.input(), ctx());
    expect(seen?.permissions.deny).toEqual(['Agent(fleet-builder)']);
  });

  it('claude-code 的会话不写这个文件（它带 --setting-sources project，不读本地这一层）', async () => {
    let wrote = true;
    const r = rig({
      deps: { subagentGuard: async () => GUARD },
      driverRun: async (spec) => {
        wrote = existsSync(join(spec.cwd, '.claude', 'settings.local.json'));
        commitInTree(spec);
        return report();
      },
    });
    await r.run(r.input(), ctx());
    expect(wrote).toBe(false);
  });

  describe('定义靠会话用户家里的 ~/.claude/agents（#2820）', () => {
    const installedHome = (names: string[]) => {
      const home = mkdtempSync(join(tmpdir(), 'fleet-seg-home-'));
      onTestFinished(() => rmSync(home, { recursive: true, force: true }));
      mkdirSync(join(home, '.claude', 'agents'), { recursive: true });
      for (const n of names)
        writeFileSync(join(home, '.claude', 'agents', n), readFileSync(join(SUBAGENTS_DIR, n), 'utf8'));
      return home;
    };
    const claudeRoute = () => mirasimRoute({ modelId: 'claude-opus-5-5', upstreamModel: 'claude-opus-5-5' });

    it('Mirasim 的 Claude 会话：家里装着的和仓里一样，起会话，提醒报「没有问题」（空数组）', async () => {
      const reported: [string, readonly string[]][] = [];
      const r = rig({
        route: claudeRoute(),
        deps: {
          subagentGuard: () => readSubagentGuard(),
          subagentsHome: installedHome(['Explore.md', 'general-purpose.md', 'Plan.md']),
          reportSubagentDefs: async (user, problems) => {
            reported.push([user, problems]);
          },
        },
        driverRun: async (spec) => {
          commitInTree(spec);
          return report({ hostId: 'mirasim' });
        },
      });
      await r.run(r.input(), ctx());
      expect(r.specs).toHaveLength(1);
      expect(reported).toEqual([[USER, []]]);
    });

    it('Mirasim 的 Claude 会话：家里缺一份，照常起会话（不挡），提醒收到这一份的问题（#2834）', async () => {
      const reported: [string, readonly string[]][] = [];
      const r = rig({
        route: claudeRoute(),
        deps: {
          subagentGuard: () => readSubagentGuard(),
          subagentsHome: installedHome(['Explore.md', 'Plan.md']),
          reportSubagentDefs: async (user, problems) => {
            reported.push([user, problems]);
          },
        },
        driverRun: async (spec) => {
          commitInTree(spec);
          return report({ hostId: 'mirasim' });
        },
      });
      await r.run(r.input(), ctx());
      expect(r.specs).toHaveLength(1);
      expect(reported).toHaveLength(1);
      expect(reported[0]?.[0]).toBe(USER);
      expect(reported[0]?.[1]).toEqual([expect.stringContaining('general-purpose')]);
    });

    it('Mirasim 的 Claude 会话：报提醒的那一下抛错，只记日志，照常起会话', async () => {
      const logs: { message: string; fields?: Record<string, unknown> | undefined }[] = [];
      const r = rig({
        route: claudeRoute(),
        deps: {
          subagentGuard: () => readSubagentGuard(),
          subagentsHome: installedHome(['Explore.md', 'Plan.md']),
          reportSubagentDefs: async () => {
            throw new Error('库连不上');
          },
          log: (message, fields) => logs.push({ message, fields }),
        },
        driverRun: async (spec) => {
          commitInTree(spec);
          return report({ hostId: 'mirasim' });
        },
      });
      await r.run(r.input(), ctx());
      expect(r.specs).toHaveLength(1);
      expect(logs).toEqual([
        {
          message: '子代理定义对不上的提醒没报成（不挡会话）',
          fields: { user: USER, error: '库连不上' },
        },
      ]);
    });

    it('Mirasim 的非 Claude 会话：不核对家里装的，照旧挡掉全部子代理', async () => {
      let seen: ReturnType<typeof settingsOf> | undefined;
      const reported: unknown[] = [];
      const r = rig({
        route: mirasimRoute(),
        deps: {
          subagentGuard: () => readSubagentGuard(),
          subagentsHome: installedHome([]),
          reportSubagentDefs: async (...args) => {
            reported.push(args);
          },
        },
        driverRun: async (spec) => {
          seen = settingsOf(spec.cwd);
          commitInTree(spec);
          return report({ hostId: 'mirasim' });
        },
      });
      await r.run(r.input(), ctx());
      expect(seen?.permissions.deny).toEqual(['Agent(Explore)', 'Agent(Plan)', 'Agent(general-purpose)']);
      expect(reported).toEqual([]);
    });
  });

  it('【故意造出的失败】Mirasim 的会话读不到子代理清单：这一段不起会话（deny 写不上，不带着没挡的状态起）', async () => {
    const r = rig({
      route: mirasimRoute(),
      deps: {
        subagentGuard: async () => {
          throw new Error('子代理定义读不到');
        },
      },
    });
    await expect(r.run(r.input(), ctx())).rejects.toMatchObject({ code: 'SEGMENT_SUBAGENT_GUARD' });
    expect(r.specs).toHaveLength(0);
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

/**
 * 等这一段的会话起来（驱动收到 spec）。vi.waitFor 默认只等 1 秒，盖不住备树：真 git 钉主线在忙的 CI 上
 * 经常超过 1 秒。等到点用例就失败，收场把临时目录删了；钉主线的 spawn 撞上已经不在的工作目录，Node 把这
 * 报成 `spawn git ENOENT`（和 PATH 里没有 git 是同一句）。#2716
 */
const sessionUp = (specs: HostRunSpec[]) =>
  vi.waitFor(() => expect(specs).toHaveLength(1), { timeout: 30_000 });

describe('脱开引擎跑、引擎重启后接回（#2238：发版不再停在跑的动手会话）', { timeout: 60_000 }, () => {
  const grok = route({ hostId: 'grok', channelId: 'xai', poolId: 'grok', modelId: 'grok-4.7' });
  /** 驱动跑着、直到被叫停；放手以后永远不落定（和 detached.ts 一样）。真驱动起会话前建好收发目录。 */
  const runsUntilStopped = async (_spec: HostRunSpec, hooks: HostRunHooks): Promise<HostReport> => {
    if (hooks.io && !hooks.io.attach) mkdirSync(hooks.io.dir, { recursive: true });
    await new Promise<void>((resolve) => hooks.signal?.addEventListener('abort', () => resolve()));
    return report({ facts: okFacts({ exitCode: null, killed: 'aborted' }) });
  };

  it('钉主线起 git 比等会话的默认 1 秒还慢时，工作目录还在，会话照样起来', async () => {
    const real = localExec();
    const r = rig({
      exec: async (command) => {
        // 钉 origin/main 这一下故意慢过 vi.waitFor 的默认 1 秒。以前等到点就收场删目录，
        // 随后的 spawn 撞上不在的工作目录，报 spawn git ENOENT。
        const pinning =
          command.argv.includes('update-ref') &&
          command.argv.some((arg) => arg.startsWith('refs/remotes/origin/'));
        if (pinning) await new Promise((resolve) => setTimeout(resolve, 1_500));
        return real(command);
      },
      driverRun: async (spec) => {
        commitInTree(spec);
        return report();
      },
    });
    const pending = r.run(r.input(), ctx());
    await sessionUp(r.specs);
    expect((await pending).ok).toBe(true);
    expect(git(r.dir, 'rev-parse', 'origin/main')).toBe(r.m.head);
  });

  it('grok 上的动手会话：引擎要走了 → 不停会话，交回 detached（runs 编号、起的时刻），不记尝试、runs 那一行不收、不在排空清单里；新引擎带 attach 接回，不建树、不开跑，结局记到原来那一行', async () => {
    const ioRoot = join(root, 'io');
    const drain = createEngineDrain();
    const sessions = oneShotSessions({ drain });
    const oldEngine = sessionHandoff(ioRoot);
    const r = rig({ route: grok, handoff: oldEngine, driverRun: runsUntilStopped, deps: { sessions } });
    const pending = r.run(r.input(), ctx());
    await sessionUp(r.specs);
    // 脱开跑的不在发布排空的在途清单里：release.sh 不给它发暂停、排空不等它；到截止也不停它
    expect(drain.inFlight()).toEqual([]);
    expect(sessions.drainStop('到了发布宽限的截止')).toEqual([]);
    expect(oldEngine.leave('收到 SIGTERM')).toEqual(['run-0002']);
    const got = await pending;
    expect(got).toMatchObject({
      ok: false,
      outcome: SEGMENT_DETACHED,
      runId: 'run-0002',
      evidence: { code: 'engine_stop' },
      detached: { runId: 'run-0002', startedAt: expect.any(String) },
    });
    expect(r.recorded).toEqual([]);
    expect(r.attempts).toEqual([]);
    expect(existsSync(join(ioRoot, 'run-0002', DETACHED_MARK))).toBe(true);

    // 新引擎：同一个收发目录的根，驱动从文件接回（这里直接交回跑完的报告）
    const newEngine = sessionHandoff(ioRoot);
    const r2 = rig({ route: grok, handoff: newEngine, driverRun: async () => report({ hostId: 'grok' }) });
    const adoptsBefore = r2.ft.treeAdopts().length;
    if (got.ok || !got.detached) throw new Error('上面没交回 detached');
    const back = await r2.run(r2.input({ attach: got.detached }), ctx());
    expect(back).toMatchObject({ ok: true, runId: 'run-0002' });
    expect(r2.started).toEqual([]);
    expect(r2.ft.treeAdopts()).toHaveLength(adoptsBefore);
    expect(r2.recorded).toEqual([
      expect.objectContaining({ runId: 'run-0002', outcome: 'done', startedAt: got.detached.startedAt }),
    ]);
    expect(r2.attempts).toEqual([expect.objectContaining({ runId: 'run-0002' })]);
    expect(existsSync(join(ioRoot, 'run-0002'))).toBe(false);
  });

  it('接回时引擎又在走（发版连着发）：不碰会话、不登记，当场再交回 detached 等下一个引擎', async () => {
    const leaving = sessionHandoff(join(root, 'io'));
    leaving.leave('收到 SIGTERM');
    const r = rig({ route: grok, handoff: leaving });
    const attach = { runId: 'run-0009', startedAt: new Date().toISOString() };
    expect(await r.run(r.input({ attach }), ctx())).toMatchObject({
      ok: false,
      outcome: SEGMENT_DETACHED,
      detached: attach,
    });
    expect(r.specs).toEqual([]);
    expect(r.recorded).toEqual([]);
  });

  /** 假的 Mirasim 驱动（#2815）：放手信号响了交回「放手」的报告（不发 stop）；叫停信号响了交回被叫停的报告。 */
  const mirasimUntilReleasedOrStopped = (_spec: HostRunSpec, hooks: HostRunHooks): Promise<HostReport> =>
    new Promise((resolve) => {
      if (hooks.io && !hooks.io.attach) mkdirSync(hooks.io.dir, { recursive: true });
      hooks.io?.release?.addEventListener('abort', () =>
        resolve(report({ hostId: 'mirasim', detached: true })),
      );
      hooks.signal?.addEventListener('abort', () =>
        resolve(report({ hostId: 'mirasim', facts: okFacts({ exitCode: null, killed: 'aborted' }) })),
      );
    });

  it('Mirasim 上的动手会话（#2815）：发版到截止不停它（不在排空清单里），引擎要走了放手、交回 detached，不发 stop；新引擎带 attach 接回，结局记到原来那一行', async () => {
    const ioRoot = join(root, 'io');
    const drain = createEngineDrain();
    const sessions = oneShotSessions({ drain });
    const oldEngine = sessionHandoff(ioRoot);
    const r = rig({
      route: route({ hostId: 'mirasim' }),
      handoff: oldEngine,
      driverRun: mirasimUntilReleasedOrStopped,
      deps: { sessions },
    });
    const pending = r.run(r.input(), ctx());
    await sessionUp(r.specs);
    expect(drain.inFlight()).toEqual([]);
    expect(sessions.drainStop('到了发布宽限的截止')).toEqual([]);
    expect(oldEngine.leave('收到 SIGTERM')).toEqual(['run-0002']);
    const got = await pending;
    expect(got).toMatchObject({ ok: false, outcome: SEGMENT_DETACHED, runId: 'run-0002' });
    expect(r.recorded).toEqual([]);
    expect(existsSync(join(ioRoot, 'run-0002', DETACHED_MARK))).toBe(true);

    const r2 = rig({
      route: route({ hostId: 'mirasim' }),
      handoff: sessionHandoff(ioRoot),
      driverRun: async () => report({ hostId: 'mirasim' }),
    });
    if (got.ok || !got.detached) throw new Error('上面没交回 detached');
    const back = await r2.run(r2.input({ attach: got.detached }), ctx());
    expect(back).toMatchObject({ ok: true, runId: 'run-0002' });
    expect(r2.started).toEqual([]);
    expect(r2.recorded).toEqual([
      expect.objectContaining({ runId: 'run-0002', outcome: 'done', startedAt: got.detached.startedAt }),
    ]);
  });

  it('Mirasim 上的动手会话：切号叫停照旧停（发 stop 那条路），不放手', async () => {
    const sessions = oneShotSessions({ drain: createEngineDrain() });
    const r = rig({
      route: route({ hostId: 'mirasim' }),
      handoff: sessionHandoff(join(root, 'io')),
      driverRun: mirasimUntilReleasedOrStopped,
      deps: { sessions },
    });
    const pending = r.run(r.input(), ctx());
    await sessionUp(r.specs);
    expect(sessions.stop(new Set([route({ hostId: 'mirasim' }).poolId]), '切号')).toEqual(['run-0002']);
    expect(await pending).toMatchObject({ ok: false, outcome: 'org_switch' });
    expect(existsSync(join(root, 'io', 'run-0002', DETACHED_MARK))).toBe(false);
  });
});

describe('备树不把父仓当成目标仓', { timeout: 60_000 }, () => {
  const REF = 'refs/fleet/export/1';

  function envFor(): Record<string, string> {
    const home = join(root, 'home');
    mkdirSync(home, { recursive: true });
    return isolatedGitEnv(realpathSync(root), home);
  }

  function commitRepo(env: Record<string, string>, dir: string): string {
    mkdirSync(dir, { recursive: true });
    gitIn(env, dir, 'init', '-q', '-b', 'main');
    writeFileSync(join(dir, 'README'), 'hi\n');
    gitIn(env, dir, 'add', 'README');
    gitIn(env, dir, 'commit', '-q', '-m', 'init');
    return gitIn(env, dir, 'rev-parse', 'HEAD');
  }

  it('目录还不存在、以及已经在的空子目录：取 bundle 之前就停，不 init、不改父仓', async () => {
    const env = envFor();
    const parent = join(root, 'parent');
    const mirrorDir = join(root, 'mirror');
    commitRepo(env, parent);
    const tip = commitRepo(env, mirrorDir);
    const gh = {
      async fetchMainline() {
        return { head: tip, defaultBranch: 'main' };
      },
      async bundleCommits(input: { tips: string[]; outPath: string }) {
        const tipSha = input.tips[0] as string;
        gitIn(env, mirrorDir, 'update-ref', REF, tipSha);
        gitIn(env, mirrorDir, 'bundle', 'create', input.outPath, REF);
        gitIn(env, mirrorDir, 'update-ref', '-d', REF);
        return { path: input.outPath, bytes: 0, refs: [{ tip: tipSha, ref: REF }] };
      },
      async commitIdentity() {
        return { name: 'fleet-agent[bot]', email: 'bot@localhost' };
      },
    };
    const deps = {
      gh,
      trees: fakeTrees(join(root, 'layout')).trees,
      exec: isolatedUserExec(env),
      tmpDir: join(root, 'engine-tmp'),
      gitBin: 'git',
      shBin: 'sh',
    };
    const input = {
      repo: REPO,
      worktreePath: join(parent, 'fresh-child'),
      branch: BRANCH,
      baseSha: tip,
      user: USER,
      runId: 'boundary-fresh',
    };
    const before = repoStamp(env, parent);
    const freshErr = await prepareSegmentTree(deps, input, ctx()).catch((e: unknown) => e);
    expect(freshErr).toMatchObject({
      code: 'GIT_FAILED',
      retryable: false,
      message: expect.stringContaining('不能往那里写'),
    });
    expect(existsSync(join(parent, 'fresh-child', '.git'))).toBe(false);

    const existing = join(parent, 'empty-child');
    mkdirSync(existing);
    const ft = fakeTrees(join(root, 'layout-2'));
    ft.owners.set(existing, USER);
    const again = await prepareSegmentTree(
      { ...deps, trees: ft.trees },
      { ...input, worktreePath: existing, runId: 'boundary-existing' },
      ctx(),
    ).catch((e: unknown) => e);
    expect(again).toMatchObject({
      code: 'GIT_FAILED',
      retryable: false,
      message: expect.stringContaining('不能往那里写'),
    });
    expect(existsSync(join(existing, '.git'))).toBe(false);
    expect(repoStamp(env, parent)).toEqual(before);
    expect(gitIn(env, parent, 'status', '--porcelain')).toBe('');
  });

  it('已经是检出、但和主仓共用元数据：走钉主线那一支，写入前停下，主仓的配置、HEAD、引用不变', async () => {
    const env = envFor();
    const parent = join(root, 'parent');
    const head = commitRepo(env, parent);
    const linked = join(root, 'linked');
    gitIn(env, parent, 'worktree', 'add', '-q', linked, 'HEAD');
    expect(lstatSync(join(linked, '.git')).isFile()).toBe(true);
    const ft = fakeTrees(join(root, 'layout'));
    ft.owners.set(linked, USER);
    const before = repoStamp(env, parent);
    const err = await prepareSegmentTree(
      {
        gh: {
          async fetchMainline() {
            return { head, defaultBranch: 'main' };
          },
          async bundleCommits() {
            throw new Error('这条路不该去镜像取包');
          },
          async commitIdentity() {
            return { name: 'fleet-agent[bot]', email: 'bot@localhost' };
          },
        },
        trees: ft.trees,
        exec: isolatedUserExec(env),
        tmpDir: join(root, 'engine-tmp'),
        gitBin: 'git',
        shBin: 'sh',
      },
      {
        repo: REPO,
        worktreePath: linked,
        branch: BRANCH,
        baseSha: head,
        user: USER,
        runId: 'boundary-pin',
      },
      ctx(),
    ).catch((e: unknown) => e);
    expect(err).toMatchObject({
      code: 'GIT_FAILED',
      retryable: false,
      message: expect.stringContaining('共用元数据'),
    });
    expect(repoStamp(env, parent)).toEqual(before);
  });
});
