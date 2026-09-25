// 幂等账与 PR 镜像在真 Postgres（PGlite，跑真迁移）上的行为。
import { repos, tasks } from '@fleet-dao/db';
import { createTestDb, resetTestDb, TEST_DB_TIMEOUT_MS, type TestDb } from '@fleet-dao/db/testing';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { GitHubError } from '../src/errors.ts';
import { type IdempotencyStore, idempotencyKey, once } from '../src/idempotency.ts';
import { type Ledger, pgLedger, pgLocker } from '../src/ledger.ts';

let t: TestDb;
let ledger: Ledger;
let repoId: string;
let now = new Date('2026-09-25T12:00:00Z');
const clock = () => now;

/** 等一个条件成立（真时间，最多 2 秒）；等不到就让测试失败，不假装成立。 */
async function waitFor(cond: () => Promise<boolean>): Promise<void> {
  for (let i = 0; i < 200; i += 1) {
    if (await cond()) return;
    await new Promise((r) => setTimeout(r, 10));
  }
  throw new Error('等了 2 秒条件还不成立');
}

beforeAll(async () => {
  t = await createTestDb();
}, TEST_DB_TIMEOUT_MS);
afterAll(() => t.close());
beforeEach(async () => {
  await resetTestDb(t);
  now = new Date('2026-09-25T12:00:00Z');
  ledger = pgLedger(t.db);
  const [row] = await t.db
    .insert(repos)
    .values({ owner: 'Acme', name: 'Widgets', testCommand: 'pnpm check' })
    .returning();
  repoId = row?.id ?? '';
});

