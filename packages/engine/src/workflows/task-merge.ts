// 任务工作流验收通过之后的两步：查「改标准」「先审后合」的路径（停下等人）、挂自动合并并等合并。
//
// 改这里之前必须知道：
// - 工作流不绕合并闸、不替创始人同意：碰了标准路径要人点「继续」才往下；批准只认批准那一刻的头（头换了新内容要重新批）。
// - 头被改了、人点「继续」之后回 head_moved，由调用方对新的头重走等 CI、验收、查路径；原样重新挂只会永远等下去（新头上没有 cold-verify）。

import { type GuardedPaths, MERGE_POLL_MINUTES, type MergeWait } from '../task-contract.ts';
import type { TaskRuntime } from './task-runtime.ts';
import { headMovedDetail } from './task-support.ts';

/** 碰了「改标准」「先审后合」的路径：停下等人（工作流不绕合并闸、不替创始人同意）。 */
export async function guardedPaths(rt: TaskRuntime): Promise<void> {
  const prNumber = rt.prNumber;
  const head = rt.head;
  if (prNumber === null || head === null) throw new Error('查路径之前还没有 PR');
  for (;;) {
    // 批准只认批准那一刻的头；头换了（有人又推了新提交）就当没批过。
    const approved = rt.guardApproval?.head === head ? rt.guardApproval.paths : null;
    const g = await rt.step('checkGuarded', () =>
      rt.acts.checkGuarded({
        schemaVersion: 1,
        taskId: rt.input.taskId,
        repo: rt.input.repo,
        prNumber,
        ...(approved === null ? {} : { approved }),
      }),
    );
    if (g.standards.length > 0) {
      await rt.park(
        '改到了标准路径，要创始人同意才挂自动合并（人闸：改标准）',
        `改到：${g.standards.join('、')}。创始人同意后点「继续」；不同意点「放弃」。`,
      );
      approve(rt, head, g, approved);
      continue;
    }
    if (g.highRisk.length > 0) {
      await rt.park(
        '碰了先审后合的路径，合并闸要通过第二意见',
        `改到：${g.highRisk.join('、')}。第二意见通过（second-opinion 状态）后点「继续」。`,
      );
      approve(rt, head, g, approved);
      continue;
    }
    return;
  }
}

/** 人点了「继续」（放弃会在 park 里抛出，走不到这儿）：把刚才停下来的那几条记成这个头上已批的，和之前批过的合在一起。 */
function approve(rt: TaskRuntime, head: string, pending: GuardedPaths, before: GuardedPaths | null): void {
  rt.guardApproval = {
    head,
    paths: {
      standards: [...(before?.standards ?? []), ...pending.standards],
      highRisk: [...(before?.highRisk ?? []), ...pending.highRisk],
    },
  };
}

/**
 * 挂自动合并、等合并。PR 被关了、头被改了，停下等人。头被改了、人点「继续」之后回 head_moved，由调用方对新的头重走一遍
 * （等 CI、验收、查路径）再来；别的情况一直等到合并才回。
 */
export async function armAndWaitMerged(
  rt: TaskRuntime,
): Promise<{ kind: 'merged'; commit?: string | undefined } | { kind: 'head_moved' }> {
  const prNumber = rt.prNumber;
  if (prNumber === null || rt.head === null) throw new Error('合并之前还没有 PR');
  for (;;) {
    rt.set('merge', `PR #${prNumber} 挂自动合并，等合并`);
    const head: string = rt.head;
    const armed = await rt.step('armAutoMerge', () =>
      rt.acts.armAutoMerge({ schemaVersion: 1, repo: rt.input.repo, prNumber, expectedHead: head }),
    );
    if (armed.merged) return { kind: 'merged', commit: armed.mergeCommit };
    if (armed.headMoved !== undefined) {
      await rt.park('PR 的头被别人改了', headMovedDetail(armed.headMoved, head));
      rt.head = armed.headMoved;
      return { kind: 'head_moved' };
    }
    if (!armed.armed) {
      await rt.park('自动合并没挂上', armed.why ?? 'GitHub 没说为什么');
      continue;
    }
    for (;;) {
      const w: MergeWait = await rt.waiting(
        'merge',
        `等 PR #${prNumber} 合并（合并闸、必过检查都要绿）`,
        () =>
          rt.step('waitMerged', () =>
            rt.cancellable(() =>
              rt.acts.waitMerged({
                schemaVersion: 1,
                repo: rt.input.repo,
                prNumber,
                expectedHead: head,
                minutes: MERGE_POLL_MINUTES,
              }),
            ),
          ),
      );
      if (w.state === 'merged') return { kind: 'merged', commit: w.mergeCommit };
      if (w.state === 'unarmed') {
        rt.status.lastProblem = '自动合并被撤掉了，重新挂';
        break;
      }
      if (w.state === 'closed') {
        await rt.park(
          'PR 被关了，没合并',
          `PR #${prNumber} 在 GitHub 上被关闭。要接着做，重开它后点「继续」；不做点「放弃」。`,
        );
        break;
      }
      if (w.state === 'head_moved') {
        await rt.park('PR 的头被别人改了', headMovedDetail(w.head, head));
        rt.head = w.head;
        return { kind: 'head_moved' };
      }
      // waiting：这一轮没合，接着等
    }
  }
}
