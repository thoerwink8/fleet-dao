// 合并队列：每个仓一条，一次只合一个。合之前把最新主线并进分支、在新头上重跑测试，红了退回子任务。
// 由子任务的 enqueueMerge 活动 signalWithStart 拉起；空闲一阵就收工，攒够一批换一次历史（continue-as-new）。

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
import type { MergeOutcome, MergeStep, TestResult } from '../decisions/merge.ts';
import type { SyncResult } from '../decisions/verify.ts';
import { activitiesFor, decide, failureOf } from './kit.ts';

const RECENT_KEPT = 50;

export async function mergeQueueWorkflow(input: MergeQueueInput): Promise<MergeQueueResult> {
  const queue: MergeItem[] = [...(input.carried?.queue ?? [])];
  let recent: Delivery[] = [...(input.carried?.recent ?? [])];
  const resend: Delivery[] = [];
  let processed = input.carried?.processed ?? 0;
  let processedThisRun = 0;
  let current: { item: MergeItem; step: string; withdrawn: boolean } | null = null;

  setHandler(enqueueSignal, (item) => {
    const done = recent.find((d) => d.result.itemId === item.itemId);
    if (done) {
      resend.push(done);
      return;
    }
    if (current?.item.itemId === item.itemId || queue.some((q) => q.itemId === item.itemId)) return;
    queue.push(item);
  });
  setHandler(withdrawSignal, ({ itemId }) => {
    const index = queue.findIndex((q) => q.itemId === itemId);
    if (index >= 0) queue.splice(index, 1);
    else if (current?.item.itemId === itemId) current.withdrawn = true;
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

  const limits = await decide('limits', input.limits ?? {});
  const acts = activitiesFor(limits);

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

  const handleItem = async (entry: {
    item: MergeItem;
    step: string;
    withdrawn: boolean;
  }): Promise<MergeResult | null> => {
    const { item } = entry;
    const scope = { taskId: item.taskId, subtaskId: item.subtaskId, subtaskKey: item.subtaskKey };
    let sync: SyncResult | null = null;
    let tests: TestResult | null = null;
    let merge: MergeOutcome | null = null;
    let failed: { step: string; message: string } | null = null;
    for (;;) {
      const step: MergeStep = await decide('mergeStep', {
        withdrawn: entry.withdrawn,
        sync,
        tests,
        merge,
        failed,
      });
      if (step.next === 'done') {
        if (step.result === 'dropped') return null;
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
    while (resend.length > 0) {
      const delivery = resend.shift();
      if (delivery) await deliver(delivery);
    }
    const hasWork = await condition(
      () => queue.length > 0 || resend.length > 0,
      `${limits.mergeQueueIdleMinutes} minutes`,
    );
    if (!hasWork) return { processed };
    const item = queue.shift();
    if (!item) continue;
    const entry = { item, step: 'sync', withdrawn: false };
    current = entry;
    const result = await handleItem(entry);
    current = null;
    if (result) {
      const delivery = { subtaskWorkflowId: item.subtaskWorkflowId, result };
      recent = [...recent, delivery].slice(-RECENT_KEPT);
      await deliver(delivery);
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
