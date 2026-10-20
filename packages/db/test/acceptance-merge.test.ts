import { randomUUID } from 'node:crypto';
import { eq } from 'drizzle-orm';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import {
  settleAcceptanceDuty,
  supersedeAcceptanceDuty,
  upsertAcceptanceDuty,
} from '../src/queries/acceptance-duties.ts';
import { acceptanceMergePlanHash, mergeAcceptanceDuties } from '../src/queries/acceptance-merge.ts';
import { acceptanceDuties, auditLog, idempotencyKeys, pullRequests } from '../src/schema/index.ts';
import { createTestDb, resetTestDb, TEST_DB_TIMEOUT_MS, type TestDb } from '../src/testing.ts';
import { mergeFixture, NOW } from './acceptance-merge-fixture.ts';

let t: TestDb;
beforeAll(async () => {
  t = await createTestDb();
}, TEST_DB_TIMEOUT_MS);
afterAll(async () => {
  await t?.close();
});
beforeEach(async () => {
  await resetTestDb(t);
});
const add = (r: import('../src/queries/acceptance-duties.ts').AcceptanceDutyRow, item: string) =>
  upsertAcceptanceDuty(t.db, {
    taskId: r.taskId,
    repo: r.repo,
    issueNumber: r.issueNumber,
    prNumber: r.prNumber,
    head: r.head,
    items: [item],
  });
const snapshot = async () =>
  JSON.stringify([
    await t.db.select().from(acceptanceDuties),
    await t.db.select().from(auditLog),
    await t.db.select().from(idempotencyKeys),
  ]);
