// runs 表：三段各跑一次（scope / manual / verify）的流水账。
// #556-6 写作入口；结构照 #554-1 RunRecord。落那一端的 ofORM 类型。
// 操作条款：
// - start/runId：幂等（同一次跑写进去两笔）
// - endedAt / outcome 一对空/不空；
// - 读不到的字段 NULL，不拿 0 顶（#216）。
import { randomUUID } from 'node:crypto';
import { and, asc, eq, isNull, or, sql } from 'drizzle-orm';
import type { Db } from '../client.ts';
import { type RunTier, runs } from '../schema/index.ts';

export type RunOutcome =
  | 'done'
  | 'timeout'
  | 'killed'
  | 'spawn_failed'
  | 'admission_blocked'
  | 'failed'
  | 'org_switch';

export interface RunInsert {
  id?: string;
  segment: 'scope' | 'manual' | 'verify';
  /** 挂在哪张单上（tasks.id）；没给就是 NULL（读的一方按单号兜底）。 */
  taskId?: string | undefined;
  issueNumber?: number | undefined;
  model: string;
  channel?: string | undefined;
  /** 跑在哪条路由上：切号靠它连到池（#157）。 */
  routeId?: string | undefined;
  /** 派工档（只有动手段分档）；没给就是没记（NULL）。 */
  tier?: RunTier | undefined;
  startedAt?: Date;
  endedAt?: Date;
  outcome?: RunOutcome;
  inputTokens?: number | null;
  outputTokens?: number | null;
  cacheReadTokens?: number | null;
  cacheWriteTokens?: number | null;
  costUsd?: number | null;
  memoryPeakMb?: number | null;
  failureReason?: string | null;
  prNumber?: number | undefined;
  branch?: string | undefined;
  workflowId?: string | undefined;
  temporalRunId?: string;
  retryOf?: string[];
}

export interface RunFinishInput {
  runId: string;
  outcome?: RunOutcome;
  startedAt?: Date;
  endedAt?: Date;
  inputTokens?: number | null;
  outputTokens?: number | null;
  cacheReadTokens?: number | null;
  cacheWriteTokens?: number | null;
  costUsd?: number | null;
  memoryPeakMb?: number | null;
  failureReason?: string | null;
  retryOf?: string[];
}

export type RunRow = typeof runs.$inferSelect;

export class RunInputError extends Error {
  constructor(message: string, options?: { cause?: unknown }) {
    super(message, options);
    this.name = 'RunInputError';
  }
}

type RunRowSure = Omit<RunRow, 'id'> & { id: string };

/**
 * 起一段时记一笔；同 runId 再记不重复建（onConflictDoUpdate）。再记是整行覆盖：这一次没给的列写回 NULL，
 * 收场补完开跑那一行时要把开跑写过的列（单子、派工档、工作流、PR、分支……）再带一遍。
 */
export async function startRun(db: Db, row: RunInsert, now: Date = new Date()): Promise<{ id: string }> {
  if (!row.segment) throw new RunInputError('segment 是空的');
  if (!row.model) throw new RunInputError('model 是空的');
  const r = toRow(row, now);
  try {
    await db
      .insert(runs)
      .values(r)
      .onConflictDoUpdate({
        target: runs.id,
        set: pickRowWithoutId(r),
      });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    throw new RunInputError(`写入 runs 失败：${message}`, { cause: error });
  }
  return { id: r.id };
}

/** 结束。幂等：重复结束不再记。 */
export async function finishRun(
  db: Db,
  row: RunFinishInput,
  now: Date = new Date(),
): Promise<'finished' | 'not_found'> {
  const changes = {
    endedAt: row.endedAt ?? now,
    outcome: row.outcome,
    ...(row.inputTokens !== undefined ? { inputTokens: row.inputTokens } : {}),
    ...(row.outputTokens !== undefined ? { outputTokens: row.outputTokens } : {}),
    ...(row.cacheReadTokens !== undefined ? { cacheReadTokens: row.cacheReadTokens } : {}),
    ...(row.cacheWriteTokens !== undefined ? { cacheWriteTokens: row.cacheWriteTokens } : {}),
    ...(row.costUsd !== undefined ? { costUsd: row.costUsd } : {}),
    ...(row.memoryPeakMb !== undefined ? { memoryPeakMb: row.memoryPeakMb } : {}),
    ...(row.failureReason !== undefined ? { failureReason: row.failureReason } : {}),
    updatedAt: now,
  };
  try {
    const updated = await db
      .update(runs)
      .set(changes)
      .where(and(eq(runs.id, row.runId), isNull(runs.endedAt)))
      .returning({ id: runs.id });
    return updated.length > 0 ? 'finished' : 'not_found';
  } catch (error) {
    if (error instanceof RunInputError) throw error;
    const message = error instanceof Error ? error.message : String(error);
    throw new RunInputError(`更新 runs 失败：${message}`, { cause: error });
  }
}

