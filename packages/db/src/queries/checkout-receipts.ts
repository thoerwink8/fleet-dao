// 完整检出成功证据独立于报警。每次物理调用一个 UUID；仅相同内容重送可幂等。
import { and, eq, sql } from 'drizzle-orm';
import type { Db } from '../client.ts';
import { auditLog } from '../schema/ops.ts';

export interface CheckoutReceiptInput {
  receiptId: string;
  taskId?: string | undefined;
  runId?: string | undefined;
  workflowId: string | undefined;
  head: string;
  dir: string;
  startedAt: Date;
  completedAt: Date;
  type: 'full';
}
export async function recordCheckoutReceipt(db: Db, receipt: CheckoutReceiptInput): Promise<void> {
  if (
    !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(receipt.receiptId) ||
    !/^[0-9a-f]{40}$/.test(receipt.head) ||
    !receipt.dir.trim() ||
    !receipt.workflowId?.trim() ||
    receipt.type !== 'full' ||
    !Number.isFinite(receipt.startedAt.getTime()) ||
    !Number.isFinite(receipt.completedAt.getTime()) ||
    receipt.completedAt < receipt.startedAt
  )
    throw new Error('完整检出成功回执身份或时间不合法');
  const target = `checkout:${receipt.receiptId}`;
  const action = 'cold_verify.checkout_full';
  const after = {
    receiptId: receipt.receiptId,
    taskId: receipt.taskId ?? null,
    runId: receipt.runId ?? null,
    workflowId: receipt.workflowId,
    head: receipt.head,
    dir: receipt.dir,
    startedAt: receipt.startedAt.toISOString(),
    completedAt: receipt.completedAt.toISOString(),
    type: receipt.type,
  };
  await db.transaction(async (tx) => {
    // 现有审计表没有业务唯一键；同一回执的查重和写入必须串行，不能先查后裸写。
    await tx.execute(sql`select pg_advisory_xact_lock(hashtextextended(${target}, 3177))`);
    const [prior] = await tx
      .select({ after: auditLog.after })
      .from(auditLog)
      .where(and(eq(auditLog.target, target), eq(auditLog.action, action)))
      .limit(1);
    if (prior) {
      // jsonb 的键顺序不是输入顺序，逐字段核对，不能覆盖不同调用。
      const stored = prior.after as Record<string, unknown>;
      if (
        !stored ||
        Object.keys(stored).length !== Object.keys(after).length ||
        Object.entries(after).some(([key, value]) => stored[key] !== value)
      )
        throw new Error('完整检出成功回执 ID 已用于不同内容');
      return;
    }
    await tx.insert(auditLog).values({
      actorKind: 'engine',
      actorId: 'cold-verify-checkout',
      action,
      target,
      after,
      via: 'engine',
      ok: true,
    });
  });
}
