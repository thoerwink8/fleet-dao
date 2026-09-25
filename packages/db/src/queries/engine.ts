// 引擎真端口要用的表和查询：会话生命周期（起、开工、结束、叫停）、引擎提问、报警、人闸批准、执行计时、
// 任务快照、选路事实。时间参数一律 Date，返回的时刻也用 Date（和别的查询文件用 ISO 字符串不同——这批是引擎内部直连，
// 不经 JSON 边界）。
import type {
  HostId,
  ProgressKind,
  QuotaWindowKind,
  RunAsUser,
  RunOutcome,
  StageKind,
  SubtaskState,
  TaskState,
} from '@fleet-dao/shared';
import { and, asc, desc, eq, gte, inArray, isNull, max, notInArray, sql } from 'drizzle-orm';
import type { Db } from '../client.ts';
import {
  approvals,
  asks,
  models,
  notifications,
  pools,
  progressEvents,
  quotaWindows,
  repos,
  routes,
  sessionRuns,
  sessionStops,
  stepTimings,
  subtaskDeps,
  subtasks,
  tasks,
} from '../schema/index.ts';
import { type Blocker, stageCandidates } from './candidates.ts';

/** 起出来的会话进程在哪；会话状态、markSessionRunStarted 的输入用同一个形状。 */
type RunHandle = { pid?: number; scope?: string };

/** 按约束名认错误，不认报错措辞：postgres.js 和 PGlite 的报错文案不同，但都会把约束名放进 message。 */
function isConstraintError(err: unknown, constraint: string): boolean {
  for (let e: unknown = err; e instanceof Error; e = e.cause) {
    if (e.message.includes(constraint)) return true;
  }
  return false;
}

// ---- 会话

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
  /** session_stops 里有这一行就给出。 */
  stopRequested: { at: Date; reason: string } | null;
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
    stopRequested: stop ? { at: stop.requestedAt, reason: stop.reason } : null,
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
}

/** 按 id 幂等：已有就不动、原样返回（created=false）。外键不满足（任务、子任务、路由不在库里）照常抛，别吞。 */
export async function openSessionRun(
  db: Db,
  input: OpenSessionRunInput,
): Promise<{ created: boolean; run: SessionRunState }> {
  const [inserted] = await db
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
    })
    .onConflictDoNothing({ target: sessionRuns.id })
    .returning();
  const row = inserted ?? (await db.select().from(sessionRuns).where(eq(sessionRuns.id, input.id)))[0];
  if (!row) throw new Error(`会话 ${input.id} 写不进也读不到`);
  // 叫停可能早于这一行插入：不管这行是刚插的还是已有的，都要把已经记下的叫停请求带出去。
  const stop = await currentStop(db, input.id);
  return { created: inserted !== undefined, run: mapSessionRun(row, stop) };
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

/** 还没结束的会话；给了 runAsUser 就只要这个会话用户的。 */
export async function openSessionRuns(
  db: Db,
  filter: { runAsUser?: string } = {},
): Promise<SessionRunState[]> {
  const rows = await db
    .select({ run: sessionRuns, stop: sessionStops })
    .from(sessionRuns)
    .leftJoin(sessionStops, eq(sessionStops.runId, sessionRuns.id))
    .where(
      and(
        isNull(sessionRuns.endedAt),
        filter.runAsUser !== undefined ? eq(sessionRuns.runAsUser, filter.runAsUser as RunAsUser) : undefined,
      ),
    );
  return rows.map((r) => mapSessionRun(r.run, r.stop));
}

/** 选路算熔断和战绩用：since 之后结束的会话。 */
export async function routeOutcomesSince(
  db: Db,
  since: Date,
): Promise<
  {
    routeId: string;
    stage: StageKind;
    endedAt: Date;
    outcome: RunOutcome;
    routeOutcome: 'ok' | 'fail' | 'neutral' | null;
  }[]
