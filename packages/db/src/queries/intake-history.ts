// 引擎拉单挑单要从库里读的历史（#1336）：这张单失败过几次、滚动一小时内起了几条、最近结束的几条任务成没成、熔断的状态。
// 失败和结束都以 state_changes 为准（触发器写的，应用写不漏）：任务行本身只有当前状态，重做过的单看不出失败过几次。
// 读不到照抛，不拿 0 或「没有」顶。只数引擎的任务行（executor = engine）：本机领的单（决定 0096）不占引擎的名额、不算引擎的成败。
import type { SegmentTier, TaskState } from '@fleet-dao/shared';
import { and, asc, count, desc, eq, gt, gte, inArray, lt, sql } from 'drizzle-orm';
import type { Db } from '../client.ts';
import { auditLog, settings, stateChanges, tasks } from '../schema/index.ts';

/** 接手没有任务工作流的老任务行时写的操作记录（engine real/intake.ts 用同一个名字）。 */
export const TASK_ADOPT_AUDIT_ACTION = 'task.adopt';

/** 这张单的任务进过几次「失败」（state_changes 里 to_state = failed 的任务行数）。没有任务行是 0。 */
export async function taskFailureCount(db: Db, repoId: string, issueNumber: number): Promise<number> {
  const [row] = await db
    .select({ n: count() })
    .from(stateChanges)
    .innerJoin(tasks, eq(stateChanges.taskId, tasks.id))
    .where(
      and(
        eq(tasks.repoId, repoId),
        eq(tasks.issueNumber, issueNumber),
        eq(tasks.executor, 'engine'),
        eq(stateChanges.entity, 'task'),
        eq(stateChanges.toState, 'failed'),
      ),
    );
  return row?.n ?? 0;
}

/** 从 since 起建出来的任务行有几条（滚动一小时限速数「已起的」）。 */
export async function tasksCreatedSince(db: Db, since: Date): Promise<number> {
  const [row] = await db
    .select({ n: count() })
    .from(tasks)
    .where(and(gte(tasks.createdAt, since), eq(tasks.executor, 'engine')));
  return row?.n ?? 0;
}

/**
 * 从 since 起接手成功的老任务行有几条（操作记录 task.adopt 且 ok）。
 * 建出时刻已经不早于 since 的不重复数：那些行 tasksCreatedSince 已经算过。
 */
export async function taskAdoptsSince(db: Db, since: Date): Promise<number> {
  const [row] = await db
    .select({ n: count() })
    .from(auditLog)
    .innerJoin(tasks, sql`${auditLog.target} = 'task:' || ${tasks.id}::text`)
    .where(
      and(
        eq(auditLog.action, TASK_ADOPT_AUDIT_ACTION),
        eq(auditLog.ok, true),
        gte(auditLog.at, since),
        lt(tasks.createdAt, since),
      ),
    );
  return row?.n ?? 0;
}

export interface EndedTask {
  taskId: string;
  state: 'done' | 'failed';
  endedAt: Date;
}

/**
 * 最近结束的任务：state_changes 里任务行进 done 或 failed 的记录，新的在前，最多 limit 条；after 给了就只要它之后的。
 * 「叫停」(stopped) 是人或单关了的决定，不算引擎成败，不在里面。
 */
export async function recentEndedTasks(
  db: Db,
  input: { limit: number; after?: Date | null; repoId?: string },
): Promise<EndedTask[]> {
  const rows = await db
    .select({ taskId: stateChanges.taskId, state: stateChanges.toState, endedAt: stateChanges.at })
    .from(stateChanges)
    .innerJoin(tasks, eq(tasks.id, stateChanges.taskId))
    .where(
      and(
        eq(stateChanges.entity, 'task'),
        eq(tasks.executor, 'engine'),
        inArray(stateChanges.toState, ['done', 'failed']),
        input.after ? gt(stateChanges.at, input.after) : undefined,
        input.repoId ? eq(tasks.repoId, input.repoId) : undefined,
      ),
    )
    .orderBy(desc(stateChanges.id))
    .limit(input.limit);
  return rows.map((r) => ({
    taskId: r.taskId,
    state: r.state === 'done' ? 'done' : 'failed',
    endedAt: r.endedAt,
  }));
}

