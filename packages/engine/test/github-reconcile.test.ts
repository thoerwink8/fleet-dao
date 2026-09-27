// 定时对账补漏（#43）：Temporal 定时任务 → 工作流 → 活动 → 后端的 reconcileGitHub（真 Store、真 GitHubIntake、@fleet-dao/github
// 的真轮询，对着照 GitHub 接口回话的假服务）→ 结局记进 schedule_runs。库是 PGlite 上跑真迁移。
// 没跑成、没查成、认不出，都要记成明确的结局（failed / unscanned / partial），不记成 ok。
import { generateKeyPairSync, randomUUID } from 'node:crypto';
import { type RequirementStart, type RequirementWorkflows, WorkflowUnavailableError } from '@fleet-dao/api';
import type { Source } from '@fleet-dao/core';
import {
  asks,
  githubEvents,
  notifications,
  repos,
  scheduleHealth,
  scheduleRuns,
  tasks,
  users,
} from '@fleet-dao/db';
import { createTestDb, resetTestDb, TEST_DB_TIMEOUT_MS, type TestDb } from '@fleet-dao/db/testing';
import { type AppCredentials, createGitHub, pgLedger } from '@fleet-dao/github';
import { requirementWorkflowId } from '@fleet-dao/shared';
import { type Client, ScheduleAlreadyRunning, WorkflowFailedError } from '@temporalio/client';
import { ApplicationFailure } from '@temporalio/common';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import type { EngineJobs } from '../src/activities.ts';
import { type GitHubReconcileRun, WORKFLOW_TYPES } from '../src/contract.ts';
import { createFakeWorld } from '../src/fakes.ts';
import {
  GITHUB_RECONCILE_JOB,
  GITHUB_RECONCILE_LOOKBACK_MS,
  type GitHubReconcileJobDeps,
  runGitHubReconcileJob,
  toScheduleResult,
  withFlowSync,
} from '../src/jobs/github-reconcile.ts';
import {
  CANARY_SCHEDULE_ID,
  engineSchedules,
  ensureEngineSchedules,
  GITHUB_RECONCILE_SCHEDULE_ID,
  HOURLY_RECONCILE_SCHEDULE_ID,
  ROUTE_PROBE_SCHEDULE_ID,
} from '../src/jobs/schedules.ts';
import { githubReconcileJob } from '../src/real/github-reconcile.ts';
import { ENGINE_JOBS, registerEngineJobs } from '../src/real/jobs.ts';
import { createRealEnv, useEnv, withWorker } from './helpers.ts';

const API = 'https://api.github.test';
const OWNER = 'example';
const NAME = 'canary';
const SLUG = `${OWNER}/${NAME}`;
const founder = { login: 'founder-a', id: 1001, type: 'User' };
const at = (minutes: number) =>
  new Date(Date.now() + minutes * 60_000).toISOString().replace(/\.\d{3}Z$/, 'Z');

let keys: Record<'agent' | 'engine', AppCredentials['privateKey']> | undefined;
function apps(): Record<'agent' | 'engine', AppCredentials> {
  keys ??= {
    agent: generateKeyPairSync('rsa', { modulusLength: 2048 }).privateKey,
    engine: generateKeyPairSync('rsa', { modulusLength: 2048 }).privateKey,
  };
  return {
    agent: { role: 'agent', appId: 101, slug: 'fleet-test-agent', privateKey: keys.agent, source: 'test' },
    engine: {
      role: 'engine',
      appId: 202,
      slug: 'fleet-test-engine',
      privateKey: keys.engine,
      source: 'test',
    },
  };
}

/** 仓里的版本（GitHub 上的里程碑）：v1 是当前版本。 */
const V1 = { number: 8, title: 'v1 Fusion 接活' };
const V2 = { number: 9, title: 'v2 引擎打磨' };

interface GitHubState {
  issues: unknown[];
  /** 仓里还开着的里程碑；不给就是只有 v1。 */
  milestones?: { number: number; title: string }[];
  /** 设了就所有接口都这样回（读不到 GitHub）。 */
  down?: number;
  /** 默认分支头上的 .fleet/flow.json：给了是正文，不给（undefined）是没有这个文件。 */
  flowFile?: string;
  /** 设了就只有读 .fleet/flow.json 这样回（读流程配置没查成）。 */
  flowDown?: number;
  /** 默认分支头的提交。 */
  head?: string;
  /** 设了就只有开单（POST issues）这样回（#259：开单的端口没成）。 */
  createDown?: number;
  /** 单子上的评论（按单号）：引擎留的回答在这里。 */
  comments?: Map<
    number,
    { id: number; body: string; user: typeof engineBot; updated_at: string; html_url: string }[]
  >;
}

const HEAD_A = 'a'.repeat(40);
/** 「引擎」机器人（apps() 里 slug 是 fleet-test-engine）：它开的单、留的评论作者是它。 */
const engineBot = { login: 'fleet-test-engine[bot]', id: 202_000, type: 'Bot' };

/**
 * 只答对账会问的几条：安装、令牌、仓（默认分支）、默认分支头、.fleet/flow.json、issue 列表、单张 issue、还开着的里程碑、
 * 评论列表、PR 列表、投递日志。since 照 GitHub 的规矩过滤。
 */