> {
  const rows = await db
    .select({
      routeId: sessionRuns.routeId,
      stage: sessionRuns.stage,
      endedAt: sessionRuns.endedAt,
      outcome: sessionRuns.outcome,
      routeOutcome: sessionRuns.routeOutcome,
    })
    .from(sessionRuns)
    .where(gte(sessionRuns.endedAt, since));
  return rows.map((r) => {
    // 结束了就必有结局（session_runs_outcome_iff_ended 检查约束），gte 也已经把 endedAt 为空的行排除在外；
    // 这里只是不裸用 ! 断言，真出现数据和约束对不上时要能看见报错，不是当空处理。
    if (r.endedAt === null || r.outcome === null) {
      throw new Error(`会话（路由 ${r.routeId}）已结束却没有结局，数据和检查约束对不上`);
    }
    return {
      routeId: r.routeId,
      stage: r.stage,
      endedAt: r.endedAt,
      outcome: r.outcome,
      routeOutcome: r.routeOutcome,
    };
  });
}

// ---- 起会话要的事实

export interface TaskContext {
  taskId: string;
  issueNumber: number;
  title: string;
  rawRequest: string;
  specDir: string | null;
  acceptance: string[];
  repo: { id: string; owner: string; name: string; defaultBranch: string; testCommand: string };
}

/** 起会话、拼接力任务书要的：任务属于哪个仓、哪张 issue。任务不在返回 null。 */
export async function taskContext(db: Db, taskId: string): Promise<TaskContext | null> {
  const [row] = await db
    .select({ task: tasks, repo: repos })
    .from(tasks)
    .innerJoin(repos, eq(repos.id, tasks.repoId))
    .where(eq(tasks.id, taskId));
  if (!row) return null;
  return {
    taskId: row.task.id,
    issueNumber: row.task.issueNumber,
    title: row.task.title,
    rawRequest: row.task.rawRequest,
    specDir: row.task.specDir,
    acceptance: row.task.acceptance,
    repo: {
      id: row.repo.id,
      owner: row.repo.owner,
      name: row.repo.name,
      defaultBranch: row.repo.defaultBranch,
      testCommand: row.repo.testCommand,
    },
  };
}

export interface RouteLaunchFacts {
  routeId: string;
  channelId: string;
  poolId: string;
  modelId: string;
  hostId: HostId;
  upstreamModel: string | null;
  runAsUser: RunAsUser | null;
}

/** 起会话要的：这条路由的池、会话用户、执行方式、上游模型串。路由不在返回 null。 */
export async function routeLaunchFacts(db: Db, routeId: string): Promise<RouteLaunchFacts | null> {
  const [row] = await db
    .select({ route: routes, pool: pools })
    .from(routes)
    .innerJoin(pools, eq(pools.id, routes.poolId))
    .where(eq(routes.id, routeId));
  if (!row) return null;
  return {
    routeId: row.route.id,
    channelId: row.route.channelId,
    poolId: row.pool.id,
    modelId: row.route.modelId,
    hostId: row.route.hostId,
    upstreamModel: row.route.upstreamModel,
    runAsUser: row.pool.runAsUser,
  };
}

// ---- 会话进度事实

/** plan 的 payload 是 { steps: {title,state}[] }（AskRequest/PlanRequest 同形，没有 index 字段）。形状不对的步骤跳过。 */
function parsePlanSteps(payload: unknown): { title: string; state: string }[] {
  const raw =
    typeof payload === 'object' && payload !== null ? (payload as { steps?: unknown }).steps : undefined;
  if (!Array.isArray(raw)) return [];
  return raw.filter(
    (s): s is { title: string; state: string } =>
      typeof s === 'object' &&
      s !== null &&
      typeof (s as { title?: unknown }).title === 'string' &&
      typeof (s as { state?: unknown }).state === 'string',
  );
}

function asRecord(payload: unknown): Record<string, unknown> | null {
  return typeof payload === 'object' && payload !== null ? (payload as Record<string, unknown>) : null;
}

export interface RunProgressFacts {
  /** 这次会话最后一条进度事件的时刻（任何 kind）；一条都没有是 null。 */
  lastEventAt: Date | null;
  /**
   * 步骤清单最后一次「有一步变成进行中或做完」的时刻。按步骤标题比对相邻两次 plan（没有稳定的步骤编号）；
   * 缺前一次记录（含第一次 plan）时按「之前是 pending」算，所以第一次 plan 里有非 pending 的也算。
   */
  lastStepAdvanceAt: Date | null;
  lastPlan: { at: Date; steps: { title: string; state: string }[] } | null;
  /** 这次会话里还没答的 fleet ask（最早的那个）。 */
  pendingAsk: { id: string; question: string; askedAt: Date } | null;
  /** 最后一条 done 事件的 payload（api 写的形状：{summary, prNumber?, testsPassed, verified?}）。 */
  done: { at: Date; summary: string; testsPassed: boolean | null; payload: unknown } | null;
  /** 最后一条 blocked 事件（{reason, needs}）。 */
  blocked: { at: Date; reason: string; needs: string; payload: unknown } | null;
  /** 最近的 say（新的在后），最多 limit 条。 */
  says: { at: Date; text: string }[];
}

