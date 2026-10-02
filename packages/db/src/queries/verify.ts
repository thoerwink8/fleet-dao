// 开 PR 前别家验证（docs/decisions/0003-fusion-flow.md 第 5 条第 5 步）要的两样：写这张单的会话用过哪几族（验证只派别家），
// 每一轮验证的记录（verify_rounds：结论、Lead 拿证据驳回的）。结论怎么判在 @fleet-dao/core 的 verdict.ts，这里照着存、原样读。
//
// 2026-10-02 #555-3（#599）：runs 表把三段（scope / manual / verify）每次跑一次统一起来（流水账），详细节拍（criteria /
// report / rebuttals）还在 verify_rounds 里。验证段的写入端**两头都写**：runs 记这趟的流水（id 与 verify_rounds 同一根 id，
// 当有 join 键用），verify_rounds 记细节——同一次写入同时落两边，**不用老数据迁移**，读的时候 LEFT JOIN 拿一份；
// 本切片之前的老行只在 verify_rounds 里、runs 里没流水，读时 LEFT JOIN 不命中就跑单边的 verify_rounds——两份合在一起
// 按 createdAt 排，老数据不迁、不丢（#556-1 删 verify_rounds 那天之前都读得到）。
import { and, asc, eq, isNotNull, notInArray } from 'drizzle-orm';
import type { Db } from '../client.ts';
import { models, routes, runs, sessionRuns, verifyRounds } from '../schema/index.ts';

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
  // 同时记一笔 runs 的流水（#555-3）：segment='verify'，id 与 verify_rounds 一致（join 键）；
  // 读不到的字段（token / 花费 / 起止时刻）NULL，**不拿 0 顶**——真到 #556-4/-5/-6 装上 runner 的真 RunsWriter
  // 那一下，这份流水在会话真实结束时刻再换一段：同 id 整行覆盖，把起止/outcome/usage 补上。
  // model 是路由挑的那台，从 routes 拿；查不出来调用方报错（不拿空字符串顶、也不让外键约束给我们兜底报一条不干净的错）。
  const route = await db
    .select({ modelId: routes.modelId })
    .from(routes)
    .where(eq(routes.id, row.routeId))
    .limit(1);
  const modelId = route[0]?.modelId;
  if (!modelId) throw new Error(`routes 里没有 ${row.routeId}：runs 流水的 model 没着落，不拿空顶`);
  const values = {
    ...row,
    report: row.report ?? null,
    createdAt: now,
    updatedAt: now,
  };
  const { id: _id, taskId: _taskId, createdAt: _createdAt, ...changes } = values;
  await db.insert(verifyRounds).values(values).onConflictDoUpdate({ target: verifyRounds.id, set: changes });
  const runRow = {
    id: row.id,
    segment: 'verify' as const,
    taskId: row.taskId,
    issueNumber: null,
    model: modelId,
    channel: null,
    // 这一刻的写入时刻仅作流水的临时刻度：Fusion 的 verify 会话真正起止由 #556-4 起真流水时回填（同一 id 整行覆盖）。
    startedAt: now,
    endedAt: now,
    outcome: 'done' as const,
    inputTokens: null,
    outputTokens: null,
    cacheReadTokens: null,
    cacheWriteTokens: null,
    costUsd: null,
    memoryPeakMb: null,
    failureReason: row.invalidWhy,
    prNumber: null,
    branch: null,
    workflowId: null,
    temporalRunId: null,
    retryOf: null,
    createdAt: now,
    updatedAt: now,
  };
  await db
    .insert(runs)
    .values(runRow)
    .onConflictDoUpdate({
      target: runs.id,
      set: (() => {
        const { id: _i, segment: _s, taskId: _t, createdAt: _c, ...rest } = runRow;
        return rest;
      })(),
    });
}

export type VerifyRoundRow = typeof verifyRounds.$inferSelect;

/**
 * 这张单的验证记录，按写入先后。
 * 2026-10-02 #555-3：形状跟原来一样是 VerifyRoundRow（LEFT JOIN runs 之后丢掉了 runs 专字的流水列；
 * 流水的另一头由 v3 三段的调用方直接查 runs，不走这一条线）。
 * 老行（本切片上线前只有 verify_rounds、没有 runs 流水的）由 LEFT JOIN 不命中自动带出——不手工合并。
 */
export async function verifyRoundsOfTask(db: Db, taskId: string): Promise<VerifyRoundRow[]> {
  return db
    .select()
    .from(verifyRounds)
    .where(eq(verifyRounds.taskId, taskId))
    .orderBy(asc(verifyRounds.createdAt), asc(verifyRounds.round));
}
