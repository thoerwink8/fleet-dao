// 流程健康（queries/pipeline-health.ts，#2762）：task_rounds 每轮一行，按 7 天窗口算结束类占比、按档一轮做成率和平均轮数、
// 重活 PR 新增行 p90、冷验收拒绝占比。PGlite 造数据。
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { pipelineHealth, recordTaskRound, releaseKilledSessions } from '../src/queries/pipeline-health.ts';
import { ROUND_OUTCOMES, taskRounds } from '../src/schema/index.ts';
import { createTestDb, resetTestDb, TEST_DB_TIMEOUT_MS, type TestDb } from '../src/testing.ts';
import {
  addRepo,
  addRoute,
  addRun,
  addTask,
  ago,
  catalog,
  DAY,
  expectViolation,
  HOUR,
  NOW,
} from './helpers.ts';

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

describe('releaseKilledSessions（#2797）', () => {
  // 北京时间 09-26 00:00：窗口是 09-19 ～ 09-25 这 7 天
  const TO = new Date('2026-09-25T16:00:00Z');
  async function seg(o: {
    endedAt: Date;
    outcome: 'killed' | 'org_switch' | 'done';
    reason: string | null;
    segment?: 'manual' | 'verify';
    minutes?: number;
  }) {
    await addRun(t.db, {
      taskId: null,
      routeId: 'k-opus',
      segment: o.segment ?? 'manual',
      startedAt: new Date(o.endedAt.getTime() - (o.minutes ?? 30) * 60_000),
      endedAt: o.endedAt,
      outcome: o.outcome,
      failureReason: o.reason,
    });
  }

  it('认三种发版叫停（排空截止、发版暂停、停机时的 CANCELLED），别的叫停、别的段、窗口外的不算；按北京时间分天，7 天都列', async () => {
    await catalog(t.db);
    await addRoute(t.db, { id: 'k-opus', poolId: 'relay-a', modelId: 'opus-5.5' });
    const at = (iso: string) => new Date(iso);
    // 09-25（北京）两段：一段排空截止（30 分钟），一段停机时 Temporal 取消（60 分钟）
    await seg({
      endedAt: at('2026-09-25T03:00:00Z'),
      outcome: 'org_switch',
      reason: '发布排空：到了发布宽限的截止（2026-09-25T03:00:00Z），这一段停下',
    });
    await seg({
      endedAt: at('2026-09-25T04:00:00Z'),
      outcome: 'killed',
      reason: 'exit=null killed=true；引擎叫停（其他：CANCELLED）',
      minutes: 60,
    });
    // 北京 09-20 00:30（UTC 09-19 16:30）：算 09-20
    await seg({
      endedAt: at('2026-09-19T16:30:00Z'),
      outcome: 'killed',
      reason: 'exit=null killed=true；引擎叫停（发版暂停：发布排空）',
    });
    // 不算的：人点停、切号、老记录没原因、验收段、窗口外、正常收场
    await seg({
      endedAt: at('2026-09-24T03:00:00Z'),
      outcome: 'killed',
      reason: 'exit=null killed=true；引擎叫停（人点了停：x）',
    });
    await seg({
      endedAt: at('2026-09-24T03:00:00Z'),
      outcome: 'org_switch',
      reason: '切号：会话用户换到独享组织',
    });
    await seg({
      endedAt: at('2026-09-24T03:00:00Z'),
      outcome: 'killed',
      reason: 'exit=null killed=true；引擎叫停',
    });
    await seg({
      endedAt: at('2026-09-24T03:00:00Z'),
      outcome: 'killed',
      reason: 'exit=null killed=true；引擎叫停（其他：CANCELLED）',
      segment: 'verify',
    });
    await seg({
      endedAt: at('2026-09-18T03:00:00Z'),
      outcome: 'killed',
      reason: 'exit=null killed=true；引擎叫停（其他：CANCELLED）',
    });
    await seg({
      endedAt: at('2026-09-25T17:00:00Z'),
      outcome: 'killed',
      reason: 'exit=null killed=true；引擎叫停（其他：CANCELLED）',
    });
    await seg({ endedAt: at('2026-09-24T03:00:00Z'), outcome: 'done', reason: null });

    const k = await releaseKilledSessions(t.db, TO);
    expect(k.total).toBe(3);
    expect(k.hours).toBe(2);
    expect(k.byDay).toEqual([
      { day: '09-19', n: 0 },
      { day: '09-20', n: 1 },
      { day: '09-21', n: 0 },
      { day: '09-22', n: 0 },
      { day: '09-23', n: 0 },
      { day: '09-24', n: 0 },
      { day: '09-25', n: 2 },
    ]);
  });

  it('窗口里一段都没有：0 段、0 小时，7 天都是 0；时刻不对照抛', async () => {
    const k = await releaseKilledSessions(t.db, TO);
    expect(k.total).toBe(0);
    expect(k.hours).toBe(0);
    expect(k.byDay.map((d) => d.n)).toEqual([0, 0, 0, 0, 0, 0, 0]);
    await expect(releaseKilledSessions(t.db, new Date('x'))).rejects.toThrow('不是有效日期');
  });
});