const DEFAULT_SAYS_LIMIT = 20;
/** 步骤状态的先后名次：缺前一次记录时按 pending（0）算。 */
const STEP_STATE_RANK: Record<string, number> = { pending: 0, in_progress: 1, done: 2 };

/** 会话行不在返回 null（不是「没有进度」）。 */
export async function runProgressFacts(
  db: Db,
  runId: string,
  options: { saysLimit?: number } = {},
): Promise<RunProgressFacts | null> {
  const [run] = await db.select({ id: sessionRuns.id }).from(sessionRuns).where(eq(sessionRuns.id, runId));
  if (!run) return null;

  const saysLimit = options.saysLimit ?? DEFAULT_SAYS_LIMIT;
  const [lastEventRows, planEvents, pendingAskRows, doneRows, blockedRows, sayRows] = await Promise.all([
    db
      .select({ at: max(progressEvents.at) })
      .from(progressEvents)
      .where(eq(progressEvents.runId, runId)),
    db
      .select({ at: progressEvents.at, payload: progressEvents.payload })
      .from(progressEvents)
      .where(and(eq(progressEvents.runId, runId), eq(progressEvents.kind, 'plan')))
      .orderBy(asc(progressEvents.at), asc(progressEvents.id)),
    db
      .select({ id: asks.id, question: asks.question, askedAt: asks.askedAt })
      .from(asks)
      .where(and(eq(asks.runId, runId), isNull(asks.answer)))
      .orderBy(asc(asks.askedAt))
      .limit(1),
    db
      .select({ at: progressEvents.at, payload: progressEvents.payload })
      .from(progressEvents)
      .where(and(eq(progressEvents.runId, runId), eq(progressEvents.kind, 'done')))
      .orderBy(desc(progressEvents.at), desc(progressEvents.id))
      .limit(1),
    db
      .select({ at: progressEvents.at, payload: progressEvents.payload })
      .from(progressEvents)
      .where(and(eq(progressEvents.runId, runId), eq(progressEvents.kind, 'blocked')))
      .orderBy(desc(progressEvents.at), desc(progressEvents.id))
      .limit(1),
    db
      .select({ at: progressEvents.at, payload: progressEvents.payload })
      .from(progressEvents)
      .where(and(eq(progressEvents.runId, runId), eq(progressEvents.kind, 'say')))
      .orderBy(desc(progressEvents.at), desc(progressEvents.id))
      .limit(saysLimit),
  ]);

  let lastStepAdvanceAt: Date | null = null;
  let prevByTitle = new Map<string, string>();
  for (const ev of planEvents) {
    const steps = parsePlanSteps(ev.payload);
    const advanced = steps.some(
      (s) => (STEP_STATE_RANK[s.state] ?? 0) > (STEP_STATE_RANK[prevByTitle.get(s.title) ?? 'pending'] ?? 0),
    );
    if (advanced) lastStepAdvanceAt = ev.at;
    prevByTitle = new Map(steps.map((s) => [s.title, s.state]));
  }
  const lastPlanEvent = planEvents.at(-1);
  const lastPlan = lastPlanEvent
    ? { at: lastPlanEvent.at, steps: parsePlanSteps(lastPlanEvent.payload) }
    : null;

  const pendingAskRow = pendingAskRows[0];
  const pendingAsk = pendingAskRow
    ? { id: pendingAskRow.id, question: pendingAskRow.question, askedAt: pendingAskRow.askedAt }
    : null;

  const doneRow = doneRows[0];
  const done = doneRow
    ? {
        at: doneRow.at,
        summary: (() => {
          const s = asRecord(doneRow.payload)?.summary;
          return typeof s === 'string' ? s : '';
        })(),
        testsPassed: (() => {
          const v = asRecord(doneRow.payload)?.testsPassed;
          return typeof v === 'boolean' ? v : null;
        })(),
        payload: doneRow.payload,
      }
    : null;

  const blockedRow = blockedRows[0];
  const blocked = blockedRow
    ? {
        at: blockedRow.at,
        reason: (() => {
          const v = asRecord(blockedRow.payload)?.reason;
          return typeof v === 'string' ? v : '';
        })(),
        needs: (() => {
          const v = asRecord(blockedRow.payload)?.needs;
          return typeof v === 'string' ? v : '';
        })(),
        payload: blockedRow.payload,
      }
    : null;

  const says = sayRows
    .map((r) => {
      const v = asRecord(r.payload)?.text;
      return { at: r.at, text: typeof v === 'string' ? v : '' };
    })
    .reverse();

  return {
    lastEventAt: lastEventRows[0]?.at ?? null,
    lastStepAdvanceAt,
    lastPlan,
    pendingAsk,
    done,
    blocked,
    says,
  };
}

