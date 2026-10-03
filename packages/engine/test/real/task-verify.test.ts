// 任务工作流的冷验收（real/task-verify.ts，#632 S2-5b）：读 PR 和文件（假 GitHub）→ 选路（假选路，按族）→ 一次性会话
// （假驱动，不起真执行体）→ 贴 cold-verify 状态 → 结局整理成工作流要的形状。每条做不出来、要等、被叫停、贴不上的路径故意造一次。
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { RunFacts, SessionUser } from '@fleet-dao/adapters';
import type { RouteLaunchFacts } from '@fleet-dao/db';
import type { PullFacts } from '@fleet-dao/github';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { type PickRouteInput, type PickRouteResult, type PortContext, PortError } from '../../src/ports.ts';
import type { HostDriver, HostReport, HostRunHooks, HostRunSpec, WiredHost } from '../../src/real/hosts.ts';
import { oneShotSessions } from '../../src/real/one-shot-sessions.ts';
import {
  type ColdVerifyActivityDeps,
  createColdVerify,
  type DiffFile,
  renderDiff,
  VERIFY_ORG_SWITCH_RETRY_SECONDS,
} from '../../src/real/task-verify.ts';
import type { RunRecord, RunStart } from '../../src/runner/not-wired.ts';
import type { ColdVerifyInput } from '../../src/task-contract.ts';
import { FAMILY_ORDER, type ModelFamily } from '../../src/verifier-invoke.ts';
import { fakeTrees } from './fixtures.ts';

const USER = 'fleet-agent-carpool' as SessionUser;
const REPO = { id: 'r1', owner: 'acme', name: 'demo', defaultBranch: 'main', testCommand: 'pnpm check' };
const BRANCH = 'fleet/12-t1a2b3c4d';
const TASK_ID = '5f0c2a8e-3b1d-4c6e-9a7f-1e2d3c4b5a69';
const HEAD = 'a'.repeat(40);
const BASE = 'b'.repeat(40);

const MODEL_PASS = ['看过了。', '', '## 问题', '', 'verdict: pass'].join('\n');
const MODEL_FAIL = ['## 问题', '- 没做到验收条：单子要状态栏，代码里没有', '', 'verdict: fail'].join('\n');

const routeFacts = (routeId: string, over: Partial<RouteLaunchFacts> = {}): RouteLaunchFacts => ({
  routeId,
  channelId: 'claude-subscription',
  poolId: 'p1',
  modelId: 'some-model',
  hostId: 'claude-code',
  upstreamModel: null,
  runAsUser: USER,
  orgKind: null,
  ...over,
});

const report = (answer: string, over: Partial<HostReport> = {}): HostReport => ({
  hostId: 'claude-code',
  facts: { exitCode: 0, terminal: { isError: false, detail: 'done' }, quotaExhausted: false } as RunFacts,
  usage: { inputTokens: 900, outputTokens: 120 },
  sessionCostUsd: 0.12,
  actualModel: 'some-model',
  answer,
  wallMs: 500,
  stderrTail: '',
  ...over,
});

const pullFacts = (over: Partial<PullFacts> = {}): PullFacts => ({
  number: 42,
  nodeId: 'PR_node',
  state: 'open',
  merged: false,
  draft: false,
  title: '给驾驶舱加状态',
  body: '',
  headSha: HEAD,
  headRef: BRANCH,
  fromFork: false,
  author: null,
  autoMerge: false,
  ...over,
});

const FILES: DiffFile[] = [
  {
    filename: 'web/status.tsx',
    status: 'added',
    patch: '@@ -0,0 +1 @@\n+export const Status = 1;',
    changes: 1,
  },
];

/** 选路剧本：按「被问的那一族」给答案；没写的族＝一条路由都没有。 */
type PickScript = Partial<Record<ModelFamily, PickRouteResult>>;
const okRoute = (family: ModelFamily): PickRouteResult => ({
  ok: true,
  route: {
    routeId: `route-${family}`,
    poolId: `pool-${family}`,
    modelId: `${family}-model`,
    family,
    hostId: 'claude-code',
  },
  why: '测试',
});

let root: string;
beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'fleet-task-verify-'));
});
afterEach(() => {
  rmSync(root, { recursive: true, force: true });
});

