// 任务工作流的「等 CI」一段：红了、有冲突记下返工意见回动手；读不到、头被改写停下等人。
//
// CI 结果没查成（不是 PR 被关了、不是没配检查）先自己隔 CI_UNKNOWN_RECHECK_SECONDS 秒重查，最多 CI_UNKNOWN_RECHECKS 次，再停下等人
// （决定 0093，patched('ci-unknown-recheck')，只在 waitForCiPolicy：waitForCi 只有老历史走）。
//
// CI 红了回动手前（patched('ci-red-review-context')）：现读这张 PR 上仍有效的正式评审，和失败的检查、摘要、日志一起交下一轮。
// 读失败、身份不符走原来的有界重试后停下；读的过程中头变了明确未交付，不记已消费、不放行合并。老历史没有这个标记，红了只交 CI 那几行。
//
// 改这里之前必须知道：等 CI 是长活动（心跳、收得到取消），一律经 rt.cancellable；冲突先自动并主线，并得干净就接着等。

import { log, patched } from '@temporalio/workflow';
import type { CiResult, SyncResult } from '../decisions/types.ts';
import { reviewFeedbackLines, reviewKey } from '../review-feedback.ts';
import type { ReviewChange } from '../task-contract.ts';
import type { TaskRuntime } from './task-runtime.ts';
import {
  CI_UNKNOWN_RECHECK_SECONDS,
  CI_UNKNOWN_RECHECKS,
  type CiStep,
  ciUnknownIsNoChecks,
  FORCE_CI_NO_CHECKS,
} from './task-support.ts';
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
      case 'red': {
        const next = await finishCiRed(rt, prNumber, got.head, got);
        if (next === 'stay') continue;
        return { kind: 'rework' };
      }
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

/** 现读仓的 CI 模式。认不出的不当成不强制。 */
export async function readRepoCiPolicy(rt: TaskRuntime): Promise<'force' | 'off'> {
  const got = await rt.step('readCiPolicy', () =>
    rt.acts.readCiPolicy({ schemaVersion: 1, repo: rt.input.repo }),
  );
  return got.mode === 'off' ? 'off' : 'force';
}

/**
 * 强制 CI 的等法。和 waitForCi 的差别：没有检查、超时、读失败停下时，每 30 秒再读一次模式，
 * 仓已切成不强制就回 skip，不用人点「继续」。PR 被关了仍只等人。
 * 老历史不走这里（patched('repo-ci-policy') 为假时调用方仍用 waitForCi）。
 */
export async function waitForCiPolicy(rt: TaskRuntime): Promise<CiStep> {
  const wt = rt.worktree;
  if (!wt || rt.prNumber === null || rt.head === null) {
    throw new Error('等 CI 之前还没有 PR（工作流自己的状态乱了）');
  }
  // 这一趟里 CI 结果没查成已经自动重查过几次
  let rechecks = 0;
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
      case 'red': {
        const next = await finishCiRed(rt, prNumber, got.head, got);
        if (next === 'stay') continue;
        return { kind: 'rework' };
      }
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
      case 'unknown': {
        // PR 被关了不是「等 CI」：切模式也不许直接合一张已经关了的 PR。
        const closed = got.detail?.includes('PR 被关了') === true;
        const noChecks = ciUnknownIsNoChecks(got.detail);
        // 没查成先自己隔一会儿重查（决定 0093），有上限。PR 被关了、强制 CI 的仓根本没配检查（要人去配）不重查。老历史没有这个标记，照旧停下
        if (!closed && !noChecks && rechecks < CI_UNKNOWN_RECHECKS && patched('ci-unknown-recheck')) {
          rechecks += 1;
          const why = got.detail ?? '没有检查，或超时读不到';
          await rt.note(
            `PR #${prNumber} 的 CI 结果没查成（${why.slice(0, 200)}），${CI_UNKNOWN_RECHECK_SECONDS} 秒后自动重查（第 ${rechecks} 次，最多 ${CI_UNKNOWN_RECHECKS} 次）`,
          );
          await rt.pause(
            'retry',
            `CI 的结果没查成，${CI_UNKNOWN_RECHECK_SECONDS} 秒后重查`,
            CI_UNKNOWN_RECHECK_SECONDS,
          );
          continue;
        }
        if (!closed) {
          const title = noChecks ? FORCE_CI_NO_CHECKS : 'CI 的结果没查成';
          const detail = noChecks
            ? `${FORCE_CI_NO_CHECKS}。${got.detail ?? '没有检查'}`
            : (got.detail ?? '没有检查，或超时读不到');
          const why = await rt.parkUnless(title, detail, async () => (await readRepoCiPolicy(rt)) === 'off');
          if (why === 'left') return { kind: 'skip' };
          continue;
        }
        await rt.park('CI 的结果没查成', got.detail ?? '没有检查，或超时读不到');
        continue;
      }
      case 'diverged':
        await rt.park('PR 的头被改写了（新头不含老头）', got.detail ?? '像是被强推改写，自动并主线接不了');
        continue;
    }
  }
}

