// 真执行的账（#3783）：批次冻结、产物幂等、按单取最近一次、作废还没做的外部动作。
import { opKey } from '@fleet-dao/harness-contract';
import { eq, sql } from 'drizzle-orm';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import {
  activeRealBatches,
  BatchFrozenError,
  cancelPendingOps,
  claimDueOps,
  countOpsByState,
  enqueueOp,
  freezeRealBatch,
  getPublishRun,
  latestPublishRun,
  latestRealBatchFor,
  listOpsForTask,
  listRealBatchItems,
  type PublishRunInput,
  recordPublishRun,
  setPublishState,
} from '../src/index.ts';
import { outbox } from '../src/schema.ts';
import { createTestDb, type TestDb } from '../src/testing.ts';

let t: TestDb;
beforeAll(async () => {
  t = await createTestDb();
});
afterAll(() => t.close());
beforeEach(async () => {
  await t.pg.exec('truncate fleet2.real_batch_items, fleet2.publish_runs, fleet2.outbox restart identity');
});

const sha = 'a'.repeat(40);
const item = (issue: number, baseSha = sha) => ({
  repo: 'o/r',
  issue,
  baseSha,
  snapshotAt: new Date('2026-11-02T00:00:00Z'),
});
const run = (over: Partial<PublishRunInput> = {}): PublishRunInput => ({
  runId: 'd1-a1',
  batchId: 'b1',
  repo: 'o/r',
  issue: 1,
  baseSha: sha,
  fencing: 3,
  model: 'grok-4.7',
  title: '改一行',
  verdict: 'unverified',
  patch: 'diff',
  wallMs: 1,
  branch: 'fleet2/1-d1-a1',
  state: 'ready',
  ...over,
});

describe('真执行批次', () => {
  it('冻结后不改；清单按（仓、单号）翻页；没出过产物的批次才算在途', async () => {
    await freezeRealBatch(t.db, 'b1', [item(2), item(1)]);
    await expect(freezeRealBatch(t.db, 'b1', [item(3)])).rejects.toBeInstanceOf(BatchFrozenError);
    expect((await listRealBatchItems(t.db, 'b1')).map((i) => i.issue)).toEqual([1, 2]);
    expect((await listRealBatchItems(t.db, 'b1', { repo: 'o/r', issue: 1 })).map((i) => i.issue)).toEqual([
      2,
    ]);
    expect(await activeRealBatches(t.db)).toEqual(['b1']);
    await recordPublishRun(t.db, run({ issue: 1 }));
    expect(await activeRealBatches(t.db)).toEqual(['b1']);
    await recordPublishRun(t.db, run({ runId: 'd2-a1', issue: 2, branch: 'fleet2/2-d2-a1' }));
    expect(await activeRealBatches(t.db)).toEqual([]);
    expect(await latestRealBatchFor(t.db, { repo: 'o/r', issue: 2 })).toBe('b1');
    expect(await latestRealBatchFor(t.db, { repo: 'o/r', issue: 9 })).toBeNull();
  });

  it('基线不是 40 位十六进制被库拒', async () => {
    await expect(freezeRealBatch(t.db, 'bad', [item(1, 'main')])).rejects.toThrow();
  });
});

describe('产物', () => {
  beforeEach(() => freezeRealBatch(t.db, 'b1', [item(1)]));

  it('同一个 runId 再记回原行；单不在批次里或基线对不上就拒', async () => {
    expect(await recordPublishRun(t.db, run())).toMatchObject({ created: true });
    expect(await recordPublishRun(t.db, run({ patch: 'other' }))).toMatchObject({
      created: false,
      run: { patch: 'diff' },
    });
    await expect(recordPublishRun(t.db, run({ runId: 'x', issue: 9 }))).rejects.toThrow('不在真执行批次');
    await expect(recordPublishRun(t.db, run({ runId: 'y', baseSha: 'b'.repeat(40) }))).rejects.toThrow(
      '基线',
    );
  });

  it('按单取最近一次；切回时改状态', async () => {
    await recordPublishRun(t.db, run({ runId: 'd1-a1' }));
    await recordPublishRun(t.db, run({ runId: 'd1-a2', branch: 'fleet2/1-d1-a2' }));
    expect((await latestPublishRun(t.db, { repo: 'o/r', issue: 1 }))?.runId).toBe('d1-a2');
    await setPublishState(t.db, 'd1-a2', 'released', '切回');
    expect(await getPublishRun(t.db, 'd1-a2')).toMatchObject({ state: 'released', reason: '切回' });
  });

  it('状态和核验值不在名单里被库拒', async () => {
    await expect(recordPublishRun(t.db, run({ state: 'weird' as 'ready' }))).rejects.toThrow();
  });
});

describe('外部动作的按单读和作废', () => {
  const ref = { repo: 'o/r', issue: 1 };
  const op = (kind: 'git.push' | 'github.pr.open', d: string) => ({
    opKey: opKey(kind, ref, 3, d),
    kind,
    ref,
    fencing: 3,
    payload: {},
  });

  it('只作废还没开始的（pending）；领着的和结果不知道的不动', async () => {
    await enqueueOp(t.db, op('git.push', 'a'));
    await enqueueOp(t.db, op('github.pr.open', 'a'));
    await enqueueOp(t.db, { ...op('git.push', 'z'), ref: { repo: 'o/r', issue: 2 } });
    const [claimed] = await claimDueOps(t.db, 1, 60_000);
    expect(claimed?.kind).toBe('git.push');
    expect(await cancelPendingOps(t.db, ref, '切回')).toBe(1);
    expect((await listOpsForTask(t.db, ref)).map((o) => `${o.kind}:${o.state}`)).toEqual([
      'git.push:claimed',
      'github.pr.open:dead',
    ]);
    // 别的单不受影响
    expect((await listOpsForTask(t.db, { repo: 'o/r', issue: 2 })).map((o) => o.state)).toEqual(['pending']);
  });
});

describe('outbox 各状态计数', () => {
  const ref = { repo: 'o/r', issue: 1 };
  const zero = { pending: 0, claimed: 0, done: 0, unknown: 0, dead: 0 };

  it('空表五个数都是 0', async () => {
    expect(await countOpsByState(t.db)).toEqual(zero);
  });

  it('五种状态各若干条，五个数和手算一致', async () => {
    // 手算：pending 2、claimed 3、done 1、unknown 4、dead 2
    const want = { pending: 2, claimed: 3, done: 1, unknown: 4, dead: 2 };
    for (const [state, n] of Object.entries(want)) {
      for (let i = 0; i < n; i++) {
        const d = `${state}-${i}`;
        await enqueueOp(t.db, {
          opKey: opKey('git.push', ref, 3, d),
          kind: 'git.push',
          ref,
          fencing: 3,
          payload: {},
        });
        if (state === 'pending') continue;
        await t.db
          .update(outbox)
          .set(
            state === 'claimed'
              ? { state, leaseUntil: sql`now() + interval '1 minute'`, claimToken: d }
              : { state, leaseUntil: null, claimToken: null },
          )
          .where(eq(outbox.opKey, opKey('git.push', ref, 3, d)));
      }
    }
    expect(await countOpsByState(t.db)).toEqual(want);
  });
});
