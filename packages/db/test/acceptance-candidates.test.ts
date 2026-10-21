import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { acceptanceDutyState } from '@fleet-dao/shared';
import { asc, eq } from 'drizzle-orm';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import {
  acceptanceDirtyGroupsQuery,
  maintainAcceptanceCandidates,
  refreshAcceptanceCandidateGroup,
} from '../src/queries/acceptance-candidates.ts';
import {
  settleAcceptanceDuty,
  supersedeAcceptanceDuty,
  upsertAcceptanceDuty,
} from '../src/queries/acceptance-duties.ts';
import { mergeAcceptanceDuties } from '../src/queries/acceptance-merge.ts';
import { listCommanderAcceptanceTasks } from '../src/queries/commander.ts';
import {
  acceptanceCandidateBootstrap,
  acceptanceCandidateGroups,
  acceptanceDuties,
  pullRequests,
  repos,
  tasks,
} from '../src/schema/index.ts';
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
function insertable(row: typeof acceptanceDuties.$inferSelect) {
  const { id: _id, ...values } = row;
  return values;
}

async function closedFixture() {
  const f = await mergeFixture(t.db);
  const merged = await mergeAcceptanceDuties(t.db, f.write, NOW);
  const target = await settleAcceptanceDuty(
    t.db,
    { ...merged.target, by: 'test', evidence: 'all items' },
    NOW,
  );
  for (const source of f.sources)
    await supersedeAcceptanceDuty(t.db, { source, target, by: 'test', evidence: 'covered' }, NOW);
  return { ...f, target };
}

// 隔离夹具中的旧算法oracle：故意保留全表和同仓PR遍历，产品代码没有这个fallback。
async function oracle(before: Date) {
  const duties = await t.db.select().from(acceptanceDuties).orderBy(asc(acceptanceDuties.id));
  const allTasks = await t.db.select().from(tasks);
  const allRepos = await t.db.select().from(repos);
  const prs = await t.db.select().from(pullRequests);
  return allTasks
    .flatMap((task) => {
      const repo = allRepos.find((r) => r.id === task.repoId)!;
      return prs
        .filter((p) => p.repoId === task.repoId && p.state === 'merged' && p.mergedAt && p.mergedAt <= before)
        .flatMap((p) => {
          const rows = duties.filter((d) => d.taskId === task.id && d.prNumber === p.number);
          if (!rows.some((d) => acceptanceDutyState(d, rows) === 'open')) return [];
          return [
            {
              taskId: task.id,
              owner: repo.owner,
              name: repo.name,
              issueNumber: task.issueNumber,
              title: task.title,
              workflowId: null,
              prNumber: p.number,
              head: p.headSha,
              mergedAt: p.mergedAt!,
              mergeCommit: p.mergeSha,
              duties: rows,
            },
          ];
        });
    })
    .sort(
      (a, b) =>
        a.owner.localeCompare(b.owner) ||
        a.name.localeCompare(b.name) ||
        a.issueNumber - b.issueNumber ||
        a.prNumber - b.prNumber,
    );
}