const ctx = (signal = new AbortController().signal): PortContext => ({
  signal,
  heartbeat: () => undefined,
  attempt: 1,
  lastHeartbeat: undefined,
});

interface Posted {
  sha: string;
  context: string;
  state: string;
  description: string;
}

function rig(
  opts: {
    pull?: Partial<PullFacts>;
    files?: DiffFile[];
    picks?: PickScript;
    driverRun?: (spec: HostRunSpec, hooks: HostRunHooks, n: number) => Promise<HostReport>;
    routeFor?: (routeId: string) => RouteLaunchFacts | null;
    readPullError?: Error;
    pullFilesError?: Error;
    setStatusError?: (posted: Posted[]) => Error | undefined;
    pickRouteError?: Error;
    deps?: Partial<ColdVerifyActivityDeps>;
  } = {},
) {
  const sub = mkdtempSync(join(root, 'rig-'));
  mkdirSync(join(sub, 'runs'), { recursive: true });
  const ft = fakeTrees(join(sub, 'work'));
  const posted: Posted[] = [];
  const specs: HostRunSpec[] = [];
  const recorded: RunRecord[] = [];
  const started: RunStart[] = [];
  const asked: PickRouteInput[] = [];
  let n = 0;
  const driver = (hostId: WiredHost): HostDriver => ({
    hostId,
    userFrom: 'pool',
    canFork: false,
    newSessionId: () => ({ id: '11111111-2222-4333-8444-555555555555', known: true }),
    async run(spec, hooks) {
      specs.push(spec);
      n += 1;
      return (opts.driverRun ?? (async () => report(MODEL_PASS)))(spec, hooks, n);
    },
    loginFix: () => '去登录',
  });
  const gh = {
    claims: {
      async readPull() {
        if (opts.readPullError) throw opts.readPullError;
        return pullFacts(opts.pull);
      },
      async setStatus(_repo: unknown, sha: string, status: Omit<Posted, 'sha'>) {
        const err = opts.setStatusError?.(posted);
        if (err) throw err;
        posted.push({ sha, ...status });
      },
    },
    async pullFiles() {
      if (opts.pullFilesError) throw opts.pullFilesError;
      return opts.files ?? FILES;
    },
  } as unknown as ColdVerifyActivityDeps['gh'];
  // 不写选路剧本＝gpt 有路由（作者是 claude 时 0006 顺序里的第一家）；要造「一条都没有」写 picks: {}
  const picks: PickScript = opts.picks ?? { gpt: okRoute('gpt') };
  let ids = 0;
  const run = createColdVerify({
    gh,
    pickRoute: async (input) => {
      asked.push(input);
      if (opts.pickRouteError) throw opts.pickRouteError;
      const family = FAMILY_ORDER.find((f) => !(input.avoidFamilies ?? []).includes(f));
      return (family && picks[family]) || { ok: false, waitFor: 'none', detail: '没有路由' };
    },
    spawner: {
      routeFacts: async (id) =>
        opts.routeFor ? opts.routeFor(id) : routeFacts(id, { modelId: `${id}-model` }),
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
      async start(r) {
        started.push(r);
      },
      async record(r) {
        recorded.push(r);
      },
    },
    runsDir: join(sub, 'runs'),
    newRunId: () => {
      ids += 1;
      return `run-${String(ids).padStart(4, '0')}`;
    },
    heartbeatEveryMs: 5,
    ...opts.deps,
  });
  const input = (over: Partial<ColdVerifyInput> = {}): ColdVerifyInput => ({
    schemaVersion: 1,
    taskId: TASK_ID,
    repo: REPO,
    issueNumber: 12,
    prNumber: 42,
    branch: BRANCH,
    baseSha: BASE,
    headSha: HEAD,
    what: '给驾驶舱加状态栏',
    howToFinish: ['驾驶舱顶部有状态栏'],
    authorFamilies: ['claude'],
    round: 1,
    ...over,
  });
  return { run, input, ft, posted, specs, recorded, started, asked };
}

