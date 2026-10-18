// 任务工作流的冷验收一段。
//
// 改这里之前必须知道：挂自动合并一定在冷验收通过之后（合并闸认通过的 cold-verify）；头换了回 head_moved，由调用方对新的头重走。
// 和等 CI 并行跑（决定 0093，task.ts 的 deliver）走 verifyAlongsideCi：只验一次、不动工作流的状态（不加轮数、不写意见、不停下），
// 结果交给调用方等 CI 收场后再认；CI 不绿就不认，并取消这一次验收（patched('verify-cancel-on-ci-red')，省一次验收会话的 token）。
// 引擎自测（决定 0093）的精炼输出只在测的就是要验的这个头时带上（testOutput）；老历史里没有自测，不带，入参和原来一样。
// 第 2 轮起只复核上轮没过的条和这一轮的增量 diff（patched('verify-recheck')）：老历史没有这个标记，冷验收入参和原来一样。

// 验收会话脱开引擎跑（#2848）：活动交回 detached 时隔 VERIFY_REATTACH_SECONDS 带上 attach 再调同一次验收（patched('cold-verify-attach')），
// 接回的结论照常认；接回没接成的活动回 retry（重验一次），不算一轮、不算没过，全程「冷验收被拒」的次数也不数它。

// 「不归我验」（#3037）：结论里的 outOfScope 不算没过、不挡合并（决定 0093），按 PR + 头记进 rt.handedOver，收尾（task.ts 的 finish）
// 照它和库里的验收责任留着原单。

// 正式评审（#2991，patched('review-request-changes')）：活动在验收有结论时现读 PR 上认可审查者还没解决的「要求改」，带在结论里。
// 没交过的交给下一轮动手，交过的不重复派工，挂着就不合。验收之后到合上之间交的评审由合并那一步接（task-merge.ts：挂自动合并、
// 等合并的每一圈、直接合之前都重读，读到了撤掉自动合并、交给这里同一份 handReviewChanges）。

import { CancellationScope, log, patched } from '@temporalio/workflow';
import { reviewFeedbackLines, reviewKey, reviewParkDetail } from '../review-feedback.ts';
import type { TaskBrief } from '../runner/task-brief.ts';
import {
  type ColdVerifyInput,
  type ColdVerifyResult,
  MAX_VERIFY_ROUNDS,
  type ReviewChange,
} from '../task-contract.ts';
import type { TaskRuntime } from './task-runtime.ts';
import { headMovedDetail, verifyStopDetail } from './task-support.ts';

/** 验收会话脱开引擎跑着、引擎在换版本（#2848）：隔多久去接回一次（和动手段的 SEGMENT_REATTACH_SECONDS 一样）。 */
export const VERIFY_REATTACH_SECONDS = 20;

/**
 * 冷验收。没过：记下问题表回动手（'rework'）；做不出来：停下等人，不让写代码的会话白改一轮；这会儿验不了、过一会儿就行：睡一会儿再来，
 * 不算一轮；要验的头已经被别人换了：停下等人看过，回 'head_moved'，由调用方对新的头重走一遍。
 * early：和 CI 同时验过、已经认下的那一次结果（决定 0093）。给了就当第一轮的结果用，不再调活动；后面的处理和串行一样。
 */