function githubApi(state: GitHubState): typeof fetch {
  return async (input, init) => {
    const url = new URL(typeof input === 'string' ? input : input instanceof URL ? input.href : input.url);
    const reply = (status: number, body: unknown) =>
      new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
    if (state.down) return reply(state.down, { message: 'Server Error' });
    if (url.pathname.endsWith('/installation')) return reply(200, { id: 1 });
    if (url.pathname.endsWith('/access_tokens')) {
      return reply(201, {
        token: 'test-installation-token',
        expires_at: '2099-01-01T00:00:00Z',
        permissions: {},
      });
    }
    const since = url.searchParams.get('since');
    const fresh = (x: unknown) =>
      !since ||
      typeof x !== 'object' ||
      x === null ||
      String((x as { updated_at?: unknown }).updated_at) >= since;
    const base = `/repos/${SLUG}`;
    if (url.pathname === base) return reply(200, { default_branch: 'main', full_name: SLUG, private: false });
    if (url.pathname === `${base}/git/ref/heads/main`) {
      return reply(200, { ref: 'refs/heads/main', object: { sha: state.head ?? HEAD_A, type: 'commit' } });
    }
    if (url.pathname === `${base}/contents/.fleet/flow.json`) {
      if (state.flowDown) return reply(state.flowDown, { message: 'Server Error' });
      if (url.searchParams.get('ref') !== (state.head ?? HEAD_A))
        return reply(400, { message: '读的不是分支头' });
      if (state.flowFile === undefined) return reply(404, { message: 'Not Found' });
      return reply(200, {
        type: 'file',
        encoding: 'base64',
        path: '.fleet/flow.json',
        content: Buffer.from(state.flowFile, 'utf8').toString('base64'),
      });
    }
    // 开单（#259 对账给提问另开单）：「引擎」机器人开，编号接着排，标签、里程碑照请求挂上
    if (url.pathname === `${base}/issues` && init?.method === 'POST') {
      if (state.createDown) return reply(state.createDown, { message: 'Server Error' });
      const req = JSON.parse(String(init.body)) as {
        title: string;
        body: string;
        labels?: string[];
        milestone?: number;
      };
      const number = Math.max(0, ...state.issues.map((i) => (i as { number?: number }).number ?? 0)) + 1;
      const now = new Date().toISOString().replace(/\.\d{3}Z$/, 'Z');
      const created = {
        number,
        node_id: `I_${number}`,
        html_url: `https://github.test/${SLUG}/issues/${number}`,
        title: req.title,
        body: req.body,
        state: 'open',
        user: engineBot,
        created_at: now,
        updated_at: now,
        labels: req.labels ?? [],
        milestone: [V1, V2].find((m) => m.number === req.milestone) ?? null,
      };
      state.issues.push(created);
      return reply(201, created);
    }
    if (url.pathname === `${base}/issues`) {
      const open = url.searchParams.get('state') === 'open';
      return reply(
        200,
        state.issues.filter((i) => (open ? (i as { state?: unknown }).state === 'open' : fresh(i))),
      );
    }
    const single = new RegExp(`^${base}/issues/(\\d+)(/comments)?$`).exec(url.pathname);
    if (single) {
      const n = Number(single[1]);
      const found = state.issues.find((i) => (i as { number?: number }).number === n);
      if (!found) return reply(404, { message: 'Not Found' });
      if (!single[2]) return reply(200, found);
      state.comments ??= new Map();
      const list = state.comments.get(n) ?? [];
      if (init?.method === 'POST') {
        const id = 7000 + list.length;
        const comment = {
          id,
          body: (JSON.parse(String(init.body)) as { body: string }).body,
          user: engineBot,
          updated_at: new Date().toISOString().replace(/\.\d{3}Z$/, 'Z'),
          html_url: `https://github.test/${SLUG}/issues/${n}#issuecomment-${id}`,
        };
        state.comments.set(n, [...list, comment]);
        return reply(201, comment);
      }
      return reply(200, list);
    }
    // 拉起前一次 GraphQL 现读这张单挂在哪个里程碑、是不是母单子单、仓里还开着哪些里程碑（接活只派当前版本的独立单）
    if (url.pathname === '/graphql' && init?.method === 'POST') {
      const { variables } = JSON.parse(String(init.body)) as { variables: { number: number } };
      const found = state.issues.find((i) => (i as { number?: unknown }).number === variables.number) as
        | (ReturnType<typeof issue> & { labels?: string[]; parent?: number; subIssues?: number })
        | undefined;
      const open = state.milestones ?? [V1];
      const milestones = { totalCount: open.length, nodes: open };
      if (!found) {
        return reply(200, {
          data: { repository: { issueOrPullRequest: null, milestones } },
          errors: [
            {
              type: 'NOT_FOUND',
              message: `Could not resolve to an issue with the number of ${variables.number}.`,
            },
          ],
        });
      }
      const labels = found.labels ?? [];
      return reply(200, {
        data: {
          repository: {
            issueOrPullRequest: {
              __typename: 'Issue',
              state: found.state.toUpperCase(),
              stateReason: null,
              author: { login: found.user.login },
              milestone: found.milestone,
              labels: { totalCount: labels.length, nodes: labels.map((name) => ({ name })) },
              parent: found.parent ? { number: found.parent } : null,
              subIssuesSummary: { total: found.subIssues ?? 0 },
            },
            milestones,
          },
        },
      });
    }
    // 补收认回声：自家机器人写出来的那一版（开的单）按它的账号当 sender，账号编号现查一次
    if (url.pathname === `/users/${encodeURIComponent(engineBot.login)}`) return reply(200, engineBot);
    if (url.pathname === `${base}/issues/comments`) return reply(200, []);
    if (url.pathname === `${base}/pulls`) return reply(200, []);
    if (url.pathname === '/app/hook/deliveries') return reply(200, []);
    return reply(404, { message: `假 GitHub 里没有 ${init?.method ?? 'GET'} ${url.pathname}` });
  };
}

/** 默认挂在当前版本 v1 上。 */
function issue(number: number, minutes: number, milestone: { number: number; title: string } | null = V1) {
  return {
    number,
    node_id: `I_${number}`,
    html_url: `https://github.test/${SLUG}/issues/${number}`,
    title: `需求 ${number}`,
    body: `第 ${number} 张的原话`,
    state: 'open',
    user: founder,
    created_at: at(minutes),
    updated_at: at(minutes),
    milestone,
  };
}

/** 记下拉起了哪些需求工作流；同一张已经在跑的回 already_running（和真 Temporal 一样按工作流编号去重）。 */
function fakeRequirements(): { starts: RequirementStart[]; requirements: RequirementWorkflows } {
  const starts: RequirementStart[] = [];
  return {
    starts,
    requirements: {
      async start(input) {
        if (starts.some((s) => s.repo.id === input.repo.id && s.issueNumber === input.issueNumber)) {
          return 'already_running';
        }
        starts.push(input);
        return 'started';
      },
    },
  };
}

const quiet = { info() {}, warn() {}, error() {} };

let t: TestDb;
beforeAll(async () => {
  t = await createTestDb();
}, TEST_DB_TIMEOUT_MS);
afterAll(() => t.close());
beforeEach(async () => {
  await resetTestDb(t);
});

/** 受管的仓（自动派活开关一小时前打开）、白名单里的创始人、登记好的定时任务，加一个照 GitHub 回话的假服务。 */
async function wiring(
  state: GitHubState,
  /** requirements：'real' = 真的经 Temporal 起工作流（后端的 createTemporalRequirementWorkflows，起 Fusion）；不给就是只记下的假的。 */
  options: {
    requirements?: RequirementWorkflows | 'real';
    register?: boolean;
    /** 换掉全组织默认（不给就读代码里带的 packages/core/flow.default.json）。 */
    orgDefault?: () => Promise<Source>;
  } = {},
) {
  const [repo] = await t.db
    .insert(repos)
    .values({
      owner: OWNER,
      name: NAME,
      testCommand: 'pnpm check',
      autoDispatchSince: new Date(Date.now() - 3_600_000),
    })
    .returning();
  await t.db
    .insert(users)
    .values({ displayName: '创始人 A', role: 'founder', githubLogin: founder.login, githubId: founder.id });
  if (options.register !== false) await registerEngineJobs(t.db);
  const gh = createGitHub({
    ledger: pgLedger(t.db),
    apps: apps(),
    apiUrl: API,
    fetch: githubApi(state),
    sleep: async () => {},
    env: {},
    // 往公开的单子上写（#259 对账开单、写回答）之前过卫生检查：给一份测试名单
    sensitiveValues: () => ({ ok: true, source: '测试名单', values: ['fake-org-778899'] }),
  });
  const fake = fakeRequirements();
  const job = githubReconcileJob({
    db: t.db,
    gh,
    ...(options.requirements === 'real' ? {} : { requirements: options.requirements ?? fake.requirements }),
    ...(options.orgDefault ? { orgDefault: options.orgDefault } : {}),
    log: quiet,
  });
  return { repoId: repo?.id ?? '', starts: fake.starts, job };
}

