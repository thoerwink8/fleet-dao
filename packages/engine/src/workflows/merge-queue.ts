// 合并队列：每个仓一条，一次只合一个。合之前把最新主线并进分支、在新头上重跑测试，红了退回子任务。
// 由子任务的 enqueueMerge 活动 signalWithStart 拉起；空闲一阵就收工，攒够一批换一次历史（continue-as-new）。
// 撤出（子任务暂停、要等人批准、叫停）一定回话：还没开始合的当场回 withdrawn；正在合的等那一步做完，合上了回 merged。
// 回过的话都记在 recent 里，撤回也记：排队信号比撤出晚到（排队的活动还在路上就叫停了），会被挡回去、不再排进来。
// 空闲计时从最后一个信号算起，刚记下的撤回至少留一个空闲期（mergeQueueIdleMinutes）。
// 这里是工作流代码：改调度顺序（多调、少调、换顺序调活动或 decide）要用 patched()，见 test/replay.test.ts
// 和 workflows/kit.ts 头注释——在途的合并队列条目换上新代码也得接得上老历史，不许重录夹具让它变绿。

import {
  allHandlersFinished,
  condition,
  continueAsNew,
  getExternalWorkflowHandle,
  isCancellation,
  log,
  patched,
  setHandler,
  workflowInfo,
} from '@temporalio/workflow';
import {
  type MergeResultDelivery as Delivery,
  enqueueSignal,
  type MergeItem,
  type MergeQueueInput,
  type MergeQueueResult,
  type MergeQueueStatus,
  type MergeResult,
  mergeQueueStatusQuery,
  mergeResultSignal,
  withdrawSignal,
} from '../contract.ts';
import type { MergeOutcome, MergeStep, MergeStepInput, TestResult } from '../decisions/merge.ts';
import type { SyncResult } from '../decisions/verify.ts';
import type { Scope } from '../ports.ts';
import { activitiesFor, failureOf, iso, judgeRetrying, limitsFor } from './kit.ts';

const RECENT_KEPT = 50;
/** 判断连着出错几次报警（之后照样退避着试，修好代码换上新工人就接着合）。 */
const ALERT_AFTER_FAILURES = 3;
/**
 * 合并前重跑测试改成按项目的流程配置读先审后合清单在哪（riskPathsFileForItem）：老历史里没有这一步多调的
 * flowConfig、decide 这两下，直接换上新代码重放会报「历史对不上」——在途的合并队列条目就得当僵尸终止。
 */
const RISK_PATHS_FILE_PATCH = 'merge-queue-risk-paths-file';

interface Entry {
  item: MergeItem;
  step: string;
  withdrawn: boolean;
  /** 已经回过话了（撤出当场确认过的，做完不再回）。 */
  answered: boolean;
}

