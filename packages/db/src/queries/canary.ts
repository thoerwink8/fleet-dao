// 全流程巡检（#223）：每一轮的记录（canary_runs），和巡检每一回看那张单时从库里读的事实（任务行、runs 记的账、每步耗时、
// 这张单的任务工作流报的要人看的提醒、最近一轮拉单）。判断不在这里：引擎的 jobs/canary.ts 拿这些事实判走到哪一步、断没断。
// 读不到照抛（调用方记「没查成」），不拿空的顶。
import { taskWorkflowId } from '@fleet-dao/shared';
import { and, asc, desc, eq, gte, isNotNull, isNull, lt, ne, sql } from 'drizzle-orm';
import type { Db } from '../client.ts';
import type { CanaryStage, CanaryVerdict, RecordedCanaryStage } from '../schema/enums.ts';
import { canaryRuns, notifications, repos, runs, scheduleRuns, stepTimings, tasks } from '../schema/index.ts';

/** 巡检一轮的一步：走到的时刻。老的几轮里可能是老步骤（RETIRED_CANARY_STAGES）。 */
export interface CanaryStep {
  stage: RecordedCanaryStage;
  at: string;
}

export interface CanaryRunRow {
  id: number;
  scheduleRunId: number;
  repo: string | null;
  issueNumber: number | null;
  taskId: string | null;
  startedAt: Date;
  endedAt: Date | null;
  verdict: CanaryVerdict | null;
  /** 换成三段任务工作流之前的老几轮，这里是老步骤（只读出来给人看）。 */
  stage: RecordedCanaryStage;
  why: string | null;
  steps: CanaryStep[];
  cleanedAt: Date | null;
  updatedAt: Date;
}

const columns = {
  id: canaryRuns.id,
  scheduleRunId: canaryRuns.scheduleRunId,
  repo: canaryRuns.repo,
  issueNumber: canaryRuns.issueNumber,
  taskId: canaryRuns.taskId,
  startedAt: canaryRuns.startedAt,
  endedAt: canaryRuns.endedAt,
  verdict: canaryRuns.verdict,
  stage: canaryRuns.stage,
  why: canaryRuns.why,
  steps: canaryRuns.steps,
  cleanedAt: canaryRuns.cleanedAt,
  updatedAt: canaryRuns.updatedAt,
};

/** 记下一轮开始（停在「开单」这一步）。 */
export async function startCanaryRun(
  db: Db,
  input: { scheduleRunId: number; repo: string | null; at: Date },
): Promise<number> {
  const [row] = await db
    .insert(canaryRuns)
    .values({
      scheduleRunId: input.scheduleRunId,
      repo: input.repo,
      stage: 'open',
      startedAt: input.at,
      updatedAt: input.at,
    })
    .returning({ id: canaryRuns.id });
  if (!row) throw new Error('没记上这一轮巡检的开始');
  return row.id;
}

/** 这一轮走到哪了：还在跑的才改（已经有结论的不动，回 false）。 */
export async function saveCanaryProgress(
  db: Db,
  id: number,
  input: {
    stage: CanaryStage;
    steps: readonly CanaryStep[];
    issueNumber?: number | undefined;
    taskId?: string | undefined;
    at: Date;
  },
): Promise<boolean> {
  const rows = await db
    .update(canaryRuns)
    .set({
      stage: input.stage,
      steps: [...input.steps],
      ...(input.issueNumber === undefined ? {} : { issueNumber: input.issueNumber }),
      ...(input.taskId === undefined ? {} : { taskId: input.taskId }),
      updatedAt: input.at,
    })
    .where(and(eq(canaryRuns.id, id), isNull(canaryRuns.verdict)))
    .returning({ id: canaryRuns.id });
  return rows.length > 0;
}

/**
 * 记下这一轮的结论。已经记过结论的不再改（回 already_finished）；没有这一轮回 not_found。
 * broken、not_run 不写原因库里的约束会拒（canary_runs_not_pass_has_why）。
 */
export async function finishCanaryRun(
  db: Db,
  id: number,
  input: {
    verdict: CanaryVerdict;
    stage: CanaryStage;
    why: string | null;
    steps: readonly CanaryStep[];
    issueNumber?: number | undefined;
    taskId?: string | undefined;
    at: Date;
  },
): Promise<'ok' | 'already_finished' | 'not_found'> {
  const rows = await db
    .update(canaryRuns)
    .set({
      verdict: input.verdict,
      stage: input.stage,
      why: input.why,
      steps: [...input.steps],
      ...(input.issueNumber === undefined ? {} : { issueNumber: input.issueNumber }),
      ...(input.taskId === undefined ? {} : { taskId: input.taskId }),
      endedAt: input.at,
      updatedAt: input.at,
    })
    .where(and(eq(canaryRuns.id, id), isNull(canaryRuns.verdict)))
    .returning({ id: canaryRuns.id });
  if (rows.length > 0) return 'ok';
  const [existing] = await db.select({ id: canaryRuns.id }).from(canaryRuns).where(eq(canaryRuns.id, id));
  return existing ? 'already_finished' : 'not_found';
}

