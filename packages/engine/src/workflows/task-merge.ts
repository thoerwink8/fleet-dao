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
// - 挂的时候 GitHub 说已经 clean、直接合却因这个头上还有检查在跑被拒（正文改成 Refs 会把 merge-gate 重新打进队列，
//   patched('merge-arm-pending-deadline')）：活动交回 checksPending（绑精确头、还在跑的检查名、原始原因）。这里把状态写成等检查，
//   截止时刻按工作流时间（Date.now，重放确定）记一次：第一次读到还在跑的那一下挂合并开调前加 ARM_PENDING_CHECKS_MINUTES。
//   之后每隔 ARM_PENDING_POLL_SECONDS 再走一次 armAutoMerge，这一下的排队、尝试、重试受剩余期限约束（scheduleToClose），
//   不按次数算，也不每次重开。状态落库和红的确认以前只在做完之后看还剩多少秒，慢的那一下本身不受期限约束，
//   确认那一觉还用着落库前记下的秒数。patched('merge-arm-pending-bounded-waits') 把这两下也放进同一份截止：
//   落库的 scheduleToClose 是当下剩余秒数，回来再算，确认那一觉不越过；到点就停下。标记不在历史里就按老步序重放。
//   同头变绿后仍由那一入口挂上或 squash，
//   合并账和回执不另开路。真红（checksRed）走下面同一套确认 / 返工。权限、认证、正式要求改、没查成没有这两个字段，照旧停下，
//   不因 why 里写了 ci_not_green 就重试。必过检查没出现也是没查成：活动不交 checksPending，哪怕旁边还有在跑的。
//   等到点仍没跑完：停下，写明 PR、头、检查名和原始原因。头变了回 head_moved，调用方重走
//   CI、冷验收、批准，不沿用旧头。老历史的活动结果没有这两个字段；标记不在历史里就当没有，照旧停下。
//   主线同步预算用尽（mainSyncBudgetExhausted，patched('main-sync-budget-continue')）排在还在跑和真红之后：
//   有 checksPending / checksRed 时不当成同步次数到顶。
// - 等合并时必过检查没出现或没出结论（patched('merge-wait-unreadable-checks')）：不是还在跑，活动回 checks_unreadable，
//   这里停下并写明没查成。老历史里 waitMerged 不回这个状态；标记不在历史里就当还在等，不新增步序。

import { CHECKS_RED_PREFIX } from '@fleet-dao/shared/checks-red';
import { CancellationScope, isCancellation, log, patched } from '@temporalio/workflow';
import {
  ARM_PENDING_CHECKS_MINUTES,
  ARM_PENDING_POLL_SECONDS,
  type ArmAutoMergeResult,
  type ColdVerifyResult,
  type GuardedPaths,
  MAX_MAIN_SYNCS,
  MERGE_POLL_MINUTES,
  MERGE_RED_CONFIRM_SECONDS,
  type MergeWait,
} from '../task-contract.ts';
import { activityWithin, failureOf } from './kit.ts';
import type { TaskRuntime } from './task-runtime.ts';
import { headMovedDetail, MergedTask } from './task-support.ts';
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

const ARM_PENDING_BUDGET_MS = ARM_PENDING_CHECKS_MINUTES * 60_000;

/**
 * 挂合并时等检查的那一段（只活在一次 armAndWaitMerged 里）：绑这个头，截止时刻是第一次读到还在跑的那一下挂合并开调之前的
 * 工作流时间加 ARM_PENDING_CHECKS_MINUTES。之后的挂合并、状态落库、休眠、红的确认都算在这一份里，不按次数、不每次重开。
 */
interface PendingWait {
  head: string;
  deadline: number;
  /** 一开始在等的检查名、一开始的拒绝原文：到点原样留下。 */
  started: string[];
  detail: string;
  /** 最近一次读到的还在跑的检查名。 */
  names: string[];
}

/** 期限里还剩多少秒（向下取整）；不足 1 秒就是到了。 */
function secondsLeft(wait: PendingWait): number {
  return Math.floor((wait.deadline - Date.now()) / 1000);
}

/**
 * 等检查这段里的状态落库：和 mirror 同一份内容，但 scheduleToClose 是当下剩余秒数。
 * 慢的那一下本身有界；回来再算，不足 1 秒就是到期。写不进去只记日志（和 mirror 一样不挡），期限没了仍当到期。
 * 只在 patched('merge-arm-pending-bounded-waits') 为真时走；老历史仍用 rt.advance。
 */
