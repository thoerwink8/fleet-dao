// 定时对账补漏（#43）：引擎的定时器 → 一轮（jobs/github-reconcile.ts）→ 后端的 reconcileGitHub（真 Store、真 GitHubIntake、@fleet-dao/github
// 的真轮询，对着照 GitHub 接口回话的假服务）→ 结局记进 schedule_runs。库是 PGlite 上跑真迁移。
// 只收 PR 和 CI 的事件：单子由引擎每 5 分钟自己拉，对账不管它们（#632、#556）。
// 没跑成、没查成、认不出，都要记成明确的结局（failed / unscanned / partial），不记成 ok。
import { generateKeyPairSync } from 'node:crypto';
import {
  notifications,
  pullRequests,
  repos,
  scheduleHealth,
  scheduleRuns,
  upsertAlert,
  users,
} from '@fleet-dao/db';
import { createTestDb, resetTestDb, TEST_DB_TIMEOUT_MS, type TestDb } from '@fleet-dao/db/testing';
import { type AppCredentials, createGitHub } from '@fleet-dao/github';
import { pgLedger } from '@fleet-dao/store';
import { type Client, ScheduleNotFoundError } from '@temporalio/client';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import type { EngineJobs } from '../src/activities.ts';
import type { GitHubReconcileRun } from '../src/contract.ts';
import {
  GITHUB_RECONCILE_JOB,
  GITHUB_RECONCILE_LOOKBACK_MS,
  GitHubReconcileFailedError,
  type GitHubReconcileJobDeps,
  runGitHubReconcileJob,
  toScheduleResult,
  withIssueGroom,
} from '../src/jobs/github-reconcile.ts';
import {
  deleteRetiredSchedules,
  RETIRED_SCHEDULE_IDS,
  RETIRED_SCHEDULES,
  type RetiredSchedule,
} from '../src/jobs/retired-schedules.ts';
import { githubReconcileJob, retireCloseSweepAlerts } from '../src/real/github-reconcile.ts';
import { ENGINE_JOBS, registerEngineJobs } from '../src/real/jobs.ts';

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
  /** 这个仓的 PR 列表（回得和 GitHub 一样：新的在前）。 */
  pulls: unknown[];
  /** 设了就所有接口都这样回（读不到 GitHub）。 */
  down?: number;
}

/**
 * 只答对账会问的几条：安装、令牌、PR 列表、投递日志。别的路径一律 404——对账要是还去拉 issue、评论、流程配置，
 * 这一轮就会算没做完，测试跟着红。
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
    if (url.pathname === `/repos/${SLUG}/pulls`) return reply(200, state.pulls);
    if (url.pathname === '/app/hook/deliveries') return reply(200, []);
    return reply(404, { message: `假 GitHub 里没有 ${init?.method ?? 'GET'} ${url.pathname}` });
  };
}

function pull(number: number, minutes: number) {
  return {
    number,
    state: 'open',
    merged_at: null,
    updated_at: at(minutes),
    user: founder,
    head: { ref: `fleet/${number}-a`, sha: 'a'.repeat(40), repo: { full_name: SLUG } },
    base: { ref: 'main', repo: { full_name: SLUG } },
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

/** 受管的仓、白名单里的创始人、登记好的定时任务，加一个照 GitHub 回话的假服务。 */
async function wiring(state: GitHubState, options: { register?: boolean } = {}) {
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
  const job = githubReconcileJob({
    db: t.db,
    gh,
    // 单子打标挂版本（#448）这里的用例不看它：没接判断题就是「没问成」，categoryPlan 不贴、只记没查成
    askIssueKind: async () => ({ judged: false, reason: 'unreachable', detail: '这个用例没接判断题' }),
    // 单子打标挂版本（#448）按真钟每小时跑：这里的用例不看它，关掉，免得几点跑测试结果就不一样
    issueGroomDue: () => false,
    log: quiet,
  });
  return { repoId: repo?.id ?? '', job };
}

const runsOf = async () =>
  (await t.db.select().from(scheduleRuns))
    .filter((r) => r.job === GITHUB_RECONCILE_JOB.id)
    .sort((a, b) => a.id - b.id);