/**
 * 健康页要的两样：最近一轮有结论的（按结束时刻），和正在跑的那一轮（最近开始、还没结论的）。都没有是 null。
 */
export async function latestCanaryRuns(
  db: Db,
): Promise<{ finished: CanaryRunRow | null; running: CanaryRunRow | null }> {
  const [finished] = await db
    .select(columns)
    .from(canaryRuns)
    .where(isNotNull(canaryRuns.verdict))
    .orderBy(desc(canaryRuns.endedAt), desc(canaryRuns.id))
    .limit(1);
  const [running] = await db
    .select(columns)
    .from(canaryRuns)
    .where(isNull(canaryRuns.verdict))
    .orderBy(desc(canaryRuns.startedAt), desc(canaryRuns.id))
    .limit(1);
  return { finished: finished ?? null, running: running ?? null };
}

/** 一轮的记录；没有是 null。 */
export async function canaryRunById(db: Db, id: number): Promise<CanaryRunRow | null> {
  const [row] = await db.select(columns).from(canaryRuns).where(eq(canaryRuns.id, id));
  return row ?? null;
}

/**
 * 前几轮留下、还没收掉的单：这个仓的、已经有结论又不是通过的、开成了单的、还没收过的（老的在前，最多 limit 条）。
 * 下一轮开始时把它们收掉（叫停工作流、关单），免得断了的巡检单一张张攒着、每天被再推一次。
 */
export async function leftoverCanaryRuns(
  db: Db,
  input: { repo: string; limit: number },
): Promise<CanaryRunRow[]> {
  if (!Number.isInteger(input.limit) || input.limit <= 0) throw new Error(`limit 要是正整数：${input.limit}`);
  return db
    .select(columns)
    .from(canaryRuns)
    .where(
      and(
        eq(canaryRuns.repo, input.repo),
        isNotNull(canaryRuns.verdict),
        ne(canaryRuns.verdict, 'pass'),
        isNotNull(canaryRuns.issueNumber),
        isNull(canaryRuns.cleanedAt),
      ),
    )
    .orderBy(asc(canaryRuns.startedAt), asc(canaryRuns.id))
    .limit(input.limit);
}

/**
 * 没收尾的几轮补记成没跑成：还没有结论、开始得比 before 早的（调用方按一轮工作流的时限算，过了时限工作流一定已经没了），
 * 写上原因和结束时刻。回补记了哪几轮，调用方把它们的 schedule_runs 也记成没跑成；开成了的单之后照前几轮留下的单收掉。
 */
export async function concludeAbandonedCanaryRuns(
  db: Db,
  input: { before: Date; why: string; at: Date },
): Promise<{ id: number; scheduleRunId: number; issueNumber: number | null }[]> {
  if (!input.why.trim()) throw new Error('补记没跑成要写原因');
  return db
    .update(canaryRuns)
    .set({ verdict: 'not_run', why: input.why, endedAt: input.at, updatedAt: input.at })
    .where(and(isNull(canaryRuns.verdict), lt(canaryRuns.startedAt, input.before)))
    .returning({
      id: canaryRuns.id,
      scheduleRunId: canaryRuns.scheduleRunId,
      issueNumber: canaryRuns.issueNumber,
    });
}

/** 这一轮留下的单收掉了。 */
export async function markCanaryCleaned(db: Db, id: number, at: Date): Promise<void> {
  const rows = await db
    .update(canaryRuns)
    .set({ cleanedAt: at, updatedAt: at })
    .where(eq(canaryRuns.id, id))
    .returning({ id: canaryRuns.id });
  if (rows.length === 0) throw new Error(`没有这一轮巡检：${id}`);
}

/** 这张单记进 runs 的账：一共几笔、结束了几笔、动手（manual）几笔、验收（verify）几笔、结束了又记上用量（输入 token）的几笔。 */
export interface CanaryLedger {
  total: number;
  ended: number;
  manual: number;
  verify: number;
  withUsage: number;
}

const NO_LEDGER: CanaryLedger = { total: 0, ended: 0, manual: 0, verify: 0, withUsage: 0 };

