// 任务工作流验收通过之后的两步：查「改标准」的路径（停下等人）、挂自动合并并等合并。
//
// 改这里之前必须知道：
// - 工作流不绕合并闸、不替创始人同意：碰了标准路径要人点「继续」才往下；批准只认批准那一刻的头（头换了新内容要重新批）。
// - 头被改了、人点「继续」之后回 head_moved，由调用方对新的头重走等 CI、验收、查路径；原样重新挂只会永远等下去（新头上没有 cold-verify）。
// - 等合并时 PR 和主线冲突（#1838，patched('merge-wait-conflict')）：自动合并永远等不到（GitHub 不给冲突的 PR 起 CI，也不会合它，
//   等下去只有超时；#1824 就这么卡了 7 小时 45 分）。走「推分支并主线撞上冲突」那一条：并主线，并得干净就回 head_moved 让调用方
//   对新头重走 CI 和验收；并不动（真有冲突）把冲突文件名记进返工意见、回 'rework' 交回会话解；本来就没得并、只是 GitHub 数据旧了，
//   睡一会儿再看。连着并满 MAX_MAIN_SYNCS 次还冲突就停下报人，不无限转。老历史里没有这一支。
// - 老历史重放：这一支用 patched() 守住——老历史里 waitMerged 不会回 conflict，标记也不在历史里，patched() 为假就当没有。
// - 等合并时必过检查转红（#1983，patched('merge-wait-red-checks')）：红了和还在跑都是 blocked，以前都当 waiting 一直等。
//   第一次红就写「检查红了：」加检查名，隔 MERGE_RED_CONFIRM_SECONDS 再读；仍红就把检查名和原因交回返工。
//   中间变回还在跑就清掉，接着等。老历史里 waitMerged 不回 checks_red；patched() 为假就当还在等。
// - 正式评审要求改（#2991，patched('merge-review-changes')）：冷验收之后交的评审由这一步接——挂自动合并前、等合并的每一圈都现读，
//   读到了活动先撤掉已挂的自动合并，这里交给工人（task-verify.ts 的 handReviewChanges，和冷验收同一份）或停下等审查者。
//   GitHub 事件那头只撤自动合并、不叫醒工作流（@fleet-dao/github 的 reviewMergeHold）：撤了之后这里读到 unarmed、回去重挂，
//   挂之前读到评审。老历史里活动结果没有 reviewChanges，标记也不在历史里。

import { CHECKS_RED_PREFIX } from '@fleet-dao/shared/checks-red';
import { patched } from '@temporalio/workflow';
import {
  type ColdVerifyResult,
  type GuardedPaths,
  MAX_MAIN_SYNCS,
  MERGE_POLL_MINUTES,
  MERGE_RED_CONFIRM_SECONDS,
  type MergeWait,
} from '../task-contract.ts';
import type { TaskRuntime } from './task-runtime.ts';
import { headMovedDetail } from './task-support.ts';
import { syncMainlineOnConflict } from './task-sync.ts';
import { handReviewChanges } from './task-verify.ts';

/** 合并这一步读到评审时，冷验收早已过了（handReviewChanges 认的「验收这一头过了」）。 */
const PASSED: Pick<ColdVerifyResult, 'pass' | 'problems'> = { pass: true, problems: [] };

/** 等合并时发现 PR 和主线冲突：写进任务状态的那句话（驾驶舱和库里看得到，和「在合并队列」分开）。 */
export const MERGE_CONFLICT_NOTE = 'PR 和主线冲突，在并主线';

/**
 * 分支已含最新主线、GitHub 却还说冲突（它的 mergeable 是后台算的，刚推完的头要等它重算）时隔多久再看一遍。
 * 不用 MERGE_POLL_MINUTES（那一次要 15 分钟，是「等合并」的节奏）：这里只是等 GitHub 把数据刷新过来。
 */
const CONFLICT_REPOLL_SECONDS = 60;

/** 碰了「改标准」的路径：停下等人（工作流不绕合并闸、不替创始人同意）。 */
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
    return;
  }
}

/** 人点了「继续」（放弃会在 park 里抛出，走不到这儿）：把刚才停下来的那几条记成这个头上已批的，和之前批过的合在一起。 */
function approve(rt: TaskRuntime, head: string, pending: GuardedPaths, before: GuardedPaths | null): void {
  rt.guardApproval = {
    head,
    paths: { standards: [...(before?.standards ?? []), ...pending.standards] },
  };
}

/**
 * 挂自动合并、等合并。PR 被关了、头被改了，停下等人。头被改了、人点「继续」之后回 head_moved，由调用方对新的头重走一遍
 * （等 CI、验收、查路径）再来；别的情况一直等到合并才回。
 * 等合并期间 PR 和主线冲突（#1838）：不留在等合并的循环里，走并主线的路——并得干净回 head_moved 让调用方对新头重走；
 * 并不动回 'rework'，由调用方交回这一轮的动手会话解冲突。
 * 必过检查红了：确认仍红也回 'rework'，意见里带检查名和原因。
 */