describe('防重复写（idempotency_keys）', () => {
  const spec = (over: Partial<Parameters<typeof once<{ n: number }>>[1]> = {}) => ({
    key: 'gh:test:acme/widgets#1',
    action: 'github.test',
    target: 'acme/widgets#1',
    now: clock,
    lookup: async () => null,
    write: async () => ({ n: 1 }),
    ...over,
  });

  it('写一次、记回执；再来直接拿回执，不再写', async () => {
    let writes = 0;
    const s = spec({ write: async () => ({ n: ++writes }) });
    expect(await once(ledger.idempotency, s)).toEqual({ value: { n: 1 }, replay: false });
    expect(await once(ledger.idempotency, s)).toEqual({ value: { n: 1 }, replay: true });
    expect(writes).toBe(1);
  });

  it('B1：上次写到一半（回执丢了）：先回查，找到就补账，不再写', async () => {
    const s = spec({
      write: async () => {
        throw new GitHubError('AMBIGUOUS_WRITE', 'lost', { retryable: true, maybeLanded: true });
      },
    });
    await expect(once(ledger.idempotency, s)).rejects.toMatchObject({ code: 'AMBIGUOUS_WRITE' });
    let writes = 0;
    const retry = spec({ lookup: async () => ({ n: 7 }), write: async () => ({ n: ++writes }) });
    expect(await once(ledger.idempotency, retry)).toEqual({ value: { n: 7 }, replay: true });
    expect(writes).toBe(0);
    expect(await once(ledger.idempotency, retry)).toEqual({ value: { n: 7 }, replay: true });
  });

  it('写到一半、远端也找不到：刚占的别抢（报可重试），占用过期了才重写', async () => {
    await expect(
      once(
        ledger.idempotency,
        spec({
          write: async () => Promise.reject(new GitHubError('AMBIGUOUS_WRITE', 'x', { maybeLanded: true })),
        }),
      ),
    ).rejects.toThrow();
    await expect(once(ledger.idempotency, spec())).rejects.toMatchObject({
      code: 'IN_FLIGHT',
      retryable: true,
    });
    now = new Date(now.getTime() + 3 * 60_000);
    expect(await once(ledger.idempotency, spec({ write: async () => ({ n: 2 }) }))).toEqual({
      value: { n: 2 },
      replay: false,
    });
  });

  it('写得慢（排队、撞限流在等）时一直续占用：重试不会当它死了再写一份', async () => {
    let release: () => void = () => {};
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    let writes = 0;
    const slow = once(
      ledger.idempotency,
      spec({
        renewEveryMs: 5,
        write: async () => {
          writes += 1;
          await gate;
          return { n: 1 };
        },
      }),
    );
    // 钟往前拨 5 分钟（远过 2 分钟的过期线），等它续上
    await waitFor(async () => (await ledger.idempotency.peek('gh:test:acme/widgets#1')) !== null);
    now = new Date(now.getTime() + 5 * 60_000);
    await waitFor(
      async () =>
        (await ledger.idempotency.peek('gh:test:acme/widgets#1'))?.claimedAt.getTime() === now.getTime(),
    );
    await expect(
      once(
        ledger.idempotency,
        spec({
          write: async () => {
            writes += 1;
            return { n: 2 };
          },
        }),
      ),
    ).rejects.toMatchObject({ code: 'IN_FLIGHT' });
    release();
    expect(await slow).toEqual({ value: { n: 1 }, replay: false });
    expect(writes).toBe(1);
  });

  /** 同一本账，只是这个工人的续约会失败（它那条库连接断了）。 */
  function flakyRenewals(store: IdempotencyStore) {
    const state = { down: false };
    const flaky: IdempotencyStore = {
      claim: (input, at) => store.claim(input, at),
      complete: (key, result, at) => store.complete(key, result, at),
      release: (...args) => store.release(...args),
      peek: (key) => store.peek(key),
      takeOver: (key, seen, at) =>
        state.down ? Promise.reject(new Error('库连不上')) : store.takeOver(key, seen, at),
    };
    return { flaky, state };
  }
  const KEY = 'gh:test:acme/widgets#1';

  it('续约续不上、被别的重试当成死了接过去：写之前发现占用不在手里，放弃这次写', async () => {
    const { flaky, state } = flakyRenewals(ledger.idempotency);
    let release: () => void = () => {};
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    let writes = 0;
    // 第一个：回查卡住（翻很多页、撞了限流在等）
    const first = once(
      flaky,
      spec({
        renewEveryMs: 5,
        lookup: async () => {
          await gate;
          return null;
        },
        write: async () => ({ n: ++writes }),
      }),
    );
    await waitFor(async () => (await ledger.idempotency.peek(KEY)) !== null);
    state.down = true;
    now = new Date(now.getTime() + 3 * 60_000);
    // 第二个：看它 3 分钟没续，当它死了，接过去写
    expect(await once(ledger.idempotency, spec({ write: async () => ({ n: ++writes }) }))).toEqual({
      value: { n: 1 },
      replay: false,
    });
    // 第一个的库连接恢复、回查也回来了：不许再写一份
    state.down = false;
    release();
    await expect(first).rejects.toMatchObject({ code: 'CLAIM_LOST', retryable: true });
    expect(writes).toBe(1);
  });

  it('写失败时只放自己那一份占用：已经被别的重试接过去的，不删', async () => {
    const { flaky, state } = flakyRenewals(ledger.idempotency);
    let failFirst: (err: Error) => void = () => {};
    const firstWrite = new Promise<{ n: number }>((_, reject) => {
      failFirst = reject;
    });
    let started = false;
    const first = once(
      flaky,
      spec({
        renewEveryMs: 5,
        write: () => {
          started = true;
          return firstWrite;
        },
      }),
    );
    await waitFor(async () => started);
    state.down = true;
    now = new Date(now.getTime() + 3 * 60_000);
    let finishSecond: () => void = () => {};
    const secondGate = new Promise<void>((resolve) => {
      finishSecond = resolve;
    });
    const second = once(
      ledger.idempotency,
      spec({
        write: async () => {
          await secondGate;
          return { n: 2 };
        },
      }),
    );
    await waitFor(async () => (await ledger.idempotency.peek(KEY))?.claimedAt.getTime() === now.getTime());
    state.down = false;
    failFirst(new GitHubError('VALIDATION', '422：GitHub 明确拒了'));
    await expect(first).rejects.toMatchObject({ code: 'VALIDATION' });
    // 第二个的占用还在：没被第一个「放键」删掉（删了的话第三个重试会再写一份）
    expect((await ledger.idempotency.peek(KEY))?.claimedAt.getTime()).toBe(now.getTime());
    finishSecond();
    expect(await second).toEqual({ value: { n: 2 }, replay: false });
  });

  it('回查失败了（还没写）：放键，重试马上就能占，不用干等 2 分钟', async () => {
    await expect(
      once(
        ledger.idempotency,
        spec({
          lookup: async () => {
            throw new GitHubError('RATE_LIMITED', '限流中', { retryable: true });
          },
        }),
      ),
    ).rejects.toMatchObject({ code: 'RATE_LIMITED' });
    expect(await ledger.idempotency.peek(KEY)).toBeNull();
    expect(await once(ledger.idempotency, spec({ write: async () => ({ n: 9 }) }))).toEqual({
      value: { n: 9 },
      replay: false,
    });
  });

  it('GitHub 明确拒了（没写成）：放键，下次能重新写', async () => {
    await expect(
      once(
        ledger.idempotency,
        spec({ write: async () => Promise.reject(new GitHubError('VALIDATION', '422')) }),
      ),
    ).rejects.toMatchObject({ code: 'VALIDATION' });
    expect(await once(ledger.idempotency, spec({ write: async () => ({ n: 3 }) }))).toEqual({
      value: { n: 3 },
      replay: false,
    });
  });

  it('B4：键含动作、目标、内容：给 issue 和给 PR 的同一组改动是两个键；同内容重试是同一个键', () => {
    const labels = { add: ['x'] };
    expect(idempotencyKey('edit_labels', 'acme/widgets#12', labels)).not.toBe(
      idempotencyKey('edit_labels', 'acme/widgets#31', labels),
    );
    expect(idempotencyKey('comment', 'acme/widgets#12', { a: 1, b: 2 })).toBe(
      idempotencyKey('comment', 'acme/widgets#12', { b: 2, a: 1 }),
    );
    expect(idempotencyKey('comment', 'acme/widgets#12', 'round 1')).not.toBe(
      idempotencyKey('comment', 'acme/widgets#12', 'round 2'),
    );
  });
});

