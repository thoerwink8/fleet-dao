// 新内核存储（#3773）对照 specs/3770-harness-rewrite/旧坑验收用例.md 第九节：S1–S5、O1，外加 F1（按游标读、有页上限）。
import { type NewEvent, opKey } from '@fleet-dao/harness-contract';
import { asc, eq, sql } from 'drizzle-orm';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { outbox, streamHeads } from '../src/schema.ts';
import {
  advanceStreamHeads,
  appendEvents,
  checkFencing,
  claimDueOps,
  completeOp,
  enqueueOp,
  failOp,
  LostClaimError,
  markUnknown,
  oldestDueAgeSeconds,
  onceByReceipt,
  PAGE_MAX,
  ReceiptConflictError,
  readAfter,
  readStream,
  resetStreamHeads,
  StreamConflictError,
} from '../src/store.ts';
import { createTestDb, type TestDb } from '../src/testing.ts';

let t: TestDb;
beforeAll(async () => {
  t = await createTestDb();
}, 60_000);
afterAll(() => t.close());
beforeEach(async () => {
  await t.pg.exec(
    'truncate fleet2.events, fleet2.command_receipts, fleet2.outbox, fleet2.projection_checkpoints, fleet2.stream_heads restart identity',
  );
});

const ev = (type: NewEvent['type'], n = 0): NewEvent => ({ schemaVersion: 1, type, payload: { n } });
const REF = { repo: 'acme/app', issue: 7 };

describe('S1 事件追加', () => {
  it('seq 从 1 连续；调用方以为的位置不对就拒，不覆盖', async () => {
    const got = await appendEvents(t.db, 'session:a', 0, [
      ev('session.turn.started'),
      ev('session.turn.settled'),
    ]);
    expect(got.map((e) => e.seq)).toEqual([1, 2]);
    await expect(appendEvents(t.db, 'session:a', 0, [ev('worker.spawned')])).rejects.toBeInstanceOf(
      StreamConflictError,
    );
    expect((await appendEvents(t.db, 'session:a', 2, [ev('worker.spawned')]))[0]?.seq).toBe(3);
  });

  it('两个写者同时从同一位置追加：只有一个成，seq 不重不跳', async () => {
    const results = await Promise.allSettled([
      appendEvents(t.db, 'session:b', 0, [ev('worker.spawned', 1)]),
      appendEvents(t.db, 'session:b', 0, [ev('worker.spawned', 2)]),
    ]);
    expect(results.filter((r) => r.status === 'fulfilled')).toHaveLength(1);
    expect((await readStream(t.db, 'session:b', 0)).map((e) => e.seq)).toEqual([1]);
  });
});

describe('F1 按游标读，有页上限', () => {
  it('readStream、readAfter 只读游标之后、不超过 PAGE_MAX', async () => {
    await appendEvents(t.db, 'issue:acme/app#7', 0, [ev('handback.recorded', 1), ev('handback.recorded', 2)]);
    expect((await readStream(t.db, 'issue:acme/app#7', 1)).map((e) => e.seq)).toEqual([2]);
    const first = await readAfter(t.db, 0, 1);
    expect(first).toHaveLength(1);
    expect((await readAfter(t.db, first[0]?.id ?? 0, 10_000)).length).toBeLessThanOrEqual(PAGE_MAX);
  });
});

describe('S3 投影删了重建、中途断了接着走', () => {
  it('删掉重建逐行一致；分页推进和一次推进结果相同', async () => {
    await appendEvents(t.db, 'session:a', 0, [ev('session.turn.started'), ev('session.turn.settled')]);
    await appendEvents(t.db, 'worker:w1', 0, [
      ev('worker.spawned'),
      ev('worker.settled'),
      ev('handback.recorded'),
    ]);
    expect(await advanceStreamHeads(t.db)).toBe(5);
    const before = await t.db.select().from(streamHeads).orderBy(asc(streamHeads.streamId));
    await resetStreamHeads(t.db);
    expect(await t.db.select().from(streamHeads)).toEqual([]);
    // 每页 1 条推进，等于中途断了好几次再接着走
    expect(await advanceStreamHeads(t.db, 1)).toBe(5);
    expect(await t.db.select().from(streamHeads).orderBy(asc(streamHeads.streamId))).toEqual(before);
    expect(before).toEqual([
      { streamId: 'session:a', headSeq: 2, lastType: 'session.turn.settled', events: 2 },
      { streamId: 'worker:w1', headSeq: 3, lastType: 'handback.recorded', events: 3 },
    ]);
    expect(await advanceStreamHeads(t.db)).toBe(0);
  });
});

describe('命令回执', () => {
  it('同键只跑一次、重放回原结果；同键异命令拒', async () => {
    let runs = 0;
    const run = async () => {
      runs++;
      return { n: runs };
    };
    expect(await onceByReceipt(t.db, 'k1', 'spawn', run)).toEqual({ replayed: false, result: { n: 1 } });
    expect(await onceByReceipt(t.db, 'k1', 'spawn', run)).toEqual({ replayed: true, result: { n: 1 } });
    expect(runs).toBe(1);
    await expect(onceByReceipt(t.db, 'k1', 'kill', run)).rejects.toBeInstanceOf(ReceiptConflictError);
  });

  it('run 抛错整笔回滚，下次还能做', async () => {
    await expect(
      onceByReceipt(t.db, 'k2', 'spawn', async () => {
        throw new Error('炸了');
      }),
    ).rejects.toThrow('炸了');
    expect(await onceByReceipt(t.db, 'k2', 'spawn', async () => ({ ok: 1 }))).toEqual({
      replayed: false,
      result: { ok: 1 },
    });
  });
});

