// 拉单的真装配（real/intake.ts，#632 S2-4b-3）：库是真的（PGlite 跑真迁移），GitHub 和 Temporal 客户端是假的。
// 从受管的仓到起任务工作流走一遍：任务行、操作记录、谁要的、工作流编号和起法；重复起、不在白名单、在跑的数读不到各故意造一次。
import {
  auditLog,
  type Db,
  INTAKE_BREAKER_SETTING,
  notifications,
  readIntakeBreaker,
  registerScheduledJobs,
  repos,
  saveTaskSnapshot,
  scheduleRuns,
  settings,
  stateChanges,
  TASK_ADOPT_AUDIT_ACTION,
  tasks,
  upsertAlert,
  users,
  writeIntakeBreaker,
} from '@fleet-dao/db';
import { createTestDb, resetTestDb, TEST_DB_TIMEOUT_MS, type TestDb } from '@fleet-dao/db/testing';
import { WorkflowExecutionAlreadyStartedError, WorkflowNotFoundError } from '@temporalio/client';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { canaryIssueTitle } from '../../src/jobs/canary.ts';
import { ORPHAN_TASK_ADOPT_NOTE } from '../../src/jobs/dispatch-standing.ts';
import { INTAKE_JOB, runIntakeJob } from '../../src/jobs/intake.ts';
import { type IntakeGitHub, intakeJob } from '../../src/real/intake.ts';

let t: TestDb;
beforeAll(async () => {
  t = await createTestDb();
}, TEST_DB_TIMEOUT_MS);
afterAll(() => t.close());
beforeEach(async () => {
  await resetTestDb(t);
  await registerScheduledJobs(t.db, [{ ...INTAKE_JOB }]);
});

const NOW = new Date('2026-10-02T14:00:00.000Z');
const V1 = { number: 3, title: 'v1 三段一条龙' };
const BODY = [
  '## 场景',
  '',
  '创始人要在驾驶舱看到每张单走到哪一步。',
  '',
  '## 原话',
  '',
  '「我回来打开驾驶舱，这张单就该在做完的那一栏」',
  '',
  '## 已知的模块',
  '',
  '- `packages/web/src/pages/`：驾驶舱页面',
  '',
  '## 怎么算做完',
  '',
  '1. 页面上能看到「验收中」这个状态',
  '',
].join('\n');

interface Seed {
  repoSwitch?: Date | null;
  /** 仓名。巡检接线用 fleet-dao-canary，其余测试仍是 demo。 */
  name?: string;
}

async function seedWorld(db: Db, over: Seed = {}) {
  const [repo] = await db
    .insert(repos)
    .values({
      owner: 'acme',
      name: over.name ?? 'demo',
      testCommand: 'pnpm check',
      autoDispatchSince: over.repoSwitch === undefined ? new Date('2026-09-30T00:00:00Z') : over.repoSwitch,
    })
    .returning();
  const [founder] = await db
    .insert(users)
    .values({ displayName: '创始人', role: 'founder', githubId: 1, githubLogin: 'frank' })
    .returning();
  if (!repo || !founder) throw new Error('没写进去');
  return { repo, founder };
}

const groomIssue = (over: Record<string, unknown> = {}) => ({
  number: 12,
  title: '给驾驶舱加状态',
  body: BODY,
  author: 'frank',
  authorId: 1,
  authorType: 'User',
  authorIsBot: false,
  createdAt: '2026-10-01T00:00:00.000Z',
  updatedAt: '2026-10-01T00:00:00.000Z',
  labels: ['需求'],
  milestone: V1,
  ...over,
});

interface GhCalls {
  groomed: number;
  planned: number[];
  comments: { issueNumber: number; key: string; body: string }[];
  labeled: { issueNumber: number; label: string }[];
}

function fakeGh(
  over: {
    issues?: unknown[];
    commentCreated?: boolean;
    pulls?: { number: number; body: string }[];
    pullsFail?: boolean;
  } = {},
): {
  gh: IntakeGitHub;
  calls: GhCalls;
} {
  const calls: GhCalls = { groomed: 0, planned: [], comments: [], labeled: [] };
  const gh = {
    claims: {
      async openPulls() {
        if (over.pullsFail) throw new Error('PR 列表读不到');
        return over.pulls ?? [];
      },
    },
    async addIssueLabel(input: { issueNumber: number; label: string }) {
      calls.labeled.push({ issueNumber: input.issueNumber, label: input.label });
      return [input.label];
    },
    async readGroomFacts() {
      calls.groomed += 1;
      return {
        milestones: [
          { number: 3, title: V1.title, state: 'open' as const },
          { number: 2, title: 'v0 旧的', state: 'closed' as const },
        ],
        issues: over.issues ?? [groomIssue()],
      };
    },
    async readIssuePlan(input: { issueNumber: number }) {
      calls.planned.push(input.issueNumber);
      return {
        state: 'open' as const,
        reopened: false,
        pullRequest: false,
        author: 'frank',
        milestone: V1,
        openMilestones: [V1],
        labels: ['需求'],
        parent: null,
        subIssues: 0,
      };
    },
    async readSpecDoc() {
      return null;
    },
    async commentIssue(input: { issueNumber: number; key: string; body: string }) {
      calls.comments.push({ issueNumber: input.issueNumber, key: input.key, body: input.body });
      return { commentId: 1, url: 'u', created: over.commentCreated ?? true };
    },
  } as unknown as IntakeGitHub;
  return { gh, calls };
}

