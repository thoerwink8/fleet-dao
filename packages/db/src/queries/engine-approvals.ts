// 人闸批准：开一条待批（同事务报一条 decision 级报警）、读、记下批或驳回。
import { and, eq, isNull } from 'drizzle-orm';
import type { Db } from '../client.ts';
import { approvals } from '../schema/index.ts';
import { upsertAlert } from './engine-alerts.ts';

export interface ApprovalRecord {
  id: string;
  taskId: string;
  subtaskId: string | null;
  holds: string[];
  prNumber: number;
  head: string;
  title: string;
  summary: string;
  requestedAt: Date;
  decision: 'approved' | 'rejected' | null;
  decidedBy: string | null;
  decidedAt: Date | null;
  reason: string | null;
}

function mapApproval(row: typeof approvals.$inferSelect): ApprovalRecord {
  return {
    id: row.id,
    taskId: row.taskId,
    subtaskId: row.subtaskId,
    holds: row.holds,
    prNumber: row.prNumber,
    head: row.head,
    title: row.title,
    summary: row.summary,
    requestedAt: row.requestedAt,
    decision: row.decision,
    decidedBy: row.decidedBy,
    decidedAt: row.decidedAt,
    reason: row.reason,
  };
}

/** 按 id 幂等；同一事务里 upsertAlert(level 'decision', dedupeKey `approval:<id>`)，正文写明批什么（holds、PR、头）。 */
export async function openApproval(
  db: Db,
  input: {
    id: string;
    taskId: string;
    subtaskId: string | null;
    holds: string[];
    prNumber: number;
    head: string;
    title: string;
    summary: string;
  },
): Promise<{ created: boolean }> {
  return db.transaction(async (tx) => {
    const [row] = await tx
      .insert(approvals)
      .values({
        id: input.id,
        taskId: input.taskId,
        subtaskId: input.subtaskId,
        holds: input.holds,
        prNumber: input.prNumber,
        head: input.head,
        title: input.title,
        summary: input.summary,
      })
      .onConflictDoNothing({ target: approvals.id })
      .returning({ id: approvals.id });
    await upsertAlert(tx, {
      dedupeKey: `approval:${input.id}`,
      level: 'decision',
      taskId: input.taskId,
      title: input.title,
      body: `请批 ${input.holds.join('、')}：PR #${input.prNumber}（${input.head}）。${input.summary}`,
    });
    return { created: row !== undefined };
  });
}

export async function getApproval(db: Db, id: string): Promise<ApprovalRecord | null> {
  const [row] = await db.select().from(approvals).where(eq(approvals.id, id));
  return row ? mapApproval(row) : null;
}

export async function decideApproval(
  db: Db,
  input: { id: string; decision: 'approved' | 'rejected'; by: string; reason?: string },
): Promise<'ok' | 'already_decided' | 'not_found'> {
  const updated = await db
    .update(approvals)
    .set({
      decision: input.decision,
      decidedBy: input.by,
      decidedAt: new Date(),
      reason: input.reason ?? null,
    })
    .where(and(eq(approvals.id, input.id), isNull(approvals.decision)))
    .returning({ id: approvals.id });
  if (updated.length > 0) return 'ok';
  const [existing] = await db.select({ id: approvals.id }).from(approvals).where(eq(approvals.id, input.id));
  return existing ? 'already_decided' : 'not_found';
}