const healthOf = async () => (await scheduleHealth(t.db)).find((h) => h.job.id === GITHUB_RECONCILE_JOB.id);
const pullsOf = async (repoId: string) =>
  (await t.db.select().from(pullRequests)).filter((r) => r.repoId === repoId);

describe('对账补漏跑一轮（真库，不起 Temporal）', { timeout: 60_000 }, () => {
  // 对账补漏这一轮不起也不查任务工作流，Temporal 客户端给一个空壳
  const client = {} as Client;

  async function runOnce(jobs: EngineJobs): Promise<GitHubReconcileRun> {
    const make = jobs.githubReconcile;
    if (!make) throw new Error('测试没装对账补漏');
    return runGitHubReconcileJob(make(client, 'fleet'));
  }

  /** 这一轮是怎么失败的：拿到它抛的错（没跑成的已经记进 schedule_runs）。 */
  async function failureOf(jobs: EngineJobs): Promise<GitHubReconcileFailedError> {
    const err = await runOnce(jobs).then(
      () => null,
      (e: unknown) => e,
    );
    expect(err).toBeInstanceOf(GitHubReconcileFailedError);
    return err as GitHubReconcileFailedError;
  }

  it('库里缺一个 PR：跑一轮由轮询补上镜像，记一行 ok；再跑一轮不重复', async () => {
    const w = await wiring({ pulls: [pull(41, -20)] });
    const jobs = { githubReconcile: w.job };

    const first = await runOnce(jobs);
    expect(first).toMatchObject({ outcome: 'ok', scanned: 1, found: 1 });
    expect((await pullsOf(w.repoId)).map((r) => [r.number, r.state])).toEqual([[41, 'open']]);

    const second = await runOnce(jobs);
    expect(second).toMatchObject({ outcome: 'ok', scanned: 1, found: 0 });
    expect(await pullsOf(w.repoId)).toHaveLength(1);

    const runs = await runsOf();
    expect(runs.map((r) => [r.id, r.outcome, r.scanned, r.found])).toEqual([
      [first.runId, 'ok', 1, 1],
      [second.runId, 'ok', 1, 0],
    ]);
    expect((await healthOf())?.status).toBe('ok');
  });

  it('读不到 GitHub：这一轮记成 unscanned（不是 ok），定时任务页标「没扫到」，不补任何镜像', async () => {
    const w = await wiring({ pulls: [pull(41, -20)], down: 500 });
    const run = await runOnce({ githubReconcile: w.job });
    expect(run.outcome).toBe('unscanned');
    expect(run.why).toBeTruthy();
    const [row] = await runsOf();
    expect(row).toMatchObject({ outcome: 'unscanned', scanned: 0 });
    expect(row?.why).toBeTruthy();
    expect((await healthOf())?.status).toBe('no-samples');
    expect(await pullsOf(w.repoId)).toHaveLength(0);
  });

  it('GitHub 回的 PR 列表认不出：这一轮不记 ok，原因写进 schedule_runs', async () => {
    const w = await wiring({ pulls: [{ numero: 41, titulo: '认不出的形状' }] });
    const run = await runOnce({ githubReconcile: w.job });
    expect(run.outcome).not.toBe('ok');
    const [row] = await runsOf();
    expect(row?.outcome).toBe(run.outcome);
    expect(row?.why).toMatch(/poll/);
    expect(await pullsOf(w.repoId)).toHaveLength(0);
  });

  it('对账本身抛错（读库失败）：记成 failed、这一轮抛 GitHubReconcileFailedError，定时任务页标「没跑成」', async () => {
    const w = await wiring({ pulls: [] });
    const failure = await failureOf({
      githubReconcile: (client, taskQueue) => ({
        ...w.job(client, taskQueue),
        reconcile: async () => {
          throw new Error('读 repos 表超时');
        },
      }),
    });
    expect(failure.message).toMatch(/读 repos 表超时/);
    const [row] = await runsOf();
    expect(row).toMatchObject({ outcome: 'failed' });
    expect(row?.why).toMatch(/读 repos 表超时/);
    expect((await healthOf())?.status).toBe('failing');
  });

  it('记不上开始（定时任务没登记，schedule_runs 的外键不让写）：这一轮失败、不去对账，不装作跑过', async () => {
    const w = await wiring({ pulls: [pull(41, -20)] }, { register: false });
    await expect(runOnce({ githubReconcile: w.job })).rejects.toThrow();
    expect(await runsOf()).toHaveLength(0);
    expect(await pullsOf(w.repoId)).toHaveLength(0);
  });
});

