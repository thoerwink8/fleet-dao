// 正式 builder 的真实SQL和参数跑 EXPLAIN；不用强制禁用seqscan、索引名或墙钟作性能结论。
import { writeFileSync } from 'node:fs';
import { asc, eq } from 'drizzle-orm';
import { afterAll, beforeAll, expect, it } from 'vitest';
import {
  acceptanceDirtyGroupsQuery,
  acceptanceGroupDutiesQuery,
  maintainAcceptanceCandidates,
} from '../src/queries/acceptance-candidates.ts';
import {
  commanderAcceptanceCandidatesQuery,
  listCommanderAcceptanceTasks,
} from '../src/queries/commander.ts';
import { acceptanceDuties } from '../src/schema/index.ts';
import { createTestDb, TEST_DB_TIMEOUT_MS, type TestDb } from '../src/testing.ts';
import { mergeFixture, NOW } from './acceptance-merge-fixture.ts';

let t: TestDb;
beforeAll(async () => {
  t = await createTestDb();
}, TEST_DB_TIMEOUT_MS);
afterAll(async () => {
  await t?.close();
});

interface Plan {
  'Actual Rows': number;
  'Actual Loops': number;
  'Rows Removed by Filter'?: number;
  'Rows Removed by Join Filter'?: number;
  'Shared Hit Blocks'?: number;
  'Shared Read Blocks'?: number;
  Plans?: Plan[];
}
function cost(p: Plan): { rows: number; blocks: number } {
  const children = (p.Plans ?? []).map(cost);
  return {
    rows:
      (p['Actual Rows'] + (p['Rows Removed by Filter'] ?? 0) + (p['Rows Removed by Join Filter'] ?? 0)) *
        p['Actual Loops'] +
      children.reduce((n, c) => n + c.rows, 0),
    blocks:
      (p['Shared Hit Blocks'] ?? 0) +
      (p['Shared Read Blocks'] ?? 0) +
      children.reduce((n, c) => n + c.blocks, 0),
  };
}
async function explain(query: { toSQL(): { sql: string; params: unknown[] } }) {
  const q = query.toSQL();
  const result = await t.client.query<{ 'QUERY PLAN': { Plan: Plan }[] }>(
    `EXPLAIN (ANALYZE, BUFFERS, FORMAT JSON) ${q.sql}`,
    q.params,
  );
  const plan = result.rows[0]!['QUERY PLAN'][0]!.Plan;
  return { query: q, plan, cost: cost(plan) };
}

