// 某个需求的时间线：状态变化、每次会话的排队 / 开工 / 结束、进度、操作记录、通知，按时间排好。
// 全部从 Postgres 读，不靠 Temporal 历史（它只留 30 天）。
import type { ProgressKind } from '@fleet-dao/shared';
import { and, asc, eq, inArray, isNull } from 'drizzle-orm';
import type { Db } from '../client.ts';
import { PROGRESS_KINDS } from '../schema/enums.ts';
import {
  auditLog,
  notifications,
  progressEvents,
  routes,
  sessionRuns,
  stateChanges,
  subtasks,
  tasks,
} from '../schema/index.ts';

type RunRow = typeof sessionRuns.$inferSelect;
type AuditRow = typeof auditLog.$inferSelect;

export interface TimelineRun {
  id: string;
  subtaskId: string | null;
  stage: RunRow['stage'];
  routeId: string;
  modelId: string;
  whyRoute: string;
  branch: string | null;
  queuedAt: Date;
  startedAt: Date | null;
  endedAt: Date | null;
  outcome: RunRow['outcome'];
  /** 排队时长，库算的。 */
  queueMs: number | null;
  /** 干活时长，库算的。 */
  runMs: number | null;
  actualModel: string | null;
  inputTokens: number | null;
  outputTokens: number | null;
  costUsd: number | null;
}

/**
 * 事件按 (at, id) 排好，翻页就按 (at, id) 做游标，同一时刻的几条不会漏。id 在一条时间线里唯一且不变；
 * 数字编号补零、会话三步按 1-queued / 2-started / 3-ended 编，让同一时刻内按字面比较也是写入先后。
 */
export type TimelineEvent = { id: string; at: Date } & (
  | { type: 'state'; entity: 'task' | 'subtask'; entityId: string; from: string | null; to: string }
  | {
      type: 'run-queued';
      runId: string;
      subtaskId: string | null;
      stage: RunRow['stage'];
      routeId: string;
      whyRoute: string;
    }
  | { type: 'run-started'; runId: string; queueMs: number | null }
  | { type: 'run-ended'; runId: string; outcome: NonNullable<RunRow['outcome']>; runMs: number | null }
  | { type: 'progress'; runId: string; kind: ProgressKind; payload: unknown }
  | {
      type: 'audit';
      action: string;
      target: string;
      actorKind: AuditRow['actorKind'];
      actorId: string;
      via: AuditRow['via'];
      reason: string | null;
      ok: boolean;
    }
  | {
      type: 'notification';
      notificationId: string;
      level: (typeof notifications.$inferSelect)['level'];
      title: string;
    }
);

export interface TaskTimeline {
  task: typeof tasks.$inferSelect;
  runs: TimelineRun[];
  /** 按时间正序；同一时刻按写入先后。 */
  events: TimelineEvent[];
}

/** 默认不放量大的动作流（改文件、调工具），它们在「直播」里看。 */
export const DEFAULT_TIMELINE_PROGRESS_KINDS: readonly ProgressKind[] = PROGRESS_KINDS.filter(
  (k) => k !== 'tool' && k !== 'file',
);

export interface TaskTimelineOptions {
  progressKinds?: readonly ProgressKind[];
}

/** 自增编号补零，按字面比较就是按数值比较。 */
const seq = (n: number): string => String(n).padStart(15, '0');