// ---- 引擎提问、报警、人闸

/**
 * 引擎提问：按 id 幂等（已有 → created=false）。runId 给了但撞上 (run_id, md5(question)) 唯一（会话已经用
 * fleet ask 问过同一句）或 (task_id, run_id) 外键不满足（这个 runId 不属于这个 taskId 名下的会话）时，
 * 改用 run_id=null 再插一次，runLinked=false；任务不在照常抛。
 */
export async function openEngineAsk(
  db: Db,
  input: { id: string; taskId: string; runId: string | null; question: string; options: string[] },
): Promise<{ created: boolean; runLinked: boolean }> {
  return db.transaction(async (tx) => {
    const askedAt = new Date();
    const values = (runId: string | null) => ({
      id: input.id,
      taskId: input.taskId,
      runId,
      question: input.question,
      options: input.options,
      askedAt,
    });

    let rows: (typeof asks.$inferSelect)[];
    if (input.runId === null) {
      rows = await tx.insert(asks).values(values(null)).onConflictDoNothing().returning();
    } else {
      try {
        // (run_id, question) 唯一冲突会被 onConflictDoNothing 接住（返回空，不抛）；只有外键不满足会抛错。
        // 抛错会让外层事务作废，用子事务（保存点）兜住这一步，抛了照样能接着往下走。
        rows = await tx.transaction((sp) =>
          sp.insert(asks).values(values(input.runId)).onConflictDoNothing().returning(),
        );
      } catch (err) {
        if (!isConstraintError(err, 'asks_run_in_task_fk')) throw err;
        rows = [];
      }
    }

    let row = rows[0];
    let created = row !== undefined;
    if (!row) {
      const [existing] = await tx.select().from(asks).where(eq(asks.id, input.id));
      if (existing) {
        row = existing;
      } else {
        const [fallback] = await tx.insert(asks).values(values(null)).onConflictDoNothing().returning();
        if (!fallback) throw new Error(`引擎提问 ${input.id} 写不进也读不到`);
        row = fallback;
        created = true;
      }
    }

    if (created && row.runId !== null) {
      // 和 api 的 openAsk 一样：同一事务里补一条进度事件，不会出现「追问开了、进度没记」的半截。
      await tx.insert(progressEvents).values({
        runId: row.runId,
        at: askedAt,
        kind: 'ask',
        payload: { askId: row.id, question: input.question },
      });
    }
    return { created, runLinked: row.runId !== null };
  });
}

/** 报警：同一件事（dedupe_key）只有一条，再报原地更新标题、正文、updated_at（显式写），已处理的重新打开（resolved_at/by 清空）。 */
export async function upsertAlert(
  db: Db,
  input: {
    dedupeKey: string;
    level: 'alert' | 'decision';
    taskId: string | null;
    title: string;
    body: string;
    link?: string;
  },
): Promise<{ id: string; created: boolean }> {
  const now = new Date();
  const [row] = await db
    .insert(notifications)
    .values({
      level: input.level,
      dedupeKey: input.dedupeKey,
      taskId: input.taskId,
      title: input.title,
      body: input.body,
      link: input.link ?? null,
    })
    .onConflictDoUpdate({
      target: notifications.dedupeKey,
      set: {
        level: input.level,
        taskId: input.taskId,
        title: input.title,
        body: input.body,
        link: input.link ?? null,
        updatedAt: now,
        resolvedAt: null,
        resolvedBy: null,
      },
    })
    // xmax = 0 只在这一行是刚插入（不是走 on conflict 更新）时成立，是判断「插成还是原地更新」的标准写法。
    .returning({ id: notifications.id, created: sql<boolean>`(xmax = 0)` });
  if (!row) throw new Error(`报警 ${input.dedupeKey} 写不进去`);
  return { id: row.id, created: row.created };
}

