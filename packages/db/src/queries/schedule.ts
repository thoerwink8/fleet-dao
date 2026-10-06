// 定时任务：登记该跑的任务、记每次跑的开始和结局；看门狗和驾驶舱按登记表逐个查新鲜度。
// 以登记为准而不是以跑过的记录为准：一次都没跑过的任务没有记录，只看记录就永远看不见它（没跑成 ≠ 没问题）。
import type { ScheduleOutcome } from '@fleet-dao/shared';
import { and, asc, desc, eq, inArray } from 'drizzle-orm';
import type { Db } from '../client.ts';
import { SCHEDULE_OUTCOMES } from '../schema/enums.ts';
import { scheduledJobs, scheduleRuns } from '../schema/index.ts';

type RunRow = typeof scheduleRuns.$inferSelect;
type JobRow = typeof scheduledJobs.$inferSelect;

/**
 * 引擎启动时按代码里的声明写入（已有的更新名字、计划、期望间隔；登记时刻不动；标过摘除的重新回来，摘除清零）。
 * 没登记的任务记不了运行记录（外键）。
 */
export async function registerScheduledJobs(
  db: Db,
  jobs: readonly (typeof scheduledJobs.$inferInsert)[],
): Promise<void> {
  for (const job of jobs) {
    await db
      .insert(scheduledJobs)
      .values(job)
      .onConflictDoUpdate({
        target: scheduledJobs.id,
        set: {
          name: job.name,
          schedule: job.schedule,
          expectEveryMinutes: job.expectEveryMinutes,
          removedAt: null,
        },
      });
  }
}

/**
 * 把退役任务的登记行标上摘除（#1140）：它不会再跑了，不再是期望，定时任务页和看门狗都不再看（scheduleHealth）。
 * 只标记不删除：schedule_runs 还挂着外键，历史跑记录也留着；跑记录里不会再有新的行。从没登记过的编号无事发生。
 */
export async function unregisterScheduledJobs(
  db: Db,
  ids: readonly string[],
  removedAt: Date = new Date(),
): Promise<void> {
  if (ids.length === 0) return;
  await db
    .update(scheduledJobs)
    .set({ removedAt })
    .where(inArray(scheduledJobs.id, [...ids]));
}

export async function startScheduleRun(db: Db, job: string, startedAt: Date = new Date()): Promise<number> {
  const [row] = await db.insert(scheduleRuns).values({ job, startedAt }).returning({ id: scheduleRuns.id });
  if (!row) throw new Error(`没记上定时任务 ${job} 的开始`);
  return row.id;
}

/** 四种结局的含义见 domain.ts 的 ScheduleOutcome；不是 ok 的都要写原因。 */
export type ScheduleResult =
  /** 跑完了：扫了 scanned 个对象（必须 > 0，一个都没扫到要写 unscanned）、发现 found 个问题。 */
  | { outcome: 'ok'; scanned: number; found: number }
  /** 跑完了但有一部分没查成（数据不全是状态不是故障），why 写缺了哪块。 */
  | { outcome: 'partial'; why: string; scanned?: number; found?: number }
  /** 跑完了但一个对象都没扫到，why 写为什么（例如上游名册是空的）。 */
  | { outcome: 'unscanned'; why: string }
  /** 没跑成。 */
  | { outcome: 'failed'; why: string; scanned?: number; found?: number };

export async function finishScheduleRun(
  db: Db,
  id: number,
  result: ScheduleResult,
  endedAt: Date = new Date(),
): Promise<void> {
  const updated = await db
    .update(scheduleRuns)
    .set({
      endedAt,
      outcome: result.outcome,
      scanned: result.outcome === 'unscanned' ? 0 : (result.scanned ?? null),
      found: result.outcome === 'unscanned' ? null : (result.found ?? null),
      why: 'why' in result ? result.why : null,
    })
    .where(eq(scheduleRuns.id, id))
    .returning({ id: scheduleRuns.id });
  if (updated.length === 0) throw new Error(`没有这次定时任务记录：${id}`);
}

