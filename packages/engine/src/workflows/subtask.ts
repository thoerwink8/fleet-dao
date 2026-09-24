// 子任务工作流：建工作树 → 执行（AI 会话，只在本地提交）→ 引擎推分支、开 PR → 验证（同步主线 + 等 CI ∥ 全新会话第二意见；
// 意见回主会话）→ 进合并队列。需求工作流以子工作流起它；也能单独起（没有上级就不发进度信号）。

import type { SubtaskState } from '@fleet-dao/shared';
import {
  CancellationScope,
  condition,
  getExternalWorkflowHandle,
  isCancellation,
  log,
  setHandler,
  sleep,
  TemporalFailure,
  workflowInfo,
} from '@temporalio/workflow';
import {
  type MergeItem,
  type MergeResult,
  mergeQueueWorkflowId,
  mergeResultSignal,
  type SubtaskInput,
  type SubtaskProgress,
  type SubtaskResult,
  type SubtaskStatus,
  type SubtaskStep,
  subtaskBranch,
  subtaskProgressSignal,
  subtaskStatusQuery,
  withdrawSignal,
} from '../contract.ts';
import type { Feedback, ReviewResult } from '../decisions/verify.ts';
import type { SessionBrief, Worktree } from '../ports.ts';
import {
  activitiesFor,
  attempt,
  decide,
  installControl,
  newKit,
  park,
  runStage,
  stopActiveSessions,
  waitFor,
} from './kit.ts';

type Next = 'execute' | 'verify' | 'merge' | 'done';