export async function coldVerifyPr(
  rt: TaskRuntime,
  brief: TaskBrief,
  early?: ColdVerifyResult,
): Promise<'pass' | 'rework' | 'head_moved'> {
  const wt = rt.worktree;
  if (!wt || rt.prNumber === null || rt.head === null) {
    throw new Error('验收之前还没有 PR（工作流自己的状态乱了）');
  }
  let current = brief;
  let ready = early;
  for (;;) {
    if (rt.verifyRound >= MAX_VERIFY_ROUNDS) {
      const problems = rt.feedback.join('；') || '（没有）';
      const mode = await rt.exhaustRounds(
        `验收 ${MAX_VERIFY_ROUNDS} 轮都没过`,
        `最近的问题：${problems}。点「继续」再验一轮；或「放弃」。`,
        verifyStopDetail(rt.verifyProblems),
      );
      if (mode === 'legacy') rt.verifyRound = 0;
      // 自动续的那一次（决定 0093，mode auto）：轮数已清零、下一轮动手避开最近的模型；这个头还没验过，接着验它
    }
    if (rt.brief) current = rt.brief;
    rt.verifyRound += 1;
    await rt.advance('verify', `验收第 ${rt.verifyRound} 轮${ready ? '（和 CI 同时验的）' : ''}`);
    const headSha: string = rt.head;
    const mark = rt.routeWakeMark(); // 叫醒的记号在验之前取，理由见 task-session.ts 的 pickRoute
    const verifyInput = coldVerifyInput(rt, current, rt.verifyRound);
    let res =
      ready ?? (await rt.step('coldVerify', () => rt.cancellable(() => rt.acts.coldVerify(verifyInput))));
    ready = undefined;
    // 引擎换版本、重启时验收会话没停、脱开接着跑（#2848，和动手段 segment-reattach 同一套）：隔一会儿带上 attach 再调同一次验收，
    // 等它收场——不算一轮、不算没过、不重新起会话。老引擎还在排空时接回会当场再交回 detached，所以隔一会儿再接。
    // 老历史没有这个标记（也不会有 detached）
    while (res.detached && patched('cold-verify-attach')) {
      const attach = res.detached;
      await rt.pause('retry', '引擎在换版本：验收会话脱开引擎接着跑，等新引擎接回', VERIFY_REATTACH_SECONDS);
      res = await rt.step('coldVerify', () =>
        rt.cancellable(() => rt.acts.coldVerify({ ...verifyInput, attach })),
      );
    }
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
    // 「不归我验」转给人的验收条（#3037）：不算没过、不挡合并，记下来，收尾时照它留着原单（纯状态，老历史没有这个字段）
    if (res.outOfScope !== undefined && res.outOfScope.length > 0) {
      rt.noteHandedOver(rt.prNumber ?? 0, headSha, res.outOfScope);
    }
    // PR 上还挂着认可审查者的正式「要求改」（#2991）：没交过的交给下一轮工人；都交过了、验收这一头又过了，不再派工也不合，
    // 停下等审查者复审或撤销。老历史的活动结果里没有 reviewChanges，进不了这一支、不打标记
    const reviews = res.reviewChanges ?? [];
    if (reviews.length > 0 && patched('review-request-changes')) {
      if ((await handReviewChanges(rt, reviews, res, 'verify')) === 'rework') return 'rework';
      continue;
    }
    if (res.pass) return 'pass';
    noteVerifyProblems(rt, res.problems);
    return 'rework';
  }
}

/**
 * 正式评审交给工人（#2991）：没交过的（新的、总述或行内编辑的）连原文、review id、审的提交写进返工意见回 'rework'；验收也没过的，
 * 问题照记、这一轮算验收的一轮，交过的评审附在意见里提醒（审查者没撤，不能因为推了新提交就丢）。
 * 都交过、验收这一头过了：不再派工（重复读到不重复派工），也不认成验过（旧头上的评审不能替新头放行），停下等审查者，
 * 人点「继续」回 'again'，调用方重读评审（冷验收重验一次；合并那一步重挂、重合，挂之前、合之前都重读）。
 * from：'verify' 是冷验收刚算了这一轮（评审返工、等审查者都退掉这一轮）；'merge' 是挂自动合并、等合并、直接合时读到的
 * （验收早过了，评审返工后验收从第 1 轮重新数）。
 */
export async function handReviewChanges(
  rt: TaskRuntime,
  reviews: readonly ReviewChange[],
  verdict: Pick<ColdVerifyResult, 'pass' | 'problems'>,
  from: 'verify' | 'merge',
): Promise<'rework' | 'again'> {
  const prNumber = rt.prNumber ?? 0;
  const keyOf = (r: ReviewChange) => reviewKey(prNumber, r);
  const fresh = reviews.filter((r) => !rt.reviewsHanded.has(keyOf(r)));
  if (fresh.length === 0 && verdict.pass) {
    if (from === 'verify') rt.verifyRound -= 1; // 验收过了，等的是审查者：不算一轮
    await rt.park(
      '正式评审还要求改',
      reviewParkDetail(prNumber, reviews, (r) => rt.reviewsHanded.get(keyOf(r))),
    );
    return 'again';
  }
  if (verdict.pass) {
    // 验收这一头过了，返工是评审要的：不占验收的轮数，下一次从头验新的头
    if (from === 'verify') rt.verifyRound -= 1;
    else rt.verifyRound = 0;
    rt.verifyProblems = [];
    rt.verifyRecheck = null;
    rt.feedback = [];
    rt.status.lastProblem = '正式评审要求改';
  } else {
    noteVerifyProblems(rt, verdict.problems);
  }
  const head = rt.head;
  rt.feedback = [
    ...reviews.flatMap((r) => reviewFeedbackLines(r, head, rt.reviewsHanded.has(keyOf(r)))),
    ...rt.feedback,
  ];
  for (const r of fresh) rt.reviewsHanded.set(keyOf(r), head ?? '');
  // 可定位的证据：哪张单、哪个 PR、哪条评审、审的哪个提交，在哪个头上交给了下一轮动手（动手会话的入参 feedback 里就是这几行）
  log.info('正式评审交给下一轮动手会话', {
    taskId: rt.input.taskId,
    prNumber,
    head,
    handed: fresh.map((r) => ({ reviewId: r.reviewId, reviewer: r.reviewer, commitId: r.commitId })),
    reminded: reviews.filter((r) => !fresh.includes(r)).map((r) => r.reviewId),
  });
  return 'rework';
}