const runsOf = async () =>
  (await t.db.select().from(scheduleRuns))
    .filter((r) => r.job === GITHUB_RECONCILE_JOB.id)
    .sort((a, b) => a.id - b.id);
const healthOf = async () => (await scheduleHealth(t.db)).find((h) => h.job.id === GITHUB_RECONCILE_JOB.id);

// 起工人、真起需求工作流，整包一起跑时一条用例能到 6–7 秒，超过默认的 5 秒（和「你好」工作流的用例同一个上限）。
describe('对账补漏的工作流（真 Temporal 测试服务端）', { timeout: 60_000 }, () => {
  const env = useEnv();

  async function runOnce(jobs: EngineJobs | undefined): Promise<GitHubReconcileRun> {
    return withWorker(
      env(),
      createFakeWorld(),
      (taskQueue) =>
        env().client.workflow.execute(WORKFLOW_TYPES.githubReconcile, {
          taskQueue,
          workflowId: `github-reconcile-${randomUUID()}`,
          args: [{ schemaVersion: 1 }],
        }),
      jobs ? { jobs } : {},
    );
  }

  /** 这一轮在 Temporal 里是怎么失败的：拿到活动报的错误码和原话。 */
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

  it('库里缺一条 issue：跑一轮补上任务行、经 Temporal 真起工作流（和 webhook 那条一样起 Fusion），记一行 ok；再跑一轮不重复建、不重复起', async () => {
    const w = await wiring({ issues: [issue(41, -20)] }, { requirements: 'real' });
    const jobs = { githubReconcile: w.job };
    const requirement = () =>
      env()
        .client.workflow.getHandle(requirementWorkflowId({ owner: OWNER, name: NAME }, 41))
        .describe();

    const first = await runOnce(jobs);
    expect(first).toMatchObject({ outcome: 'ok', scanned: 1, found: 1 });
    const rows = (await t.db.select().from(tasks)).filter((r) => r.repoId === w.repoId);
    expect(rows.map((r) => [r.issueNumber, r.title])).toEqual([[41, '需求 41']]);
    const started = await requirement();
    // 对账补漏（引擎这边重放投递）和 webhook（后端）用同一份拉起实现：起的一定是同一种，不会一边起 Fusion 一边起旧的
    expect(started.type).toBe(WORKFLOW_TYPES.fusion);

    const second = await runOnce(jobs);
    expect(second).toMatchObject({ outcome: 'ok', scanned: 1, found: 0 });
    expect((await t.db.select().from(tasks)).filter((r) => r.repoId === w.repoId)).toHaveLength(1);
    // 同一个编号只有那一次执行：第二轮没再起
    expect((await requirement()).runId).toBe(started.runId);

    const runs = await runsOf();
    expect(runs.map((r) => [r.id, r.outcome, r.scanned, r.found])).toEqual([
      [first.runId, 'ok', 1, 1],
      [second.runId, 'ok', 1, 0],
    ]);
    expect((await healthOf())?.status).toBe('ok');
  });

  it('读不到 GitHub：这一轮记成 unscanned（不是 ok），定时任务页标「没扫到」，不建任务', async () => {
    const w = await wiring({ issues: [issue(41, -20)], down: 500 });
    const run = await runOnce({ githubReconcile: w.job });
    expect(run.outcome).toBe('unscanned');
    expect(run.why).toBeTruthy();
    const [row] = await runsOf();
    expect(row).toMatchObject({ outcome: 'unscanned', scanned: 0 });
    expect(row?.why).toBeTruthy();
    expect((await healthOf())?.status).toBe('no-samples');
    expect(await t.db.select().from(tasks)).toHaveLength(0);
  });

  it('GitHub 回的 issue 列表认不出：这一轮不记 ok，原因写进 schedule_runs', async () => {
    const w = await wiring({ issues: [{ numero: 41, titulo: '认不出的形状' }] });
    const run = await runOnce({ githubReconcile: w.job });
    expect(run.outcome).not.toBe('ok');
    const [row] = await runsOf();
    expect(row?.outcome).toBe(run.outcome);
    expect(row?.why).toMatch(/poll/);
    expect(await t.db.select().from(tasks)).toHaveLength(0);
  });

  it('拉起工作流时 Temporal 连不上：这一轮不记 ok（投递记成出错，等下一轮重放），不装作拉起了', async () => {
    const unreachable: RequirementWorkflows = {
      async start() {
        throw new WorkflowUnavailableError('拉起工作流：Temporal 连不上或没回应');
      },
    };
    const w = await wiring({ issues: [issue(41, -20)] }, { requirements: unreachable });
    const run = await runOnce({ githubReconcile: w.job });
    expect(run.outcome).not.toBe('ok');
    const [row] = await runsOf();
    expect(row?.outcome).toBe(run.outcome);
    expect(row?.why).toMatch(/Temporal 连不上/);
  });

  it('对账本身抛错（读库失败）：记成 failed、活动报 RECONCILE_FAILED，定时任务页标「没跑成」', async () => {
    const w = await wiring({ issues: [] });
    const failure = await failureOf({
      githubReconcile: (client, taskQueue) => ({
        ...w.job(client, taskQueue),
        reconcile: async () => {
          throw new Error('读 repos 表超时');
        },
      }),
    });
    expect(failure.type).toBe('RECONCILE_FAILED');
    expect(failure.message).toMatch(/读 repos 表超时/);
    const [row] = await runsOf();
    expect(row).toMatchObject({ outcome: 'failed' });
    expect(row?.why).toMatch(/读 repos 表超时/);
    expect((await healthOf())?.status).toBe('failing');
  });

  it('记不上开始（定时任务没登记，schedule_runs 的外键不让写）：这一轮失败、不去对账，不装作跑过', async () => {
    const w = await wiring({ issues: [issue(41, -20)] }, { register: false });
    const failure = await failureOf({ githubReconcile: w.job });
    expect(failure.message).toBeTruthy();
    expect(await runsOf()).toHaveLength(0);
    expect(await t.db.select().from(tasks)).toHaveLength(0);
  });

  it('假端口的工人（没装对账）接到这一轮：明确报 JOB_NOT_CONFIGURED，不回一个空的 ok', async () => {
    const failure = await failureOf(undefined);
    expect(failure.type).toBe('JOB_NOT_CONFIGURED');
    expect(failure.nonRetryable).toBe(true);
  });
});

