import { createMemoryStore } from '../src/memory-store.ts';
import { describeStoreContract, type MakeStore } from './store-contract.ts';
import { describeCheckoutHistoryContract } from './store-contract-checkout-history.ts';
import { describeCredentialsStoreContract } from './store-contract-credentials.ts';
import { describeFlowStoreContract } from './store-contract-flow.ts';
import { describeNodeStoreContract } from './store-contract-nodes.ts';
import { describeTaskListContract } from './store-contract-task-list.ts';

const make: MakeStore = async (data, clock) => {
  const store = createMemoryStore(data, { now: () => new Date(clock.now) });
  return {
    store,
    async backdateState(taskId, at) {
      for (const change of store.data.stateChanges)
        if (change.entityId === taskId) change.at = at.toISOString();
    },
  };
};

describeStoreContract('内存版', make);
describeCheckoutHistoryContract('内存版', async (data) => {
  const store = createMemoryStore(data, { now: () => new Date('2026-10-19T05:00:00.000Z') });
  return {
    store,
    async reopen(id, raisedAt) {
      const n = store.data.notifications.find((x) => x.id === id);
      if (!n) throw new Error('没有这条通知');
      delete n.resolvedAt;
      delete n.resolvedBy;
      n.raisedAt = raisedAt;
    },
    async setTaskState(taskId, state) {
      const task = store.data.tasks.find((t) => t.id === taskId);
      if (!task) throw new Error('没有这张任务');
      task.state = state;
    },
    async addRun(run) {
      store.data.segmentRuns.push({
        id: run.id,
        segment: 'manual',
        ...(run.taskId === undefined ? {} : { taskId: run.taskId }),
        issueNumber: 13,
        workflowId: run.workflowId,
        model: 'opus-5.5',
        startedAt: '2026-10-19T04:00:00.000Z',
      } as unknown as (typeof store.data.segmentRuns)[number]);
    },
  };
});
describeCredentialsStoreContract('内存版', make);
describeNodeStoreContract('内存版', make);
describeTaskListContract('内存版', make);
describeFlowStoreContract('内存版', make);
