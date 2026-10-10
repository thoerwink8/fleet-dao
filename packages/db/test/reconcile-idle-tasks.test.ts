import { randomUUID } from 'node:crypto';
import { asc, eq } from 'drizzle-orm';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { listOpenTaskRows, stopTaskRows } from '../src/queries/reconcile.ts';
import { stateChanges, tasks } from '../src/schema/index.ts';
import { createTestDb, resetTestDb, TEST_DB_TIMEOUT_MS, type TestDb } from '../src/testing.ts';
import { addRepo, addTask } from './helpers.ts';

let t: TestDb;
beforeAll(async () => {
  t = await createTestDb();
}, TEST_DB_TIMEOUT_MS);
afterAll(() => t.close());
beforeEach(() => resetTestDb(t));

const REASON = '单已关闭，没有任务工作流在跑';

describe('每小时对账收遗留的非终态任务行', () => {
  it('列出的行不含 done、stopped、failed，带着仓、单号和状态', async () => {
    const aaa = await addRepo(t.db, 'aaa');
    const bbb = await addRepo(t.db, 'bbb');
    await addTask(t.db, aaa.id, { issueNumber: 1, state: 'done' });
    const running = await addTask(t.db, aaa.id, { issueNumber: 2, state: 'running' });
    const queued = await addTask(t.db, aaa.id, { issueNumber: 3, state: 'queued' });
    await addTask(t.db, bbb.id, { issueNumber: 4, state: 'failed' });
    const planning = await addTask(t.db, bbb.id, { issueNumber: 5, state: 'planning' });
    await addTask(t.db, bbb.id, { issueNumber: 6, state: 'stopped' });

    const rows = await listOpenTaskRows(t.db);
    expect(rows.map((r) => r.state)).toEqual(['running', 'queued', 'planning']);
    expect(rows).toEqual([
      { taskId: running.id, owner: 'acme', name: 'aaa', issueNumber: 2, state: 'running' },
      { taskId: queued.id, owner: 'acme', name: 'aaa', issueNumber: 3, state: 'queued' },
      { taskId: planning.id, owner: 'acme', name: 'bbb', issueNumber: 5, state: 'planning' },
    ]);
  });

  it('stopTaskRows 只改仍不是终态的行，返回实际改了几条', async () => {
    const repo = await addRepo(t.db, 'widgets');
    const done = await addTask(t.db, repo.id, { issueNumber: 1, state: 'done', lastProblem: '做完了' });
    const running = await addTask(t.db, repo.id, {
      issueNumber: 2,
      state: 'running',
      lastProblem: '旧原因',
    });
    const queued = await addTask(t.db, repo.id, { issueNumber: 3, state: 'queued' });
    const failed = await addTask(t.db, repo.id, { issueNumber: 4, state: 'failed', lastProblem: '失败了' });
    const stopped = await addTask(t.db, repo.id, {
      issueNumber: 6,
      state: 'stopped',
      lastProblem: '早叫停了',
    });

    const n = await stopTaskRows(
      t.db,
      [running.id, done.id, failed.id, stopped.id, queued.id, randomUUID()],
      REASON,
    );
    expect(n).toBe(2);

    const rows = await t.db
      .select({ id: tasks.id, state: tasks.state, lastProblem: tasks.lastProblem })
      .from(tasks)
      .orderBy(asc(tasks.issueNumber));
    expect(rows).toEqual([
      { id: done.id, state: 'done', lastProblem: '做完了' },
      { id: running.id, state: 'stopped', lastProblem: REASON },
      { id: queued.id, state: 'stopped', lastProblem: REASON },
      { id: failed.id, state: 'failed', lastProblem: '失败了' },
      { id: stopped.id, state: 'stopped', lastProblem: '早叫停了' },
    ]);
  });

  it('taskIds 为空数组时返回 0，已有的行不动', async () => {
    const repo = await addRepo(t.db, 'widgets');
    const queued = await addTask(t.db, repo.id, { issueNumber: 3, state: 'queued', lastProblem: null });

    expect(await stopTaskRows(t.db, [], REASON)).toBe(0);

    const [row] = await t.db
      .select({ state: tasks.state, lastProblem: tasks.lastProblem })
      .from(tasks)
      .where(eq(tasks.id, queued.id));
    expect(row).toEqual({ state: 'queued', lastProblem: null });
  });

  it('改成 stopped 后 state_changes 多出一条对应的变更记录', async () => {
    const repo = await addRepo(t.db, 'widgets');
    const running = await addTask(t.db, repo.id, { issueNumber: 2, state: 'running' });
    const done = await addTask(t.db, repo.id, { issueNumber: 1, state: 'done' });
    const before = await t.db
      .select({
        entity: stateChanges.entity,
        entityId: stateChanges.entityId,
        taskId: stateChanges.taskId,
        from: stateChanges.fromState,
        to: stateChanges.toState,
      })
      .from(stateChanges)
      .orderBy(asc(stateChanges.id));

    expect(await stopTaskRows(t.db, [running.id, done.id], REASON)).toBe(1);

    const after = await t.db
      .select({
        entity: stateChanges.entity,
        entityId: stateChanges.entityId,
        taskId: stateChanges.taskId,
        from: stateChanges.fromState,
        to: stateChanges.toState,
      })
      .from(stateChanges)
      .orderBy(asc(stateChanges.id));
    expect(after.slice(0, before.length)).toEqual(before);
    expect(after.slice(before.length)).toEqual([
      { entity: 'task', entityId: running.id, taskId: running.id, from: 'running', to: 'stopped' },
    ]);
  });
});
