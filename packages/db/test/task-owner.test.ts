// 新旧并行的认领（决定 0124，#3773）：一张单只有 tasks 那一行，owner 分新旧系统，fencing 由触发器在所有权变化时加一。
import { randomUUID } from 'node:crypto';
import { and, eq } from 'drizzle-orm';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
// 三个入口在别的包里（db 不倒过来依赖它们）。这几行要写进 packages/db/tsconfig.json 的 include，
// 否则 tsc -b 报 TS6307：复合项目不能凭相对路径把包外的 .ts 拉进来。
import { type DispatchIssueDeps, dispatchIssue } from '../../engine/src/jobs/dispatch-issue.ts';
import { acquireTask } from '../../harness-dispatch/src/task-claim.ts';
import { createPgStore } from '../../store/src/pg-store.ts';
import { intakeTaskRow } from '../src/queries/intake.ts';
import { claimLocalTask } from '../src/queries/local-claims.ts';
import { stopTaskRows } from '../src/queries/reconcile.ts';
import { handoffExpiredOwner } from '../src/queries/task-owner.ts';
import { runs, tasks } from '../src/schema/index.ts';
import { createTestDb, resetTestDb, TEST_DB_TIMEOUT_MS, type TestDb } from '../src/testing.ts';
import { addRepo, addRoute, addRun, addTask, ago, catalog, HOUR, NOW } from './helpers.ts';

let t: TestDb;
beforeAll(async () => {
  t = await createTestDb();
}, TEST_DB_TIMEOUT_MS);
afterAll(() => t.close());
beforeEach(() => resetTestDb(t));

const fencingOf = async (id: string) =>
  (await t.db.select({ f: tasks.fencing }).from(tasks).where(eq(tasks.id, id)))[0]?.f;

/** 读 tasks.owner 这一列。四个入口的用例都从这里看，确认写的是同一张表。 */
const ownerOf = async (id: string) =>
  (await t.db.select({ owner: tasks.owner, doing: tasks.doing }).from(tasks).where(eq(tasks.id, id)))[0];

/** 建仓加第 7 号单，回 [仓 id, 任务 id]。 */
async function seed(): Promise<[string, string]> {
  const repo = await addRepo(t.db, 'app');
  const task = await addTask(t.db, repo.id, { issueNumber: 7 });
  return [repo.id, task.id];
}

