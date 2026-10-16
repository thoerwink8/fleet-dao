// 一键清理没用的工作树（#1993，母单 #1990）和工作树清单。
// 驾驶舱的按钮、命令行都只记一条 worktrees.cleanup.request（shared/web-api/worktrees.ts）；这里每几秒看一眼，有排队的就接手：
// 记 worktrees.cleanup.start → 跑一轮和每小时对账**同一个**清扫（worktree-sweep.ts 的 sweepWorktrees：没人用的树都删，剩着没推的提交、
// 没提交的改动也删——AI 产生的树，决定 0097、#2729；在跑的任务、没结束的会话在用的、认不出的、人以前点过留着的不删）→ 存清单 → 记 worktrees.cleanup.done
// （删了哪些、拒了哪些、为什么）。每小时对账那一轮也调 inventoryOf 存一份清单（jobs/hourly-reconcile.ts）。
//
// 改这里之前必须知道：
// - 判据只在 sweepWorktrees 里一处，这里不另写一套；「拒删」就是清单上还留着的树，原因照抄清单上的那一句。
// - 同一时刻只一个：有一次在做（start 了还没 done、没过 WORKTREE_RUN_TTL_MS）就不接第二次；点了超过 WORKTREE_REQUEST_TTL_MS
//   没人接的作废、不接（引擎停了一夜，起来不把隔夜点的全跑一遍）。
// - 记「接手」写不进就不清（不然页面一直看到没人接手、下一眼又接一次）。树清了、清单存不进库，结果记 ok=false 写明，不当成做成了。
import type { AlertRow } from '@fleet-dao/db';
import {
  activeCleanup,
  foldCleanupRequests,
  WORKTREE_LIST_WINDOW_MS,
  WORKTREE_POLL_MS,
  type WorktreeAuditRow,
  type WorktreeCleanupResult,
  type WorktreeInventory,
} from '@fleet-dao/shared';
import { errMessage } from '@fleet-dao/shared/util';
import type { SweepWithInventory, WorktreeSweepDeps } from './worktree-sweep.ts';
import { sweepWorktrees } from './worktree-sweep.ts';

export interface WorktreeCleanupDeps {
  /** 每次接手现拿一份（和每小时对账同一份装配）。 */
  sweep(): WorktreeSweepDeps;
  /** since 之后 target=worktrees 的操作记录。读不到照抛。 */
  rows(since: Date): Promise<WorktreeAuditRow[]>;
  recordStart(input: { requestId: string; at: Date }): Promise<void>;
  recordDone(
    input: { requestId: string; at: Date } & (
      | { ok: true; result: WorktreeCleanupResult }
      | { ok: false; error: string; result?: WorktreeCleanupResult }
    ),
  ): Promise<void>;
  saveInventory(inventory: WorktreeInventory): Promise<void>;
  /** 没处理的提醒（树的去向定了顺手撤和树有关的提醒）；列不成回 null，树照清。 */
  openAlerts(): Promise<AlertRow[] | null>;
  now(): Date;
  log(level: 'info' | 'warn' | 'error', message: string, fields?: Record<string, unknown>): void;
}

/** 一轮清扫的结果 → 整份清单。 */
export function inventoryOf(
  part: SweepWithInventory,
  meta: { trigger: WorktreeInventory['trigger']; at: Date; root: string },
): WorktreeInventory {
  return {
    takenAt: meta.at.toISOString(),
    trigger: meta.trigger,
    root: meta.root,
    trees: part.inventory.trees,
    removed: part.inventory.removed,
    repos: part.inventory.repos,
    ...(part.failed ? { failed: part.failed } : {}),
    unchecked: part.unchecked.filter((u) => u !== ''),
  };
}

/** 清单 → 一次清理的结果：删了的照列；还留着的树都是拒删，原因照抄清单。 */
export function cleanupResultOf(inv: WorktreeInventory): WorktreeCleanupResult {
  return {
    removed: inv.removed,
    refused: inv.trees.map((t) => ({ tree: `${dirOf(t.repo)}/${t.tree}`, state: t.state, why: t.why })),
    unchecked: inv.unchecked,
  };
}