it('closed/有效superseded历史增长32倍，活组/dirty/上下文不变，正常计划扫描行与块有界', async () => {
  const f = await mergeFixture(t.db);
  async function addHistory(start: number, end: number) {
    await t.client.query(
      `insert into pull_requests(repo_id,number,state,head_ref,head_sha,merged_at,updated_at)
      select $1::uuid,n,'merged','history',repeat('b',40),$2::timestamptz,$2::timestamptz from generate_series($3::int,$4::int) n`,
      [f.repo.id, NOW.toISOString(), start, end],
    );
    // 同仓同task、活PR外的历史；半数纯settled，半数有效superseded，全部由正式刷新判法建立缓存。
    await t.client.query(
      `insert into acceptance_duties(task_id,repo,issue_number,pr_number,head,items,merge_commit,settled_at,settled_by,settle_evidence)
      select $1::uuid,'merge/fixture',1,n,repeat('b',40),array['x'],repeat('e',40),$2::timestamptz,'test','test' from generate_series($3::int,$4::int) n`,
      [f.task.id, NOW.toISOString(), start, end],
    );
    await t.client.query(
      `insert into acceptance_duties(task_id,repo,issue_number,pr_number,head,items,superseded_at,superseded_by,supersede_evidence,successor_id,successor_generation,supersede_coverage)
      select task_id,repo,issue_number,pr_number,repeat('a',40),array['x'],$2::timestamptz,'test','test',id,1,'[]'::jsonb
      from acceptance_duties where task_id=$1::uuid and pr_number between $3 and $4 and pr_number % 2=0`,
      [f.task.id, NOW.toISOString(), start, end],
    );
    for (let i = 0; i < 100; i++) {
      try {
        await maintainAcceptanceCandidates(t.db);
        return;
      } catch (error) {
        if (!(error instanceof Error) || !error.message.includes('unknown')) throw error;
      }
    }
    throw new Error('历史维护未完成');
  }
  async function sample() {
    await t.client.exec('VACUUM ANALYZE');
    const active = await explain(commanderAcceptanceCandidatesQuery(t.db, NOW));
    const clean = await explain(acceptanceDirtyGroupsQuery(t.db, 128));
    const context = await explain(
      acceptanceGroupDutiesQuery(t.db, { taskId: f.task.id, prNumber: 2 }, 65537),
    );
    // 旧实现第一句正式SQL：历史全表装载。它的线性增长是失败基线，而非推荐fallback。
    const oldAllDuties = await explain(
      t.db.select().from(acceptanceDuties).orderBy(asc(acceptanceDuties.id)),
    );
    expect(await listCommanderAcceptanceTasks(t.db, NOW)).toHaveLength(1);
    await t.db
      .update(acceptanceDuties)
      .set({ items: ['changed'] })
      .where(eq(acceptanceDuties.id, f.sources[0]!.id));
    const dirty = await explain(acceptanceDirtyGroupsQuery(t.db, 128));
    await maintainAcceptanceCandidates(t.db);
    // 让原活组结清，测试没有任何候选时也不读历史。
    await t.client.query(
      `update acceptance_duties set settled_at=$2,settled_by='test',settle_evidence='test' where task_id=$1 and pr_number=2`,
      [f.task.id, NOW.toISOString()],
    );
    await maintainAcceptanceCandidates(t.db);
    const empty = await explain(commanderAcceptanceCandidatesQuery(t.db, NOW));
    expect(await listCommanderAcceptanceTasks(t.db, NOW)).toEqual([]);
    await t.client.query(
      'update acceptance_duties set settled_at=null,settled_by=null,settle_evidence=null where task_id=$1 and pr_number=2',
      [f.task.id],
    );
    await maintainAcceptanceCandidates(t.db);
    return { active, clean, dirty, empty, context, oldAllDuties };
  }
  await addHistory(100, 227);
  const small = await sample();
  await addHistory(228, 4195);
  const large = await sample();
  for (const key of ['active', 'clean', 'dirty', 'empty', 'context'] as const) {
    expect(
      large[key].cost.rows,
      `${key}: ${JSON.stringify({ small: small[key].cost, large: large[key].cost })}`,
    ).toBeLessThanOrEqual(small[key].cost.rows * 2 + 64);
    expect(large[key].cost.blocks, `${key}访问块不线性增长`).toBeLessThanOrEqual(
      small[key].cost.blocks * 2 + 64,
    );
  }
  // root返回行就是旧SELECT传入Node的责任数；固定的2条活上下文不跟历史倍增。
  expect(large.oldAllDuties.plan['Actual Rows'] - 2).toBe((small.oldAllDuties.plan['Actual Rows'] - 2) * 32);
  await t.client.query(
    `insert into acceptance_duties(task_id,repo,issue_number,pr_number,head,items,merge_commit,settled_at,settled_by,settle_evidence)
    select $1::uuid,'merge/fixture',1,2,'context-'||n,array['x'],repeat('e',40),$2::timestamptz,'test','test' from generate_series(1,40) n`,
    [f.task.id, NOW.toISOString()],
  );
  await maintainAcceptanceCandidates(t.db);
  const expandedContext = await explain(
    acceptanceGroupDutiesQuery(t.db, { taskId: f.task.id, prNumber: 2 }, 65537),
  );
  expect((await listCommanderAcceptanceTasks(t.db, NOW))[0]!.duties).toHaveLength(42);
  expect(expandedContext.cost.rows).toBeGreaterThan(large.context.cost.rows);
  // 可选仅供本机保存完整原件，CI不依赖临时目录。
  if (process.env.FLEET_ACCEPTANCE_PLAN_OUTPUT)
    writeFileSync(
      process.env.FLEET_ACCEPTANCE_PLAN_OUTPUT,
      JSON.stringify({ small, large, expandedContext }, null, 2),
    );
}, 60_000);
