import { createMemoryStore } from '../src/memory-store.ts';
import { describeStoreContract, type MakeStore } from './store-contract.ts';
import { describeFeishuStoreContract } from './store-contract-feishu.ts';

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
describeFeishuStoreContract('内存版', make);
