// 任务工作流的冷验收（real/task-verify.ts，#632 S2-5b）：读 PR 和文件（假 GitHub）→ 选路（假选路，按族）→ 一次性会话
// （假驱动，不起真执行体）→ 贴 cold-verify 状态 → 结局整理成工作流要的形状。每条做不出来、要等、被叫停、贴不上的路径故意造一次。
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { RunFacts, SessionUser } from '@fleet-dao/adapters';
import type { RouteLaunchFacts } from '@fleet-dao/db';
import type { PullFacts } from '@fleet-dao/github';
import { hardBanFor } from '@fleet-dao/shared';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createEngineDrain, waitDrained } from '../../src/drain.ts';
import { type PickRouteInput, type PickRouteResult, type PortContext, PortError } from '../../src/ports.ts';
import type { HostDriver, HostReport, HostRunHooks, HostRunSpec, WiredHost } from '../../src/real/hosts.ts';
import { oneShotSessions } from '../../src/real/one-shot-sessions.ts';
import {
  type ColdVerifyActivityDeps,
  createColdVerify,
  type DiffFile,
  fillMissingPatches,
  MAX_FILE_DIFF_LINES,
  mirrorFileDiff,
  renderDiff,
  SUMMARY_LINE_CHARS,
  summarizePatch,
  VERIFY_ORG_SWITCH_RETRY_SECONDS,
} from '../../src/real/task-verify.ts';
import { NoSlotError, type RunRecord, type RunStart } from '../../src/runner/not-wired.ts';
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
  effort: null,
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
    filename: 'src/status.ts',
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

