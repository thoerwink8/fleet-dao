// 各家原始 verdict 不可被聚合覆盖；组合结论独立持久化并核对真实来源行。
import { RunVerdictSchema, type VerifyAggregate, VerifyAggregateSchema } from '@fleet-dao/shared';
import { and, eq, inArray, sql } from 'drizzle-orm';
import type { Db } from '../client.ts';
import { runs } from '../schema/runs.ts';
import { verifyAggregates } from '../schema/work.ts';

export async function recordVerifyAggregate(db: Db, value: VerifyAggregate): Promise<void> {
  const input = VerifyAggregateSchema.parse(value);
  const sourceRunIds = [...new Set(input.sourceRunIds)].sort();
  if (sourceRunIds.length !== input.sourceRunIds.length) throw new Error('聚合来源重复');
  const sourceKey = sourceRunIds.join(',');
  await db.transaction(async (tx) => {
    // 顺序锁来源行，重试及不同来源组合共用一笔时也不能竞相跨头绑定。
    const sources = await tx
      .select()
      .from(runs)
      .where(inArray(runs.id, sourceRunIds))
      .orderBy(runs.id)
      .for('update');
    if (
      sources.length !== sourceRunIds.length ||
      sources.some(
        (r) =>
          r.taskId !== input.taskId ||
          r.prNumber !== input.prNumber ||
          r.workflowId !== (input.workflowId ?? null) ||
          r.segment !== 'verify' ||
          r.verdict === null,
      )
    )
      throw new Error('聚合来源的任务、工作流、PR 或原始裁决不一致');
    const prior = await tx
      .select()
      .from(verifyAggregates)
      .where(
        sql`${verifyAggregates.sourceRunIds} && ARRAY[${sql.join(
          sourceRunIds.map((id) => sql`${id}::uuid`),
          sql`, `,
        )}]::uuid[]`,
      );
    if (
      prior.some(
        (r) =>
          r.taskId !== input.taskId ||
          r.workflowId !== (input.workflowId ?? null) ||
          r.prNumber !== input.prNumber ||
          r.headSha !== input.headSha ||
          r.round !== input.round,
      )
    )
      throw new Error('原始验收笔已绑定其他头或验收轮，不能复用来源');
    const key = and(
      eq(verifyAggregates.taskId, input.taskId),
      eq(verifyAggregates.prNumber, input.prNumber),
      eq(verifyAggregates.headSha, input.headSha),
      eq(verifyAggregates.round, input.round),
      eq(verifyAggregates.sourceKey, sourceKey),
    );
    await tx
      .insert(verifyAggregates)
      .values({ ...input, workflowId: input.workflowId ?? null, sourceRunIds, sourceKey })
      .onConflictDoNothing();
    const [stored] = await tx.select().from(verifyAggregates).where(key);
    if (
      !stored ||
      stored.workflowId !== (input.workflowId ?? null) ||
      JSON.stringify(RunVerdictSchema.parse(stored.verdict)) !== JSON.stringify(input.verdict)
    )
      throw new Error('相同聚合来源的裁决冲突');
  });
}

export async function listVerifyAggregates(db: Db, taskId: string) {
  return db.select().from(verifyAggregates).where(eq(verifyAggregates.taskId, taskId));
}
