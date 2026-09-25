// 看板树：某个仓的需求 → 子任务 → PR，带每一层正在跑的会话、步骤进度和「进入当前状态多久了」。
import { and, asc, desc, eq, inArray, isNull, max } from 'drizzle-orm';
import type { Db } from '../client.ts';
import { TERMINAL_TASK_STATES } from '../schema/enums.ts';
import {
  models,
  progressEvents,
  repos,
  routes,
  sessionRuns,
  stateChanges,
  subtaskDeps,
  subtasks,
  tasks,
} from '../schema/index.ts';

export interface BoardProgress {
  done: number;
  total: number;
  /** 进行中那一步的白话；没有进行中的步就是空。 */
  current: string | null;
}

export interface BoardRun {
  id: string;
  stage: (typeof sessionRuns.$inferSelect)['stage'];
  routeId: string;
  modelId: string;
  modelName: string;
  hostId: (typeof routes.$inferSelect)['hostId'];
  queuedAt: Date;
  /** 还在排队就是空。 */
  startedAt: Date | null;
  /** 最后一条进度的时间；沉默太久就该催。 */
  lastProgressAt: Date | null;
  /** 按最近一次 fleet plan 的步骤清单算；还没报过步骤就是空。 */
  progress: BoardProgress | null;
}

export interface BoardSubtask {
  id: string;
  index: number;
  title: string;
  state: (typeof subtasks.$inferSelect)['state'];
  /** 进入当前状态的时刻：超时从这里算，不从开单算。 */
  stateSince: Date | null;
  touches: string[];
  dependsOn: string[];
  waitingOn: string | null;
  pr: { number: number; url: string } | null;
  run: BoardRun | null;
}

export interface BoardTask {
  id: string;
  issueNumber: number;
  issueUrl: string;
  title: string;
  state: (typeof tasks.$inferSelect)['state'];
  stateSince: Date | null;
  priority: number;
  requestedBy: string;
  specDir: string | null;
  createdAt: Date;
  /** 需求级的会话（分诊、写需求、写方案）。 */
  run: BoardRun | null;
  subtasks: BoardSubtask[];
}

export interface RepoBoard {
  repo: { id: string; owner: string; name: string };
  tasks: BoardTask[];
}

export interface RepoBoardOptions {
  /** 在这个时刻之前就已进入终态（完成、叫停、失败）的需求不列。不传就全列。 */
  hideTerminalBefore?: Date;
}

/** 从 plan 事件的载荷（{ steps: Step[] }）算进度；形状不对的步骤跳过。 */
export function planProgress(payload: unknown): BoardProgress | null {
  const raw =
    typeof payload === 'object' && payload !== null ? (payload as { steps?: unknown }).steps : undefined;
  if (!Array.isArray(raw)) return null;
  const steps = raw.filter(
    (s): s is { title: string; state: string } =>
      typeof s === 'object' && s !== null && typeof s.title === 'string' && typeof s.state === 'string',
  );
  return {
    done: steps.filter((s) => s.state === 'done').length,
    total: steps.length,
    current: steps.find((s) => s.state === 'in_progress')?.title ?? null,
  };
}

