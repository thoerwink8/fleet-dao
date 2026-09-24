// 幂等账与 PR 镜像在真 Postgres（PGlite，跑真迁移）上的行为。
import { repos, tasks } from '@fleet-dao/db';
import { createTestDb, resetTestDb, TEST_DB_TIMEOUT_MS, type TestDb } from '@fleet-dao/db/testing';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { GitHubError } from '../src/errors.ts';
import { idempotencyKey, once } from '../src/idempotency.ts';
import { type Ledger, pgLedger, pgLocker } from '../src/ledger.ts';

let t: TestDb;
let ledger: Ledger;
let repoId: string;
let now = new Date('2026-09-25T12:00:00Z');
const clock = () => now;

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
});
