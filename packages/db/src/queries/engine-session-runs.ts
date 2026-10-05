// 引擎的会话生命周期：开一次会话（按 id 幂等）、开工、结束、叫停，以及按 id、按执行体会话编号读回来。
// 时间参数一律 Date，返回的时刻也用 Date（引擎内部直连，不经 JSON 边界）。
import type { RunAsUser, RunOutcome, StageKind } from '@fleet-dao/shared';
import { and, desc, eq, getTableColumns, isNull, sql } from 'drizzle-orm';
import type { Db } from '../client.ts';
import { sessionRuns, sessionStops } from '../schema/index.ts';

/** 起出来的会话进程在哪；会话状态、markSessionRunStarted 的输入用同一个形状。 */
type RunHandle = { pid?: number; scope?: string };

export interface SessionRunState {
  id: string;
  taskId: string | null;
  subtaskId: string | null;
  stage: StageKind;
  routeId: string;
  branch: string | null;
  sessionId: string | null;
  workflowId: string | null;
  runAsUser: string | null;
  worktreePath: string | null;
  handle: RunHandle | null;
  queuedAt: Date;
  startedAt: Date | null;
  endedAt: Date | null;
  outcome: RunOutcome | null;
  failureCode: string | null;
  /** 上一轮为什么断了（续会话时写进提示词）。 */
  failureMessage: string | null;
  contextTokens: number | null;
  sessionCostUsd: number | null;
  /** 起会话时交代的测试命令（交活核对认它）。 */
  testCommand: string | null;
  /** session_stops 里有这一行就给出。 */
  stopRequested: { at: Date; reason: string } | null;
  /** 输出确认到哪一行（见 schema 的 output_seq）；空 = 一行都还没确认。 */
  outputSeq: number | null;
}

function mapSessionRun(
  row: typeof sessionRuns.$inferSelect,
  stop: typeof sessionStops.$inferSelect | null,
): SessionRunState {
  return {
    id: row.id,
    taskId: row.taskId,
    subtaskId: row.subtaskId,
    stage: row.stage,
    routeId: row.routeId,
    branch: row.branch,
    sessionId: row.sessionId,
    workflowId: row.workflowId,
    runAsUser: row.runAsUser,
    worktreePath: row.worktreePath,
    handle: row.handle,
    queuedAt: row.queuedAt,
    startedAt: row.startedAt,
    endedAt: row.endedAt,
    outcome: row.outcome,
    failureCode: row.failureCode,
    failureMessage: row.failureMessage,
    contextTokens: row.contextTokens,
    sessionCostUsd: row.sessionCostUsd,
    testCommand: row.testCommand,
    stopRequested: stop ? { at: stop.requestedAt, reason: stop.reason } : null,
    outputSeq: row.outputSeq,
  };
}

async function currentStop(db: Db, runId: string): Promise<typeof sessionStops.$inferSelect | null> {
  const [row] = await db.select().from(sessionStops).where(eq(sessionStops.runId, runId));
  return row ?? null;
}

export interface OpenSessionRunInput {
  id: string;
  taskId: string | null;
  subtaskId: string | null;
  stage: StageKind;
  routeId: string;
  whyRoute: string;
  branch: string | null;
  queuedAt: Date;
  workflowId: string | null;
  runAsUser: string | null;
  worktreePath: string | null;
  /** 这次交代给会话的测试命令（副本里的，taskContext 读出来、起会话前核过）；没有就是 null。 */
  testCommand?: string | null;
}

/**
 * 按 id 幂等：已有就原样返回（created=false）。外键不满足（任务、子任务、路由不在库里）照常抛，别吞。
 * 唯一的例外是测试命令：已有的这一行还没开工（上一次尝试没把会话起来），就改成这一次交代的——交活核对认的必须是
 * 真起来的那次会话被告知的命令；已经开工的不改。
 */
export async function openSessionRun(
  db: Db,
  input: OpenSessionRunInput,
): Promise<{ created: boolean; run: SessionRunState }> {
  const testCommand = input.testCommand ?? null;
  const [written] = await db
    .insert(sessionRuns)
    .values({
      id: input.id,
      taskId: input.taskId,
      subtaskId: input.subtaskId,
      stage: input.stage,
      routeId: input.routeId,
      whyRoute: input.whyRoute,
      branch: input.branch,
      queuedAt: input.queuedAt,
      workflowId: input.workflowId,
      runAsUser: input.runAsUser as RunAsUser | null,
      worktreePath: input.worktreePath,
      testCommand,
    })
    .onConflictDoUpdate({
      target: sessionRuns.id,
      set: { testCommand },
      setWhere: sql`${sessionRuns.startedAt} is null and ${sessionRuns.endedAt} is null`,
    })
    // xmax = 0 只在这一行是刚插入（不是走 on conflict 更新）时成立
    .returning({ ...getTableColumns(sessionRuns), created: sql<boolean>`(xmax = 0)` });
  const row = written ?? (await db.select().from(sessionRuns).where(eq(sessionRuns.id, input.id)))[0];
  if (!row) throw new Error(`会话 ${input.id} 写不进也读不到`);
  // 叫停可能早于这一行插入：不管这行是刚插的还是已有的，都要把已经记下的叫停请求带出去。
  const stop = await currentStop(db, input.id);
  return { created: written?.created === true, run: mapSessionRun(row, stop) };
}