/** 返回 null = 没有这个仓。 */
export async function repoBoard(
  db: Db,
  repoId: string,
  options: RepoBoardOptions = {},
): Promise<RepoBoard | null> {
  const [repo] = await db.select().from(repos).where(eq(repos.id, repoId));
  if (!repo) return null;

  const taskRows = await db
    .select()
    .from(tasks)
    .where(eq(tasks.repoId, repoId))
    .orderBy(asc(tasks.priority), asc(tasks.createdAt));
  const taskIds = taskRows.map((t) => t.id);
  if (taskIds.length === 0) return { repo: { id: repo.id, owner: repo.owner, name: repo.name }, tasks: [] };

  const [latestStates, subtaskRows, depRows, openRuns] = await Promise.all([
    // 最近一次变化按写入先后（id）取，不按时间戳取：状态的先后顺序以写入为准。
    db
      .selectDistinctOn([stateChanges.entityId], { entityId: stateChanges.entityId, at: stateChanges.at })
      .from(stateChanges)
      .where(inArray(stateChanges.taskId, taskIds))
      .orderBy(stateChanges.entityId, desc(stateChanges.id)),
    // 重拆方案作废的子任务（superseded_at 非空）不上看板：它们的 index 可能和现役子任务重复。
    db
      .select()
      .from(subtasks)
      .where(and(inArray(subtasks.taskId, taskIds), isNull(subtasks.supersededAt)))
      .orderBy(asc(subtasks.taskId), asc(subtasks.index)),
    db.select().from(subtaskDeps).where(inArray(subtaskDeps.taskId, taskIds)),
    db
      .select({ run: sessionRuns, route: routes, model: models })
      .from(sessionRuns)
      .innerJoin(routes, eq(routes.id, sessionRuns.routeId))
      .innerJoin(models, eq(models.id, routes.modelId))
      .where(and(inArray(sessionRuns.taskId, taskIds), isNull(sessionRuns.endedAt)))
      .orderBy(desc(sessionRuns.queuedAt)),
  ]);

  const runIds = openRuns.map((r) => r.run.id);
  const [plans, lastProgress] =
    runIds.length === 0
      ? [[], []]
      : await Promise.all([
          db
            .selectDistinctOn([progressEvents.runId], {
              runId: progressEvents.runId,
              payload: progressEvents.payload,
            })
            .from(progressEvents)
            .where(and(inArray(progressEvents.runId, runIds), eq(progressEvents.kind, 'plan')))
            .orderBy(progressEvents.runId, desc(progressEvents.at), desc(progressEvents.id)),
          db
            .select({ runId: progressEvents.runId, at: max(progressEvents.at) })
            .from(progressEvents)
            .where(inArray(progressEvents.runId, runIds))
            .groupBy(progressEvents.runId),
        ]);

  const stateSince = new Map(latestStates.map((s) => [s.entityId, s.at]));
  const planByRun = new Map(plans.map((p) => [p.runId, planProgress(p.payload)]));
  const lastProgressByRun = new Map(lastProgress.map((p) => [p.runId, p.at]));
  const depsBySubtask = new Map<string, string[]>();
  for (const d of depRows)
    depsBySubtask.set(d.subtaskId, [...(depsBySubtask.get(d.subtaskId) ?? []), d.dependsOnId]);

  // 每个需求 / 子任务取最新排进来的那个未结束会话（openRuns 已按排队时间倒序）。
  const runByOwner = new Map<string, BoardRun>();
  for (const { run, route, model } of openRuns) {
    const owner = run.subtaskId ?? run.taskId;
    if (owner === null || runByOwner.has(owner)) continue;
    runByOwner.set(owner, {
      id: run.id,
      stage: run.stage,
      routeId: route.id,
      modelId: model.id,
      modelName: model.displayName,
      hostId: route.hostId,
      queuedAt: run.queuedAt,
      startedAt: run.startedAt,
      lastProgressAt: lastProgressByRun.get(run.id) ?? null,
      progress: planByRun.get(run.id) ?? null,
    });
  }

  const repoUrl = `https://github.com/${repo.owner}/${repo.name}`;
  const hideBefore = options.hideTerminalBefore;
  const terminal: readonly string[] = TERMINAL_TASK_STATES;

  const boardTasks = taskRows
    .filter((t) => {
      if (!hideBefore || !terminal.includes(t.state)) return true;
      const since = stateSince.get(t.id) ?? t.createdAt;
      return since.getTime() >= hideBefore.getTime();
    })
    .map(
      (t): BoardTask => ({
        id: t.id,
        issueNumber: t.issueNumber,
        issueUrl: `${repoUrl}/issues/${t.issueNumber}`,
        title: t.title,
        state: t.state,
        stateSince: stateSince.get(t.id) ?? null,
        priority: t.priority,
        requestedBy: t.requestedBy,
        specDir: t.specDir,
        createdAt: t.createdAt,
        run: runByOwner.get(t.id) ?? null,
        subtasks: subtaskRows
          .filter((s) => s.taskId === t.id)
          .map(
            (s): BoardSubtask => ({
              id: s.id,
              index: s.index,
              title: s.title,
              state: s.state,
              stateSince: stateSince.get(s.id) ?? null,
              touches: s.touches,
              dependsOn: depsBySubtask.get(s.id) ?? [],
              waitingOn: s.waitingOn,
              pr: s.prNumber === null ? null : { number: s.prNumber, url: `${repoUrl}/pull/${s.prNumber}` },
              run: runByOwner.get(s.id) ?? null,
            }),
          ),
      }),
    );

  return { repo: { id: repo.id, owner: repo.owner, name: repo.name }, tasks: boardTasks };
}