describe('跑通：换了家族、贴了状态', { timeout: 30_000 }, () => {
  it('通过：先贴 pending 再贴 success（都在要验的头上）；会话在会话用户的空目录里起，收场就删；跑记到这张单名下', async () => {
    const r = rig();
    const got = await r.run(r.input(), ctx());
    expect(got).toMatchObject({ pass: true, problems: [], round: 1 });
    expect(got.unavailable).toBeUndefined();
    expect(r.posted.map((p) => [p.sha, p.context, p.state])).toEqual([
      [HEAD, 'cold-verify', 'pending'],
      [HEAD, 'cold-verify', 'success'],
    ]);
    // 作者是 claude：按 0006 顺序问的第一家是 gpt
    expect(r.asked.map((a) => a.avoidFamilies?.includes('gpt'))).toEqual([false]);
    expect(r.asked[0]).toMatchObject({ taskId: TASK_ID, stage: 'review' });
    // 会话：空目录归会话用户、会话在里面起、收场删掉
    expect(r.specs).toHaveLength(1);
    const cwd = r.specs[0]?.cwd ?? '';
    expect(cwd).toContain('verify-run-0001');
    expect(r.ft.adopts).toEqual([
      { dir: cwd, user: USER },
      expect.objectContaining({ user: USER }), // 驱动自己的 TMPDIR
    ]);
    expect(r.ft.removes).toContain(cwd);
    // 提示词里有 diff、要什么、怎么算做完
    expect(r.specs[0]?.prompt).toContain('export const Status = 1;');
    expect(r.specs[0]?.prompt).toContain('给驾驶舱加状态栏');
    expect(r.specs[0]?.prompt).toContain('驾驶舱顶部有状态栏');
    // runs：segment 是 verify，开跑那一行、收场那一笔都记到这张单名下（#216）：tasks.id、单号、任务工作流编号、PR、分支；
    // 验收是冷调用，不带派工档
    const owner = {
      segment: 'verify',
      taskId: TASK_ID,
      issueNumber: 12,
      workflowId: 'task:acme/demo#12',
      prNumber: 42,
      branch: BRANCH,
    };
    expect(r.started).toEqual([expect.objectContaining(owner)]);
    expect(r.recorded).toHaveLength(1);
    expect(r.recorded[0]).toMatchObject({ ...owner, outcome: 'done' });
    expect(r.recorded[0]).not.toHaveProperty('tier');
  });

  it('没过：问题原样带出，贴 failure；不是 unavailable（返工解决得了）', async () => {
    const r = rig({ driverRun: async () => report(MODEL_FAIL) });
    const got = await r.run(r.input(), ctx());
    expect(got.pass).toBe(false);
    expect(got.problems).toEqual(['没做到验收条：单子要状态栏，代码里没有']);
    expect(got.unavailable).toBeUndefined();
    expect(got.retry).toBeUndefined();
    expect(r.posted.at(-1)).toMatchObject({ sha: HEAD, state: 'failure' });
    expect(r.posted.at(-1)?.description).toContain('没做到验收条');
  });

  it('写这张单的族不止一个：全部跳过（先 gpt 后 claude 写的 → 验的是 deepseek）', async () => {
    const r = rig({ picks: { deepseek: okRoute('deepseek') } });
    const got = await r.run(r.input({ authorFamilies: ['gpt', 'claude'] }), ctx());
    expect(got.pass).toBe(true);
    // 第一个被问的就是 deepseek：gpt、claude 压根没问
    expect(r.asked).toHaveLength(1);
    expect(r.asked[0]?.avoidFamilies).not.toContain('deepseek');
    expect(r.asked[0]?.avoidFamilies).toEqual(expect.arrayContaining(['gpt', 'claude', 'grok', 'kimi']));
  });

  it('二进制 / 纯改名的文件（changes 为 0）没有文本 diff：注明一句，不算看不全', async () => {
    const r = rig({
      files: [...FILES, { filename: 'web/logo.png', status: 'added', changes: 0 }],
      picks: { gpt: okRoute('gpt') },
    });
    const got = await r.run(r.input(), ctx());
    expect(got.pass).toBe(true);
    expect(r.specs[0]?.prompt).toContain('web/logo.png');
    expect(r.specs[0]?.prompt).toContain('没有文本改动');
  });
});

