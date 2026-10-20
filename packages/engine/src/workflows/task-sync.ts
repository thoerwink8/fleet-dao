// 任务工作流的「每一轮动手前并最新主线」（#1246）：任务分支已经推上去过（第 2 轮起），动手会话起之前把最新主线并进来，
// 冲突在这时就看到，不拖到推分支才发现；任务动手一轮常要 30 分钟，期间主线合进别人的改动，后面的 CI 和验收不在旧底子上跑。
//
// 改这里之前必须知道：
// - 这是工作流代码，会被重放：新加的这一步活动（syncMainline）用 patched() 守住，老历史第 2 轮动手前没有它（test/replay.test.ts 的 task-reworked 夹具）。
// - 复用等 CI 那一段同一个 syncMainline 活动（并、推、把会话的树快进到新头），不另写一份 git 代码。
// - 这一步只尽力而为：没查成（读不到主线、头被别人动过、树里有没推的提交……）记进 lastProblem 和日志、照旧往下走，不停下等人、
//   不当成已经是最新；真正的把关还是推分支时并主线（pushBranch）和等 CI 遇冲突时并主线。
// - 冲突不新造停下状态：冲突文件名进返工意见，由这一轮的动手会话解（走现有的「回动手」带意见的路）。
//   例外是 syncMainlineBeforeImplement 里的机械解（#3428）：冲突文件全在机械可解名单里就由活动 resolveConflictMechanically 解开、
//   自测、推上去，不派会话；解不了或只解了一部分，原因进意见。
// - 验收（冷调用）开始前不并：并了头就变、验收白跑。

import { isCancellation, log, patched } from '@temporalio/workflow';
import type { SyncResult } from '../decisions/types.ts';
import type { ResolveConflictResult } from '../task-contract.ts';
import type { TaskRuntime } from './task-runtime.ts';
import { Abandoned, MergedTask } from './task-support.ts';

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

/**
 * 冲突文件全在机械可解名单里时引擎自己解（#3428，patched('mechanical-conflict-resolve')，活动 resolveConflictMechanically）：
 * 解开自测过推上去了，当作并干净了（'merged'，mechanicalNote 写怎么解的）；没解成或只解了一部分，原因进返工意见交给会话。
 * mechanical 由调用方按「上一轮因冲突返工、自己并的次数没到上限」定：机械解和自己并共用 MAX_MAIN_SYNCS 那个上限。
 */
export async function syncMainlineBeforeImplement(
  rt: TaskRuntime,
  opts: { mechanical?: boolean },
): Promise<{ result: SyncBeforeImplement; mechanicalNote?: string }> {
  const wt = rt.worktree;
  const head = rt.head;
  const prNumber = rt.prNumber;
  // 第 1 轮（树刚从最新主线切出来、什么都没推过）没有可并的：分支不在远端
  if (!wt || head === null || prNumber === null) return { result: 'skipped' };
  // 老历史重放：第 2 轮动手前没有这一步
  if (!patched('sync-mainline-before-implement')) return { result: 'skipped' };
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
      let line = conflictFeedback(sync.conflictFiles, sync.mainlineStale);
      // 树里的主线是旧的就别动手解：机械解要的是已经取进树里的最新主线
      if (opts.mechanical && sync.mainlineStale === undefined && patched('mechanical-conflict-resolve')) {
        const got = await tryMechanicalResolve(rt, wt.path, prNumber, head, sync.conflictFiles);
        if (got.state === 'resolved') {
          rt.head = got.head;
          if (patched('since-follows-sync')) rt.since = got.head;
          if (rt.status.lastProblem?.startsWith(SYNC_UNREAD)) rt.status.lastProblem = null;
          return { result: 'merged', mechanicalNote: got.note };
        }
        if (got.reason !== '') line = `${line}。${got.reason}`;
      }
      if (!rt.feedback.includes(line)) rt.feedback = [...rt.feedback, line];
      rt.status.lastProblem = '和主线有冲突';
      return { result: 'conflict' };
    }
    const merged = sync.head !== head;
    rt.head = sync.head;
    // 工作树此时已快进到 sync.head：交付核对的起点跟着换，引擎自己并进来的合并提交不算会话的提交（#1582）。老历史没有这个标记。
    if (merged && patched('since-follows-sync')) rt.since = sync.head;
    if (rt.status.lastProblem?.startsWith(SYNC_UNREAD)) rt.status.lastProblem = null;
    return { result: merged ? 'merged' : 'current' };
  } catch (error) {
    if (error instanceof Abandoned || error instanceof MergedTask || isCancellation(error)) throw error;
    const why = String(
      (error as { cause?: { message?: string } })?.cause?.message ?? (error as Error)?.message ?? error,
    );
    log.warn('动手前并最新主线没查成，照旧往下走', { error: why });
    rt.status.lastProblem = `${SYNC_UNREAD}（照旧往下走）：${why.slice(0, 200)}`;
    return { result: 'unread' };
  }
}