/** 查一段。不给 id 就查不到。 */
export async function getRun(db: Db, id: string): Promise<RunRow | null> {
  const [row] = await db.select().from(runs).where(eq(runs.id, id)).limit(1);
  return row ?? null;
}

/** 查还没跑的（ended_at 为空的）。 */
export async function listOpenRuns(db: Db): Promise<RunRow[]> {
  return db.select().from(runs).where(isNull(runs.endedAt)).orderBy(asc(runs.createdAt));
}

/** 按 issue 查三段的。 */
export async function runsOfIssue(db: Db, issueNumber: number): Promise<RunRow[]> {
  return db.select().from(runs).where(eq(runs.issueNumber, issueNumber)).orderBy(asc(runs.createdAt));
}

/**
 * 一张单的三段流水（任务详情读）：task_id 对得上的，加上 task_id 没记、单号对得上的老行（兜底，调用方要标明）。
 * 单号在几个仓里会重：兜底的行记了工作流编号、却不是这张单的（别的仓同号的单、巡检这类），不收；没记工作流编号的分不出，照收。
 * 按起跑先后排。
 */
export async function runsOfTask(
  db: Db,
  task: { id: string; issueNumber: number; workflowId: string },
): Promise<RunRow[]> {
  return db
    .select()
    .from(runs)
    .where(
      or(
        eq(runs.taskId, task.id),
        and(
          isNull(runs.taskId),
          eq(runs.issueNumber, task.issueNumber),
          or(isNull(runs.workflowId), eq(runs.workflowId, task.workflowId)),
        ),
      ),
    )
    .orderBy(asc(runs.startedAt), asc(runs.createdAt), asc(runs.id));
}

/**
 * 把还没结束的行都收成 killed、写明为什么，交回收掉的编号。只给引擎起来、接活之前用（#157）：一次性会话不脱开引擎进程跑，
 * 上一轮引擎一退它们就断了（起来时的收尾收掉了它们的 scope），库里那几行不收，切号就一直以为它们在跑、一直等。
 * 收的时刻早于开跑时刻（时钟回拨）就按开跑时刻收，不撞 runs_ended_after_start。
 */
export async function closeOpenRuns(db: Db, input: { endedAt: Date; reason: string }): Promise<string[]> {
  if (!input.reason.trim()) throw new RunInputError('收掉没结束的 runs 要写为什么');
  try {
    const rows = await db
      .update(runs)
      .set({
        endedAt: sql`greatest(${input.endedAt.toISOString()}::timestamptz, ${runs.startedAt})`,
        outcome: 'killed',
        failureReason: input.reason,
        updatedAt: input.endedAt,
      })
      .where(isNull(runs.endedAt))
      .returning({ id: runs.id });
    return rows.map((r) => r.id);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    throw new RunInputError(`收掉没结束的 runs 失败：${message}`, { cause: error });
  }
}

/** 各段 loading: RunInsert -> 写入形状。 */
function toRow(row: RunInsert, now: Date): RunRowSure {
  return {
    id: row.id ?? randomUUID(),
    segment: row.segment,
    taskId: row.taskId ?? null,
    issueNumber: row.issueNumber ?? null,
    model: row.model,
    channel: row.channel ?? null,
    routeId: row.routeId ?? null,
    tier: row.tier ?? null,
    startedAt: row.startedAt ?? now,
    endedAt: row.endedAt ?? null,
    outcome: row.outcome ?? null,
    inputTokens: row.inputTokens ?? null,
    outputTokens: row.outputTokens ?? null,
    cacheReadTokens: row.cacheReadTokens ?? null,
    cacheWriteTokens: row.cacheWriteTokens ?? null,
    costUsd: row.costUsd ?? null,
    memoryPeakMb: row.memoryPeakMb ?? null,
    failureReason: row.failureReason ?? null,
    prNumber: row.prNumber ?? null,
    branch: row.branch ?? null,
    workflowId: row.workflowId ?? null,
    temporalRunId: row.temporalRunId ?? null,
    retryOf: null,
    createdAt: now,
    updatedAt: now,
  };
}

function pickRowWithoutId(r: RunRowSure) {
  const { id: _i, createdAt: _c, ...rest } = r;
  return rest;
}
