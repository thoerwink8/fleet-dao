// runs 表：三段各跑一次（scope / manual / verify）的流水账。
// #556-6 写作入口；结构照 #554-1 RunRecord。落那一端的 ofORM 类型。
// 操作条款：
// - start/runId：幂等（同一次跑写进去两笔）
// - endedAt / outcome 一对空/不空；
// - 读不到的字段 NULL，不拿 0 顶（#216）。

import { randomUUID } from 'node:crypto';
import { errMessage } from '@fleet-dao/shared/util';
import { and, asc, eq, gte, isNotNull, isNull, or, sql } from 'drizzle-orm';
import type { Db } from '../client.ts';
import { type RunRouteOutcome, type RunTier, routes, runs } from '../schema/index.ts';

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
  /** 这一次算不算这条路由的账（收场才有）；没给就是 NULL（按不算账读）。 */
  routeOutcome?: RunRouteOutcome | null;
  inputTokens?: number | null;
  outputTokens?: number | null;
  cacheReadTokens?: number | null;
  cacheWriteTokens?: number | null;
  costUsd?: number | null;
  /** 执行体报的会话号（收场才有）；没读到不给。 */
  sessionId?: string | null;
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
  routeOutcome?: RunRouteOutcome | null;
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
 * 起一段时记一笔；同 runId 再记不重复建（onConflictDoUpdate）。再记时：开跑写的那几列（单子、派工档、工作流、PR、分支……）
 * 整行覆盖，这一次没给的写回 NULL，收场补完开跑那一行时要把它们再带一遍；收场才有的列（endedAt、outcome、routeOutcome、
 * 用量、花费、内存峰值、失败原因）没给就保留库里已有的，所以重放的开跑不会把已经收场的那一行冲回「还在跑」。
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
    const message = errMessage(error);
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
    ...(row.routeOutcome !== undefined ? { routeOutcome: row.routeOutcome } : {}),
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
    const message = errMessage(error);
    throw new RunInputError(`更新 runs 失败：${message}`, { cause: error });
  }
}

/** 查一段。不给 id 就查不到。 */
export async function getRun(db: Db, id: string): Promise<RunRow | null> {
  const [row] = await db.select().from(runs).where(eq(runs.id, id)).limit(1);
  return row ?? null;
}

/**
 * 一张单的三段流水（任务详情读）：task_id 对得上的，加上 task_id 没记、单号和工作流编号都对得上的老行（兜底，调用方要标明）。
 * 单号在几个仓里会重：兜底必须靠工作流编号（带着仓名）认；工作流编号也没记的行分不出是哪个仓的，不收——
 * 宁可少一行，也不把别的仓同号的单的会话混进这张单。
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
          eq(runs.workflowId, task.workflowId),
        ),
      ),
    )
    .orderBy(asc(runs.startedAt), asc(runs.createdAt), asc(runs.id));
}

/**
 * 把还没结束的行都收成 killed、写明为什么，交回收掉的编号。只给引擎起来、接活之前用（#157）：一次性会话不脱开引擎进程跑，
 * 上一轮引擎一退它们就断了（起来时的收尾收掉了它们的 scope），库里那几行不收，切号就一直以为它们在跑、一直等。
 * 收的时刻早于开跑时刻（时钟回拨）就按开跑时刻收，不撞 runs_ended_after_start。是引擎退了断的，不算路由的账（neutral）。
 */
export async function closeOpenRuns(db: Db, input: { endedAt: Date; reason: string }): Promise<string[]> {
  if (!input.reason.trim()) throw new RunInputError('收掉没结束的 runs 要写为什么');
  try {
    const rows = await db
      .update(runs)
      .set({
        endedAt: sql`greatest(${input.endedAt.toISOString()}::timestamptz, ${runs.startedAt})`,
        outcome: 'killed',
        routeOutcome: 'neutral',
        failureReason: input.reason,
        updatedAt: input.endedAt,
      })
      .where(isNull(runs.endedAt))
      .returning({ id: runs.id });
    return rows.map((r) => r.id);
  } catch (error) {
    const message = errMessage(error);
    throw new RunInputError(`收掉没结束的 runs 失败：${message}`, { cause: error });
  }
}

/** 四样 token 有一样没记上（「用量补记」要补的那几笔，和补齐之后不再碰的判法是同一条）。 */
const usageIncomplete = or(
  isNull(runs.inputTokens),
  isNull(runs.outputTokens),
  isNull(runs.cacheReadTokens),
  isNull(runs.cacheWriteTokens),
);

/** 等「用量补记」补的一笔：经 Mirasim 起、记了会话号、结束了、四样 token 有缺的。 */
export interface MeterPendingRun {
  id: string;
  /** Mirasim 服务端回的 <执行体>:<uuid>。 */
  sessionId: string;
  model: string;
  startedAt: Date;
  endedAt: Date;
  usageNote: string | null;
}

/**
 * 经 Mirasim 起（路由的执行方式是 mirasim）、endedAfter 以后结束、记了会话号、四样 token 有缺的那几笔，先结束的在前，最多 limit 笔
 * （#1935）。没记会话号的老行补不了（不知道是哪个会话），不在里面。
 */