/** 只在 started_at 为空时写 started_at；session_id、handle 每次覆盖。行不在返回 'not_found'。 */
export async function markSessionRunStarted(
  db: Db,
  input: { id: string; startedAt: Date; sessionId: string; handle: RunHandle | null },
): Promise<'ok' | 'not_found'> {
  const updated = await db
    .update(sessionRuns)
    .set({
      sessionId: input.sessionId,
      handle: input.handle,
      startedAt: sql`coalesce(${sessionRuns.startedAt}, ${input.startedAt.toISOString()}::timestamptz)`,
    })
    .where(eq(sessionRuns.id, input.id))
    .returning({ id: sessionRuns.id });
  return updated.length > 0 ? 'ok' : 'not_found';
}

export interface FinishSessionRunInput {
  id: string;
  outcome: RunOutcome;
  endedAt: Date;
  sessionId?: string;
  actualModel?: string;
  inputTokens?: number;
  outputTokens?: number;
  /** 这一轮的缓存读、缓存写：没读到就不给，库里留空（不记 0）。 */
  cacheReadTokens?: number;
  cacheWriteTokens?: number;
  costUsd?: number;
  sessionCostUsd?: number;
  failureCode?: string;
  failureMessage?: string;
  routeOutcome?: 'ok' | 'fail' | 'neutral';
  contextTokens?: number;
}

/** 幂等：已结束的不改（'already_finished'）；ended_at 取 greatest(给的, coalesce(started_at, queued_at))；不知道的字段不写（不记 0）。 */
export async function finishSessionRun(
  db: Db,
  input: FinishSessionRunInput,
): Promise<'finished' | 'already_finished' | 'not_found'> {
  const changes = {
    outcome: input.outcome,
    endedAt: sql`greatest(${input.endedAt.toISOString()}::timestamptz, coalesce(${sessionRuns.startedAt}, ${sessionRuns.queuedAt}))`,
    ...(input.sessionId !== undefined && { sessionId: input.sessionId }),
    ...(input.actualModel !== undefined && { actualModel: input.actualModel }),
    ...(input.inputTokens !== undefined && { inputTokens: input.inputTokens }),
    ...(input.outputTokens !== undefined && { outputTokens: input.outputTokens }),
    ...(input.cacheReadTokens !== undefined && { cacheReadTokens: input.cacheReadTokens }),
    ...(input.cacheWriteTokens !== undefined && { cacheWriteTokens: input.cacheWriteTokens }),
    ...(input.costUsd !== undefined && { costUsd: input.costUsd }),
    ...(input.sessionCostUsd !== undefined && { sessionCostUsd: input.sessionCostUsd }),
    ...(input.failureCode !== undefined && { failureCode: input.failureCode }),
    // 截到 2000 字：库里没配对应的检查约束（asks.question 的 2000 字上限也是写入口自己截，不靠 DB），落在写入口最省事。
    ...(input.failureMessage !== undefined && { failureMessage: input.failureMessage.slice(0, 2000) }),
    ...(input.routeOutcome !== undefined && { routeOutcome: input.routeOutcome }),
    ...(input.contextTokens !== undefined && { contextTokens: input.contextTokens }),
  };
  const updated = await db
    .update(sessionRuns)
    .set(changes)
    .where(and(eq(sessionRuns.id, input.id), isNull(sessionRuns.endedAt)))
    .returning({ id: sessionRuns.id });
  if (updated.length > 0) return 'finished';
  const [existing] = await db
    .select({ id: sessionRuns.id })
    .from(sessionRuns)
    .where(eq(sessionRuns.id, input.id));
  return existing ? 'already_finished' : 'not_found';
}

/** 记「这个 runId 已叫停」；重复调不报错（第一次的请求算数，onConflictDoNothing 让重试静默通过）。 */
export async function requestSessionStop(
  db: Db,
  input: { runId: string; reason: string; at?: Date },
): Promise<void> {
  await db
    .insert(sessionStops)
    .values({ runId: input.runId, reason: input.reason, requestedAt: input.at ?? new Date() })
    .onConflictDoNothing({ target: sessionStops.runId });
}

export async function getSessionRun(db: Db, id: string): Promise<SessionRunState | null> {
  const [row] = await db
    .select({ run: sessionRuns, stop: sessionStops })
    .from(sessionRuns)
    .leftJoin(sessionStops, eq(sessionStops.runId, sessionRuns.id))
    .where(eq(sessionRuns.id, id));
  return row ? mapSessionRun(row.run, row.stop) : null;
}

/** 某个执行体会话编号（session_id）最近的一次（按 queued_at）。 */
export async function latestRunOfSession(db: Db, sessionId: string): Promise<SessionRunState | null> {
  const [row] = await db
    .select({ run: sessionRuns, stop: sessionStops })
    .from(sessionRuns)
    .leftJoin(sessionStops, eq(sessionStops.runId, sessionRuns.id))
    .where(eq(sessionRuns.sessionId, sessionId))
    .orderBy(desc(sessionRuns.queuedAt))
    .limit(1);
  return row ? mapSessionRun(row.run, row.stop) : null;
}

// 选路要的会话事实（池的并发、熔断、战绩、半开时在途的试探、估算的用量）两张表并起来读，都在 pool-runs.ts：别在这里另写只读
// session_runs 的（#735、#758；原来的 openSessionRuns、routeOutcomesSince 就是这么漏掉三段的会话的）。
