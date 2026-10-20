// 法国指挥官会话（engine/src/jobs/park-triage.ts，#3294 第 2 片）读库的那几样。写操作记录经 recordEngineAudit（queries/session-org.ts）。
// 都是只读；读不到原样抛，调用方记没查成，不当成空。
import { and, asc, desc, eq, gte, sql } from 'drizzle-orm';
import type { Db } from '../client.ts';
import {
  auditLog,
  notifications,
  routingPurposeModels,
  settings,
  taskRounds,
  tasks,
} from '../schema/index.ts';

/** 指挥官会话的操作记录都记在这个 target 下（和 groom 一样一个 target 一类事）。 */
export const COMMANDER_AUDIT_TARGET = 'commander';

export interface CommanderAuditRow {
  at: Date;
  action: string;
  actorId: string;
  after: unknown;
  ok: boolean;
}

/** since 之后（含）target=commander 的全部操作记录。 */
export async function commanderAuditRows(db: Db, since: Date): Promise<CommanderAuditRow[]> {
  return db
    .select({
      at: auditLog.at,
      action: auditLog.action,
      actorId: auditLog.actorId,
      after: auditLog.after,
      ok: auditLog.ok,
    })
    .from(auditLog)
    .where(and(eq(auditLog.target, COMMANDER_AUDIT_TARGET), gte(auditLog.at, since)))
    .orderBy(asc(auditLog.at));
}

/** 设置里某一行的原始值。没设过回 null（和值是 JSON null 分开：这里没有行才是 null，行里的 null 回 `{ value: null }`）。 */
export async function readSettingValue(db: Db, key: string): Promise<{ value: unknown } | null> {
  const [row] = await db.select({ value: settings.value }).from(settings).where(eq(settings.key, key));
  return row ? { value: row.value } : null;
}

/** 这个用途下配了几个模型。0 就是「没配模型」。 */
export async function countPurposeModels(
  db: Db,
  purpose: (typeof routingPurposeModels.$inferSelect)['purpose'],
): Promise<number> {
  const [row] = await db
    .select({ n: sql<number>`count(*)::int` })
    .from(routingPurposeModels)
    .where(eq(routingPurposeModels.purpose, purpose));
  return row?.n ?? 0;
}

export interface CommanderRoundRow {
  seq: number;
  outcome: string;
  addedLines: number | null;
  reworkSummary: string | null;
}

/** 这张单最近 limit 个回合收场（旧的在前）。 */
export async function readTaskRoundsForSpin(db: Db, taskId: string, limit = 8): Promise<CommanderRoundRow[]> {
  const rows = await db
    .select({
      seq: taskRounds.seq,
      outcome: taskRounds.outcome,
      addedLines: taskRounds.addedLines,
      reworkSummary: taskRounds.reworkSummary,
    })
    .from(taskRounds)
    .where(eq(taskRounds.taskId, taskId))
    .orderBy(desc(taskRounds.endedAt), desc(taskRounds.id))
    .limit(limit);
  return rows.reverse();
}

/** 停下那一次的提醒正文（工作流报的 <工作流编号>:park:<第几次>）。没有、没读到内容回 null。 */
export async function readParkAlertBody(db: Db, dedupeKey: string): Promise<string | null> {
  const [row] = await db
    .select({ title: notifications.title, body: notifications.body })
    .from(notifications)
    .where(eq(notifications.dedupeKey, dedupeKey));
  if (!row) return null;
  const body = row.body.trim();
  return body === '' ? null : body;
}

/** 任务标题（重做起新一代要带）。 */
export async function readTaskTitle(db: Db, taskId: string): Promise<string | null> {
  const [row] = await db.select({ title: tasks.title }).from(tasks).where(eq(tasks.id, taskId));
  return row?.title ?? null;
}