// 流程配置副本（0003 第 9 条）：每轮对账先读仓里默认分支头上的 .fleet/flow.json，合并校验后写进 repos 的 flow_* 列，
// 接活拉起工作流前看它。不起 Temporal：直接跑一轮（拉起需求工作流用只记下的假的），库是 PGlite 上跑真迁移。
describe('流程配置副本：每轮对账从仓里同步（真库、照 GitHub 回话的假服务）', () => {
  const HEAD_B = 'b'.repeat(40);
  const KEY = `flow-config:${SLUG}`;
  const config = (o: Record<string, unknown>) => JSON.stringify({ formatVersion: 1, ...o });
  const round = (w: Awaited<ReturnType<typeof wiring>>) =>
    runGitHubReconcileJob(w.job({} as unknown as Client, 'fleet-test'));
  const row = async () => {
    const [r] = await t.db.select().from(repos);
    if (!r) throw new Error('库里没有这个仓');
    return r;
  };
  const alertOf = async (key: string) =>
    (await t.db.select().from(notifications)).find((n) => n.dedupeKey === key);

  it('仓里没有 .fleet/flow.json：副本用全组织默认、标成 org_default，记下读的提交；给人看的 test_command 不动；单照常拉起', async () => {
    const w = await wiring({ issues: [issue(41, -20)] });
    expect(await round(w)).toMatchObject({ outcome: 'ok', scanned: 1, found: 1 });
    const r = await row();
    expect(r).toMatchObject({
      flowSource: 'org_default',
      flowCommit: HEAD_A,
      flowError: null,
      flowUnread: null,
      testCommand: 'pnpm check',
    });
    expect(r.flowSyncedAt).toBeInstanceOf(Date);
    expect(r.flowConfig).toMatchObject({ formatVersion: 1, categoryProfiles: { 需求: 'default' } });
    // 全组织默认里不放测试命令：这个仓的写码会话会停下说「项目没写测试命令」（real/flow-gate.ts）
    expect(r.flowConfig).not.toHaveProperty('testCommand');
    expect(w.starts.map((s) => s.issueNumber)).toEqual([41]);
  });

  it('仓里写了测试命令、后来改了：副本整份跟着变（测试命令、读的提交），给人看的 test_command 也改成一样的', async () => {
    const state: GitHubState = { issues: [], flowFile: config({ testCommand: 'pnpm test:changed' }) };
    const w = await wiring(state);
    await round(w);
    expect(await row()).toMatchObject({
      flowSource: 'project',
      flowCommit: HEAD_A,
      testCommand: 'pnpm test:changed',
      flowConfig: expect.objectContaining({ testCommand: 'pnpm test:changed' }),
    });
    state.flowFile = config({ testCommand: 'pnpm test' });
    state.head = HEAD_B;
    await round(w);
    expect(await row()).toMatchObject({
      flowCommit: HEAD_B,
      testCommand: 'pnpm test',
      flowConfig: expect.objectContaining({ testCommand: 'pnpm test' }),
    });
  });

  it('【失败】坏 JSON：这个项目停派、报一条提醒，单子建了行但不拉起（投递记成等着）；改好之后下一轮自动恢复、补拉起、撤掉提醒', async () => {
    const state: GitHubState = { issues: [issue(41, -20)], flowFile: '{"formatVersion": 1,' };
    const w = await wiring(state);
    const first = await round(w);
    // 轮询到这张单时接活说「等着」，这个仓这一轮没轮询完：不记 ok，原因里两样都写明
    expect(first.outcome).not.toBe('ok');
    expect(first.why).toContain(`流程配置 ${SLUG} 认不出、停派`);
    expect(first.why).toContain('这个项目停派：流程配置认不出');
    const r = await row();
    expect(r.flowError).toMatch(/项目配置 \.fleet\/flow\.json：不是 JSON.*（提交 aaaaaaa）/);
    expect(r.flowSyncedAt).toBeNull();
    expect(await alertOf(KEY)).toMatchObject({
      level: 'alert',
      resolvedAt: null,
      title: `${SLUG} 的流程配置认不出：这个项目停派`,
    });
    expect((await t.db.select().from(tasks)).map((x) => x.issueNumber)).toEqual([41]);
    expect(w.starts).toEqual([]);
    const waiting = (await t.db.select().from(githubEvents)).filter((e) => e.status === 'waiting');
    expect(waiting.map((e) => e.reason)).toEqual([expect.stringContaining('这个项目停派：流程配置认不出')]);

    // 仓里改好了：下一轮先同步副本，再重放等着的投递——这回拉起，提醒撤掉
    state.flowFile = config({ testCommand: 'pnpm test:changed' });
    await round(w);
    expect(await row()).toMatchObject({ flowError: null, testCommand: 'pnpm test:changed' });
    expect((await alertOf(KEY))?.resolvedAt).toBeInstanceOf(Date);
    expect(w.starts.map((s) => s.issueNumber)).toEqual([41]);
  });

  it('【失败】读 .fleet/flow.json 时 GitHub 出错：记下没查成，副本一样不动（不当成没有这个文件）；这一轮记成没查全', async () => {
    const state: GitHubState = { issues: [], flowFile: config({ testCommand: 'pnpm test:changed' }) };
    const w = await wiring(state);
    await round(w);
    const before = await row();
    state.flowDown = 502;
    delete state.flowFile; // 就算文件真没了，没查成也看不出来：不许写成「没有」
    const run = await round(w);
    expect(run.outcome).toBe('partial');
    expect(run.why).toContain(`流程配置 ${SLUG} 没查成`);
    const after = await row();
    expect(after.flowUnread).toMatch(/502/);
    const same = (x: typeof after) => ({ ...x, flowUnread: null, flowCheckedAt: null });
    expect(same(after)).toEqual(same(before));
    // 还在时限里：照样能派，不报提醒
    expect(await alertOf(KEY)).toBeUndefined();
  });

  it('【失败】没查成、副本又已经超过 45 分钟没同步成：停派并报提醒；读成一次就撤掉', async () => {
    const state: GitHubState = { issues: [], flowFile: config({ testCommand: 'pnpm test:changed' }) };
    const w = await wiring(state);
    await round(w);
    await t.db.update(repos).set({ flowSyncedAt: new Date(Date.now() - 50 * 60_000) });
    state.flowDown = 502;
    await round(w);
    expect(await alertOf(KEY)).toMatchObject({
      resolvedAt: null,
      body: expect.stringMatching(/5\d 分钟没同步成.*最近一次没查成/),
    });
    delete state.flowDown;
    await round(w);
    expect((await alertOf(KEY))?.resolvedAt).toBeInstanceOf(Date);
  });

  it('【失败】全组织默认坏了：所有仓停派，只报一条全组织的提醒（不按仓各报一条）', async () => {
    const w = await wiring(
      { issues: [], flowFile: config({ testCommand: 'pnpm test:changed' }) },
      { orgDefault: async () => ({ kind: 'text', text: '{' }) },
    );
    // 这一轮查全了（ok），认不出算发现的问题；原因在提醒和副本里
    expect(await round(w)).toMatchObject({ outcome: 'ok', found: 1 });
    expect((await row()).flowError).toMatch(/^全组织默认：不是 JSON/);
    expect(await alertOf('flow-config:org')).toMatchObject({
      resolvedAt: null,
      title: '全组织默认的流程配置认不出：所有项目停派',
    });
    expect(await alertOf(KEY)).toBeUndefined();
  });
});

