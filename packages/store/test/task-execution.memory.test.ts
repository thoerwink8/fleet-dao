import { createMemoryStore } from '../src/memory-store.ts';
import { admissionSeed, describeAdmissionContract } from './task-admission-contract.ts';
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

describeAdmissionContract('出生/legacy Memory', async () => {
  const store = createMemoryStore(admissionSeed(), { now: () => EXECUTION_TIME });
  return {
    store,
    rebuild: (now) => createMemoryStore(store.data, { now: () => now }),
    audits: async () => store.data.audit,
  };
});