/**
 * never：一次都没跑过；failing：最近一次结束的没跑成；no-samples：最近一次结束的一个对象都没扫到；
 * stale：上次跑成（ok / partial）距今超过 expect_every_minutes，或从没跑成过；ok：新鲜、跑完、扫到了东西。
 * 先看最近一次的结局，再看新鲜度：最近一次没跑成、没扫到，比「多久没成功」更能说明问题。
 * 要不要报人看 fresh（下面），不只看这个标签：最近一次是 no-samples 的，停在那儿不动了也还是 no-samples。
 */
export type JobHealthStatus = 'never' | 'failing' | 'no-samples' | 'stale' | 'ok';

/** 看门狗（引擎的定时任务，#203）在登记表上的编号：它自己停没停由后端的健康检查和看守按这一行现算。 */
export const WATCHDOG_JOB_ID = 'watchdog';

export interface JobHealth {
  job: JobRow;
  status: JobHealthStatus;
  /**
   * 在不在期望间隔里：上次跑成距今不超过 expect_every_minutes；从没跑成过的从登记（registered_at）算起——刚登记、
   * 还没轮到第一次的算新鲜，登记了超过期望间隔还没跑成过的不算。和标签无关：no-samples 一直没扫到东西、停着不跑，
   * 过了期望间隔一样是 false。看门狗报「停了」就看它。
   */
  fresh: boolean;
  /** 最近一次还没结束。 */
  running: boolean;
  lastRun: RunRow | null;
  /** 最近一次结束了的（结局不为空；还在跑的那次不算）。 */
  lastFinished: RunRow | null;
  /** 最近一次跑成（ok 或 partial）。 */
  lastSuccess: RunRow | null;
}

export async function scheduleHealth(db: Db, now: Date = new Date()): Promise<JobHealth[]> {
  const jobs = (await db.select().from(scheduledJobs).orderBy(asc(scheduledJobs.id))).filter(
    // 摘除了的（#1140：退役任务，引擎起来时 unregisterScheduledJobs 标的）不再是期望，不参加新不新鲜的判断
    (j) => j.removedAt === null,
  );
  if (jobs.length === 0) return [];
  const ids = jobs.map((j) => j.id);
  const latestPer = (only?: readonly ScheduleOutcome[]) =>
    db
      .selectDistinctOn([scheduleRuns.job])
      .from(scheduleRuns)
      .where(and(inArray(scheduleRuns.job, ids), only ? inArray(scheduleRuns.outcome, [...only]) : undefined))
      .orderBy(
        scheduleRuns.job,
        desc(only ? scheduleRuns.endedAt : scheduleRuns.startedAt),
        desc(scheduleRuns.id),
      );
  const [latest, latestSuccess, latestFinished] = await Promise.all([
    latestPer(),
    latestPer(['ok', 'partial']),
    // 还在跑的那次没有结局，看最近一次的结局要看已结束的。
    latestPer(SCHEDULE_OUTCOMES),
  ]);
  const latestByJob = new Map(latest.map((r) => [r.job, r]));
  const successByJob = new Map(latestSuccess.map((r) => [r.job, r]));
  const finishedByJob = new Map(latestFinished.map((r) => [r.job, r]));

  return jobs.map((job): JobHealth => {
    const lastRun = latestByJob.get(job.id) ?? null;
    const lastSuccess = successByJob.get(job.id) ?? null;
    const lastFinished = finishedByJob.get(job.id) ?? null;
    const maxAgeMs = job.expectEveryMinutes * 60_000;
    let status: JobHealthStatus;
    if (lastRun === null) status = 'never';
    else if (lastFinished?.outcome === 'failed') status = 'failing';
    else if (lastFinished?.outcome === 'unscanned') status = 'no-samples';
    else if (lastSuccess?.endedAt == null || now.getTime() - lastSuccess.endedAt.getTime() > maxAgeMs)
      status = 'stale';
    else status = 'ok';
    const since = lastSuccess?.endedAt ?? job.registeredAt;
    return {
      job,
      status,
      fresh: now.getTime() - since.getTime() <= maxAgeMs,
      running: lastRun !== null && lastRun.outcome === null,
      lastRun,
      lastFinished,
      lastSuccess,
    };
  });
}