async function advanceWithin(
  rt: TaskRuntime,
  phase: 'merge',
  doing: string,
  wait: PendingWait,
): Promise<'ok' | 'expired'> {
  rt.set(phase, doing);
  if (!patched('mirror-phase')) return secondsLeft(wait) < 1 ? 'expired' : 'ok';
  const left = secondsLeft(wait);
  if (left < 1) return 'expired';
  const save = activityWithin('saveTaskState', rt.limits, left);
  try {
    await CancellationScope.nonCancellable(() =>
      save({
        taskId: rt.input.taskId,
        repoId: rt.input.repo.id,
        issueNumber: rt.input.issueNumber,
        state: 'running',
        phase: rt.status.phase,
        doing: rt.status.doing,
        lastProblem: rt.status.lastProblem,
        subtasks: [],
      }),
    );
  } catch (error) {
    if (error instanceof MergedTask || isCancellation(error)) throw error;
    const failure = failureOf(error, 'saveTaskState', rt.limits);
    if (
      failure.code === 'TIMEOUT_SCHEDULE_TO_CLOSE' ||
      failure.code === 'TIMEOUT_START_TO_CLOSE' ||
      secondsLeft(wait) < 1
    ) {
      return 'expired';
    }
    log.warn('任务状态没写进库（驾驶舱晚一会儿才看到）', { error: String(error) });
  }
  return secondsLeft(wait) < 1 ? 'expired' : 'ok';
}

/**
 * 必过检查红了：第一次记下并隔 MERGE_RED_CONFIRM_SECONDS 再看，仍红才返工。
 * 等合并的 waitMerged 和挂自动合并时现读到的红共用这一套。
 * maxSeconds 是老步序用的：调用方在落库之前就算好的剩余秒数。等检查这段在新标记下改传 wait，
 * 落库受剩余期限约束，确认那一觉在落库之后重算，不睡越过截止。到期回 expired，由调用方停下。
 */
async function confirmChecksRed(
  rt: TaskRuntime,
  failedChecks: readonly string[],
  detail: string,
  maxSeconds?: number,
  wait?: PendingWait,
): Promise<'confirming' | 'rework' | 'expired'> {
  const names = failedChecks.length > 0 ? failedChecks.join('、') : '（没写是哪项）';
  const line = `${CHECKS_RED_PREFIX}${names}`;
  if (!rt.mergeRedNoted) {
    rt.mergeRedNoted = true;
    rt.status.lastProblem = line;
    // 老历史、以及不在等检查期限里的红：步序和以前一样（先落库，再按调用方事先算好的秒数睡）。
    if (wait !== undefined && patched('merge-arm-pending-bounded-waits')) {
      const noted = await advanceWithin(rt, 'merge', line, wait);
      if (noted === 'expired' || secondsLeft(wait) < 1) {
        rt.mergeRedNoted = false;
        return 'expired';
      }
      await rt.pause('merge', detail || line, Math.min(MERGE_RED_CONFIRM_SECONDS, secondsLeft(wait)));
      return 'confirming';
    }
    await rt.advance('merge', line);
    const seconds =
      maxSeconds === undefined ? MERGE_RED_CONFIRM_SECONDS : Math.min(MERGE_RED_CONFIRM_SECONDS, maxSeconds);
    await rt.pause('merge', detail || line, Math.max(1, seconds));
    return 'confirming';
  }
  rt.mergeRedNoted = false;
  rt.feedback = detail ? [line, detail] : [line];
  rt.status.lastProblem = line;
  return 'rework';
}

/** 有界等待耗尽：精确 PR、头、还在跑的检查名、一开始的拒绝原文都留下。last 是最后那一下挂合并自己没跑成的原因。 */
function pendingExhaustedDetail(prNumber: number, wait: PendingWait, last?: string): string {
  const waiting = wait.names.join('、');
  const origin = wait.started.join('、');
  const which = waiting === origin ? waiting : `${waiting}（一开始在等：${origin}）`;
  const tail = last === undefined ? '' : `。最后一次挂合并没在期限内跑成：${last}`;
  return (
    `PR #${prNumber} 头 ${wait.head} 上等了 ${ARM_PENDING_CHECKS_MINUTES} 分钟还没跑完：${which}。` +
    `原始原因：${wait.detail}${tail}`
  );
}

