// 合并后等发版（step_timings 的 wait 行，wait_for = release，决定 0093）：一张单从合并到在法国上线等了多久。
// 这一段不在任务工作流里（工作流合并完就收场，发版是自动发布单元的事），由后端每 5 分钟看一遍发布目录补记：
// 主线最近的提交（自动发布状态文件的 main.commits，新的在前）+ 发布历史（.history，每行 `时间 提交号 事件`），
// 认出每个合并提交第一次随哪一版上线、那一版切上去的时刻，记一笔 started_at = 合并时刻、ended_at = 上线时刻。
// 改这里之前必须知道：
// - 「随哪一版上线」只认主线提交的先后：切上去的那一版在 main.commits 里不比合并提交新（下标不比它小）就是带上了它。合并提交或
//   那一版不在最近 300 个提交里的认不出，不记、不猜（不拿合并时刻和发版时刻比先后顶，回滚到老版本时那样会记错）。
// - 一个合并提交只记一笔（库里按 temporal_run_id = 合并提交去重，db 的 mergesAwaitingReleaseWait 只回还没记过的）。
// - 还没上线的这一轮不记，下一轮再看；读不到发布目录、状态文件这一轮不记，只记日志。
// - 只看 RELEASE_WAIT_LOOKBACK_MS 以内合的 PR：再老的上线时刻早就记过了，或者不在最近的提交里。
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { type Db, mergesAwaitingReleaseWait, RELEASE_WAIT, recordStepTiming } from '@fleet-dao/db';
import { type DeployLagInput, RELEASES_DIR, readDeployLagInput } from './deploy-lag.ts';
import type { Logger } from './ports.ts';

export const RELEASE_WAIT_EVERY_MS = 5 * 60_000;
export const RELEASE_WAIT_LOOKBACK_MS = 7 * 24 * 60 * 60_000;
const RELEASE_EVENTS = new Set(['release', 'rollback', 'auto-rollback']);

/**
 * 这个合并提交第一次随哪一版切上去的时刻：按发布历史从早到晚找第一行切上去的提交在主线上不比它新的。认不出（不在最近的提交里、
 * 还没上线）回 null。commits 是新的在前。
 */
export function firstLiveAt(
  history: string,
  commits: readonly (readonly [string, string])[],
  mergeSha: string,
): string | null {
  const order = new Map(commits.map(([sha], i) => [sha, i]));
  const mergeAt = order.get(mergeSha);
  if (mergeAt === undefined) return null;
  for (const raw of history.split(/\r?\n/)) {
    const [time, sha, event] = raw.trim().split(/\s+/);
    if (!time || !sha || !event || !RELEASE_EVENTS.has(event)) continue;
    const at = order.get(sha);
    if (at === undefined || at > mergeAt) continue;
    if (Number.isNaN(Date.parse(time))) continue;
    return new Date(time).toISOString();
  }
  return null;
}

export interface ReleaseWaitDeps {
  db: Db;
  /** 自动发布的状态（readDeployLagInput 的 state）。 */
  read: () => Pick<DeployLagInput, 'state'>;
  /** 发布历史原文（发布目录的 .history）。 */
  history: () => string;
  now: () => Date;
  log: Logger;
}

/** 看一遍：回这一轮记了几笔；读不到状态文件回 0、记日志。 */
export async function recordReleaseWaitsOnce(deps: ReleaseWaitDeps): Promise<number> {
  const state = deps.read().state;
  if ('error' in state || !state.main) {
    deps.log.warn('合并后等发版：自动发布的状态读不到，这一轮不记', {
      error: 'error' in state ? state.error : '主线头还没读到过',
    });
    return 0;
  }
  const commits = state.main.commits;
  const now = deps.now();
  const merges = await mergesAwaitingReleaseWait(deps.db, {
    mergeShas: commits.map(([sha]) => sha),
    mergedAfter: new Date(now.getTime() - RELEASE_WAIT_LOOKBACK_MS),
  });
  if (merges.length === 0) return 0;
  const history = deps.history();
  let written = 0;
  for (const m of merges) {
    const live = firstLiveAt(history, commits, m.mergeSha);
    if (live === null) continue;
    const endedAt = new Date(live);
    // 发布历史和 GitHub 的钟差几秒、合并时刻比切上去还晚的：记 0，不记成负的
    const startedAt = m.mergedAt.getTime() <= endedAt.getTime() ? m.mergedAt : endedAt;
    const r = await recordStepTiming(deps.db, {
      kind: 'wait',
      workflowId: RELEASE_WAIT.workflowId,
      temporalRunId: m.mergeSha,
      workflowType: RELEASE_WAIT.workflowType,
      waitFor: RELEASE_WAIT.waitFor,
      detail: `PR #${m.number} 合并后等发版，随 ${m.mergeSha.slice(0, 12)} 起的那一版上线`,
      ...(m.taskId ? { taskId: m.taskId } : {}),
      startedAt,
      endedAt,
      waitMs: endedAt.getTime() - startedAt.getTime(),
    });
    if (r === 'written') written += 1;
  }
  return written;
}

/** 正式环境才有发布目录：每 5 分钟看一遍。库写不进、读不到只记日志，下一轮再来。返回停止的函数。 */
export function startReleaseWaitWatch(deps: {
  db: Db;
  now: () => Date;
  log: Logger;
  dir?: string;
  everyMs?: number;
}): () => void {
  const dir = deps.dir ?? RELEASES_DIR;
  const once: ReleaseWaitDeps = {
    db: deps.db,
    read: () => readDeployLagInput(dir),
    history: () => readFileSync(join(dir, '.history'), 'utf8'),
    now: deps.now,
    log: deps.log,
  };
  let running = false;
  const tick = async () => {
    if (running) return;
    running = true;
    try {
      await recordReleaseWaitsOnce(once);
    } catch (err) {
      deps.log.warn('合并后等发版：这一轮没记成', { error: String(err) });
    } finally {
      running = false;
    }
  };
  void tick();
  const timer = setInterval(() => void tick(), deps.everyMs ?? RELEASE_WAIT_EVERY_MS);
  timer.unref?.();
  return () => clearInterval(timer);
}