describe('PR 镜像（pull_requests）', () => {
  const at = (s: string) => new Date(`2026-09-25T${s}Z`);

  it('按 owner/name 找仓不分大小写；不归本系统管的仓返回 null', async () => {
    expect(await ledger.repoId({ owner: 'acme', name: 'widgets' })).toBe(repoId);
    expect(await ledger.repoId({ owner: 'acme', name: 'other' })).toBeNull();
  });

  it('事件乱序：旧的 updated_at 不盖新的；换了头 CI 汇总重置成 pending', async () => {
    const base = { repoId, number: 5, headRef: 'task/5' };
    expect(
      await ledger.upsertPullRequest({
        ...base,
        state: 'open',
        headSha: 'a'.repeat(40),
        updatedAt: at('12:00:00'),
      }),
    ).toBe('written');
    await ledger.setChecks(repoId, 5, 'a'.repeat(40), 'success');
    expect(
      await ledger.upsertPullRequest({
        ...base,
        state: 'open',
        headSha: 'a'.repeat(40),
        updatedAt: at('12:01:00'),
      }),
    ).toBe('written');
    expect((await ledger.getPullRequest(repoId, 5))?.checks).toBe('success');
    expect(
      await ledger.upsertPullRequest({
        ...base,
        state: 'merged',
        headSha: 'b'.repeat(40),
        updatedAt: at('12:05:00'),
      }),
    ).toBe('written');
    expect(await ledger.getPullRequest(repoId, 5)).toMatchObject({
      state: 'merged',
      headSha: 'b'.repeat(40),
      checks: 'pending',
    });
    expect(
      await ledger.upsertPullRequest({
        ...base,
        state: 'open',
        headSha: 'a'.repeat(40),
        updatedAt: at('12:02:00'),
      }),
    ).toBe('stale');
    expect((await ledger.getPullRequest(repoId, 5))?.state).toBe('merged');
  });

  it('CI 汇总只写到 head 还是那个 sha 的行上', async () => {
    await ledger.upsertPullRequest({
      repoId,
      number: 6,
      state: 'open',
      headRef: 'x',
      headSha: 'b'.repeat(40),
      updatedAt: at('12:00:00'),
    });
    expect(await ledger.setChecks(repoId, 6, 'a'.repeat(40), 'failure')).toBe(false);
    expect(await ledger.setChecks(repoId, 6, 'b'.repeat(40), 'failure')).toBe(true);
    expect((await ledger.pullRequestsByHead(repoId, 'b'.repeat(40))).map((p) => p.number)).toEqual([6]);
  });

  it('按 issue 号找需求', async () => {
    await t.db
      .insert(tasks)
      .values({ repoId, issueNumber: 12, title: 't', rawRequest: 'r', requestedBy: 'u', priority: 1 });
    expect(await ledger.taskFor(repoId, 12)).toMatchObject({ state: 'queued' });
    expect(await ledger.taskFor(repoId, 13)).toBeNull();
  });
});

