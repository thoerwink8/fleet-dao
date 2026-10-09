// 引擎拉单挑单要从库里读的历史（#1336）：这张单失败过几次、滚动一小时内起了几条、最近结束的几条任务成没成、熔断的状态。
// 失败和结束都以 state_changes 为准（触发器写的，应用写不漏）：任务行本身只有当前状态，重做过的单看不出失败过几次。
// 读不到照抛，不拿 0 或「没有」顶。
import type { TaskState } from '@fleet-dao/shared';
import { and, asc, count, desc, eq, gt, gte, inArray, lt, sql } from 'drizzle-orm';
import type { Db } from '../client.ts';
import { auditLog, repos, settings, stateChanges, tasks } from '../schema/index.ts';

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
        eq(stateChanges.entity, 'task'),
        eq(stateChanges.toState, 'failed'),
      ),
    );
  return row?.n ?? 0;
}

/**
 * 从计数里划掉的任务：这个仓里、标题对上 titlePosix（Postgres ~）的不算。
 * 拉单用它把巡检单剔出每小时名额（#1364）。不给就一条不剔。
 */
export interface HourlyCountExclude {
  owner: string;
  name: string;
  titlePosix: string;
}

/** 从 since 起建出来的任务行有几条（滚动一小时限速数「已起的」）。exclude 给了，那个仓里对得上标题的不算。 */
export async function tasksCreatedSince(
  db: Db,
  since: Date,
  exclude?: HourlyCountExclude | null,
): Promise<number> {
  const created = gte(tasks.createdAt, since);
  if (!exclude) {
    const [row] = await db.select({ n: count() }).from(tasks).where(created);
    return row?.n ?? 0;
  }
  const owner = exclude.owner.toLowerCase();
  const name = exclude.name.toLowerCase();
  const [row] = await db
    .select({ n: count() })
    .from(tasks)
    .innerJoin(repos, eq(tasks.repoId, repos.id))
    .where(
      and(
        created,
        sql`not (lower(${repos.owner}) = ${owner} and lower(${repos.name}) = ${name} and ${tasks.title} ~ ${exclude.titlePosix})`,
      ),
    );
  return row?.n ?? 0;
}

/**
 * 从 since 起接手成功的老任务行有几条（操作记录 task.adopt 且 ok）。
 * 建出时刻已经不早于 since 的不重复数：那些行 tasksCreatedSince 已经算过。
 * exclude 和 tasksCreatedSince 同一条巡检单口径。
 */
export async function taskAdoptsSince(
  db: Db,
  since: Date,
  exclude?: HourlyCountExclude | null,
): Promise<number> {
  const base = and(
    eq(auditLog.action, TASK_ADOPT_AUDIT_ACTION),
    eq(auditLog.ok, true),
    gte(auditLog.at, since),
    lt(tasks.createdAt, since),
  );
  if (!exclude) {
    const [row] = await db
      .select({ n: count() })
      .from(auditLog)
      .innerJoin(tasks, sql`${auditLog.target} = 'task:' || ${tasks.id}::text`)
      .where(base);
    return row?.n ?? 0;
  }
  const owner = exclude.owner.toLowerCase();
  const name = exclude.name.toLowerCase();
  const [row] = await db
    .select({ n: count() })
    .from(auditLog)
    .innerJoin(tasks, sql`${auditLog.target} = 'task:' || ${tasks.id}::text`)
    .innerJoin(repos, eq(tasks.repoId, repos.id))
    .where(
      and(
        base,
        sql`not (lower(${repos.owner}) = ${owner} and lower(${repos.name}) = ${name} and ${tasks.title} ~ ${exclude.titlePosix})`,
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
  input: { limit: number; after?: Date | null },
): Promise<EndedTask[]> {
  const rows = await db
    .select({ taskId: stateChanges.taskId, state: stateChanges.toState, endedAt: stateChanges.at })
    .from(stateChanges)
    .where(
      and(
        eq(stateChanges.entity, 'task'),
        inArray(stateChanges.toState, ['done', 'failed']),
        input.after ? gt(stateChanges.at, input.after) : undefined,
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
): Promise<{ id: string; state: TaskState; createdAt: Date } | null> {
  const [row] = await db
    .select({ id: tasks.id, state: tasks.state, createdAt: tasks.createdAt })
    .from(tasks)
    .where(gte(tasks.createdAt, since))
    .orderBy(asc(tasks.createdAt))
    .limit(1);
  return row ?? null;
}

// —— 熔断状态：设置表里 engine.intakeBreaker 那一行 ——

export const INTAKE_BREAKER_SETTING = 'engine.intakeBreaker';

/**
 * open：熔断着，at 是进入（或试探失败后重新计冷却）的时刻；
 * closed：正常，at 是上次恢复的时刻（数最近 6 条只数这之后结束的，免得恢复后马上被旧的失败又触发）。
 * 没这一行 = 正常、没恢复过。
 */
export type IntakeBreakerRow = { state: 'open' | 'closed'; at: Date } | null;

/** 读熔断状态。这一行认不出（形状不对）照抛，不当成「正常」。 */
export async function readIntakeBreaker(db: Db): Promise<IntakeBreakerRow> {
  const [row] = await db.select().from(settings).where(eq(settings.key, INTAKE_BREAKER_SETTING));
  if (!row) return null;
  const v = row.value as { state?: unknown; at?: unknown } | null;
  const at = typeof v?.at === 'string' ? new Date(v.at) : null;
  if ((v?.state !== 'open' && v?.state !== 'closed') || at === null || Number.isNaN(at.getTime())) {
    throw new Error(
      `设置 ${INTAKE_BREAKER_SETTING} 的值认不出（要 {state: open|closed, at: 时间}）：${JSON.stringify(row.value)}`,
    );
  }
  return { state: v.state, at };
}

/** 写熔断状态（有就换、没有就建，版本加 1）。 */
export async function writeIntakeBreaker(
  db: Db,
  input: { state: 'open' | 'closed'; at: Date; by: string },
): Promise<void> {
  const value = { state: input.state, at: input.at.toISOString() };
  await db
    .insert(settings)
    .values({ key: INTAKE_BREAKER_SETTING, value, updatedBy: input.by })
    .onConflictDoUpdate({
      target: settings.key,
      set: { value, updatedBy: input.by, version: sql`${settings.version} + 1` },
    });
}
