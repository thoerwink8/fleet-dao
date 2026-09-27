import { createMemoryStore } from '../src/memory-store.ts';
import { describeStoreContract, type MakeStore } from './store-contract.ts';
import { describeCredentialsStoreContract } from './store-contract-credentials.ts';
import { describeFeishuStoreContract } from './store-contract-feishu.ts';
import { describeSeatStoreContract, type MakeSeatStore } from './store-contract-seat.ts';

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
describeCredentialsStoreContract('内存版', make);

const back = (at: string, minutes: number) => new Date(Date.parse(at) - minutes * 60_000).toISOString();

const makeSeat: MakeSeatStore = async (data, clock) => {
  const store = createMemoryStore(data, { now: () => new Date(clock.now) });
  return {
    store,
    async backdateSeat(scope, minutes) {
      for (const l of store.data.seatLeases) if (l.scope === scope) l.renewedAt = back(l.renewedAt, minutes);
    },
    async backdateClaim(repoId, issueNumber, minutes) {
      for (const c of store.data.claims)
        if (c.repoId === repoId && c.issueNumber === issueNumber)
          c.heartbeatAt = back(c.heartbeatAt, minutes);
    },
  };
};

describeSeatStoreContract('内存版', makeSeat);
