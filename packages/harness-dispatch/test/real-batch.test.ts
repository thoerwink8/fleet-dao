// 真执行冻结的试算（#3865）：假读取器判开着的单、已关、PR、读不到；--dry-run 不写库。
import { createTestDb, type TestDb } from '@fleet-dao/harness-store/testing';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import {
  planRealBatch,
  type RealBatchReader,
  type RealBatchRejection,
  runRealFreeze,
} from '../src/real-batch.ts';

const SHA_A = 'a'.repeat(40);
const SHA_B = 'b'.repeat(40);

let t: TestDb;
beforeAll(async () => {
  t = await createTestDb();
}, 60_000);
afterAll(() => t.close());
beforeEach(async () => {
  await t.pg.exec('truncate fleet2.real_batch_items restart identity');
});

async function itemCount(): Promise<number> {
  const rows = await t.pg.query('select count(*)::int as n from fleet2.real_batch_items');
  return (rows.rows[0] as { n: number }).n;
}

type Fact = { open: boolean; isPr: boolean };

function reader(opts: {
  facts: Record<string, Fact | Error>;
  heads?: Record<string, string | Error>;
}): RealBatchReader & { factCalls: string[]; headsAsked: string[] } {
  const factCalls: string[] = [];
  const headsAsked: string[] = [];
  return {
    factCalls,
    headsAsked,
    async issueFacts(repo, issue) {
      const key = `${repo}#${issue}`;
      factCalls.push(key);
      const fact = opts.facts[key];
      if (fact === undefined) throw new Error(`没这张单 ${key}`);
      if (fact instanceof Error) throw fact;
      return fact;
    },
    async headSha(repo, branch) {
      headsAsked.push(`${repo} ${branch}`);
      const head = opts.heads?.[repo];
      if (head instanceof Error) throw head;
      if (!head) throw new Error(`读不到 ${repo} ${branch}`);
      return head;
    },
  };
}

const open = { open: true, isPr: false };

describe('planRealBatch', () => {
  it('开着的单进清单，基线是主线现在的提交', async () => {
    const gh = reader({
      facts: { 'o/a#1': open, 'o/b#2': open },
      heads: { 'o/a': SHA_A, 'o/b': SHA_B },
    });
    const plan = await planRealBatch(
      [
        { repo: 'o/a', issue: 1 },
        { repo: 'o/b', issue: 2 },
      ],
      gh,
    );
    expect(plan).toEqual({
      ok: true,
      items: [
        { repo: 'o/a', issue: 1, baseSha: SHA_A, snapshotAt: expect.any(Date) },
        { repo: 'o/b', issue: 2, baseSha: SHA_B, snapshotAt: expect.any(Date) },
      ],
    });
    if (!plan.ok) return;
    expect(plan.items[0]?.snapshotAt).toBe(plan.items[1]?.snapshotAt);
    expect(gh.headsAsked).toEqual(['o/a main', 'o/b main']);
  });

  it('已关、是 PR、读不到各给原因，整批不冻结（开着的那张也不进清单）', async () => {
    const gh = reader({
      facts: {
        'o/r#1': { open: false, isPr: false },
        'o/r#2': { open: false, isPr: true },
        'o/r#3': new Error('HTTP 404'),
        'o/r#4': open,
      },
      heads: { 'o/r': SHA_A },
    });
    const refs = [1, 2, 3, 4].map((issue) => ({ repo: 'o/r', issue }));
    const plan = await planRealBatch(refs, gh);
    const rejected: RealBatchRejection[] = [
      { repo: 'o/r', issue: 1, kind: 'closed', reason: 'o/r#1 已经关了' },
      { repo: 'o/r', issue: 2, kind: 'pr', reason: 'o/r#2 是 PR，不是单' },
      { repo: 'o/r', issue: 3, kind: 'unreadable', reason: 'o/r#3 读不到：HTTP 404' },
    ];
    expect(plan).toEqual({ ok: false, rejected });
    expect(gh.factCalls).toEqual(['o/r#1', 'o/r#2', 'o/r#3', 'o/r#4']);
    expect(gh.headsAsked).toEqual([]);

    const cmd = await runRealFreeze(t.db, ['b1', 'o/r#1', 'o/r#2', 'o/r#3', 'o/r#4'], gh);
    expect(cmd).toEqual({ exitCode: 1, body: { dryRun: false, rejected } });
    expect(await itemCount()).toBe(0);
  });

  it('基线读不到算读不到，整批不写', async () => {
    const gh = reader({
      facts: { 'o/r#8': open, 'o/r#9': open },
      heads: { 'o/r': new Error('HTTP 503') },
    });
    const refs = [
      { repo: 'o/r', issue: 8 },
      { repo: 'o/r', issue: 9 },
    ];
    expect(await planRealBatch(refs, gh)).toEqual({
      ok: false,
      rejected: [
        { repo: 'o/r', issue: 8, kind: 'unreadable', reason: 'o/r#8 读不到：HTTP 503' },
        { repo: 'o/r', issue: 9, kind: 'unreadable', reason: 'o/r#9 读不到：HTTP 503' },
      ],
    });
    const cmd = await runRealFreeze(t.db, ['b1', 'o/r#8', 'o/r#9'], gh);
    expect(cmd.exitCode).toBe(1);
    expect(await itemCount()).toBe(0);
  });
});

describe('freeze --dry-run', () => {
  const facts = { 'o/r#7': open, 'p/q#3': open };
  const heads = { 'o/r': SHA_A, 'p/q': SHA_B };
  const items = [
    { repo: 'o/r', issue: 7, baseSha: SHA_A },
    { repo: 'p/q', issue: 3, baseSha: SHA_B },
  ];

  it('只打印清单，不调用写库（real_batch_items 仍是空表）', async () => {
    const gh = reader({ facts, heads });
    const cmd = await runRealFreeze(t.db, ['b9', '--dry-run', 'o/r#7', 'p/q#3'], gh);
    expect(cmd).toEqual({ exitCode: 0, body: { dryRun: true, batchId: 'b9', items } });
    expect(gh.headsAsked).toEqual(['o/r main', 'p/q main']);
    expect(await itemCount()).toBe(0);
  });

  it('不加 --dry-run：同样的单写入 real_batch_items', async () => {
    const cmd = await runRealFreeze(t.db, ['b9', 'o/r#7', 'p/q#3'], reader({ facts, heads }));
    expect(cmd).toEqual({ exitCode: 0, body: { frozen: 'b9', items } });
    const rows = await t.pg.query(
      'select repo, issue, base_sha from fleet2.real_batch_items order by repo, issue',
    );
    expect(rows.rows).toEqual([
      { repo: 'o/r', issue: 7, base_sha: SHA_A },
      { repo: 'p/q', issue: 3, base_sha: SHA_B },
    ]);
  });
});