export async function mergeQueueWorkflow(input: MergeQueueInput): Promise<MergeQueueResult> {
  const queue: MergeItem[] = [...(input.carried?.queue ?? [])];
  let recent: Delivery[] = [...(input.carried?.recent ?? [])];
  let processed = input.carried?.processed ?? 0;
  let processedThisRun = 0;
  let current: Entry | null = null;

  const deliver = async (delivery: Delivery) => {
    try {
      await getExternalWorkflowHandle(delivery.subtaskWorkflowId).signal(mergeResultSignal, delivery.result);
    } catch (error) {
      log.warn('合并结果没送到（子任务可能已经结束）', {
        itemId: delivery.result.itemId,
        error: String(error),
      });
    }
  };
  /** 记下结果（子任务等太久重排、重复撤出时补发；撤回挡住后到的排队），再送过去。 */
  const answer = async (subtaskWorkflowId: string, result: MergeResult) => {
    const delivery = { subtaskWorkflowId, result };
    recent = [...recent.filter((d) => d.result.itemId !== result.itemId), delivery].slice(-RECENT_KEPT);
    await deliver(delivery);
  };

  // 收到过几个信号（排队、撤出）：空闲计时从最后一个信号算起。
  let heard = 0;
  setHandler(enqueueSignal, async (item) => {
    heard += 1;
    // 回过话的（合上、退回、撤回）不再排：补发那句话。
    const done = recent.find((d) => d.result.itemId === item.itemId);
    if (done) return deliver(done);
    if (current?.item.itemId === item.itemId || queue.some((q) => q.itemId === item.itemId)) return;
    queue.push(item);
  });
  setHandler(withdrawSignal, async ({ itemId, subtaskWorkflowId }) => {
    heard += 1;
    const index = queue.findIndex((q) => q.itemId === itemId);
    if (index >= 0) {
      const [item] = queue.splice(index, 1);
      if (item) await answer(item.subtaskWorkflowId, { itemId, outcome: 'withdrawn' });
      return;
    }
    if (current?.item.itemId === itemId) {
      current.withdrawn = true;
      // 还没开始合：当场确认——之后不会再去合（handleItem 每步都先看撤没撤）。正在合的等那一步做完再回话。
      if (current.step !== 'merge' && !current.answered) {
        current.answered = true;
        await answer(current.item.subtaskWorkflowId, { itemId, outcome: 'withdrawn' });
      }
      return;
    }
    const done = recent.find((d) => d.result.itemId === itemId);
    if (done) return deliver(done);
    // 没见过这一条：排队信号可能还在路上（排队的活动还没做完就叫停了）。记下撤回，它后到也会被挡回去。
    await answer(subtaskWorkflowId, { itemId, outcome: 'withdrawn' });
  });
  setHandler(
    mergeQueueStatusQuery,
    (): MergeQueueStatus => ({
      kind: 'merge-queue',
      repo: `${input.repo.owner}/${input.repo.name}`,
      current: current
        ? {
            itemId: current.item.itemId,
            prNumber: current.item.prNumber,
            subtaskKey: current.item.subtaskKey,
            step: current.step,
          }
        : null,
      queue: queue.map((q) => ({ itemId: q.itemId, prNumber: q.prNumber, subtaskKey: q.subtaskKey })),
      processed,
    }),
  );

  const limits = await limitsFor(input.limits);
  const acts = activitiesFor(limits);
  const repoName = `${input.repo.owner}/${input.repo.name}`;
  const judgeStep = (stepInput: MergeStepInput): Promise<MergeStep> =>
    judgeRetrying('mergeStep', stepInput, {
      alertAfter: ALERT_AFTER_FAILURES,
      alert: async (message) => {
        try {
          await acts.raiseAlert({
            taskId: current?.item.taskId ?? '',
            level: 'stuck',
            title: `${repoName} 的合并队列判断出错，卡住了`,
            detail: message,
            dedupeKey: `${workflowInfo().workflowId}:decide`,
          });
        } catch (error) {
          if (isCancellation(error)) throw error;
          log.warn('报警没发出去', { error: String(error) });
        }
      },
    });

  /**
   * 判「合并闸红是不是只缺 second-opinion」要知道这个项目声明的先审后合清单在哪（没声明就不查，见 runTests 里的
   * 判法）；和 Fusion 任务读的是同一份副本、同一份判法（core 的 riskPathsFileFor），不各写一份走岔。副本认不出、
   * 太久没同步成、活动读不到：这里不当基础设施出错把整个条目退回子任务——查不出就等于「这一次不查」，落到
   * runTests 里没声明的老路（按真红处理）。宁可偶尔把还在等第二意见的合并闸红错当真红多退一轮，也不能让合并
   * 队列卡在读配置这一步上（写死一份清单、读不到就抛错断流程是 #429 那次教训；反过来在这一步抛错卡住条目是
   * 同一类坑，不能反着再踩一次）。
   */
  const riskPathsFileForItem = async (scope: Scope): Promise<{ riskPathsFile?: string }> => {
    try {
      const flow = await acts.flowConfig({ ...scope });
      const risk = await judgeRetrying('riskPathsFileFor', { read: flow, now: iso(Date.now()) });
      if (!risk.ok) {
        log.warn('先审后合清单的路径判不出，这一次不查（照真红处理）', { why: risk.why });
        return {};
      }
      return risk.riskPathsFile !== undefined ? { riskPathsFile: risk.riskPathsFile } : {};
    } catch (error) {
      if (isCancellation(error)) throw error;
      log.warn('先审后合清单的路径读不到，这一次不查（照真红处理）', { error: String(error) });
      return {};
    }
  };

  const handleItem = async (entry: Entry): Promise<MergeResult> => {
    const { item } = entry;
    const scope = { taskId: item.taskId, subtaskId: item.subtaskId, subtaskKey: item.subtaskKey };
    let sync: SyncResult | null = null;
    let tests: TestResult | null = null;
    let merge: MergeOutcome | null = null;
    let failed: { step: string; message: string } | null = null;
    for (;;) {
      const withdrawn = entry.withdrawn;
      const step = await judgeStep({ withdrawn, sync, tests, merge, failed });
      // 判断的那一会儿撤出了：按撤出重判——已经确认撤出的，绝不能再去合。
      if (entry.withdrawn !== withdrawn) continue;
      if (step.next === 'done') {
        if (step.result === 'withdrawn') return { itemId: item.itemId, outcome: 'withdrawn' };
        if (step.result === 'merged')
          return { itemId: item.itemId, outcome: 'merged', mergeCommit: step.mergeCommit };
        return {
          itemId: item.itemId,
          outcome: 'returned',
          reason: step.reason,
          detail: step.detail,
          files: step.files,
        };
      }
      entry.step = step.next;
      try {
        if (step.next === 'sync') {
          sync = await acts.syncMainline({
            ...scope,
            repo: item.repo,
            prNumber: item.prNumber,
            branch: item.branch,
            head: item.head,
          });
        } else if (step.next === 'test') {
          // patched() 本身也要记进历史、调用次数不能跟着分支变，所以先问一次存起来（老历史没打过这个标记，
          // 一直走没有 riskPathsFile 的老路；见 kit.ts 头注释、fusion.ts 里 second-opinion 那几个 PATCH 的用法）。
          const riskPathsFileOn = patched(RISK_PATHS_FILE_PATCH);
          tests = await acts.runTests({
            ...scope,
            repo: item.repo,
            prNumber: item.prNumber,
            branch: item.branch,
            head: step.head,
            ...(riskPathsFileOn ? await riskPathsFileForItem(scope) : {}),
          });
        } else {
          merge = await acts.mergePr({
            ...scope,
            repo: item.repo,
            prNumber: item.prNumber,
            expectedHead: step.head,
          });
        }
      } catch (error) {
        if (isCancellation(error)) throw error;
        failed = { step: step.next, message: failureOf(error, step.next).message };
      }
    }
  };

  for (;;) {
    const heardBefore = heard;
    await condition(
      () => queue.length > 0 || heard !== heardBefore,
      `${limits.mergeQueueIdleMinutes} minutes`,
    );
    if (queue.length === 0) {
      // 空闲计时从最后一个信号算起：刚记下的撤回至少再留一个空闲期，快收工时来的撤回也挡得住晚到的排队。
      if (heard !== heardBefore) continue;
      // 收工前把正在回话的送完（撤出确认、补发结果）；这期间又来了信号就接着等。
      await condition(allHandlersFinished);
      if (queue.length === 0 && heard === heardBefore) return { processed };
      continue;
    }
    const item = queue.shift();
    if (!item) continue;
    const entry: Entry = { item, step: 'sync', withdrawn: false, answered: false };
    current = entry;
    const result = await handleItem(entry);
    current = null;
    if (!entry.answered) {
      entry.answered = true;
      await answer(item.subtaskWorkflowId, result);
    }
    processed += 1;
    processedThisRun += 1;
    if (processedThisRun >= limits.mergeQueueBatch || workflowInfo().continueAsNewSuggested) {
      await condition(allHandlersFinished);
      return await continueAsNew<typeof mergeQueueWorkflow>({
        ...input,
        carried: { queue, processed, recent },
      });
    }
  }
}