interface StartCall {
  type: string;
  options: Record<string, unknown>;
}

function fakeClient(
  opts: {
    running?: number;
    /** 在跑的工作流编号（写了就不用 running 造的编号）。 */
    runningIds?: string[];
    listFails?: boolean;
    startFails?: (n: number) => Error | undefined;
    /** describe 抛这个。不是 WorkflowNotFoundError 才算问不清。 */
    describeFails?: Error;
    /** 工作流编号 → Temporal 状态名。没写的编号当不存在。 */
    statuses?: Record<string, string>;
    /**
     * start 返回之前跑（模拟工作流第一步已经把任务行写成 running）。
     * 起失败时不跑：工作流没起来，不该有第一步。
     */
    onStart?: () => Promise<void> | void;
  } = {},
) {
  const starts: StartCall[] = [];
  const queries: string[] = [];
  const client = {
    connection: { withDeadline: async (_at: number, fn: () => Promise<unknown>) => fn() },
    workflow: {
      async start(type: string, options: Record<string, unknown>) {
        starts.push({ type, options });
        const err = opts.startFails?.(starts.length);
        if (err) throw err;
        await opts.onStart?.();
        return {};
      },
      getHandle(workflowId: string) {
        return {
          async describe() {
            if (opts.describeFails) throw opts.describeFails;
            const name = opts.statuses?.[workflowId];
            if (name === undefined) throw new WorkflowNotFoundError('not found', workflowId, undefined);
            return { status: { name } };
          },
        };
      },
      list(query: { query: string }) {
        queries.push(query.query);
        return {
          async *[Symbol.asyncIterator]() {
            if (opts.listFails) throw new Error('可见性存储连不上');
            if (opts.runningIds) {
              for (const workflowId of opts.runningIds) yield { workflowId };
              return;
            }
            for (let i = 0; i < (opts.running ?? 0); i += 1) yield { workflowId: `task:x/y#${i}` };
          },
        };
      },
    },
  };
  return { client: client as never, starts, queries };
}

const logs: string[] = [];
const wire = (gh: IntakeGitHub, over: { canaryRepo?: string } = {}) =>
  intakeJob({
    db: t.db,
    gh,
    now: () => NOW,
    log: (_l, text) => logs.push(text),
    gateLive: true,
    ...(over.canaryRepo === undefined ? {} : { canaryRepo: over.canaryRepo }),
  });