// 只派当前版本的单（0003 第 2、8 条）：对账补收、重放和 webhook 走同一道门、同一套判法，挂在哪由「引擎」机器人拉起前现读。
describe('只派当前版本的独立单（母单、子单不派）：对账补收进来的也一样（真库、照 GitHub 回话的假服务）', () => {
  const round = (w: Awaited<ReturnType<typeof wiring>>) =>
    runGitHubReconcileJob(w.job({} as unknown as Client, 'fleet-test'));
  const notes = async () =>
    Object.fromEntries(
      (await t.db.select().from(githubEvents))
        .filter((e) => e.event === 'issues')
        .map((e) => [(e.payload as { issue: { number: number } }).issue.number, e.note]),
    );

  it('【故意造出的失败】未排期的、挂在 v2 上的、v1 的母单和它的子单补收进来：建了任务行、不拉起，投递写明原因；v1 的独立单拉起', async () => {
    const w = await wiring({
      issues: [
        issue(41, -20),
        issue(42, -20, null),
        issue(43, -20, V2),
        { ...issue(44, -20), labels: ['需求', '母单'], subIssues: 1 },
        { ...issue(45, -20), parent: 44 },
      ],
      milestones: [V1, V2],
    });
    await round(w);
    const rows = (await t.db.select().from(tasks)).filter((r) => r.repoId === w.repoId);
    expect(rows.map((r) => r.issueNumber).sort()).toEqual([41, 42, 43, 44, 45]);
    expect(w.starts.map((s) => s.issueNumber)).toEqual([41]);
    expect(await notes()).toMatchObject({
      41: 'task=created, workflow=started',
      42: 'task=created, workflow=unscheduled',
      43: 'task=created, workflow=not_current_version',
      44: 'task=created, workflow=mother_ticket',
      45: 'task=created, workflow=sub_issue',
    });
  });

  it('【故意造出的失败】读不到这张单挂在哪个版本、是不是母单子单（里程碑列表认不出）：不派，投递记成出错、写明没查成，这一轮不记 ok', async () => {
    const w = await wiring({
      issues: [issue(41, -20)],
      // 只有「列还开着的里程碑」这一条回的形状不对：轮询、建任务行照常
      milestones: [{ id: 1, name: '不是里程碑的形状' }] as unknown as (typeof V1)[],
    });
    const run = await round(w);
    expect(run.outcome).not.toBe('ok');
    expect(w.starts).toEqual([]);
    expect((await t.db.select().from(tasks)).map((r) => [r.issueNumber, r.state])).toEqual([[41, 'queued']]);
    const [event] = (await t.db.select().from(githubEvents)).filter((e) => e.event === 'issues');
    expect(event).toMatchObject({
      status: 'failed',
      reason: expect.stringMatching(
        /^没查成：读不到 example\/canary#41 挂在哪个版本、是不是母单子单（.+），这张单没派；对账重放时再判$/,
      ),
    });
  });
});

