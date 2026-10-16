// 人闸批准：开一条待批（同事务报一条 decision 级报警）、读。
import type { DecisionOption } from '@fleet-dao/shared';
import { eq } from 'drizzle-orm';
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

/**
 * 人闸待批的选项（#1915、#1931）：先看看、批、不批。推荐先看 PR：人闸拦的就是要人亲眼看过的改动。
 * 在这里拍不会替人写批准（approvals 表的 decision 不动）：批、不批都写明「记下交给指挥官去办」；先看看带 keepsOpen，这条留着等看完。
 */
export function approvalOptions(prNumber: number): DecisionOption[] {
  return [
    {
      id: 'review',
      label: '先看 PR 再定',
      detail: `这条留着；我去看 PR #${prNumber} 的改动，看完再批或不批`,
      recommended: '人闸拦下的就是要人亲眼看过的改动（删数据、改标准这类），看了再批最稳',
      keepsOpen: true,
    },
    {
      id: 'approve',
      label: '批，合进去',
      detail: `这条转已处理，记下交给指挥官去批、合 PR #${prNumber}`,
    },
    {
      id: 'reject',
      label: '不批',
      detail: `这条转已处理，记下交给指挥官：PR #${prNumber} 不合，去问清楚或撤掉`,
    },
  ];
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
      options: approvalOptions(input.prNumber),
      // 人闸要人批（#2729）：批不批只有创始人能定
      reason: 'human-only',
    });
    return { created: row !== undefined };
  });
}

export async function getApproval(db: Db, id: string): Promise<ApprovalRecord | null> {
  const [row] = await db.select().from(approvals).where(eq(approvals.id, id));
  return row ? mapApproval(row) : null;
}