describe('拉单的真装配', { timeout: 60_000 }, () => {
  it('开关开着的仓里一张好单：建任务行（谁要的、原话）、记操作记录、按定死的编号起任务工作流，这一轮记 ok', async () => {
    const { repo, founder } = await seedWorld(t.db);
    const { gh } = fakeGh();
    const { client, starts, queries } = fakeClient({ running: 2 });
    const run = await runIntakeJob(wire(gh)(client, 'fleet'));
    // scanned = 受管的仓数加读到的单数
    expect(run).toMatchObject({ outcome: 'ok', scanned: 2, found: 1 });

    // 任务行
    const rows = await t.db.select().from(tasks);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      repoId: repo.id,
      issueNumber: 12,
      title: '给驾驶舱加状态',
      rawRequest: BODY,
      requestedBy: founder.id,
      state: 'queued',
    });
    // 操作记录
    const audit = (await t.db.select().from(auditLog)).filter((a) => a.action === 'task.create');
    expect(audit).toHaveLength(1);
    expect(audit[0]).toMatchObject({ target: `task:${rows[0]?.id}`, via: 'github', ok: true });
    // 起工作流：类型、编号、起法、输入
    expect(starts).toHaveLength(1);
    expect(starts[0]?.type).toBe('taskWorkflow');
    expect(starts[0]?.options).toMatchObject({
      taskQueue: 'fleet',
      workflowId: 'task:acme/demo#12',
      workflowIdConflictPolicy: 'FAIL',
      workflowIdReusePolicy: 'REJECT_DUPLICATE',
      args: [
        {
          schemaVersion: 1,
          taskId: rows[0]?.id,
          repo: {
            id: repo.id,
            owner: 'acme',
            name: 'demo',
            defaultBranch: 'main',
            testCommand: 'pnpm check',
          },
          issueNumber: 12,
          title: '给驾驶舱加状态',
        },
      ],
    });
    // 数在跑的：按工作流类型和状态查
    expect(queries).toEqual(["WorkflowType = 'taskWorkflow' AND ExecutionStatus = 'Running'"]);
    // 结局进了 schedule_runs
    const runs = await t.db.select().from(scheduleRuns);
    expect(runs).toHaveLength(1);
    expect(runs[0]).toMatchObject({ job: 'intake', outcome: 'ok' });
  });

  it('开关全关：不读 GitHub、不读在跑的数，这一轮也记 ok（正常的空闲），scanned 算上受管的仓', async () => {
    await seedWorld(t.db, { repoSwitch: null });
    const { gh, calls } = fakeGh();
    const { client, starts, queries } = fakeClient();
    const run = await runIntakeJob(wire(gh)(client, 'fleet'));
    expect(run).toMatchObject({ outcome: 'ok', scanned: 1, found: 0 });
    expect(calls.groomed).toBe(0);
    expect(queries).toEqual([]);
    expect(starts).toEqual([]);
  });

  it('同一张单拉两轮：第二轮任务还在排队（工作流没起成过）会再试，起工作流说编号用过了就当 already_exists——任务行始终只有一行', async () => {
    await seedWorld(t.db);
    const { gh } = fakeGh();
    // 第一轮起工作流出错（Temporal 暂时连不上）：这一张记没查成，任务行留在 queued
    const first = fakeClient({ startFails: () => new Error('14 UNAVAILABLE') });
    const partial = await runIntakeJob(wire(gh)(first.client, 'fleet'));
    expect(partial.outcome).toBe('partial');
    expect(partial.why).toContain('UNAVAILABLE');
    expect(await t.db.select().from(tasks)).toHaveLength(1);
    // 第二轮：行还在排队、Temporal 里仍然没有一代，再试；这回服务端说同编号已经有了
    const second = fakeClient({
      startFails: () =>
        new WorkflowExecutionAlreadyStartedError('already', 'task:acme/demo#12', 'taskWorkflow'),
    });
    const run = await runIntakeJob(wire(gh)(second.client, 'fleet'));
    expect(run).toMatchObject({ outcome: 'ok', found: 0 });
    expect(await t.db.select().from(tasks)).toHaveLength(1);
    expect(second.starts).toHaveLength(1);
  });

  const OLD = new Date('2026-09-01T00:00:00.000Z');

  /** 没有任务工作流的老行：历史列先写上，接手之后这些不该被清掉。 */
  async function seedOrphan(repoId: string, over: Partial<typeof tasks.$inferInsert> = {}) {
    const [row] = await t.db
      .insert(tasks)
      .values({
        repoId,
        issueNumber: 12,
        title: 'Fusion 留下的标题',
        rawRequest: 'Fusion 留下的原话',
        requestedBy: 'old-founder',
        priority: 7,
        state: 'queued',
        phase: '分诊',
        doing: '等着',
        lastProblem: '上次卡在部署',
        docs: { requirement: 'specs/405/需求.md' },
        acceptance: ['页面上能看到状态'],
        specDir: 'specs/405-fleet-api-socket-activation部署',
        createdAt: OLD,
        ...over,
      })
      .returning();
    if (!row) throw new Error('老行没写进去');
    return row;
  }

  it('排队的老行、没有任何一代：接手这一行再派，不另建、不删历史', async () => {
    const { repo } = await seedWorld(t.db);
    const old = await seedOrphan(repo.id);
    const { gh } = fakeGh();
    const { client, starts } = fakeClient();
    const run = await runIntakeJob(wire(gh)(client, 'fleet'));
    expect(run).toMatchObject({ outcome: 'ok', found: 1 });
    const rows = await t.db.select().from(tasks);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      id: old.id,
      title: '给驾驶舱加状态',
      rawRequest: BODY,
      requestedBy: 'old-founder',
      priority: 7,
      state: 'queued',
      phase: '分诊',
      doing: '等着',
      lastProblem: '上次卡在部署',
      acceptance: ['页面上能看到状态'],
      specDir: 'specs/405-fleet-api-socket-activation部署',
      docs: { requirement: 'specs/405/需求.md' },
    });
    expect(rows[0]?.createdAt.toISOString()).toBe(OLD.toISOString());
    expect(starts).toHaveLength(1);
    expect(starts[0]?.options).toMatchObject({
      workflowId: 'task:acme/demo#12',
      args: [{ taskId: old.id, title: '给驾驶舱加状态' }],
    });
    const audit = (await t.db.select().from(auditLog)).filter((a) => a.target === `task:${old.id}`);
    expect(audit.map((a) => a.action)).toEqual([TASK_ADOPT_AUDIT_ACTION]);
    expect(audit[0]).toMatchObject({ ok: true, reason: ORPHAN_TASK_ADOPT_NOTE, via: 'github' });
  });

  it('已叫停的老行、没有任何一代：接手后改回排队，原来的状态变化还在', async () => {
    const { repo } = await seedWorld(t.db);
    const old = await seedOrphan(repo.id, { state: 'stopped' });
    const before = (await t.db.select().from(stateChanges)).slice().sort((a, b) => a.id - b.id);
    expect(before.map((c) => c.toState)).toEqual(['stopped']);
    const { gh } = fakeGh();
    const { client, starts } = fakeClient();
    const run = await runIntakeJob(wire(gh)(client, 'fleet'));
    expect(run).toMatchObject({ outcome: 'ok', found: 1 });
    const rows = await t.db.select().from(tasks);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      id: old.id,
      state: 'queued',
      title: '给驾驶舱加状态',
      requestedBy: 'old-founder',
      priority: 7,
      lastProblem: '上次卡在部署',
    });
    expect(rows[0]?.createdAt.toISOString()).toBe(OLD.toISOString());
    const after = (await t.db.select().from(stateChanges)).slice().sort((a, b) => a.id - b.id);
    expect(after.map((c) => [c.fromState, c.toState])).toEqual([
      [null, 'stopped'],
      ['stopped', 'queued'],
    ]);
    expect(starts[0]?.options).toMatchObject({ args: [{ taskId: old.id }] });
    const adopt = (await t.db.select().from(auditLog)).filter((a) => a.action === TASK_ADOPT_AUDIT_ACTION);
    expect(adopt).toHaveLength(1);
    expect(adopt[0]?.reason).toBe(ORPHAN_TASK_ADOPT_NOTE);
  });

  it('工作流第一步先把行改成 running：标题和原话已经是当前这一代，接手成功只记一条', async () => {
    const { repo } = await seedWorld(t.db);
    const old = await seedOrphan(repo.id, { state: 'stopped' });
    const { gh } = fakeGh();
    const { client, starts } = fakeClient({
      onStart: async () => {
        const saved = await saveTaskSnapshot(t.db, {
          taskId: old.id,
          state: 'running',
          phase: '收单',
          doing: '正在读单',
          lastProblem: null,
          subtasks: [],
        });
        if (saved !== 'saved') throw new Error('工作流快照没写上');
      },
    });
    const run = await runIntakeJob(wire(gh)(client, 'fleet'));
    expect(run).toMatchObject({ outcome: 'ok', found: 1 });
    expect(starts).toHaveLength(1);
    const rows = await t.db.select().from(tasks);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      id: old.id,
      title: '给驾驶舱加状态',
      rawRequest: BODY,
      state: 'running',
      phase: '收单',
      doing: '正在读单',
      lastProblem: null,
      requestedBy: 'old-founder',
      priority: 7,
      specDir: 'specs/405-fleet-api-socket-activation部署',
      docs: { requirement: 'specs/405/需求.md' },
      acceptance: ['页面上能看到状态'],
    });
    expect(rows[0]?.createdAt.toISOString()).toBe(OLD.toISOString());
    const changes = (await t.db.select().from(stateChanges)).slice().sort((a, b) => a.id - b.id);
    expect(changes.map((c) => [c.fromState, c.toState])).toEqual([
      [null, 'stopped'],
      ['stopped', 'queued'],
      ['queued', 'running'],
    ]);
    const adopt = (await t.db.select().from(auditLog)).filter((a) => a.action === TASK_ADOPT_AUDIT_ACTION);
    expect(adopt).toHaveLength(1);
    expect(adopt[0]).toMatchObject({ ok: true, reason: ORPHAN_TASK_ADOPT_NOTE });
  });

  it('老行还没起成工作流：标题和状态放回去，不记接手成功', async () => {
    const { repo } = await seedWorld(t.db);
    const old = await seedOrphan(repo.id, { state: 'stopped' });
    const { client, starts } = fakeClient({ startFails: () => new Error('14 UNAVAILABLE') });
    const run = await runIntakeJob(wire(fakeGh().gh)(client, 'fleet'));
    expect(run.outcome).toBe('partial');
    expect(run.why).toContain('UNAVAILABLE');
    expect(starts).toHaveLength(1);
    const rows = await t.db.select().from(tasks);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      id: old.id,
      title: 'Fusion 留下的标题',
      rawRequest: 'Fusion 留下的原话',
      state: 'stopped',
      phase: '分诊',
      doing: '等着',
      lastProblem: '上次卡在部署',
      requestedBy: 'old-founder',
      priority: 7,
    });
    expect((await t.db.select().from(auditLog)).filter((a) => a.action === TASK_ADOPT_AUDIT_ACTION)).toEqual(
      [],
    );
  });

  it('有一代在跑：不接手、不起，标题不动', async () => {
    const { repo } = await seedWorld(t.db);
    await seedOrphan(repo.id);
    const { gh, calls } = fakeGh();
    const { client, starts } = fakeClient({ statuses: { 'task:acme/demo#12': 'RUNNING' } });
    const run = await runIntakeJob(wire(gh)(client, 'fleet'));
    expect(run).toMatchObject({ outcome: 'ok', found: 0 });
    expect(calls.planned).toEqual([]);
    expect(starts).toEqual([]);
    expect((await t.db.select().from(tasks))[0]?.title).toBe('Fusion 留下的标题');
    expect((await t.db.select().from(auditLog)).filter((a) => a.action === TASK_ADOPT_AUDIT_ACTION)).toEqual(
      [],
    );
  });

  it('已做完的一代：不接手、不起', async () => {
    const { repo } = await seedWorld(t.db);
    await seedOrphan(repo.id, { state: 'done' });
    const { client, starts } = fakeClient({ statuses: { 'task:acme/demo#12': 'COMPLETED' } });
    const run = await runIntakeJob(wire(fakeGh().gh)(client, 'fleet'));
    expect(run).toMatchObject({ outcome: 'ok', found: 0 });
    expect(starts).toEqual([]);
    expect((await t.db.select().from(tasks))[0]).toMatchObject({ state: 'done', title: 'Fusion 留下的标题' });
  });

  it('已经派出去的（任务行不在排队）：不再读这张单的现状、不再起', async () => {
    const { repo } = await seedWorld(t.db);
    await t.db.insert(tasks).values({
      repoId: repo.id,
      issueNumber: 12,
      title: 'x',
      rawRequest: 'y',
      requestedBy: 'founder',
      priority: 1,
      state: 'running',
    });
    const { gh, calls } = fakeGh();
    const { client, starts } = fakeClient();
    const run = await runIntakeJob(wire(gh)(client, 'fleet'));
    expect(run).toMatchObject({ outcome: 'ok', found: 0 });
    expect(calls.planned).toEqual([]);
    expect(starts).toEqual([]);
  });

  it('【故意造出的失败】作者不在白名单 / 账号删了读不到编号 / 成员被停用：都不派', async () => {
    await seedWorld(t.db);
    const stranger = groomIssue({ number: 21, author: 'stranger', authorId: 777 });
    const deleted = groomIssue({ number: 22, author: null, authorId: null, authorType: null });
    const { gh } = fakeGh({ issues: [stranger, deleted] });
    const a = fakeClient();
    expect(await runIntakeJob(wire(gh)(a.client, 'fleet'))).toMatchObject({ outcome: 'ok', found: 0 });
    expect(a.starts).toEqual([]);

    // 创始人被停用后，下一轮他开的单也不认（名单每轮重读，不跨轮缓存）
    await t.db.update(users).set({ active: false }); // 库里只有这一位
    const { gh: gh2 } = fakeGh();
    const b = fakeClient();
    expect(await runIntakeJob(wire(gh2)(b.client, 'fleet'))).toMatchObject({ outcome: 'ok', found: 0 });
    expect(b.starts).toEqual([]);
  });

  it('【故意造出的失败】在跑的任务数读不到（Temporal 可见性连不上）：这一轮记没跑成，一张单都没起——不拿 0 顶', async () => {
    await seedWorld(t.db);
    const { gh } = fakeGh();
    const { client, starts } = fakeClient({ listFails: true });
    await expect(runIntakeJob(wire(gh)(client, 'fleet'))).rejects.toThrow(/在跑的任务数读不到/);
    expect(starts).toEqual([]);
    expect(await t.db.select().from(tasks)).toHaveLength(0);
    const runs = await t.db.select().from(scheduleRuns);
    expect(runs[0]).toMatchObject({ outcome: 'failed' });
  });

  it('在跑的数去掉任务行是 stalled 的（#1776）：6 条在跑里 6 条停下等人，不占名额，照起', async () => {
    const { repo } = await seedWorld(t.db);
    const ids: string[] = [];
    for (let n = 101; n <= 106; n += 1) {
      await t.db.insert(tasks).values({
        repoId: repo.id,
        issueNumber: n,
        title: 'x',
        rawRequest: 'y',
        requestedBy: 'founder',
        priority: 1,
        state: 'stalled',
      });
      ids.push(`task:acme/demo#${n}`);
    }
    const { gh } = fakeGh();
    const { client, starts } = fakeClient({ runningIds: ids });
    logs.length = 0;
    await runIntakeJob(wire(gh)(client, 'fleet'));
    expect(logs.join(' | ')).toContain('不占名额 6 条（停下/追问/暂停）');
    expect(starts).toHaveLength(1);
  });

  it('在跑的数：一条停下、其余在干活（含没有任务行的、二代编号）→ 只去掉停下的那条', async () => {
    const { repo } = await seedWorld(t.db);
    for (const [n, state] of [
      [101, 'stalled'],
      [102, 'running'],
    ] as const) {
      await t.db.insert(tasks).values({
        repoId: repo.id,
        issueNumber: n,
        title: 'x',
        rawRequest: 'y',
        requestedBy: 'founder',
        priority: 1,
        state,
      });
    }
    const { gh } = fakeGh();
    const { client } = fakeClient({
      runningIds: [
        'task:acme/demo#101:r2',
        'task:acme/demo#102',
        'task:acme/demo#103',
        'task:other/x#1',
        'task:acme/demo#104',
        'task:acme/demo#105',
      ],
    });
    logs.length = 0;
    await runIntakeJob(wire(gh)(client, 'fleet'));
    expect(logs.join(' | ')).toContain('开头在干活 5 条、不占名额 1 条（停下/追问/暂停）');
  });

  it('在跑的数去掉追问和暂停（#1795）：6 条全是 asking / phase=paused，不占名额，照起', async () => {
    const { repo } = await seedWorld(t.db);
    const ids: string[] = [];
    for (let n = 101; n <= 106; n += 1) {
      const asking = n % 2 === 0;
      await t.db.insert(tasks).values({
        repoId: repo.id,
        issueNumber: n,
        title: 'x',
        rawRequest: 'y',
        requestedBy: 'founder',
        priority: 1,
        state: asking ? 'asking' : 'running',
        phase: asking ? 'implement' : 'paused',
      });
      ids.push(`task:acme/demo#${n}`);
    }
    const { gh } = fakeGh();
    const { client, starts } = fakeClient({ runningIds: ids });
    logs.length = 0;
    await runIntakeJob(wire(gh)(client, 'fleet'));
    expect(logs.join(' | ')).toContain('不占名额 6 条（停下/追问/暂停）');
    expect(starts).toHaveLength(1);
  });

  it('交代不全：在单子上留言（幂等键由缺的内容算出），不建任务行、不起', async () => {
    await seedWorld(t.db);
    const { gh, calls } = fakeGh({ issues: [groomIssue({ body: '## 场景\n\n只写了场景' })] });
    const { client, starts } = fakeClient();
    const run = await runIntakeJob(wire(gh)(client, 'fleet'));
    expect(run).toMatchObject({ outcome: 'ok', found: 1 });
    expect(calls.comments).toHaveLength(1);
    expect(calls.comments[0]?.key).toMatch(/^intake-incomplete:/);
    expect(calls.comments[0]?.body).toContain('原话');
    expect(starts).toEqual([]);
    expect(await t.db.select().from(tasks)).toHaveLength(0);
  });

  it('被开着的 PR 的「需求」栏挂着的单（#1197）：经「引擎」读 PR 列表、贴「本机做」、留言，不建任务行、不起；读不到 PR 列表不拉也不贴', async () => {
    await seedWorld(t.db);
    const claimed = fakeGh({ pulls: [{ number: 40, body: '**做了什么**：x\n\n**需求**：Closes #12' }] });
    const { client, starts } = fakeClient();
    const run = await runIntakeJob(wire(claimed.gh)(client, 'fleet'));
    expect(run).toMatchObject({ outcome: 'ok', found: 1 });
    expect(claimed.calls.labeled).toEqual([{ issueNumber: 12, label: '本机做' }]);
    expect(claimed.calls.comments[0]?.key).toBe('intake-pr-claimed:40');
    expect(starts).toEqual([]);
    expect(await t.db.select().from(tasks)).toHaveLength(0);

    const broken = fakeGh({ pullsFail: true });
    const second = await runIntakeJob(wire(broken.gh)(fakeClient().client, 'fleet'));
    expect(second.outcome).toBe('partial');
    expect(second.why).toContain('PR 列表读不到');
    expect(broken.calls.labeled).toEqual([]);
    expect(broken.calls.comments).toEqual([]);
    expect(await t.db.select().from(tasks)).toHaveLength(0);
  });

  it('没挂里程碑的单、整理过的老单：照样建任务行、起工作流；没整理过的老单不拉，并真的叫了一次整理待办（#1338）', async () => {
    await seedWorld(t.db);
    await t.db.insert(settings).values({ key: 'engine.master', value: true, updatedBy: 'test' });
    const old = groomIssue({
      number: 31,
      createdAt: '2026-09-01T00:00:00.000Z',
      milestone: V1,
      labels: ['需求', '整理过'],
    });
    const ungroomed = groomIssue({ number: 33, createdAt: '2026-09-01T00:00:00.000Z', milestone: V1 });
    const unscheduled = groomIssue({ number: 32, milestone: null });
    const { gh } = fakeGh({ issues: [old, ungroomed, unscheduled] });
    const { client, starts } = fakeClient();
    const run = await runIntakeJob(wire(gh)(client, 'fleet'));
    expect(run).toMatchObject({ outcome: 'ok', found: 2 });
    expect(starts.map((s) => s.options.workflowId)).toEqual(['task:acme/demo#31', 'task:acme/demo#32']);
    expect((await t.db.select().from(tasks)).map((r) => r.issueNumber).sort()).toEqual([31, 32]);
    // 有从没整理过的老单 → 记了一条「点了」（来源 auto），引擎的接手另行处理
    const asks = (await t.db.select().from(auditLog)).filter((a) => a.target === 'groom');
    expect(asks.map((a) => a.action)).toEqual(['groom.request']);
    expect(asks[0]?.after).toMatchObject({ repo: 'acme/demo', source: 'auto' });
  });

  it('【故意造出的失败】总开关没开时，没整理过的老单照样不拉，叫整理被拒：不记「点了」', async () => {
    await seedWorld(t.db);
    const ungroomed = groomIssue({ number: 33, createdAt: '2026-09-01T00:00:00.000Z', milestone: V1 });
    const { gh } = fakeGh({ issues: [ungroomed] });
    const { client, starts } = fakeClient();
    const run = await runIntakeJob(wire(gh)(client, 'fleet'));
    expect(run.outcome).toBe('ok');
    expect(starts).toEqual([]);
    expect((await t.db.select().from(auditLog)).filter((a) => a.target === 'groom')).toEqual([]);
  });
});

