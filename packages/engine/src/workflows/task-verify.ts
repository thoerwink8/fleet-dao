// 任务工作流的冷验收一段。
//
// 改这里之前必须知道：挂自动合并一定在冷验收通过之后（合并闸认通过的 cold-verify）；头换了回 head_moved，由调用方对新的头重走。

import type { TaskBrief } from '../runner/task-brief.ts';
import { MAX_VERIFY_ROUNDS } from '../task-contract.ts';
import type { TaskRuntime } from './task-runtime.ts';
import { headMovedDetail } from './task-support.ts';

/**
 * 冷验收。没过：记下问题表回动手（'rework'）；做不出来：停下等人，不让写代码的会话白改一轮；这会儿验不了、过一会儿就行：睡一会儿再来，
 * 不算一轮；要验的头已经被别人换了：停下等人看过，回 'head_moved'，由调用方对新的头重走一遍。
 */
export async function coldVerifyPr(
  rt: TaskRuntime,
  brief: TaskBrief,
): Promise<'pass' | 'rework' | 'head_moved'> {
  const wt = rt.worktree;
  if (!wt || rt.prNumber === null || rt.head === null) {
    throw new Error('验收之前还没有 PR（工作流自己的状态乱了）');
  }
  for (;;) {
    if (rt.verifyRound >= MAX_VERIFY_ROUNDS) {
      await rt.park(
        `验收 ${MAX_VERIFY_ROUNDS} 轮都没过`,
        `最近的问题：${rt.feedback.join('；') || '（没有）'}。点「继续」再验一轮；或「放弃」。`,
      );
      rt.verifyRound = 0;
    }
    rt.verifyRound += 1;
    await rt.advance('verify', `验收第 ${rt.verifyRound} 轮`);
    const prNumber: number = rt.prNumber;
    const headSha: string = rt.head;
    const mark = rt.routeWakeMark(); // 叫醒的记号在验之前取，理由见 task-session.ts 的 pickRoute
    const res = await rt.step('coldVerify', () =>
      rt.cancellable(() =>
        rt.acts.coldVerify({
          schemaVersion: 1,
          taskId: rt.input.taskId,
          repo: rt.input.repo,
          issueNumber: rt.input.issueNumber,
          prNumber,
          branch: rt.branch,
          baseSha: wt.baseSha,
          headSha,
          what: brief.request,
          howToFinish: brief.acceptance,
          authorFamilies: [...rt.families],
          round: rt.verifyRound === 1 ? 1 : 2,
        }),
      ),
    );
    if (res.headMoved !== undefined) {
      rt.verifyRound -= 1;
      await rt.park('PR 的头被别人改了', headMovedDetail(res.headMoved, headSha));
      rt.head = res.headMoved;
      return 'head_moved';
    }
    if (res.retry) {
      // 这会儿验不了、过一会儿就行（没空位、内存放不下、引擎在停机、上游临时故障）：不算一轮，不停下报人
      rt.verifyRound -= 1;
      await rt.pauseForRoute(res.retry.wait, res.retry.reason, res.retry.afterSeconds, mark);
      continue;
    }
    if (res.unavailable) {
      rt.verifyRound -= 1; // 没验成不算一轮
      await rt.park('验收做不出来', res.unavailable);
      continue;
    }
    if (res.pass) return 'pass';
    rt.feedback = res.problems.map((p) => `验收没过：${p}`);
    rt.status.lastProblem = '验收没过';
    return 'rework';
  }
}