/**
 * 按 dedupe_key 把一条报警标成已处理（引擎看到事情好了：挂起的账号池跑通了一次会话）。已处理的不动（不改处理人、处理时刻），
 * 回 already_resolved；没有这条回 not_found——调用方分得清「处理掉了」「本来就处理过」「根本没报过」。
 */
export async function resolveAlertByKey(
  db: Db,
  input: { dedupeKey: string; by: string; at?: Date },
): Promise<'ok' | 'already_resolved' | 'not_found'> {
  const at = input.at ?? new Date();
  const [row] = await db
    .update(notifications)
    .set({ resolvedAt: at, resolvedBy: input.by, updatedAt: at })
    .where(and(eq(notifications.dedupeKey, input.dedupeKey), isNull(notifications.resolvedAt)))
    .returning({ id: notifications.id });
  if (row) return 'ok';
  const [existing] = await db
    .select({ id: notifications.id })
    .from(notifications)
    .where(eq(notifications.dedupeKey, input.dedupeKey));
  return existing ? 'already_resolved' : 'not_found';
}

export interface OpenAlert {
  id: string;
  dedupeKey: string;
  level: 'decision' | 'alert' | 'daily';
  taskId: string | null;
  title: string;
  body: string;
  createdAt: Date;
  updatedAt: Date;
}

/**
 * 还没处理的、dedupe_key 以 prefix 开头的报警，老的在前（例如 `pool-hold:` 找出被挂起的账号池）。
 * 按前缀逐字比（starts_with），不走 LIKE：前缀里的 % 和 _ 不会变成通配符。空前缀等于全表，明确拒绝。
 */
export async function openAlertsByPrefix(db: Db, prefix: string): Promise<OpenAlert[]> {
  if (!prefix) throw new Error('报警前缀是空的：那等于把所有没处理的报警都拿出来');
  return db
    .select({
      id: notifications.id,
      dedupeKey: notifications.dedupeKey,
      level: notifications.level,
      taskId: notifications.taskId,
      title: notifications.title,
      body: notifications.body,
      createdAt: notifications.createdAt,
      updatedAt: notifications.updatedAt,
    })
    .from(notifications)
    .where(and(isNull(notifications.resolvedAt), sql`starts_with(${notifications.dedupeKey}, ${prefix})`))
    .orderBy(asc(notifications.createdAt), asc(notifications.id));
}

/** 一次最多写这么多条：插头一秒能吐几十条工具事件，引擎攒一批再写；再多说明攒批的地方坏了。 */
export const PROGRESS_BATCH_MAX = 500;

/**
 * 引擎从过程记录里被动读到的进度（说话、工具、改文件、跑测试、待办清单）按批追加进 progress_events。
 * 会话行不在回 run_not_found（一条都不写）；plan 的 payload 没有 steps 数组、条数超上限、时刻读不出都直接抛——
 * 这些是引擎自己的错，不能静默丢（看板的进度条会变成 0/0）。整批一个语句，要么全进要么全不进。
 */
export async function appendProgressEvents(
  db: Db,
  runId: string,
  events: readonly { at: Date; kind: ProgressKind; payload: unknown }[],
): Promise<'written' | 'run_not_found'> {
  if (events.length > PROGRESS_BATCH_MAX) {
    throw new Error(`一批进度事件 ${events.length} 条，超过上限 ${PROGRESS_BATCH_MAX}`);
  }
  for (const [i, e] of events.entries()) {
    if (!(e.at instanceof Date) || Number.isNaN(e.at.getTime())) throw new Error(`第 ${i + 1} 条进度事件的时刻读不出`);
    if (e.kind === 'plan' && !Array.isArray(asRecord(e.payload)?.steps)) {
      throw new Error(`第 ${i + 1} 条进度事件是 plan，但 payload 里没有 steps 数组`);
    }
  }
  const [run] = await db.select({ id: sessionRuns.id }).from(sessionRuns).where(eq(sessionRuns.id, runId));
  if (!run) return 'run_not_found';
  if (events.length === 0) return 'written';
  await db.insert(progressEvents).values(events.map((e) => ({ runId, at: e.at, kind: e.kind, payload: e.payload })));
  return 'written';
}

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
    });
    return { created: row !== undefined };
  });
}

