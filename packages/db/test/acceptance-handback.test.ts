// 旧验收责任一次性交回原单（#3630，决定 0113 第二片）的两样读写：listOpenAcceptanceDuties 只列还开着的
// （结清的、被有效替代收口的不算），handBackAcceptanceDuty 只写 settled_* 三列、不删行，重跑不覆盖已有的结清。
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { handBackAcceptanceDuty, listOpenAcceptanceDuties } from '../src/queries/acceptance-duties.ts';
import { acceptanceDuties } from '../src/schema/index.ts';
import { createTestDb, resetTestDb, TEST_DB_TIMEOUT_MS, type TestDb } from '../src/testing.ts';
import { addRepo, addTask } from './helpers.ts';

let t: TestDb;
beforeAll(async () => {
  t = await createTestDb();
}, TEST_DB_TIMEOUT_MS);
afterAll(() => t.close());
beforeEach(() => resetTestDb(t));

const NOW = new Date('2026-10-23T01:00:00Z');
const OLD = 'a'.repeat(40);
const FINAL = 'c'.repeat(40);
const MERGE = 'd'.repeat(40);

async function seed() {
  const repo = await addRepo(t.db, 'shop');
  const task = await addTask(t.db, repo.id, { issueNumber: 3483 });
  const base = { taskId: task.id, repo: 'acme/shop', issueNumber: 3483, prNumber: 100 };
  const [target] = await t.db
    .insert(acceptanceDuties)
    .values({
      ...base,
      head: FINAL,
      items: ['现场审计'],
      mergeCommit: MERGE,
      settledAt: NOW,
      settledBy: 'frank',
      settleEvidence: '截图',
    })
    .returning();
  if (!target) throw new Error('目标行没建成');
  const [superseded] = await t.db
    .insert(acceptanceDuties)
    .values({
      ...base,
      head: OLD,
      items: ['现场审计'],
      supersededAt: NOW,
      supersededBy: 'frank',
      supersedeEvidence: '换头',
      successorId: target.id,
      successorGeneration: target.generation,
      supersedeCoverage: [],
    })
    .returning();
  const [open] = await t.db
    .insert(acceptanceDuties)
    .values({ ...base, prNumber: 101, head: 'e'.repeat(40), items: ['线上数据'] })
    .returning();
  const [coordination] = await t.db
    .insert(acceptanceDuties)
    .values({ ...base, prNumber: 0, head: '', items: ['和对方确认窗口'], source: 'coordination' })
    .returning();
  if (!superseded || !open || !coordination) throw new Error('行没建成');
  return { target, superseded, open, coordination };
}

describe('旧验收责任交回原单（#3630）', () => {
  it('只列还开着的：结清的、被有效替代收口的不列', async () => {
    const { open, coordination } = await seed();
    expect((await listOpenAcceptanceDuties(t.db)).map((r) => r.id)).toEqual([open.id, coordination.id]);
  });

  it('交回只写 settled_* 三列、不删行；重跑回 already，不覆盖第一次的记录', async () => {
    const { open } = await seed();
    const input = { id: open.id, generation: open.generation, by: 'handback:#3630', evidence: '交回 #3483' };
    expect(await handBackAcceptanceDuty(t.db, input, NOW)).toBe('handed_back');
    expect(
      await handBackAcceptanceDuty(t.db, { ...input, evidence: '第二次' }, new Date(NOW.getTime() + 1)),
    ).toBe('already');
    const rows = await t.db.select().from(acceptanceDuties);
    expect(rows).toHaveLength(4);
    const row = rows.find((r) => r.id === open.id);
    expect(row).toMatchObject({
      ...open,
      settledAt: NOW,
      settledBy: 'handback:#3630',
      settleEvidence: '交回 #3483',
    });
    expect((await listOpenAcceptanceDuties(t.db)).map((r) => r.id)).not.toContain(open.id);
  });

  it('【故意造出的失败】代次对不上、行不存在、没写交回到哪：抛错，不冒充交回', async () => {
    const { open } = await seed();
    await expect(
      handBackAcceptanceDuty(t.db, { id: open.id, generation: 9, by: 'x', evidence: 'y' }, NOW),
    ).rejects.toThrow(/代次/);
    await expect(
      handBackAcceptanceDuty(t.db, { id: 999999, generation: 1, by: 'x', evidence: 'y' }, NOW),
    ).rejects.toThrow(/读不到/);
    await expect(
      handBackAcceptanceDuty(t.db, { id: open.id, generation: 1, by: 'x', evidence: ' ' }, NOW),
    ).rejects.toThrow(/交回/);
    expect((await listOpenAcceptanceDuties(t.db)).map((r) => r.id)).toContain(open.id);
  });
});
