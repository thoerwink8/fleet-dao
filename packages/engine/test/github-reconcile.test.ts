// 定时对账补漏（#43）：Temporal 定时任务 → 工作流 → 活动 → 后端的 reconcileGitHub（真 Store、真 GitHubIntake、@fleet-dao/github
// 的真轮询，对着照 GitHub 接口回话的假服务）→ 结局记进 schedule_runs。库是 PGlite 上跑真迁移。
// 没跑成、没查成、认不出，都要记成明确的结局（failed / unscanned / partial），不记成 ok。
import { generateKeyPairSync, randomUUID } from 'node:crypto';
import { type RequirementStart, type RequirementWorkflows, WorkflowUnavailableError } from '@fleet-dao/api';
import { repos, scheduleHealth, scheduleRuns, tasks, users } from '@fleet-dao/db';
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
} from '../src/jobs/github-reconcile.ts';
import {
  engineSchedules,
  ensureEngineSchedules,
  GITHUB_RECONCILE_SCHEDULE_ID,
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

interface GitHubState {
  issues: unknown[];
  /** 设了就所有接口都这样回（读不到 GitHub）。 */
  down?: number;
}

/** 只答对账会问的几条：安装、令牌、issue 列表、评论列表、PR 列表、投递日志。since 照 GitHub 的规矩过滤。 */
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
    if (url.pathname === `${base}/issues`) {
      const open = url.searchParams.get('state') === 'open';
      return reply(
        200,
        state.issues.filter((i) => (open ? (i as { state?: unknown }).state === 'open' : fresh(i))),
      );
    }
    if (url.pathname === `${base}/issues/comments`) return reply(200, []);
    if (url.pathname === `${base}/pulls`) return reply(200, []);
    if (url.pathname === '/app/hook/deliveries') return reply(200, []);
    return reply(404, { message: `假 GitHub 里没有 ${init?.method ?? 'GET'} ${url.pathname}` });
  };
}

function issue(number: number, minutes: number) {
  return {
    number,
    title: `需求 ${number}`,
    body: `第 ${number} 张的原话`,
    state: 'open',
    user: founder,
    created_at: at(minutes),
    updated_at: at(minutes),
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
  /** requirements：'real' = 真的经 Temporal 起需求工作流（后端的 createTemporalRequirementWorkflows）；不给就是只记下的假的。 */
  options: { requirements?: RequirementWorkflows | 'real'; register?: boolean } = {},
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
  });
  const fake = fakeRequirements();
  const job = githubReconcileJob({
    db: t.db,
    gh,
    ...(options.requirements === 'real' ? {} : { requirements: options.requirements ?? fake.requirements }),
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

  it('库里缺一条 issue：跑一轮补上任务行、经 Temporal 真起需求工作流，记一行 ok；再跑一轮不重复建、不重复起', async () => {
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
    expect(started.type).toBe(WORKFLOW_TYPES.requirement);

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

  it('拉起需求工作流时 Temporal 连不上：这一轮不记 ok（投递记成出错，等下一轮重放），不装作拉起了', async () => {
    const unreachable: RequirementWorkflows = {
      async start() {
        throw new WorkflowUnavailableError('拉起需求工作流：Temporal 连不上或没回应');
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

describe('对账补漏一轮的记账（不起 Temporal）', () => {
  const NOW = new Date('2026-09-25T08:00:00.000Z');

  function deps(reconcile: GitHubReconcileJobDeps['reconcile']) {
    const finished: { id: number; result: unknown }[] = [];
    const logs: string[] = [];
    const d: GitHubReconcileJobDeps = {
      reconcile,
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
    });
    const again = fakeScheduleClient(true);
    expect(await ensureEngineSchedules(again.client, 'fleet')).toEqual({
      [GITHUB_RECONCILE_SCHEDULE_ID]: 'updated',
      [ROUTE_PROBE_SCHEDULE_ID]: 'updated',
    });
    expect(again.calls).toEqual([
      `create:${GITHUB_RECONCILE_SCHEDULE_ID}`,
      `update:${GITHUB_RECONCILE_SCHEDULE_ID}`,
      `create:${ROUTE_PROBE_SCHEDULE_ID}`,
      `update:${ROUTE_PROBE_SCHEDULE_ID}`,
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
  });

  it('建的时候出了别的错（连不上、没权限）：原样抛出，引擎起不来要看得见', async () => {
    const broken = fakeScheduleClient(false, new Error('14 UNAVAILABLE: 连不上'));
    await expect(ensureEngineSchedules(broken.client, 'fleet')).rejects.toThrow('UNAVAILABLE');
  });

  it('真 Temporal 开发服务端：对两遍各只有一个定时任务，对账每 15 分钟、路由探针每 15 分钟错开 7 分钟', {
    timeout: 300_000,
  }, async () => {
    const real = await createRealEnv();
    try {
      const { client } = real;
      expect(await ensureEngineSchedules(client, 'fleet-a')).toEqual({
        [GITHUB_RECONCILE_SCHEDULE_ID]: 'created',
        [ROUTE_PROBE_SCHEDULE_ID]: 'created',
      });
      await client.schedule.getHandle(GITHUB_RECONCILE_SCHEDULE_ID).pause('人停的');
      expect(await ensureEngineSchedules(client, 'fleet-b')).toEqual({
        [GITHUB_RECONCILE_SCHEDULE_ID]: 'updated',
        [ROUTE_PROBE_SCHEDULE_ID]: 'updated',
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
    } finally {
      await real.teardown();
    }
  });
});
