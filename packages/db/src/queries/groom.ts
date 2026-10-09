// 临时指挥官整理待办（母单 #1335 第 3 片，#1338）的三种操作记录：入口记「点了」(groom.request)，引擎记「接手」(groom.start) 和「整理完」
// (groom.done)，都在 audit_log、target 是 groom。一次整理走到哪由 shared 的 foldGroomRequests 从这些记录现算，这里只管读写那几行。
// 没加表：点击本来就要记操作记录，再存一份状态就是同一件事两本账（和立即探测同一个做法，queries/route-probe-now.ts）。
// 驾驶舱后端点按钮时不经这里（经 Store.appendAudit，带登录人），引擎自己叫和命令行叫经这里。
import {
  GROOM_ACTION,
  GROOM_AUTO_ACTOR,
  GROOM_ENGINE_ACTOR,
  GROOM_TARGET,
  type GroomAuditRow,
  type GroomResult,
  type GroomSource,
} from '@fleet-dao/shared';
import { and, desc, eq, gte, inArray, isNull } from 'drizzle-orm';
import type { Db } from '../client.ts';
import { auditLog, notifications, repos, tasks } from '../schema/index.ts';
import { recordEngineAudit } from './session-org.ts';

/** 还停着等人的任务，带上还开着的提醒正文（新的在前）。读不到原样抛，调用方记没查成，不许换成空数组。 */
export interface GroomParkedTaskRow {
  issue: number;
  state: string;
  doing: string | null;
  /** 还开着的提醒正文，新的在前。整理只认第一条非空的：那是现在这次停下的原因。 */
  alertBodies: string[];
}

/**
 * 这个仓里 state 为 stalled 的任务，外加每条还开着的提醒正文（新的在前）。
 * 仓不在库里、一张 stalled 都没有，回空数组（读到了）。库出错原样抛。
 */
export async function groomParkedTasks(
  db: Db,
  repo: { owner: string; name: string },
): Promise<GroomParkedTaskRow[]> {
  const parked = await db
    .select({
      id: tasks.id,
      issue: tasks.issueNumber,
      state: tasks.state,
      doing: tasks.doing,
    })
    .from(tasks)
    .innerJoin(repos, eq(repos.id, tasks.repoId))
    .where(and(eq(repos.owner, repo.owner), eq(repos.name, repo.name), eq(tasks.state, 'stalled')));
  if (parked.length === 0) return [];
  const alerts = await db
    .select({
      taskId: notifications.taskId,
      body: notifications.body,
    })
    .from(notifications)
    .where(
      and(
        inArray(
          notifications.taskId,
          parked.map((row) => row.id),
        ),
        isNull(notifications.resolvedAt),
      ),
    )
    .orderBy(desc(notifications.updatedAt), desc(notifications.createdAt), desc(notifications.id));
  const bodies = new Map<string, string[]>();
  for (const alert of alerts) {
    if (alert.taskId === null) continue;
    const list = bodies.get(alert.taskId) ?? [];
    list.push(alert.body);
    bodies.set(alert.taskId, list);
  }
  return parked
    .map((row) => ({
      issue: row.issue,
      state: row.state,
      doing: row.doing,
      alertBodies: bodies.get(row.id) ?? [],
    }))
    .sort((a, b) => a.issue - b.issue);
}

/** since 之后（含）target=groom 的全部操作记录。读不到原样抛（调用方写「没查成」，不当没人点过）。 */
export async function groomAuditRows(db: Db, since: Date): Promise<GroomAuditRow[]> {
  return db
    .select({
      at: auditLog.at,
      action: auditLog.action,
      actorId: auditLog.actorId,
      after: auditLog.after,
      ok: auditLog.ok,
      error: auditLog.error,
    })
    .from(auditLog)
    .where(and(eq(auditLog.target, GROOM_TARGET), gte(auditLog.at, since)));
}

/**
 * 引擎自己叫（auto）或命令行叫（cli）记一条「点了」。actorId：自动叫记 engine:intake，命令行叫记 ops:groom（reason 里写谁跑的）。
 * 判能不能叫在调用方（shared 的 judgeGroomRequest），这里只写。写不进原样抛。
 */
export function recordGroomRequest(
  db: Db,
  input: { requestId: string; repo: string; source: GroomSource; reason: string; at: Date },
): Promise<void> {
  return recordEngineAudit(db, {
    action: GROOM_ACTION.request,
    target: GROOM_TARGET,
    actorId: input.source === 'auto' ? GROOM_AUTO_ACTOR : 'ops:groom',
    after: { requestId: input.requestId, repo: input.repo, source: input.source },
    reason: input.reason,
    ok: true,
    at: input.at,
  });
}

/** 引擎接手了一次整理。写不进原样抛：没记上就不整理（不然页面一直看到没人接手，引擎下一眼又接一次）。 */
export function recordGroomStart(
  db: Db,
  input: { requestId: string; repo: string; at: Date },
): Promise<void> {
  return recordEngineAudit(db, {
    action: GROOM_ACTION.start,
    target: GROOM_TARGET,
    actorId: GROOM_ENGINE_ACTOR,
    after: { requestId: input.requestId, repo: input.repo },
    ok: true,
    at: input.at,
  });
}

/** 一次整理完了：ok 带做成了什么；没跑成写 error（必填），已经做了一部分的也带 result。写不进原样抛。 */
export function recordGroomDone(
  db: Db,
  input: { requestId: string; repo: string; at: Date } & (
    | { ok: true; result: GroomResult }
    | { ok: false; error: string; result?: GroomResult }
  ),
): Promise<void> {
  return recordEngineAudit(db, {
    action: GROOM_ACTION.done,
    target: GROOM_TARGET,
    actorId: GROOM_ENGINE_ACTOR,
    after: {
      requestId: input.requestId,
      repo: input.repo,
      ...(input.result ? { result: input.result } : {}),
    },
    ok: input.ok,
    ...(input.ok ? {} : { error: input.error }),
    at: input.at,
  });
}