describe('对账补漏一轮的记账（不起 Temporal）', () => {
  const NOW = new Date('2026-09-25T08:00:00.000Z');

  function deps(
    reconcile: GitHubReconcileJobDeps['reconcile'],
    syncFlowConfigs: GitHubReconcileJobDeps['syncFlowConfigs'] = async () => ({ repos: [] }),
    askIssues: GitHubReconcileJobDeps['askIssues'] = async () => ({
      scanned: 0,
      found: 0,
      opened: [],
      unchecked: [],
    }),
  ) {
    const finished: { id: number; result: unknown }[] = [];
    const logs: string[] = [];
    const d: GitHubReconcileJobDeps = {
      syncFlowConfigs,
      reconcile,
      askIssues,
      runs: {
        async start() {
          return 7;
        },
        async finish(id, result) {
          finished.push({ id, result });
        },
      },
      now: () => NOW,
      log: (level, message) => logs.push(`${level}:${message}`),
    };
    return { d, finished, logs };
  }

  it('往回看 2 小时；ok 原样记', async () => {
    let since: Date | undefined;
    const { d, finished } = deps(async (o) => {
      since = o.since;
      return { outcome: 'ok', scanned: 2, found: 1, steps: [] };
    });
    expect(await runGitHubReconcileJob(d)).toEqual({ runId: 7, outcome: 'ok', scanned: 2, found: 1 });
    expect(since?.getTime()).toBe(NOW.getTime() - GITHUB_RECONCILE_LOOKBACK_MS);
    expect(finished).toEqual([{ id: 7, result: { outcome: 'ok', scanned: 2, found: 1 } }]);
  });

  it('说是 ok 却一个仓都没查：记成 unscanned，不冒充查过', () => {
    expect(toScheduleResult({ outcome: 'ok', scanned: 0, found: 0, steps: [] })).toMatchObject({
      outcome: 'unscanned',
    });
  });

  it('partial、unscanned 没带原因也补上原因（schedule_runs 不许不是 ok 的没原因）', () => {
    expect(toScheduleResult({ outcome: 'partial', scanned: 1, found: 0, steps: [] })).toMatchObject({
      outcome: 'partial',
      why: expect.any(String),
    });
    expect(toScheduleResult({ outcome: 'unscanned', scanned: 0, found: 0, steps: [] })).toMatchObject({
      outcome: 'unscanned',
      why: expect.any(String),
    });
  });

  it('记结局失败：原样抛出，不当成跑完了', async () => {
    const { d } = deps(async () => ({ outcome: 'ok', scanned: 1, found: 0, steps: [] }));
    d.runs.finish = async () => {
      throw new Error('库连不上');
    };
    await expect(runGitHubReconcileJob(d)).rejects.toThrow('库连不上');
  });

  it('先同步流程配置副本、再对账（同一轮里重放等着的投递看到的是新副本）', async () => {
    const order: string[] = [];
    const { d } = deps(
      async () => {
        order.push('reconcile');
        return { outcome: 'ok', scanned: 1, found: 0, steps: [] };
      },
      async () => {
        order.push('flow');
        return { repos: [{ repo: 'example/canary', outcome: 'synced', source: 'project', blocked: false }] };
      },
    );
    expect(await runGitHubReconcileJob(d)).toEqual({ runId: 7, outcome: 'ok', scanned: 1, found: 0 });
    expect(order).toEqual(['flow', 'reconcile']);
  });

  it('【失败】有仓的流程配置没查成：这一轮记成 partial（没查全），原因写明；认不出的算发现的问题', async () => {
    const { d, finished } = deps(
      async () => ({ outcome: 'ok', scanned: 2, found: 0, steps: [] }),
      async () => ({
        repos: [
          { repo: 'example/canary', outcome: 'unread', why: 'GitHub 回 502', blocked: false },
          {
            repo: 'example/other',
            outcome: 'invalid',
            why: '项目配置 .fleet/flow.json：不是 JSON',
            blocked: true,
          },
        ],
      }),
    );
    const run = await runGitHubReconcileJob(d);
    expect(run).toMatchObject({ outcome: 'partial', scanned: 2, found: 1 });
    expect(run.why).toContain('流程配置 example/canary 没查成（GitHub 回 502）');
    expect(run.why).toContain('流程配置 example/other 认不出、停派（项目配置 .fleet/flow.json：不是 JSON）');
    expect(finished[0]?.result).toMatchObject({ outcome: 'partial', found: 1 });
  });

  it('【失败】流程配置整步没跑成（读仓列表出错）：不挡对账本身，这一轮记成 partial 写明原因', async () => {
    let reconciled = false;
    const { d } = deps(
      async () => {
        reconciled = true;
        return { outcome: 'ok', scanned: 1, found: 0, steps: [] };
      },
      async () => {
        throw new Error('读 repos 表超时');
      },
    );
    const run = await runGitHubReconcileJob(d);
    expect(reconciled).toBe(true);
    expect(run).toMatchObject({ outcome: 'partial', why: '流程配置没同步成：读 repos 表超时' });
  });

  it('流程配置全同步成、没问题：这一轮的结局照对账的原样', () => {
    const r = { outcome: 'unscanned' as const, scanned: 0, found: 0, why: '没有受管的仓', steps: [] };
    expect(withFlowSync(r, { repos: [] })).toBe(r);
  });

  it('给提问另开单（#259）在对账之后跑；开出的单、写上的回答算处理了的', async () => {
    const order: string[] = [];
    const { d } = deps(
      async () => {
        order.push('reconcile');
        return { outcome: 'ok', scanned: 1, found: 0, steps: [] };
      },
      undefined,
      async () => {
        order.push('asks');
        return {
          scanned: 2,
          found: 2,
          opened: [{ askId: 'a', kind: 'follow-up', issueNumber: 301, created: true }],
          unchecked: [],
        };
      },
    );
    expect(await runGitHubReconcileJob(d)).toEqual({ runId: 7, outcome: 'ok', scanned: 1, found: 2 });
    expect(order).toEqual(['reconcile', 'asks']);
  });

  it('【失败】有提问的单没开成：这一轮记成 partial（没查全），哪一条没开成写进原因，不当成开了', async () => {
    const { d, finished } = deps(
      async () => ({ outcome: 'ok', scanned: 1, found: 0, steps: [] }),
      undefined,
      async () => ({
        scanned: 1,
        found: 0,
        opened: [],
        unchecked: ['#12 的提问 11111111 开后续单没成：GitHub 回 502'],
      }),
    );
    const run = await runGitHubReconcileJob(d);
    expect(run).toMatchObject({ outcome: 'partial', why: '#12 的提问 11111111 开后续单没成：GitHub 回 502' });
    expect(finished[0]?.result).toMatchObject({ outcome: 'partial' });
  });

  it('【失败】没开成的多：原因里只写前 3 条，其余写明还有几条、去提醒中心看，不悄悄丢掉', async () => {
    const lines = [1, 2, 3, 4, 5].map((i) => `#${i} 的提问 0000000${i} 另开单没成：GitHub 回 502`);
    const { d } = deps(
      async () => ({ outcome: 'ok', scanned: 1, found: 0, steps: [] }),
      undefined,
      async () => ({ scanned: 5, found: 0, opened: [], unchecked: lines }),
    );
    const run = await runGitHubReconcileJob(d);
    expect(run.outcome).toBe('partial');
    expect(run.why?.split('；')).toEqual([
      ...lines.slice(0, 3),
      '另有 2 条提问没开成单或没写成回答（提醒中心 ask-issue:、ask-answer: 开头的）',
    ]);
  });

  it('【失败】另开单整步没跑成（读库里的提问出错）：不挡对账本身，这一轮记成 partial 写明原因', async () => {
    const { d } = deps(
      async () => ({ outcome: 'ok', scanned: 1, found: 0, steps: [] }),
      undefined,
      async () => {
        throw new Error('读 asks 表超时');
      },
    );
    expect(await runGitHubReconcileJob(d)).toMatchObject({
      outcome: 'partial',
      why: '给提问另开单没跑成：读 asks 表超时',
    });
  });
});

