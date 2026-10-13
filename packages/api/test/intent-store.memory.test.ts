// 内存版意图存储过契约（参照实现）。
import { createMemoryIntentStore } from '../src/intent-store.ts';
import { seedMemory } from './intent-seed.ts';
import { describeIntentStoreContract } from './intent-store-contract.ts';

describeIntentStoreContract('内存版', async (clock) => {
  const now = () => new Date(clock.now);
  const store = createMemoryIntentStore({ now });
  return {
    store,
    seed: seedMemory(store, now),
    audits: async () =>
      store.audits.map((a) => ({ action: a.action, target: a.target, before: a.before, after: a.after })),
  };
});
