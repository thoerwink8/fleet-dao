// real/runs-writer.ts 接真库（PGlite）：三段的一次性会话经 runOneShot 记进 runs（#216 写的那一半）。
// 三段各一笔：task_id、单号、工作流编号、PR、分支都落进列，派工档只有动手有；开跑那一行就带齐（在跑的那一笔不靠单号兜底），
// 收场整行补完也不冲掉；没给的是 NULL，不是 0、空串。驾驶舱按 task_id 就认得出这几笔。
// 故意造出的失败：派工档不在三档里、验收带了档、taskId 不是 uuid——写进库之前就报错，不起会话、库里不留一行。

import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { getRun, type RunRow, runs, runsOfTask } from '@fleet-dao/db';
import { createTestDb, resetTestDb, TEST_DB_TIMEOUT_MS, type TestDb } from '@fleet-dao/db/testing';
import { taskWorkflowId } from '@fleet-dao/shared/workflow-ids';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { RunInputError, realRuns } from '../../src/real/runs-writer.ts';
import {
  OneShotError,
  type OneShotInput,
  type OneShotSpawner,
  runOneShot,
} from '../../src/runner/one-shot.ts';
import { addTask } from './fixtures.ts';

const BRANCH = 'fleet/12-t1a2b3c4d';

let t: TestDb;
beforeAll(async () => {
  t = await createTestDb();
}, TEST_DB_TIMEOUT_MS);
afterAll(() => t.close());

let root: string;
beforeEach(async () => {
  await resetTestDb(t);
  root = mkdtempSync(join(tmpdir(), 'fleet-runs-writer-'));
});
afterEach(() => {
  rmSync(root, { recursive: true, force: true });
});

/** 假会话：跑着的时候把库里开跑那一行读出来（看开跑那一刻就带齐了没有），然后交一份用量。 */
function spawnPeeking(opening: (RunRow | null)[]): OneShotSpawner {
  return async (cmd) => {
    opening.push(await getRun(t.db, cmd.input.runId));
    return {
      exitCode: 0,
      stdout: '做完了',
      stderr: '',
      killed: false,
      facts: {
        usage: { inputTokens: 1000, outputTokens: 200, cacheReadTokens: 30, cacheWriteTokens: 4 },
        costUsd: 0.25,
      },
    };
  };
}

describe('三段各一笔记进 runs：记到这张单名下（#216）', { timeout: 60_000 }, () => {
  it('对题、动手、验收各跑一次：task_id、单号、工作流编号、PR、分支落进列，派工档只有动手有；开跑那一行就带齐，收场不冲掉', async () => {
    const { repo, task } = await addTask(t.db);
    const workflowId = taskWorkflowId(repo, task.issueNumber);
    const owner = {
      taskId: task.id,
      issueNumber: task.issueNumber,
      workflowId,
      prNumber: 31,
      branch: BRANCH,
    };
    const opening: (RunRow | null)[] = [];
    const deps = { spawn: spawnPeeking(opening), runs: realRuns({ db: t.db }), tmpDir: join(root, 'runs') };
    const inputs: OneShotInput[] = [
      { ...owner, segment: 'scope', modelId: 'opus-5.5', prompt: '对题', cwd: root },
      { ...owner, segment: 'manual', modelId: 'opus-5.5', tier: 'medium', prompt: '动手', cwd: root },
      { ...owner, segment: 'verify', modelId: 'gpt-5.6', prompt: '验收', cwd: root },
    ];
    const results = [];
    for (const input of inputs) results.push(await runOneShot(input, deps));
    expect(results.map((r) => r.outcome)).toEqual(['done', 'done', 'done']);

    const columns = {
      taskId: task.id,
      issueNumber: task.issueNumber,
      workflowId,
      prNumber: 31,
      branch: BRANCH,
    };
    // 开跑那一行（会话还在跑时读的）：已经带齐，还没结束
    expect(opening).toHaveLength(3);
    for (const row of opening) expect(row).toMatchObject({ ...columns, endedAt: null, outcome: null });
    // 收场之后：同一行补完，这几列还在；派工档只有动手段有，对题、验收是 NULL（不分档，不是没记）
    const rows = await Promise.all(results.map((r) => getRun(t.db, r.runId)));
    expect(rows.map((r) => [r?.segment, r?.tier])).toEqual([
      ['scope', null],
      ['manual', 'medium'],
      ['verify', null],
    ]);
    for (const row of rows) {
      expect(row).toMatchObject({
        ...columns,
        outcome: 'done',
        inputTokens: 1000,
        outputTokens: 200,
        cacheReadTokens: 30,
        cacheWriteTokens: 4,
        costUsd: 0.25,
      });
      expect(row?.endedAt).toBeInstanceOf(Date);
    }
    expect(await t.db.select().from(runs)).toHaveLength(3);

    // 驾驶舱任务详情读的那一份：三笔都按 task_id 对上（不靠单号兜底）
    const read = await runsOfTask(t.db, { id: task.id, issueNumber: task.issueNumber, workflowId });
    expect(read.map((r) => r.segment)).toEqual(['scope', 'manual', 'verify']);
    expect(read.every((r) => r.taskId === task.id)).toBe(true);
  });

  it('动手第一轮还没开 PR：pr_number 是 NULL（不是 0），单子、派工档、工作流、分支照记', async () => {
    const { repo, task } = await addTask(t.db);
    const workflowId = taskWorkflowId(repo, task.issueNumber);
    const r = await runOneShot(
      {
        segment: 'manual',
        modelId: 'opus-5.5',
        taskId: task.id,
        issueNumber: task.issueNumber,
        tier: 'fast',
        workflowId,
        branch: BRANCH,
        prompt: '动手',
        cwd: root,
      },
      { spawn: spawnPeeking([]), runs: realRuns({ db: t.db }), tmpDir: join(root, 'runs') },
    );
    expect(await getRun(t.db, r.runId)).toMatchObject({
      taskId: task.id,
      tier: 'fast',
      workflowId,
      branch: BRANCH,
      prNumber: null,
    });
  });
});