export async function getApproval(db: Db, id: string): Promise<ApprovalRecord | null> {
  const [row] = await db.select().from(approvals).where(eq(approvals.id, id));
  return row ? mapApproval(row) : null;
}

export async function decideApproval(
  db: Db,
  input: { id: string; decision: 'approved' | 'rejected'; by: string; reason?: string },
): Promise<'ok' | 'already_decided' | 'not_found'> {
  const updated = await db
    .update(approvals)
    .set({
      decision: input.decision,
      decidedBy: input.by,
      decidedAt: new Date(),
      reason: input.reason ?? null,
    })
    .where(and(eq(approvals.id, input.id), isNull(approvals.decision)))
    .returning({ id: approvals.id });
  if (updated.length > 0) return 'ok';
  const [existing] = await db.select({ id: approvals.id }).from(approvals).where(eq(approvals.id, input.id));
  return existing ? 'already_decided' : 'not_found';
}

// ---- 执行计时

export type StepTimingInput =
  | {
      kind: 'activity';
      workflowId: string;
      temporalRunId: string;
      workflowType: string;
      activity: string;
      attempt: number;
      taskId?: string;
      subtaskId?: string;
      subtaskKey?: string;
      scheduledAt: Date;
      startedAt: Date;
      endedAt: Date;
      queueMs: number;
      runMs: number;
      outcome: 'ok' | 'failed' | 'cancelled';
      errorCode?: string;
    }
  | {
      kind: 'wait';
      workflowId: string;
      temporalRunId: string;
      workflowType: string;
      waitFor: string;
      detail: string;
      taskId?: string;
      subtaskId?: string;
      subtaskKey?: string;
      startedAt: Date;
      endedAt: Date;
      waitMs: number;
    };

/** 重复的一笔（活动重试重写）返回 'duplicate'，不报错。 */
export async function recordStepTiming(db: Db, input: StepTimingInput): Promise<'written' | 'duplicate'> {
  const common = {
    kind: input.kind,
    workflowId: input.workflowId,
    temporalRunId: input.temporalRunId,
    workflowType: input.workflowType,
    taskId: input.taskId ?? null,
    subtaskId: input.subtaskId ?? null,
    subtaskKey: input.subtaskKey ?? null,
    startedAt: input.startedAt,
    endedAt: input.endedAt,
  };
  const [row] =
    input.kind === 'activity'
      ? await db
          .insert(stepTimings)
          .values({
            ...common,
            activity: input.activity,
            attempt: input.attempt,
            scheduledAt: input.scheduledAt,
            queueMs: input.queueMs,
            runMs: input.runMs,
            outcome: input.outcome,
            errorCode: input.errorCode ?? null,
          })
          .onConflictDoNothing({
            target: [
              stepTimings.workflowId,
              stepTimings.temporalRunId,
              stepTimings.activity,
              stepTimings.attempt,
              stepTimings.scheduledAt,
            ],
            where: sql`kind = 'activity'`,
          })
          .returning({ id: stepTimings.id })
      : await db
          .insert(stepTimings)
          .values({ ...common, waitFor: input.waitFor, detail: input.detail, waitMs: input.waitMs })
          .onConflictDoNothing({
            target: [
              stepTimings.workflowId,
              stepTimings.temporalRunId,
              stepTimings.waitFor,
              stepTimings.startedAt,
            ],
            where: sql`kind = 'wait'`,
          })
          .returning({ id: stepTimings.id });
  return row ? 'written' : 'duplicate';
}

// ---- 任务快照