describe('拉单的真装配 · 每小时限速和熔断（读真库）', { timeout: 60_000 }, () => {
  const HOURS = 60 * 60_000;

  /** 往库里补一批已有的任务行（各占一个号，状态各异），建出时刻定死。 */
  async function seedTasks(
    repoId: string,
    specs: { issue: number; state: 'done' | 'failed' | 'running'; createdAt: Date; title?: string }[],
  ) {
    await t.db.insert(tasks).values(
      specs.map((s) => ({
        repoId,
        issueNumber: s.issue,
        title: s.title ?? `旧任务 ${s.issue}`,
        rawRequest: '原话',
        requestedBy: 'founder',
        priority: s.issue,
        state: s.state,
        createdAt: s.createdAt,
      })),
    );
  }
  const longAgo = new Date(NOW.getTime() - 10 * HOURS);

  /** n 条一小时内建出的任务行（5 分钟一条往前排，最老的 59 分钟前），任务号从 101 起。 */
  const recentRows = (n: number) =>
    Array.from({ length: n }, (_, i) => ({
      issue: 101 + i,
      state: 'running' as const,
      createdAt: new Date(NOW.getTime() - Math.min(59, 5 * (i + 1)) * 60_000),
    }));

  it('一小时内已经建出 20 条任务行：这一轮一条都不起，也不去现读那张单', async () => {
    const { repo } = await seedWorld(t.db);
    await seedTasks(repo.id, recentRows(20));
    const { gh, calls } = fakeGh();
    const { client, starts } = fakeClient();
    const run = await runIntakeJob(wire(gh)(client, 'fleet'));
    expect(run.outcome).toBe('ok');
    expect(starts).toEqual([]);
    expect(calls.planned).toEqual([]);
  });

  it('近一小时 20 条里有 1 条是巡检仓的巡检单：不计入，普通单还能再起 1 条', async () => {
    const { repo } = await seedWorld(t.db, { name: 'fleet-dao-canary' });
    const recent = (min: number) => new Date(NOW.getTime() - min * 60_000);
    await seedTasks(repo.id, [
      ...recentRows(19),
      { issue: 150, state: 'done', createdAt: recent(30), title: canaryIssueTitle(4) },
    ]);
    const { gh } = fakeGh();
    const { client, starts } = fakeClient();
    const run = await runIntakeJob(wire(gh, { canaryRepo: 'acme/fleet-dao-canary' })(client, 'fleet'));
    expect(run.outcome).toBe('ok');
    expect(starts).toHaveLength(1);
  });

  it('近一小时 20 条普通任务已经把名额用满：巡检单仍被拉起', async () => {
    const { repo } = await seedWorld(t.db, { name: 'fleet-dao-canary' });
    await seedTasks(repo.id, recentRows(20));
    const { gh } = fakeGh({
      issues: [groomIssue({ number: 70, title: canaryIssueTitle(9) })],
    });
    const { client, starts } = fakeClient();
    const run = await runIntakeJob(wire(gh, { canaryRepo: 'acme/fleet-dao-canary' })(client, 'fleet'));
    expect(run.outcome).toBe('ok');
    expect(starts).toHaveLength(1);
    expect(starts[0]?.options).toMatchObject({ workflowId: 'task:acme/fleet-dao-canary#70' });
  });

  it('一小时内接手成功 20 条老行：和新建一样占满名额，这一轮不起、也不去现读', async () => {
    const { repo } = await seedWorld(t.db);
    const createdAt = new Date(NOW.getTime() - 2 * HOURS);
    await seedTasks(
      repo.id,
      Array.from({ length: 20 }, (_, i) => ({ issue: 101 + i, state: 'running' as const, createdAt })),
    );
    const rows = await t.db.select().from(tasks);
    await t.db.insert(auditLog).values(
      rows.map((r) => ({
        at: new Date(NOW.getTime() - 10 * 60_000),
        actorKind: 'engine' as const,
        actorId: 'engine:intake',
        action: TASK_ADOPT_AUDIT_ACTION,
        target: `task:${r.id}`,
        via: 'github' as const,
        ok: true,
        reason: ORPHAN_TASK_ADOPT_NOTE,
      })),
    );
    const { gh, calls } = fakeGh();
    const { client, starts } = fakeClient();
    const run = await runIntakeJob(wire(gh)(client, 'fleet'));
    expect(run.outcome).toBe('ok');
    expect(starts).toEqual([]);
    expect(calls.planned).toEqual([]);
  });

  it('一小时前建的不算：20 条都是 61 分钟前，照起', async () => {
    const { repo } = await seedWorld(t.db);
    await seedTasks(
      repo.id,
      Array.from({ length: 20 }, (_, i) => ({
        issue: 101 + i,
        state: 'running' as const,
        createdAt: new Date(NOW.getTime() - 61 * 60_000),
      })),
    );
    const { gh } = fakeGh();
    const { client, starts } = fakeClient();
    await runIntakeJob(wire(gh)(client, 'fleet'));
    expect(starts).toHaveLength(1);
  });

  it('最近 6 条结束的任务里失败 4 条：进入熔断——不起、设置表记下 open、推一条报警；下一轮冷却没到还是不起，不再推第二条', async () => {
    const { repo } = await seedWorld(t.db);
    const states = ['failed', 'failed', 'done', 'failed', 'done', 'failed'] as const;
    await seedTasks(
      repo.id,
      states.map((state, i) => ({ issue: 201 + i, state, createdAt: longAgo })),
    );
    const { gh } = fakeGh();
    const first = fakeClient();
    await runIntakeJob(wire(gh)(first.client, 'fleet'));
    expect(first.starts).toEqual([]);
    const row = await readIntakeBreaker(t.db);
    expect(row).toMatchObject({ state: 'open' });
    const alerts = await t.db.select().from(notifications);
    expect(alerts.filter((a) => a.dedupeKey === 'intake-breaker' && a.resolvedAt === null)).toHaveLength(1);

    const again = fakeClient();
    await runIntakeJob(wire(gh)(again.client, 'fleet'));
    expect(again.starts).toEqual([]);
    expect(
      (await t.db.select().from(notifications)).filter((a) => a.dedupeKey.startsWith('intake-breaker')),
    ).toHaveLength(1);
  });

  it('熔断着、冷却完了：只放 1 条试探；试探那条做成了，下一轮恢复——设置表记 closed、撤掉报警、推一条恢复通知', async () => {
    await seedWorld(t.db);
    // 3 小时前进入熔断（报警还开着）
    const openedAt = new Date(NOW.getTime() - 3 * HOURS);
    await writeIntakeBreaker(t.db, { state: 'open', at: openedAt, by: 'test' });
    await upsertAlert(t.db, {
      dedupeKey: 'intake-breaker',
      level: 'alert',
      taskId: null,
      title: '停拉',
      body: 'x',
    });
    const { gh } = fakeGh({
      issues: [groomIssue({ number: 11 }), groomIssue({ number: 12 })],
    });
    const trial = fakeClient();
    await runIntakeJob(wire(gh)(trial.client, 'fleet'));
    expect(trial.starts).toHaveLength(1); // 只放 1 条试探
    const [made] = await t.db.select().from(tasks);
    expect(made?.state).toBe('queued');

    // 试探那条做成了
    if (!made) throw new Error('试探的任务行没建出来');
    await saveTaskSnapshot(t.db, {
      taskId: made.id,
      state: 'done',
      phase: '收尾',
      doing: '做完了',
      lastProblem: null,
      subtasks: [],
    });
    const next = fakeClient();
    await runIntakeJob(wire(gh)(next.client, 'fleet'));
    expect(await readIntakeBreaker(t.db)).toMatchObject({ state: 'closed' });
    const all = await t.db.select().from(notifications);
    expect(all.find((a) => a.dedupeKey === 'intake-breaker')?.resolvedAt).not.toBeNull();
    expect(all.filter((a) => a.dedupeKey.startsWith('intake-breaker:recovered'))).toHaveLength(1);
    // 恢复的这一轮照常拉：试探用掉了 #11，没派过的 #12 这一轮起来
    expect(next.starts).toHaveLength(1);
  });

  it('【故意造出的失败】熔断状态那一行的值认不出：这一轮记没跑成，一张都不起，不当成正常', async () => {
    await seedWorld(t.db);
    await t.db.insert(settings).values({ key: INTAKE_BREAKER_SETTING, value: { state: '半开' } });
    const { gh } = fakeGh();
    const { client, starts } = fakeClient();
    await expect(runIntakeJob(wire(gh)(client, 'fleet'))).rejects.toThrow(/认不出/);
    expect(starts).toEqual([]);
  });
});

