// 开单账本的读口（决定 0122，shared 的 intake.ts）：不另建表，读 audit_log 里 target 以 `issue:` 开头的行，按 id 升序往后读。
// 走部分索引 audit_log_issue_events_idx（schema/ops.ts，只收这类行，按 id 排）：从 after 往后扫，读的行数只跟返回条数有关，
// 不跟 audit_log 多大有关。where 里的 like 写法要和索引谓词一字不差。读不到照抛，不拿空列表冒充「没有新事件」。
import { and, asc, gt, sql } from 'drizzle-orm';
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

/** 账本行的 where 条件（和部分索引谓词同形）。 */
export const issueEventsFilter = sql`${auditLog.target} like 'issue:%'`;

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