describe('验收候选派生索引', () => {
  it('未初始化或dirty不能返回空或看似完整的候选', async () => {
    await mergeFixture(t.db);
    await expect(listCommanderAcceptanceTasks(t.db, NOW)).rejects.toThrow(/未读全|unknown/);
  });
  it('shared完整判法字节摘要变化必须升级版本并正式重建，不复用旧clean缓存', () => {
    const source = readFileSync(
      new URL('../../shared/src/acceptance.ts', import.meta.url),
      'utf8',
    ).replaceAll('\r\n', '\n');
    expect(
      createHash('sha256').update(source).digest('hex'),
      '变更判法须同步semanticsVersion和重建迁移',
    ).toBe('8f1b0081f39aa1cd37762d8b9869daaa69e3dab0f4644356f76af1d695f28f6b');
  });
  it('有效superseded不入选；target换代重开，新代settle之后旧源仍open且上下文完整', async () => {
    const f = await closedFixture();
    await maintainAcceptanceCandidates(t.db);
    expect(await listCommanderAcceptanceTasks(t.db, NOW)).toEqual([]);
    await upsertAcceptanceDuty(t.db, { ...insertable(f.target), items: ['新增项'] });
    await expect(listCommanderAcceptanceTasks(t.db, NOW)).rejects.toThrow(/unknown/);
    await maintainAcceptanceCandidates(t.db);
    expect(await listCommanderAcceptanceTasks(t.db, NOW)).toEqual(await oracle(NOW));
    const [newTarget] = await t.db
      .select()
      .from(acceptanceDuties)
      .where(eq(acceptanceDuties.id, f.target.id));
    await settleAcceptanceDuty(t.db, { ...newTarget!, by: 'test', evidence: 'new generation' }, NOW);
    await maintainAcceptanceCandidates(t.db);
    const got = await listCommanderAcceptanceTasks(t.db, NOW);
    expect(got).toEqual(await oracle(NOW));
    expect(got[0]!.duties).toHaveLength(3);
    expect(got[0]!.duties.find((d) => d.id === f.target.id)?.settledAt).not.toBeNull();
  });
  it.each(['identity', 'merge', 'coverage', 'missing-coverage', 'missing-target'] as const)(
    '失效替代%s保留open，与完整oracle一致',
    async (mode) => {
      const f = await closedFixture();
      if (mode === 'identity')
        await t.db
          .update(acceptanceDuties)
          .set({ repo: 'wrong/repo' })
          .where(eq(acceptanceDuties.id, f.target.id));
      if (mode === 'merge')
        await t.db
          .update(acceptanceDuties)
          .set({ mergeCommit: null })
          .where(eq(acceptanceDuties.id, f.target.id));
      if (mode === 'coverage')
        await t.db
          .update(acceptanceDuties)
          .set({ supersedeCoverage: [{ source: 'not-original', target: '检查', basis: 'bad' }] })
          .where(eq(acceptanceDuties.id, f.sources[0]!.id));
      if (mode === 'missing-coverage')
        await t.db
          .update(acceptanceDuties)
          .set({ items: ['目标没有的新项'] })
          .where(eq(acceptanceDuties.id, f.sources[0]!.id));
      // FK仍存在，但目标移动到另一个PR，现行合同同task/PR上下文中读不到。
      if (mode === 'missing-target')
        await t.db.update(acceptanceDuties).set({ prNumber: 3 }).where(eq(acceptanceDuties.id, f.target.id));
      await maintainAcceptanceCandidates(t.db);
      expect(await listCommanderAcceptanceTasks(t.db, NOW)).toEqual(await oracle(NOW));
      expect(await listCommanderAcceptanceTasks(t.db, NOW)).toHaveLength(1);
    },
  );
  it('同仓多task/PR、不同仓同号、PR0、近期/未合PR、done旧任务与原oracle完整对照', async () => {
    const f = await mergeFixture(t.db);
    await t.db.update(tasks).set({ state: 'done' }).where(eq(tasks.id, f.task.id));
    const [otherRepo] = await t.db
      .insert(repos)
      .values({ owner: 'other', name: 'repo', testCommand: 'pnpm check' })
      .returning();
    const [otherTask] = await t.db
      .insert(tasks)
      .values({
        repoId: otherRepo!.id,
        issueNumber: 1,
        title: 'other',
        rawRequest: 'test',
        requestedBy: 'test',
        priority: 1,
      })
      .returning();
    const [sameRepoTask] = await t.db
      .insert(tasks)
      .values({
        repoId: f.repo.id,
        issueNumber: 3,
        title: 'same repo',
        rawRequest: 'test',
        requestedBy: 'test',
        priority: 1,
      })
      .returning();
    await t.db.insert(pullRequests).values([
      {
        repoId: otherRepo!.id,
        number: 2,
        state: 'merged',
        headRef: 'x',
        headSha: 'c'.repeat(40),
        mergedAt: NOW,
        updatedAt: NOW,
      },
      {
        repoId: f.repo.id,
        number: 3,
        state: 'merged',
        headRef: 'x',
        headSha: 'd'.repeat(40),
        mergedAt: new Date(NOW.getTime() + 1),
        updatedAt: NOW,
      },
      { repoId: f.repo.id, number: 4, state: 'open', headRef: 'x', headSha: 'e'.repeat(40), updatedAt: NOW },
      {
        repoId: f.repo.id,
        number: 99,
        state: 'merged',
        headRef: 'x',
        headSha: '9'.repeat(40),
        mergedAt: NOW,
        updatedAt: NOW,
      },
    ]);
    for (const [task, repo] of [
      [otherTask!, 'other/repo'],
      [sameRepoTask!, 'merge/fixture'],
    ] as const)
      await t.db.insert(acceptanceDuties).values({
        taskId: task.id,
        repo,
        issueNumber: task.issueNumber,
        prNumber: 2,
        head: 'c'.repeat(40),
        items: ['x'],
      });
    for (const prNumber of [0, 3, 4])
      await t.db.insert(acceptanceDuties).values({
        taskId: f.task.id,
        repo: 'merge/fixture',
        issueNumber: 1,
        prNumber,
        head: `${prNumber}`,
        items: ['x'],
      });
    await maintainAcceptanceCandidates(t.db);
    expect(await listCommanderAcceptanceTasks(t.db, NOW)).toEqual(await oracle(NOW));
    expect((await listCommanderAcceptanceTasks(t.db, NOW)).map((r) => r.prNumber)).toEqual([2, 2, 2]);
  });
  it('全部业务写者与直接UPDATE/DELETE事务失效；回滚不改revision/dirty', async () => {
    const f = await mergeFixture(t.db);
    await maintainAcceptanceCandidates(t.db);
    const [before] = await t.db.select().from(acceptanceCandidateGroups);
    await expect(
      t.db.transaction(async (tx) => {
        await tx
          .update(acceptanceDuties)
          .set({ items: ['rollback'] })
          .where(eq(acceptanceDuties.id, f.sources[0]!.id));
        throw new Error('rollback');
      }),
    ).rejects.toThrow('rollback');
    expect(await t.db.select().from(acceptanceCandidateGroups)).toEqual([before]);
    await mergeAcceptanceDuties(t.db, f.write, NOW);
    expect(await acceptanceDirtyGroupsQuery(t.db, 128)).toHaveLength(1);
    await maintainAcceptanceCandidates(t.db);
    await t.db.delete(acceptanceDuties).where(eq(acceptanceDuties.taskId, f.task.id));
    expect(await acceptanceDirtyGroupsQuery(t.db, 128)).toHaveLength(1);
    await maintainAcceptanceCandidates(t.db);
    expect(await listCommanderAcceptanceTasks(t.db, NOW)).toEqual([]);
    expect((await t.db.select().from(acceptanceCandidateGroups))[0]!.revision).toBeGreaterThan(
      before!.revision,
    );
    await t.db.delete(tasks).where(eq(tasks.id, f.task.id));
    expect(await t.db.select().from(acceptanceCandidateGroups)).toEqual([]);
  });
  it('持久bootstrap分批重启，低ID新写仍trigger覆盖，不能把第一页当成功', async () => {
    const f = await mergeFixture(t.db);
    await t.db.delete(acceptanceCandidateGroups);
    await expect(maintainAcceptanceCandidates(t.db, { bootstrapRows: 1 })).rejects.toThrow(/初始化尚未完成/);
    expect((await t.db.select().from(acceptanceCandidateBootstrap))[0]!.cursorId).toBe(f.sources[0]!.id);
    await upsertAcceptanceDuty(t.db, { ...insertable(f.sources[0]!), items: ['later'] });
    await maintainAcceptanceCandidates(t.db, { bootstrapRows: 1 });
    expect(await listCommanderAcceptanceTasks(t.db, NOW)).toEqual(await oracle(NOW));
  });
  it('CAS失败保留新失效；公平尝试排序不让热组一直占首页', async () => {
    const f = await mergeFixture(t.db);
    await maintainAcceptanceCandidates(t.db);
    await t.db
      .update(acceptanceDuties)
      .set({ items: ['first'] })
      .where(eq(acceptanceDuties.id, f.sources[0]!.id));
    const [observed] = await acceptanceDirtyGroupsQuery(t.db, 1);
    await t.db
      .update(acceptanceDuties)
      .set({ items: ['second'] })
      .where(eq(acceptanceDuties.id, f.sources[0]!.id));
    expect((await refreshAcceptanceCandidateGroup(t.db, observed!, 100)).published).toBe(false);
    await t.db.insert(acceptanceDuties).values({ ...insertable(f.sources[0]!), prNumber: 3 });
    expect((await acceptanceDirtyGroupsQuery(t.db, 1))[0]!.prNumber).toBe(3);
    await expect(maintainAcceptanceCandidates(t.db, { groups: 1 })).rejects.toThrow(/unknown/);
    expect((await acceptanceDirtyGroupsQuery(t.db, 1))[0]!.prNumber).toBe(2);
    await maintainAcceptanceCandidates(t.db);
  });
  it('旧语义refresher最后CAS必须重核版本；版本失配时reader/维护明确unknown', async () => {
    await mergeFixture(t.db);
    await maintainAcceptanceCandidates(t.db);
    await t.db.update(acceptanceCandidateGroups).set({ dirty: true });
    const [observed] = await acceptanceDirtyGroupsQuery(t.db, 1);
    await t.db.update(acceptanceCandidateBootstrap).set({ semanticsVersion: 2 });
    expect((await refreshAcceptanceCandidateGroup(t.db, observed!, 100)).published).toBe(false);
    expect(await acceptanceDirtyGroupsQuery(t.db, 128)).toHaveLength(1);
    await expect(maintainAcceptanceCandidates(t.db)).rejects.toThrow(/版本/);
    await expect(listCommanderAcceptanceTasks(t.db, NOW)).rejects.toThrow(/unknown/);
  });
  it('责任预算超限保留dirty明确unknown，不截取成功', async () => {
    await mergeFixture(t.db);
    await expect(maintainAcceptanceCandidates(t.db, { duties: 1 })).rejects.toThrow(/预算/);
    expect(await acceptanceDirtyGroupsQuery(t.db, 128)).toHaveLength(1);
    await maintainAcceptanceCandidates(t.db);
  });
});
