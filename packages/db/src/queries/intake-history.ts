// 引擎拉单挑单要从库里读的历史（#1336）：这张单失败过几次、滚动一小时内起了几条、最近结束的几条任务成没成、熔断的状态。
// 失败和结束都以 state_changes 为准（触发器写的，应用写不漏）：任务行本身只有当前状态，重做过的单看不出失败过几次。
// 读不到照抛，不拿 0 或「没有」顶。只数引擎的任务行（executor = engine）：本机领的单（决定 0096）不占引擎的名额、不算引擎的成败。
import type { SegmentTier, TaskState } from '@fleet-dao/shared';
import { and, asc, count, desc, eq, gt, gte, inArray, lt, sql } from 'drizzle-orm';
import type { Db } from '../client.ts';
import { auditLog, runs, settings, stateChanges, tasks } from '../schema/index.ts';

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
// 数的是任务行（新建的看建出时刻，接手老行看 task.adopt），不数设置表里单独的一份流水。
// 设置 engine.intakeStarts 只给「已经起了、动手段还没写下档」的那条补上拉单时知道的档，并带上任务编号；
// 没有任务行的流水不算一条已起的单。合并前起的单没有这份流水，档从动手段（runs.tier）读。

export const INTAKE_STARTS_SETTING = 'engine.intakeStarts';
type IntakeStart = { repoId: string; at: string; tier: SegmentTier; taskId?: string };

function isTier(value: unknown): value is SegmentTier {
  return value === 'fast' || value === 'medium' || value === 'heavyweight';
}

function parseIntakeStarts(value: unknown): IntakeStart[] {
  if (!Array.isArray(value)) throw new Error(`设置 ${INTAKE_STARTS_SETTING} 的值认不出（要任务起单数组）`);
  return value.map((v) => {
    const row = v as { repoId?: unknown; at?: unknown; tier?: unknown; taskId?: unknown };
    if (
      typeof row?.repoId !== 'string' ||
      typeof row.at !== 'string' ||
      !isTier(row.tier) ||
      Number.isNaN(new Date(row.at).getTime()) ||
      (row.taskId !== undefined && typeof row.taskId !== 'string')
    ) {
      throw new Error(`设置 ${INTAKE_STARTS_SETTING} 的值认不出（要 [{repoId, taskId, at, tier}]）`);
    }
    return row.taskId === undefined
      ? { repoId: row.repoId, at: row.at, tier: row.tier }
      : { repoId: row.repoId, at: row.at, tier: row.tier, taskId: row.taskId };
  });
}

const intakeTierCost = (tier: SegmentTier): number => (tier === 'fast' ? 1 : tier === 'medium' ? 2 : 4);

async function readIntakeStarts(db: Db): Promise<IntakeStart[]> {
  const [row] = await db
    .select({ value: settings.value })
    .from(settings)
    .where(eq(settings.key, INTAKE_STARTS_SETTING));
  return row ? parseIntakeStarts(row.value) : [];
}

/**
 * 近 24 小时（或调用方给的 since）各仓已起单的加权工作量：快档 1、中档 2、主力档 4。
 * 已起 = 这段时间新建的引擎任务行，加上这段时间接手的更老的引擎任务行。本机领的不算。
 * 档：起单时写下的那条（带任务编号）优先，否则取这条任务最早的动手段档；两处都没有按快档算，不当成没起过。
 * 只有设置、没有对应任务行的，不算。
 */
export async function intakeWorkloadSince(db: Db, since: Date): Promise<Record<string, number>> {
  const sinceMs = since.getTime();
  const created = await db
    .select({ id: tasks.id, repoId: tasks.repoId, at: tasks.createdAt })
    .from(tasks)
    .where(and(gte(tasks.createdAt, since), eq(tasks.executor, 'engine')));
  const adopted = await db
    .select({ id: tasks.id, repoId: tasks.repoId, at: auditLog.at })
    .from(auditLog)
    .innerJoin(tasks, sql`${auditLog.target} = 'task:' || ${tasks.id}::text`)
    .where(
      and(
        eq(auditLog.action, TASK_ADOPT_AUDIT_ACTION),
        eq(auditLog.ok, true),
        gte(auditLog.at, since),
        lt(tasks.createdAt, since),
        eq(tasks.executor, 'engine'),
      ),
    );
  const started = new Map<string, { id: string; repoId: string; at: Date }>();
  for (const row of [...created, ...adopted]) {
    const prev = started.get(row.id);
    if (!prev || row.at.getTime() < prev.at.getTime()) started.set(row.id, row);
  }
  if (started.size === 0) return {};

  const ids = [...started.keys()];
  const runRows = await db
    .select({ taskId: runs.taskId, tier: runs.tier, startedAt: runs.startedAt })
    .from(runs)
    .where(
      and(
        inArray(runs.taskId, ids),
        eq(runs.segment, 'manual'),
        inArray(runs.tier, ['fast', 'medium', 'heavyweight']),
      ),
    )
    .orderBy(asc(runs.startedAt));
  const tierByRun = new Map<string, SegmentTier>();
  for (const row of runRows) {
    if (!row.taskId || tierByRun.has(row.taskId) || !isTier(row.tier)) continue;
    tierByRun.set(row.taskId, row.tier);
  }

  const recorded = (await readIntakeStarts(db)).filter((start) => new Date(start.at).getTime() >= sinceMs);
  const tierByRecord = new Map<string, SegmentTier>();
  const loose: IntakeStart[] = [];
  for (const start of recorded) {
    if (start.taskId) tierByRecord.set(start.taskId, start.tier);
    else loose.push(start);
  }
  const usedLoose = new Set<number>();
  const totals: Record<string, number> = {};
  for (const task of started.values()) {
    let tier = tierByRecord.get(task.id) ?? tierByRun.get(task.id);
    if (!tier) {
      const idx = loose.findIndex(
        (start, i) =>
          !usedLoose.has(i) &&
          start.repoId === task.repoId &&
          Math.abs(new Date(start.at).getTime() - task.at.getTime()) <= 2 * 60_000,
      );
      const matched = idx >= 0 ? loose[idx] : undefined;
      if (matched) {
        usedLoose.add(idx);
        tier = matched.tier;
      }
    }
    totals[task.repoId] = (totals[task.repoId] ?? 0) + intakeTierCost(tier ?? 'fast');
  }
  return totals;
}

/** 成功起一条任务后记下它的档（带任务编号）；同时清掉 24 小时以前的历史，避免设置值无限长。 */
export async function recordIntakeStart(
  db: Db,
  input: { repoId: string; taskId: string; at: Date; tier: SegmentTier; by: string },
): Promise<void> {
  const [row] = await db
    .select({ value: settings.value })
    .from(settings)
    .where(eq(settings.key, INTAKE_STARTS_SETTING));
  const since = input.at.getTime() - 24 * 60 * 60_000;
  const starts = row
    ? parseIntakeStarts(row.value).filter((start) => new Date(start.at).getTime() >= since)
    : [];
  starts.push({
    repoId: input.repoId,
    taskId: input.taskId,
    at: input.at.toISOString(),
    tier: input.tier,
  });
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
