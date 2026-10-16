// 设置表里的只凭 401 记号：两次调用（两个 claim）在窗口里，第二次才 repeated。
import { createTestDb, resetTestDb, TEST_DB_TIMEOUT_MS, type TestDb } from '@fleet-dao/db/testing';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { createNoteBare401 } from '../../src/real/bare-401.ts';

let t: TestDb;
beforeAll(async () => {
  t = await createTestDb();
}, TEST_DB_TIMEOUT_MS);
afterAll(() => t.close());
beforeEach(() => resetTestDb(t));

describe('noteBare401 写设置表', () => {
  it('两个任务各记一次：第二次才算重复；同一个 claim 重试不算', async () => {
    const note = createNoteBare401(t.db);
    const now = '2026-10-16T08:00:00.000Z';
    const soon = '2026-10-16T08:01:00.000Z';
    const first = await note({ schemaVersion: 1, poolId: 'p1', now, claim: 'wf-a:p1:0' });
    expect(first.repeated).toBe(false);
    const retry = await note({ schemaVersion: 1, poolId: 'p1', now: soon, claim: 'wf-a:p1:0' });
    expect(retry.repeated).toBe(false);
    const second = await note({ schemaVersion: 1, poolId: 'p1', now: soon, claim: 'wf-b:p1:0' });
    expect(second.repeated).toBe(true);
    const otherPool = await note({ schemaVersion: 1, poolId: 'p2', now: soon, claim: 'wf-b:p2:0' });
    expect(otherPool.repeated).toBe(false);
  });
});
