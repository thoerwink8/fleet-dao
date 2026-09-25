// 子任务工作流：建工作树 → 执行（AI 会话，只在本地提交）→ 引擎推分支、开 PR → 验证（同步主线 + 等 CI ∥ 全新会话第二意见；
// 意见回主会话）→ 人闸（带人闸标记的等人批准）→ 进合并队列。需求工作流以子工作流起它；也能单独起（没有上级就不发进度信号）。
// 编号是 subtaskWorkflowId(subtasks.id)：驾驶舱后端可以直接给它发信号（fleet 叫醒、批准、回答……）。

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
  type ApprovalCommand,
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
import { describeHolds, normalizeHolds } from '../holds.ts';
import type { SessionBrief, Worktree } from '../ports.ts';
import {
  activitiesFor,
  attempt,
  attemptOrRework,
  type Control,
  gate,
  installControl,
  iso,
  judge,
  type Kit,
  limitsFor,
  NO_REWORK,
  newId,
  newKit,
  offClockMs,
  park,
  type ReworkCarry,
  runStage,
  stopActiveSessions,
  type Verdict,
  waitFor,
} from './kit.ts';

type Next = 'execute' | 'verify' | 'merge' | 'done';

/** 叫停收尾时等合并队列确认撤出多久：队列正在合的要等那一步做完（合并是秒级的），其余当场确认。 */
const STOP_WITHDRAW_MINUTES = 10;

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
    holds: normalizeHolds(sub.holds),
    approval: null,
    lastProblem: null,
    lastAgentEvent: null,
    commands: [],
  };

  // 信号处理器挂上时会当场处理缓存着的信号：它们要用的东西都得先声明好（control、kit 在那时还可能是 null）。
  let controlRef: Control | null = null;
  let kitRef: Kit | null = null;
  let lastSent = '';
  const notifyParent = () => {
    const parent = info.parent;
    if (!parent) return;
    const progress: SubtaskProgress = {
      key: sub.key,
      state: status.state,
      prNumber: status.prNumber,
      paused: controlRef?.paused ?? false,
      waiting: status.waiting,
      holds: status.holds,
    };
    const text = JSON.stringify(progress);
    if (text === lastSent) return;
    lastSent = text;
    CancellationScope.nonCancellable(() =>
      getExternalWorkflowHandle(parent.workflowId).signal(subtaskProgressSignal, progress),
    ).catch((error) => log.warn('进度没送到需求工作流', { error: String(error) }));
  };

  const decideApproval = (command: ApprovalCommand, state: 'approved' | 'rejected'): Verdict => {
    if (command.subtaskId && command.subtaskId !== input.subtaskId) {
      return { accepted: false, note: `点名的是别的子任务（${command.subtaskId}）` };
    }
    const pending = status.approval;
    if (pending?.state !== 'pending') return { accepted: false, note: '没有在等批准' };
    if (command.approvalId && command.approvalId !== pending.approvalId) {
      return { accepted: false, note: `批准编号对不上：在等的是 ${pending.approvalId}` };
    }
    status.approval = {
      ...pending,
      state,
      ...(command.by ? { by: command.by } : {}),
      ...(command.reason ? { reason: command.reason } : {}),
      at: iso(Date.now()),
    };
    return {
      accepted: true,
      note:
        state === 'approved'
          ? `批准（${describeHolds(pending.holds)}），进合并队列`
          : `拒绝，退回返工${command.reason ? `：${command.reason}` : ''}`,
    };
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
    ownsRun: (runId) => Boolean(kitRef?.active[runId]),
    approve: (command) => decideApproval(command, 'approved'),
    reject: (command) => decideApproval(command, 'rejected'),
    requireApproval: (command) => {
      if (command.subtaskId && command.subtaskId !== input.subtaskId) {
        return { accepted: false, note: `点名的是别的子任务（${command.subtaskId}）` };
      }
      const holds = normalizeHolds([...status.holds, ...(command.holds ?? [])]);
      if (holds.length === status.holds.length) {
        return { accepted: false, note: command.holds?.length ? '这些人闸已经有了' : '没给要拦的事' };
      }
      status.holds = holds;
      notifyParent();
      return { accepted: true, note: `加人闸：${describeHolds(holds)}（合并前等人批）` };
    },
  });
  controlRef = control;
  setHandler(subtaskStatusQuery, () => ({
    ...status,
    paused: control.paused,
    parked: control.parked,
    lastAgentEvent: control.lastAgentEvent,
    commands: [...control.commands],
  }));

  const setStep = (step: SubtaskStep, state: SubtaskState, doing: string) => {
    status.step = step;
    status.state = state;
    status.doing = doing;
    notifyParent();
  };

  const limits = await limitsFor(input.limits);
  const acts = activitiesFor(limits);
  const kit = newKit({
    acts,
    limits,
    control,
    scope: { taskId: input.taskId, subtaskId: input.subtaskId, subtaskKey: sub.key },
    view: status,
    onChange: notifyParent,
  });
  kitRef = kit;

  let worktree: Worktree | null = null;
  let pendingItemId: string | null = null;
  let mergeAttempt = 0;
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

  /** 这个头批过了吗（批的时候的人闸要盖住现在的全部人闸：之后又加了的，要重新批）。 */
  const approvedFor = (head: string) => {
    const a = status.approval;
    return a?.state === 'approved' && a.head === head && status.holds.every((h) => a.holds.includes(h));
  };
  const needsApproval = (head: string) => status.holds.length > 0 && !approvedFor(head);

  /** 人闸：发卡请人批（编号先定好进历史，发卡重试只有一张卡），等批准或拒绝。拒了回返工意见，批了回 null。 */
  const awaitApproval = async (prNumber: number, head: string): Promise<Feedback[] | null> => {
    const approvalId = await newId(kit);
    const holds = [...status.holds];
    const what = describeHolds(holds);
    status.approval = { approvalId, holds, head, state: 'pending' };
    setStep('merge', 'verifying', `等人批准（${what}）`);
    await waitFor(
      kit,
      'human',
      `等人批准：${what}（PR #${prNumber}）`,
      async () => {
        await attempt(kit, 'requestApproval', () =>
          acts.requestApproval({
            ...kit.scope,
            approvalId,
            holds,
            repo: input.repo,
            prNumber,
            head,
            title: sub.title,
            summary,
          }),
        );
        await condition(() => status.approval?.state !== 'pending');
      },
      { approvalId },
    );
    const decided = status.approval;
    if (decided?.state !== 'rejected') return null;
    return [
      {
        kind: 'review',
        summary: `人没批（${what}）：${decided.reason ?? '没写理由'}`,
        items: decided.reason ? [decided.reason] : [],
      },
    ];
  };

  /**
   * 撤出：送到队列，它记下撤回、回一句话（撤回，或撤出前已经合上/退回了）。送到了回 true，两条路都送不到回 false。
   * 队列没在跑时直接发的信号送不到，但排队的那一下可能还在路上：排队的活动不心跳、收不到叫停，服务端到了这次尝试的限时
   * 就判它超时、让这里收尾，代码却可能还卡着、事后才发（真服务端上实测过：卡完把队列拉起来照合）。所以改经活动
   * signalWithStart 送：顺手把队列拉起来记下撤回，晚到的排队被挡回去。队列收到信号就从头再等一个空闲期，撤回至少留这么久；
   * 排队那一下带着这次尝试的截止时间，拖不了这么久。
   */
  const sendWithdraw = async (itemId: string): Promise<boolean> => {
    const withdraw = { itemId, subtaskWorkflowId: info.workflowId };
    try {
      await getExternalWorkflowHandle(mergeQueueWorkflowId(input.repo)).signal(withdrawSignal, withdraw);
      return true;
    } catch (error) {
      if (isCancellation(error)) throw error;
      log.info('合并队列没在跑，撤出改经活动送去', { itemId, error: String(error) });
    }
    try {
      await acts.withdrawMerge({ repo: input.repo, ...withdraw, limits: input.limits ?? {} });
      return true;
    } catch (error) {
      if (isCancellation(error)) throw error;
      log.warn('撤出没送到合并队列', { itemId, error: String(error) });
      return false;
    }
  };

  /** 暂停、新加人闸时撤出合并队列：一直等到队列确认（撤出了，或撤出前已经合上/退回了）。 */
  const withdrawUntilConfirmed = (itemId: string): Promise<MergeResult | null> =>
    waitFor(kit, 'merge-queue', '撤出合并队列，等队列确认', async () => {
      for (;;) {
        if (!(await sendWithdraw(itemId))) return mergeResults[itemId] ?? null;
        if (await condition(() => itemId in mergeResults, `${limits.mergeWaitMinutes} minutes`)) {
          return mergeResults[itemId] ?? null;
        }
      }
    });

  /** 排进合并队列等结果。暂停了、或新加了人闸要等批准：还没合的撤出来，回 null（回头过暂停门、人闸再排）。 */
  const viaMergeQueue = async (prNumber: number, head: string): Promise<MergeResult | null> => {
    await gate(kit);
    mergeAttempt += 1;
    const item: MergeItem = {
      itemId: `${info.workflowId}#${mergeAttempt}`,
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
    const interrupted = () => control.paused || needsApproval(head);
    for (;;) {
      await attempt(kit, 'enqueueMerge', () => acts.enqueueMerge({ item, limits: input.limits ?? {} }));
      await waitFor(kit, 'merge-queue', `PR #${prNumber} 在合并队列里`, () =>
        condition(() => item.itemId in mergeResults || interrupted(), `${limits.mergeWaitMinutes} minutes`),
      );
      const answered = mergeResults[item.itemId];
      if (answered) {
        pendingItemId = null;
        return answered;
      }
      if (interrupted()) {
        const confirmed = await withdrawUntilConfirmed(item.itemId);
        pendingItemId = null;
        return confirmed && confirmed.outcome !== 'withdrawn' ? confirmed : null;
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
    let offPlan = 0;
    let pushRework: ReworkCarry = NO_REWORK;
    // 墙钟预算：从开工算起，等人（暂停、挂起、回答、批准）和排队（空位、额度、合并队列）的时间不算；
    // 人看过（挂起后被放行）就重新计。
    let budget = { since: Date.now(), off: offClockMs(kit) };
    const workedMinutes = () => (Date.now() - budget.since - (offClockMs(kit) - budget.off)) / 60_000;
    const parkAndReset = async (reason: string, detail: string) => {
      await park(kit, reason, detail);
      budget = { since: Date.now(), off: offClockMs(kit) };
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
        const delivery = await judge(kit, 'delivery', {
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
        // 会话只在本地提交；推分支、开 PR 由引擎在会话外面做。推之前的卫生检查拦下了会话交的内容：退回会话拿掉再交
        // （同一处连续被拦两次挂起报警，失败分流 HY1）；名单没读到、没扫成是这一侧的问题，挂起报警、不退会话（HY2）。
        const pushedOrRework = await attemptOrRework(
          kit,
          'pushBranch',
          () =>
            acts.pushBranch({
              ...kit.scope,
              repo: input.repo,
              worktreePath: tree.path,
              branch,
              head: exec.output.head,
            }),
          pushRework,
        );
        if ('rework' in pushedOrRework) {
          pushRework = pushedOrRework.rework.carry;
          status.lastProblem = pushedOrRework.rework.reason;
          feedback = [
            {
              kind: 'hygiene',
              summary:
                '推之前的卫生检查拦下了你交的内容：公开仓推上去就公开了。把这些从提交里拿掉——要改写提交（推上去的是全部提交），不能只加一个删掉它的新提交',
              items: [pushedOrRework.rework.message],
            },
          ];
          continue;
        }
        pushRework = NO_REWORK;
        const pushed = pushedOrRework.ok;
        status.head = pushed.head;
        if (status.prNumber === null) {
          const changedFiles = exec.output.changedFiles;
          const pr = await attempt(kit, 'openPr', () =>
            acts.openPr({
              ...kit.scope,
              repo: input.repo,
              branch,
              head: pushed.head,
              title: sub.title,
              // 正文由 github 包的 renderPrBody 按 PR 模板的栏目生成；这里只给结构。「对应计划」「specs」两栏
              // （#41）里的对应计划由端口开 PR 时去主线的需求文档里现读那一行，读不到就不开、挂起报警。
              body: {
                requirement: input.issueNumber,
                subtask: `${sub.key} ${sub.title}`,
                did: summaryItems(summary),
                verified: [
                  exec.output.testsPassed
                    ? '会话里跑过测试，报通过（fleet done --tests passed）'
                    : '会话报测试没过（fleet done --tests failed）',
                  '合并前在最新主线上再等 CI（合并队列）',
                ],
                specs: input.specDir,
                changedFiles: changedFiles ?? [],
                ...(changedFiles ? {} : { owed: ['改了哪些文件没查成（交付没带文件清单）'] }),
              },
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
        const verdict = await judge(kit, 'verify', {
          sync,
          ci,
          review,
          reviewRequired: sub.secondOpinion && sync.state === 'clean',
          rounds: status.rounds,
          limits,
          lastFingerprints: fingerprints,
          elapsedMinutes: workedMinutes(),
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

      // 合并：先过人闸（带人闸标记的等人批），再进合并队列。
      if (needsApproval(verifiedHead)) {
        const rejected = await awaitApproval(prNumber, verifiedHead);
        if (rejected) {
          status.lastProblem = rejected[0]?.summary ?? '人没批';
          feedback = rejected;
          next = 'execute';
        }
        continue;
      }
      setStep('merge', 'in_merge_queue', '在合并队列里排队');
      const result = await viaMergeQueue(prNumber, verifiedHead);
      if (!result || result.outcome === 'withdrawn') continue;
      if (result.outcome === 'merged') {
        mergeCommit = result.mergeCommit;
        next = 'done';
        continue;
      }
      const after = await judge(kit, 'mergeReturn', {
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
    if (itemId && !(await sendWithdraw(itemId))) {
      problem = `${problem ?? '收尾'}；撤出没送到合并队列，PR #${status.prNumber} 要人核对有没有合上`;
    } else if (itemId) {
      // 等队列确认：撤出前已经合上的，如实记成合并了（不然合进主线的改动没人认）。
      await waitFor(kit, 'merge-queue', '撤出合并队列，等队列确认', () =>
        condition(() => itemId in mergeResults, `${STOP_WITHDRAW_MINUTES} minutes`),
      );
      const confirmed = mergeResults[itemId];
      if (confirmed?.outcome === 'merged') {
        outcome = 'merged';
        mergeCommit = confirmed.mergeCommit;
        problem = `${problem ?? '收尾'}时已经合进主线了`;
      } else if (!confirmed) {
        problem = `${problem ?? '收尾'}；合并队列 ${STOP_WITHDRAW_MINUTES} 分钟没确认撤出，PR #${status.prNumber} 要人核对有没有合上`;
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

/** 会话交活时的总结 → PR 正文「做了什么」的几条：按换行、分号切，去掉列表记号，最多 5 条。 */
function summaryItems(summary: string): string[] {
  return summary
    .split(/\r?\n|；|;/)
    .map((line) => line.replace(/^[\s\-*•]+/, '').trim())
    .filter(Boolean)
    .slice(0, 5);
}