describe('【故意造出的失败】对不上 runs 约束的：写进库之前就报错，不起会话、库里不留一行', {
  timeout: 60_000,
}, () => {
  it('派工档不在 tier.ts 那三档里：runOneShot 报 BAD_RUN_INPUT（不当成库一时不通的 RUN_START_FAILED），会话没起', async () => {
    const { task } = await addTask(t.db);
    let spawned = 0;
    const err = await runOneShot(
      {
        segment: 'manual',
        modelId: 'opus-5.5',
        taskId: task.id,
        tier: 'turbo' as never,
        prompt: '动手',
        cwd: root,
      },
      {
        spawn: async () => {
          spawned += 1;
          return { exitCode: 0, stdout: '做完了', stderr: '', killed: false };
        },
        runs: realRuns({ db: t.db }),
        tmpDir: join(root, 'runs'),
      },
    ).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(OneShotError);
    expect(err).toMatchObject({ code: 'BAD_RUN_INPUT' });
    expect(spawned).toBe(0);
    expect(await t.db.select().from(runs)).toEqual([]);
  });

  it('直接调写入（不经 runOneShot）：验收段带派工档、taskId 不是 uuid，都在碰库之前拒（RunInputError），库里一行没有', async () => {
    const writer = realRuns({ db: t.db });
    const startErr = await writer
      .start({
        runId: '0b6f8a4e-5d2c-4e1b-8a3f-2c1d0e9f8a7b',
        segment: 'verify',
        model: 'gpt-5.6',
        tier: 'fast',
        startedAt: '2026-10-04T01:00:00Z',
      })
      .catch((e: unknown) => e);
    expect(startErr).toBeInstanceOf(RunInputError);
    expect((startErr as Error).message).toContain('形状不对，没写进库');
    expect((startErr as Error).message).toContain('只有动手段分档');

    const recordErr = await writer
      .record({
        runId: '0b6f8a4e-5d2c-4e1b-8a3f-2c1d0e9f8a7c',
        segment: 'manual',
        model: 'opus-5.5',
        taskId: 'task-1',
        startedAt: '2026-10-04T01:00:00Z',
        endedAt: '2026-10-04T01:10:00Z',
        outcome: 'done',
      })
      .catch((e: unknown) => e);
    expect(recordErr).toBeInstanceOf(RunInputError);
    expect((recordErr as Error).message).toContain('taskId');
    expect(await t.db.select().from(runs)).toEqual([]);
  });
});