describe('定时任务按固定编号建：重启、重复部署不多出第二个', () => {
  function fakeScheduleClient(existing: boolean, failWith?: Error) {
    const calls: string[] = [];
    const updated = new Map<string, unknown>();
    const client = {
      schedule: {
        async create(options: { scheduleId: string }) {
          calls.push(`create:${options.scheduleId}`);
          if (failWith) throw failWith;
          if (existing) throw new ScheduleAlreadyRunning('已经有了', options.scheduleId);
          return {};
        },
        getHandle(id: string) {
          return {
            async update(fn: (prev: unknown) => unknown) {
              calls.push(`update:${id}`);
              updated.set(
                id,
                fn({ state: { paused: true, note: '人停的' }, spec: {}, action: {}, policies: {} }),
              );
            },
          };
        },
      },
    } as unknown as Pick<Client, 'schedule'>;
    return { client, calls, updated: (id: string) => updated.get(id) };
  }

  it('登记表和 Temporal 定时任务一一对得上：每个定时任务都登记了（一次没跑过也在看门狗名单上）', () => {
    expect(engineSchedules('fleet').map((s) => s.scheduleId)).toEqual(ENGINE_JOBS.map((j) => j.id));
  });

  it('没有就建；已经有了就按声明更新、人手动暂停的照旧停着', async () => {
    const fresh = fakeScheduleClient(false);
    expect(await ensureEngineSchedules(fresh.client, 'fleet')).toEqual({
      [GITHUB_RECONCILE_SCHEDULE_ID]: 'created',
      [ROUTE_PROBE_SCHEDULE_ID]: 'created',
      [HOURLY_RECONCILE_SCHEDULE_ID]: 'created',
      [CANARY_SCHEDULE_ID]: 'created',
    });
    const again = fakeScheduleClient(true);
    expect(await ensureEngineSchedules(again.client, 'fleet')).toEqual({
      [GITHUB_RECONCILE_SCHEDULE_ID]: 'updated',
      [ROUTE_PROBE_SCHEDULE_ID]: 'updated',
      [HOURLY_RECONCILE_SCHEDULE_ID]: 'updated',
      [CANARY_SCHEDULE_ID]: 'updated',
    });
    expect(again.calls).toEqual([
      `create:${GITHUB_RECONCILE_SCHEDULE_ID}`,
      `update:${GITHUB_RECONCILE_SCHEDULE_ID}`,
      `create:${ROUTE_PROBE_SCHEDULE_ID}`,
      `update:${ROUTE_PROBE_SCHEDULE_ID}`,
      `create:${HOURLY_RECONCILE_SCHEDULE_ID}`,
      `update:${HOURLY_RECONCILE_SCHEDULE_ID}`,
      `create:${CANARY_SCHEDULE_ID}`,
      `update:${CANARY_SCHEDULE_ID}`,
    ]);
    expect(again.updated(GITHUB_RECONCILE_SCHEDULE_ID)).toMatchObject({
      state: { paused: true, note: '人停的' },
      spec: { intervals: [{ every: '15 minutes' }] },
      action: { workflowType: WORKFLOW_TYPES.githubReconcile, taskQueue: 'fleet' },
      policies: { overlap: 'SKIP' },
    });
    // 路由探针：同样每 15 分钟，错开 7 分钟（和对账不在整点挤着起会话）
    expect(again.updated(ROUTE_PROBE_SCHEDULE_ID)).toMatchObject({
      state: { paused: true, note: '人停的' },
      spec: { intervals: [{ every: '15 minutes', offset: '7 minutes' }] },
      action: { workflowType: WORKFLOW_TYPES.routeProbe, taskQueue: 'fleet' },
      policies: { overlap: 'SKIP' },
    });
    // 每小时对账：每 60 分钟，41 分起（和前两个错开）
    expect(again.updated(HOURLY_RECONCILE_SCHEDULE_ID)).toMatchObject({
      state: { paused: true, note: '人停的' },
      spec: { intervals: [{ every: '60 minutes', offset: '41 minutes' }] },
      action: { workflowType: WORKFLOW_TYPES.hourlyReconcile, taskQueue: 'fleet' },
      policies: { overlap: 'SKIP' },
    });
    // 全流程巡检：每 6 小时，26 分起（北京时间 2、8、14、20 点 26 分）；一轮工作流最长 5.5 小时，上一轮没完就跳过
    expect(again.updated(CANARY_SCHEDULE_ID)).toMatchObject({
      state: { paused: true, note: '人停的' },
      spec: { intervals: [{ every: '6 hours', offset: '26 minutes' }] },
      action: { workflowType: WORKFLOW_TYPES.canary, taskQueue: 'fleet', workflowRunTimeout: '330 minutes' },
      policies: { overlap: 'SKIP' },
    });
  });

  it('建的时候出了别的错（连不上、没权限）：原样抛出，引擎起不来要看得见', async () => {
    const broken = fakeScheduleClient(false, new Error('14 UNAVAILABLE: 连不上'));
    await expect(ensureEngineSchedules(broken.client, 'fleet')).rejects.toThrow('UNAVAILABLE');
  });

  it('真 Temporal 开发服务端：对两遍各只有一个定时任务，对账每 15 分钟、路由探针每 15 分钟错开 7 分钟、每小时对账 41 分起、巡检每 6 小时 26 分起', {
    timeout: 300_000,
  }, async () => {
    const real = await createRealEnv();
    try {
      const { client } = real;
      expect(await ensureEngineSchedules(client, 'fleet-a')).toEqual({
        [GITHUB_RECONCILE_SCHEDULE_ID]: 'created',
        [ROUTE_PROBE_SCHEDULE_ID]: 'created',
        [HOURLY_RECONCILE_SCHEDULE_ID]: 'created',
        [CANARY_SCHEDULE_ID]: 'created',
      });
      await client.schedule.getHandle(GITHUB_RECONCILE_SCHEDULE_ID).pause('人停的');
      expect(await ensureEngineSchedules(client, 'fleet-b')).toEqual({
        [GITHUB_RECONCILE_SCHEDULE_ID]: 'updated',
        [ROUTE_PROBE_SCHEDULE_ID]: 'updated',
        [HOURLY_RECONCILE_SCHEDULE_ID]: 'updated',
        [CANARY_SCHEDULE_ID]: 'updated',
      });
      const d = await client.schedule.getHandle(GITHUB_RECONCILE_SCHEDULE_ID).describe();
      expect(d.spec.intervals?.map((i) => i.every)).toEqual([15 * 60_000]);
      expect(d.action).toMatchObject({ workflowType: WORKFLOW_TYPES.githubReconcile, taskQueue: 'fleet-b' });
      // 第二次是在同一个编号上改（编号固定，建第二个会撞 ScheduleAlreadyRunning），人停的照旧停着
      expect(d.state.paused).toBe(true);
      const probe = await client.schedule.getHandle(ROUTE_PROBE_SCHEDULE_ID).describe();
      expect(probe.spec.intervals?.map((i) => [i.every, i.offset])).toEqual([[15 * 60_000, 7 * 60_000]]);
      expect(probe.action).toMatchObject({ workflowType: WORKFLOW_TYPES.routeProbe, taskQueue: 'fleet-b' });
      expect(probe.state.paused).toBe(false);
      const hourly = await client.schedule.getHandle(HOURLY_RECONCILE_SCHEDULE_ID).describe();
      expect(hourly.spec.intervals?.map((i) => [i.every, i.offset])).toEqual([[60 * 60_000, 41 * 60_000]]);
      expect(hourly.action).toMatchObject({
        workflowType: WORKFLOW_TYPES.hourlyReconcile,
        taskQueue: 'fleet-b',
      });
      const canary = await client.schedule.getHandle(CANARY_SCHEDULE_ID).describe();
      expect(canary.spec.intervals?.map((i) => [i.every, i.offset])).toEqual([
        [6 * 60 * 60_000, 26 * 60_000],
      ]);
      expect(canary.action).toMatchObject({ workflowType: WORKFLOW_TYPES.canary, taskQueue: 'fleet-b' });
    } finally {
      await real.teardown();
    }
  });
});

