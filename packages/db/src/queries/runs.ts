// runs 表：三段各跑一次（scope / manual / verify）的流水账。
// #556-6 写作入口；结构照 #554-1 RunRecord。落那一端的 ofORM 类型。
// 操作条款：
// - start/runId：幂等（同一次跑写进去两笔）
// - endedAt / outcome 一对空/不空；
// - 读不到的字段 NULL，不拿 0 顶（#216）。确定没发出模型调用的例外：记 0 并写 usage_note（#2689）。

import { randomUUID } from 'node:crypto';
import { laterGenerationPattern, sessionlessUsage, USAGE_SESSION_UNREAD } from '@fleet-dao/shared';
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

/** 查一段。不给 id 就查不到。 */
export async function getRun(db: Db, id: string): Promise<RunRow | null> {
  const [row] = await db.select().from(runs).where(eq(runs.id, id)).limit(1);
  return row ?? null;
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
): Promise<{ tokens: number; runs: number; unmetered: number; estimated: number }> {
  const perRun = sql`coalesce(${runs.inputTokens}, 0) + coalesce(${runs.outputTokens}, 0) + coalesce(${runs.cacheReadTokens}, 0) + coalesce(${runs.cacheWriteTokens}, 0)`;
  const blank = sql`${runs.inputTokens} is null and ${runs.outputTokens} is null and ${runs.cacheReadTokens} is null and ${runs.cacheWriteTokens} is null`;
  const seconds = sql`greatest(extract(epoch from (coalesce(${runs.endedAt}, now()) - ${runs.startedAt})), 0)`;
  const [row] = await db
    .select({
      tokens: sql<string>`coalesce(sum(case when ${blank} then 0 else ${perRun} end), 0)`,
      runs: sql<string>`count(*)`,
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

/** 等「用量补记」补的一笔：经 Mirasim 起、记了会话号、结束了、四样 token 有缺的。 */
export interface MeterPendingRun {
  id: string;
  /** Mirasim 服务端回的 <执行体>:<uuid>。 */
  sessionId: string;
  model: string;
  startedAt: Date;
  endedAt: Date;
  usageNote: string | null;
  /** 这一行上次动是什么时候：读不成的每次都改写 usage_note（带第几次），所以它就是上次补记的时刻，退避看它。 */
  updatedAt: Date;
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
    .select({
      id: runs.id,
      sessionId: runs.sessionId,
      model: runs.model,
      startedAt: runs.startedAt,
      endedAt: runs.endedAt,
      usageNote: runs.usageNote,
      updatedAt: runs.updatedAt,
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
        or(isNull(runs.usageNote), sql`${runs.usageNote} not like ${`${USAGE_GAVE_UP_PREFIX}%`}`),
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
