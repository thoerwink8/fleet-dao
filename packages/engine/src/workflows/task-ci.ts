// 任务工作流的「等 CI」一段：红了、有冲突记下返工意见回动手；读不到、头被改写停下等人。
//
// 改这里之前必须知道：等 CI 是长活动（心跳、收得到取消），一律经 rt.cancellable；冲突先自动并主线，并得干净就接着等。

import type { CiResult, SyncResult } from '../decisions/types.ts';
import type { TaskRuntime } from './task-runtime.ts';
import type { CiStep } from './task-support.ts';
import { conflictFeedback } from './task-sync.ts';

/** 等 CI。红了、有冲突：记下返工意见，回动手。读不到、头被改写：停下等人，继续后再等。 */
export async function waitForCi(rt: TaskRuntime): Promise<CiStep> {
  const wt = rt.worktree;
  if (!wt || rt.prNumber === null || rt.head === null) {
    throw new Error('等 CI 之前还没有 PR（工作流自己的状态乱了）');
  }
  for (;;) {
    await rt.advance('ci', `等 PR #${rt.prNumber} 的 CI`);
    const prNumber: number = rt.prNumber;
    const head: string = rt.head;
    const got: CiResult = await rt.waiting('ci', `等 PR #${prNumber} 的 CI`, () =>
      rt.step('waitCi', () =>
        rt.cancellable(() =>
          rt.acts.waitCi({
            taskId: rt.input.taskId,
            repo: rt.input.repo,
            prNumber,
            branch: rt.branch,
            head,
            worktreePath: wt.path,
          }),
        ),
      ),
    );
    rt.head = got.head;
    switch (got.state) {
      case 'green':
        return { kind: 'green' };
      case 'merged':
        return { kind: 'merged', mergeCommit: got.mergeCommit };
      case 'red':
        rt.feedback = [
          `CI 红了：${got.failedChecks.join('、') || '（没写是哪项）'}`,
          ...(got.digest ? [got.digest] : []),
          ...(got.detail ? [got.detail] : []),
        ];
        rt.status.lastProblem = 'CI 红了';
        return { kind: 'rework' };
      case 'conflict': {
        const sync: SyncResult = await rt.step('syncMainline', () =>
          rt.acts.syncMainline({
            taskId: rt.input.taskId,
            repo: rt.input.repo,
            prNumber,
            branch: rt.branch,
            head: got.head,
            worktreePath: wt.path,
          }),
        );
        rt.head = sync.head;
        if (sync.state === 'clean') continue;
        rt.feedback = [conflictFeedback(sync.conflictFiles, sync.mainlineStale)];
        rt.status.lastProblem = '和主线有冲突';
        return { kind: 'rework' };
      }
      case 'unknown':
        await rt.park('CI 的结果没查成', got.detail ?? '没有检查，或超时读不到');
        continue;
      case 'diverged':
        await rt.park('PR 的头被改写了（新头不含老头）', got.detail ?? '像是被强推改写，自动并主线接不了');
        continue;
    }
  }
}