describe('【故意造出的失败】做不出来：回 unavailable（工作流停下报人），并且贴 failure', {
  timeout: 30_000,
}, () => {
  it('没有别家的路由（一条能用的都没有）：unavailable 写明没讨论成；一个会话都没起；状态是 failure', async () => {
    const r = rig({ picks: {} });
    const got = await r.run(r.input(), ctx());
    expect(got.pass).toBe(false);
    expect(got.unavailable).toContain('没讨论成');
    expect(got.retry).toBeUndefined();
    expect(r.specs).toHaveLength(0);
    expect(r.posted.map((p) => p.state)).toEqual(['pending', 'failure']);
  });

  it('作者族认不出（cursor）：unavailable，不硬跑——认不出的可能就是某个已知族的别名', async () => {
    const r = rig();
    const got = await r.run(r.input({ authorFamilies: ['cursor'] }), ctx());
    expect(got.unavailable).toContain('作者族认不出');
    expect(r.specs).toHaveLength(0);
    expect(r.asked).toHaveLength(0);
  });

  it('diff 太大：unavailable，不截断了假装看全；状态 failure', async () => {
    const r = rig({
      files: [{ filename: 'big.ts', status: 'modified', patch: 'x'.repeat(5_000), changes: 5000 }],
      deps: { maxDiffChars: 1_000 },
      picks: { gpt: okRoute('gpt') },
    });
    const got = await r.run(r.input(), ctx());
    expect(got.unavailable).toContain('diff 太大');
    expect(r.specs).toHaveLength(0);
    expect(r.posted.at(-1)?.state).toBe('failure');
  });

  it('有文本文件 GitHub 没给 diff（改了很多行却没有 patch）：unavailable，点名是哪个文件', async () => {
    const r = rig({
      files: [{ filename: 'data/huge.json', status: 'modified', changes: 90_000 }],
      picks: { gpt: okRoute('gpt') },
    });
    const got = await r.run(r.input(), ctx());
    expect(got.unavailable).toContain('data/huge.json');
    expect(got.unavailable).toContain('diff GitHub 没给');
  });

  it('PR 已经关了：unavailable；还没读到头，状态贴不了（不假装贴过）', async () => {
    const r = rig({ pull: { state: 'closed' }, picks: { gpt: okRoute('gpt') } });
    const got = await r.run(r.input(), ctx());
    expect(got.unavailable).toContain('已经关闭');
    expect(got.headMoved).toBeUndefined();
    expect(r.posted).toEqual([]);
    expect(r.specs).toHaveLength(0);
  });

  it('会话没跑成（额度用完）：unavailable 带着原因码和原话，不是「没过」；状态 failure', async () => {
    const r = rig({
      picks: { gpt: okRoute('gpt') },
      driverRun: async () =>
        report('', {
          facts: {
            exitCode: 1,
            terminal: { isError: true, detail: '额度用完' },
            quotaExhausted: true,
          } as RunFacts,
          stderrTail: 'quota',
        }),
    });
    const got = await r.run(r.input(), ctx());
    expect(got.pass).toBe(false);
    expect(got.unavailable).toContain('冷调用没跑成');
    expect(got.unavailable).toContain('quota_exhausted');
    expect(got.problems).toEqual([]);
    expect(r.posted.at(-1)?.state).toBe('failure');
    // 会话的空目录照样收了
    expect(r.ft.removes.some((d) => d.includes('verify-run-0001'))).toBe(true);
  });

  it('结论写 fail 却没有一条算挡的问题：unavailable（要人看），不让写代码的会话拿一张空问题表白改一轮', async () => {
    const r = rig({
      picks: { gpt: okRoute('gpt') },
      driverRun: async () => report(['## 问题', '- 命名不好看', '', 'verdict: fail'].join('\n')),
    });
    const got = await r.run(r.input(), ctx());
    expect(got.pass).toBe(false);
    expect(got.problems).toEqual([]);
    expect(got.unavailable).toContain('没有一条以');
  });

  it('路由在库里查不到（配置问题）：unavailable 写明库里没有这条路由；不起会话', async () => {
    const r = rig({ picks: { gpt: okRoute('gpt') }, routeFor: () => null });
    const got = await r.run(r.input(), ctx());
    expect(got.unavailable).toContain('库里没有路由');
    expect(r.specs).toHaveLength(0);
  });
});

