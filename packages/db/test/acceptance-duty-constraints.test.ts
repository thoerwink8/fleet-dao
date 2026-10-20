// 验收责任替代列（#3114）的库约束：走真实迁移建出来的表，不靠写路径代码守。
// CHECK 遇到 NULL 算通过，所以半条替代记录（只有 superseded_at/by）必须由显式 IS NOT NULL 挡住。
import { eq } from 'drizzle-orm';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { acceptanceDuties } from '../src/schema/index.ts';
import { createTestDb, resetTestDb, TEST_DB_TIMEOUT_MS, type TestDb } from '../src/testing.ts';
import { addRepo, addTask, expectViolation, NOW } from './helpers.ts';

let t: TestDb;
beforeAll(async () => {
  t = await createTestDb();
}, TEST_DB_TIMEOUT_MS);
afterAll(() => t.close());
beforeEach(() => resetTestDb(t));

const COMPLETE = {
  supersededAt: NOW,
  supersededBy: 'ops:acceptance:frank',
  supersedeEvidence: 'PR 最终头已合已验',
  successorGeneration: 1,
  supersedeCoverage: [] as never[],
} as const;

async function seedDuties() {
  const repo = await addRepo(t.db);
  const task = await addTask(t.db, repo.id);
  const row = (head: string) => ({
    taskId: task.id,
    repo: 'acme/shop',
    issueNumber: task.issueNumber,
    prNumber: 3081,
    head: head.repeat(40),
    items: ['现场核验'],
  });
  const [target] = await t.db.insert(acceptanceDuties).values(row('b')).returning();
  if (!target) throw new Error('target 没写进去');
  return { row, target };
}

describe('acceptance_duties_superseded_complete', () => {
  it('全空（未替代）和完整合法的替代都接受', async () => {
    const { row, target } = await seedDuties();
    await t.db.insert(acceptanceDuties).values(row('a'));
    await t.db.insert(acceptanceDuties).values({ ...row('c'), ...COMPLETE, successorId: target.id });
    const rows = await t.db.select().from(acceptanceDuties);
    expect(rows).toHaveLength(3);
  });

  it('替代记录缺任何一个字段都拒绝（含只有 superseded_at/by 的半条）', async () => {
    const { row, target } = await seedDuties();
    const full = { ...row('d'), ...COMPLETE, successorId: target.id };
    const missing: (keyof typeof full)[] = [
      'supersededAt',
      'supersededBy',
      'supersedeEvidence',
      'successorId',
      'successorGeneration',
      'supersedeCoverage',
    ];
    for (const key of missing)
      await expectViolation(
        t.db.insert(acceptanceDuties).values({ ...full, [key]: null }),
        'acceptance_duties_superseded_complete',
      );
    // 评审复现的反例：只写 superseded_at / superseded_by，其余三列 NULL
    await expectViolation(
      t.db.insert(acceptanceDuties).values({ ...row('e'), supersededAt: NOW, supersededBy: 'operator' }),
      'acceptance_duties_superseded_complete',
    );
    // 覆盖声明不是数组同样拒绝
    await expectViolation(
      t.db.insert(acceptanceDuties).values({ ...full, supersedeCoverage: {} as never }),
      'acceptance_duties_superseded_complete',
    );
    // 空证据、代次非正同样拒绝
    await expectViolation(
      t.db.insert(acceptanceDuties).values({ ...full, supersedeEvidence: '' }),
      'acceptance_duties_superseded_complete',
    );
    await expectViolation(
      t.db.insert(acceptanceDuties).values({ ...full, successorGeneration: 0 }),
      'acceptance_duties_superseded_complete',
    );
    expect(await t.db.select().from(acceptanceDuties)).toHaveLength(1);
  });

  it('已有行被 UPDATE 成半条替代记录同样拒绝', async () => {
    const { row } = await seedDuties();
    const [source] = await t.db.insert(acceptanceDuties).values(row('a')).returning();
    if (!source) throw new Error('source 没写进去');
    await expectViolation(
      t.db
        .update(acceptanceDuties)
        .set({ supersededAt: NOW, supersededBy: 'operator' })
        .where(eq(acceptanceDuties.id, source.id)),
      'acceptance_duties_superseded_complete',
    );
  });
});

describe('acceptance_duties_source_known', () => {
  it('三种初建来源都接受（含迁移 0098 加的 management_merge），未知来源拒绝', async () => {
    const { row } = await seedDuties();
    const sources = ['cold_verify', 'coordination', 'management_merge'] as const;
    for (const [i, source] of sources.entries())
      await t.db.insert(acceptanceDuties).values({ ...row('acd'[i] ?? 'a'), source });
    await expectViolation(
      t.db.insert(acceptanceDuties).values({ ...row('f'), source: 'manual' as never }),
      'acceptance_duties_source_known',
    );
    expect(await t.db.select().from(acceptanceDuties)).toHaveLength(4);
  });
});
