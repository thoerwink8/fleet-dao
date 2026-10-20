import type { Db } from '../src/client.ts';
import {
  type AcceptanceMergeContract,
  acceptanceMergeDutyContract,
  acceptanceMergePlanHash,
} from '../src/queries/acceptance-merge.ts';
import { acceptanceDuties, pullRequests, repos, tasks } from '../src/schema/index.ts';
export const NOW = new Date('2026-10-20T00:00:00Z');
export async function mergeFixture(db: Db, existing = false) {
  const [repo] = await db
    .insert(repos)
    .values({ owner: 'merge', name: 'fixture', testCommand: 'pnpm check' })
    .returning();
  const [task] = await db
    .insert(tasks)
    .values({
      repoId: repo!.id,
      issueNumber: 1,
      title: '归并',
      rawRequest: 'fixture',
      requestedBy: 'fixture',
      priority: 1,
    })
    .returning();
  await db.insert(pullRequests).values({
    repoId: repo!.id,
    number: 2,
    state: 'merged',
    headRef: 'test',
    headSha: 'f'.repeat(40),
    mergeSha: 'e'.repeat(40),
    mergedAt: NOW,
    updatedAt: NOW,
  });
  const sources = await db
    .insert(acceptanceDuties)
    .values(
      ['a', 'b'].map((h, i) => ({
        taskId: task!.id,
        repo: 'merge/fixture',
        issueNumber: 1,
        prNumber: 2,
        head: h.repeat(40),
        items: [i ? '检查' : '历史要求'],
        source: 'cold_verify',
      })),
    )
    .returning();
  const [target] = existing
    ? await db
        .insert(acceptanceDuties)
        .values({
          taskId: task!.id,
          repo: 'merge/fixture',
          issueNumber: 1,
          prNumber: 2,
          head: 'f'.repeat(40),
          items: ['检查'],
          source: 'cold_verify',
          mergeCommit: 'e'.repeat(40),
          mergedAt: NOW,
          settledAt: NOW,
          settledBy: 'prior',
          settleEvidence: 'prior',
        })
        .returning()
    : [];
  const union = [...new Set([...sources.flatMap((r) => r.items), ...(target?.items ?? [])])].sort();
  const contract: AcceptanceMergeContract = {
    repo: 'merge/fixture',
    issueNumber: 1,
    taskId: task!.id,
    repoId: repo!.id,
    workflowId: 'task:merge/fixture#1',
    temporalRunId: '00000000-0000-4000-8000-000000000002',
    prNumber: 2,
    head: 'f'.repeat(40),
    mergeCommit: 'e'.repeat(40),
    sources: sources.map(acceptanceMergeDutyContract),
    target: target ? acceptanceMergeDutyContract(target) : null,
    items: union,
    itemSources: union.map((item) => ({
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
    proof: { fixture: 'explicitly synthetic; product reader tested separately' },
  };
  const write = {
    request: '00000000-0000-4000-8000-000000000003',
    planHash: acceptanceMergePlanHash(contract),
    by: 'ops:test',
    reason: '保留全部历史要求',
    evidence: '测试夹具',
    contract,
  };
  return { repo: repo!, task: task!, sources, target, contract, write };
}
