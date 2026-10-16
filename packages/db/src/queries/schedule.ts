// 定时任务：登记该跑的任务、记每次跑的开始和结局；看门狗和驾驶舱按登记表逐个查新鲜度。
// 以登记为准而不是以跑过的记录为准：一次都没跑过的任务没有记录，只看记录就永远看不见它（没跑成 ≠ 没问题）。
import type { ScheduleOutcome } from '@fleet-dao/shared';
import { errMessage } from '@fleet-dao/shared/util';
import { and, asc, desc, eq, gte, inArray, isNull, like, lt, max, not, or } from 'drizzle-orm';
import type { Db } from '../client.ts';
import { SCHEDULE_OUTCOMES } from '../schema/enums.ts';
import { scheduledJobs, scheduleRuns } from '../schema/index.ts';
import { allSettledOrThrow } from './all-settled.ts';

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

/**
 * 这个定时任务最近一次跑成（outcome = ok，不含 partial）的结束时刻。
 * 对账用它当回看起点：没查全的那一轮不能把窗口往前推，否则没扫到的仓在这段里的事件就补不回来。
 * 一次都没跑成回 null，不回时刻 0。读库失败照抛，由调用方按「没有记录」退。
 */
export async function lastSuccessfulScheduleRunEndedAt(db: Db, job: string): Promise<Date | null> {
  const [row] = await db
    .select({ endedAt: scheduleRuns.endedAt })
    .from(scheduleRuns)
    .where(and(eq(scheduleRuns.job, job), eq(scheduleRuns.outcome, 'ok')))
    .orderBy(desc(scheduleRuns.endedAt), desc(scheduleRuns.id))
    .limit(1);
  const endedAt = row?.endedAt ?? null;
  if (endedAt === null) return null;
  const ms = endedAt.getTime();
  if (!Number.isFinite(ms) || ms <= 0) return null;
  return endedAt;
}

export async function startScheduleRun(db: Db, job: string, startedAt: Date = new Date()): Promise<number> {
  const [row] = await db.insert(scheduleRuns).values({ job, startedAt }).returning({ id: scheduleRuns.id });
  if (!row) throw new Error(`没记上定时任务 ${job} 的开始`);
  return row.id;
}

/** 四种结局的含义见 domain.ts 的 ScheduleOutcome；不是 ok 的都要写原因。 */
export type ScheduleResult =
  /**
   * 跑完了：扫了 scanned 个对象（必须 > 0，一个都没扫到要写 unscanned）、发现 found 个问题。
   * why 可选：这一轮怎么分的账（拉单：每种没派的原因各几张），只记事实、不是故障——found=0 时靠它分得开「没单」和「全被拦」。
   */
  | { outcome: 'ok'; scanned: number; found: number; why?: string }
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

/** 这一时刻之后拉单各轮发现的候选数。含还在跑的（found 是 null）。空闲升级靠它判断这一小时没有候选。 */
export async function intakeFoundSince(db: Db, since: Date): Promise<(number | null)[]> {
  const rows = await db
    .select({ found: scheduleRuns.found })
    .from(scheduleRuns)
    .where(and(eq(scheduleRuns.job, 'intake'), gte(scheduleRuns.startedAt, since)))
    .orderBy(asc(scheduleRuns.startedAt));
  return rows.map((row) => row.found);
}

/**
 * 引擎总开关关着、这一轮被跳过时记在 schedule_runs 的原因开头（记成 partial：看门狗的新鲜度当它跑成，不会误报「停了」）。
 * 这是有意的暂停不是故障：「连着没跑全」（scheduleRedStreaks）不把它算进红的，也不让它打断一段真的红。
 */
export const MASTER_OFF_SKIP_WHY = '引擎总开关关着，这一轮不跑：';

/** 进程被发版或重启腰斩、已经记下开始却没人收尾时，起来补记写的原因。 */
export const INTERRUPTED_SCHEDULE_WHY = '进程中断没收尾，启动时补记';

export interface CloseInterruptedScheduleRunsInput {
  /** 本进程会跑的任务，和各自的补记线：开始得比这早、还没结束的才补。 */
  jobs: readonly { id: string; startedBefore: Date }[];
  /** 这次补记是什么时候做的。结束时刻不写它，见 closeInterruptedScheduleRuns。 */
  at: Date;
  /** 不给就用 INTERRUPTED_SCHEDULE_WHY。巡检补自己的没收尾轮次时换自己的原因。 */
  why?: string;
}

/**
 * 把还没结束、又已经超过补记线的 schedule_runs 补记成 failed，回补上的编号。
 * 结束时刻写成开跑时刻，不写成现在：写成现在的话这行会变成「最近一次结束的」，看门狗把后面已经跑成的轮次盖成没跑成。
 * 没超过补记线的不动（可能是这一轮还在跑）。名单以外的任务不动（不是这个进程跑的）。
 * 写库失败照抛，不把「没补上」当成补上了。
 */