describe('对账补漏一轮的记账（不起 Temporal）', () => {
  const NOW = new Date('2026-09-25T08:00:00.000Z');

  function deps(
    reconcile: GitHubReconcileJobDeps['reconcile'],
    issueGroom: GitHubReconcileJobDeps['issueGroom'] = async () => ({ scanned: 0, found: 0, unchecked: [] }),
  ) {
    const finished: { id: number; result: unknown }[] = [];
    const logs: string[] = [];
    const d: GitHubReconcileJobDeps = {
      reconcile,
      issueGroom,
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

  describe('单子打标挂版本这一步并进这一轮的结局（#448）', () => {
    const ok = { outcome: 'ok' as const, scanned: 1, found: 2, steps: [] };

    it('没到点（null）：原样', () => {
      expect(withIssueGroom(ok, null)).toBe(ok);
    });

    it('跑成了、没有没查成的：found 加上，outcome 不降级', () => {
      expect(withIssueGroom(ok, { scanned: 3, found: 5, unchecked: [] })).toEqual({ ...ok, found: 7 });
    });

    it('有没查成的：outcome 降成 partial，原因写进 why', () => {
      const got = withIssueGroom(ok, { scanned: 3, found: 1, unchecked: ['o/r#1 贴类别标签没写成'] });
      expect(got.outcome).toBe('partial');
      expect(got.found).toBe(3);
      expect(got.why).toContain('o/r#1 贴类别标签没写成');
    });

    it('没查成的太多：只写前几条，剩下的说还有几条（看引擎日志）', () => {
      const unchecked = Array.from({ length: 5 }, (_, i) => `o/r#${i} 没查成`);
      const got = withIssueGroom(ok, { scanned: 1, found: 0, unchecked });
      expect(got.why).toContain('o/r#0 没查成');
      expect(got.why).toContain('另有 2 条没查成、没写成（看引擎日志）');
    });

    it('整步没跑成：outcome 降成 partial，原因写明是单子打标挂版本没跑成', () => {
      const got = withIssueGroom(ok, { failed: '读 repos 表超时' });
      expect(got).toMatchObject({ outcome: 'partial', why: expect.stringContaining('读 repos 表超时') });
    });
  });
});

describe('退役的定时任务：Temporal 上还在的删掉（断链修复：#445 删「提醒派单」整层，法国的 alert-dispatch 只能帅位手动暂停）', () => {
  const ONLY_ALERT_DISPATCH: RetiredSchedule[] = [{ id: 'alert-dispatch', retiredBy: '#445' }];

  /** 假的删：每个编号的结局按 byId 给，'ok' 删成、'absent' 回 ScheduleNotFoundError、给个 Error 就是删的时候出了别的错。 */
  function fakeDeleteClient(byId: Record<string, 'ok' | 'absent' | Error>) {
    const calls: string[] = [];
    const client = {
      schedule: {
        getHandle(id: string) {
          return {
            async delete() {
              calls.push(id);
              const outcome = byId[id];
              if (outcome === 'ok') return;
              if (outcome === 'absent') throw new ScheduleNotFoundError('没有这个 Schedule', id);
              throw outcome ?? new Error(`测试没给 ${id} 配结局`);
            },
          };
        },
      },
    } as unknown as Pick<Client, 'schedule'>;
    return { client, calls };
  }

  it('名单：alert-dispatch（#445 退役的「提醒派单」）加上摘出 Temporal 的 8 个定时任务（#1072，任务还在、只删老的 Schedule）；两处（这里、看门狗）认同一份', () => {
    expect(RETIRED_SCHEDULES[0]).toEqual({ id: 'alert-dispatch', retiredBy: '#445' });
    // 8 个就是登记表上的 8 个：少一个，Temporal 上那条老 Schedule 就留着和进程内定时器各跑一轮
    expect(
      RETIRED_SCHEDULES.filter((s) => s.moved)
        .map((s) => s.id)
        .sort(),
    ).toEqual(ENGINE_JOBS.map((j) => j.id).sort());
    expect(RETIRED_SCHEDULES.filter((s) => s.moved).every((s) => s.retiredBy === '#1072')).toBe(true);
  });

  it('看门狗剔除的只有真退役的（alert-dispatch）；摘出 Temporal 的 8 个任务还在，照看', () => {
    expect([...RETIRED_SCHEDULE_IDS]).toEqual(['alert-dispatch']);
  });

  it('【故意造出的失败】Temporal 上还在：删掉，回 deleted', async () => {
    const { client, calls } = fakeDeleteClient({ 'alert-dispatch': 'ok' });
    expect(await deleteRetiredSchedules(client, ONLY_ALERT_DISPATCH)).toEqual({
      'alert-dispatch': 'deleted',
    });
    expect(calls).toEqual(['alert-dispatch']);
  });

  it('【故意造出的失败】Temporal 上本来就没有（ScheduleNotFoundError）：回 absent，不算错、不多做别的事', async () => {
    const { client } = fakeDeleteClient({ 'alert-dispatch': 'absent' });
    expect(await deleteRetiredSchedules(client, ONLY_ALERT_DISPATCH)).toEqual({ 'alert-dispatch': 'absent' });
  });

  it('【故意造出的失败】删的时候出了别的错（连不上、没权限）：原文带着报回来，不当成删掉了、不抛出、不挡别的编号', async () => {
    const { client } = fakeDeleteClient({ 'alert-dispatch': new Error('14 UNAVAILABLE: 连不上') });
    await expect(deleteRetiredSchedules(client, ONLY_ALERT_DISPATCH)).resolves.toEqual({
      'alert-dispatch': { error: '14 UNAVAILABLE: 连不上' },
    });
  });

  it('多个编号各自独立：一个删不掉不耽误别的照删、照认「本来就没有」', async () => {
    const list: RetiredSchedule[] = [
      { id: 'a', retiredBy: '#1' },
      { id: 'b', retiredBy: '#2' },
      { id: 'c', retiredBy: '#3' },
    ];
    const { client, calls } = fakeDeleteClient({ a: 'ok', b: 'absent', c: new Error('权限不够') });
    expect(await deleteRetiredSchedules(client, list)).toEqual({
      a: 'deleted',
      b: 'absent',
      c: { error: '权限不够' },
    });
    expect(calls).toEqual(['a', 'b', 'c']);
  });
});

describe('关单对账 #654 删了以后，它留在库里的提醒一次性撤掉', () => {
  const repo = { owner: 'example', name: 'canary' };
  const alert = (dedupeKey: string) => ({
    dedupeKey,
    level: 'daily' as const,
    taskId: null,
    title: '提醒',
    body: '正文',
    link: 'https://github.com/example/canary/issues',
  });

  it('撤 close-sweep:<仓>:<种类> 四种；别的提醒不动；再跑一遍不报错、撤 0 条', async () => {
    const mine = ['due', 'mother', 'merged', 'no-result'].map((k) => `close-sweep:example/canary:${k}`);
    const other = 'close-sweep:example/other-repo:due';
    for (const key of [...mine, other, 'something-else']) await upsertAlert(t.db, alert(key));
    const now = () => new Date('2026-10-03T00:00:00Z');
    expect(await retireCloseSweepAlerts({ db: t.db }, [repo], now)).toBe(4);
    const rows = await t.db.select().from(notifications);
    for (const key of mine) {
      const row = rows.find((n) => n.dedupeKey === key);
      expect(row?.resolvedAt, key).not.toBeNull();
      expect(row?.body).toContain('已撤：关单对账已删（#654）');
    }
    // 没列进来的仓、别的提醒不碰
    expect(rows.find((n) => n.dedupeKey === other)?.resolvedAt).toBeNull();
    expect(rows.find((n) => n.dedupeKey === 'something-else')?.resolvedAt).toBeNull();
    expect(await retireCloseSweepAlerts({ db: t.db }, [repo], now)).toBe(0);
  });

  it('【故意造出的失败】库连不上：原样抛出，不回 0 冒充「没有要撤的」', async () => {
    const broken = {
      transaction: async () => {
        throw new Error('连不上库');
      },
    } as unknown as typeof t.db;
    await expect(retireCloseSweepAlerts({ db: broken }, [repo], () => new Date())).rejects.toThrow(
      '连不上库',
    );
  });
});