export interface TaskSnapshotInput {
  taskId: string;
  state: TaskState;
  phase: string;
  doing: string;
  specDir: string;
  docs: { requirement?: string; plan?: string; result?: string };
  lastProblem: string | null;
  subtasks: {
    id: string;
    key: string;
    index: number;
    title: string;
    touches: string[];
    dependsOn: string[];
    state: SubtaskState;
    prNumber: number | null;
    waitingOn: string | null;
    workflowId: string | null;
    holds: string[];
  }[];
}

/**
 * 一个事务：更新 tasks 那一行（含 updated_at）；这个任务里不在快照中的子任务标 superseded_at（已标的不重标）；
 * 快照里的逐个按 id upsert（清掉 superseded_at）；快照里子任务的依赖整体替换。任务行不在返回 'task_not_found'
 * （不建任务行：快照里没有标题、原话这些必填列）。
 *
 * 注意：子任务按 id 逐条 upsert，不是一条多行语句——如果快照把两个仍在役的子任务互换 index（不经过标作废），
 * 处理顺序在前的那条会撞部分唯一索引。目前唯一会撞索引的场景（旧子任务标作废、新子任务复用它的 index）
 * 天然没这问题：作废写在所有 upsert 之前，新记录落地时旧 index 早就让出来了。
 */
export async function saveTaskSnapshot(
  db: Db,
  input: TaskSnapshotInput,
): Promise<'saved' | 'task_not_found'> {
  return db.transaction(async (tx) => {
    const updated = await tx
      .update(tasks)
      .set({
        state: input.state,
        phase: input.phase,
        doing: input.doing,
        specDir: input.specDir,
        docs: input.docs,
        lastProblem: input.lastProblem,
        updatedAt: new Date(),
      })
      .where(eq(tasks.id, input.taskId))
      .returning({ id: tasks.id });
    if (updated.length === 0) return 'task_not_found';

    const keepIds = input.subtasks.map((s) => s.id);
    await tx
      .update(subtasks)
      .set({ supersededAt: new Date() })
      .where(
        and(
          eq(subtasks.taskId, input.taskId),
          isNull(subtasks.supersededAt),
          keepIds.length > 0 ? notInArray(subtasks.id, keepIds) : undefined,
        ),
      );

    for (const s of input.subtasks) {
      const values = {
        index: s.index,
        title: s.title,
        touches: s.touches,
        state: s.state,
        prNumber: s.prNumber,
        waitingOn: s.waitingOn,
        key: s.key,
        workflowId: s.workflowId,
        holds: s.holds,
        supersededAt: null,
      };
      await tx
        .insert(subtasks)
        .values({ id: s.id, taskId: input.taskId, ...values })
        .onConflictDoUpdate({ target: subtasks.id, set: values });
    }

    await tx
      .delete(subtaskDeps)
      .where(
        and(
          eq(subtaskDeps.taskId, input.taskId),
          keepIds.length > 0 ? inArray(subtaskDeps.subtaskId, keepIds) : undefined,
        ),
      );
    const deps = input.subtasks.flatMap((s) =>
      s.dependsOn.map((dependsOnId) => ({ taskId: input.taskId, subtaskId: s.id, dependsOnId })),
    );
    if (deps.length > 0) await tx.insert(subtaskDeps).values(deps);

    return 'saved';
  });
}

// ---- 选路事实

/** 没有的话来 candidates.ts 已算好的比例，反过来（1 - 比例）会在超额（>100%）时把信息夹没，所以单独写一份。 */
function usedRatio(w: {
  utilization: number | null;
  used: number | null;
  limit: number | null;
}): number | null {
  if (w.utilization !== null) return w.utilization;
  if (w.used !== null && w.limit !== null && w.limit > 0) return w.used / w.limit;
  return null;
}

export interface StageRouteFacts {
  stage: StageKind;
  configured: boolean;
  stagePinned: boolean;
  order: { routeId: string; position: number; enabled: boolean }[];
  routes: {
    routeId: string;
    channelId: string;
    poolId: string;
    poolRunAsUser: string | null;
    modelId: string;
    modelName: string;
    family: string;
    hostId: HostId;
    upstreamModel: string | null;
    upstreamAliases: string[];
    quota: 'ok' | 'exhausted' | 'unknown';
    windows: {
      label: string;
      window: QuotaWindowKind;
      scope: string | null;
      state: 'ok' | 'exhausted' | 'stale' | 'reset';
      applies: 'yes' | 'unknown';
      used: number | null;
      resetsAt: Date | null;
      reading: 'measured' | 'estimated';
      readAt: Date;
      staleSince: Date | null;
    }[];
    inFlight: number;
    reserved: number;
    maxConcurrency: number;
    banReasons: string[];
    blockers: Blocker[];
  }[];
}

