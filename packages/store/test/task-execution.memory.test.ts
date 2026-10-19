import { createMemoryStore } from '../src/memory-store.ts';
import { describeExecutionContract, EXECUTION_TIME, executionSeed } from './task-execution-contract.ts';

describeExecutionContract('执行资格 Memory', async (control) => {
  const store = createMemoryStore(executionSeed(control), { now: () => EXECUTION_TIME });
  return {
    store,
    rebuild: (now) => createMemoryStore(store.data, { now: () => now }),
    operations: async () => [...store.data.executionOperations.values()],
    audits: async () => store.data.audit,
  };
});
