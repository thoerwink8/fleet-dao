import { createMemoryStore } from '../src/memory-store.ts';
import { describeStoreContract } from './store-contract.ts';

describeStoreContract('内存版', async (data, clock) => {
  const store = createMemoryStore(data, { now: () => new Date(clock.now) });
  return {
    store,
    async backdateState(taskId, at) {
      for (const change of store.data.stateChanges)
        if (change.entityId === taskId) change.at = at.toISOString();
    },
  };
});
