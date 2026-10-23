// real/runs-writer.ts 接真库（PGlite）：三段的一次性会话经 runOneShot 记进 runs（#216 写的那一半）。
// 三段各一笔：task_id、单号、工作流编号、PR、分支都落进列，派工档只有动手有；开跑那一行就带齐（在跑的那一笔不靠单号兜底），
// 收场整行补完也不冲掉；没给的是 NULL，不是 0、空串。驾驶舱按 task_id 就认得出这几笔。
// 故意造出的失败：派工档不在三档里、验收带了档、taskId 不是 uuid——写进库之前就报错，不起会话、库里不留一行。

import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  getRun,
  poolReservations,
  type RunRow,
  reservePoolSlot,
  runs,
  runsOfTask,
  startRun,
} from '@fleet-dao/db';
import { createTestDb, resetTestDb, TEST_DB_TIMEOUT_MS, type TestDb } from '@fleet-dao/db/testing';
import { taskWorkflowId } from '@fleet-dao/shared/workflow-ids';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { RunInputError, realRuns } from '../../src/real/runs-writer.ts';
import { RunRecordSchema, RunStartSchema } from '../../src/runner/not-wired.ts';
import {
  OneShotError,
  type OneShotInput,
  type OneShotSpawner,
  runOneShot,
} from '../../src/runner/one-shot.ts';
import { addTask, world } from './fixtures.ts';

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