describe('outbox', () => {
  const key = (d: string, fencing = 3) => opKey('github.pr.open', REF, fencing, d);

  it('S4 同一个操作键只进一次；做成后再预留回原来那条、不再领', async () => {
    const a = await enqueueOp(t.db, {
      opKey: key('pr'),
      kind: 'github.pr.open',
      ref: REF,
      fencing: 3,
      payload: {},
    });
    const b = await enqueueOp(t.db, {
      opKey: key('pr'),
      kind: 'github.pr.open',
      ref: REF,
      fencing: 3,
      payload: {},
    });
    expect(a.created).toBe(true);
    expect(b).toMatchObject({ created: false, op: { id: a.op.id } });
    const [op] = await claimDueOps(t.db, 10, 60_000);
    if (!op) throw new Error('没领到');
    await completeOp(t.db, op, { pr: 12 });
    expect(await claimDueOps(t.db, 10, 60_000)).toEqual([]);
    expect(
      (await enqueueOp(t.db, { opKey: key('pr'), kind: 'github.pr.open', ref: REF, fencing: 3, payload: {} }))
        .op.state,
    ).toBe('done');
  });

  it('两个领取者不会领到同一条；租约过期别人可以接，原领取者收尾被拒', async () => {
    await enqueueOp(t.db, { opKey: key('a'), kind: 'github.pr.open', ref: REF, fencing: 3, payload: {} });
    const [first] = await claimDueOps(t.db, 10, 60_000);
    expect(await claimDueOps(t.db, 10, 60_000)).toEqual([]);
    if (!first) throw new Error('没领到');
    await t.db
      .update(outbox)
      .set({ leaseUntil: sql`now() - interval '1 second'` })
      .where(eq(outbox.id, first.id));
    const [second] = await claimDueOps(t.db, 10, 60_000);
    expect(second?.id).toBe(first.id);
    expect(second?.attempts).toBe(2);
    await expect(completeOp(t.db, first, {})).rejects.toBeInstanceOf(LostClaimError);
    if (!second) throw new Error('没接到');
    await completeOp(t.db, second, {});
  });

  it('结果不知道记 unknown，到点再领出来（领到的人先查证）；不是直接丢', async () => {
    await enqueueOp(t.db, { opKey: key('u'), kind: 'github.pr.open', ref: REF, fencing: 3, payload: {} });
    const [op] = await claimDueOps(t.db, 10, 60_000);
    if (!op) throw new Error('没领到');
    await markUnknown(t.db, op, '30 秒没回', 0);
    const [again] = await claimDueOps(t.db, 10, 60_000);
    expect(again).toMatchObject({ id: op.id, attempts: 2 });
  });

  it('S5 一条一直失败：退避重试，到上限进 dead，不挡后面的', async () => {
    await enqueueOp(t.db, { opKey: key('bad'), kind: 'github.pr.open', ref: REF, fencing: 3, payload: {} });
    await enqueueOp(t.db, { opKey: key('good'), kind: 'github.pr.open', ref: REF, fencing: 3, payload: {} });
    for (let i = 0; i < 3; i++) {
      const ops = await claimDueOps(t.db, 10, 60_000);
      for (const op of ops) {
        if (op.opKey === key('bad')) await failOp(t.db, op, '422', 0, 3);
        else await completeOp(t.db, op, {});
      }
    }
    const rows = await t.db.select({ k: outbox.opKey, s: outbox.state }).from(outbox).orderBy(asc(outbox.id));
    expect(rows).toEqual([
      { k: key('bad'), s: 'dead' },
      { k: key('good'), s: 'done' },
    ]);
  });

  it('O1 令牌对不上（单已易手）：不做、进 dead；对得上照做；读不到令牌抛错不当对得上', async () => {
    await enqueueOp(t.db, { opKey: key('f'), kind: 'github.pr.open', ref: REF, fencing: 3, payload: {} });
    const [op] = await claimDueOps(t.db, 10, 60_000);
    if (!op) throw new Error('没领到');
    await expect(
      checkFencing(t.db, op, async () => {
        throw new Error('库读不到');
      }),
    ).rejects.toThrow('库读不到');
    expect(await checkFencing(t.db, op, async () => 3)).toBe(true);
    expect(await checkFencing(t.db, op, async () => 4)).toBe(false);
    const [row] = await t.db.select().from(outbox).where(eq(outbox.id, op.id));
    expect(row).toMatchObject({ state: 'dead' });
    expect(row?.lastError).toContain('令牌对不上');
  });

  it('积压年龄：没有到期的回 0，有到期的回正数', async () => {
    expect(await oldestDueAgeSeconds(t.db)).toBe(0);
    await enqueueOp(t.db, { opKey: key('old'), kind: 'github.pr.open', ref: REF, fencing: 3, payload: {} });
    await t.db.update(outbox).set({ nextAt: sql`now() - interval '90 seconds'` });
    expect(await oldestDueAgeSeconds(t.db)).toBeGreaterThanOrEqual(89);
  });
});