/** 熔断试探的那一条：从 since 起建出来的第一条任务行（没有是 null）。 */
export async function firstTaskCreatedSince(
  db: Db,
  since: Date,
  repoId?: string,
): Promise<{ id: string; state: TaskState; createdAt: Date } | null> {
  const [row] = await db
    .select({ id: tasks.id, state: tasks.state, createdAt: tasks.createdAt })
    .from(tasks)
    .where(
      and(
        gte(tasks.createdAt, since),
        eq(tasks.executor, 'engine'),
        repoId ? eq(tasks.repoId, repoId) : undefined,
      ),
    )
    .orderBy(asc(tasks.createdAt))
    .limit(1);
  return row ?? null;
}

// —— 熔断状态：设置表里按仓分开的 engine.intakeBreaker:<仓号> 那一行 ——

export const INTAKE_BREAKER_SETTING = 'engine.intakeBreaker';
export const intakeBreakerSetting = (repoId?: string) =>
  repoId ? `${INTAKE_BREAKER_SETTING}:${repoId}` : INTAKE_BREAKER_SETTING;

/**
 * open：熔断着，at 是进入（或试探失败后重新计冷却）的时刻；
 * closed：正常，at 是上次恢复的时刻（数最近 6 条只数这之后结束的，免得恢复后马上被旧的失败又触发）。
 * 没这一行 = 正常、没恢复过。
 */
export type IntakeBreakerRow = { state: 'open' | 'closed'; at: Date } | null;

/** 读熔断状态。这一行认不出（形状不对）照抛，不当成「正常」。 */
export async function readIntakeBreaker(db: Db, repoId?: string): Promise<IntakeBreakerRow> {
  const key = intakeBreakerSetting(repoId);
  const [row] = await db.select().from(settings).where(eq(settings.key, key));
  if (!row) return null;
  const v = row.value as { state?: unknown; at?: unknown } | null;
  const at = typeof v?.at === 'string' ? new Date(v.at) : null;
  if ((v?.state !== 'open' && v?.state !== 'closed') || at === null || Number.isNaN(at.getTime())) {
    throw new Error(
      `设置 ${key} 的值认不出（要 {state: open|closed, at: 时间}）：${JSON.stringify(row.value)}`,
    );
  }
  return { state: v.state, at };
}

/** 写熔断状态（有就换、没有就建，版本加 1）。 */
export async function writeIntakeBreaker(
  db: Db,
  input: { state: 'open' | 'closed'; at: Date; by: string },
  repoId?: string,
): Promise<void> {
  const key = intakeBreakerSetting(repoId);
  const value = { state: input.state, at: input.at.toISOString() };
  await db
    .insert(settings)
    .values({ key, value, updatedBy: input.by })
    .onConflictDoUpdate({
      target: settings.key,
      set: { value, updatedBy: input.by, version: sql`${settings.version} + 1` },
    });
}

// —— 近 24 小时各仓已起单的加权工作量 ——

export const INTAKE_STARTS_SETTING = 'engine.intakeStarts';
type IntakeStart = { repoId: string; at: string; tier: SegmentTier };

function parseIntakeStarts(value: unknown): IntakeStart[] {
  if (!Array.isArray(value)) throw new Error(`设置 ${INTAKE_STARTS_SETTING} 的值认不出（要任务起单数组）`);
  const starts = value as Record<string, unknown>[];
  if (
    starts.some(
      (v) =>
        typeof v?.repoId !== 'string' ||
        typeof v.at !== 'string' ||
        !['fast', 'medium', 'heavyweight'].includes(v.tier as string) ||
        Number.isNaN(new Date(v.at).getTime()),
    )
  ) {
    throw new Error(`设置 ${INTAKE_STARTS_SETTING} 的值认不出（要 [{repoId, at, tier}]）`);
  }
  return starts as IntakeStart[];
}

