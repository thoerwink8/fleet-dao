import { claimIdempotencyKey, completeIdempotencyKey, type Db } from '@fleet-dao/db';
import {
  allSettledOrThrow,
  createConcurrentTestDb,
  realTestPgUrl,
  resetTestDb,
  TEST_DB_TIMEOUT_MS,
} from '@fleet-dao/db/testing';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { pgIdempotencyStore, pgLocker } from '../src/github-pg.ts';

/** 仅拦真实SQL完成后的调度，不替换任何数据库结果。 */
function observeQueries(
  db: Db,
  hooks: { inserted?: (rows: unknown[]) => Promise<void>; selected?: (rows: unknown[]) => Promise<void> },
): Db {
  const builder = (value: object, terminal: string, after?: (rows: unknown[]) => Promise<void>): object =>
    new Proxy(value, {
      get(target, key) {
        const member = Reflect.get(target, key, target);
        if (typeof member !== 'function') return member;
        if (key === terminal)
          return async (...args: unknown[]) => {
            const rows = await Reflect.apply(member, target, args);
            if (!Array.isArray(rows)) throw new Error('真实查询结果不是行数组');
            await after?.(rows);
            return rows;
          };
        return (...args: unknown[]) => builder(Reflect.apply(member, target, args), terminal, after);
      },
    });
  return new Proxy(db, {
    get(target, key) {
      const member = Reflect.get(target, key, target);
      if (key === 'insert')
        return (...args: unknown[]) =>
          builder(Reflect.apply(member, target, args), 'returning', hooks.inserted);
      if (key === 'select')
        return (...args: unknown[]) => builder(Reflect.apply(member, target, args), 'where', hooks.selected);
      return typeof member === 'function' ? member.bind(target) : member;
    },
  });
}

function deferred() {
  let resolve!: () => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<void>((yes, no) => {
    resolve = yes;
    reject = no;
  });
  // 两个闸都可能先于等待方失败，最终仍由主调用收尽。
  void promise.catch(() => {});
  return { promise, resolve, reject };
}