describe('过一会儿再来就行：回 retry，贴的是 pending 不是 failure', { timeout: 30_000 }, () => {
  it('选路回「没空位」：retry（slot，用选路给的秒数）；状态是 pending，写明在等什么；没起会话', async () => {
    const r = rig({
      picks: { gpt: { ok: false, waitFor: 'slot', detail: '在等内存：放不下', retryAfterSeconds: 30 } },
    });
    const got = await r.run(r.input(), ctx());
    expect(got.retry).toEqual({
      wait: 'slot',
      reason: expect.stringContaining('在等内存'),
      afterSeconds: 30,
    });
    expect(got.unavailable).toBeUndefined();
    expect(got.pass).toBe(false);
    expect(r.specs).toHaveLength(0);
    expect(r.posted.map((p) => p.state)).toEqual(['pending', 'pending']);
    expect(r.posted.at(-1)?.description).toContain('在等');
  });

  it('只有额度在等（别家都没有路由）：retry 的 wait 是 quota；几家都在等取最短的那个秒数', async () => {
    const r = rig({
      picks: {
        gpt: { ok: false, waitFor: 'quota', detail: '额度要等', retryAfterSeconds: 900 },
        deepseek: { ok: false, waitFor: 'quota', detail: '另一个也要等', retryAfterSeconds: 300 },
      },
    });
    const got = await r.run(r.input(), ctx());
    expect(got.retry).toMatchObject({ wait: 'quota', afterSeconds: 300 });
  });

  it('一家在等、别家一条路由都没有：照样是等（等得来），不是做不出来', async () => {
    const r = rig({
      picks: { gpt: { ok: false, waitFor: 'slot', detail: '没空位', retryAfterSeconds: 45 } },
    });
    const got = await r.run(r.input(), ctx());
    expect(got.retry).toMatchObject({ wait: 'slot', afterSeconds: 45 });
  });

  it('选路没给秒数：用默认的 ROUTE_RETRY_SECONDS', async () => {
    const r = rig({ picks: { gpt: { ok: false, waitFor: 'slot', detail: '没空位' } } });
    const got = await r.run(r.input(), ctx());
    expect(got.retry).toMatchObject({ wait: 'slot', afterSeconds: 60 });
  });

  it('选完路由、起会话前内存又放不下（准入没放行）：retry（slot）；状态 pending；会话没起', async () => {
    const r = rig({
      picks: { gpt: okRoute('gpt') },
      deps: {
        memoryAdmission: {
          readText: async () => String(9500 * 1024 * 1024),
          cgroupRoot: '/sys/fs/cgroup',
          slicePath: 'fleet.slice/fleet-agents.slice',
          sliceHighMb: 10_000,
          reservePerSessionMb: 2048,
        },
      },
    });
    const got = await r.run(r.input(), ctx());
    expect(got.retry).toMatchObject({ wait: 'slot', afterSeconds: 60 });
    expect(got.retry?.reason).toContain('内存放不下');
    expect(r.specs).toHaveLength(0);
    expect(r.posted.map((p) => p.state)).toEqual(['pending', 'pending']);
    expect(r.recorded.map((x) => x.outcome)).toEqual(['admission_blocked']);
  });

  it('切号把这一次验收停下（#59）：retry（slot、切号的秒数），状态 pending 不是 failure；runs 记 org_switch；登记走掉', async () => {
    const sessions = oneShotSessions();
    let resolveStarted: () => void = () => {};
    const started = new Promise<void>((resolve) => {
      resolveStarted = resolve;
    });
    const r = rig({
      picks: { gpt: okRoute('gpt') },
      deps: { sessions },
      driverRun: async (_spec, hooks) => {
        resolveStarted();
        await new Promise<void>((resolve) => {
          (hooks.signal as AbortSignal).addEventListener('abort', () => resolve(), { once: true });
        });
        return report('', {
          facts: { exitCode: null, killed: 'aborted', quotaExhausted: false } as RunFacts,
        });
      },
    });
    const pending = r.run(r.input(), ctx());
    await started;
    // 挑中的路由在 pool-gpt 上：切号看得见这一次验收（编号是开跑时 runs 那一行的编号）
    const live = sessions.live(new Set(['pool-gpt']));
    expect(live).toHaveLength(1);
    expect(sessions.stop(new Set(['pool-gpt']), '切号：拼车切到独享，先停下')).toEqual(live);
    const got = await pending;
    expect(got).toMatchObject({
      pass: false,
      problems: [],
      retry: { wait: 'slot', afterSeconds: VERIFY_ORG_SWITCH_RETRY_SECONDS },
    });
    expect(got.retry?.reason).toContain('切号');
    expect(got.unavailable).toBeUndefined();
    expect(r.posted.map((p) => p.state)).toEqual(['pending', 'pending']);
    expect(r.recorded.map((x) => [x.runId, x.outcome])).toEqual([[live[0], 'org_switch']]);
    expect(sessions.live(new Set(['pool-gpt']))).toEqual([]);
  });

  it('挑完路由、还没起会话（备目录那一下）就被切号停下：不起会话，回 retry；停下时登记的编号就是记成 org_switch 的那一行', async () => {
    const sessions = oneShotSessions();
    let stopped: string[] = [];
    const r = rig({ picks: { gpt: okRoute('gpt') }, deps: { sessions } });
    // 备目录（交给会话用户）那一下切号
    const adopt = r.ft.trees.adopt;
    r.ft.trees.adopt = async (dir, user) => {
      stopped = sessions.stop(new Set(['pool-gpt']), '切号：拼车切到独享，先停下');
      return adopt(dir, user);
    };
    const got = await r.run(r.input(), ctx());
    expect(got.retry).toMatchObject({ wait: 'slot', afterSeconds: VERIFY_ORG_SWITCH_RETRY_SECONDS });
    expect(r.specs).toHaveLength(0);
    expect(stopped).toHaveLength(1);
    expect(r.recorded.map((x) => [x.runId, x.outcome])).toEqual([[stopped[0], 'org_switch']]);
    expect(sessions.live(new Set(['pool-gpt']))).toEqual([]);
  });
});