describe('受管归并原子事务', () => {
  it('创建OPEN管理责任，逐项来源/审计/幂等同事务，源不改；独立验收后才能替代', async () => {
    const f = await mergeFixture(t.db),
      before = JSON.stringify(f.sources);
    const result = await mergeAcceptanceDuties(t.db, f.write, NOW);
    expect(result.target).toMatchObject({
      source: 'management_merge',
      generation: 1,
      settledAt: null,
      supersededAt: null,
      items: f.contract.items,
    });
    expect(
      JSON.stringify(
        await t.db.select().from(acceptanceDuties).where(eq(acceptanceDuties.head, f.sources[0]!.head)),
      ),
    ).toBe(JSON.stringify([f.sources[0]]));
    expect(before).toBe(JSON.stringify(f.sources));
    expect(await t.db.select().from(auditLog)).toHaveLength(1);
    expect((await t.db.select().from(idempotencyKeys))[0]?.completedAt).not.toBeNull();
    await expect(
      supersedeAcceptanceDuty(
        t.db,
        { source: f.sources[0]!, target: result.target, by: 'ops:test', evidence: '尚未验' },
        NOW,
      ),
    ).rejects.toThrow();
    const settled = await settleAcceptanceDuty(
      t.db,
      { ...result.target, by: 'ops:test', evidence: '独立验收' },
      NOW,
    );
    const replaced = await supersedeAcceptanceDuty(
      t.db,
      { source: f.sources[0]!, target: settled, by: 'ops:test', evidence: '完整原项覆盖' },
      NOW,
    );
    expect(replaced.successorGeneration).toBe(1);
    const replay = await mergeAcceptanceDuties(t.db, f.write, NOW);
    expect(replay.replayed).toBe(true);
    expect(replay.target.settledAt).not.toBeNull();
    expect(await t.db.select().from(auditLog)).toHaveLength(1);
  });
  it('已有settled目标加项gen+1并撤终态，保留初建source', async () => {
    const f = await mergeFixture(t.db, true),
      r = await mergeAcceptanceDuties(t.db, f.write, NOW);
    expect(r.target).toMatchObject({
      id: f.target!.id,
      generation: 2,
      source: 'cold_verify',
      settledAt: null,
      settledBy: null,
      settleEvidence: null,
      items: f.contract.items,
    });
  });
  it.each(['sourceAdded', 'targetAdded', 'newTarget', 'prChanged', 'sourceSettled'])(
    '预检后 %s 则全部回滚',
    async (mode) => {
      const f = await mergeFixture(t.db, mode === 'targetAdded');
      if (mode === 'sourceAdded') await add(f.sources[0]!, '新项');
      if (mode === 'targetAdded') await add(f.target!, '新项');
      if (mode === 'newTarget')
        await t.db.insert(acceptanceDuties).values({
          taskId: f.task.id,
          repo: 'merge/fixture',
          issueNumber: 1,
          prNumber: 2,
          head: f.contract.head,
          items: ['并发目标'],
        });
      if (mode === 'prChanged')
        await t.db
          .update(pullRequests)
          .set({ headSha: '0'.repeat(40) })
          .where(eq(pullRequests.repoId, f.repo.id));
      if (mode === 'sourceSettled')
        await t.db
          .update(acceptanceDuties)
          .set({ mergeCommit: 'e'.repeat(40), settledAt: NOW, settledBy: 'x', settleEvidence: 'x' })
          .where(eq(acceptanceDuties.id, f.sources[0]!.id));
      const before = await snapshot();
      await expect(mergeAcceptanceDuties(t.db, f.write, NOW)).rejects.toThrow();
      expect(await snapshot()).toBe(before);
    },
  );
  it.each(['reason', 'evidence', 'by'])('同request换%s拒绝', async (field) => {
    const f = await mergeFixture(t.db);
    await mergeAcceptanceDuties(t.db, f.write, NOW);
    const before = await snapshot();
    await expect(mergeAcceptanceDuties(t.db, { ...f.write, [field]: 'different' }, NOW)).rejects.toThrow();
    expect(await snapshot()).toBe(before);
  });
  it.each(['source', 'target'])('成功后%s新增换代，不能把旧成功报当前有效', async (which) => {
    const f = await mergeFixture(t.db),
      r = await mergeAcceptanceDuties(t.db, f.write, NOW);
    await add(which === 'source' ? f.sources[0]! : r.target, '后来要求');
    const before = await snapshot();
    await expect(mergeAcceptanceDuties(t.db, f.write, NOW)).rejects.toThrow(/失效|代次/);
    expect(await snapshot()).toBe(before);
  });
  it.each(['audit_log', 'idempotency_keys'])('%s落账异常使目标、占键和审计全回滚', async (table) => {
    const f = await mergeFixture(t.db);
    await t.client.exec(
      `CREATE FUNCTION reject_merge_test() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION 'forced rollback'; END $$; CREATE TRIGGER reject_merge_test BEFORE ${table === 'audit_log' ? 'INSERT' : 'UPDATE'} ON ${table} FOR EACH ROW EXECUTE FUNCTION reject_merge_test();`,
    );
    const before = await snapshot();
    try {
      await expect(mergeAcceptanceDuties(t.db, f.write, NOW)).rejects.toThrow();
      expect(await snapshot()).toBe(before);
    } finally {
      await t.client.exec(`DROP TRIGGER reject_merge_test ON ${table}; DROP FUNCTION reject_merge_test();`);
    }
  });
  it('计划原项被改、换request、无新增项不会偷偷写', async () => {
    const f = await mergeFixture(t.db, true);
    const bad = structuredClone(f.write);
    bad.contract.items = ['丢失历史'];
    await expect(mergeAcceptanceDuties(t.db, bad, NOW)).rejects.toThrow();
    bad.planHash = acceptanceMergePlanHash(bad.contract);
    await expect(mergeAcceptanceDuties(t.db, bad, NOW)).rejects.toThrow();
    const r = await mergeAcceptanceDuties(t.db, f.write, NOW);
    expect(r.target.generation).toBe(2);
    await expect(mergeAcceptanceDuties(t.db, { ...f.write, request: randomUUID() }, NOW)).rejects.toThrow();
  });
});
