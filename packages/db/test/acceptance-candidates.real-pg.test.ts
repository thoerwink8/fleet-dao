// 隔离fixture的真实PG双连接；没环境明确跳过，不用PGlite顺序用例冒充并发证明。
import { eq } from 'drizzle-orm';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import * as candidates from '../src/queries/acceptance-candidates.ts';
import { listCommanderAcceptanceTasks } from '../src/queries/commander.ts';
import { acceptanceCandidateGroups, acceptanceDuties } from '../src/schema/index.ts';
import {
  allSettledOrThrow,
  createConcurrentTestDb,
  realTestPgUrl,
  resetTestDb,
  TEST_DB_TIMEOUT_MS,
} from '../src/testing.ts';
import { mergeFixture, NOW } from './acceptance-merge-fixture.ts';

const url = realTestPgUrl();
it.runIf(Boolean(process.env.CI) && !url)('CI必须提供真实PG双连接', () => {
  throw new Error('FLEET_TEST_PG_URL required');
});
describe.runIf(Boolean(url))('候选索引真实PG竞争', () => {
  let t: Awaited<ReturnType<typeof createConcurrentTestDb>>;
  beforeAll(async () => {
    t = await createConcurrentTestDb();
    const ids = await allSettledOrThrow(
      t.peers.map((p) =>
        p.client.query<{ pid: number; db: string }>('select pg_backend_pid() pid,current_database() db'),
      ),
    );
    expect(ids[0]!.rows[0]!.db).toBe(ids[1]!.rows[0]!.db);
    expect(ids[0]!.rows[0]!.pid).not.toBe(ids[1]!.rows[0]!.pid);
  }, TEST_DB_TIMEOUT_MS);
  afterAll(async () => {
    await t?.close();
  });
  beforeEach(async () => {
    vi.restoreAllMocks();
    await resetTestDb(t);
  });

  it('writer持duty锁时refresher无锁读完整上下文，不产生group→duty反序；后提交新写保留dirty', async () => {
    const f = await mergeFixture(t.db);
    await candidates.maintainAcceptanceCandidates(t.db);
    await t.db.update(acceptanceCandidateGroups).set({ dirty: true });
    const [observed] = await candidates.acceptanceDirtyGroupsQuery(t.db, 1);
    await t.blocker.client.exec('BEGIN');
    try {
      await t.blocker.client.query('select id from acceptance_duties where id=$1 for update', [
        f.sources[0]!.id,
      ]);
      const result = await candidates.refreshAcceptanceCandidateGroup(t.peers[0].db, observed!, 100);
      expect(result.published).toBe(true);
      await t.blocker.client.query("update acceptance_duties set items=array['new'] where id=$1", [
        f.sources[0]!.id,
      ]);
      await t.blocker.client.exec('COMMIT');
      expect(await candidates.acceptanceDirtyGroupsQuery(t.peers[1].db, 128)).toHaveLength(1);
      await expect(listCommanderAcceptanceTasks(t.peers[1].db, NOW)).rejects.toThrow(/unknown/);
    } finally {
      await t.blocker.client.exec('ROLLBACK');
    }
  });
  it('writer在revision读取后提交，旧CAS不能清新dirty；两个refresher同时跑仍收敛', async () => {
    const f = await mergeFixture(t.db);
    await candidates.maintainAcceptanceCandidates(t.db);
    await t.db.update(acceptanceCandidateGroups).set({ dirty: true });
    const [observed] = await candidates.acceptanceDirtyGroupsQuery(t.peers[0].db, 1);
    await t.peers[1].db
      .update(acceptanceDuties)
      .set({ items: ['later'] })
      .where(eq(acceptanceDuties.id, f.sources[0]!.id));
    expect((await candidates.refreshAcceptanceCandidateGroup(t.peers[0].db, observed!, 100)).published).toBe(
      false,
    );
    const results = await Promise.allSettled(
      t.peers.map((p) => candidates.maintainAcceptanceCandidates(p.db)),
    );
    expect(results.every((r) => r.status === 'fulfilled')).toBe(true);
    expect(await candidates.acceptanceDirtyGroupsQuery(t.db, 128)).toEqual([]);
  });
  it('readiness之后writer提交，pure reader仍从同一只读snapshot返回完整旧上下文，下一次明确dirty', async () => {
    const f = await mergeFixture(t.db);
    await candidates.maintainAcceptanceCandidates(t.db);
    const expected = await listCommanderAcceptanceTasks(t.db, NOW);
    const assertReady = candidates.assertAcceptanceCandidatesReady;
    vi.spyOn(candidates, 'assertAcceptanceCandidatesReady').mockImplementationOnce(async (db) => {
      await assertReady(db);
      await t.peers[1].db
        .update(acceptanceDuties)
        .set({ items: ['committed between reads'] })
        .where(eq(acceptanceDuties.id, f.sources[0]!.id));
    });
    expect(await listCommanderAcceptanceTasks(t.peers[0].db, NOW)).toEqual(expected);
    await expect(listCommanderAcceptanceTasks(t.peers[0].db, NOW)).rejects.toThrow(/unknown/);
    await candidates.maintainAcceptanceCandidates(t.db);
    expect((await listCommanderAcceptanceTasks(t.db, NOW))[0]!.duties[0]!.items).toEqual([
      'committed between reads',
    ]);
  });
  it('多行相反顺序跨组移动由statement transition全集排序，不给新组锁制造反序', async () => {
    const f = await mergeFixture(t.db);
    const [a] = await t.db
      .insert(acceptanceDuties)
      .values({
        taskId: f.task.id,
        repo: 'merge/fixture',
        issueNumber: 1,
        prNumber: 3,
        head: 'c'.repeat(40),
        items: ['c'],
      })
      .returning();
    const [b] = await t.db
      .insert(acceptanceDuties)
      .values({
        taskId: f.task.id,
        repo: 'merge/fixture',
        issueNumber: 1,
        prNumber: 4,
        head: 'd'.repeat(40),
        items: ['d'],
      })
      .returning();
    await candidates.maintainAcceptanceCandidates(t.db);
    await allSettledOrThrow([
      t.peers[0].client.query(
        'update acceptance_duties set pr_number=case pr_number when 2 then 3 else 2 end where id=any($1::bigint[])',
        [f.sources.map((s) => s.id)],
      ),
      t.peers[1].client.query(
        'update acceptance_duties set pr_number=case pr_number when 3 then 2 else 3 end where id=any($1::bigint[])',
        [[a!.id, b!.id]],
      ),
    ]);
    expect((await candidates.acceptanceDirtyGroupsQuery(t.db, 128)).map((r) => r.prNumber)).toEqual([
      2, 3, 4,
    ]);
    await candidates.maintainAcceptanceCandidates(t.db);
  });
  it('历史id顺序与组键相反时，bootstrap和批量writer并发仍收敛，cursor不冒充第一页就绪', async () => {
    const f = await mergeFixture(t.db);
    await t.peers[0].client.query(
      `insert into acceptance_duties(task_id,repo,issue_number,pr_number,head,items)
      select $1::uuid,'merge/fixture',1,n,'history',array['x'] from generate_series(30,3,-1) n`,
      [f.task.id],
    );
    const work = await Promise.allSettled([
      candidates.maintainAcceptanceCandidates(t.peers[0].db, { bootstrapRows: 8 }),
      t.peers[1].client.query("update acceptance_duties set items=array['changed'] where task_id=$1", [
        f.task.id,
      ]),
    ]);
    expect(work[1]!.status).toBe('fulfilled');
    if (work[0]!.status === 'rejected') expect(String(work[0]!.reason)).toMatch(/unknown/);
    for (let page = 0; page < 4; page++) {
      try {
        await candidates.maintainAcceptanceCandidates(t.db, { bootstrapRows: 8 });
      } catch (error) {
        if (!(error instanceof Error) || !error.message.includes('unknown')) throw error;
      }
    }
    expect(await candidates.acceptanceDirtyGroupsQuery(t.db, 128)).toEqual([]);
    expect(await t.db.select().from(acceptanceCandidateGroups)).toHaveLength(29);
    expect(await listCommanderAcceptanceTasks(t.db, NOW)).toHaveLength(1);
  });
});