describe('PR 的头不是要验的那个了', { timeout: 30_000 }, () => {
  it('回 headMoved（现在的头）；不起会话、不贴状态（要验的头已经不是 PR 的头，贴在哪都不对）', async () => {
    const r = rig({ pull: { headSha: 'c'.repeat(40) }, picks: { gpt: okRoute('gpt') } });
    const got = await r.run(r.input(), ctx());
    expect(got.headMoved).toBe('c'.repeat(40));
    expect(got.unavailable).toBeUndefined();
    expect(got.pass).toBe(false);
    expect(r.specs).toHaveLength(0);
    expect(r.posted).toEqual([]);
  });
});

describe('【故意造出的失败】贴不上、读不到、被叫停：抛出去，不当成验过也不当成没过', {
  timeout: 30_000,
}, () => {
  it('开跑前那条 pending 贴不上：抛出去，会话一个没起（别花一次调用再发现结论贴不上）', async () => {
    const r = rig({
      picks: { gpt: okRoute('gpt') },
      setStatusError: () =>
        new PortError('FORBIDDEN', '「引擎」机器人没有 statuses 写权限', { retryable: false }),
    });
    await expect(r.run(r.input(), ctx())).rejects.toMatchObject({ code: 'FORBIDDEN' });
    expect(r.specs).toHaveLength(0);
  });

  it('会话跑完了，结论贴不上：抛出去（闸看不到＝没验过），不回 pass', async () => {
    const r = rig({
      picks: { gpt: okRoute('gpt') },
      setStatusError: (posted) =>
        posted.length >= 1 ? new PortError('GITHUB_DOWN', '502', { retryable: true }) : undefined,
    });
    await expect(r.run(r.input(), ctx())).rejects.toMatchObject({ code: 'GITHUB_DOWN' });
    expect(r.specs).toHaveLength(1); // 会话是跑了的，结论没贴上
  });

  it('GitHub 一时读不到 PR：PortError 往外抛（工作流按失败分流重试），不是 unavailable', async () => {
    const r = rig({ readPullError: new PortError('GITHUB_DOWN', '502', { retryable: true }) });
    await expect(r.run(r.input(), ctx())).rejects.toMatchObject({ code: 'GITHUB_DOWN', retryable: true });
    expect(r.posted).toEqual([]);
  });

  it('GitHub 一时读不到文件列表：同样往外抛', async () => {
    const r = rig({ pullFilesError: new PortError('GITHUB_DOWN', '502', { retryable: true }) });
    await expect(r.run(r.input(), ctx())).rejects.toMatchObject({ code: 'GITHUB_DOWN' });
  });

  it('选路读库读不到（重试有用的 PortError）：往外抛，不当成「没有别家的模型」', async () => {
    const r = rig({
      pickRouteError: new PortError('DB_DOWN', '库连不上', { retryable: true }),
    });
    await expect(r.run(r.input(), ctx())).rejects.toMatchObject({ code: 'DB_DOWN' });
    expect(r.specs).toHaveLength(0);
  });

  it('【故意造出的失败】开跑那一行写不进 runs（库一时不通，#157）：会话没起，PortError VERIFY_RUNS_UNWRITABLE 往外抛（可以重试），不是「验收做不出来」', async () => {
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
    expect(err).toMatchObject({ code: 'VERIFY_RUNS_UNWRITABLE', retryable: true });
    expect((err as Error).message).toContain('connection refused');
    expect(r.specs).toHaveLength(0);
  });

  it('会话用户的空目录交不出去（重试有用）：往外抛', async () => {
    const r = rig({ picks: { gpt: okRoute('gpt') } });
    r.ft.trees.adopt = async () => {
      throw new PortError('ADOPT_FAILED', 'sudo 不让用', { retryable: true });
    };
    await expect(r.run(r.input(), ctx())).rejects.toMatchObject({ code: 'ADOPT_FAILED' });
    expect(r.specs).toHaveLength(0);
  });

  it('叫停（会话在跑时信号触发）：会话被杀，取消原样抛出去，不回「没跑成」', async () => {
    const ac = new AbortController();
    const r = rig({
      picks: { gpt: okRoute('gpt') },
      driverRun: async () => {
        ac.abort(new Error('被叫停了：放弃'));
        return report('', {
          facts: {
            exitCode: null,
            terminal: null,
            quotaExhausted: false,
            killed: 'aborted',
          } as unknown as RunFacts,
        });
      },
    });
    await expect(r.run(r.input(), ctx(ac.signal))).rejects.toThrow('被叫停了：放弃');
  });
});

