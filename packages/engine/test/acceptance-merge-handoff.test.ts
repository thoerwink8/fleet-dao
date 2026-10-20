// 历史验收责任归并（#3207）与引擎的接续：merge 建出的 management_merge 目标是普通待验行，
// 引擎原有的读（openAcceptanceDuties）、重复转交（recordAcceptanceDuties）、最终验收（settleAcceptanceDuty）、
// 旧头替代（supersedeAcceptanceDuty）都按精确身份和代次接得住；换代后旧代次、旧替代不再放行。

import {
  type AcceptanceDutyRow,
  type AcceptanceMergeContract,
  acceptanceDuties,
  acceptanceMergeDutyContract,
  acceptanceMergePlanHash,
  mergeAcceptanceDuties,
  pullRequests,
  readAcceptanceDutyRows,
  repos,
  settleAcceptanceDuty,
  supersedeAcceptanceDuty,
  tasks,
} from '@fleet-dao/db';
import { createTestDb, resetTestDb, TEST_DB_TIMEOUT_MS, type TestDb } from '@fleet-dao/db/testing';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { openAcceptanceDuties, recordAcceptanceDuties } from '../src/real/store-ports.ts';

const NOW = new Date('2026-10-20T08:00:00Z');
const FINAL = 'f'.repeat(40);
const MERGE = 'e'.repeat(40);
const REPO = { owner: 'merge', name: 'handoff' };
const PR = 7;

let t: TestDb;
beforeAll(async () => {
  t = await createTestDb();
}, TEST_DB_TIMEOUT_MS);
afterAll(() => t.close());
beforeEach(() => resetTestDb(t));

const ident = (r: AcceptanceDutyRow) => ({
  id: r.id,
  generation: r.generation,
  repo: r.repo,
  issueNumber: r.issueNumber,
  prNumber: r.prNumber,
  head: r.head,
});

async function seed() {
  const [repo] = await t.db
    .insert(repos)
    .values({ ...REPO, testCommand: 'pnpm check' })
    .returning();
  const [task] = await t.db
    .insert(tasks)
    .values({
      repoId: repo!.id,
      issueNumber: 3207,
      title: '归并',
      rawRequest: 'x',
      requestedBy: 'x',
      priority: 1,
    })
    .returning();
  await t.db.insert(pullRequests).values({
    repoId: repo!.id,
    number: PR,
    state: 'merged',
    headRef: 'b',
    headSha: FINAL,
    mergeSha: MERGE,
    mergedAt: NOW,
    updatedAt: NOW,
  });
  return { repoId: repo!.id, taskId: task!.id };
}

const addSource = async (taskId: string, head: string, items: string[]) => {
  const [row] = await t.db
    .insert(acceptanceDuties)
    .values({
      taskId,
      repo: 'merge/handoff',
      issueNumber: 3207,
      prNumber: PR,
      head,
      items,
      source: 'cold_verify',
    })
    .returning();
  return row!;
};

/** 用真实归并事务把 sources 并进最终头；target 为库里已有的最终头行（没有传 null）。 */
async function merge(
  s: { repoId: string; taskId: string },
  sources: AcceptanceDutyRow[],
  target: AcceptanceDutyRow | null,
  request: string,
) {
  const items = [...new Set([...sources.flatMap((r) => r.items), ...(target?.items ?? [])])].sort();
  const contract: AcceptanceMergeContract = {
    repo: 'merge/handoff',
    issueNumber: 3207,
    taskId: s.taskId,
    repoId: s.repoId,
    workflowId: 'task:merge/handoff#3207',
    temporalRunId: '00000000-0000-4000-8000-000000000002',
    prNumber: PR,
    head: FINAL,
    mergeCommit: MERGE,
    sources: sources.map(acceptanceMergeDutyContract),
    target: target ? acceptanceMergeDutyContract(target) : null,
    items,
    itemSources: items.map((item) => ({
      item,
      sources: [...sources, ...(target ? [target] : [])]
        .filter((r) => r.items.includes(item))
        .map((r) => ({
          id: r.id,
          generation: r.generation,
          head: r.head,
          existingTarget: r.id === target?.id,
        })),
    })),
    proof: { fixture: 'synthetic' },
  };
  const { target: made } = await mergeAcceptanceDuties(
    t.db,
    {
      request,
      planHash: acceptanceMergePlanHash(contract),
      by: 'ops:test',
      reason: '保留全部历史要求',
      evidence: '测试',
      contract,
    },
    NOW,
  );
  return made;
}

