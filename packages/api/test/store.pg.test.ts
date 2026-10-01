// Postgres 版过同一套契约：PGlite 上跑真迁移（和生产同一批 SQL），每个测试前清空再写入同一份样例数据。
import { stateChanges } from '@fleet-dao/db';
import { createTestDb, resetTestDb, TEST_DB_TIMEOUT_MS, type TestDb } from '@fleet-dao/db/testing';
import { eq } from 'drizzle-orm';
import { afterAll, beforeAll } from 'vitest';
import { createPgStore } from '../src/pg-store.ts';
import { seedPg } from './pg-fixtures.ts';
import { describeStoreContract, type MakeStore } from './store-contract.ts';
import { describeCredentialsStoreContract } from './store-contract-credentials.ts';
import { describeFeishuStoreContract } from './store-contract-feishu.ts';

let t: TestDb;
beforeAll(async () => {
  t = await createTestDb();
}, TEST_DB_TIMEOUT_MS);
afterAll(() => t.close());

const make: MakeStore = async (data, clock) => {
  await resetTestDb(t);
  await seedPg(t.db, data);
  return {
    store: createPgStore(t.db, { now: () => new Date(clock.now) }),
    async backdateState(taskId, at) {
      await t.db.update(stateChanges).set({ at }).where(eq(stateChanges.entityId, taskId));
    },
  };
};

describeStoreContract('Postgres 版', make);
describeFeishuStoreContract('Postgres 版', make);
describeCredentialsStoreContract('Postgres 版', make);