/**
 * 等检查期间再挂一次：这一下（排队、尝试、重试）受剩余期限约束，不走 rt.step 的失败分流梯（那条梯子的退避不看期限）。
 * 到期或这一下超时：park 等检查超时。重试也治不好的错（认证、权限）：当场 park，不当成还在跑。
 * 别的错、期限还有：隔一会儿（不越过期限）再来（again）。parked＝已经停下过、人点了继续，调用方丢掉这段等待从头挂。
 */
async function armWithinDeadline(
  rt: TaskRuntime,
  prNumber: number,
  wait: PendingWait,
): Promise<{ kind: 'result'; armed: ArmAutoMergeResult } | { kind: 'parked' } | { kind: 'again' }> {
  const left = secondsLeft(wait);
  if (left < 1) {
    await rt.park('等检查超时', pendingExhaustedDetail(prNumber, wait));
    return { kind: 'parked' };
  }
  rt.guard();
  const arm = activityWithin('armAutoMerge', rt.limits, left);
  try {
    const armed = await arm({
      schemaVersion: 1,
      repo: rt.input.repo,
      prNumber,
      expectedHead: wait.head,
      ...(rt.mainSyncs > 0 ? { syncedBehind: rt.mainSyncs } : {}),
    });
    return { kind: 'result', armed };
  } catch (error) {
    if (error instanceof MergedTask || isCancellation(error)) throw error;
    const failure = failureOf(error, 'armAutoMerge', rt.limits);
    const where = `PR #${prNumber} 头 ${wait.head}，在等：${wait.names.join('、')}。原始原因：${wait.detail}`;
    const after = secondsLeft(wait);
    // 活动自己拒绝再写（期限已过、不重试）和调度超时一样：停下，不另开一次挂合并。
    if (
      failure.code === 'TIMEOUT_SCHEDULE_TO_CLOSE' ||
      failure.code === 'ARM_DEADLINE_PASSED' ||
      failure.code === 'WRITE_DEADLINE_PASSED' ||
      after < 1
    ) {
      await rt.park(
        '等检查超时',
        pendingExhaustedDetail(prNumber, wait, `${failure.code}：${failure.message}`),
      );
      return { kind: 'parked' };
    }
    if (failure.retryable === false) {
      await rt.park(`挂自动合并没跑成（${failure.code}）`, `${failure.message}。${where}`);
      return { kind: 'parked' };
    }
    rt.status.lastProblem = `等检查时挂合并没跑成，再来一次：${failure.message}`;
    await rt.pause('merge', `等检查：${where}`, Math.max(1, Math.min(ARM_PENDING_POLL_SECONDS, after)));
    return { kind: 'again' };
  }
}

