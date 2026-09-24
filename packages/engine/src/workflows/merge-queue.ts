// 合并队列：每个仓一条，一次只合一个。合之前把最新主线并进分支、在新头上重跑测试，红了退回子任务。
// 由子任务的 enqueueMerge 活动 signalWithStart 拉起；空闲一阵就收工，攒够一批换一次历史（continue-as-new）。
// 撤出（子任务暂停、要等人批准、叫停）一定回话：还没开始合的当场回 withdrawn；正在合的等那一步做完，合上了回 merged。

import {
  allHandlersFinished,
  condition,
  continueAsNew,
  getExternalWorkflowHandle,
  isCancellation,
  log,
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
import { activitiesFor, failureOf, judgeRetrying, limitsFor } from './kit.ts';

const RECENT_KEPT = 50;
/** 判断连着出错几次报警（之后照样退避着试，修好代码换上新工人就接着合）。 */
const ALERT_AFTER_FAILURES = 3;

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
  /** 记下结果（子任务等太久重排、重复撤出时补发），再送过去。 */
  const answer = async (item: MergeItem, result: MergeResult) => {
    const delivery = { subtaskWorkflowId: item.subtaskWorkflowId, result };
    recent = [...recent.filter((d) => d.result.itemId !== result.itemId), delivery].slice(-RECENT_KEPT);
    await deliver(delivery);
  };

  setHandler(enqueueSignal, async (item) => {
    const done = recent.find((d) => d.result.itemId === item.itemId);
    if (done) return deliver(done);
    if (current?.item.itemId === item.itemId || queue.some((q) => q.itemId === item.itemId)) return;
    queue.push(item);
  });
  setHandler(withdrawSignal, async ({ itemId, subtaskWorkflowId }) => {
    const index = queue.findIndex((q) => q.itemId === itemId);
    if (index >= 0) {
      const [item] = queue.splice(index, 1);
      if (item) await answer(item, { itemId, outcome: 'withdrawn' });
      return;
    }
    if (current?.item.itemId === itemId) {
      current.withdrawn = true;
      // 还没开始合：当场确认——之后不会再去合（handleItem 每步都先看撤没撤）。正在合的等那一步做完再回话。
      if (current.step !== 'merge' && !current.answered) {
        current.answered = true;
        await answer(current.item, { itemId, outcome: 'withdrawn' });
      }
      return;
    }
    const done = recent.find((d) => d.result.itemId === itemId);
    if (done) return deliver(done);
    // 没见过这一条（还没排进来、或者早就处理完了记录已经轮掉）：没有谁会再合它。
    await deliver({ subtaskWorkflowId, result: { itemId, outcome: 'withdrawn' } });
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
          tests = await acts.runTests({
            ...scope,
            repo: item.repo,
            prNumber: item.prNumber,
            branch: item.branch,
            head: step.head,
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
    const hasWork = await condition(() => queue.length > 0, `${limits.mergeQueueIdleMinutes} minutes`);
    if (!hasWork) {
      // 收工前把正在回话的送完（撤出确认、补发结果）。
      await condition(allHandlersFinished);
      if (queue.length === 0) return { processed };
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
      await answer(item, result);
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
