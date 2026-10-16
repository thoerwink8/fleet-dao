// 法国工作树的清单和一键清理（#1993）：清单存 worktree_inventory（最近一份覆盖写）；清理的三种操作记录（点了、接手、清完）在
// audit_log、target 是 worktrees。一次清理走到哪由 shared 的 foldCleanupRequests 从这些记录现算，这里只管读写那几行
// （和整理待办 queries/groom.ts、立即探测 queries/route-probe-now.ts 同一个做法：点击本来就要记操作记录，不再存一份状态）。
// 驾驶舱后端点按钮时不经这里（经 Store.appendAudit，带登录人）。
import {
  WORKTREE_ACTION,
  WORKTREE_ENGINE_ACTOR,
  WORKTREE_TARGET,
  type WorktreeAuditRow,
  type WorktreeCleanupResult,
  type WorktreeInventory,
  WorktreeInventorySchema,
} from '@fleet-dao/shared';
import { and, eq, gte, isNotNull, sql } from 'drizzle-orm';
import type { Db } from '../client.ts';
import { auditLog, runs, worktreeInventory } from '../schema/index.ts';
import { recordEngineAudit } from './session-org.ts';

const LATEST = 'latest';

/** 存最近一份清单（覆盖写）。先照 shared 的契约校验：认不出的不存。写不进原样抛。 */
export async function saveWorktreeInventory(db: Db, inventory: WorktreeInventory): Promise<void> {
  const parsed = WorktreeInventorySchema.parse(inventory);
  const takenAt = new Date(parsed.takenAt);
  await db
    .insert(worktreeInventory)
    .values({ key: LATEST, takenAt, payload: parsed })
    .onConflictDoUpdate({ target: worktreeInventory.key, set: { takenAt, payload: parsed } });
}

/** 最近一份清单；一次都没存过是 null。库里那份认不出抛错，不当成没有。 */
export async function readWorktreeInventory(db: Db): Promise<WorktreeInventory | null> {
  const rows = await db.select().from(worktreeInventory).where(eq(worktreeInventory.key, LATEST));
  const row = rows[0];
  if (!row) return null;
  const parsed = WorktreeInventorySchema.safeParse(row.payload);
  if (!parsed.success) {
    throw new Error(`库里那份工作树清单认不出：${parsed.error.issues[0]?.message ?? '形状不对'}`);
  }
  return parsed.data;
}

/** since 之后（含）target=worktrees 的全部操作记录。读不到原样抛。 */
export async function worktreeAuditRows(db: Db, since: Date): Promise<WorktreeAuditRow[]> {
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
    .where(and(eq(auditLog.target, WORKTREE_TARGET), gte(auditLog.at, since)));
}

/** 引擎接手了一次清理。写不进原样抛：没记上就不清。 */
export function recordWorktreeCleanupStart(db: Db, input: { requestId: string; at: Date }): Promise<void> {
  return recordEngineAudit(db, {
    action: WORKTREE_ACTION.start,
    target: WORKTREE_TARGET,
    actorId: WORKTREE_ENGINE_ACTOR,
    after: { requestId: input.requestId },
    ok: true,
    at: input.at,
  });
}

/** 一次清理完了：ok 带删了哪些、拒了哪些；没做成写 error（必填），清了一部分的也带 result。写不进原样抛。 */
export function recordWorktreeCleanupDone(
  db: Db,
  input: { requestId: string; at: Date } & (
    | { ok: true; result: WorktreeCleanupResult }
    | { ok: false; error: string; result?: WorktreeCleanupResult }
  ),
): Promise<void> {
  return recordEngineAudit(db, {
    action: WORKTREE_ACTION.done,
    target: WORKTREE_TARGET,
    actorId: WORKTREE_ENGINE_ACTOR,
    after: { requestId: input.requestId, ...(input.result ? { result: input.result } : {}) },
    ok: input.ok,
    ...(input.ok ? {} : { error: input.error }),
    at: input.at,
  });
}

/** 命令行叫一次清理（fleet-api worktrees clean）：记一条「点了」。写不进原样抛。 */
export function recordWorktreeCleanupRequest(
  db: Db,
  input: { requestId: string; actorId: string; reason: string; at: Date },
): Promise<void> {
  return recordEngineAudit(db, {
    action: WORKTREE_ACTION.request,
    target: WORKTREE_TARGET,
    actorId: input.actorId,
    after: { requestId: input.requestId },
    reason: input.reason,
    ok: true,
    at: input.at,
  });
}

/**
 * 每个目录里最近一次会话的时刻：收场了取收场时刻，没收场取起的时刻（runs 按 worktree_path 取最新）。
 * 清单上写「最近一次会话多久前」：判这棵树多久没人动过，比看目录的修改时间准（在树里改文件不动树根那一层）。
 */
export async function lastSessionByTree(db: Db): Promise<Map<string, Date>> {
  const at = sql<Date>`max(coalesce(${runs.endedAt}, ${runs.startedAt}))`.mapWith(
    (v: string | Date) => new Date(v),
  );
  const rows = await db
    .select({ path: runs.worktreePath, at })
    .from(runs)
    .where(isNotNull(runs.worktreePath))
    .groupBy(runs.worktreePath);
  return new Map(rows.flatMap((r) => (r.path ? [[r.path, r.at] as const] : [])));
}
