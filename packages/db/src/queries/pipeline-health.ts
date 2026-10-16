// 流程健康（#2762）：引擎任务工作流每一轮收场写一行 task_rounds，这里按 7 天窗口算每日简报「流程健康」一节的数。
//
// 口径（都只看窗口 [to - 7 天, to) 里收场的轮）：
// - 总轮数、各结束类的条数和占比（占总轮数）；冷验收拒绝占比＝verify_rejected 占总轮数。
// - 按档的一轮做成率＝这一档收场的轮里 merged 的占比（一轮动手到合并没再返工的那一轮才是 merged）；
//   平均轮数＝这一档窗口里合并的工作流，从开工到合并一共收场了几轮（含窗口之前的轮）。
// - 重活 PR 新增行 p90：窗口里合并的 heavyweight 轮，收场时 PR 相对主线的新增行数的 p90；没有量到的行不算。
// 读不到照抛，不拿空顶；窗口里一轮都没有时各占比是 null（调用方写「没有」），不是 0。
import { sql } from 'drizzle-orm';
import type { Db } from '../client.ts';
import { ROUND_OUTCOMES, type RoundOutcome, taskRounds } from '../schema/work.ts';

export const PIPELINE_HEALTH_DAYS = 7;

export interface RoundRecord {
  taskId: string;
  workflowId: string;
  seq: number;
  round: number;
  outcome: RoundOutcome;
  tier?: string | null;
  firstModel?: string | null;
  addedLines?: number | null;
  endedAt?: Date;
}

/** 记一轮怎么收场的。同一条工作流同一个 seq 已经记过就不动（活动重试不写第二行）。 */
export async function recordTaskRound(db: Db, r: RoundRecord): Promise<void> {
  if (!(ROUND_OUTCOMES as readonly string[]).includes(r.outcome)) {
    throw new Error(`认不出的一轮结束类：${r.outcome}`);
  }
  await db
    .insert(taskRounds)
    .values({
      taskId: r.taskId,
      workflowId: r.workflowId,
      seq: r.seq,
      round: r.round,
      outcome: r.outcome,
      tier: r.tier ?? null,
      firstModel: r.firstModel ?? null,
      addedLines: r.addedLines ?? null,
      ...(r.endedAt ? { endedAt: r.endedAt } : {}),
    })
    .onConflictDoNothing({ target: [taskRounds.workflowId, taskRounds.seq] });
}

export interface PipelineHealth {
  from: Date;
  to: Date;
  rounds: number;
  /** 每一类都有（没有的 n=0）；占比在 rounds 为 0 时是 null。 */
  outcomes: { outcome: RoundOutcome; n: number; share: number | null }[];
  byTier: { tier: string; rounds: number; oneRoundRate: number | null; avgRounds: number | null }[];
  heavyAddedP90: number | null;
  verifyRejectShare: number | null;
}

const rowsOf = (res: unknown) =>
  (Array.isArray(res) ? res : (res as { rows: unknown[] }).rows) as Record<string, unknown>[];
const num = (v: unknown): number | null => (v === null || v === undefined ? null : Number(v));

/** 截至 to（不含）的 7 天。 */
export async function pipelineHealth(db: Db, to: Date): Promise<PipelineHealth> {
  if (Number.isNaN(to.getTime())) throw new Error('pipelineHealth: 时刻不是有效日期');
  const from = new Date(to.getTime() - PIPELINE_HEALTH_DAYS * 86_400_000);
  const counts = rowsOf(
    await db.execute(sql`
      select outcome, count(*)::int as n
      from task_rounds
      where ended_at >= ${from.toISOString()}::timestamptz and ended_at < ${to.toISOString()}::timestamptz
      group by outcome`),
  );
  const byOutcome = new Map(counts.map((r) => [String(r.outcome), Number(r.n)]));
  const rounds = [...byOutcome.values()].reduce((a, b) => a + b, 0);
  const share = (n: number) => (rounds === 0 ? null : n / rounds);
  const outcomes = ROUND_OUTCOMES.map((outcome) => {
    const n = byOutcome.get(outcome) ?? 0;
    return { outcome, n, share: share(n) };
  });

  const tiers = rowsOf(
    await db.execute(sql`
      with win as (
        select * from task_rounds
        where ended_at >= ${from.toISOString()}::timestamptz and ended_at < ${to.toISOString()}::timestamptz
      ),
      merged as (
        select w.workflow_id, coalesce(w.tier, '（没判档）') as tier,
               (select count(*) from task_rounds a where a.workflow_id = w.workflow_id and a.seq <= w.seq) as n
        from win w where w.outcome = 'merged'
      ),
      per as (
        select coalesce(tier, '（没判档）') as tier, count(*)::int as rounds,
               (count(*) filter (where outcome = 'merged'))::numeric / count(*) as one_round_rate
        from win group by 1
      )
      select per.tier, per.rounds, round(per.one_round_rate, 3) as one_round_rate,
             (select round(avg(m.n)::numeric, 2) from merged m where m.tier = per.tier) as avg_rounds
      from per order by per.tier`),
  );
  const byTier = tiers.map((r) => ({
    tier: String(r.tier),
    rounds: Number(r.rounds),
    oneRoundRate: num(r.one_round_rate),
    avgRounds: num(r.avg_rounds),
  }));

  const p90 = rowsOf(
    await db.execute(sql`
      select percentile_cont(0.9) within group (order by added_lines) as p90
      from task_rounds
      where ended_at >= ${from.toISOString()}::timestamptz and ended_at < ${to.toISOString()}::timestamptz
        and outcome = 'merged' and tier = 'heavyweight' and added_lines is not null`),
  );
  const heavy = num(p90[0]?.p90);

  return {
    from,
    to,
    rounds,
    outcomes,
    byTier,
    heavyAddedP90: heavy === null ? null : Math.round(heavy),
    verifyRejectShare: share(byOutcome.get('verify_rejected') ?? 0),
  };
}