export async function runsAwaitingMeter(
  db: Db,
  input: { endedAfter: Date; limit: number },
): Promise<MeterPendingRun[]> {
  if (!Number.isInteger(input.limit) || input.limit <= 0)
    throw new RunInputError(`limit 要是正整数：${input.limit}`);
  const rows = await db
    .select({
      id: runs.id,
      sessionId: runs.sessionId,
      model: runs.model,
      startedAt: runs.startedAt,
      endedAt: runs.endedAt,
      usageNote: runs.usageNote,
    })
    .from(runs)
    .innerJoin(routes, eq(routes.id, runs.routeId))
    .where(
      and(
        eq(routes.hostId, 'mirasim'),
        isNotNull(runs.sessionId),
        isNotNull(runs.endedAt),
        gte(runs.endedAt, input.endedAfter),
        usageIncomplete,
      ),
    )
    .orderBy(asc(runs.endedAt), asc(runs.id))
    .limit(input.limit);
  return rows.flatMap((r) =>
    r.sessionId !== null && r.endedAt !== null ? [{ ...r, sessionId: r.sessionId, endedAt: r.endedAt }] : [],
  );
}

/** 中转计量回填齐了的一次会话的用量（四样都读到了才有这一份；花费中转报了才有）。 */
export interface MeterUsageWrite {
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  cacheWriteTokens: number;
  costUsd?: number | undefined;
}

/**
 * 把读齐了的用量写回这一笔：四样 token 整套换成计量的数（会话结束时快照里的输出只是近似，计量才是逐次调用的账），中转报了花费才写
 * 花费，清掉原因。只改四样还有缺的行：补齐了的再来一遍什么都不做（回 false），重复跑、两轮叠着跑都不会改第二次。
 */
export async function fillRunUsageFromMeter(
  db: Db,
  input: { runId: string; usage: MeterUsageWrite; at: Date },
): Promise<boolean> {
  const u = input.usage;
  for (const [name, v] of Object.entries({
    inputTokens: u.inputTokens,
    outputTokens: u.outputTokens,
    cacheReadTokens: u.cacheReadTokens,
    cacheWriteTokens: u.cacheWriteTokens,
  })) {
    if (!Number.isSafeInteger(v) || v < 0) throw new RunInputError(`${name} 要是非负整数：${v}`);
  }
  if (u.costUsd !== undefined && !(Number.isFinite(u.costUsd) && u.costUsd >= 0)) {
    throw new RunInputError(`costUsd 要是非负数：${u.costUsd}`);
  }
  const rows = await db
    .update(runs)
    .set({
      inputTokens: u.inputTokens,
      outputTokens: u.outputTokens,
      cacheReadTokens: u.cacheReadTokens,
      cacheWriteTokens: u.cacheWriteTokens,
      ...(u.costUsd !== undefined ? { costUsd: u.costUsd } : {}),
      usageNote: null,
      updatedAt: input.at,
    })
    .where(and(eq(runs.id, input.runId), isNotNull(runs.endedAt), usageIncomplete))
    .returning({ id: runs.id });
  return rows.length > 0;
}

/** 这一笔用量为什么还没记全（四样还有缺才写；原因没变不重写）。写了回 true。 */
export async function noteRunUsage(
  db: Db,
  input: { runId: string; note: string; at: Date },
): Promise<boolean> {
  if (!input.note.trim()) throw new RunInputError('用量没记全的原因是空的');
  const rows = await db
    .update(runs)
    .set({ usageNote: input.note, updatedAt: input.at })
    .where(
      and(eq(runs.id, input.runId), usageIncomplete, sql`${runs.usageNote} is distinct from ${input.note}`),
    )
    .returning({ id: runs.id });
  return rows.length > 0;
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
    routeOutcome: row.routeOutcome ?? null,
    inputTokens: row.inputTokens ?? null,
    outputTokens: row.outputTokens ?? null,
    cacheReadTokens: row.cacheReadTokens ?? null,
    cacheWriteTokens: row.cacheWriteTokens ?? null,
    costUsd: row.costUsd ?? null,
    sessionId: row.sessionId ?? null,
    // 只由「用量补记」写（fillRunUsageFromMeter / noteRunUsage），记一笔时不碰
    usageNote: null,
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

/** 再记时要改的列：收场才有的那几列用 coalesce(新值, 库里已有的)，没给就不清。 */
function pickRowWithoutId(r: RunRowSure) {
  const { id: _i, createdAt: _c, usageNote: _n, ...rest } = r;
  return {
    ...rest,
    sessionId: sql`coalesce(${r.sessionId}, ${runs.sessionId})`,
    endedAt: sql`coalesce(${r.endedAt?.toISOString() ?? null}::timestamptz, ${runs.endedAt})`,
    outcome: sql`coalesce(${r.outcome}, ${runs.outcome})`,
    routeOutcome: sql`coalesce(${r.routeOutcome}, ${runs.routeOutcome})`,
    inputTokens: sql`coalesce(${r.inputTokens}::bigint, ${runs.inputTokens})`,
    outputTokens: sql`coalesce(${r.outputTokens}::bigint, ${runs.outputTokens})`,
    cacheReadTokens: sql`coalesce(${r.cacheReadTokens}::bigint, ${runs.cacheReadTokens})`,
    cacheWriteTokens: sql`coalesce(${r.cacheWriteTokens}::bigint, ${runs.cacheWriteTokens})`,
    costUsd: sql`coalesce(${r.costUsd}::numeric, ${runs.costUsd})`,
    memoryPeakMb: sql`coalesce(${r.memoryPeakMb}::integer, ${runs.memoryPeakMb})`,
    failureReason: sql`coalesce(${r.failureReason}, ${runs.failureReason})`,
  };
}
