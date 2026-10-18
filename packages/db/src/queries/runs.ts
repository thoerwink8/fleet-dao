// runs 表：三段各跑一次（scope / manual / verify）的流水账。
// #556-6 写作入口；结构照 #554-1 RunRecord。落那一端的 ofORM 类型。
// 操作条款：
// - start/runId：幂等（同一次跑写进去两笔）
// - endedAt / outcome 一对空/不空；
// - 读不到的字段 NULL，不拿 0 顶（#216）。确定没发出模型调用的例外：记 0 并写 usage_note（#2689）。

import { randomUUID } from 'node:crypto';
import {
  clipCauseSummary,
  laterGenerationPattern,
  type RunCause,
  type RunVerdict,
  RunVerdictSchema,
  sessionlessUsage,
  USAGE_SESSION_UNREAD,
} from '@fleet-dao/shared';
import { errMessage } from '@fleet-dao/shared/util';
import { and, asc, desc, eq, gte, inArray, isNotNull, isNull, notInArray, or, sql } from 'drizzle-orm';
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
  /** 选路时那句「为什么派它」。没给就是没记（NULL）。收场没带就留着开跑写的，不冲成空。 */
  routeWhy?: string | null;
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
  /** 判定这一段要续的上一段会话号；用于统计实际续上的比例。 */
  resumeSessionId?: string | null;
  /** 判定不开上一段会话、改开新会话的原因。 */
  resumeReason?: string | null;
  /** 为什么起这一笔（#3140，shared 的 RUN_CAUSES）；老行、不经任务工作流的不给。 */
  cause?: RunCause | null;
  /** 起因摘要（≤500 字，写之前截断）。 */
  causeSummary?: string | null;
  /** 这一笔属于第几个回合（task_rounds.seq，#3140）。 */
  roundSeq?: number | null;
  /** 冷验收的结论（验收那一笔，#3140）；开跑、收场不带，验收有结论后由 noteRunVerdict 写。 */
  verdict?: RunVerdict | null;
  /**
   * 用量没照终帧读到时记的「怎么来的、为什么缺」（白话）：会话被叫停、超时杀时各家插头给的那句写进 runs.usage_note。
   * 没读到就不写（交给「用量补记」按会话号补）。
   */
  usageNote?: string | null;
  memoryPeakMb?: number | null;
  /** 这一次会话的 CPU 秒数；没读到不给（NULL），不写 0。 */
  cpuSeconds?: number | null;
  failureReason?: string | null;
  prNumber?: number | undefined;
  branch?: string | undefined;
  /** 会话起在哪个目录（工作树路径）；开跑、收场两次都要带，没给写回 NULL。 */
  worktreePath?: string | undefined;
  workflowId?: string | undefined;
  temporalRunId?: string;
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
  cpuSeconds?: number | null;
  failureReason?: string | null;
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

/**
 * 冷验收有结论了：把结论写在验收那一笔上（#3140，过没过、哪几条没过、转给人的）。会话已经收场（那一行早写好了），所以单独写这一列；
 * 同一笔再写以最后一次为准（接回后重验）。结论形状不对、这一笔不在 runs 里都抛，不悄悄丢。
 */
export async function noteRunVerdict(db: Db, runId: string, verdict: RunVerdict): Promise<void> {
  const parsed = RunVerdictSchema.safeParse(verdict);
  if (!parsed.success) throw new RunInputError(`验收结论的形状不对：${parsed.error.message}`);
  const done = await db
    .update(runs)
    .set({ verdict: parsed.data, updatedAt: new Date() })
    .where(eq(runs.id, runId))
    .returning({ id: runs.id });
  if (done.length === 0) throw new RunInputError(`验收结论没写进去：库里没有这一笔（${runId}）`);
}

/**
 * 过程记录挂在 runs 上（外键）。提需求、临时指挥官不走 runOneShot，本来不写这一行，第一条 prompt 就被外键挡掉、
 * 之后每次重试都带着它整批失败。写过程记录之前补一行锚点：没有 route_id（不占池的名额）、没有 task（不是三段派单）。
 * 已经有这一行（三段会话开跑时写过）就什么都不改，避免把开跑那一行冲掉。返回是不是这次补上的。
 */