export async function closeInterruptedScheduleRuns(
  db: Db,
  input: CloseInterruptedScheduleRunsInput,
): Promise<number[]> {
  const why = (input.why ?? INTERRUPTED_SCHEDULE_WHY).trim();
  if (!why) throw new Error('补记没收尾的定时任务要写为什么');
  if (Number.isNaN(input.at.getTime())) throw new Error('补记没收尾的定时任务要有有效时刻');
  if (input.jobs.length === 0) return [];
  for (const job of input.jobs) {
    if (!job.id.trim()) throw new Error('补记没收尾的定时任务要有任务编号');
    if (Number.isNaN(job.startedBefore.getTime())) throw new Error('补记没收尾的定时任务要有有效时刻');
  }
  try {
    const ids: number[] = [];
    for (const job of input.jobs) {
      const open = await db
        .select({ id: scheduleRuns.id, startedAt: scheduleRuns.startedAt })
        .from(scheduleRuns)
        .where(
          and(
            eq(scheduleRuns.job, job.id),
            isNull(scheduleRuns.endedAt),
            lt(scheduleRuns.startedAt, job.startedBefore),
          ),
        )
        .orderBy(asc(scheduleRuns.id));
      for (const row of open) {
        const updated = await db
          .update(scheduleRuns)
          .set({ endedAt: row.startedAt, outcome: 'failed', why })
          .where(and(eq(scheduleRuns.id, row.id), isNull(scheduleRuns.endedAt)))
          .returning({ id: scheduleRuns.id });
        for (const written of updated) ids.push(written.id);
      }
    }
    return ids;
  } catch (error) {
    throw new Error(`补记没收尾的定时任务失败：${errMessage(error)}`, { cause: error });
  }
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
  const [latest, latestSuccess, latestFinished] = await allSettledOrThrow([
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

/**
 * 一个定时任务「连着没跑全」的这一段：最近一次跑成（ok）或没东西可扫（unscanned）之后，每一次结束的都是 partial / failed。
 * partial 在 scheduleHealth 里算「跑成」，所以一个任务可以一个月每次都只跑了一半而没人知道——这一段就是把它找出来。
 */
export interface RedStreak {
  job: string;
  /** 这一段有几次（已结束的 partial / failed）。 */
  runs: number;
  firstStartedAt: Date;
  lastStartedAt: Date;
  /** 最近一次的结局和原因。 */
  lastOutcome: 'partial' | 'failed';
  lastWhy: string | null;
  /** 这一段从哪次之后算（上一次 ok / unscanned 的跑记录编号）；回看窗口里没有为 null。 */
  afterRunId: number | null;
}

/** 回看多久：再早的红不管从哪次开始，都只当「已经红了很久」。 */
const RED_STREAK_LOOKBACK_MS = 14 * 24 * 60 * 60_000;

/**
 * 每个任务当前连着没跑全的这一段（没有红的任务不在里面）。只看已结束的；还在跑的不算，也不打断这一段。
 * 读不到照抛，由看门狗记这一轮没查成。
 */
export async function scheduleRedStreaks(db: Db, now: Date = new Date()): Promise<RedStreak[]> {
  const since = new Date(now.getTime() - RED_STREAK_LOOKBACK_MS);
  const [breaks, reds] = await allSettledOrThrow([
    db
      .select({ job: scheduleRuns.job, id: max(scheduleRuns.id) })
      .from(scheduleRuns)
      .where(and(inArray(scheduleRuns.outcome, ['ok', 'unscanned']), gte(scheduleRuns.startedAt, since)))
      .groupBy(scheduleRuns.job),
    db
      .select({
        job: scheduleRuns.job,
        id: scheduleRuns.id,
        startedAt: scheduleRuns.startedAt,
        outcome: scheduleRuns.outcome,
        why: scheduleRuns.why,
      })
      .from(scheduleRuns)
      .where(
        and(
          inArray(scheduleRuns.outcome, ['partial', 'failed']),
          gte(scheduleRuns.startedAt, since),
          // 总开关关着的跳过不算红（有意的暂停）
          or(isNull(scheduleRuns.why), not(like(scheduleRuns.why, `${MASTER_OFF_SKIP_WHY}%`))),
        ),
      )
      .orderBy(asc(scheduleRuns.id)),
  ]);
  const breakAt = new Map(breaks.map((b) => [b.job, b.id ?? 0]));
  const byJob = new Map<string, typeof reds>();
  for (const r of reds) {
    if (r.id <= (breakAt.get(r.job) ?? 0)) continue;
    byJob.set(r.job, [...(byJob.get(r.job) ?? []), r]);
  }
  const out: RedStreak[] = [];
  for (const [job, rows] of byJob) {
    const first = rows[0];
    const last = rows.at(-1);
    if (!first || !last) continue;
    out.push({
      job,
      runs: rows.length,
      firstStartedAt: first.startedAt,
      lastStartedAt: last.startedAt,
      lastOutcome: last.outcome === 'failed' ? 'failed' : 'partial',
      lastWhy: last.why,
      afterRunId: breakAt.get(job) ?? null,
    });
  }
  return out.sort((a, b) => (a.job < b.job ? -1 : 1));
}