const subjectOf = (route: { modelId: string; family: string }) => ({
  id: route.modelId,
  family: route.family,
  displayName: route.modelId,
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
  /** 每次开跑带给 runs.start 的预占编号（没带是 undefined）。 */
  const startedWith: (string | undefined)[] = [];
  /** 收场时放掉的预占编号。 */
  const released: string[] = [];
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
      const pick = family ? picks[family] : undefined;
      // 真选路的硬禁令（shared 的 hardBanFor，和 routing/filter.ts 同一份）：界面活按 ui 判，GPT 一条路由都派不出
      if (pick?.ok && hardBanFor(subjectOf(pick.route), input.uiWork ? 'ui' : input.stage)) {
        return { ok: false, waitFor: 'none', detail: '犯禁令：GPT 不做 UI 类活' };
      }
      return pick || { ok: false, waitFor: 'none', detail: '没有路由' };
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
  return { run, input, ft, posted, specs, recorded, started, startedWith, released, asked };
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
    expect(r.asked[0]).toMatchObject({ taskId: TASK_ID, stage: 'verify' });
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

  it('写这张单的族不止一个：全部跳过（先 gpt 后 claude 写的 → grok 没路由，验的是 deepseek）', async () => {
    const r = rig({ picks: { deepseek: okRoute('deepseek') } });
    const got = await r.run(r.input({ authorFamilies: ['gpt', 'claude'] }), ctx());
    expect(got.pass).toBe(true);
    // 顺序 gpt、grok、claude、deepseek、kimi：gpt、claude 压根没问，先问 grok（没有）再问 deepseek
    expect(r.asked).toHaveLength(2);
    expect(r.asked[0]?.avoidFamilies).toEqual(expect.arrayContaining(['gpt', 'claude', 'deepseek', 'kimi']));
    expect(r.asked[0]?.avoidFamilies).not.toContain('grok');
    expect(r.asked[1]?.avoidFamilies).not.toContain('deepseek');
    expect(r.asked[1]?.avoidFamilies).toEqual(expect.arrayContaining(['gpt', 'claude', 'grok', 'kimi']));
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

describe('界面活的验收不派 GPT（#1262：GPT 不做界面、不审界面）', { timeout: 30_000 }, () => {
  const UI_FILES: DiffFile[] = [
    { filename: 'packages/web/src/status.tsx', status: 'added', patch: '@@ -0,0 +1 @@\n+x', changes: 1 },
  ];
  const BOTH = { gpt: okRoute('gpt'), grok: okRoute('grok') };

  it('界面单：选路带 uiWork，GPT 排第一也被跳过，往下问 grok，会话派给 grok；notes 不带「没认出」', async () => {
    const r = rig({ files: UI_FILES, picks: BOTH });
    const got = await r.run(r.input(), ctx());
    expect(got.pass).toBe(true);
    expect(r.asked.length).toBeGreaterThan(0);
    expect(r.asked.every((a) => a.uiWork === true)).toBe(true);
    expect(r.asked.map((a) => a.avoidFamilies?.includes('gpt'))).toEqual([false, true]);
    expect(r.started).toEqual([expect.objectContaining({ routeId: 'route-grok' })]);
    expect(got.notes).not.toContain('没认出');
  });

  it('非界面单：不带 uiWork，GPT 照旧排第一、派给 GPT', async () => {
    const r = rig({ files: FILES, picks: BOTH });
    const got = await r.run(r.input(), ctx());
    expect(got.pass).toBe(true);
    expect(r.asked.every((a) => a.uiWork === undefined)).toBe(true);
    expect(r.started).toEqual([expect.objectContaining({ routeId: 'route-gpt' })]);
    expect(got.notes).not.toContain('没认出');
  });

  it('【故意造出的失败】界面单、只有 GPT 有路由：一个模型都派不出，回 retry 过一会儿重来，一个会话都没起（不拿 GPT 顶，#1731）', async () => {
    const r = rig({ files: UI_FILES, picks: { gpt: okRoute('gpt') } });
    const got = await r.run(r.input(), ctx());
    expect(got.unavailable).toBeUndefined();
    expect(got.retry?.reason).toContain('一个模型都派不出');
    expect(r.specs).toHaveLength(0);
    expect(r.started).toHaveLength(0);
  });

  // 文件名读不成（GitHub 不会这样给，但读不成就是认不出）：diff 照样拼得出来，验收照跑，所以走到选路这一步
  const NAMELESS: DiffFile[] = [
    { filename: '', status: 'modified', patch: '@@ -1 +1 @@\n-a\n+b', changes: 2 },
  ];

  it('【故意造出的失败】认不出是不是界面活（有文件名读不成）：按界面活处理、不派 GPT，notes 写明没认出', async () => {
    const r = rig({ files: NAMELESS, picks: BOTH });
    const got = await r.run(r.input(), ctx());
    expect(r.asked.every((a) => a.uiWork === true)).toBe(true);
    expect(r.started).toEqual([expect.objectContaining({ routeId: 'route-grok' })]);
    expect(got.notes).toContain('没认出是不是界面活，按界面活处理');
  });

  it('【故意造出的失败】认不出、又只有 GPT 有路由：不派 GPT，回 retry，结果上也写明没认出（#1731）', async () => {
    const r = rig({ files: NAMELESS, picks: { gpt: okRoute('gpt') } });
    const got = await r.run(r.input(), ctx());
    expect(got.unavailable).toBeUndefined();
    expect(got.retry?.reason).toContain('一个模型都派不出');
    expect(r.specs).toHaveLength(0);
    expect(got.notes).toContain('没认出是不是界面活，按界面活处理');
  });

  it('【故意造出的失败】PR 没有任何改动文件：本来就验不了（unavailable），结果上也写明没认出，不当成「不是界面」', async () => {
    const r = rig({ files: [], picks: BOTH });
    const got = await r.run(r.input(), ctx());
    expect(got.unavailable).toBeDefined();
    expect(r.specs).toHaveLength(0);
    expect(got.notes).toContain('没认出是不是界面活，按界面活处理');
  });
});

describe('【故意造出的失败】做不出来：回 unavailable（工作流停下报人），并且贴 failure', {
  timeout: 30_000,
}, () => {
  it('作者族认不出（cursor）、只派得出一家：不停下，同族兜底验用那一家验，结论照常（#1731）', async () => {
    const r = rig();
    const got = await r.run(r.input({ authorFamilies: ['cursor'] }), ctx());
    expect(got.unavailable).toBeUndefined();
    expect(got.pass).toBe(true);
    expect(got.notes?.startsWith('同族兜底验：')).toBe(true);
    expect(r.recorded.map((row) => row.routeId)).toEqual(['route-gpt']);
    expect(r.asked.length).toBeGreaterThan(0);
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

  it('作者族认不出（cursor）、只有 gpt 能派、grok 在等空位：retry（等空位），这一次一个验收会话都没起；gpt 预占的名额收场放掉（#1697）', async () => {
    const sessions = oneShotSessions();
    const gpt = okRoute('gpt');
    if (!gpt.ok) throw new Error('夹具：okRoute 该是派出去的');
    const r = rig({
      picks: {
        gpt: { ...gpt, route: { ...gpt.route, reservationId: 'res-gpt' } },
        grok: { ok: false, waitFor: 'slot', detail: 'cursor 池并发满了（4/4）', retryAfterSeconds: 25 },
      },
      deps: { sessions },
    });
    const got = await r.run(r.input({ authorFamilies: ['cursor'] }), ctx());
    expect(got.unavailable).toBeUndefined();
    expect(got.retry).toMatchObject({ wait: 'slot', afterSeconds: 25 });
    expect(got.retry?.reason).toContain('grok（cursor 池并发满了（4/4））');
    expect(r.specs).toHaveLength(0);
    expect(r.started).toHaveLength(0);
    expect(r.posted.map((p) => p.state)).toEqual(['pending', 'pending']);
    expect(r.released).toEqual(['res-gpt']);
    expect(sessions.live(new Set(['pool-gpt', 'pool-grok']))).toEqual([]);
  });

  it('两家都验先挑齐两家再起会话：每个会话跑着时，切号登记的是它自己那条路由的池（#1697）', async () => {
    const sessions = oneShotSessions();
    const liveAt: { gpt: number; grok: number }[] = [];
    const r = rig({
      picks: { gpt: okRoute('gpt'), grok: okRoute('grok') },
      deps: { sessions },
      driverRun: async () => {
        liveAt.push({
          gpt: sessions.live(new Set(['pool-gpt'])).length,
          grok: sessions.live(new Set(['pool-grok'])).length,
        });
        return report(MODEL_PASS);
      },
    });
    const got = await r.run(r.input({ authorFamilies: ['cursor'] }), ctx());
    expect(got).toMatchObject({ pass: true });
    expect(r.recorded.map((row) => row.routeId)).toEqual(['route-gpt', 'route-grok']);
    expect(liveAt).toEqual([
      { gpt: 1, grok: 0 },
      { gpt: 0, grok: 1 },
    ]);
    expect(sessions.live(new Set(['pool-gpt', 'pool-grok']))).toEqual([]);
  });

  it('一个模型都派不出（每一族都没有路由、也没有在等的）：判成等待（retry，默认秒数），没有 unavailable；状态 pending、没起会话（#1731）', async () => {
    const r = rig({ picks: {} });
    const got = await r.run(r.input(), ctx());
    expect(got.pass).toBe(false);
    expect(got.unavailable).toBeUndefined();
    expect(got.retry).toEqual({
      wait: 'slot',
      reason: expect.stringContaining('一个模型都派不出'),
      afterSeconds: 60,
    });
    expect(r.specs).toHaveLength(0);
    expect(r.posted.map((p) => p.state)).toEqual(['pending', 'pending']);
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

describe('发布排空看得见验收会话（#957）', { timeout: 30_000 }, () => {
  const abortable = (signal: AbortSignal) =>
    new Promise<void>((resolve) => signal.addEventListener('abort', () => resolve(), { once: true }));

  it('验收会话在跑时，排空报「还有 1 个」（verify 用途、这张单、在跑）；到截止停下它，回 retry、不贴 failure，清单走空', async () => {
    const drain = createEngineDrain();
    const sessions = oneShotSessions({ drain });
    let resolveStarted: () => void = () => {};
    const started = new Promise<void>((resolve) => {
      resolveStarted = resolve;
    });
    const r = rig({
      picks: { gpt: okRoute('gpt') },
      deps: { sessions },
      driverRun: async (_spec, hooks) => {
        resolveStarted();
        await abortable(hooks.signal as AbortSignal);
        return report('', {
          facts: { exitCode: null, killed: 'aborted', quotaExhausted: false } as RunFacts,
        });
      },
    });
    const pending = r.run(r.input(), ctx());
    pending.catch(() => undefined);
    await started;
    expect(drain.inFlight()).toEqual([
      expect.objectContaining({ stage: 'verify', taskId: TASK_ID, phase: 'running' }),
    ]);
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
    const got = await pending;
    expect(got).toMatchObject({ pass: false, problems: [], retry: { wait: 'slot' } });
    expect(got.unavailable).toBeUndefined();
    expect(r.posted.map((p) => p.state)).not.toContain('failure');
    expect(r.recorded.map((x) => x.outcome)).toEqual(['org_switch']);
    expect(drain.inFlight()).toEqual([]);
  });

  it('【故意造出的失败】验收会话抛错：登记一定撤掉，不泄漏成永远排不空', async () => {
    const drain = createEngineDrain();
    const r = rig({
      picks: { gpt: okRoute('gpt') },
      deps: { sessions: oneShotSessions({ drain }) },
      driverRun: async () => {
        throw new Error('驱动炸了');
      },
    });
    await r.run(r.input(), ctx()).catch(() => undefined);
    expect(drain.inFlight()).toEqual([]);
  });
});

describe('按族选路时给这一次验收预占池的名额（#757）', { timeout: 30_000 }, () => {
  /** 选路交回的路由带着预占。 */
  const reservedRoute = (
    family: ModelFamily,
    reservationId: string,
    routeFamily = family,
  ): PickRouteResult => {
    const r = okRoute(family);
    if (!r.ok) throw new Error('夹具：okRoute 该是派出去的');
    return { ...r, route: { ...r.route, family: routeFamily, reservationId } };
  };

  it('选路带上 reserve（验收那一段）；开跑那一行带上预占（在那一下换掉）；收场照样放一次', async () => {
    const r = rig({ picks: { gpt: reservedRoute('gpt', 'res-gpt') } });
    expect(await r.run(r.input(), ctx())).toMatchObject({ pass: true });
    expect(r.asked.map((a) => a.reserve)).toEqual([{ segment: 'verify' }]);
    expect(r.startedWith).toEqual(['res-gpt']);
    expect(r.released).toEqual(['res-gpt']);
  });

  it('选路交回的族对不上、这一次没用上：它预占的名额也放掉；真用上的那一次照常交接', async () => {
    const r = rig({
      picks: {
        gpt: reservedRoute('gpt', 'res-mismatch', 'grok'),
        deepseek: reservedRoute('deepseek', 'res-ds'),
      },
    });
    expect(await r.run(r.input(), ctx())).toMatchObject({ pass: true });
    expect(r.startedWith).toEqual(['res-ds']);
    expect([...r.released].sort()).toEqual(['res-ds', 'res-mismatch']);
  });

  it('【故意造出的失败】开跑时名额已经没了（预占过期、空位给了别的单）：会话没起，PortError VERIFY_NO_SLOT 往外抛（可以重试，不是「验收做不出来」），预占照样放', async () => {
    const r = rig({
      picks: { gpt: reservedRoute('gpt', 'res-gpt') },
      deps: {
        runs: {
          async start() {
            throw new NoSlotError('池 pool-gpt 的名额满了（已经有 3 个，上限 3 个）');
          },
          async record() {
            throw new Error('没开跑，不该收场');
          },
        },
      },
    });
    const err = await r.run(r.input(), ctx()).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(PortError);
    expect(err).toMatchObject({ code: 'VERIFY_NO_SLOT', retryable: true });
    expect(r.specs).toHaveLength(0);
    expect(r.released).toEqual(['res-gpt']);
  });

  it('【故意造出的失败】预占放不掉（库一时不通）：只记日志、写明放不掉，结论照旧（名额到点自己过期）', async () => {
    const logs: string[] = [];
    const r = rig({
      picks: { gpt: reservedRoute('gpt', 'res-gpt') },
      deps: {
        reservations: {
          async release() {
            throw new Error('connection refused');
          },
        },
        log: (message, fields) => logs.push(`${message} ${JSON.stringify(fields)}`),
      },
    });
    expect(await r.run(r.input(), ctx())).toMatchObject({ pass: true });
    expect(logs.filter((l) => l.includes('没放掉'))).toEqual([expect.stringContaining('connection refused')]);
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

/** n 行的假 patch：第 i 行是 `+row-i`，方便断言头尾在、中间不在。 */
const bigPatch = (n: number) =>
  `@@ -0,0 +1,${n} @@\n${Array.from({ length: n }, (_, i) => `+row-${i}`).join('\n')}`;

describe('大文件 GitHub 不给 patch：用 git 补读、超上限给摘要、迁移快照按生成文件（#1308）', {
  timeout: 30_000,
}, () => {
  const HUGE: DiffFile = { filename: 'data/huge.json', status: 'modified', changes: 90_000 };
  const SNAPSHOT = 'packages/db/migrations/meta/0043_snapshot.json';

  it('缺 patch 的大文件走 git 补：补读拿到基线、头、分支、路径；补来的 diff 进提示词；验收照跑', async () => {
    const calls: unknown[] = [];
    const r = rig({
      files: [...FILES, HUGE],
      deps: {
        fileDiff: async (input) => {
          calls.push(input);
          return '@@ -1 +1 @@\n-old-line\n+new-line';
        },
      },
    });
    const got = await r.run(r.input(), ctx());
    expect(got.pass).toBe(true);
    expect(calls).toEqual([
      expect.objectContaining({
        baseSha: BASE,
        headSha: HEAD,
        branch: BRANCH,
        paths: ['data/huge.json'],
        repo: { owner: 'acme', name: 'demo' },
      }),
    ]);
    const prompt = r.specs[0]?.prompt ?? '';
    expect(prompt).toContain('diff --git a/data/huge.json b/data/huge.json');
    expect(prompt).toContain('+new-line');
    expect(prompt).not.toContain('只给了摘要：diff 共');
  });

  it('改名的文件补读时前后两个路径都给', async () => {
    const seen: string[][] = [];
    const out = await fillMissingPatches(
      [{ filename: 'new/name.json', previous: 'old/name.json', status: 'renamed', changes: 5_000 }],
      async (paths) => {
        seen.push(paths);
        return '@@ -1 +1 @@\n-a\n+b';
      },
    );
    expect(seen).toEqual([['old/name.json', 'new/name.json']]);
    expect(out[0]?.patch).toBe('@@ -1 +1 @@\n-a\n+b');
  });

  it('补出来超过上限：提示词里只有摘要（行数、头尾各几十行、中间不在），并明说「这个文件太大，只给了摘要」', async () => {
    const r = rig({
      files: [HUGE],
      deps: { fileDiff: async () => bigPatch(MAX_FILE_DIFF_LINES + 500) },
    });
    const got = await r.run(r.input(), ctx());
    expect(got.pass).toBe(true);
    const prompt = r.specs[0]?.prompt ?? '';
    expect(prompt).toContain(`这个文件太大，只给了摘要：diff 共 ${MAX_FILE_DIFF_LINES + 501} 行`);
    expect(prompt).toContain('+row-0\n');
    expect(prompt).toContain(`+row-${MAX_FILE_DIFF_LINES + 499}`);
    expect(prompt).not.toContain('+row-1000\n');
    expect(prompt).toContain('省略');
    // 摘要有上限：提示词远小于整个 patch
    expect(prompt.length).toBeLessThan(20_000);
  });

  it('恰好在上限内：原样给，不做摘要', async () => {
    const out = await fillMissingPatches([HUGE], async () => bigPatch(MAX_FILE_DIFF_LINES - 1));
    expect(out[0]?.patch).toContain('+row-1000\n');
    expect(out[0]?.patch).not.toContain('只给了摘要');
  });

  it('summarizePatch：行数、加删统计、超长行被截', () => {
    const text = summarizePatch(`@@ -1 +1 @@\n-gone\n+${'z'.repeat(1_000)}\n${bigPatch(300)}`);
    expect(text).toContain('这个文件太大，只给了摘要');
    expect(text).toMatch(/共 \d+ 行，其中加 301 行、删 1 行/);
    expect(text).not.toContain('z'.repeat(SUMMARY_LINE_CHARS + 1));
  });

  it('迁移快照按生成文件处理：不逐行给（有 patch 也不给）、不去补读；写明同一 PR 里配套的迁移 sql、_journal、schema', async () => {
    let called = 0;
    const r = rig({
      files: [
        ...FILES,
        { filename: SNAPSHOT, status: 'added', changes: 6_103 },
        {
          filename: 'packages/db/migrations/0043_lowly_stark.sql',
          status: 'added',
          patch: '@@ -0,0 +1 @@\n+x',
          changes: 1,
        },
        {
          filename: 'packages/db/migrations/meta/_journal.json',
          status: 'modified',
          patch: '@@ -1 +1 @@\n-a\n+b',
          changes: 2,
        },
        {
          filename: 'packages/db/src/schema/routing.ts',
          status: 'modified',
          patch: '@@ -1 +1 @@\n-a\n+b',
          changes: 2,
        },
      ],
      deps: {
        fileDiff: async () => {
          called += 1;
          return '@@ -1 +1 @@\n-a\n+b';
        },
      },
    });
    const got = await r.run(r.input(), ctx());
    expect(got.pass).toBe(true);
    expect(called).toBe(0);
    const prompt = r.specs[0]?.prompt ?? '';
    expect(prompt).toContain('（生成文件：迁移工具生成的快照');
    expect(prompt).toContain('改了 6103 行');
    expect(prompt).toContain('编号 0043 的迁移 sql packages/db/migrations/0043_lowly_stark.sql');
    expect(prompt).toContain('_journal.json 改了');
    expect(prompt).toContain('packages/db/src/schema/routing.ts');
  });

  it('快照带着 GitHub 给的 patch 也按生成文件处理：patch 内容不进提示词；配套的东西不在就明说对不上', () => {
    const out = renderDiff([
      {
        filename: SNAPSHOT,
        status: 'modified',
        patch: '@@ -1 +1 @@\n-snapshot-old\n+snapshot-new',
        changes: 2,
      },
    ]);
    expect(out.diffText).not.toContain('snapshot-new');
    expect(out.diffText).toContain('编号 0043 的迁移 sql 没有（对不上，要查）');
    expect(out.diffText).toContain('_journal.json 没改（对不上，要查）');
    expect(out.diffText).toContain('schema（packages/db/src/schema/）改动 没有（对不上，要查）');
    expect(out.changedFiles).toEqual([SNAPSHOT]);
  });

  it('【故意造出的失败】GitHub 没给、git 补读也读不到：unavailable，点名文件和哪一步没成；不起会话、状态 failure，不当通过', async () => {
    const r = rig({
      files: [...FILES, HUGE],
      deps: {
        fileDiff: async () => {
          throw new Error('镜像里没有基线提交');
        },
      },
    });
    const got = await r.run(r.input(), ctx());
    expect(got.pass).toBe(false);
    expect(got.unavailable).toContain('data/huge.json');
    expect(got.unavailable).toContain('diff GitHub 没给');
    expect(got.unavailable).toContain('git 补读也失败');
    expect(got.unavailable).toContain('镜像里没有基线提交');
    expect(r.specs).toHaveLength(0);
    expect(r.posted.at(-1)?.state).toBe('failure');
  });

  it('【故意造出的失败】git 补读回来是空的（和 GitHub 说的改动对不上）：同样 unavailable，不当通过', async () => {
    const r = rig({ files: [HUGE], deps: { fileDiff: async () => '' } });
    const got = await r.run(r.input(), ctx());
    expect(got.pass).toBe(false);
    expect(got.unavailable).toContain('data/huge.json');
    expect(got.unavailable).toContain('补读回来的是空的');
    expect(r.specs).toHaveLength(0);
  });

  it('【故意造出的失败】补读出来的摘要加上别的文件仍超总上限：照旧 diff 太大', async () => {
    const r = rig({
      files: [HUGE],
      deps: { fileDiff: async () => bigPatch(MAX_FILE_DIFF_LINES + 10), maxDiffChars: 500 },
    });
    const got = await r.run(r.input(), ctx());
    expect(got.unavailable).toContain('diff 太大');
  });
});

describe('mirrorFileDiff：生产的补读', () => {
  it('先抓主线和分支头进镜像，再读 基线...头 的 diff；顺序对', async () => {
    const order: string[] = [];
    const read = mirrorFileDiff({
      fetchMainline: async () => {
        order.push('main');
        return { head: BASE, defaultBranch: 'main' };
      },
      fetchBranchHead: async () => {
        order.push('branch');
        return { head: HEAD };
      },
      readFileDiff: async (input) => {
        order.push(
          `diff:${input.baseSha.slice(0, 1)}...${input.headSha.slice(0, 1)}:${input.paths.join(',')}`,
        );
        return { patch: '@@ -1 +1 @@\n-a\n+b' };
      },
    });
    const patch = await read({
      repo: { owner: 'acme', name: 'demo' },
      branch: BRANCH,
      baseSha: BASE,
      headSha: HEAD,
      paths: ['x.json'],
      signal: new AbortController().signal,
    });
    expect(patch).toBe('@@ -1 +1 @@\n-a\n+b');
    expect(order).toEqual(['main', 'branch', 'diff:b...a:x.json']);
  });
});

/** 会话退出 1，终帧和 stderr 都是这句。令牌样字符串要能被脱敏认出来。 */
const TOKEN_LIKE = 'sk-fakefakefake1';

function crashed(detail: string, stderrTail = detail): HostReport {
  return report('', {
    facts: {
      exitCode: 1,
      terminal: { isError: true, detail },
      quotaExhausted: false,
    } as RunFacts,
    stderrTail,
  });
}

describe('验收会话撞上游临时故障：等一会儿再验，认不出就换下一条路由', { timeout: 30_000 }, () => {
  it('503 容量满 → retry，不停下，只起了这一条路由', async () => {
    const r = rig({
      picks: { gpt: okRoute('gpt'), grok: okRoute('grok') },
      driverRun: async () => crashed('gpt-6.1-sol 当前容量已满（503 Service Unavailable）'),
    });
    const got = await r.run(r.input(), ctx());
    expect(got.pass).toBe(false);
    expect(got.unavailable).toBeUndefined();
    expect(got.retry?.afterSeconds).toBeGreaterThan(0);
    expect(got.retry?.reason).toMatch(/容量已满|路由繁忙/);
    expect(r.specs).toHaveLength(1);
    expect(r.posted.map((p) => p.state)).toEqual(['pending', 'pending']);
    expect(r.recorded[0]?.failureReason).toContain('当前容量已满');
  });

  it('429 限流 → retry，不停下', async () => {
    const r = rig({
      picks: { gpt: okRoute('gpt'), grok: okRoute('grok') },
      driverRun: async () => crashed('429 Too Many Requests'),
    });
    const got = await r.run(r.input(), ctx());
    expect(got.unavailable).toBeUndefined();
    expect(got.retry?.reason).toMatch(/限流/);
    expect(got.retry?.afterSeconds).toBeGreaterThan(0);
    expect(r.specs).toHaveLength(1);
  });

  it('连接被重置 → retry，不停下', async () => {
    const r = rig({
      driverRun: async () => crashed('上游把连接被重置了'),
    });
    const got = await r.run(r.input(), ctx());
    expect(got.unavailable).toBeUndefined();
    expect(got.retry?.reason).toMatch(/网络不通|连接被重置/);
    expect(r.specs).toHaveLength(1);
  });

  it('流中断（stream disconnected before completion）→ retry，不停下', async () => {
    const r = rig({
      driverRun: async () => crashed('stream disconnected before completion: error sending request'),
    });
    const got = await r.run(r.input(), ctx());
    expect(got.unavailable).toBeUndefined();
    expect(got.retry?.afterSeconds).toBeGreaterThan(0);
    expect(r.specs).toHaveLength(1);
  });

  it('此刻派不出（几家里有的没空位、有的一条路由都没有）→ retry 等一会儿，不是 unavailable，没起会话', async () => {
    const r = rig({
      picks: {
        gpt: { ok: false, waitFor: 'slot', detail: 'cursor 池并发满了（4/4）', retryAfterSeconds: 20 },
        claude: { ok: false, waitFor: 'none', detail: '没有路由' },
        deepseek: { ok: false, waitFor: 'slot', detail: 'cursor 池并发满了（4/4）' },
      },
    });
    const got = await r.run(r.input(), ctx());
    expect(got.unavailable).toBeUndefined();
    expect(got.retry).toMatchObject({ wait: 'slot', afterSeconds: 20 });
    expect(got.retry?.reason).toContain('cursor 池并发满了');
    expect(r.specs).toHaveLength(0);
    expect(r.posted.map((p) => p.state)).toEqual(['pending', 'pending']);
  });

  it('认不出的失败 → 换下一条家族不同于作者的路由，验成', async () => {
    const r = rig({
      picks: { gpt: okRoute('gpt'), grok: okRoute('grok') },
      driverRun: async (_spec, _hooks, n) => (n === 1 ? crashed('xyzzy-no-rule-match') : report(MODEL_PASS)),
    });
    const got = await r.run(r.input(), ctx());
    expect(got).toMatchObject({ pass: true, problems: [] });
    expect(got.unavailable).toBeUndefined();
    expect(got.retry).toBeUndefined();
    expect(r.recorded.map((row) => row.routeId)).toEqual(['route-gpt', 'route-grok']);
    expect(r.recorded.map((row) => row.routeId)).not.toContain('route-claude');
    expect(r.posted.at(-1)?.state).toBe('success');
  });

  it('所有路由都失败 → 停下，说明列出每条路由和报错尾巴，不含令牌', async () => {
    const r = rig({
      picks: { gpt: okRoute('gpt'), grok: okRoute('grok') },
      driverRun: async (_spec, _hooks, n) =>
        crashed(`xyzzy-no-rule-match-${n === 1 ? 'gpt' : 'grok'} ${TOKEN_LIKE}`),
    });
    const got = await r.run(r.input(), ctx());
    expect(got.pass).toBe(false);
    expect(got.retry).toBeUndefined();
    expect(got.unavailable).toContain('route-gpt');
    expect(got.unavailable).toContain('route-grok');
    expect(got.unavailable).toContain('xyzzy-no-rule-match-gpt');
    expect(got.unavailable).toContain('xyzzy-no-rule-match-grok');
    expect(got.unavailable).not.toContain(TOKEN_LIKE);
    expect(got.unavailable).toContain('<密钥>');
    expect(r.recorded.map((row) => row.routeId)).toEqual(['route-gpt', 'route-grok']);
  });

  it('failure_reason 带报错尾巴（脱敏后最多 600 字），不含令牌样字符串', async () => {
    const padding = Array.from({ length: 120 }, (_, i) => `pad${i}`).join(' ');
    const detail = `${padding} 当前容量已满（503 Service Unavailable） ${TOKEN_LIKE}`;
    const r = rig({ driverRun: async () => crashed(detail) });
    const got = await r.run(r.input(), ctx());
    expect(got.retry).toBeDefined();
    const reason = r.recorded[0]?.failureReason ?? '';
    expect(reason.startsWith('exit=1 killed=false；')).toBe(true);
    const tail = reason.slice('exit=1 killed=false；'.length);
    expect(tail.length).toBeGreaterThan(0);
    expect(tail.length).toBeLessThanOrEqual(600);
    expect(reason).toContain('当前容量已满');
    expect(reason).not.toContain(TOKEN_LIKE);
    expect(reason).not.toContain('pad0');
    expect(reason).toContain('<密钥>');
  });

  it('【故意造出的失败】容量满被判成 unavailable 时这条该红：应是 retry、不停下', async () => {
    const r = rig({
      picks: { gpt: okRoute('gpt'), grok: okRoute('grok') },
      driverRun: async () => crashed('gpt-6.1-sol 当前容量已满（503 Service Unavailable）'),
    });
    const got = await r.run(r.input(), ctx());
    expect(got.unavailable).toBeUndefined();
    expect(got.retry).toBeDefined();
  });
});