export async function armAndWaitMerged(
  rt: TaskRuntime,
): Promise<{ kind: 'merged'; commit?: string | undefined } | { kind: 'head_moved' } | { kind: 'rework' }> {
  const prNumber = rt.prNumber;
  if (prNumber === null || rt.head === null) throw new Error('合并之前还没有 PR');
  for (;;) {
    await rt.advance('merge', `PR #${prNumber} 挂自动合并，等合并`);
    const head: string = rt.head;
    const armed = await rt.step('armAutoMerge', () =>
      rt.acts.armAutoMerge({
        schemaVersion: 1,
        repo: rt.input.repo,
        prNumber,
        expectedHead: head,
        ...(rt.mainSyncs > 0 ? { syncedBehind: rt.mainSyncs } : {}),
      }),
    );
    if (armed.merged) return { kind: 'merged', commit: armed.mergeCommit };
    // 挂之前现读到还挂着的正式「要求改」（#2991）：没挂（挂着的已撤），交给工人；交过的停下等审查者，点「继续」回来重挂、重读。
    // 老历史的活动结果里没有 reviewChanges，进不了这一支、不打标记
    if ((armed.reviewChanges?.length ?? 0) > 0 && patched('merge-review-changes')) {
      const next = await handReviewChanges(rt, armed.reviewChanges ?? [], PASSED, 'merge');
      if (next === 'rework') return { kind: 'rework' };
      continue;
    }
    if (armed.headMoved !== undefined && armed.syncedMain === true) {
      // 落后主线、引擎已把 PR 同步到最新主线：头是自己换的，不停下等人，直接对新头重走 CI 和验收
      rt.mainSyncs += 1;
      rt.status.lastProblem = armed.why ?? `PR #${prNumber} 落后主线，已同步`;
      rt.head = armed.headMoved;
      return { kind: 'head_moved' };
    }
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
      // 不是连着两次红：中间有别的结果就把确认清掉（红一下又变回还在跑，不算要返工）。
      if (w.state !== 'checks_red') rt.mergeRedNoted = false;
      if (w.state === 'merged') return { kind: 'merged', commit: w.mergeCommit };
      if (w.state === 'review_changes') {
        // 等合并时交的正式「要求改」（#2991）：活动已撤掉自动合并。交给工人，或停下等审查者后回去重挂（挂之前再读一次）。
        // 老历史里 waitMerged 不回这个状态
        if (!patched('merge-review-changes')) continue;
        const next = await handReviewChanges(rt, w.reviewChanges, PASSED, 'merge');
        if (next === 'rework') return { kind: 'rework' };
        break;
      }
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
      if (w.state === 'conflict') {
        // 老历史重放：这一支是加进来的，老历史里 waitMerged 不会回 conflict，patched() 为假就当没有（照旧接着等）。
        if (!patched('merge-wait-conflict')) continue;
        // 状态里写清是冲突挡着（不是单纯在排队），人打开驾驶舱看得出来。
        await rt.advance('merge', MERGE_CONFLICT_NOTE);
        // 已经同步过 MAX_MAIN_SYNCS 次了还是冲突：不接着转（和「落后主线自动同步」同一个上限），原样停下报人。
        if (rt.mainSyncs >= MAX_MAIN_SYNCS) {
          await rt.park(
            `连着 ${MAX_MAIN_SYNCS} 次并主线后 PR #${prNumber} 还是和主线冲突`,
            `PR #${prNumber} 和主线冲突，引擎自动并主线 ${MAX_MAIN_SYNCS} 次都没并干净：要人看。` +
              `看一下 PR #${prNumber} 和主线的冲突，解完对新头重走 CI 和验收。`,
          );
          continue;
        }
        const sync = await syncMainlineOnConflict(rt, head);
        // 并得干净：头是引擎自己换的，不停下等人，回 head_moved 让调用方对新头重走 CI 和验收。
        if (sync === 'merged') return { kind: 'head_moved' };
        // 真有冲突：返工意见（冲突文件名）已记下，交回会话解。
        if (sync === 'conflict') return { kind: 'rework' };
        // 分支已含最新主线、没什么可并，GitHub 却说冲突（它的 mergeable 是后台算的，刚推完的头要等它重算）：
        // 睡一会儿再问一遍，不空转。连着转满 MAX_MAIN_SYNCS 次上面就停下报人了。
        await rt.pause(
          'merge',
          `PR #${prNumber} 的冲突数据还没重算完，等一会儿再看`,
          CONFLICT_REPOLL_SECONDS,
        );
      }
      if (w.state === 'checks_red') {
        // 老历史重放：这一支是加进来的。patched() 为假就当还在等，不多调活动。
        if (!patched('merge-wait-red-checks')) continue;
        const names = w.failedChecks.length > 0 ? w.failedChecks.join('、') : '（没写是哪项）';
        const line = `${CHECKS_RED_PREFIX}${names}`;
        if (!rt.mergeRedNoted) {
          rt.mergeRedNoted = true;
          rt.status.lastProblem = line;
          await rt.advance('merge', line);
          await rt.pause('merge', w.detail || line, MERGE_RED_CONFIRM_SECONDS);
          continue;
        }
        rt.mergeRedNoted = false;
        rt.feedback = w.detail ? [line, w.detail] : [line];
        rt.status.lastProblem = line;
        return { kind: 'rework' };
      }
      // waiting：这一轮没合，接着等
    }
  }
}