describe('跨工人的锁', () => {
  it('同一个键串行跑', async () => {
    const locker = pgLocker(t.db);
    const order: string[] = [];
    await Promise.all(
      ['a', 'b'].map((name) =>
        locker.withLock('issue:acme/widgets#1', async () => {
          order.push(`${name}-in`);
          await new Promise((r) => setTimeout(r, 20));
          order.push(`${name}-out`);
        }),
      ),
    );
    expect(order).toEqual(['a-in', 'a-out', 'b-in', 'b-out']);
  });

  it('两个工人（两份 pgLocker）抢同一个键：一个放了另一个才进', async () => {
    const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, Math.min(ms, 5)));
    const order: string[] = [];
    await Promise.all(
      [pgLocker(t.db, { sleep }), pgLocker(t.db, { sleep })].map((locker, i) =>
        locker.withLock('merge:acme/widgets', async () => {
          order.push(`${i}-in`);
          await new Promise((r) => setTimeout(r, 30));
          order.push(`${i}-out`);
        }),
      ),
    );
    // 谁先进不要紧，要紧的是一个出来了另一个才进
    expect([
      ['0-in', '0-out', '1-in', '1-out'],
      ['1-in', '1-out', '0-in', '0-out'],
    ]).toContainEqual(order);
  });

  it('持锁的 fn 里还要查库：锁不占着连接，只有一条连接的库也不会自己等自己', async () => {
    const locker = pgLocker(t.db);
    const status = await locker.withLock('issue:acme/widgets#2', async () => {
      const claim = await ledger.idempotency.claim(
        { key: 'gh:test:inside-lock', action: 'github.test' },
        now,
      );
      return claim.status;
    });
    expect(status).toBe('claimed');
  });

  it('持锁的工人死了（2 分钟没续）：别的工人等它过期再接过去，不提前闯进去；用完放掉', async () => {
    let at = new Date('2026-09-25T12:00:00Z');
    const waited: number[] = [];
    // 死掉的持锁人：占了锁、从此不续
    await ledger.idempotency.claim({ key: 'gh:lock:merge:acme/widgets', action: 'github.lock' }, at);
    const locker = pgLocker(t.db, {
      now: () => at,
      sleep: async (ms) => {
        waited.push(ms);
        at = new Date(at.getTime() + ms);
        await new Promise((r) => setTimeout(r, 1));
      },
    });
    let ranAt: Date | null = null;
    await locker.withLock('merge:acme/widgets', async () => {
      ranAt = at;
    });
    expect(ranAt).not.toBeNull();
    expect(waited.reduce((a, b) => a + b, 0)).toBeGreaterThanOrEqual(120_000);
    expect(await ledger.idempotency.peek('gh:lock:merge:acme/widgets')).toBeNull();
  });

  it('锁那一行被记成了「已完成」（账写错了）：报出来，不干等', async () => {
    await ledger.idempotency.claim({ key: 'gh:lock:merge:acme/broken', action: 'github.lock' }, now);
    await ledger.idempotency.complete('gh:lock:merge:acme/broken', null, now);
    let ran = false;
    await expect(
      pgLocker(t.db).withLock('merge:acme/broken', async () => {
        ran = true;
      }),
    ).rejects.toMatchObject({ code: 'LOCK_CORRUPT', retryable: false });
    expect(ran).toBe(false);
  });
});