describe('tasks.owner 和 fencing', () => {
  it('新行默认 v1、令牌 0；读口带出 owner', async () => {
    const [repo, id] = await seed();
    expect(await fencingOf(id)).toBe(0);
    expect(await intakeTaskRow(t.db, repo, 7)).toMatchObject({ owner: 'v1' });
  });

  it('owner、executor、claimed_by 变了令牌加一；别的列变了不动；写方自己改令牌被盖回去', async () => {
    const [, id] = await seed();
    await t.db.update(tasks).set({ doing: '写测试' }).where(eq(tasks.id, id));
    expect(await fencingOf(id)).toBe(0);
    await t.db.update(tasks).set({ owner: 'harness' }).where(eq(tasks.id, id));
    expect(await fencingOf(id)).toBe(1);
    await t.db.update(tasks).set({ claimedBy: 'node-a' }).where(eq(tasks.id, id));
    expect(await fencingOf(id)).toBe(2);
    await t.db.update(tasks).set({ executor: 'local' }).where(eq(tasks.id, id));
    expect(await fencingOf(id)).toBe(3);
    await t.db.update(tasks).set({ fencing: 99 }).where(eq(tasks.id, id));
    expect(await fencingOf(id)).toBe(3);
  });

  it('认不出的 owner 被库拒', async () => {
    const [, id] = await seed();
    await expect(
      t.db
        .update(tasks)
        .set({ owner: 'v3' as 'v1' })
        .where(eq(tasks.id, id)),
    ).rejects.toThrow();
  });

  it('新内核的单：本机领单拒、旧对账收行不碰', async () => {
    const [, id] = await seed();
    await t.db.update(tasks).set({ owner: 'harness' }).where(eq(tasks.id, id));
    const claim = await claimLocalTask(t.db, {
      repo: 'acme/app',
      issueNumber: 7,
      title: 't',
      nodeId: 'founder-pc',
      now: NOW,
    });
    expect(claim).toMatchObject({ ok: false, code: 'engine_has_it' });
    expect(claim.ok ? '' : claim.why).toContain('新内核');
    expect(await stopTaskRows(t.db, [id], '单已关')).toBe(0);
    const [r] = await t.db
      .select({ state: tasks.state, owner: tasks.owner })
      .from(tasks)
      .where(eq(tasks.id, id));
    expect(r).toMatchObject({ owner: 'harness' });
    expect(r?.state).not.toBe('stopped');
  });

  it('租约过期、原会话还在：标成待确认释放，所有权不转；会话结束后才转手', async () => {
    await catalog(t.db);
    await addRoute(t.db, { id: 'kimi-r', poolId: 'relay-a', modelId: 'kimi-k3', hostId: 'mirasim' });
    const repo = await addRepo(t.db, 'app');
    const task = await addTask(t.db, repo.id, { issueNumber: 7, leaseUntil: ago(HOUR) });
    const run = await addRun(t.db, { taskId: task.id, routeId: 'kimi-r' });

    const held = await handoffExpiredOwner(t.db, { taskId: task.id, now: NOW, to: 'harness' });
    expect(held).toEqual({ transferred: false, marked: true, owner: 'v1' });
    expect(await ownerOf(task.id)).toMatchObject({ owner: 'v1', doing: '待确认释放' });
    expect(await fencingOf(task.id)).toBe(0);

    await t.db.update(runs).set({ endedAt: NOW, outcome: 'done' }).where(eq(runs.id, run.id));
    const moved = await handoffExpiredOwner(t.db, { taskId: task.id, now: NOW, to: 'harness' });
    expect(moved).toEqual({ transferred: true, owner: 'harness' });
    expect(await ownerOf(task.id)).toMatchObject({ owner: 'harness', doing: null });
    expect(await fencingOf(task.id)).toBe(1);
  });

  it('旧引擎拉单写的是 tasks.owner', async () => {
    const repo = await addRepo(t.db, 'app');
    const id = randomUUID();
    const created = await createPgStore(t.db, { now: () => NOW }).createTaskFromIssue(
      {
        id,
        repoId: repo.id,
        issueNumber: 7,
        title: 't',
        rawRequest: '原话',
        requestedBy: 'founder-a',
      },
      {
        actor: { kind: 'engine', id: 'intake' },
        action: 'task.create',
        target: `task:${id}`,
        via: 'github',
        ok: true,
      },
    );
    expect(created.created).toBe(true);
    expect(await ownerOf(id)).toMatchObject({ owner: 'v1' });
  });

  it('点名派单写的是 tasks.owner', async () => {
    const repo = await addRepo(t.db, 'app');
    const id = randomUUID();
    const issueBody = [
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
    const deps: DispatchIssueDeps = {
      db: t.db,
      findRepo: async () => ({
        id: repo.id,
        owner: 'acme',
        name: 'app',
        defaultBranch: 'main',
        testCommand: 'pnpm check',
        autoDispatchSince: null,
      }),
      engineMasterRow: async () => ({ value: true, updatedBy: 'u1', updatedAt: NOW.toISOString() }),
      whitelist: async () => ({
        userIds: new Set([1]),
        logins: new Set<string>(),
        botIds: new Set<number>(),
      }),
      plan: async () => ({
        state: 'open',
        pullRequest: false,
        milestone: { number: 3, title: 'v1 三段一条龙' },
        openMilestones: [
          { number: 3, title: 'v1 三段一条龙' },
          { number: 4, title: 'v2 下一版' },
        ],
        labels: ['需求'],
        parent: null,
        subIssues: 0,
      }),
      listIssue: async () => ({
        number: 7,
        title: '给驾驶舱加状态',
        body: issueBody,
        author: { login: 'frank', id: 1, type: 'User' },
        createdAt: '2026-10-01T00:00:00.000Z',
        labels: ['需求'],
        milestone: { number: 3, title: 'v1 三段一条龙' },
      }),
      issueTask: async () => {
        const [row] = await t.db
          .select({
            id: tasks.id,
            state: tasks.state,
            executor: tasks.executor,
            owner: tasks.owner,
          })
          .from(tasks)
          .where(and(eq(tasks.repoId, repo.id), eq(tasks.issueNumber, 7)));
        return row ?? null;
      },
      taskGenerations: async () => ({ ok: true, lives: [] }),
      openPrClaims: async () => new Map(),
      prerequisiteStates: async () => new Map(),
      now: () => NOW,
      readSpecDoc: async () => null,
      failedAttempts: async () => 0,
      // 准入过了才建行（和真装配的 start 一样：先有行，派成之后再写 owner）。
      start: async () => {
        await addTask(t.db, repo.id, { id, issueNumber: 7 });
        return 'started';
      },
      audit: async () => {},
    };
    const result = await dispatchIssue(deps, { owner: 'acme', name: 'app', issueNumber: 7, force: false });
    expect(result, JSON.stringify(result)).toMatchObject({ outcome: 'started' });
    expect(await ownerOf(id)).toMatchObject({ owner: 'v1' });
  });

  it('本机领取写的是 tasks.owner', async () => {
    await seed();
    const claim = await claimLocalTask(t.db, {
      repo: 'acme/app',
      issueNumber: 8,
      title: 't',
      nodeId: 'founder-pc',
      now: NOW,
    });
    expect(claim.ok).toBe(true);
    if (!claim.ok) return;
    expect(await ownerOf(claim.taskId)).toMatchObject({ owner: 'v1' });
  });

  it('新内核写的是 tasks.owner', async () => {
    const [, id] = await seed();
    const got = await acquireTask(
      t.db as unknown as Parameters<typeof acquireTask>[0],
      { repo: 'acme/app', issue: 7 },
      't',
    );
    expect(got).toMatchObject({ ok: true });
    expect(await ownerOf(id)).toMatchObject({ owner: 'harness' });
  });
});
