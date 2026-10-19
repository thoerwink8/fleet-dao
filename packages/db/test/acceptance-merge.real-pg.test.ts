import { randomUUID } from 'node:crypto';
import { eq } from 'drizzle-orm';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  settleAcceptanceDuty,
  supersedeAcceptanceDuty,
  upsertAcceptanceDuty,
} from '../src/queries/acceptance-duties.ts';
import { mergeAcceptanceDuties } from '../src/queries/acceptance-merge.ts';
import {
  acceptanceDuties,
  acceptanceDutySupersessions,
  auditLog,
  idempotencyKeys,
  runs,
  tasks,
} from '../src/schema/index.ts';
import {
  allSettledOrThrow,
  createConcurrentTestDb,
  realTestPgUrl,
  resetTestDb,
  TEST_DB_TIMEOUT_MS,
} from '../src/testing.ts';
import { mergeFixture, NOW } from './acceptance-merge-fixture.ts';

const url = realTestPgUrl();
it.runIf(Boolean(process.env.CI) && !url)('CI必须提供真实PG竞争环境', () => {
  throw Error('FLEET_TEST_PG_URL required');
});
describe.runIf(Boolean(url))('受管归并真实PG双连接', () => {
  let t: Awaited<ReturnType<typeof createConcurrentTestDb>>;
  beforeAll(async () => {
    t = await createConcurrentTestDb();
    const identities = await allSettledOrThrow(
      t.peers.map((p) =>
        p.client.query<{ pid: number; db: string }>('select pg_backend_pid() pid,current_database() db'),
      ),
    );
    expect(identities[0]!.rows[0]!.db).toBe(identities[1]!.rows[0]!.db);
    expect(identities[0]!.rows[0]!.pid).not.toBe(identities[1]!.rows[0]!.pid);
  }, TEST_DB_TIMEOUT_MS);
  afterAll(async () => {
    await t?.close();
  });
  beforeEach(async () => {
    await resetTestDb(t);
  });
  const blocked = async (pid: number) =>
    vi.waitFor(
      async () => {
        const { rows } = await t.client.query<{ waiting: boolean }>(
          'select cardinality(pg_blocking_pids($1)) > 0 as waiting',
          [pid],
        );
        expect(rows[0]?.waiting).toBe(true);
      },
      { interval: 10, timeout: 1_000 },
    );
  const pids = async () =>
    allSettledOrThrow(
      t.peers.map(
        async (p) => (await p.client.query<{ pid: number }>('select pg_backend_pid() as pid')).rows[0]!.pid,
      ),
    );
  it('同request竞争只建一个目标、一条审计和一份完整回执', async () => {
    const f = await mergeFixture(t.db);
    const results = await allSettledOrThrow(t.peers.map((p) => mergeAcceptanceDuties(p.db, f.write, NOW)));
    expect(results.map((r) => r.replayed).sort()).toEqual([false, true]);
    expect(new Set(results.map((r) => r.target.id)).size).toBe(1);
    expect(await t.db.select().from(acceptanceDuties)).toHaveLength(3);
    expect(await t.db.select().from(auditLog)).toHaveLength(1);
    expect(await t.db.select().from(idempotencyKeys)).toHaveLength(1);
  });
  it('不同request争同一缺失目标，第二份旧计划必须stale且不留占键', async () => {
    const f = await mergeFixture(t.db);
    const results = await Promise.allSettled(
      t.peers.map((p, i) =>
        mergeAcceptanceDuties(p.db, { ...f.write, request: i ? randomUUID() : f.write.request }, NOW),
      ),
    );
    expect(results.filter((r) => r.status === 'fulfilled')).toHaveLength(1);
    expect(results.filter((r) => r.status === 'rejected')).toHaveLength(1);
    expect(await t.db.select().from(acceptanceDuties)).toHaveLength(3);
    expect(await t.db.select().from(auditLog)).toHaveLength(1);
    expect(await t.db.select().from(idempotencyKeys)).toHaveLength(1);
  });
  it('与engine新增源项竞争：不丢源项，若先归并成功则旧回执明确失效', async () => {
    const f = await mergeFixture(t.db),
      source = f.sources[0]!;
    const results = await Promise.allSettled([
      mergeAcceptanceDuties(t.peers[0].db, f.write, NOW),
      upsertAcceptanceDuty(t.peers[1].db, {
        taskId: source.taskId,
        repo: source.repo,
        issueNumber: source.issueNumber,
        prNumber: source.prNumber,
        head: source.head,
        items: ['后来要求'],
      }),
    ]);
    expect(results[1]!.status).toBe('fulfilled');
    const rows = await t.db.select().from(acceptanceDuties),
      current = rows.find((r) => r.id === source.id)!;
    expect(current.items).toEqual(expect.arrayContaining([...source.items, '后来要求']));
    expect(current.generation).toBe(2);
    await expect(mergeAcceptanceDuties(t.db, f.write, NOW)).rejects.toThrow(/代次|失效/);
    expect((await t.db.select().from(auditLog)).length).toBe(results[0]!.status === 'fulfilled' ? 1 : 0);
  });
  it.each(['settle', 'supersede'] as const)(
    '归并先持源锁、%s随后排队，旧代次不能结清新增后的目标',
    async (mode) => {
      const f = await mergeFixture(t.db, true),
        [mergePid, otherPid] = await pids();
      if (mode === 'settle')
        await t.db
          .update(acceptanceDuties)
          .set({ settledAt: null, settledBy: null, settleEvidence: null })
          .where(eq(acceptanceDuties.id, f.target!.id));
      const jobs: Promise<unknown>[] = [];
      await t.blocker.client.exec('BEGIN');
      try {
        await t.blocker.client.query('select id from acceptance_duties where id=$1 for update', [
          f.target!.id,
        ]);
        const merged = mergeAcceptanceDuties(t.peers[0].db, f.write, NOW);
        jobs.push(merged);
        void merged.catch(() => {});
        await blocked(mergePid!);
        const other =
          mode === 'settle'
            ? settleAcceptanceDuty(t.peers[1].db, { ...f.target!, by: 'late', evidence: '只核过旧代次' }, NOW)
            : supersedeAcceptanceDuty(
                t.peers[1].db,
                { source: f.sources[1]!, target: f.target!, by: 'late', evidence: '旧代次覆盖' },
                NOW,
              );
        jobs.push(other);
        void other.catch(() => {});
        await blocked(otherPid!);
        await t.blocker.client.exec('COMMIT');
        expect((await merged).target).toMatchObject({ generation: 2, settledAt: null, supersededAt: null });
        await expect(other).rejects.toThrow(/代次/);
        expect(await t.db.select().from(acceptanceDutySupersessions)).toHaveLength(0);
        const target = (await t.db.select().from(acceptanceDuties)).find((r) => r.id === f.target!.id)!;
        expect(target).toMatchObject({
          generation: 2,
          settledAt: null,
          supersededAt: null,
          items: f.contract.items,
        });
      } finally {
        await t.blocker.client.exec('ROLLBACK');
        await Promise.allSettled(jobs);
      }
    },
  );
  it('supersede先提交、归并等PR锁，现行已结源不能被旧计划再次归并', async () => {
    const f = await mergeFixture(t.db, true),
      [mergePid] = await pids();
    let merged: Promise<unknown> | undefined;
    await t.blocker.client.exec('BEGIN');
    try {
      await t.blocker.client.query(
        'select number from pull_requests where repo_id=$1 and number=2 for update',
        [f.repo.id],
      );
      merged = mergeAcceptanceDuties(t.peers[0].db, f.write, NOW);
      void merged.catch(() => {});
      await blocked(mergePid!);
      await supersedeAcceptanceDuty(
        t.peers[1].db,
        { source: f.sources[1]!, target: f.target!, by: 'early', evidence: '已验覆盖' },
        NOW,
      );
      await t.blocker.client.exec('COMMIT');
      await expect(merged).rejects.toThrow(/已结清/);
      expect(await t.db.select().from(acceptanceDutySupersessions)).toHaveLength(1);
      expect(await t.db.select().from(auditLog)).toHaveLength(0);
      expect(await t.db.select().from(idempotencyKeys)).toHaveLength(0);
      expect(
        (await t.db.select().from(acceptanceDuties)).find((r) => r.id === f.target!.id)?.generation,
      ).toBe(1);
    } finally {
      await t.blocker.client.exec('ROLLBACK');
      if (merged) await Promise.allSettled([merged]);
    }
  });
  it('engine先新增源项、归并等PR锁，旧计划明确失效且不留审计或占键', async () => {
    const f = await mergeFixture(t.db),
      source = f.sources[0]!,
      [mergePid] = await pids();
    let merged: Promise<unknown> | undefined;
    await t.blocker.client.exec('BEGIN');
    try {
      await t.blocker.client.query(
        'select number from pull_requests where repo_id=$1 and number=2 for update',
        [f.repo.id],
      );
      merged = mergeAcceptanceDuties(t.peers[0].db, f.write, NOW);
      void merged.catch(() => {});
      await blocked(mergePid!);
      await upsertAcceptanceDuty(t.peers[1].db, {
        taskId: source.taskId,
        repo: source.repo,
        issueNumber: source.issueNumber,
        prNumber: source.prNumber,
        head: source.head,
        items: ['后来要求'],
      });
      await t.blocker.client.exec('COMMIT');
      await expect(merged).rejects.toThrow(/代次|失效/);
      expect(await t.db.select().from(acceptanceDuties)).toHaveLength(2);
      expect(await t.db.select().from(auditLog)).toHaveLength(0);
      expect(await t.db.select().from(idempotencyKeys)).toHaveLength(0);
    } finally {
      await t.blocker.client.exec('ROLLBACK');
      if (merged) await Promise.allSettled([merged]);
    }
  });
  it.each(['nullUpdated', 'inserted'] as const)(
    'run关联%s先提交，归并等表锁后必须重读并拒绝冲突任务',
    async (mode) => {
      const f = await mergeFixture(t.db),
        [mergePid] = await pids();
      const [other] = await t.db
        .insert(tasks)
        .values({
          repoId: f.repo.id,
          issueNumber: 2,
          title: '另一任务',
          rawRequest: 'fixture',
          requestedBy: 'fixture',
          priority: 1,
        })
        .returning();
      const runId = randomUUID();
      if (mode === 'nullUpdated')
        await t.db.insert(runs).values({
          id: runId,
          segment: 'manual',
          model: 'm',
          startedAt: NOW,
          taskId: other!.id,
          workflowId: f.contract.workflowId,
        });
      let merged: Promise<unknown> | undefined;
      await t.blocker.client.exec('BEGIN');
      try {
        if (mode === 'nullUpdated')
          await t.blocker.client.query('update runs set temporal_run_id=$1 where id=$2', [
            f.contract.temporalRunId,
            runId,
          ]);
        else
          await t.blocker.client.query(
            'insert into runs(id,segment,model,started_at,task_id,workflow_id,temporal_run_id) values($1,$2,$3,$4,$5,$6,$7)',
            [
              runId,
              'manual',
              'm',
              NOW.toISOString(),
              other!.id,
              f.contract.workflowId,
              f.contract.temporalRunId,
            ],
          );
        merged = mergeAcceptanceDuties(t.peers[0].db, f.write, NOW);
        void merged.catch(() => {});
        await blocked(mergePid!);
        await t.blocker.client.exec('COMMIT');
        await expect(merged).rejects.toThrow(/run.*冲突/);
        expect(await t.db.select().from(acceptanceDuties)).toHaveLength(2);
        expect(await t.db.select().from(auditLog)).toHaveLength(0);
        expect(await t.db.select().from(idempotencyKeys)).toHaveLength(0);
      } finally {
        await t.blocker.client.exec('ROLLBACK');
        if (merged) await Promise.allSettled([merged]);
      }
    },
  );
  it('runs写入持续占锁，2秒拿不到SHARE锁明确失败并回滚本次占键', async () => {
    const f = await mergeFixture(t.db),
      [mergePid] = await pids();
    let merged: Promise<unknown> | undefined;
    await t.blocker.client.exec('BEGIN');
    try {
      await t.blocker.client.exec('LOCK TABLE runs IN ROW EXCLUSIVE MODE');
      merged = mergeAcceptanceDuties(t.peers[0].db, f.write, NOW);
      void merged.catch(() => {});
      await blocked(mergePid!);
      await expect(merged).rejects.toThrow();
    } finally {
      await t.blocker.client.exec('ROLLBACK');
      if (merged) await Promise.allSettled([merged]);
    }
    expect(await t.db.select().from(acceptanceDuties)).toHaveLength(2);
    expect(await t.db.select().from(auditLog)).toHaveLength(0);
    expect(await t.db.select().from(idempotencyKeys)).toHaveLength(0);
  });
});