const url = realTestPgUrl();
it.runIf(Boolean(process.env.CI) && !url)('CI真实幂等竞争缺测试URL必须失败', () => {
  throw new Error('真实幂等竞争测试必须提供FLEET_TEST_PG_URL');
});
describe.runIf(Boolean(url))('幂等键冲突后的真实PG可控交错', () => {
  let t: Awaited<ReturnType<typeof createConcurrentTestDb>>;
  const input = { key: 'race:claim', action: 'original.action', target: 'original-target' };
  const oldAt = new Date('2026-10-20T00:00:00Z');
  const nextAt = new Date('2026-10-20T00:00:01Z');
  beforeAll(async () => {
    t = await createConcurrentTestDb();
    const identities = await allSettledOrThrow(
      t.peers.map((p) =>
        p.client.query<{ db: string; pid: number }>(
          'select current_database() as db, pg_backend_pid() as pid',
        ),
      ),
    );
    const [a, b] = identities.map((r) => r.rows[0]);
    expect(a?.db).toMatch(/^fleet_test_[a-f0-9]{32}$/);
    expect(a?.db).toBe(b?.db);
    expect(a?.pid).not.toBe(b?.pid);
  }, TEST_DB_TIMEOUT_MS);
  beforeEach(async () => {
    await resetTestDb(t);
  });
  afterAll(async () => {
    await t?.close();
  });

  async function afterConflict(action: () => Promise<void>) {
    const reached = deferred(),
      resume = deferred();
    const timer = setTimeout(() => {
      const e = new Error('真实冲突交错闸超时');
      reached.reject(e);
      resume.reject(e);
    }, 5000);
    let paused = false;
    const observed = observeQueries(t.peers[1].db, {
      inserted: async (rows) => {
        if (!paused && rows.length === 0) {
          paused = true;
          reached.resolve();
          await resume.promise;
        }
      },
    });
    const pending = claimIdempotencyKey(
      observed,
      { ...input, action: 'contender', target: 'contender-target' },
      nextAt,
    );
    void pending.catch(reached.reject);
    let failure: unknown;
    try {
      await reached.promise;
      await action();
    } catch (error) {
      failure = error;
    } finally {
      resume.resolve();
      clearTimeout(timer);
    }
    const [result] = await allSettledOrThrow([pending]);
    if (failure) throw failure;
    expect(paused).toBe(true);
    return result;
  }

  it('INSERT真实冲突后持有者删除提交，等待者重新安全占键', async () => {
    const owner = pgIdempotencyStore(t.peers[0].db);
    await owner.claim(input, oldAt);
    const result = await afterConflict(async () => {
      expect(await owner.release(input.key, oldAt)).toBe(true);
      expect(await owner.peek(input.key)).toBeNull();
    });
    expect(result).toEqual({ status: 'claimed' });
    expect(await owner.peek(input.key)).toMatchObject({
      action: 'contender',
      target: 'contender-target',
      claimedAt: nextAt,
    });
    expect(await owner.release(input.key, oldAt)).toBe(false);
    expect(await owner.peek(input.key)).not.toBeNull();
  });

  it('冲突后仍持有，返回真实代次且不覆盖action或target', async () => {
    const owner = pgIdempotencyStore(t.peers[0].db);
    await owner.claim(input, oldAt);
    expect(await afterConflict(async () => {})).toEqual({ status: 'in-flight', claimedAt: oldAt });
    expect(await owner.peek(input.key)).toMatchObject({
      action: input.action,
      target: input.target,
      claimedAt: oldAt,
    });
  });

  it('冲突后已完成，返回原结果且不重写已完成记录', async () => {
    const owner = pgIdempotencyStore(t.peers[0].db);
    await owner.claim(input, oldAt);
    const result = { url: 'https://example.invalid/receipt', count: 1 };
    expect(
      await afterConflict(async () => {
        await completeIdempotencyKey(t.peers[0].db, input.key, result, nextAt);
      }),
    ).toEqual({ status: 'done', result, completedAt: nextAt });
    expect(await owner.release(input.key, oldAt)).toBe(false);
    expect(await owner.peek(input.key)).toMatchObject({ action: input.action, target: input.target, result });
  });

  it('冲突后第三者抢先占新代次，不能当作等待者自己成功', async () => {
    const owner = pgIdempotencyStore(t.peers[0].db),
      third = pgIdempotencyStore(t.blocker.db);
    const thirdAt = new Date(nextAt.getTime() + 1000);
    await owner.claim(input, oldAt);
    expect(
      await afterConflict(async () => {
        expect(await owner.release(input.key, oldAt)).toBe(true);
        expect(await third.claim({ ...input, action: 'third' }, thirdAt)).toEqual({ status: 'claimed' });
      }),
    ).toEqual({ status: 'in-flight', claimedAt: thirdAt });
    expect(await owner.release(input.key, oldAt)).toBe(false);
    expect(await third.peek(input.key)).toMatchObject({ action: 'third', claimedAt: thirdAt });
  });

  it('持续真实冲突与释放有界终止，保留第三者记录并报告可重试竞争', async () => {
    const owner = pgIdempotencyStore(t.peers[0].db);
    let at = oldAt,
      inserts = 0;
    await owner.claim(input, at);
    const observed = observeQueries(t.peers[1].db, {
      inserted: async (rows) => {
        inserts++;
        expect(rows).toHaveLength(0);
        expect(await owner.release(input.key, at)).toBe(true);
      },
      selected: async (rows) => {
        expect(rows).toHaveLength(0);
        at = new Date(at.getTime() + 1000);
        expect(await owner.claim({ ...input, action: 'third' }, at)).toEqual({ status: 'claimed' });
      },
    });
    await expect(claimIdempotencyKey(observed, input, nextAt)).rejects.toMatchObject({
      code: 'IDEMPOTENCY_CLAIM_CONTENTION',
      retryable: true,
    });
    expect(inserts).toBeGreaterThan(1);
    expect(inserts).toBeLessThanOrEqual(4);
    expect(await owner.peek(input.key)).toMatchObject({ action: 'third', claimedAt: at });
  });

  it('真实数据库错误直接抛出，不作为空读重试', async () => {
    let inserts = 0;
    const observed = observeQueries(t.peers[1].db, {
      inserted: async () => {
        inserts++;
      },
    });
    await expect(
      claimIdempotencyKey(observed, { ...input, action: null as unknown as string }, nextAt),
    ).rejects.toThrow();
    expect(inserts).toBe(0);
  });

  it('成功冲突后的真实SELECT错误也原样抛出，不占键重试', async () => {
    const owner = pgIdempotencyStore(t.peers[0].db);
    await owner.claim(input, oldAt);
    let inserts = 0,
      renamed = false;
    const observed = observeQueries(t.peers[1].db, {
      inserted: async (rows) => {
        inserts++;
        expect(rows).toHaveLength(0);
        await t.peers[0].client.exec('alter table idempotency_keys rename to idempotency_keys_read_failure');
        renamed = true;
      },
    });
    try {
      await expect(claimIdempotencyKey(observed, input, nextAt)).rejects.toMatchObject({
        cause: { code: '42P01' },
      });
    } finally {
      if (renamed)
        await t.peers[0].client.exec('alter table idempotency_keys_read_failure rename to idempotency_keys');
    }
    expect(inserts).toBe(1);
    expect(await owner.peek(input.key)).toMatchObject({ action: input.action, claimedAt: oldAt });
  });

  it('单连接pgLocker临界区仍能查询，同键两个临界区不重叠', async () => {
    const entered = deferred(),
      release = deferred(),
      waiting = deferred(),
      retry = deferred();
    const timer = setTimeout(() => {
      const e = new Error('真实锁交错闸超时');
      for (const gate of [entered, release, waiting, retry]) gate.reject(e);
    }, 5000);
    const first = pgLocker(t.peers[0].db),
      second = pgLocker(t.peers[1].db, {
        sleep: async () => {
          waiting.resolve();
          await retry.promise;
        },
      });
    let active = 0,
      peak = 0;
    const order: string[] = [];
    const a = first.withLock('real-race', async () => {
      active++;
      peak = Math.max(active, peak);
      order.push('a-enter');
      entered.resolve();
      try {
        expect((await t.peers[0].client.query('select 1 as n')).rows[0]).toEqual({ n: 1 });
        await release.promise;
      } finally {
        active--;
        order.push('a-exit');
      }
    });
    void a.catch(entered.reject);
    let b: Promise<unknown> | undefined, failure: unknown;
    try {
      await entered.promise;
      b = second.withLock('real-race', async () => {
        active++;
        peak = Math.max(active, peak);
        order.push('b-enter');
        try {
          expect((await t.peers[1].client.query('select 1 as n')).rows[0]).toEqual({ n: 1 });
        } finally {
          active--;
          order.push('b-exit');
        }
      });
      void b.catch(waiting.reject);
      await waiting.promise;
      release.resolve();
      await a;
      retry.resolve();
    } catch (error) {
      failure = error;
    } finally {
      release.resolve();
      retry.resolve();
      clearTimeout(timer);
    }
    await allSettledOrThrow([a, ...(b ? [b] : [])]);
    if (failure) throw failure;
    expect(peak).toBe(1);
    expect(order).toEqual(['a-enter', 'a-exit', 'b-enter', 'b-exit']);
  });
});
