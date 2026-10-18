// 真 PGlite + 真 invokeVerifier/runOneShot/realRuns；只替换模型进程，不调用真实渠道。
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  getRun,
  listVerifyAggregates,
  models,
  recordVerifyAggregate,
  repos,
  seed,
  tasks,
} from '@fleet-dao/db';
import { createTestDb, resetTestDb, TEST_DB_TIMEOUT_MS, type TestDb } from '@fleet-dao/db/testing';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { realRuns } from '../src/real/runs-writer.ts';
import { invokeVerifier, type VerifierInvokeInput } from '../src/verifier-invoke.ts';

let t: TestDb;
let dir: string;
let taskId: string;
beforeAll(async () => {
  t = await createTestDb();
  dir = await mkdtemp(join(tmpdir(), 'fleet-verdict-integrity-'));
}, TEST_DB_TIMEOUT_MS);
afterAll(async () => {
  await t.close();
  await rm(dir, { recursive: true, force: true });
});
beforeEach(async () => {
  await resetTestDb(t);
  await seed(t.db);
  await t.db.insert(models).values([
    { id: 'gpt-m', family: 'gpt', displayName: 'GPT test' },
    { id: 'grok-m', family: 'grok', displayName: 'Grok test' },
  ]);
  const [repo] = await t.db
    .insert(repos)
    .values({ owner: 'fixture', name: 'integrity', testCommand: 'pnpm check' })
    .returning();
  const [task] = await t.db
    .insert(tasks)
    .values({
      repoId: repo!.id,
      issueNumber: 3140,
      title: 'verdict',
      rawRequest: 'verdict',
      requestedBy: 'test',
      priority: 1,
    })
    .returning();
  taskId = task!.id;
});
const fail = (problem: string) => `## 问题\n- 没做到验收条：${problem}\n\nverdict: fail`;
const pass = '## 问题\n\nverdict: pass';
async function run(failed: boolean, opts: Partial<VerifierInvokeInput> = {}, problem = '第 1 条未实现') {
  return invokeVerifier(
    {
      taskId,
      issueNumber: 3140,
      workflowId: 'task:fixture/integrity#3140',
      prNumber: 7,
      branch: 'fleet/3140-x',
      headSha: 'a'.repeat(40),
      baseSha: 'b'.repeat(40),
      what: '实现功能',
      howToFinish: ['功能存在', '另一个功能存在'],
      round: 1,
      modelFamiliesAvoid: [],
      requireTwoFamilies: true,
      ...opts,
    },
    {
      oneShot: {
        runs: realRuns({ db: t.db }),
        tmpDir: dir,
        buildCommand: (input) => ({ argv: ['fake', '--model', input.modelId], cwd: input.cwd }),
        spawn: async (cmd) => ({
          exitCode: 0,
          killed: false,
          stderr: '',
          stdout: failed && cmd.argv.includes('gpt-m') ? fail(problem) : pass,
        }),
      },
      fetchDiff: async () => ({ diffText: '@@ -1 +1 @@\n-a\n+b', changedFiles: ['src/a.ts'] }),
      fetchSpec: async () => ({}),
      chooseModelForFamily: async (family) =>
        family === 'gpt' || family === 'grok' ? { modelId: `${family}-m` } : undefined,
      cwd: dir,
    },
  );
}

describe('验收证据归属与聚合', () => {
  it.each([true, false])(
    'GPT fail=%s：两家各记原始 verdict，聚合保存精确头和真实贡献来源',
    async (failed) => {
      const out = await run(failed);
      expect(out.pass).toBe(!failed);
      expect(out.session).toBeUndefined();
      expect(out.sourceRunIds).toHaveLength(2);
      const rows = await Promise.all(out.sourceRunIds!.map((id) => getRun(t.db, id)));
      expect(rows.find((r) => r?.model === 'gpt-m')?.verdict).toMatchObject({ pass: !failed });
      expect(rows.find((r) => r?.model === 'grok-m')?.verdict).toEqual({
        pass: true,
        problems: [],
        failedCriteria: [],
        handedOver: [],
      });
      const all = await listVerifyAggregates(t.db, taskId);
      expect(all).toHaveLength(1);
      expect(all[0]).toMatchObject({
        headSha: 'a'.repeat(40),
        round: 1,
        sourceRunIds: [...out.sourceRunIds!].sort(),
        verdict: { pass: !failed },
      });
      const aggregate = {
        taskId,
        workflowId: all[0]!.workflowId!,
        prNumber: 7,
        headSha: 'a'.repeat(40),
        round: 1 as const,
        sourceRunIds: [...out.sourceRunIds!].reverse(),
        verdict: all[0]!.verdict,
      };
      await recordVerifyAggregate(t.db, aggregate);
      expect(await listVerifyAggregates(t.db, taskId)).toHaveLength(1);
      await expect(
        recordVerifyAggregate(t.db, { ...aggregate, verdict: { ...aggregate.verdict, pass: failed } }),
      ).rejects.toThrow('裁决冲突');
      expect(await listVerifyAggregates(t.db, taskId)).toHaveLength(1);
    },
  );

  it('原始长问题先完整入库；二轮过滤后的聚合可以通过，不能反写原始裁决', async () => {
    const problem = `第 2 条未实现：${'完整证据'.repeat(110)} 末尾证据`;
    const out = await run(
      true,
      { round: 2, recheck: { failedCriteria: [1], priorProblems: ['第 1 条未实现'] } },
      problem,
    );
    expect(out.pass).toBe(true);
    const raw = await Promise.all(out.sourceRunIds!.map((id) => getRun(t.db, id)));
    const gpt = raw.find((r) => r?.model === 'gpt-m');
    expect(gpt?.verdict?.pass).toBe(false);
    expect(gpt?.verdict?.problems[0]).toContain(problem);
    expect(gpt?.verdict?.problems[0]?.endsWith('末尾证据')).toBe(true);
    expect((await listVerifyAggregates(t.db, taskId))[0]?.verdict.pass).toBe(true);
  });

  it('同任务同 PR 换头、换轮必须是新笔；已绑定的来源不能跨头或跨轮重用', async () => {
    const first = await run(false);
    const next = await run(false, { headSha: 'c'.repeat(40), round: 2 });
    expect(next.sourceRunIds?.some((id) => first.sourceRunIds?.includes(id))).toBe(false);
    const all = await listVerifyAggregates(t.db, taskId);
    expect(all).toHaveLength(2);
    expect(all).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          headSha: 'a'.repeat(40),
          round: 1,
          sourceRunIds: [...first.sourceRunIds!].sort(),
        }),
        expect.objectContaining({
          headSha: 'c'.repeat(40),
          round: 2,
          sourceRunIds: [...next.sourceRunIds!].sort(),
        }),
      ]),
    );
    const original = all.find((r) => r.round === 1)!;
    const input = {
      taskId,
      workflowId: original.workflowId!,
      prNumber: 7,
      headSha: original.headSha,
      round: 1 as const,
      sourceRunIds: original.sourceRunIds,
      verdict: original.verdict,
    };
    await expect(recordVerifyAggregate(t.db, { ...input, headSha: 'd'.repeat(40) })).rejects.toThrow(
      '不能复用来源',
    );
    await expect(recordVerifyAggregate(t.db, { ...input, round: 2 })).rejects.toThrow('不能复用来源');
    expect(await listVerifyAggregates(t.db, taskId)).toHaveLength(2);
  });
});