/** 头已经不是这次挂的那个：停下等人，回来由调用方重走 CI、冷验收、批准。 */
async function headNoLonger(rt: TaskRuntime, pushed: string, now: string): Promise<{ kind: 'head_moved' }> {
  await rt.park('PR 的头被别人改了', headMovedDetail(now, pushed));
  rt.head = now;
  return { kind: 'head_moved' };
}

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
  // 等检查的那一段（绑头、带截止时刻）。换头、停下过、离开这条等待就丢掉，不把上一段的期限套到新头上。
  // 只有 patched('merge-arm-pending-deadline') 为真时才会有：老历史里一直是 null，下面的调度和原来一样。
  let pending: PendingWait | null = null;
  for (;;) {
    const head: string = rt.head;
    if (pending !== null && pending.head !== head) pending = null;
    // 这一下挂合并开调前的工作流时间：第一次读到还在跑时，期限从这里起算，这一下的耗时也在里面。
    const armStartedAt = Date.now();
    let armed: ArmAutoMergeResult;
    if (pending === null) {
      await rt.advance('merge', `PR #${prNumber} 挂自动合并，等合并`);
      armed = await rt.step('armAutoMerge', () =>
        rt.acts.armAutoMerge({
          schemaVersion: 1,
          repo: rt.input.repo,
          prNumber,
          expectedHead: head,
          ...(rt.mainSyncs > 0 ? { syncedBehind: rt.mainSyncs } : {}),
        }),
      );
    } else {
      const got = await armWithinDeadline(rt, prNumber, pending);
      if (got.kind === 'parked') {
        pending = null;
        continue;
      }
      if (got.kind === 'again') continue;
      armed = got.armed;
    }
    if (armed.merged) return { kind: 'merged', commit: armed.mergeCommit };
    // 挂之前现读到还挂着的正式「要求改」（#2991）：没挂（挂着的已撤），交给工人；交过的停下等审查者，点「继续」回来重挂、重读。
    // 老历史的活动结果里没有 reviewChanges，进不了这一支、不打标记
    if ((armed.reviewChanges?.length ?? 0) > 0 && patched('merge-review-changes')) {
      pending = null;
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
      // 老历史的活动结果没有 checksPending / checksRed，标记也不在：patched() 为假，照旧停下，不因 why 里的 ci_not_green 重试。
      if (patched('merge-arm-pending-deadline')) {
        const red = armed.checksRed;
        if (red) {
          if (red.head !== head) return headNoLonger(rt, head, red.head);
          // 等检查当中红了：期限不清、不重开，确认那一觉也不越过它。红一下又变回还在跑，接着用同一份期限。
          const outcome = await confirmChecksRed(
            rt,
            red.failedChecks,
            red.detail,
            pending === null ? undefined : secondsLeft(pending),
            pending ?? undefined,
          );
          if (outcome === 'expired' && pending !== null) {
            const detail = pendingExhaustedDetail(prNumber, pending);
            pending = null;
            await rt.park('等检查超时', detail);
            continue;
          }
          if (outcome === 'rework') return { kind: 'rework' };
          continue;
        }
        const running = armed.checksPending;
        if (running && running.names.length > 0) {
          if (running.head !== head) return headNoLonger(rt, head, running.head);
          // 红了一下又变回还在跑：这次确认作废，接着等，不返工。
          rt.mergeRedNoted = false;
          if (pending === null) {
            pending = {
              head,
              deadline: armStartedAt + ARM_PENDING_BUDGET_MS,
              started: [...running.names],
              detail: running.detail,
              names: [...running.names],
            };
          } else {
            pending.names = [...running.names];
          }
          const left = secondsLeft(pending);
          if (left < 1) {
            const detail = pendingExhaustedDetail(prNumber, pending);
            pending = null;
            await rt.park('等检查超时', detail);
            continue;
          }
          const names = running.names.join('、');
          const line = `等检查：${names}`;
          rt.status.lastProblem = line;
          if (rt.status.phase !== 'merge' || rt.status.doing !== line) {
            if (patched('merge-arm-pending-bounded-waits')) {
              const noted = await advanceWithin(rt, 'merge', line, pending);
              if (noted === 'expired') {
                const detail = pendingExhaustedDetail(prNumber, pending);
                pending = null;
                await rt.park('等检查超时', detail);
                continue;
              }
            } else {
              await rt.advance('merge', line);
            }
          }
          // 落库那一下也花了时间：睡之前再算一次剩下多少，睡不越过期限。
          const sleepFor = Math.min(ARM_PENDING_POLL_SECONDS, secondsLeft(pending));
          if (sleepFor >= 1) {
            await rt.pause('merge', `等检查：PR #${prNumber} 头 ${head} 的 ${names}`, sleepFor);
          }
          continue;
        }
      }
      pending = null;
      // 不是还在跑、也不是真红：主线同步次数用尽才走结构化续段，别的失败仍停下报人。
      if (await rt.parkMainSyncBudget(armed.mainSyncBudgetExhausted, armed.why ?? '同步主线次数已到上限'))
        continue;
      await rt.park('自动合并没挂上', armed.why ?? 'GitHub 没说为什么');
      continue;
    }
    pending = null;
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
          if (
            await rt.parkMainSyncBudget(
              { prNumber, headSha: head, used: rt.mainSyncs },
              `PR #${prNumber} 的主线同步次数已到上限，GitHub 仍报告冲突`,
              `连着 ${MAX_MAIN_SYNCS} 次并主线后 PR #${prNumber} 还是和主线冲突`,
            )
          )
            continue;
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
      if (w.state === 'checks_unreadable') {
        // 老历史重放：这一支是加进来的。patched() 为假就当还在等，不多调活动。
        if (!patched('merge-wait-unreadable-checks')) continue;
        await rt.park('必过检查没查成', w.detail);
        continue;
      }
      if (w.state === 'checks_red') {
        // 老历史重放：这一支是加进来的。patched() 为假就当还在等，不多调活动。
        if (!patched('merge-wait-red-checks')) continue;
        const outcome = await confirmChecksRed(rt, w.failedChecks, w.detail);
        if (outcome === 'confirming') continue;
        return { kind: 'rework' };
      }
      // waiting：这一轮没合，接着等
    }
  }
}
