// 开 PR 前别家验证（docs/decisions/0003-fusion-flow.md 第 5 条第 5 步）要的两样：写这张单的会话用过哪几族（验证只派别家），
// 每一轮验证的记录（verify_rounds：结论、Lead 拿证据驳回的）。结论怎么判在 @fleet-dao/core 的 verdict.ts，这里照着存、原样读。
import { and, asc, eq, isNotNull, notInArray } from 'drizzle-orm';
import type { Db } from '../client.ts';
import { models, routes, sessionRuns, verifyRounds } from '../schema/index.ts';

/**
 * 不算「写这张单」的阶段：验证、审查（第二意见、方案评审）只看不写，判断题不起会话。别的阶段（分诊、需求文档、方案、写码……）
 * 宁可多算：多算一族只是少一个能验的，少算了就可能派到同族自己验自己。
 */
const NOT_AUTHORING = ['verify', 'review', 'judge'] as const;

/**
 * 写这张单的会话用过的路由的族（去重、按字母排）：这张单上真起过（有开工时刻）的会话，按路由查模型目录里的族。
 * 一个都没有返回空数组——调用方要明确报错（判不了是不是别家），不当成「谁都能验」。
 */
export async function authorFamiliesOfTask(db: Db, taskId: string): Promise<string[]> {
  const rows = await db
    .selectDistinct({ family: models.family })
    .from(sessionRuns)
    .innerJoin(routes, eq(routes.id, sessionRuns.routeId))
    .innerJoin(models, eq(models.id, routes.modelId))
    .where(
      and(
        eq(sessionRuns.taskId, taskId),
        isNotNull(sessionRuns.startedAt),
        notInArray(sessionRuns.stage, [...NOT_AUTHORING]),
      ),
    );
  return rows.map((r) => r.family).sort();
}

/** 一轮验证的记录：整行给齐，同一个 id 再写就整行覆盖（重试幂等；Lead 回话后再写一次带上驳回和驳回之后的结论）。 */
export interface VerifyRoundRecord {
  id: string;
  taskId: string;
  round: number;
  head: string;
  runId: string;
  routeId: string;
  family: string;
  authorFamilies: string[];
  criteria: string[];
  /** 验证模型交回的原样（作废的可以是空）。 */
  report: unknown;
  verdict: 'pass' | 'block' | 'invalid';
  invalidWhy: string | null;
  rebuttals: { target: string; evidence: string }[];
  finalVerdict: 'pass' | 'block' | null;
  reasons: string[];
  notes: string[];
}

export async function saveVerifyRound(db: Db, row: VerifyRoundRecord, now: Date = new Date()): Promise<void> {
  const values = {
    ...row,
    report: row.report ?? null,
    createdAt: now,
    updatedAt: now,
  };
  const { id: _id, taskId: _taskId, createdAt: _createdAt, ...changes } = values;
  await db.insert(verifyRounds).values(values).onConflictDoUpdate({ target: verifyRounds.id, set: changes });
}

export type VerifyRoundRow = typeof verifyRounds.$inferSelect;

/** 这张单的验证记录，按写入先后。 */
export async function verifyRoundsOfTask(db: Db, taskId: string): Promise<VerifyRoundRow[]> {
  return db
    .select()
    .from(verifyRounds)
    .where(eq(verifyRounds.taskId, taskId))
    .orderBy(asc(verifyRounds.createdAt), asc(verifyRounds.round));
}
