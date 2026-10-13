// 资源页「仓库」一节（#1993，母单 #1990）：法国的工作树清单和「清理没用的工作树」按钮。两个口：
// GET  /worktrees：引擎最近一份清单（每个仓的镜像、每棵树的状态和原因）加最近几次一键清理走到哪。
// POST /worktrees/cleanup：叫一次清理。点一下 = 记一条操作记录 worktrees.cleanup.request（target worktrees）；
//   法国引擎每 5 秒看一眼，接手、跑一轮和每小时对账同一份判据的清扫（engine/src/jobs/worktree-cleanup.ts），记结果。
// 改这里之前必须知道：
// - 这里不删任何东西，也不判哪棵能删：判据只在引擎（worktree-sweep.ts），后端读不了会话用户的树（700）。
// - 拒的情况都明说，不记成点过：引擎没开 / 没连上 / 查不成 409 或 503；已经有一次在排队或在做 409 cleanup_busy。
// - 读不到操作记录 → 503 写明没读成；清单认不出 → inventory 是 null、inventoryWhy 写原因，不当成「没有树」。
import { randomUUID } from 'node:crypto';
import {
  activeCleanup,
  foldCleanupRequests,
  WebRoutes,
  WORKTREE_ACTION,
  WORKTREE_LIST_WINDOW_MS,
  WORKTREE_TARGET,
  type WorktreeAuditRow,
  WorktreeCleanupRequestSchema,
  WorktreeCleanupResponseSchema,
  type WorktreeInventory,
  WorktreesResponseSchema,
} from '@fleet-dao/shared';
import { errMessage } from '@fleet-dao/shared/util';
import type { Context, Hono } from 'hono';
import type { Deps } from './deps.ts';
import { ApiError, readJson, reply } from './http.ts';
import type { Actor } from './ports.ts';
import type { CockpitEnv } from './session.ts';

type EngineState = { state: 'on' | 'off' | 'down' | 'unknown'; detail?: string | undefined };

/** 最多翻几页（每页 200 条）：一周清理不过几十次，翻满了明说没读全。 */
const MAX_PAGES = 5;
/** 页面列最近几次。 */
const RECENT = 10;

async function recentRows(deps: Deps, now: Date): Promise<WorktreeAuditRow[]> {
  const since = now.getTime() - WORKTREE_LIST_WINDOW_MS;
  const rows: WorktreeAuditRow[] = [];
  let cursor: string | undefined;
  for (let page = 0; page < MAX_PAGES; page += 1) {
    const got = await deps.store.listAudit({
      target: WORKTREE_TARGET,
      limit: 200,
      ...(cursor ? { cursor } : {}),
    });
    for (const item of got.items) {
      const at = new Date(item.at);
      if (at.getTime() < since) return rows;
      rows.push({
        at,
        action: item.action,
        actorId: item.actor.id,
        after: item.after,
        ok: item.ok,
        error: item.error ?? null,
      });
    }
    cursor = got.nextCursor;
    if (!cursor) return rows;
  }
  throw new Error(`清理工作树的操作记录超过 ${MAX_PAGES} 页没翻完，不拿一部分冒充全部`);
}

function refuseWhenEngineAway(engine: EngineState): void {
  if (engine.state === 'on') return;
  const detail = engine.detail ? `（${engine.detail}）` : '';
  if (engine.state === 'off') {
    throw new ApiError(409, 'engine_off', `清理不了：这台机器的引擎按配置没开${detail}，工作树只有引擎能动`);
  }
  if (engine.state === 'down') {
    throw new ApiError(503, 'engine_down', `清理不了：引擎没连上${detail}，点了也没人接，等引擎起来再点`);
  }
  throw new ApiError(503, 'engine_unknown', `清理不了：没查成引擎在不在${detail}，不敢说点了会有人接`);
}

export function registerWorktreeRoutes(
  app: Hono<CockpitEnv>,
  deps: Deps,
  actorOf: (c: Context<CockpitEnv>) => Actor,
  engineProbe: () => Promise<EngineState>,
): void {
  const { store } = deps;

  const readRequests = async (now: Date) => {
    try {
      const folded = foldCleanupRequests(await recentRows(deps, now), now);
      if (folded.unreadable > 0)
        deps.log.warn('清理工作树：有操作记录认不出', { unreadable: folded.unreadable });
      return folded;
    } catch (err) {
      deps.log.error('清理工作树：操作记录没读成', { error: errMessage(err) });
      throw new ApiError(503, 'worktrees_unreadable', `清理工作树的记录没读成：${errMessage(err)}`);
    }
  };

  app.get(WebRoutes.worktrees.path, async (c) => {
    const now = deps.now();
    const { requests, unreadable } = await readRequests(now);
    let inventory: WorktreeInventory | null = null;
    let inventoryWhy: string | undefined;
    try {
      inventory = await store.getWorktreeInventory();
    } catch (err) {
      deps.log.error('工作树清单没读成', { error: errMessage(err) });
      inventoryWhy = `工作树清单没读成：${errMessage(err)}`;
    }
    return reply(c, WorktreesResponseSchema, {
      inventory,
      ...(inventoryWhy === undefined ? {} : { inventoryWhy }),
      cleanups: requests.slice(0, RECENT).map((r) => ({
        requestId: r.requestId,
        by: r.by,
        requestedAt: r.requestedAt.toISOString(),
        ...(r.startedAt ? { startedAt: r.startedAt.toISOString() } : {}),
        ...(r.doneAt ? { doneAt: r.doneAt.toISOString() } : {}),
        status: r.status,
        ...(r.result ? { result: r.result } : {}),
        ...(r.error === undefined ? {} : { error: r.error }),
      })),
      unreadable,
    });
  });

  app.post(WebRoutes.worktreeCleanup.path, async (c) => {
    const body = await readJson(c, WorktreeCleanupRequestSchema);
    refuseWhenEngineAway(await engineProbe());
    const now = deps.now();
    const { requests } = await readRequests(now);
    const busy = activeCleanup(requests);
    if (busy) {
      const word = busy.status === 'running' ? '在做' : '在排队';
      throw new ApiError(409, 'cleanup_busy', `已经有一次清理${word}（${busy.requestId}），等它做完再点`);
    }
    const requestId = randomUUID();
    await store.appendAudit({
      actor: actorOf(c),
      action: WORKTREE_ACTION.request,
      target: WORKTREE_TARGET,
      after: { requestId },
      reason: body.reason ?? '驾驶舱上点了「清理没用的工作树」',
      via: c.get('via'),
      ok: true,
    });
    return reply(c, WorktreeCleanupResponseSchema, { requestId, requestedAt: now.toISOString() });
  });
}
