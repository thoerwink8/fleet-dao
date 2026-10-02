// 拉单的真装配（real/intake.ts，#632 S2-4b-3）：库是真的（PGlite 跑真迁移），GitHub 和 Temporal 客户端是假的。
// 从受管的仓到起任务工作流走一遍：任务行、操作记录、谁要的、工作流编号和起法；重复起、不在白名单、在跑的数读不到各故意造一次。
import { auditLog, type Db, registerScheduledJobs, repos, scheduleRuns, tasks, users } from '@fleet-dao/db';
import { createTestDb, resetTestDb, TEST_DB_TIMEOUT_MS, type TestDb } from '@fleet-dao/db/testing';
import { WorkflowExecutionAlreadyStartedError } from '@temporalio/client';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
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
}

async function seedWorld(db: Db, over: Seed = {}) {
  const [repo] = await db
    .insert(repos)
    .values({
      owner: 'acme',
      name: 'demo',
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
}

function fakeGh(over: { issues?: unknown[]; commentCreated?: boolean } = {}): {
  gh: IntakeGitHub;
  calls: GhCalls;
} {
  const calls: GhCalls = { groomed: 0, planned: [], comments: [] };
  const gh = {
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
  opts: { running?: number; listFails?: boolean; startFails?: (n: number) => Error | undefined } = {},
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
        return {};
      },
      list(query: { query: string }) {
        queries.push(query.query);
        return {
          async *[Symbol.asyncIterator]() {
            if (opts.listFails) throw new Error('可见性存储连不上');
            for (let i = 0; i < (opts.running ?? 0); i += 1) yield { workflowId: `task:x/y#${i}` };
          },
        };
      },
    },
  };
  return { client: client as never, starts, queries };
}

const logs: string[] = [];
const wire = (gh: IntakeGitHub) =>
  intakeJob({ db: t.db, gh, now: () => NOW, log: (_l, text) => logs.push(text), gateLive: true });

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
    // 第二轮：dispatched 仍是 false（还在排队），再试；这回服务端说同编号已经有了
    const second = fakeClient({
      startFails: () =>
        new WorkflowExecutionAlreadyStartedError('already', 'task:acme/demo#12', 'taskWorkflow'),
    });
    const run = await runIntakeJob(wire(gh)(second.client, 'fleet'));
    expect(run).toMatchObject({ outcome: 'ok', found: 0 });
    expect(await t.db.select().from(tasks)).toHaveLength(1);
    expect(second.starts).toHaveLength(1);
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
});