/** 返回 null = 没有这个需求。操作记录按 target 取：task:<需求 id> 和它每个子任务的 subtask:<id>。 */
export async function taskTimeline(
  db: Db,
  taskId: string,
  options: TaskTimelineOptions = {},
): Promise<TaskTimeline | null> {
  const [task] = await db.select().from(tasks).where(eq(tasks.id, taskId));
  if (!task) return null;
  const kinds = [...(options.progressKinds ?? DEFAULT_TIMELINE_PROGRESS_KINDS)];

  const [changes, runRows, subtaskRows, notes] = await Promise.all([
    db.select().from(stateChanges).where(eq(stateChanges.taskId, taskId)).orderBy(asc(stateChanges.id)),
    db
      .select({ run: sessionRuns, modelId: routes.modelId })
      .from(sessionRuns)
      .innerJoin(routes, eq(routes.id, sessionRuns.routeId))
      .where(eq(sessionRuns.taskId, taskId))
      .orderBy(asc(sessionRuns.queuedAt)),
    // 重拆方案作废的子任务不再计入操作记录的 target 范围。
    db
      .select({ id: subtasks.id })
      .from(subtasks)
      .where(and(eq(subtasks.taskId, taskId), isNull(subtasks.supersededAt))),
    db
      .select()
      .from(notifications)
      .where(eq(notifications.taskId, taskId))
      .orderBy(asc(notifications.createdAt)),
  ]);

  const runIds = runRows.map((r) => r.run.id);
  const targets = [`task:${taskId}`, ...subtaskRows.map((s) => `subtask:${s.id}`)];
  const [progress, audits] = await Promise.all([
    runIds.length === 0 || kinds.length === 0
      ? []
      : db
          .select()
          .from(progressEvents)
          .where(and(inArray(progressEvents.runId, runIds), inArray(progressEvents.kind, kinds)))
          .orderBy(asc(progressEvents.id)),
    db.select().from(auditLog).where(inArray(auditLog.target, targets)).orderBy(asc(auditLog.id)),
  ]);

  const runs: TimelineRun[] = runRows.map(({ run, modelId }) => ({
    id: run.id,
    subtaskId: run.subtaskId,
    stage: run.stage,
    routeId: run.routeId,
    modelId,
    whyRoute: run.whyRoute,
    branch: run.branch,
    queuedAt: run.queuedAt,
    startedAt: run.startedAt,
    endedAt: run.endedAt,
    outcome: run.outcome,
    queueMs: run.queueMs,
    runMs: run.runMs,
    actualModel: run.actualModel,
    inputTokens: run.inputTokens,
    outputTokens: run.outputTokens,
    costUsd: run.costUsd,
  }));

  const events: TimelineEvent[] = [];
  for (const c of changes) {
    events.push({
      id: `state:${seq(c.id)}`,
      at: c.at,
      type: 'state',
      entity: c.entity,
      entityId: c.entityId,
      from: c.fromState,
      to: c.toState,
    });
  }
  for (const r of runs) {
    events.push({
      id: `run:${r.id}:1-queued`,
      at: r.queuedAt,
      type: 'run-queued',
      runId: r.id,
      subtaskId: r.subtaskId,
      stage: r.stage,
      routeId: r.routeId,
      whyRoute: r.whyRoute,
    });
    if (r.startedAt) {
      events.push({
        id: `run:${r.id}:2-started`,
        at: r.startedAt,
        type: 'run-started',
        runId: r.id,
        queueMs: r.queueMs,
      });
    }
    if (r.endedAt && r.outcome) {
      events.push({
        id: `run:${r.id}:3-ended`,
        at: r.endedAt,
        type: 'run-ended',
        runId: r.id,
        outcome: r.outcome,
        runMs: r.runMs,
      });
    }
  }
  for (const p of progress) {
    events.push({
      id: `progress:${seq(p.id)}`,
      at: p.at,
      type: 'progress',
      runId: p.runId,
      kind: p.kind,
      payload: p.payload,
    });
  }
  for (const a of audits) {
    events.push({
      id: `audit:${seq(a.id)}`,
      at: a.at,
      type: 'audit',
      action: a.action,
      target: a.target,
      actorKind: a.actorKind,
      actorId: a.actorId,
      via: a.via,
      reason: a.reason,
      ok: a.ok,
    });
  }
  for (const n of notes) {
    events.push({
      id: `notification:${n.id}`,
      at: n.createdAt,
      type: 'notification',
      notificationId: n.id,
      level: n.level,
      title: n.title,
    });
  }
  events.sort((a, b) => a.at.getTime() - b.at.getTime() || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));

  return { task, runs, events };
}