describe('execution 来源贯通与 attach（#3652）', { timeout: 60_000 }, () => {
  const source = { workflowId: 'workflow-a', temporalRunId: 'execution-a' };
  it('schema 保留真实 execution，one-shot 开跑与收场都入库；本机无 context 保持 NULL', async () => {
    const opening: (RunRow | null)[] = [];
    const input = { segment: 'manual' as const, modelId: 'opus-5.5', prompt: 'x', cwd: root, ...source };
    const writer = realRuns({ db: t.db });
    const result = await runOneShot(input, { runs: writer, spawn: spawnPeeking(opening), tmpDir: root });
    expect(opening[0]).toMatchObject(source);
    expect(await getRun(t.db, result.runId)).toMatchObject(source);
    const start = {
      runId: result.runId,
      segment: 'manual',
      model: 'opus-5.5',
      startedAt: result.startedAt,
      ...source,
    };
    expect(RunStartSchema.parse(start)).toMatchObject(source);
    expect(
      RunRecordSchema.parse({ ...start, endedAt: result.endedAt, outcome: 'done', routeOutcome: 'ok' }),
    ).toMatchObject(source);
    const local = await runOneShot(
      { segment: 'manual', modelId: 'opus-5.5', prompt: 'local', cwd: root },
      { runs: writer, spawn: spawnPeeking([]), tmpDir: root },
    );
    expect(await getRun(t.db, local.runId)).toMatchObject({ workflowId: null, temporalRunId: null });
  });

  it.each([source, {}, { workflowId: 'workflow-a' }])(
    'attach 保留原 pair，不能借当前 execution 补未知来源：%j',
    async (original) => {
      const runId = '11111111-2222-4333-8444-555555555555';
      const startedAt = new Date().toISOString();
      await startRun(t.db, {
        id: runId,
        segment: 'manual',
        model: 'opus-5.5',
        startedAt: new Date(startedAt),
        ...original,
      });
      const opening: (RunRow | null)[] = [];
      await runOneShot(
        {
          runId,
          segment: 'manual',
          modelId: 'opus-5.5',
          prompt: '',
          cwd: root,
          workflowId: 'workflow-b',
          temporalRunId: 'execution-b',
          detach: { attach: { startedAt } },
        },
        { runs: realRuns({ db: t.db }), spawn: spawnPeeking(opening), tmpDir: root },
      );
      expect(opening[0]).toMatchObject({
        workflowId: original.workflowId ?? null,
        temporalRunId: 'temporalRunId' in original ? original.temporalRunId : null,
      });
      expect(await getRun(t.db, runId)).toMatchObject({
        workflowId: original.workflowId ?? null,
        temporalRunId: 'temporalRunId' in original ? original.temporalRunId : null,
        outcome: 'done',
      });
    },
  );

  it('缺原行 attach 在驱动/anchor/record 前拒绝，不造无源锚点', async () => {
    const runId = '11111111-2222-4333-8444-555555555555';
    let spawned = 0;
    const writer = realRuns({ db: t.db });
    let recorded = 0;
    const record = writer.record;
    writer.record = async (row) => {
      recorded += 1;
      await record(row);
    };
    await expect(
      runOneShot(
        {
          runId,
          segment: 'manual',
          modelId: 'opus-5.5',
          prompt: '',
          cwd: root,
          ...source,
          detach: { attach: { startedAt: new Date().toISOString() } },
        },
        {
          runs: writer,
          spawn: async () => {
            spawned += 1;
            throw new Error('不该进入 transcript anchor 路径');
          },
          tmpDir: root,
        },
      ),
    ).rejects.toMatchObject({ code: 'BAD_RUN_INPUT' });
    expect([spawned, recorded]).toEqual([0, 0]);
    expect(await getRun(t.db, runId)).toBeNull();
  });

  it('同 runId 在另一 execution 重试明确失败，不再起模型，原行不变', async () => {
    const runId = '11111111-2222-4333-8444-555555555555';
    await startRun(t.db, { id: runId, segment: 'manual', model: 'opus-5.5', ...source });
    const before = await getRun(t.db, runId);
    let spawned = 0;
    const failure = await runOneShot(
      {
        runId,
        segment: 'manual',
        modelId: 'opus-5.5',
        prompt: 'retry',
        cwd: root,
        ...source,
        temporalRunId: 'execution-b',
      },
      {
        runs: realRuns({ db: t.db }),
        spawn: async () => {
          spawned += 1;
          throw new Error('不应重起');
        },
        tmpDir: root,
      },
    ).catch((error: unknown) => error);
    expect(failure).toMatchObject({ code: 'RUN_START_FAILED' });
    expect((failure as Error).message).toContain('来源冲突');
    expect(spawned).toBe(0);
    expect(await getRun(t.db, runId)).toEqual(before);
  });
});

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
        routeOutcome: 'ok',
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

  it('起因、摘要、所属回合（#3140）：开跑那一行就写进 runs，收场整行补完也不冲掉；验收结论经 noteVerdict 写在验收那一笔上', async () => {
    const { repo, task } = await addTask(t.db);
    const workflowId = taskWorkflowId(repo, task.issueNumber);
    const opening: (RunRow | null)[] = [];
    const runsWriter = realRuns({ db: t.db });
    const deps = { spawn: spawnPeeking(opening), runs: runsWriter, tmpDir: join(root, 'runs') };
    const owner = { taskId: task.id, issueNumber: task.issueNumber, workflowId, branch: BRANCH };
    const manual = await runOneShot(
      {
        ...owner,
        segment: 'manual',
        modelId: 'opus-5.5',
        tier: 'medium',
        prompt: '动手',
        cwd: root,
        cause: 'rework_ci',
        causeSummary: `检查红了：test\n${'很长'.repeat(400)}`,
        roundSeq: 2,
        resumeReason: '上一段没记下会话号',
      },
      deps,
    );
    // 开跑那一行（会话还在跑时读的）已经带着起因、回合
    expect(opening[0]).toMatchObject({ cause: 'rework_ci', roundSeq: 2, endedAt: null });
    const row = await getRun(t.db, manual.runId);
    expect(row).toMatchObject({
      cause: 'rework_ci',
      roundSeq: 2,
      outcome: 'done',
      resumeReason: '上一段没记下会话号',
    });
    // 摘要截到 500 字（换行折成空格）
    expect(row?.causeSummary?.startsWith('检查红了：test 很长')).toBe(true);
    expect(row?.causeSummary?.length).toBe(500);

    const verify = await runOneShot(
      { ...owner, segment: 'verify', modelId: 'gpt-5.6', prompt: '验收', cwd: root, roundSeq: 2 },
      deps,
    );
    expect(await getRun(t.db, verify.runId)).toMatchObject({ cause: null, roundSeq: 2, verdict: null });
    await runsWriter.noteVerdict?.(verify.runId, {
      pass: false,
      problems: ['第 1 条没做到'],
      failedCriteria: [1],
      handedOver: [],
    });
    expect((await getRun(t.db, verify.runId))?.verdict).toMatchObject({ pass: false, failedCriteria: [1] });
  });

  it('【故意造出的失败】起因不在名单里、回合号是 0：写库之前就报错，不起会话、库里不留一行', async () => {
    const { task } = await addTask(t.db);
    const spawned: string[] = [];
    const deps = {
      spawn: (async () => {
        spawned.push('起了');
        return { exitCode: 0, stdout: '', stderr: '', killed: false };
      }) as OneShotSpawner,
      runs: realRuns({ db: t.db }),
      tmpDir: join(root, 'runs'),
    };
    for (const bad of [{ cause: 'nope' as never }, { roundSeq: 0 }]) {
      await expect(
        runOneShot(
          { segment: 'manual', modelId: 'opus-5.5', taskId: task.id, prompt: 'x', cwd: root, ...bad },
          deps,
        ),
      ).rejects.toBeInstanceOf(OneShotError);
    }
    expect(spawned).toEqual([]);
    expect(await t.db.select().from(runs)).toHaveLength(0);
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

describe('收场那一笔带上算不算路由的账（#758）：和失败分流同一份证据，选路的熔断、战绩靠它', {
  timeout: 60_000,
}, () => {
  const manual = (cwd: string): OneShotInput => ({
    segment: 'manual',
    modelId: 'opus-5.5',
    routeId: 'carpool',
    prompt: '动手',
    cwd,
  });
  const refused =
    (reason: string): OneShotSpawner =>
    async () => ({
      exitCode: 1,
      stdout: '',
      stderr: '',
      killed: false,
      facts: { reason, detail: '上游说的' },
    });
  const outcomeOf = async (spawn: OneShotSpawner) => {
    const r = await runOneShot(manual(root), {
      spawn,
      runs: realRuns({ db: t.db }),
      tmpDir: join(root, 'runs'),
    }).catch((e: unknown) => e);
    const rows = await t.db.select().from(runs);
    const row = rows.at(-1);
    await t.db.delete(runs);
    return { r, row };
  };

  it('路由繁忙（分流判路由的错）记 fail；额度用满（账号池的事）记 neutral；起不来的记 neutral', async () => {
    await world(t.db);
    expect((await outcomeOf(refused('overloaded'))).row).toMatchObject({
      outcome: 'failed',
      routeOutcome: 'fail',
    });
    expect((await outcomeOf(refused('quota_exhausted'))).row).toMatchObject({
      outcome: 'failed',
      routeOutcome: 'neutral',
    });
    const spawnFailed = await outcomeOf(async () => {
      throw new Error('执行方式没接上');
    });
    expect(spawnFailed.r).toMatchObject({ code: 'SPAWN_FAILED' });
    expect(spawnFailed.row).toMatchObject({ outcome: 'spawn_failed', routeOutcome: 'neutral' });
  });
});

describe('开跑那一行就是占上池的名额（#757）：选路时预占的在那一下换掉，没预占着、池又满了不让开跑', {
  timeout: 60_000,
}, () => {
  const at = '2026-09-25T08:00:00.000Z';
  const manual = (cwd: string, over: Partial<OneShotInput> = {}): OneShotInput => ({
    segment: 'manual',
    modelId: 'opus-5.5',
    routeId: 'carpool',
    prompt: '动手',
    cwd,
    ...over,
  });
  /** 拼车池（上限 3）上先开着 n 行一次性会话。 */
  const busy = async (n: number) => {
    for (let i = 0; i < n; i++) {
      await startRun(t.db, {
        segment: 'verify',
        model: 'opus-5.5',
        routeId: 'carpool',
        startedAt: new Date(at),
      });
    }
  };
  const deps = (spawned: { n: number }) => ({
    spawn: async () => {
      spawned.n += 1;
      return { exitCode: 0, stdout: '做完了', stderr: '', killed: false };
    },
    runs: realRuns({ db: t.db }),
    tmpDir: join(root, 'runs'),
    now: () => new Date(at),
  });

  it('带着预占开跑：池满着也照样开跑（名额本来就是它的），预占在开跑那一下换成这一行', async () => {
    await world(t.db);
    const { task } = await addTask(t.db);
    await busy(2);
    const held = await reservePoolSlot(t.db, {
      taskId: task.id,
      segment: 'manual',
      routeId: 'carpool',
      reservedAt: new Date(at),
      expiresAt: new Date(Date.parse(at) + 20 * 60_000),
    });
    if (!held.reserved) throw new Error('夹具：应该预占上了');
    const opening: (RunRow | null)[] = [];
    const r = await runOneShot(manual(root, { taskId: task.id, reservationId: held.reservationId }), {
      ...deps({ n: 0 }),
      spawn: spawnPeeking(opening),
    });
    expect(r.outcome).toBe('done');
    expect(opening[0]).toMatchObject({ taskId: task.id, routeId: 'carpool', endedAt: null });
    expect(await t.db.select().from(poolReservations)).toEqual([]);
  });

  it('【故意造出的失败】没预占着、池又满了：runOneShot 报 NO_SLOT（不当成库一时不通的 RUN_START_FAILED），会话没起、库里不多一行', async () => {
    await world(t.db);
    await busy(3);
    const spawned = { n: 0 };
    const err = await runOneShot(manual(root), deps(spawned)).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(OneShotError);
    expect(err).toMatchObject({ code: 'NO_SLOT' });
    expect((err as Error).message).toContain('名额满了');
    expect(spawned.n).toBe(0);
    expect(await t.db.select().from(runs)).toHaveLength(3);
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
        routeOutcome: 'ok',
      })
      .catch((e: unknown) => e);
    expect(recordErr).toBeInstanceOf(RunInputError);
    expect((recordErr as Error).message).toContain('taskId');
    expect(await t.db.select().from(runs)).toEqual([]);
  });

  it('收场那一笔没带算不算路由的账（#758）：碰库之前拒，不让熔断看不见这一次', async () => {
    const err = await realRuns({ db: t.db })
      .record({
        runId: '0b6f8a4e-5d2c-4e1b-8a3f-2c1d0e9f8a7d',
        segment: 'manual',
        model: 'opus-5.5',
        startedAt: '2026-10-04T01:00:00Z',
        endedAt: '2026-10-04T01:10:00Z',
        outcome: 'failed',
      } as never)
      .catch((e: unknown) => e);
    expect(err).toBeInstanceOf(RunInputError);
    expect((err as Error).message).toContain('routeOutcome');
    expect(await t.db.select().from(runs)).toEqual([]);
  });
});
