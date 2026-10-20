import {
  type AcceptanceMergeContract,
  acceptanceDuties,
  acceptanceMergeDutyContract,
  acceptanceMergePlanHash,
  type Db,
  pullRequests,
  repos,
  tasks,
  upsertAcceptanceDuty,
} from '@fleet-dao/db';
import { createTestDb, resetTestDb, TEST_DB_TIMEOUT_MS, type TestDb } from '@fleet-dao/db/testing';
import { acceptanceDutyState } from '@fleet-dao/shared';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { planAcceptanceMerge } from '../src/acceptance-cli.ts';
import type { AcceptanceExecutionReader } from '../src/acceptance-execution-reader.ts';
import { ACCEPTANCE_PUBLIC_PATH, acceptancePublicRoutes } from '../src/acceptance-public.ts';
import { type CliDeps, main } from '../src/cli.ts';
import type { Deps } from '../src/deps.ts';

const NOW = new Date('2026-10-20T00:00:00Z');
async function mergeFixture(db: Db, existing = false) {
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
async function prepare() {
  const f = await mergeFixture(t.db);
  const input = {
    action: 'merge-plan' as const,
    repo: f.contract.repo,
    issueNumber: 1,
    taskId: f.task.id,
    workflowId: f.contract.workflowId,
    temporalRunId: f.contract.temporalRunId,
    prNumber: 2,
    head: f.contract.head,
    mergeCommit: f.contract.mergeCommit,
    duties: f.sources.map((s) => ({ id: s.id, generation: s.generation })),
  };
  const reader: AcceptanceExecutionReader = {
    read: async (identity) =>
      identity.taskId !== input.taskId || identity.temporalRunId !== input.temporalRunId
        ? { kind: 'unknown', code: 'identity_conflict' }
        : {
            kind: 'observed',
            stats: { events: 8, pages: 1, bytes: 999 },
            proof: {
              namespace: 'test',
              workflowId: input.workflowId,
              runId: input.temporalRunId,
              taskId: input.taskId,
              repo: input.repo,
              issueNumber: 1,
              workflowType: 'taskWorkflow',
              taskQueue: 'q',
              startHash: '0'.repeat(64),
              closeEvent: '8',
              status: 2,
              final: {
                head: input.head,
                prNumber: 2,
                scheduled: '6',
                completed: '7',
                payloadHash: '0'.repeat(64),
              },
              sources: f.sources.map((s, i) => ({
                kind: i ? 'acceptanceDuties' : 'coldVerify',
                head: s.head,
                prNumber: s.prNumber,
                items: [...s.items],
                scheduled: '2',
                completed: '3',
                payloadHash: '0'.repeat(64),
              })),
            },
          },
  };
  const argv = [
    'acceptance',
    'merge-plan',
    input.repo,
    '1',
    '--task',
    input.taskId,
    '--workflow',
    input.workflowId,
    '--run',
    input.temporalRunId,
    '--pr',
    '2',
    '--head',
    input.head,
    '--merge-commit',
    input.mergeCommit,
    '--duties',
    input.duties.map((d) => `${d.id}:${d.generation}`).join(','),
  ];
  const out: string[] = [],
    err: string[] = [];
  const deps = {
    env: { DATABASE_URL: 'test' },
    out: (s: string) => out.push(s),
    err: (s: string) => err.push(s),
    openDb: async () => ({ db: t.db, close: async () => {} }),
    now: () => NOW,
    acceptanceExecutionReader: reader,
  } as unknown as CliDeps;
  return { f, input, reader, argv, out, err, deps };
}
describe('正式私有CLI plan→merge及公开边界', () => {
  it('正式plan→merge→独立settle→supersede；后续目标新增换代使旧替代重新开放', async () => {
    const s = await prepare();
    expect(await main(s.argv, s.deps)).toBe(0);
    const plan = JSON.parse(s.out.pop()!);
    const write = s.argv
      .map((v, i) => (i === 1 ? 'merge' : v))
      .concat([
        '--request',
        '00000000-0000-4000-8000-000000000098',
        '--plan',
        plan.planHash,
        '--reason',
        '保留原项',
        '--evidence',
        '可信原执行',
      ]);
    expect(await main(write, s.deps)).toBe(0);
    const { target } = JSON.parse(s.out.pop()!);
    const initial = await t.db.select().from(acceptanceDuties);
    expect(initial.filter((r) => r.head !== target.head)).toEqual(s.f.sources);
    expect(initial.find((r) => r.id === target.id)?.settledAt).toBeNull();
    const supersede = [
      'acceptance',
      'supersede',
      s.input.repo,
      '1',
      '--id',
      String(s.f.sources[0]!.id),
      '--generation',
      '1',
      '--pr',
      '2',
      '--head',
      s.f.sources[0]!.head,
      '--target-id',
      String(target.id),
      '--target-generation',
      String(target.generation),
      '--target-pr',
      '2',
      '--target-head',
      target.head,
      '--evidence',
      '完整原项覆盖',
    ];
    expect(await main(supersede, s.deps)).toBe(1);
    expect(
      await main(
        [
          'acceptance',
          'settle',
          s.input.repo,
          '1',
          '--id',
          String(target.id),
          '--generation',
          String(target.generation),
          '--pr',
          '2',
          '--head',
          target.head,
          '--evidence',
          '独立逐项验收',
        ],
        s.deps,
      ),
    ).toBe(0);
    s.out.pop();
    expect(await main(supersede, s.deps)).toBe(0);
    s.out.pop();
    const replaced = await t.db.select().from(acceptanceDuties);
    expect(acceptanceDutyState(replaced.find((r) => r.id === s.f.sources[0]!.id)!, replaced)).toBe(
      'superseded',
    );
    await upsertAcceptanceDuty(t.db, {
      taskId: s.f.task.id,
      repo: s.input.repo,
      issueNumber: 1,
      prNumber: 2,
      head: target.head,
      items: ['后来要求'],
    });
    const changed = await t.db.select().from(acceptanceDuties);
    expect(changed.find((r) => r.id === target.id)).toMatchObject({ generation: 2, settledAt: null });
    expect(acceptanceDutyState(changed.find((r) => r.id === s.f.sources[0]!.id)!, changed)).toBe('open');
    expect(await main(supersede, s.deps)).toBe(1);
  });
  it('NULL旧关联仍须可信reader；正式写入/同request重试不重写，公开口无原项/计划/证明', async () => {
    const s = await prepare();
    expect(await main(s.argv, s.deps)).toBe(0);
    const plan = JSON.parse(s.out.pop()!);
    expect(plan.ok).toBe(true);
    expect(plan.planHash).toMatch(/^[0-9a-f]{64}$/);
    const write = s.argv
      .map((v, i) => (i === 1 ? 'merge' : v))
      .concat([
        '--request',
        '00000000-0000-4000-8000-000000000099',
        '--plan',
        plan.planHash,
        '--reason',
        '保留旧要求',
        '--evidence',
        '原执行记录',
      ]);
    expect(await main(write, s.deps)).toBe(0);
    const result = JSON.parse(s.out.pop()!);
    expect(result.replayed).toBe(false);
    expect(await main(write, s.deps)).toBe(0);
    expect(JSON.parse(s.out.pop()!).replayed).toBe(true);
    const rows = await t.db.select().from(acceptanceDuties);
    const publicApp = acceptancePublicRoutes({
      ciPolicyBridge: { read: async () => ({ repo: s.input.repo }) },
      acceptanceDuties: async () => rows,
    } as unknown as Deps);
    const response = await publicApp.request(
      ACCEPTANCE_PUBLIC_PATH.replace(':githubId', '9').replace(':issue', '1'),
    );
    expect(response.status).toBe(200);
    const body = await response.text();
    for (const word of ['历史要求', 'itemSources', 'proof', 'planHash', 'items', 'management_merge'])
      expect(body).not.toContain(word);
  });
  it('旧账、session UUID或无可信原项不能自行授权；失败不产生可用计划', async () => {
    const s = await prepare();
    expect((await planAcceptanceMerge(t.db, s.input)).ok).toBe(false);
    expect((await planAcceptanceMerge(t.db, { ...s.input, temporalRunId: s.f.task.id }, s.reader)).ok).toBe(
      false,
    );
    const noSource: AcceptanceExecutionReader = {
      read: async (id) => {
        const r = await s.reader.read(id);
        if (r.kind === 'observed') r.proof.sources = [];
        return r;
      },
    };
    const plan = await planAcceptanceMerge(t.db, s.input, noSource);
    expect(plan.ok).toBe(false);
    expect(plan.contract).toBeNull();
    expect(plan.target.items).toEqual([]);
  });
  it('merge必须有request/plan/reason/evidence；只读和写入的定位原项来自同一合同', async () => {
    const s = await prepare();
    expect(
      await main(
        s.argv.map((v, i) => (i === 1 ? 'merge' : v)),
        s.deps,
      ),
    ).toBe(1);
    expect(s.out).toEqual([]);
    const a = await planAcceptanceMerge(t.db, s.input, s.reader),
      b = await planAcceptanceMerge(t.db, { ...s.input, duties: [...s.input.duties].reverse() }, s.reader);
    expect(a.planHash).toBe(b.planHash);
  });
});
