// 账本的读写口（决定 0122，shared 的 intake.ts）：不另建表，读 audit_log 里 target 以 `issue:` 或 `progress:` 开头的行，按 id 升序往后读。
// 走部分索引 audit_log_ledger_events_idx（schema/ops.ts，只收这类行，按 id 排）：从 after 往后扫，读的行数只跟返回条数有关，
// 不跟 audit_log 多大有关。where 里的 like 写法要和索引谓词一字不差。读不到照抛，不拿空列表冒充「没有新事件」。
import { LEDGER_NOTE_KINDS } from '@fleet-dao/shared';
import { and, asc, gt, inArray, sql } from 'drizzle-orm';
import type { Db } from '../client.ts';
import { auditLog } from '../schema/index.ts';

export interface IssueEventRow {
  id: number;
  at: Date;
  actorKind: string;
  actorId: string;
  action: string;
  target: string;
  after: unknown;
  ok: boolean;
}

/** 账本行的 where 条件（和部分索引 audit_log_ledger_events_idx 的谓词同形：issue: 和 progress: 两个前缀）。 */
export const issueEventsFilter = sql`(${auditLog.target} like 'issue:%' or ${auditLog.target} like 'progress:%')`;

export interface LedgerNoteInput {
  at: Date;
  actorKind: 'agent';
  actorId: string;
  /** progress.note / decision.handoff / report.daily / report.guards（唯一索引只管这四种）。 */
  action: string;
  target: string;
  /** after 里必须有 repo 和 idempotencyKey：唯一索引按这两个认重放。 */
  after: { repo: string; idempotencyKey: string } & Record<string, unknown>;
}

/**
 * 记一行过程记录，幂等：同一个 repo + idempotencyKey（同样是这四种 action）只留一行，重放回原来那行、created:false。
 * 靠唯一索引 audit_log_ledger_note_key_idx 原子判重，并发重放也只有一个写进去。
 */
export async function appendLedgerNote(
  db: Pick<Db, 'insert' | 'select'>,
  input: LedgerNoteInput,
): Promise<{ id: number; created: boolean }> {
  const [row] = await db
    .insert(auditLog)
    .values({
      at: input.at,
      actorKind: input.actorKind,
      actorId: input.actorId,
      action: input.action,
      target: input.target,
      after: input.after,
      via: 'agent',
      ok: true,
    })
    .onConflictDoNothing()
    .returning({ id: auditLog.id });
  if (row) return { id: row.id, created: true };
  const [old] = await db
    .select({ id: auditLog.id })
    .from(auditLog)
    .where(
      and(
        inArray(auditLog.action, [...LEDGER_NOTE_KINDS]),
        sql`${auditLog.after} ->> 'repo' = ${input.after.repo}`,
        sql`${auditLog.after} ->> 'idempotencyKey' = ${input.after.idempotencyKey}`,
      ),
    )
    .limit(1);
  if (!old) throw new Error('过程记录判成重放，却找不到原来那行');
  return { id: old.id, created: false };
}

export async function listIssueEvents(
  db: Pick<Db, 'select'>,
  input: { after: number; limit: number },
): Promise<IssueEventRow[]> {
  const rows = await db
    .select({
      id: auditLog.id,
      at: auditLog.at,
      actorKind: auditLog.actorKind,
      actorId: auditLog.actorId,
      action: auditLog.action,
      target: auditLog.target,
      after: auditLog.after,
      ok: auditLog.ok,
    })
    .from(auditLog)
    .where(and(gt(auditLog.id, input.after), issueEventsFilter))
    .orderBy(asc(auditLog.id))
    .limit(input.limit);
  return rows;
}