/**
 * 在 stageCandidates 算好的挡法上加字段，不重判一遍谁能派谁不能派。stage_policy_routes 里 enabled=false 的行
 * stageCandidates 已经带着（用 'switched-off' 这个挡因标记），这里原样透出到 order。
 */
export async function routeFactsForStage(
  db: Db,
  stage: StageKind,
  options: { now?: Date; staleAfterMs?: number } = {},
): Promise<StageRouteFacts> {
  const candidates = await stageCandidates(db, stage, options);
  if (!candidates.configured) return { stage, configured: false, stagePinned: false, order: [], routes: [] };

  const sorted = [...candidates.candidates].sort((a, b) => a.position - b.position);
  const order = sorted.map((c) => ({
    routeId: c.routeId,
    position: c.position,
    enabled: !c.blockers.includes('switched-off'),
  }));
  if (sorted.length === 0)
    return { stage, configured: true, stagePinned: candidates.pinned, order, routes: [] };

  const routeIds = sorted.map((c) => c.routeId);
  const poolIds = [...new Set(sorted.map((c) => c.poolId))];
  const [detailRows, windowRows, reservedRows] = await Promise.all([
    db
      .select({
        routeId: routes.id,
        upstreamModel: routes.upstreamModel,
        upstreamAliases: routes.upstreamAliases,
        poolRunAsUser: pools.runAsUser,
        modelName: models.displayName,
      })
      .from(routes)
      .innerJoin(pools, eq(pools.id, routes.poolId))
      .innerJoin(models, eq(models.id, routes.modelId))
      .where(inArray(routes.id, routeIds)),
    db.select().from(quotaWindows).where(inArray(quotaWindows.poolId, poolIds)),
    db
      .select({ poolId: routes.poolId, n: sql<number>`count(*)::int` })
      .from(sessionRuns)
      .innerJoin(routes, eq(routes.id, sessionRuns.routeId))
      .where(and(isNull(sessionRuns.startedAt), isNull(sessionRuns.endedAt)))
      .groupBy(routes.poolId),
  ]);
  const detailByRoute = new Map(detailRows.map((r) => [r.routeId, r]));
  const windowByKey = new Map(windowRows.map((w) => [`${w.poolId}\u0000${w.label}`, w]));
  const reservedByPool = new Map(reservedRows.map((r) => [r.poolId, r.n]));

  const routesOut = sorted.map((c) => {
    const detail = detailByRoute.get(c.routeId);
    if (!detail) throw new Error(`路由 ${c.routeId} 查不到渠道 / 池 / 模型详情`);
    return {
      routeId: c.routeId,
      channelId: c.channelId,
      poolId: c.poolId,
      poolRunAsUser: detail.poolRunAsUser,
      modelId: c.modelId,
      modelName: detail.modelName,
      family: c.family,
      hostId: c.hostId,
      upstreamModel: detail.upstreamModel,
      upstreamAliases: detail.upstreamAliases,
      quota: c.quota,
      windows: c.windows.map((w) => {
        const raw = windowByKey.get(`${c.poolId}\u0000${w.label}`);
        if (!raw) throw new Error(`额度窗 ${c.poolId}/${w.label} 在候选查询之后就没了`);
        return {
          label: w.label,
          window: w.window,
          scope: w.scope,
          state: w.state,
          applies: w.applies,
          used: usedRatio(raw),
          resetsAt: w.resetsAt,
          reading: raw.reading,
          readAt: w.readAt,
          staleSince: w.staleSince,
        };
      }),
      inFlight: c.inFlight,
      reserved: reservedByPool.get(c.poolId) ?? 0,
      maxConcurrency: c.maxConcurrency,
      banReasons: c.banReasons,
      blockers: c.blockers,
    };
  });

  return { stage, configured: true, stagePinned: candidates.pinned, order, routes: routesOut };
}