describe('renderDiff：喂给会话的 diff', () => {
  it('每个文件一段，带 git 风格的头；新增、删除、改名各有各的头；文件名单按原顺序', () => {
    const out = renderDiff([
      { filename: 'a.ts', status: 'modified', patch: '@@ -1 +1 @@\n-1\n+2', changes: 2 },
      { filename: 'b.ts', status: 'added', patch: '@@ -0,0 +1 @@\n+x', changes: 1 },
      { filename: 'c.ts', status: 'removed', patch: '@@ -1 +0,0 @@\n-y', changes: 1 },
      { filename: 'd2.ts', status: 'renamed', previous: 'd1.ts', patch: '@@ -1 +1 @@\n-p\n+q', changes: 2 },
    ]);
    expect(out.changedFiles).toEqual(['a.ts', 'b.ts', 'c.ts', 'd2.ts']);
    expect(out.diffText).toContain('diff --git a/a.ts b/a.ts\n--- a/a.ts\n+++ b/a.ts\n@@ -1 +1 @@');
    expect(out.diffText).toContain('diff --git a/b.ts b/b.ts\n--- /dev/null\n+++ b/b.ts');
    expect(out.diffText).toContain('diff --git a/c.ts b/c.ts\n--- a/c.ts\n+++ /dev/null');
    expect(out.diffText).toContain(
      'diff --git a/d1.ts b/d2.ts\nrename from d1.ts\nrename to d2.ts\n--- a/d1.ts\n+++ b/d2.ts',
    );
  });

  it('【故意造出的失败】没有 patch 又说不清改了多少行（changes 读不到）：当看不全，抛，不当二进制', () => {
    expect(() => renderDiff([{ filename: 'x.bin', status: 'modified' }])).toThrow('diff GitHub 没给');
  });

  it('【故意造出的失败】总长超过上限：抛，写明已经看了几个文件', () => {
    const files: DiffFile[] = [1, 2, 3].map((i) => ({
      filename: `f${i}.ts`,
      status: 'modified',
      patch: 'y'.repeat(400),
      changes: 400,
    }));
    expect(() => renderDiff(files, 1_000)).toThrow(/diff 太大.*3\/3/);
  });
});