const REQ1 = '00000000-0000-4000-8000-000000000011';
const REQ2 = '00000000-0000-4000-8000-000000000012';
const rows = () => readAcceptanceDutyRows(t.db, { repo: 'merge/handoff', issueNumber: 3207 });
const settle = (r: AcceptanceDutyRow) =>
  settleAcceptanceDuty(t.db, { ...ident(r), by: 'frank', evidence: '最终头现场验收' }, NOW);
const openHeads = async (taskId: string) =>
  (await openAcceptanceDuties(t.db, taskId)).map((d) => d.head).sort();

describe('归并目标由引擎原有入口接续（#3207）', () => {
  it('merge 建出的待验目标：引擎读得到、重复转交不换代不开回、旧代次拿不到终态、最终验收+替代后收得掉', async () => {
    const s = await seed();
    const a = await addSource(s.taskId, 'a'.repeat(40), ['历史要求']);
    const b = await addSource(s.taskId, 'b'.repeat(40), ['检查']);
    const target = await merge(s, [a, b], null, REQ1);
    expect(target).toMatchObject({ source: 'management_merge', generation: 1, head: FINAL, settledAt: null });

    // 引擎读：目标连同合并回执、并集验收项都在待验里
    const open = await openAcceptanceDuties(t.db, s.taskId);
    expect(open.find((d) => d.head === FINAL)).toMatchObject({
      prNumber: PR,
      items: ['历史要求', '检查'],
      mergeCommit: MERGE,
    });

    // 引擎重放同头同项：幂等，不换代
    await recordAcceptanceDuties(
      t.db,
      {
        taskId: s.taskId,
        repo: REPO,
        issueNumber: 3207,
        record: [{ prNumber: PR, head: FINAL, items: ['检查'], mergeCommit: MERGE }],
      },
      NOW,
    );
    expect((await rows()).find((r) => r.head === FINAL)).toMatchObject({
      generation: 1,
      source: 'management_merge',
    });

    // 独立验收入口：错代次拿不到终态，精确身份收得掉
    await expect(settle({ ...target!, generation: 0 })).rejects.toThrow('身份、代次或完成回执已变');
    await settle(target!);
    expect(await openHeads(s.taskId)).toEqual([a.head, b.head]);

    // 旧头沿原替代入口指向已验目标后，库里不再有待验行
    const final = (await rows()).find((r) => r.head === FINAL)!;
    for (const src of [a, b]) {
      await supersedeAcceptanceDuty(
        t.db,
        { source: ident(src), target: ident(final), by: 'ops:test', evidence: 'PR 最终头已合已验' },
        NOW,
      );
    }
    expect(await openAcceptanceDuties(t.db, s.taskId)).toEqual([]);
  });

  it('换代：已验目标再并进新来源项后，旧代次验收和旧替代都失效，目标重新待验', async () => {
    const s = await seed();
    const a = await addSource(s.taskId, 'a'.repeat(40), ['历史要求']);
    const target = await merge(s, [a], null, REQ1);
    await settle(target!);
    const settled = (await rows()).find((r) => r.head === FINAL)!;
    await supersedeAcceptanceDuty(
      t.db,
      { source: ident(a), target: ident(settled), by: 'ops:test', evidence: '最终头已验' },
      NOW,
    );
    expect(await openAcceptanceDuties(t.db, s.taskId)).toEqual([]);

    // 又发现一条旧头的新项：二次归并换代，撤掉最终验收；旧头的替代因目标换代过期
    const c = await addSource(s.taskId, 'c'.repeat(40), ['新发现的要求']);
    const regenerated = await merge(s, [c], settled, REQ2);
    expect(regenerated).toMatchObject({
      generation: 2,
      settledAt: null,
      items: ['历史要求', '新发现的要求'],
    });
    expect(await openHeads(s.taskId)).toEqual([a.head, c.head, FINAL].sort());

    // 迟到的旧代次验收不能收掉新项；新代次验收后只收目标，不误收未替代的新来源
    await expect(settle(settled)).rejects.toThrow('身份、代次或完成回执已变');
    await settle(regenerated!);
    expect(await openHeads(s.taskId)).toEqual([a.head, c.head].sort());
  });
});
