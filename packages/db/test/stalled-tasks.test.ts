// 停下等人的引擎任务：看门狗叫醒点名和读回不一致的旧挂起时，要最近一条会话的工作流编号（含重做的下一代）。

import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { listStalledEngineTasks } from '../src/queries/stalled-tasks.ts';
import { runs } from '../src/schema/index.ts';
import { createTestDb, resetTestDb, TEST_DB_TIMEOUT_MS, type TestDb } from '../src/testing.ts';
import { addRepo, addTask, ago, catalog, HOUR } from './helpers.ts';

let t: TestDb;
beforeAll(async () => {
  t = await createTestDb();
}, TEST_DB_TIMEOUT_MS);
afterAll(() => t.close());
beforeEach(async () => {
  await resetTestDb(t);
  await catalog(t.db);
});

describe('listStalledEngineTasks', () => {
  it('只列 stalled 且 executor=engine；工作流编号取最近一条，不猜第一代', async () => {
    const repo = await addRepo(t.db, 'fleet-dao');
    const stalled = await addTask(t.db, repo.id, {
      issueNumber: 2742,
      state: 'stalled',
      executor: 'engine',
      doing: '停下等人：回话的模型不是点名的那个（model_mismatch）：挂起并报警',
      lastProblem: '回话的模型不是点名的那个（model_mismatch）：挂起并报警',
    });
    await addTask(t.db, repo.id, { issueNumber: 1, state: 'running', executor: 'engine' });
    await addTask(t.db, repo.id, { issueNumber: 2, state: 'stalled', executor: 'local' });
    const noRun = await addTask(t.db, repo.id, {
      issueNumber: 3,
      state: 'stalled',
      executor: 'engine',
      lastProblem: '别的原因',
    });
    await t.db.insert(runs).values({
      segment: 'manual',
      model: 'claude-opus-5-5',
      taskId: stalled.id,
      startedAt: ago(2 * HOUR),
      endedAt: ago(HOUR),
      outcome: 'failed',
      workflowId: 'task:acme/fleet-dao#2742',
    });
    await t.db.insert(runs).values({
      segment: 'manual',
      model: 'claude-sonnet-5-5',
      taskId: stalled.id,
      startedAt: ago(HOUR),
      endedAt: ago(HOUR / 2),
      outcome: 'failed',
      workflowId: 'task:acme/fleet-dao#2742:r2',
    });

    const rows = await listStalledEngineTasks(t.db);
    expect(rows.map((r) => [r.issueNumber, r.workflowId])).toEqual([
      [3, null],
      [2742, 'task:acme/fleet-dao#2742:r2'],
    ]);
    expect(rows.find((r) => r.taskId === noRun.id)?.workflowId).toBeNull();
    expect(rows.find((r) => r.issueNumber === 2742)?.lastProblem).toContain('model_mismatch');
  });
});