describe('拉单的真装配 · 查工作流没查成（放最后）', { timeout: 60_000 }, () => {
  it('【故意造出的失败】describe 抛错：这张记没查成，不当成没有工作流，老行不动、不另建', async () => {
    const { repo } = await seedWorld(t.db);
    const [old] = await t.db
      .insert(tasks)
      .values({
        repoId: repo.id,
        issueNumber: 12,
        title: '旧标题',
        rawRequest: '旧原话',
        requestedBy: 'old-founder',
        priority: 4,
        state: 'queued',
        lastProblem: '上次卡在部署',
      })
      .returning();
    const { client, starts } = fakeClient({ describeFails: new Error('UNAVAILABLE') });
    const run = await runIntakeJob(wire(fakeGh().gh)(client, 'fleet'));
    expect(run.outcome).toBe('partial');
    expect(run.why).toContain('不确定');
    expect(run.why).toContain('没有当成没有工作流');
    expect(starts).toEqual([]);
    const rows = await t.db.select().from(tasks);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      id: old?.id,
      title: '旧标题',
      state: 'queued',
      lastProblem: '上次卡在部署',
    });
    expect((await t.db.select().from(auditLog)).filter((a) => a.action === TASK_ADOPT_AUDIT_ACTION)).toEqual(
      [],
    );
  });
});