export async function ensureRunForTranscript(
  db: Db,
  row: { id: string; segment: RunInsert['segment']; model: string; startedAt?: Date },
): Promise<boolean> {
  const startedAt = row.startedAt ?? new Date();
  const inserted = await db
    .insert(runs)
    .values({
      id: row.id,
      segment: row.segment,
      model: row.model,
      startedAt,
    })
    .onConflictDoNothing({ target: runs.id })
    .returning({ id: runs.id });
  return inserted.length > 0;
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
    ...(row.cpuSeconds !== undefined ? { cpuSeconds: row.cpuSeconds } : {}),
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

/** 流里提前拿到真会话号时先写回；已经收场的行不改，避免把晚到的临时号盖进账本。 */
export async function observeRunSessionId(
  db: Db,
  input: { runId: string; sessionId: string },
): Promise<boolean> {
  const sessionId = input.sessionId.trim();
  if (!sessionId) throw new RunInputError('会话号是空的');
  try {
    const rows = await db
      .update(runs)
      .set({ sessionId, updatedAt: new Date() })
      .where(and(eq(runs.id, input.runId), isNull(runs.endedAt), isNull(runs.sessionId)))
      .returning({ id: runs.id });
    return rows.length > 0;
  } catch (error) {
    const message = errMessage(error);
    throw new RunInputError(`提前写入 runs 会话号失败：${message}`, { cause: error });
  }
}

/** 查一段。不给 id 就查不到。 */
export async function getRun(db: Db, id: string): Promise<RunRow | null> {
  const [row] = await db.select().from(runs).where(eq(runs.id, id)).limit(1);
  return row ?? null;
}

export interface RunSessionIdStat {
  /** 路由没有执行方式时归到 unknown。 */
  hostId: string;
  endedRuns: number;
  missingSessionIds: number;
}

/**
 * 按执行方式数一段时间内已结束的 runs，以及其中没有会话号的笔数。
 * 左连路由是为了不把旧的无路由记录悄悄漏掉；这类归 unknown。
 */
export async function runSessionIdStats(
  db: Db,
  input: { endedAfter: Date; endedBefore?: Date },
): Promise<RunSessionIdStat[]> {
  const rows = await db
    .select({
      hostId: routes.hostId,
      endedRuns: sql<string>`count(*)`,
      missingSessionIds: sql<string>`count(*) filter (where ${runs.sessionId} is null)`,
    })
    .from(runs)
    .leftJoin(routes, eq(routes.id, runs.routeId))
    .where(
      and(
        isNotNull(runs.endedAt),
        gte(runs.endedAt, input.endedAfter),
        ...(input.endedBefore ? [sql`${runs.endedAt} < ${input.endedBefore}`] : []),
      ),
    )
    .groupBy(routes.hostId)
    .orderBy(asc(routes.hostId));
  return rows.map((row) => ({
    hostId: row.hostId ?? 'unknown',
    endedRuns: Number(row.endedRuns),
    missingSessionIds: Number(row.missingSessionIds),
  }));
}

/**
 * 一张单某一段最近起的那一次（续会话找上一段的会话号用）：只认 task_id 对得上的；给了 startedAfter 只看那之后起的。
 * 同一时刻起的按建行先后、编号排，结果确定。没有返回 null。
 */
export async function latestRunOfTask(
  db: Db,
  input: { taskId: string; segment: 'scope' | 'manual' | 'verify'; startedAfter?: Date },
): Promise<RunRow | null> {
  const [row] = await db
    .select()
    .from(runs)
    .where(
      and(
        eq(runs.taskId, input.taskId),
        eq(runs.segment, input.segment),
        ...(input.startedAfter ? [gte(runs.startedAt, input.startedAfter)] : []),
      ),
    )
    .orderBy(desc(runs.startedAt), desc(runs.createdAt), desc(runs.id))
    .limit(1);
  return row ?? null;
}

/** 一张单某一段起过几次会话（加权抽签的「第几次选」用，决定 0104）：只认 task_id 对得上的。读不到照抛。 */
export async function runCountOfTask(
  db: Db,
  input: { taskId: string; segment: 'scope' | 'manual' | 'verify' },
): Promise<number> {
  const [row] = await db
    .select({ n: sql<string>`count(*)` })
    .from(runs)
    .where(and(eq(runs.taskId, input.taskId), eq(runs.segment, input.segment)));
  return Number(row?.n ?? 0);
}

/**
 * 一张单到现在花掉的 token（单任务预算用，决定 0093）：task_id 对得上的动手、验收两段，输入、输出、缓存读、缓存写四样相加。
 * 四样都还空着的行（被引擎叫停、超时杀，或中转会话的用量稍后才补）算不出确数：按这张单已经记到用量的几行的每分钟速率（合并了
 * 两样都记到的会话，没记到的算 0），乘它们跑过的分钟数，估个下限（estimated），数出有几行（unmetered）。预算判断把 estimated
 * 一起算进去（只多不少），页面上写明是估的。
 * since：只算这一刻之后起的会话（含这一刻）。重做的新一代用自己的开工时刻，不背上一代。不给就整张单都算，和原来一样。
 */
export async function taskTokenSpend(
  db: Db,
  taskId: string,
  opts?: { since?: Date },
): Promise<{
  tokens: number;
  runs: number;
  unmetered: number;
  estimated: number;
  /** 原始四样分开给（缺的按 0 加）：折成输入当量在引擎的 taskSpend 活动里做（#2859），库只交原始的。 */
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  cacheWriteTokens: number;
}> {
  const perRun = sql`coalesce(${runs.inputTokens}, 0) + coalesce(${runs.outputTokens}, 0) + coalesce(${runs.cacheReadTokens}, 0) + coalesce(${runs.cacheWriteTokens}, 0)`;
  const blank = sql`${runs.inputTokens} is null and ${runs.outputTokens} is null and ${runs.cacheReadTokens} is null and ${runs.cacheWriteTokens} is null`;
  const seconds = sql`greatest(extract(epoch from (coalesce(${runs.endedAt}, now()) - ${runs.startedAt})), 0)`;
  const [row] = await db
    .select({
      tokens: sql<string>`coalesce(sum(case when ${blank} then 0 else ${perRun} end), 0)`,
      runs: sql<string>`count(*)`,
      inputTokens: sql<string>`coalesce(sum(coalesce(${runs.inputTokens}, 0)), 0)`,
      outputTokens: sql<string>`coalesce(sum(coalesce(${runs.outputTokens}, 0)), 0)`,
      cacheReadTokens: sql<string>`coalesce(sum(coalesce(${runs.cacheReadTokens}, 0)), 0)`,
      cacheWriteTokens: sql<string>`coalesce(sum(coalesce(${runs.cacheWriteTokens}, 0)), 0)`,
      unmetered: sql<string>`count(*) filter (where ${blank})`,
      measuredSeconds: sql<string>`coalesce(sum(case when ${blank} then 0 else ${seconds} end), 0)`,
      blankSeconds: sql<string>`coalesce(sum(case when ${blank} then ${seconds} else 0 end), 0)`,
    })
    .from(runs)
    .where(
      and(
        eq(runs.taskId, taskId),
        or(eq(runs.segment, 'manual'), eq(runs.segment, 'verify')),
        // 含起算这一刻：这一代自己的会话不会早于开工，上一代的都在这之前
        ...(opts?.since ? [gte(runs.startedAt, opts.since)] : []),
      ),
    );
  const tokens = Number(row?.tokens ?? 0);
  const measuredSeconds = Number(row?.measuredSeconds ?? 0);
  const blankSeconds = Number(row?.blankSeconds ?? 0);
  // 没有一行记到用量：没有速率可估，回 0（调用方照 unmetered 说「读不到」，不当成没花）
  const estimated =
    measuredSeconds > 0 && tokens > 0 ? Math.round((tokens / measuredSeconds) * blankSeconds) : 0;
  return {
    tokens,
    runs: Number(row?.runs ?? 0),
    unmetered: Number(row?.unmetered ?? 0),
    estimated,
    inputTokens: Number(row?.inputTokens ?? 0),
    outputTokens: Number(row?.outputTokens ?? 0),
    cacheReadTokens: Number(row?.cacheReadTokens ?? 0),
    cacheWriteTokens: Number(row?.cacheWriteTokens ?? 0),
  };
}

/**
 * 一张单的三段流水（任务详情读）：task_id 对得上的，加上 task_id 没记、单号对得上、工作流是这张单的第一代或重做下一代
 * （:r2、:r3，和 shared 的 runBelongsToTask 同一个正则）的老行。调用方要标明是兜底。
 * 单号在几个仓里会重：兜底必须靠工作流编号（带着仓名）认；工作流编号也没记、或是挂起键之类的别的后缀，不收——
 * 宁可少一行，也不把别的仓同号的单的会话混进这张单。记了别的 task_id 的行不收。
 * 按起跑先后排。workflowId 传第一代的编号（taskWorkflowId 不带代数）。
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
          or(
            eq(runs.workflowId, task.workflowId),
            sql`${runs.workflowId} ~ ${laterGenerationPattern(task.workflowId)}`,
          ),
        ),
      ),
    )
    .orderBy(asc(runs.startedAt), asc(runs.createdAt), asc(runs.id));
}

/**
 * 把还没结束的行都收成 killed、写明为什么，交回收掉的编号。给引擎起来、接活之前用（#157）：上一轮引擎起的会话它一退就断了
 * （起来时的收尾收掉了它们的 scope），库里那几行不收，切号就一直以为它们在跑、一直等。脱开引擎跑、等人接回的那几个
 * （#2238）放进 except 不收；过了时限还没人接的再用 only 单收那几行。
 * 收的时刻早于开跑时刻（时钟回拨）就按开跑时刻收，不撞 runs_ended_after_start。是引擎退了断的，不算路由的账（neutral）。
 * 没有会话号的写上「会话号没拿到，用量读不到」：开跑那一行已经写下，说明进程可能起来过，不能记成 0（#2689）。已经有原因或有会话号的不改。
 */
export async function closeOpenRuns(
  db: Db,
  input: { endedAt: Date; reason: string; except?: readonly string[]; only?: readonly string[] },
): Promise<string[]> {
  if (!input.reason.trim()) throw new RunInputError('收掉没结束的 runs 要写为什么');
  if (input.only !== undefined && input.only.length === 0) return [];
  const except = input.except ?? [];
  try {
    const rows = await db
      .update(runs)
      .set({
        endedAt: sql`greatest(${input.endedAt.toISOString()}::timestamptz, ${runs.startedAt})`,
        outcome: 'killed',
        routeOutcome: 'neutral',
        failureReason: input.reason,
        usageNote: sql`coalesce(${runs.usageNote}, case when ${runs.sessionId} is null then ${USAGE_SESSION_UNREAD} else null end)`,
        updatedAt: input.endedAt,
      })
      .where(
        and(
          isNull(runs.endedAt),
          input.only === undefined ? undefined : inArray(runs.id, [...input.only]),
          except.length === 0 ? undefined : notInArray(runs.id, [...except]),
        ),
      )
      .returning({ id: runs.id });
    return rows.map((r) => r.id);
  } catch (error) {
    const message = errMessage(error);
    throw new RunInputError(`收掉没结束的 runs 失败：${message}`, { cause: error });
  }
}

/**
 * 近一段时间结束、没有会话号、原因也空着的 runs：确定没发出模型调用的记 0 并写原因，读不准的只写
 * 「会话号没拿到，用量读不到」（#2689）。补记任务不收没会话号的，不在这里补，它们会永远显示成用量缺。
 * 已经有原因、有会话号、还在跑的不动。再跑一次一行都不改。返回这次写上原因的笔数。
 */
export async function annotateSessionlessRuns(
  db: Db,
  input: { endedAfter: Date; at: Date },
): Promise<number> {
  const rows = await db
    .select({
      id: runs.id,
      outcome: runs.outcome,
      failureReason: runs.failureReason,
      inputTokens: runs.inputTokens,
      outputTokens: runs.outputTokens,
      cacheReadTokens: runs.cacheReadTokens,
      cacheWriteTokens: runs.cacheWriteTokens,
    })
    .from(runs)
    .where(
      and(
        isNull(runs.sessionId),
        isNull(runs.usageNote),
        isNotNull(runs.endedAt),
        gte(runs.endedAt, input.endedAfter),
      ),
    );
  let noted = 0;
  for (const row of rows) {
    const hasToken =
      row.inputTokens !== null ||
      row.outputTokens !== null ||
      row.cacheReadTokens !== null ||
      row.cacheWriteTokens !== null;
    const decision = sessionlessUsage({
      outcome: row.outcome ?? '',
      failureReason: row.failureReason,
      hasSessionId: false,
      hasUsageWhy: false,
      hasToken,
    });
    if (decision.kind === 'leave') continue;
    const updated =
      decision.kind === 'zero'
        ? await db
            .update(runs)
            .set({
              inputTokens: 0,
              outputTokens: 0,
              cacheReadTokens: 0,
              cacheWriteTokens: 0,
              costUsd: sql`coalesce(${runs.costUsd}, 0)`,
              usageNote: decision.note,
              updatedAt: input.at,
            })
            .where(
              and(
                eq(runs.id, row.id),
                isNull(runs.usageNote),
                isNull(runs.inputTokens),
                isNull(runs.outputTokens),
                isNull(runs.cacheReadTokens),
                isNull(runs.cacheWriteTokens),
              ),
            )
            .returning({ id: runs.id })
        : await db
            .update(runs)
            .set({ usageNote: decision.note, updatedAt: input.at })
            .where(and(eq(runs.id, row.id), isNull(runs.usageNote)))
            .returning({ id: runs.id });
    if (updated.length > 0) noted += 1;
  }
  return noted;
}

/** 四样 token 有一样没记上（「用量补记」要补的那几笔，和补齐之后不再碰的判法是同一条）。 */
const usageIncomplete = or(
  isNull(runs.inputTokens),
  isNull(runs.outputTokens),
  isNull(runs.cacheReadTokens),
  isNull(runs.cacheWriteTokens),
);

/**
 * 「用量补记」查了几次都读不成、定案不再补的那一笔，usage_note 以它开头。runsAwaitingMeter 不再收这样的行：账本里就是没有，
 * 无限重试只会天天白跑、天天记一条 partial。数仍留空（不写 0），原因留在 usage_note 里给任务详情、巡检看。
 */
export const USAGE_GAVE_UP_PREFIX = '用量不再补：';

/**
 * 按放宽后的计费窗口算过的一笔，usage_note 以它开头（「已补」或「没读成」）。已补齐的老行重读尾巴时认这个前缀，只碰一次。
 */
export const USAGE_TAIL_PREFIX = '叫停后的调用';

/** 尾巴补进这一笔之后的记号（USAGE_TAIL_PREFIX 开头）。页面不显示：四样已经齐。 */
export const USAGE_TAIL_MARKER = '叫停后的调用已补';
/** #2675 改了读法（用量账本里没有计费调用的再拿流量记录核）：按新读法定案不再补的，usage_note 末尾带这个记号；不带的是改读法
 * 之前定案的老行，runsGaveUpAwaitingReread 收它们按新读法再读一次，读完带上记号，不再读第二次。
 */
export const USAGE_REREAD_MARK = '（按 #2675 起的读法读过）';

/** 等「用量补记」补的一笔：经 Mirasim 起、记了会话号、结束了、四样 token 有缺的。 */
export interface MeterPendingRun {
  id: string;
  /** Mirasim 服务端回的 <执行体>:<uuid>。 */
  sessionId: string;
  model: string;
  startedAt: Date;
  endedAt: Date;
  /** 同一会话里更晚的那一笔的起点；没有下一笔是 null。这一笔的计费窗口收到它和结束后宽限里更早的那个。 */
  nextStartedAt: Date | null;
  /** 同一会话（续跑）在这一笔起点之前结束的上一笔的终点：读账本时起点往前放宽不越过它。没有上一笔是 null。 */
  previousEndedAt: Date | null;
  usageNote: string | null;
  /** 这一行上次动是什么时候：读不成的每次都改写 usage_note（带第几次），所以它就是上次补记的时刻，退避看它。 */
  updatedAt: Date;
}

/** 四样已经齐、还没按放宽后的窗口重读过尾巴的一笔。 */
export interface MeterTailRun {
  id: string;
  sessionId: string;
  model: string;
  startedAt: Date;
  endedAt: Date;
  nextStartedAt: Date | null;
  usageNote: string | null;
  /** 原来记上的花费；尾巴上也有花费才相加，空的不拿尾巴的花费顶成整笔的花费。 */
  costUsd: number | null;
}

/** 同一会话里、这一笔之后最先起的那一笔（还没结束的也算）。没有就是 null。 */
function nextRunStartedAt() {
  return sql<string | Date | null>`(
    select min(n.started_at) from runs n
    where n.session_id = ${runs.sessionId}
      and (
        n.started_at > ${runs.startedAt}
        or (n.started_at = ${runs.startedAt} and n.id > ${runs.id})
      )
  )`;
}

function dateOrNull(v: unknown): Date | null {
  if (v == null) return null;
  if (v instanceof Date) return Number.isNaN(v.getTime()) ? null : v;
  if (typeof v === 'string' || typeof v === 'number') {
    const d = new Date(v);
    return Number.isNaN(d.getTime()) ? null : d;
  }
  return null;
}

const tailNotMarked = or(isNull(runs.usageNote), sql`${runs.usageNote} not like ${`${USAGE_TAIL_PREFIX}%`}`);

/** 四样 token 都记上了。 */
const usageComplete = and(
  isNotNull(runs.inputTokens),
  isNotNull(runs.outputTokens),
  isNotNull(runs.cacheReadTokens),
  isNotNull(runs.cacheWriteTokens),
);

/** 同一会话在这一笔起点之前（含）结束的上一笔的终点（毫秒），续跑的会话才有。 */
const previousEndedMs = sql<number | string | null>`(
  select extract(epoch from max(prev.ended_at)) * 1000
  from ${runs} as prev
  where prev.session_id = ${runs.sessionId} and prev.id <> ${runs.id} and prev.ended_at <= ${runs.startedAt}
)`;

const meterPendingColumns = {
  id: runs.id,
  sessionId: runs.sessionId,
  model: runs.model,
  startedAt: runs.startedAt,
  endedAt: runs.endedAt,
  nextStartedAt: nextRunStartedAt(),
  previousEndedMs,
  usageNote: runs.usageNote,
  updatedAt: runs.updatedAt,
};

function toMeterPending(
  rows: {
    id: string;
    sessionId: string | null;
    model: string;
    startedAt: Date;
    endedAt: Date | null;
    nextStartedAt: string | Date | null;
    previousEndedMs: number | string | null;
    usageNote: string | null;
    updatedAt: Date;
  }[],
): MeterPendingRun[] {
  return rows.flatMap(({ previousEndedMs: prev, nextStartedAt, ...r }) =>
    r.sessionId !== null && r.endedAt !== null
      ? [
          {
            ...r,
            sessionId: r.sessionId,
            endedAt: r.endedAt,
            nextStartedAt: dateOrNull(nextStartedAt),
            previousEndedAt: prev === null ? null : new Date(Math.round(Number(prev))),
          },
        ]
      : [],
  );
}

function toMeterTail(
  rows: {
    id: string;
    sessionId: string | null;
    model: string;
    startedAt: Date;
    endedAt: Date | null;
    nextStartedAt: string | Date | null;
    usageNote: string | null;
    costUsd: number | null;
  }[],
): MeterTailRun[] {
  return rows.flatMap((r) =>
    r.sessionId !== null && r.endedAt !== null
      ? [{ ...r, sessionId: r.sessionId, endedAt: r.endedAt, nextStartedAt: dateOrNull(r.nextStartedAt) }]
      : [],
  );
}

/**
 * 经 Mirasim 起（路由的执行方式是 mirasim）、endedAfter 以后结束、记了会话号、四样 token 有缺的那几笔，先结束的在前，最多 limit 笔
 * （#1935）。没记会话号的老行不在里面（不知道是哪个会话）；那些走一次性的 runsAwaitingHistoricalMeter，按分支名对（#1948）。
 */
export async function runsAwaitingMeter(
  db: Db,
  input: { endedAfter: Date; limit: number },
): Promise<MeterPendingRun[]> {
  if (!Number.isInteger(input.limit) || input.limit <= 0)
    throw new RunInputError(`limit 要是正整数：${input.limit}`);
  const rows = await db
    .select(meterPendingColumns)
    .from(runs)
    .innerJoin(routes, eq(routes.id, runs.routeId))
    .where(
      and(
        eq(routes.hostId, 'mirasim'),
        isNotNull(runs.sessionId),
        isNotNull(runs.endedAt),
        gte(runs.endedAt, input.endedAfter),
        usageIncomplete,
        or(isNull(runs.usageNote), sql`${runs.usageNote} not like ${`${USAGE_GAVE_UP_PREFIX}%`}`),
      ),
    )
    .orderBy(asc(runs.endedAt), asc(runs.id))
    .limit(input.limit);
  return toMeterPending(rows);
}

/**
 * 四样已经齐、endedAfter 以后结束、记了会话号、usage_note 还没带「叫停后的调用」记号的 Mirasim 行。
 * 近 14 天里按旧窗口（收到 ended_at）补齐的那些，重读时把终点之后的尾巴补上；带了记号的不再收。
 */
export async function runsAwaitingMeterTail(
  db: Db,
  input: { endedAfter: Date; limit: number },
): Promise<MeterTailRun[]> {
  if (!Number.isInteger(input.limit) || input.limit <= 0)
    throw new RunInputError(`limit 要是正整数：${input.limit}`);
  const rows = await db
    .select({
      id: runs.id,
      sessionId: runs.sessionId,
      model: runs.model,
      startedAt: runs.startedAt,
      endedAt: runs.endedAt,
      nextStartedAt: nextRunStartedAt(),
      usageNote: runs.usageNote,
      costUsd: runs.costUsd,
    })
    .from(runs)
    .innerJoin(routes, eq(routes.id, runs.routeId))
    .where(
      and(
        eq(routes.hostId, 'mirasim'),
        isNotNull(runs.sessionId),
        isNotNull(runs.endedAt),
        gte(runs.endedAt, input.endedAfter),
        usageComplete,
        tailNotMarked,
      ),
    )
    .orderBy(asc(runs.endedAt), asc(runs.id))
    .limit(input.limit);
  return toMeterTail(rows);
}

/**
 * 改读法之前就定案不再补（usage_note 以 USAGE_GAVE_UP_PREFIX 开头）、还没按新读法重读过（不带 USAGE_REREAD_MARK）、
 * endedAfter 以后结束、四样还有缺的那几笔，先结束的在前，最多 limit 笔（#2675）。
 */
export async function runsGaveUpAwaitingReread(
  db: Db,
  input: { endedAfter: Date; limit: number },
): Promise<MeterPendingRun[]> {
  if (!Number.isInteger(input.limit) || input.limit <= 0)
    throw new RunInputError(`limit 要是正整数：${input.limit}`);
  const rows = await db
    .select(meterPendingColumns)
    .from(runs)
    .innerJoin(routes, eq(routes.id, runs.routeId))
    .where(
      and(
        eq(routes.hostId, 'mirasim'),
        isNotNull(runs.sessionId),
        isNotNull(runs.endedAt),
        gte(runs.endedAt, input.endedAfter),
        usageIncomplete,
        sql`${runs.usageNote} like ${`${USAGE_GAVE_UP_PREFIX}%`}`,
        sql`strpos(${runs.usageNote}, ${USAGE_REREAD_MARK}) = 0`,
      ),
    )
    .orderBy(asc(runs.endedAt), asc(runs.id))
    .limit(input.limit);
  return toMeterPending(rows);
}

/** 中转计量回填齐了的一次会话的用量（四样都读到了才有这一份；花费中转报了才有）。 */
export interface MeterUsageWrite {
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  cacheWriteTokens: number;
  costUsd?: number | undefined;
}

function assertMeterUsage(u: MeterUsageWrite): void {
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
}

/** 记号不以「叫停后的调用」开头的话，下一轮还会把这行收进来，尾巴加第二次。 */
function assertTailNote(note: string): void {
  if (!note.startsWith(USAGE_TAIL_PREFIX)) {
    throw new RunInputError(`补记要带「${USAGE_TAIL_PREFIX}」开头的记号，不然同一笔会再补一次`);
  }
}

/**
 * 把读齐了的用量写回这一笔：四样 token 整套换成计量的数（会话结束时快照里的输出只是近似，计量才是逐次调用的账），中转报了花费才写
 * 花费，usage_note 写上记号（按放宽后的窗口算过，尾巴不会再加一遍）。只改四样还有缺的行：补齐了的再来一遍什么都不做（回 false），
 * 重复跑、两轮叠着跑都不会改第二次。
 */
export async function fillRunUsageFromMeter(
  db: Db,
  input: { runId: string; usage: MeterUsageWrite; at: Date; note?: string },
): Promise<boolean> {
  const u = input.usage;
  assertMeterUsage(u);
  const rows = await db
    .update(runs)
    .set({
      inputTokens: u.inputTokens,
      outputTokens: u.outputTokens,
      cacheReadTokens: u.cacheReadTokens,
      cacheWriteTokens: u.cacheWriteTokens,
      ...(u.costUsd !== undefined ? { costUsd: u.costUsd } : {}),
      usageNote: input.note?.trim() ? input.note : null,
      updatedAt: input.at,
    })
    .where(and(eq(runs.id, input.runId), isNotNull(runs.endedAt), usageIncomplete))
    .returning({ id: runs.id });
  return rows.length > 0;
}

/**
 * 已补齐的老行补上终点之后的尾巴：四样加上 add（没给就是只做记号、不改数），花费只在原来有、尾巴上也有时才加。
 * 只改还没带记号的、四样已经齐的行。写了回 true；已经带过记号的回 false，再补不会加第二次。
 */
export async function fillRunMeterTail(
  db: Db,
  input: { runId: string; at: Date; note: string; add?: MeterUsageWrite },
): Promise<boolean> {
  assertTailNote(input.note);
  const add = input.add;
  if (add) assertMeterUsage(add);
  const rows = await db
    .update(runs)
    .set({
      ...(add
        ? {
            inputTokens: sql`${runs.inputTokens} + ${add.inputTokens}::bigint`,
            outputTokens: sql`${runs.outputTokens} + ${add.outputTokens}::bigint`,
            cacheReadTokens: sql`${runs.cacheReadTokens} + ${add.cacheReadTokens}::bigint`,
            cacheWriteTokens: sql`${runs.cacheWriteTokens} + ${add.cacheWriteTokens}::bigint`,
            ...(add.costUsd !== undefined ? { costUsd: sql`${runs.costUsd} + ${add.costUsd}::numeric` } : {}),
          }
        : {}),
      usageNote: input.note,
      updatedAt: input.at,
    })
    .where(and(eq(runs.id, input.runId), isNotNull(runs.endedAt), usageComplete, tailNotMarked))
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

/**
 * #1946 上线前结束、没记会话号、四样 token 还有缺的老 run（#1948）。只收经 Mirasim 起、结局是 done 的。
 * 已经记了会话号的交给上面的定时任务；四样已经齐的、不是 done 的、不是这条执行方式的，这次不碰。
 */
export interface HistoricalMeterRun {
  id: string;
  branch: string | null;
  model: string;
  startedAt: Date;
  endedAt: Date;
  usageNote: string | null;
  inputTokens: number | null;
  outputTokens: number | null;
  cacheReadTokens: number | null;
  cacheWriteTokens: number | null;
  costUsd: number | null;
}

/** 上面那一类，先结束的在前。 */
export async function runsAwaitingHistoricalMeter(db: Db): Promise<HistoricalMeterRun[]> {
  const rows = await db
    .select({
      id: runs.id,
      branch: runs.branch,
      model: runs.model,
      startedAt: runs.startedAt,
      endedAt: runs.endedAt,
      usageNote: runs.usageNote,
      inputTokens: runs.inputTokens,
      outputTokens: runs.outputTokens,
      cacheReadTokens: runs.cacheReadTokens,
      cacheWriteTokens: runs.cacheWriteTokens,
      costUsd: runs.costUsd,
    })
    .from(runs)
    .innerJoin(routes, eq(routes.id, runs.routeId))
    .where(
      and(eq(routes.hostId, 'mirasim'), isNull(runs.sessionId), eq(runs.outcome, 'done'), usageIncomplete),
    )
    .orderBy(asc(runs.endedAt), asc(runs.id));
  return rows.flatMap((r) => (r.endedAt !== null ? [{ ...r, endedAt: r.endedAt }] : []));
}

/**
 * 一次性回填写用量：只填还是空的字段（coalesce），已经有的输入、输出、缓存、花费一律不动，也不写会话号、也不改 usage_note。
 * 写了会话号的话，定时任务会整套覆盖，快照里的输出就没了。没有空字段可写、或者这行已经有会话号，回 false，不改 updated_at。
 */
export async function fillHistoricalRunUsage(
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
  const holes = [
    isNull(runs.inputTokens),
    isNull(runs.outputTokens),
    isNull(runs.cacheReadTokens),
    isNull(runs.cacheWriteTokens),
    ...(u.costUsd !== undefined ? [isNull(runs.costUsd)] : []),
  ];
  const rows = await db
    .update(runs)
    .set({
      inputTokens: sql`coalesce(${runs.inputTokens}, ${u.inputTokens}::bigint)`,
      outputTokens: sql`coalesce(${runs.outputTokens}, ${u.outputTokens}::bigint)`,
      cacheReadTokens: sql`coalesce(${runs.cacheReadTokens}, ${u.cacheReadTokens}::bigint)`,
      cacheWriteTokens: sql`coalesce(${runs.cacheWriteTokens}, ${u.cacheWriteTokens}::bigint)`,
      ...(u.costUsd !== undefined ? { costUsd: sql`coalesce(${runs.costUsd}, ${u.costUsd}::numeric)` } : {}),
      updatedAt: input.at,
    })
    .where(and(eq(runs.id, input.runId), isNull(runs.sessionId), eq(runs.outcome, 'done'), or(...holes)))
    .returning({ id: runs.id });
  return rows.length > 0;
}

/**
 * 一次性回填写「为什么对不上」。只在原因还空着、四样还有缺、没有会话号时写；已经有原因的不覆盖（再跑一次一行都不改）。
 * 写了回 true。
 */
export async function noteHistoricalRunUsage(
  db: Db,
  input: { runId: string; note: string; at: Date },
): Promise<boolean> {
  if (!input.note.trim()) throw new RunInputError('用量没记全的原因是空的');
  const rows = await db
    .update(runs)
    .set({ usageNote: input.note, updatedAt: input.at })
    .where(
      and(
        eq(runs.id, input.runId),
        isNull(runs.sessionId),
        eq(runs.outcome, 'done'),
        isNull(runs.usageNote),
        usageIncomplete,
      ),
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
    routeWhy: row.routeWhy ?? null,
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
    resumeSessionId: row.resumeSessionId ?? null,
    resumeReason: row.resumeReason ?? null,
    cause: row.cause ?? null,
    causeSummary: row.causeSummary ? clipCauseSummary(row.causeSummary) : null,
    roundSeq: row.roundSeq ?? null,
    verdict: row.verdict ?? null,
    // 收场那一笔只在用量没照终帧读到时带（会话被叫停、超时杀：记的是怎么来的、缺的为什么读不到）；别的由「用量补记」和一次性回填写
    usageNote: row.usageNote ?? null,
    memoryPeakMb: row.memoryPeakMb ?? null,
    cpuSeconds: row.cpuSeconds ?? null,
    failureReason: row.failureReason ?? null,
    prNumber: row.prNumber ?? null,
    branch: row.branch ?? null,
    worktreePath: row.worktreePath ?? null,
    workflowId: row.workflowId ?? null,
    temporalRunId: row.temporalRunId ?? null,
    retryOf: null,
    createdAt: now,
    updatedAt: now,
  };
}

/** 再记时要改的列：收场才有的那几列用 coalesce(新值, 库里已有的)，没给就不清。 */
function pickRowWithoutId(r: RunRowSure) {
  const { id: _i, createdAt: _c, ...rest } = r;
  return {
    ...rest,
    // 开跑写的「为什么派它」：收场那一笔常常不带，没带就留着，不冲成空
    routeWhy: sql`coalesce(${r.routeWhy}, ${runs.routeWhy})`,
    usageNote: sql`coalesce(${r.usageNote}, ${runs.usageNote})`,
    sessionId: sql`coalesce(${r.sessionId}, ${runs.sessionId})`,
    resumeSessionId: sql`coalesce(${r.resumeSessionId}, ${runs.resumeSessionId})`,
    resumeReason: sql`coalesce(${r.resumeReason}, ${runs.resumeReason})`,
    // 起因、回合、验收结论：开跑写过的，收场那一笔没带就留着（验收结论在收场之后另写，见 noteRunVerdict）
    cause: sql`coalesce(${r.cause}, ${runs.cause})`,
    causeSummary: sql`coalesce(${r.causeSummary}, ${runs.causeSummary})`,
    roundSeq: sql`coalesce(${r.roundSeq}::integer, ${runs.roundSeq})`,
    verdict: sql`coalesce(${r.verdict === null ? null : JSON.stringify(r.verdict)}::jsonb, ${runs.verdict})`,
    endedAt: sql`coalesce(${r.endedAt?.toISOString() ?? null}::timestamptz, ${runs.endedAt})`,
    outcome: sql`coalesce(${r.outcome}, ${runs.outcome})`,
    routeOutcome: sql`coalesce(${r.routeOutcome}, ${runs.routeOutcome})`,
    inputTokens: sql`coalesce(${r.inputTokens}::bigint, ${runs.inputTokens})`,
    outputTokens: sql`coalesce(${r.outputTokens}::bigint, ${runs.outputTokens})`,
    cacheReadTokens: sql`coalesce(${r.cacheReadTokens}::bigint, ${runs.cacheReadTokens})`,
    cacheWriteTokens: sql`coalesce(${r.cacheWriteTokens}::bigint, ${runs.cacheWriteTokens})`,
    costUsd: sql`coalesce(${r.costUsd}::numeric, ${runs.costUsd})`,
    memoryPeakMb: sql`coalesce(${r.memoryPeakMb}::integer, ${runs.memoryPeakMb})`,
    cpuSeconds: sql`coalesce(${r.cpuSeconds}::integer, ${runs.cpuSeconds})`,
    failureReason: sql`coalesce(${r.failureReason}, ${runs.failureReason})`,
  };
}