/** 给冷验收活动的入参：验的是现在的头，round 是这一次算第几轮（1 或 2）。 */
function coldVerifyInput(rt: TaskRuntime, brief: TaskBrief, round: number): ColdVerifyInput {
  const wt = rt.worktree;
  if (!wt || rt.prNumber === null || rt.head === null) {
    throw new Error('验收之前还没有 PR（工作流自己的状态乱了）');
  }
  const headSha = rt.head;
  const tested = rt.selfCheckOutput?.head === headSha ? rt.selfCheckOutput.text : undefined;
  const roundNo = round === 1 ? 1 : 2;
  const input: ColdVerifyInput = {
    schemaVersion: 1,
    taskId: rt.input.taskId,
    repo: rt.input.repo,
    issueNumber: rt.input.issueNumber,
    prNumber: rt.prNumber,
    branch: rt.branch,
    baseSha: wt.baseSha,
    headSha,
    what: brief.request,
    howToFinish: brief.acceptance,
    authorFamilies: [...rt.families],
    round: roundNo,
    ...(tested ? { testOutput: tested } : {}),
  };
  // 第 1 轮从头验，丢掉上一张头上留下的复核材料。这一支不调 patched()：老历史第 1 轮的命令顺序不变。
  if (roundNo === 1) {
    rt.verifyRecheck = null;
    return input;
  }
  const prior = rt.verifyRecheck;
  // 老历史重放：标记不在历史里，patched() 为假，入参和原来一字不差。
  if (!patched('verify-recheck') || prior === null || prior.problems.length === 0) {
    return input;
  }
  return {
    ...input,
    recheck: {
      failedCriteria: prior.criteria,
      sinceSha: prior.head,
      priorProblems: prior.problems,
    },
  };
}

/** 从上轮问题里抽出验收条编号（「第 N 条」）。同一个号只留一次。 */
function criterionNumbers(problems: readonly string[]): number[] {
  const out: number[] = [];
  for (const problem of problems) {
    for (const match of problem.matchAll(/第\s*(\d+)\s*条/g)) {
      const n = Number(match[1]);
      if (n >= 1 && !out.includes(n)) out.push(n);
    }
  }
  return out;
}

/** 和等 CI 同时起的那一次验收：结果（不抛）和只取消它自己的钩子。 */
export interface AlongsideVerify {
  result: Promise<{ ok: true; res: ColdVerifyResult } | { ok: false; error: unknown }>;
  /**
   * CI 先不绿了、结果反正不认：取消这一次验收，省下验收会话的 token（决定 0093）。只取消它自己的范围，不碰动手会话、不算放弃。
   * 活动已经跑完（结果已经交回工作流）再调也没事：SDK 只给还没收场的活动发取消，跑完的不发命令；结果在取消送到之前先回来的，
   * result 照样是 ok（默认的取消方式等活动真收场才回，不会出现「工作流以为取消了、活动其实跑完了」）。只调一次。
   */
  cancel(): void;
}

/**
 * 和等 CI 同时起的那一次验收（决定 0093）：只调一次活动，不加轮数、不写意见、不停下、不睡，结果原样交回，由调用方等 CI 收场后认。
 * 活动没跑成、被 cancel 取消了也不抛（交回 error），放弃照常收得到（rt.cancellable）。轮数按「认了这一次」算（现在的轮数 + 1）。
 * 活动包在自己的一层可取消范围里：建范围不发命令，老历史重放照旧；cancel 由调用方在 patched 里调。
 */
export function verifyAlongsideCi(rt: TaskRuntime, brief: TaskBrief): AlongsideVerify {
  const input = coldVerifyInput(rt, rt.brief ?? brief, rt.verifyRound + 1);
  // 这一层要在 rt.cancellable 的范围里建（父范围取建的那一刻的当前范围）：放弃取消外层时连着它一起取消
  let own: CancellationScope | null = null;
  let cancelled = false;
  const result = rt
    .cancellable(() => {
      const scope = new CancellationScope({ cancellable: true });
      own = scope;
      if (cancelled) scope.cancel();
      return scope.run(() => rt.acts.coldVerify(input));
    })
    .then(
      (res) => ({ ok: true as const, res }),
      (error: unknown) => ({ ok: false as const, error }),
    );
  return {
    result,
    cancel: () => {
      if (cancelled) return;
      cancelled = true;
      (own as CancellationScope | null)?.cancel();
    },
  };
}

/** 验收没过：记下原话（轮数用尽的通知要用）和返工意见。头和下一条复核要用的条也记下（纯状态，不调活动）。 */
export function noteVerifyProblems(rt: TaskRuntime, problems: string[]): void {
  rt.verifyProblems = problems;
  rt.feedback = problems.map((p) => `验收没过：${p}`);
  rt.status.lastProblem = '验收没过';
  if (rt.head !== null) {
    rt.verifyRecheck = { head: rt.head, criteria: criterionNumbers(problems), problems: [...problems] };
  }
}