export async function subtaskWorkflow(input: SubtaskInput): Promise<SubtaskResult> {
  const info = workflowInfo();
  const sub = input.subtask;
  const branch = subtaskBranch(input.issueNumber, sub.key);
  const status: SubtaskStatus = {
    kind: 'subtask',
    taskId: input.taskId,
    subtaskId: input.subtaskId,
    key: sub.key,
    title: sub.title,
    state: 'pending',
    step: 'worktree',
    doing: '准备开工',
    paused: false,
    parked: false,
    waiting: null,
    route: null,
    runId: null,
    sessionId: null,
    prNumber: null,
    head: null,
    rounds: { review: 0, ciFix: 0, conflict: 0, mergeReturn: 0 },
    lastProblem: null,
    lastAgentEvent: null,
    commands: [],
  };

  // 具体的信号处理先挂，再挂兜底处理（兜底处理一挂上就会吃掉还没有处理器的缓存信号）。
  const mergeResults: Record<string, MergeResult> = {};
  setHandler(mergeResultSignal, (result) => {
    mergeResults[result.itemId] = result;
  });
  const main = new CancellationScope();
  const control = installControl(input.routeOverrides, {
    onStop: () => main.cancel(),
    mainStages: [sub.stage],
    selfSubtaskId: input.subtaskId,
  });
  setHandler(subtaskStatusQuery, () => ({
    ...status,
    paused: control.paused,
    parked: control.parked,
    lastAgentEvent: control.lastAgentEvent,
    commands: [...control.commands],
  }));

  let lastSent = '';
  const notifyParent = () => {
    const parent = info.parent;
    if (!parent) return;
    const progress: SubtaskProgress = {
      key: sub.key,
      state: status.state,
      prNumber: status.prNumber,
      paused: control.paused,
      waiting: status.waiting,
      runId: status.runId,
    };
    const text = JSON.stringify(progress);
    if (text === lastSent) return;
    lastSent = text;
    CancellationScope.nonCancellable(() =>
      getExternalWorkflowHandle(parent.workflowId).signal(subtaskProgressSignal, progress),
    ).catch((error) => log.warn('进度没送到需求工作流', { error: String(error) }));
  };
  const setStep = (step: SubtaskStep, state: SubtaskState, doing: string) => {
    status.step = step;
    status.state = state;
    status.doing = doing;
    notifyParent();
  };

  const limits = await decide('limits', input.limits ?? {});
  const acts = activitiesFor(limits);
  const kit = newKit({
    acts,
    limits,
    control,
    scope: { taskId: input.taskId, subtaskId: input.subtaskId, subtaskKey: sub.key },
    view: status,
    onChange: notifyParent,
  });

  let worktree: Worktree | null = null;
  let pendingItemId: string | null = null;
  let summary = '';
  let mergeCommit: string | null = null;

  const brief = (feedback: Feedback[], extra: Partial<SessionBrief> = {}): SessionBrief => ({
    title: sub.title,
    request: sub.title,
    specDir: input.specDir,
    acceptance: sub.acceptance,
    touches: sub.touches,
    feedback,
    answers: [],
    branch,
    ...extra,
  });

  const secondOpinion = async (prNumber: number, head: string): Promise<ReviewResult> => {
    // 每一轮都是全新会话，不续上一轮的审查。
    const review = await runStage(kit, {
      stage: 'review',
      expect: 'review',
      brief: brief([], { prNumber, head }),
    });
    return review.output.review;
  };

  const viaMergeQueue = async (prNumber: number, head: string, n: number): Promise<MergeResult> => {
    const item: MergeItem = {
      itemId: `${info.workflowId}#${n}`,
      subtaskWorkflowId: info.workflowId,
      taskId: input.taskId,
      subtaskId: input.subtaskId,
      subtaskKey: sub.key,
      repo: input.repo,
      prNumber,
      branch,
      head,
      enqueuedAt: new Date().toISOString(),
    };
    pendingItemId = item.itemId;
    for (;;) {
      await attempt(kit, 'enqueueMerge', () => acts.enqueueMerge({ item, limits: input.limits ?? {} }));
      const answered = await waitFor(kit, 'merge-queue', `PR #${prNumber} 在合并队列里`, () =>
        condition(() => item.itemId in mergeResults, `${limits.mergeWaitMinutes} minutes`),
      );
      const result = mergeResults[item.itemId];
      if (answered && result) {
        pendingItemId = null;
        return result;
      }
      // 太久没回话：再排一次（队列按条目编号去重，已经有结果的会补发）。
    }
  };

  const run = async (): Promise<void> => {
    setStep('worktree', 'running', '建工作树、装依赖');
    const tree = await attempt(kit, 'createWorktree', () =>
      acts.createWorktree({ ...kit.scope, repo: input.repo, branch }),
    );
    worktree = tree;
    let sessionId: string | undefined;
    let feedback: Feedback[] = [];
    let fingerprints: { ci?: string; review?: string } = {};
    let verifiedHead = '';
    let mergeAttempt = 0;
    let offPlan = 0;
    // 墙钟预算从开工算起；人看过（挂起后被放行）就重新计。
    let budgetStart = Date.now();
    const parkAndReset = async (reason: string, detail: string) => {
      await park(kit, reason, detail);
      budgetStart = Date.now();
    };
    let next: Next = 'execute';
    while (next !== 'done') {
      if (next === 'execute') {
        setStep('execute', 'running', feedback[0] ? `返工：${feedback[0].summary}` : '写码');
        const exec = await runStage(kit, {
          stage: sub.stage,
          expect: 'delivery',
          brief: brief(feedback),
          resumeSessionId: sessionId,
          worktreePath: tree.path,
          baseHead: status.head ?? tree.baseSha,
        });
        sessionId = exec.sessionId;
        summary = exec.output.summary;
        // 交付对账：改的文件和方案点名的地方一个都对不上，就是假完成，不推也不进验证。
        const delivery = await decide('delivery', {
          touches: sub.touches,
          changedFiles: exec.output.changedFiles,
          offPlanSoFar: offPlan,
          limits,
        });
        if (delivery.action === 'rework') {
          offPlan += 1;
          status.lastProblem = delivery.reason;
          feedback = delivery.feedback;
          continue;
        }
        if (delivery.action === 'escalate') {
          await parkAndReset(delivery.reason, delivery.detail);
          offPlan = 0;
          feedback = [
            { kind: 'plan', summary: `人看过后接着干：${delivery.reason}`, items: [delivery.detail] },
          ];
          continue;
        }
        if (delivery.note) status.lastProblem = delivery.note;
        // 会话只在本地提交；推分支、开 PR 由引擎在会话外面做。
        const pushed = await attempt(kit, 'pushBranch', () =>
          acts.pushBranch({
            ...kit.scope,
            repo: input.repo,
            worktreePath: tree.path,
            branch,
            head: exec.output.head,
          }),
        );
        status.head = pushed.head;
        if (status.prNumber === null) {
          const pr = await attempt(kit, 'openPr', () =>
            acts.openPr({
              ...kit.scope,
              repo: input.repo,
              branch,
              head: pushed.head,
              title: sub.title,
              body: `需求 #${input.issueNumber} 的子任务「${sub.key}」\n\n${summary}`,
            }),
          );
          status.prNumber = pr.prNumber;
          notifyParent();
        }
        next = 'verify';
        continue;
      }

      const prNumber = status.prNumber;
      if (prNumber === null) throw new Error('走到验证却没有 PR');

      if (next === 'verify') {
        setStep('verify', 'verifying', '同步主线、等 CI、第二意见');
        const head = status.head ?? '';
        const sync = await attempt(kit, 'syncMainline', () =>
          acts.syncMainline({
            ...kit.scope,
            repo: input.repo,
            prNumber,
            branch,
            head,
            worktreePath: tree.path,
          }),
        );
        status.head = sync.head;
        const [ci, review] =
          sync.state === 'clean'
            ? await Promise.all([
                attempt(kit, 'waitCi', () =>
                  acts.waitCi({ ...kit.scope, repo: input.repo, prNumber, head: sync.head }),
                ),
                sub.secondOpinion ? secondOpinion(prNumber, sync.head) : Promise.resolve(null),
              ])
            : [null, null];
        const verdict = await decide('verify', {
          sync,
          ci,
          review,
          reviewRequired: sub.secondOpinion && sync.state === 'clean',
          rounds: status.rounds,
          limits,
          lastFingerprints: fingerprints,
          elapsedMinutes: (Date.now() - budgetStart) / 60_000,
        });
        if (verdict.action === 'merge') {
          verifiedHead = sync.head;
          next = 'merge';
        } else if (verdict.action === 'rework') {
          status.rounds = { ...status.rounds, [verdict.count]: status.rounds[verdict.count] + 1 };
          if (verdict.count === 'ciFix') fingerprints = { ...fingerprints, ci: verdict.fingerprint };
          if (verdict.count === 'review') fingerprints = { ...fingerprints, review: verdict.fingerprint };
          status.lastProblem = verdict.reason;
          feedback = verdict.feedback;
          next = 'execute';
        } else {
          await parkAndReset(verdict.reason, verdict.detail);
          // 人（或帅位）看过了：计数清零，带着上一轮的问题再干一轮。
          status.rounds = { ...status.rounds, review: 0, ciFix: 0, conflict: 0 };
          fingerprints = {};
          feedback = [
            {
              kind: 'review',
              summary: `人看过后接着干：${verdict.reason}`,
              items: verdict.detail ? [verdict.detail] : [],
            },
          ];
          next = 'execute';
        }
        continue;
      }

      setStep('merge', 'in_merge_queue', '在合并队列里排队');
      mergeAttempt += 1;
      const result = await viaMergeQueue(prNumber, verifiedHead, mergeAttempt);
      if (result.outcome === 'merged') {
        mergeCommit = result.mergeCommit;
        next = 'done';
        continue;
      }
      const after = await decide('mergeReturn', {
        reason: result.reason,
        detail: result.detail,
        files: result.files,
        returnsSoFar: status.rounds.mergeReturn,
        limits,
      });
      status.rounds = { ...status.rounds, mergeReturn: status.rounds.mergeReturn + 1 };
      status.lastProblem = after.reason;
      if (after.action === 'requeue') {
        await waitFor(kit, 'retry', after.reason, () => sleep(`${after.delaySeconds} seconds`));
        next = 'merge';
      } else if (after.action === 'rework') {
        feedback = after.feedback;
        next = 'execute';
      } else {
        await parkAndReset(after.reason, after.detail);
        status.rounds = { ...status.rounds, mergeReturn: 0 };
        feedback = [
          { kind: 'merge-return', summary: `人看过后接着干：${after.reason}`, items: [after.detail] },
        ];
        next = 'execute';
      }
    }
  };

  let outcome: SubtaskResult['state'];
  let problem: string | null = null;
  try {
    await main.run(run);
    outcome = 'merged';
  } catch (error) {
    if (isCancellation(error)) {
      outcome = 'stopped';
      problem = '叫停';
    } else if (error instanceof TemporalFailure) {
      outcome = 'failed';
      problem = error.message;
    } else {
      // 代码错误：让工作流任务失败重试，修好代码、换上新工人就能接着跑。
      throw error;
    }
  }

  // 收尾不可取消：谁创建谁回收。收不掉只报警，不改结论。
  await CancellationScope.nonCancellable(async () => {
    status.step = 'cleanup';
    await stopActiveSessions(kit, problem ?? '收尾');
    status.runId = null;
    status.sessionId = null;
    const itemId = pendingItemId as string | null;
    if (itemId) {
      try {
        await getExternalWorkflowHandle(mergeQueueWorkflowId(input.repo)).signal(withdrawSignal, { itemId });
      } catch (error) {
        log.warn('撤出合并队列失败', { error: String(error) });
      }
    }
    const tree = worktree as Worktree | null;
    if (tree) {
      try {
        await acts.removeWorktree({
          ...kit.scope,
          repo: input.repo,
          path: tree.path,
          branch: tree.branch,
          archive: outcome !== 'merged',
        });
      } catch (error) {
        status.lastProblem = `工作树没收掉：${String(error)}`;
        await acts
          .raiseAlert({
            ...kit.scope,
            level: 'stuck',
            title: '工作树没收掉',
            detail: String(error),
            dedupeKey: `${info.workflowId}:worktree`,
          })
          .catch(() => undefined);
      }
    }
  });

  status.step = 'finished';
  status.state = outcome;
  status.waiting = null;
  status.doing = outcome === 'merged' ? '已合并' : outcome === 'stopped' ? '已叫停' : `失败：${problem}`;
  notifyParent();
  return {
    key: sub.key,
    subtaskId: input.subtaskId,
    state: outcome,
    prNumber: status.prNumber,
    mergeCommit,
    summary,
    problem,
    rounds: status.rounds,
  };
}
