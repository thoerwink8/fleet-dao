// 任务工作流的「每一轮动手前并最新主线」（#1246）：任务分支已经推上去过（第 2 轮起），动手会话起之前把最新主线并进来，
// 冲突在这时就看到，不拖到推分支才发现；任务动手一轮常要 30 分钟，期间主线合进别人的改动，后面的 CI 和验收不在旧底子上跑。
//
// 改这里之前必须知道：
// - 这是工作流代码，会被重放：新加的这一步活动（syncMainline）用 patched() 守住，老历史第 2 轮动手前没有它（test/replay.test.ts 的 task-reworked 夹具）。
// - 复用等 CI 那一段同一个 syncMainline 活动（并、推、把会话的树快进到新头），不另写一份 git 代码。
// - 这一步只尽力而为：没查成（读不到主线、头被别人动过、树里有没推的提交……）记进 lastProblem 和日志、照旧往下走，不停下等人、
//   不当成已经是最新；真正的把关还是推分支时并主线（pushBranch）和等 CI 遇冲突时并主线。
// - 冲突不自己解、不新造停下状态：冲突文件名进返工意见，由这一轮的动手会话解（走现有的「回动手」带意见的路）。
// - 验收（冷调用）开始前不并：并了头就变、验收白跑。

import { isCancellation, log, patched } from '@temporalio/workflow';
import type { TaskRuntime } from './task-runtime.ts';
import { Abandoned } from './task-support.ts';

/** 没查成时写进 lastProblem 的前缀：之后并成功了认这个前缀把它清掉，不动别的原因。 */
export const SYNC_UNREAD = '动手前并最新主线没查成';

/** 并出冲突时进返工意见的那一句（并上最新主线的冲突，文件名逐个列）。 */
export function conflictFeedback(files: readonly string[], mainlineStale?: string): string {
  const line = `和最新主线有冲突，要解决：${files.join('、') || '（没读到冲突文件名）'}`;
  // 最新主线没能取进会话的树（#1249）：明说树里的主线是旧的，会话先自己取到新主线再 git merge，不能当成已经是最新
  return mainlineStale === undefined
    ? line
    : `${line}。注意：树里的主线是旧的（最新主线没能取进来：${mainlineStale}），先自己取到最新主线再 git merge`;
}

/** 回 'skipped'＝没到并的时候（还没推过）；'merged' / 'current' / 'conflict' / 'unread' 是并的结果，测试看。 */
export type SyncBeforeImplement = 'skipped' | 'merged' | 'current' | 'conflict' | 'unread';

export async function syncMainlineBeforeImplement(rt: TaskRuntime): Promise<SyncBeforeImplement> {
  const wt = rt.worktree;
  const head = rt.head;
  const prNumber = rt.prNumber;
  // 第 1 轮（树刚从最新主线切出来、什么都没推过）没有可并的：分支不在远端
  if (!wt || head === null || prNumber === null) return 'skipped';
  // 老历史重放：第 2 轮动手前没有这一步
  if (!patched('sync-mainline-before-implement')) return 'skipped';
  try {
    const sync = await rt.acts.syncMainline({
      taskId: rt.input.taskId,
      repo: rt.input.repo,
      prNumber,
      branch: rt.branch,
      head,
      worktreePath: wt.path,
    });
    if (sync.state === 'conflict') {
      const line = conflictFeedback(sync.conflictFiles, sync.mainlineStale);
      if (!rt.feedback.includes(line)) rt.feedback = [...rt.feedback, line];
      rt.status.lastProblem = '和主线有冲突';
      return 'conflict';
    }
    const merged = sync.head !== head;
    rt.head = sync.head;
    // 工作树此时已快进到 sync.head：交付核对的起点跟着换，引擎自己并进来的合并提交不算会话的提交（#1582）。老历史没有这个标记。
    if (merged && patched('since-follows-sync')) rt.since = sync.head;
    if (rt.status.lastProblem?.startsWith(SYNC_UNREAD)) rt.status.lastProblem = null;
    return merged ? 'merged' : 'current';
  } catch (error) {
    if (error instanceof Abandoned || isCancellation(error)) throw error;
    const why = String(
      (error as { cause?: { message?: string } })?.cause?.message ?? (error as Error)?.message ?? error,
    );
    log.warn('动手前并最新主线没查成，照旧往下走', { error: why });
    rt.status.lastProblem = `${SYNC_UNREAD}（照旧往下走）：${why.slice(0, 200)}`;
    return 'unread';
  }
}