// 问创始人不挡路（#259）：每轮对账给提问另开单——他改选了别的、原单已经合了的开后续单（挂同一个版本，下一轮接活自动派），
// 超出范围的开一张未排期的等他拍（原单接着做）；开单没成的照实记没开成。不起 Temporal：直接跑一轮，库是 PGlite 上跑真迁移，
// GitHub 是照接口回话的假服务（开单、评论都在它身上看得见）。
describe('给提问另开单：每轮对账（真库、照 GitHub 回话的假服务）', () => {
  const round = (w: Awaited<ReturnType<typeof wiring>>) =>
    runGitHubReconcileJob(w.job({} as unknown as Client, 'fleet-test'));
  /** 原单 #12：五个小时前动过（不在这一轮补收的范围里），开着还是关了由用例定。 */
  const original = (state: 'open' | 'closed', labels: string[]) => ({
    ...issue(12, -300),
    title: '登录页加验证码',
    state,
    labels,
  });
  const byEngine = (state: GitHubState) =>
    state.issues.filter((i) => (i as { user: unknown }).user === engineBot) as {
      number: number;
      title: string;
      body: string;
      labels: string[];
      milestone: unknown;
    }[];

  async function taskWithAsk(
    repoId: string,
    issueNumber: number,
    taskState: 'running' | 'done',
    ask: Partial<typeof asks.$inferInsert>,
  ) {
    const [task] = await t.db
      .insert(tasks)
      .values({
        repoId,
        issueNumber,
        title: '登录页加验证码',
        rawRequest: '给登录页加手机验证码',
        requestedBy: 'founder',
        state: taskState,
        priority: 0,
      })
      .returning();
    if (!task) throw new Error('任务没建上');
    const [row] = await t.db
      .insert(asks)
      .values({ taskId: task.id, question: '验证码几位？', options: ['6 位', '4 位'], ...ask })
      .returning();
    if (!row) throw new Error('提问没建上');
    return { task, ask: row };
  }
  const answered = (answer: string) => ({ answer, answeredBy: 'founder', answeredAt: new Date() });
  /** 「引擎」机器人在白名单里（ops 第五节：两个机器人各一行 role = bot）：它开的单接活才收。 */
  const botMember = () =>
    t.db
      .insert(users)
      .values({ displayName: '引擎', role: 'bot', githubLogin: engineBot.login, githubId: engineBot.id });
  const askRow = async (id: string) => {
    return (await t.db.select().from(asks)).find((a) => a.id === id);
  };

  it('他改选了别的、原单已经合了：开一张后续单（照抄类别、挂原单的同一个版本、链接原单），单号回写；下一轮接活自动派它', async () => {
    const state: GitHubState = { issues: [original('closed', ['缺陷'])] };
    const w = await wiring(state);
    await botMember();
    const { ask } = await taskWithAsk(w.repoId, 12, 'done', {
      scope: 'task',
      recommended: '6 位',
      ...answered('4 位'),
    });

    const first = await round(w);
    expect(first).toMatchObject({ outcome: 'ok', found: 1 });
    const opened = byEngine(state);
    expect(opened).toHaveLength(1);
    expect(opened[0]).toMatchObject({
      number: 13,
      title: '#12 的后续：验证码几位？改成「4 位」',
      labels: ['缺陷'],
      milestone: V1,
    });
    expect(opened[0]?.body).toContain('创始人在 #12（登录页加验证码）的提问里改选了「4 位」');
    expect(opened[0]?.body).toContain('## 怎么算做完');
    expect((await askRow(ask.id))?.followUpIssue).toBe(13);
    expect(w.starts).toEqual([]);

    // 下一轮：后续单被补收进来，挂在当前版本上、是独立单，接活自动派；不再开第二张
    expect((await round(w)).outcome).toBe('ok');
    expect(w.starts.map((s) => s.issueNumber)).toEqual([13]);
    expect(byEngine(state)).toHaveLength(1);
  });

  it('超出范围的：开一张未排期的等他拍，原单接着做（任务不动、不派新单）；他之后在卡片上回答了，回答写到那张单的评论里', async () => {
    const state: GitHubState = { issues: [original('open', ['需求'])] };
    const w = await wiring(state);
    await botMember();
    const { task, ask } = await taskWithAsk(w.repoId, 12, 'running', {
      question: '要不要顺手改注册页？',
      options: ['不改', '改'],
      scope: 'outside',
      recommended: '不改',
    });

    expect(await round(w)).toMatchObject({ outcome: 'ok', found: 1 });
    expect(byEngine(state)).toEqual([
      expect.objectContaining({
        number: 13,
        title: '#12 问到的、超出范围的：要不要顺手改注册页？',
        labels: ['需求'],
        milestone: null,
      }),
    ]);
    expect((await askRow(ask.id))?.followUpIssue).toBe(13);
    // 原单接着做：任务状态没动；未排期的那张下一轮也不派
    const still = (await t.db.select().from(tasks)).find((r) => r.id === task.id);
    expect(still?.state).toBe('running');
    await round(w);
    expect(w.starts).toEqual([]);

    // 他在卡片上回答了：下一轮把回答写到那张单上，再下一轮不重写
    await t.client.query(
      "update asks set answer = '改', answered_by = 'founder', answered_at = now() where id = $1",
      [ask.id],
    );
    expect(await round(w)).toMatchObject({ outcome: 'ok', found: 1 });
    await round(w);
    const comments = state.comments?.get(13) ?? [];
    expect(comments).toHaveLength(1);
    expect(comments[0]?.body).toContain('创始人在 #12 的提问卡片上选了「改」：这一块照它做。');
    // 写上了记成转交完（applied_at），之后的对账不再看这条
    expect((await askRow(ask.id))?.appliedAt).not.toBeNull();
  });

  it('【失败】开单没成（GitHub 开单接口报错、卫生检查拦下提问里的敏感值）：记成没开成（partial、写明哪条），报提醒，单号不回写；好了下一轮补开', async () => {
    const state: GitHubState = { issues: [original('closed', ['需求'])], createDown: 422 };
    const w = await wiring(state);
    const { ask } = await taskWithAsk(w.repoId, 12, 'done', {
      scope: 'task',
      recommended: '6 位',
      ...answered('4 位'),
    });
    const { ask: leaky } = await taskWithAsk(w.repoId, 14, 'running', {
      question: '接到组织 fake-org-778899 的账号上吗？',
      options: ['接', '不接'],
      scope: 'outside',
      recommended: '接',
    });

    const run = await round(w);
    expect(run.outcome).toBe('partial');
    expect(run.why).toContain(`#12 的提问 ${ask.id.slice(0, 8)} 开后续单没成`);
    expect(run.why).toContain(`#14 的提问 ${leaky.id.slice(0, 8)} 另开单没成`);
    // 卫生检查拦下的只写哪一条规则、在哪，不把敏感值原样写进结局
    expect(run.why).not.toContain('fake-org-778899');
    expect((await askRow(ask.id))?.followUpIssue).toBeNull();
    expect((await askRow(leaky.id))?.followUpIssue).toBeNull();
    expect(byEngine(state)).toEqual([]);
    const alerts = (await t.db.select().from(notifications)).filter((n) =>
      n.dedupeKey.startsWith('ask-issue:'),
    );
    expect(alerts.map((a) => a.dedupeKey).sort()).toEqual(
      [`ask-issue:${ask.id}`, `ask-issue:${leaky.id}`].sort(),
    );
    expect((await runsOf()).at(-1)).toMatchObject({ outcome: 'partial' });

    // GitHub 好了：下一轮补开、撤掉那条提醒；卫生检查拦下的那条照旧没开成
    delete state.createDown;
    const again = await round(w);
    expect((await askRow(ask.id))?.followUpIssue).toBe(13);
    expect(again.why).toContain(`#14 的提问 ${leaky.id.slice(0, 8)} 另开单没成`);
    const after = (await t.db.select().from(notifications)).find(
      (n) => n.dedupeKey === `ask-issue:${ask.id}`,
    );
    expect(after?.resolvedAt).not.toBeNull();
  });
});
