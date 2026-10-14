// 执行计时：工作流里每次活动、每段等待记一笔，重复的一笔（活动重试重写）不报错。
import { and, asc, eq, gte, inArray, isNotNull, notExists, sql } from 'drizzle-orm';
import type { Db } from '../client.ts';
import { pullRequests, runs, stepTimings, tasks } from '../schema/index.ts';

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

/** 合并后等发版那一段等待（wait_for = release）：不在任务工作流里，由后端看发布历史补记，一个合并提交记一笔。 */
export const RELEASE_WAIT = { workflowId: 'release', workflowType: 'release', waitFor: 'release' } as const;

/** 合进了主线、还没记过「等发版」那一笔的 PR（mergeShas 里的合并提交，mergedAfter 以后合的）。 */
export interface MergeAwaitingRelease {
  repoId: string;
  number: number;
  mergedAt: Date;
  mergeSha: string;
  /** 这个 PR 是哪张单的：动手段记了这个 PR 号的任务，没有再按正文挂的单号找；本机开的 PR 两样都没有是空。 */
  taskId: string | null;
}

export async function mergesAwaitingReleaseWait(
  db: Db,
  input: { mergeShas: readonly string[]; mergedAfter: Date },
): Promise<MergeAwaitingRelease[]> {
  if (input.mergeShas.length === 0) return [];
  const taskOfPr = sql<string | null>`coalesce(
    (select r.task_id from ${runs} r join ${tasks} t on t.id = r.task_id
      where t.repo_id = ${pullRequests.repoId} and r.pr_number = ${pullRequests.number}
      order by r.started_at desc limit 1),
    (select t.id from ${tasks} t
      where t.repo_id = ${pullRequests.repoId} and t.issue_number = any(${pullRequests.issueRefs})
      order by t.created_at desc limit 1)
  )`;
  const rows = await db
    .select({
      repoId: pullRequests.repoId,
      number: pullRequests.number,
      mergedAt: pullRequests.mergedAt,
      mergeSha: pullRequests.mergeSha,
      taskId: taskOfPr,
    })
    .from(pullRequests)
    .where(
      and(
        inArray(pullRequests.mergeSha, [...input.mergeShas]),
        isNotNull(pullRequests.mergedAt),
        gte(pullRequests.mergedAt, input.mergedAfter),
        notExists(
          db
            .select({ one: sql`1` })
            .from(stepTimings)
            .where(
              and(
                eq(stepTimings.kind, 'wait'),
                eq(stepTimings.waitFor, RELEASE_WAIT.waitFor),
                eq(stepTimings.temporalRunId, pullRequests.mergeSha),
              ),
            ),
        ),
      ),
    )
    .orderBy(asc(pullRequests.mergedAt));
  return rows.flatMap((r) =>
    r.mergedAt !== null && r.mergeSha !== null
      ? [
          {
            repoId: r.repoId,
            number: r.number,
            mergedAt: r.mergedAt,
            mergeSha: r.mergeSha,
            taskId: r.taskId ?? null,
          },
        ]
      : [],
  );
}