const intakeTierCost = (tier: SegmentTier): number => (tier === 'fast' ? 1 : tier === 'medium' ? 2 : 4);

/** 读近 24 小时（或调用方给的 since）各仓已成功起单的加权工作量；没有历史就是空。 */
export async function intakeWorkloadSince(db: Db, since: Date): Promise<Record<string, number>> {
  const [row] = await db
    .select({ value: settings.value })
    .from(settings)
    .where(eq(settings.key, INTAKE_STARTS_SETTING));
  if (!row) return {};
  const totals: Record<string, number> = {};
  for (const start of parseIntakeStarts(row.value)) {
    if (new Date(start.at).getTime() < since.getTime()) continue;
    totals[start.repoId] = (totals[start.repoId] ?? 0) + intakeTierCost(start.tier);
  }
  return totals;
}

/** 成功起一条任务后登记；同时清掉 24 小时以前的历史，避免设置值无限长。 */
export async function recordIntakeStart(
  db: Db,
  input: { repoId: string; at: Date; tier: SegmentTier; by: string },
): Promise<void> {
  const [row] = await db
    .select({ value: settings.value })
    .from(settings)
    .where(eq(settings.key, INTAKE_STARTS_SETTING));
  const since = input.at.getTime() - 24 * 60 * 60_000;
  const starts = row
    ? parseIntakeStarts(row.value).filter((start) => new Date(start.at).getTime() >= since)
    : [];
  starts.push({ repoId: input.repoId, at: input.at.toISOString(), tier: input.tier });
  await db
    .insert(settings)
    .values({ key: INTAKE_STARTS_SETTING, value: starts, updatedBy: input.by })
    .onConflictDoUpdate({
      target: settings.key,
      set: { value: starts, updatedBy: input.by, version: sql`${settings.version} + 1` },
    });
}

// —— 拉单这一轮每个仓等空位的单数：设置表里 engine.intakeWaiting 那一行（决定 0093）——

export const INTAKE_WAITING_SETTING = 'engine.intakeWaiting';

/**
 * 拉单最近一轮记下的：每个开着开关、单子读成了的仓里「过了准入、只因没空位没起」的单几张（仓编号 → 张数），和那一轮的时刻。
 * 看门狗的「主线 N 小时没合 PR」报警读它。没这一行 = 拉单还没记过。
 */
export type IntakeWaitingRow = { at: Date; byRepo: Record<string, number> } | null;

/** 读。这一行认不出（形状不对）照抛，不当成「没有待做的单」。 */
export async function readIntakeWaiting(db: Db): Promise<IntakeWaitingRow> {
  const [row] = await db.select().from(settings).where(eq(settings.key, INTAKE_WAITING_SETTING));
  if (!row) return null;
  const v = row.value as { at?: unknown; byRepo?: unknown } | null;
  const at = typeof v?.at === 'string' ? new Date(v.at) : null;
  const byRepo = v?.byRepo;
  const ok =
    at !== null &&
    !Number.isNaN(at.getTime()) &&
    typeof byRepo === 'object' &&
    byRepo !== null &&
    !Array.isArray(byRepo) &&
    Object.values(byRepo).every((n) => Number.isInteger(n) && (n as number) >= 0);
  if (!ok) {
    throw new Error(
      `设置 ${INTAKE_WAITING_SETTING} 的值认不出（要 {at: 时间, byRepo: {仓编号: 张数}}）：${JSON.stringify(row.value)}`,
    );
  }
  return { at, byRepo: byRepo as Record<string, number> };
}

/** 写（有就换、没有就建，版本加 1）。 */
export async function writeIntakeWaiting(
  db: Db,
  input: { at: Date; byRepo: Record<string, number>; by: string },
): Promise<void> {
  const value = { at: input.at.toISOString(), byRepo: input.byRepo };
  await db
    .insert(settings)
    .values({ key: INTAKE_WAITING_SETTING, value, updatedBy: input.by })
    .onConflictDoUpdate({
      target: settings.key,
      set: { value, updatedBy: input.by, version: sql`${settings.version} + 1` },
    });
}