/** 巡检看一张单时从库里读到的事实（判断在引擎 jobs/canary.ts）。 */
export interface CanaryDbFacts {
  /** 巡检仓在库里的样子；不在库里（没受管）是 null。 */
  repo: { id: string; autoDispatchSince: Date | null } | null;
  /** 这张单的任务行（拉单起任务工作流之前建的）；还没拉起来是 null。 */
  task: {
    id: string;
    state: (typeof tasks.$inferSelect)['state'];
    phase: string | null;
    lastProblem: string | null;
    updatedAt: Date | null;
  } | null;
  /** 这张单记进 runs 的账（三段每跑一次一笔）；还没有任务行是全 0。 */
  runs: CanaryLedger;
  /** 这张单记进库的每步耗时有几笔（活动、等待）。 */
  timings: number;
  /** 这张单的任务工作流报的、还开着的提醒（停下等人……）。 */
  openAlerts: { dedupeKey: string; title: string }[];
  /** 最近一轮拉单（定时任务 intakeJob）：几点开始、结局、原因；一轮都没跑过是 null。收单卡住时看它。 */
  lastIntake: {
    startedAt: Date;
    endedAt: Date | null;
    outcome: (typeof scheduleRuns.$inferSelect)['outcome'];
    why: string | null;
  } | null;
}

/**
 * since：这一轮巡检开单的时刻。runs 的行没有仓和任务编号，只能按单号加「开单以后起的」认这张单的账——
 * 别的仓同一个单号、同一段时间里跑的会话会混进来；要认准得让 runs 写上 task_id。
 * intakeJob：拉单在 scheduled_jobs 里的编号（引擎的 INTAKE_JOB.id）。
 */
export async function canaryDbFacts(
  db: Db,
  input: { owner: string; name: string; issueNumber: number; since: Date; intakeJob: string },
): Promise<CanaryDbFacts> {
  const [repo] = await db
    .select({ id: repos.id, autoDispatchSince: repos.autoDispatchSince })
    .from(repos)
    .where(and(eq(repos.owner, input.owner), eq(repos.name, input.name)));
  const [intake] = await db
    .select({
      startedAt: scheduleRuns.startedAt,
      endedAt: scheduleRuns.endedAt,
      outcome: scheduleRuns.outcome,
      why: scheduleRuns.why,
    })
    .from(scheduleRuns)
    .where(eq(scheduleRuns.job, input.intakeJob))
    .orderBy(desc(scheduleRuns.startedAt), desc(scheduleRuns.id))
    .limit(1);
  const noTask: CanaryDbFacts = {
    repo: repo ?? null,
    task: null,
    runs: NO_LEDGER,
    timings: 0,
    openAlerts: [],
    lastIntake: intake ?? null,
  };
  if (!repo) return noTask;
  const [task] = await db
    .select({
      id: tasks.id,
      state: tasks.state,
      phase: tasks.phase,
      lastProblem: tasks.lastProblem,
      updatedAt: tasks.updatedAt,
    })
    .from(tasks)
    .where(and(eq(tasks.repoId, repo.id), eq(tasks.issueNumber, input.issueNumber)));
  if (!task) return noTask;
  const [ledger] = await db
    .select({
      total: sql<number>`count(*)::int`,
      ended: sql<number>`count(${runs.endedAt})::int`,
      manual: sql<number>`count(*) filter (where ${runs.segment} = 'manual')::int`,
      verify: sql<number>`count(*) filter (where ${runs.segment} = 'verify')::int`,
      withUsage: sql<number>`count(*) filter (where ${runs.endedAt} is not null and ${runs.inputTokens} is not null)::int`,
    })
    .from(runs)
    .where(and(eq(runs.issueNumber, input.issueNumber), gte(runs.startedAt, input.since)));
  const [timings] = await db
    .select({ n: sql<number>`count(*)::int` })
    .from(stepTimings)
    .where(eq(stepTimings.taskId, task.id));
  // 这张单的任务工作流报的提醒都以它的编号开头（taskWorkflowId：task:<owner>/<name>#<号>，后面跟 :park:<第几次>）
  const prefix = `${taskWorkflowId(input, input.issueNumber)}:`;
  const openAlerts = await db
    .select({ dedupeKey: notifications.dedupeKey, title: notifications.title })
    .from(notifications)
    .where(and(isNull(notifications.resolvedAt), sql`starts_with(${notifications.dedupeKey}, ${prefix})`))
    .orderBy(asc(notifications.createdAt), asc(notifications.id));
  return {
    repo,
    task,
    runs: ledger ?? NO_LEDGER,
    timings: timings?.n ?? 0,
    openAlerts,
    lastIntake: intake ?? null,
  };
}