/** 机械解：活动本身不抛业务失败（回 declined）；真抛了（没装、读不到树……）当没解成，原因写进意见，不挡会话去解。 */
async function tryMechanicalResolve(
  rt: TaskRuntime,
  worktreePath: string,
  prNumber: number,
  head: string,
  conflictFiles: string[],
): Promise<ResolveConflictResult> {
  try {
    return await rt.acts.resolveConflictMechanically({
      schemaVersion: 1,
      taskId: rt.input.taskId,
      repo: rt.input.repo,
      prNumber,
      branch: rt.branch,
      head,
      worktreePath,
      conflictFiles,
    });
  } catch (error) {
    if (error instanceof Abandoned || error instanceof MergedTask || isCancellation(error)) throw error;
    const why = String(
      (error as { cause?: { message?: string } })?.cause?.message ?? (error as Error)?.message ?? error,
    );
    log.warn('机械解冲突没做成，交给会话', { error: why });
    return { state: 'declined', reason: `引擎机械解冲突没做成（${why.slice(0, 200)}）` };
  }
}

/**
 * 等合并时发现 PR 和主线冲突（#1838）：并最新主线，和等 CI 遇冲突时走同一条路（复用同一个 syncMainline 活动）。
 * 这个函数只在 armAndWaitMerged 的 patched('merge-wait-conflict') 那一支里调，老历史重放走不到，不另加标记。
 * - 'merged'：真并上了新的主线（头是引擎自己换的）：调用方回 head_moved，对新头重走 CI 和验收。
 * - 'conflict'：真有冲突，冲突文件名进返工意见：调用方回 'rework'，交回会话解（走现有的「回动手」带意见的路）。
 * - 'current'：分支本来就含最新主线、没什么可并，GitHub 却还说冲突（它的数据是旧的）：调用方接着等它重算。
 * 每调一次记一次 rt.mainSyncs（和「落后主线自动同步」同一个计数）：调用方拿它兜底，不无限转。
 */
export async function syncMainlineOnConflict(
  rt: TaskRuntime,
  head: string,
): Promise<'merged' | 'conflict' | 'current'> {
  const prNumber = rt.prNumber;
  if (prNumber === null) throw new Error('并主线之前还没有 PR');
  rt.mainSyncs += 1;
  const sync: SyncResult = await rt.step('syncMainline', () =>
    rt.acts.syncMainline({
      taskId: rt.input.taskId,
      repo: rt.input.repo,
      prNumber,
      branch: rt.branch,
      head,
      ...(rt.worktree ? { worktreePath: rt.worktree.path } : {}),
    }),
  );
  rt.head = sync.head;
  if (sync.state === 'conflict') {
    const line = conflictFeedback(sync.conflictFiles, sync.mainlineStale);
    if (!rt.feedback.includes(line)) rt.feedback = [...rt.feedback, line];
    rt.status.lastProblem = '和主线有冲突';
    return 'conflict';
  }
  if (sync.head === head) return 'current';
  rt.status.lastProblem = null;
  return 'merged';
}
