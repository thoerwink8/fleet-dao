// Postgres 版过同一套契约：PGlite 上跑真迁移（和生产同一批 SQL），每个测试前清空再写入同一份样例数据。
import { notifications, runs, stateChanges, tasks } from '@fleet-dao/db';
import { createTestDb, resetTestDb, TEST_DB_TIMEOUT_MS, type TestDb } from '@fleet-dao/db/testing';
import { eq } from 'drizzle-orm';
import { afterAll, beforeAll } from 'vitest';
import { createPgStore } from '../src/pg-store.ts';
import { seedPg } from '../src/testing/pg-fixtures.ts';
import { describeStoreContract, type MakeStore } from './store-contract.ts';
import { describeCheckoutHistoryContract } from './store-contract-checkout-history.ts';
import { describeCredentialsStoreContract } from './store-contract-credentials.ts';
import { describeFlowStoreContract } from './store-contract-flow.ts';
import { describeNodeStoreContract } from './store-contract-nodes.ts';
import { describeTaskListContract } from './store-contract-task-list.ts';

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
describeCheckoutHistoryContract('Postgres 版', async (data) => {
  await resetTestDb(t);
  await seedPg(t.db, data);
  // seedPg 不写 temporal_run_id：照数据补上
  for (const run of (data.segmentRuns ?? []) as { id: string; temporalRunId?: string }[]) {
    if (run.temporalRunId)
      await t.db.update(runs).set({ temporalRunId: run.temporalRunId }).where(eq(runs.id, run.id));
  }
  return {
    store: createPgStore(t.db, { now: () => new Date('2026-10-19T05:00:00.000Z') }),
    async reopen(id, raisedAt) {
      await t.db
        .update(notifications)
        .set({ resolvedAt: null, resolvedBy: null, raisedAt: new Date(raisedAt) })
        .where(eq(notifications.id, id));
    },
    async setTaskState(taskId, state) {
      await t.db.update(tasks).set({ state }).where(eq(tasks.id, taskId));
    },
    async addRun(run) {
      await t.db.insert(runs).values({
        id: run.id,
        segment: 'manual',
        taskId: run.taskId ?? null,
        issueNumber: 13,
        workflowId: run.workflowId,
        model: 'opus-5.5',
        startedAt: new Date('2026-10-19T04:00:00.000Z'),
      });
    },
    async failAuditWrites() {
      await t.client.exec(`
        create function test_fail_audit() returns trigger language plpgsql as $$ begin raise exception 'audit write blocked by test'; end $$;
        create trigger fail_audit before insert on audit_log for each row execute function test_fail_audit();
      `);
      return async () => {
        await t.client.exec('drop trigger fail_audit on audit_log; drop function test_fail_audit();');
      };
    },
  };
});
describeCredentialsStoreContract('Postgres 版', make);
describeNodeStoreContract('Postgres 版', make);
describeTaskListContract('Postgres 版', make);
describeFlowStoreContract('Postgres 版', make);
