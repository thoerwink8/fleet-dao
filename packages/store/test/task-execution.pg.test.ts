import { auditLog, taskExecutionControls } from '@fleet-dao/db';
import { createTestDb, resetTestDb, TEST_DB_TIMEOUT_MS, type TestDb } from '@fleet-dao/db/testing';
import { afterAll, beforeAll } from 'vitest';
import { createPgStore } from '../src/pg-store.ts';
import { seedPg } from '../src/testing.ts';
import { admissionSeed, describeAdmissionContract } from './task-admission-contract.ts';
import { describeExecutionContract, EXECUTION_TIME, executionSeed } from './task-execution-contract.ts';
import { readExecutionOperations } from './task-execution-pg-fixture.ts';
import { describeExecutionSchema } from './task-execution-schema-contract.ts';

let t: TestDb;
beforeAll(async () => {
  t = await createTestDb();
}, TEST_DB_TIMEOUT_MS);
afterAll(async () => {
  await t?.close();
});
describeExecutionContract('执行资格 PgStore（默认PGlite）', async (control) => {
  await resetTestDb(t);
  await seedPg(t.db, executionSeed(null));
  if (control)
    await t.db
      .insert(taskExecutionControls)
      .values([...(executionSeed(control).executionControls?.values() ?? [])]);
  return {
    store: createPgStore(t.db, { now: () => EXECUTION_TIME }),
    rebuild: (now) => createPgStore(t.db, { now: () => now }),
    operations: () => readExecutionOperations(t.db),
    audits: () => t.db.select().from(auditLog),
  };
});
describeExecutionSchema('执行资格SQL约束（默认PGlite）', async () => {
  await resetTestDb(t);
  return t;
});

describeAdmissionContract('出生/legacy PgStore（默认PGlite）', async () => {
  await resetTestDb(t);
  await seedPg(t.db, admissionSeed());
  return {
    store: createPgStore(t.db, { now: () => EXECUTION_TIME }),
    rebuild: (now) => createPgStore(t.db, { now: () => now }),
    audits: () => t.db.select().from(auditLog),
  };
});