/**
 * CI 红了：先记下失败的检查、摘要、日志，再（新历史）把仍有效的正式评审附在后面，一起交下一轮。
 * 已交过但仍挂着的评审只当上下文（again），不为此多起一轮。读失败由 step 按原来的有界重试停下，CI 那几行留着。
 * 头变了或快照对不上：停下说明未核实，不记已消费，也不拿这次红去返工、更不合。
 * 回 stay＝调用方接着等 CI（头可能已经换成读到的新头）。
 */
async function finishCiRed(
  rt: TaskRuntime,
  prNumber: number,
  head: string,
  got: CiResult,
): Promise<'rework' | 'stay'> {
  const ciLines = [
    `CI 红了：${got.failedChecks.join('、') || '（没写是哪项）'}`,
    ...(got.digest ? [got.digest] : []),
    ...(got.detail ? [got.detail] : []),
  ];
  rt.feedback = ciLines;
  rt.status.lastProblem = 'CI 红了';
  // 老历史重放：标记不在，patched 为假，不调度读评审，返工意见和原来一样只有 CI 这几行。
  if (!patched('ci-red-review-context')) return 'rework';
  const snap = await rt.step('readCiReviews', () =>
    rt.acts.readCiReviews({
      schemaVersion: 1,
      taskId: rt.input.taskId,
      repo: rt.input.repo,
      prNumber,
      branch: rt.branch,
      expectedHead: head,
    }),
  );
  if (!snap.delivered) {
    await rt.park('正式评审未核实、未交付', `${snap.reason}\nCI 仍是红的，不放行。\n${ciLines.join('\n')}`);
    if (snap.headMoved) rt.head = snap.headMoved;
    rt.feedback = [];
    return 'stay';
  }
  if (snap.head !== head) {
    await rt.park(
      '正式评审未核实、未交付',
      `读回的头 ${snap.head} 不是 CI 红的 ${head}，未核实、未交付。\nCI 仍是红的，不放行。\n${ciLines.join('\n')}`,
    );
    rt.feedback = [];
    return 'stay';
  }
  if (snap.reviews.length === 0) return 'rework';
  const keyOf = (review: ReviewChange) => reviewKey(prNumber, review);
  const lines = snap.reviews.flatMap((review) =>
    reviewFeedbackLines(review, head, rt.reviewsHanded.has(keyOf(review))),
  );
  rt.feedback = [...ciLines, ...lines];
  const fresh = snap.reviews.filter((review) => !rt.reviewsHanded.has(keyOf(review)));
  for (const review of fresh) rt.reviewsHanded.set(keyOf(review), head);
  log.info('CI 红返工带上仍有效的正式评审', {
    taskId: rt.input.taskId,
    prNumber,
    head,
    handed: fresh.map((review) => ({
      reviewId: review.reviewId,
      reviewer: review.reviewer,
      commitId: review.commitId,
    })),
    reminded: snap.reviews.filter((review) => !fresh.includes(review)).map((review) => review.reviewId),
  });
  return 'rework';
}