/** owner/name → 工作树的根下那一层的名字 owner_name。 */
const dirOf = (slug: string) => slug.replace('/', '_');

/** 看一眼：有排队的就接手跑一次。idle = 没有要做的；done = 清了；failed = 接手了但没做成（已记）或接手没记上。 */
export async function runWorktreeCleanupRequests(
  deps: WorktreeCleanupDeps,
): Promise<'idle' | 'done' | 'failed'> {
  const now = deps.now();
  const rows = await deps.rows(new Date(now.getTime() - WORKTREE_LIST_WINDOW_MS));
  const { requests, unreadable } = foldCleanupRequests(rows, now);
  if (unreadable > 0) deps.log('warn', '工作树清理：操作记录里有认不出的', { unreadable });
  const active = activeCleanup(requests);
  // 在做的（另一个进程接了、还没回）不接；只接排队的里最早那一次
  if (!active || active.status !== 'queued') return 'idle';
  const requestId = active.requestId;
  try {
    await deps.recordStart({ requestId, at: deps.now() });
  } catch (err) {
    deps.log('error', '工作树清理：记接手没成，这次不清', { requestId, error: errMessage(err) });
    return 'failed';
  }
  const sweep = deps.sweep();
  let part: SweepWithInventory;
  try {
    let alerts: AlertRow[] | null = null;
    try {
      alerts = await deps.openAlerts();
    } catch (err) {
      deps.log('warn', '工作树清理：列没处理的提醒没成，树照清', { error: errMessage(err) });
    }
    part = await sweepWorktrees(sweep, alerts);
  } catch (err) {
    await done(deps, { requestId, ok: false, error: `清扫没跑成：${errMessage(err)}` });
    return 'failed';
  }
  const inv = inventoryOf(part, { trigger: 'cleanup', at: deps.now(), root: sweep.root });
  const result = cleanupResultOf(inv);
  if (part.failed) {
    await done(deps, { requestId, ok: false, error: part.failed, result });
    return 'failed';
  }
  try {
    await deps.saveInventory(inv);
  } catch (err) {
    await done(deps, {
      requestId,
      ok: false,
      error: `树清了，但清单没存成（页面上还是上一份）：${errMessage(err)}`,
      result,
    });
    return 'failed';
  }
  deps.log('info', '工作树清理：清完了', {
    requestId,
    removed: result.removed.length,
    refused: result.refused.length,
  });
  await done(deps, { requestId, ok: true, result });
  return 'done';
}

/** 记「清完」；写不进只记日志（页面过 WORKTREE_RUN_TTL_MS 会把它标成没做成）。 */
async function done(
  deps: WorktreeCleanupDeps,
  input: { requestId: string } & (
    | { ok: true; result: WorktreeCleanupResult }
    | { ok: false; error: string; result?: WorktreeCleanupResult }
  ),
): Promise<void> {
  try {
    await deps.recordDone({ ...input, at: deps.now() });
  } catch (err) {
    deps.log('error', '工作树清理：记清完没成', { requestId: input.requestId, error: errMessage(err) });
  }
}

export interface WorktreeCleanupPoller {
  stop(): void;
}

/** 每 WORKTREE_POLL_MS 看一眼；上一眼没看完不叠着看。 */
export function startWorktreeCleanupRequests(
  deps: () => WorktreeCleanupDeps,
  options: { everyMs?: number } = {},
): WorktreeCleanupPoller {
  let running: Promise<void> | null = null;
  let stopped = false;
  const tick = () => {
    if (stopped || running) return;
    const d = deps();
    running = runWorktreeCleanupRequests(d)
      .then(() => undefined)
      .catch((err: unknown) => d.log('error', '工作树清理：这一眼没看成', { error: errMessage(err) }))
      .finally(() => {
        running = null;
      });
  };
  const handle = setInterval(tick, options.everyMs ?? WORKTREE_POLL_MS);
  return {
    stop() {
      stopped = true;
      clearInterval(handle);
    },
  };
}
