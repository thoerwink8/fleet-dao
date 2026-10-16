// 流程健康（queries/pipeline-health.ts，#2762）：task_rounds 每轮一行，按 7 天窗口算结束类占比、按档一轮做成率和平均轮数、
// 重活 PR 新增行 p90、冷验收拒绝占比。PGlite 造数据。
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { pipelineHealth, recordTaskRound } from '../src/queries/pipeline-health.ts';
import { ROUND_OUTCOMES, taskRounds } from '../src/schema/index.ts';
import { createTestDb, resetTestDb, TEST_DB_TIMEOUT_MS, type TestDb } from '../src/testing.ts';
import { addRepo, addTask, ago, DAY, expectViolation, HOUR, NOW } from './helpers.ts';

let t: TestDb;
beforeAll(async () => {
  t = await createTestDb();
}, TEST_DB_TIMEOUT_MS);
afterAll(() => t.close());
beforeEach(() => resetTestDb(t));

describe('recordTaskRound', () => {
  it('同一条工作流同一个 seq 只记一行（活动重试不重复）；认不出的结束类拒', async () => {
    const r = await addRepo(t.db);
    const task = await addTask(t.db, r.id);
    const row = { taskId: task.id, workflowId: 'wf-1', seq: 1, round: 1, outcome: 'ci_red' as const };
    await recordTaskRound(t.db, row);
    await recordTaskRound(t.db, { ...row, outcome: 'merged' });
    const rows = await t.db.select().from(taskRounds);
    expect(rows).toHaveLength(1);
    expect(rows[0]?.outcome).toBe('ci_red');
    await expect(recordTaskRound(t.db, { ...row, seq: 2, outcome: 'nope' as never })).rejects.toThrow(
      '认不出',
    );
    // 库里的检查和 ROUND_OUTCOMES 一字不差：名单里的都写得进，名单外的被约束挡
    for (const [i, outcome] of ROUND_OUTCOMES.entries()) {
      await recordTaskRound(t.db, { ...row, workflowId: 'wf-all', seq: i + 1, outcome });
    }
    await expectViolation(
      t.db.insert(taskRounds).values({ ...row, workflowId: 'wf-x', outcome: 'nope' as never }),
      'task_rounds_outcome_known',
    );
  });
});

describe('pipelineHealth', () => {
  it('7 天窗口：占比、按档一轮做成率和平均轮数、重活新增行 p90、冷验收拒绝占比；窗口外的不算', async () => {
    const r = await addRepo(t.db);
    const task = await addTask(t.db, r.id);
    let n = 0;
    const add = async (
      workflowId: string,
      outcome: (typeof ROUND_OUTCOMES)[number],
      at: Date,
      tier: string,
      addedLines?: number,
    ) => {
      n += 1;
      await recordTaskRound(t.db, {
        taskId: task.id,
        workflowId,
        seq: n,
        round: 1,
        outcome,
        tier,
        firstModel: 'm1',
        ...(addedLines === undefined ? {} : { addedLines }),
        endedAt: at,
      });
    };
    // 重活 A：窗口前一轮 CI 红，窗口里冷验收拒、再合并（共 3 轮）
    await add('A', 'ci_red', ago(8 * DAY), 'heavyweight');
    await add('A', 'verify_rejected', ago(2 * DAY), 'heavyweight');
    await add('A', 'merged', ago(DAY), 'heavyweight', 1000);
    // 重活 B：一轮就合
    await add('B', 'merged', ago(HOUR), 'heavyweight', 100);
    // 快活 C：没提交、再合并
    await add('C', 'no_commit', ago(3 * DAY), 'fast');
    await add('C', 'merged', ago(3 * DAY - HOUR), 'fast', 5);
    const h = await pipelineHealth(t.db, NOW);
    expect(h.rounds).toBe(5);
    const of = (o: string) => h.outcomes.find((x) => x.outcome === o);
    expect(of('merged')).toEqual({ outcome: 'merged', n: 3, share: 3 / 5 });
    expect(of('ci_red')?.n).toBe(0);
    expect(h.outcomes).toHaveLength(ROUND_OUTCOMES.length);
    expect(h.verifyRejectShare).toBe(1 / 5);
    const heavy = h.byTier.find((x) => x.tier === 'heavyweight');
    expect(heavy).toEqual({ tier: 'heavyweight', rounds: 3, oneRoundRate: 0.667, avgRounds: 2 });
    expect(h.byTier.find((x) => x.tier === 'fast')).toEqual({
      tier: 'fast',
      rounds: 2,
      oneRoundRate: 0.5,
      avgRounds: 2,
    });
    // p90 of [100, 1000] = 100 + 0.9 * 900
    expect(h.heavyAddedP90).toBe(910);
  });

  it('【故意造出的失败】窗口里一轮都没有：占比、p90 是 null，不拿 0 顶', async () => {
    const h = await pipelineHealth(t.db, NOW);
    expect(h.rounds).toBe(0);
    expect(h.verifyRejectShare).toBeNull();
    expect(h.heavyAddedP90).toBeNull();
    expect(h.byTier).toEqual([]);
    expect(h.outcomes.every((o) => o.share === null)).toBe(true);
  });
});
