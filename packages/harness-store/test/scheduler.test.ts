// 自建调度器（#3774）的故障矩阵里能在单库进程内造出来的那些：
// 做的进程被杀（租约过期别人领）、被 SIGSTOP 后回来（收尾被拒）、两个内核同时领、停机后积压一起到期（限速追赶）、
// 毒活（领了总做不完）、取消一路传下去、截止时刻继承和过期、时钟（只认数据库 now()）、心跳三种结果、健康数字。
// 库重启、断线、只读、磁盘满这几类要真库，放 CI 的 pg 台和法国真机（见 #3774 正文）。
import { eq, sql } from 'drizzle-orm';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import {
  cancelJob,
  claimJobs,
  completeJob,
  heartbeat,
  NoQueueLimitError,
  queueHealth,
  retryJob,
  schedule,
  setQueueLimit,
} from '../src/scheduler.ts';
import { jobs } from '../src/schema.ts';
import { LostClaimError } from '../src/store.ts';
import { createTestDb, type TestDb } from '../src/testing.ts';

let t: TestDb;
beforeAll(async () => {
  t = await createTestDb();
}, 60_000);
afterAll(() => t.close());
beforeEach(async () => {
  await t.pg.exec('truncate fleet2.jobs, fleet2.queue_limits restart identity');
  await setQueueLimit(t.db, 'q', 10, 100);
});

const LEASE = 60_000;
const expireLeases = () =>
  t.db.update(jobs).set({ leaseUntil: sql`now() - interval '1 second'` }).where(eq(jobs.state, 'claimed'));
const stateOf = async (key: string) => (await t.db.select().from(jobs).where(eq(jobs.key, key)))[0];

describe('排活', () => {
  it('同一个 key 只进一次；没设限速的队列不让领', async () => {
    expect((await schedule(t.db, { queue: 'q', key: 'a', payload: {} })).kind).toBe('created');
    expect((await schedule(t.db, { queue: 'q', key: 'a', payload: { other: 1 } })).kind).toBe('existing');
    await schedule(t.db, { queue: 'nolimit', key: 'b', payload: {} });
    await expect(claimJobs(t.db, 'nolimit', 5, LEASE)).rejects.toBeInstanceOf(NoQueueLimitError);
  });

  it('没到点的不领；到点按数据库时钟判（应用时钟跳了也不影响）', async () => {
    await schedule(t.db, { queue: 'q', key: 'later', payload: {}, delayMs: 3_600_000 });
    expect(await claimJobs(t.db, 'q', 5, LEASE)).toEqual([]);
    await t.db.update(jobs).set({ dueAt: sql`now() - interval '1 second'` });
    expect((await claimJobs(t.db, 'q', 5, LEASE)).map((j) => j.key)).toEqual(['later']);
  });
});

describe('做的进程出事', () => {
  it('被杀（租约过期）：别人接着领，attempts 加一', async () => {
    await schedule(t.db, { queue: 'q', key: 'k', payload: {} });
    const [a] = await claimJobs(t.db, 'q', 5, LEASE);
    expect(await claimJobs(t.db, 'q', 5, LEASE)).toEqual([]);
    await expireLeases();
    const [b] = await claimJobs(t.db, 'q', 5, LEASE);
    expect(b).toMatchObject({ key: 'k', attempts: 2 });
    expect(b?.claimToken).not.toBe(a?.claimToken);
  });

  it('被 SIGSTOP 后回来：心跳回 lost、收尾被拒，结果不写；新领的人照常收尾', async () => {
    await schedule(t.db, { queue: 'q', key: 'k', payload: {} });
    const [stale] = await claimJobs(t.db, 'q', 5, LEASE);
    if (!stale) throw new Error('没领到');
    await expireLeases();
    const [fresh] = await claimJobs(t.db, 'q', 5, LEASE);
    if (!fresh) throw new Error('没接到');
    expect(await heartbeat(t.db, stale, LEASE)).toBe('lost');
    await expect(completeJob(t.db, stale)).rejects.toBeInstanceOf(LostClaimError);
    expect(await heartbeat(t.db, fresh, LEASE)).toBe('ok');
    await completeJob(t.db, fresh);
    expect((await stateOf('k'))?.state).toBe('done');
  });

  it('两个内核同时领：同一件活只给一个', async () => {
    for (let i = 0; i < 6; i++) await schedule(t.db, { queue: 'q', key: `k${i}`, payload: {} });
    const [x, y] = await Promise.all([claimJobs(t.db, 'q', 6, LEASE), claimJobs(t.db, 'q', 6, LEASE)]);
    const keys = [...(x ?? []), ...(y ?? [])].map((j) => j.key);
    expect(new Set(keys).size).toBe(keys.length);
    expect(keys.length).toBe(6);
  });

  it('毒活：每次领了都没做完（进程死），到次数上限进 dead，不再交出去', async () => {
    await schedule(t.db, { queue: 'q', key: 'poison', payload: {}, maxAttempts: 2 });
    await schedule(t.db, { queue: 'q', key: 'ok', payload: {} });
    for (let i = 0; i < 3; i++) {
      for (const j of await claimJobs(t.db, 'q', 5, LEASE)) if (j.key === 'ok') await completeJob(t.db, j);
      await expireLeases();
    }
    expect(await stateOf('poison')).toMatchObject({ state: 'dead' });
    expect((await stateOf('poison'))?.lastError).toContain('领了 2 次');
    expect((await stateOf('ok'))?.state).toBe('done');
  });

  it('确定没做成：退避重排；次数到顶进 dead', async () => {
    await schedule(t.db, { queue: 'q', key: 'r', payload: {}, maxAttempts: 2 });
    const [a] = await claimJobs(t.db, 'q', 5, LEASE);
    if (!a) throw new Error('没领到');
    await retryJob(t.db, a, '上游 503', 0);
    const [b] = await claimJobs(t.db, 'q', 5, LEASE);
    if (!b) throw new Error('没再领到');
    await retryJob(t.db, b, '上游 503', 0);
    expect(await stateOf('r')).toMatchObject({ state: 'dead' });
  });
});

describe('停机后积压一起到期：按队列限速追赶', () => {
  it('同时在领不超过 maxInflight，每分钟新领不超过 perMinute', async () => {
    await setQueueLimit(t.db, 'q', 3, 5);
    for (let i = 0; i < 20; i++) await schedule(t.db, { queue: 'q', key: `b${i}`, payload: {} });
    const first = await claimJobs(t.db, 'q', 20, LEASE);
    expect(first).toHaveLength(3);
    expect(await claimJobs(t.db, 'q', 20, LEASE)).toEqual([]);
    for (const j of first) await completeJob(t.db, j);
    const second = await claimJobs(t.db, 'q', 20, LEASE);
    expect(second).toHaveLength(2);
    for (const j of second) await completeJob(t.db, j);
    expect(await claimJobs(t.db, 'q', 20, LEASE)).toEqual([]);
    const h = await queueHealth(t.db, 'q');
    expect(h.inflight).toBe(0);
    expect(h.oldestDueSeconds).toBeGreaterThanOrEqual(0);
  });
});

describe('取消和截止', () => {
  it('取消一路传到子孙；领着的人下次心跳拿到 cancelled；已取消的父活下不能再排子活', async () => {
    await schedule(t.db, { queue: 'q', key: 'p', payload: {} });
    await schedule(t.db, { queue: 'q', key: 'c1', payload: {}, parentKey: 'p' });
    await schedule(t.db, { queue: 'q', key: 'g1', payload: {}, parentKey: 'c1' });
    const claimed = await claimJobs(t.db, 'q', 5, LEASE);
    const child = claimed.find((j) => j.key === 'c1');
    if (!child) throw new Error('子活没领到');
    expect(await cancelJob(t.db, 'p', '人点了停')).toBe(3);
    expect(await heartbeat(t.db, child, LEASE)).toBe('cancelled');
    await expect(completeJob(t.db, child)).rejects.toBeInstanceOf(LostClaimError);
    expect(await schedule(t.db, { queue: 'q', key: 'c2', payload: {}, parentKey: 'p' })).toMatchObject({
      kind: 'refused',
    });
  });

  it('子活截止不晚于父活；过了截止不再领、进 dead', async () => {
    await schedule(t.db, { queue: 'q', key: 'p', payload: {}, deadlineInMs: 60_000 });
    await schedule(t.db, { queue: 'q', key: 'c', payload: {}, parentKey: 'p', deadlineInMs: 3_600_000 });
    const p = await stateOf('p');
    const c = await stateOf('c');
    expect(c?.deadlineAt?.getTime()).toBe(p?.deadlineAt?.getTime());
    await t.db.update(jobs).set({ deadlineAt: sql`now() - interval '1 second'` }).where(eq(jobs.key, 'c'));
    const got = await claimJobs(t.db, 'q', 5, LEASE);
    expect(got.map((j) => j.key)).toEqual(['p']);
    expect(await stateOf('c')).toMatchObject({ state: 'dead', lastError: '过了截止时刻还没做完' });
  });
});

describe('死活在同一个事务里交给派活的一方', () => {
  it('过截止的、毒活（领到上限）都交给 onDead，各一次', async () => {
    await schedule(t.db, { queue: 'q', key: 'late', payload: { who: 'late' } });
    await schedule(t.db, { queue: 'q', key: 'poison', payload: { who: 'poison' }, maxAttempts: 1 });
    await t.db.update(jobs).set({ deadlineAt: sql`now() - interval '1 second'` }).where(eq(jobs.key, 'late'));
    const seen: string[] = [];
    const onDead = async (_tx: unknown, dead: { key: string; state: string }[]) => {
      for (const d of dead) seen.push(`${d.key}:${d.state}`);
    };
    expect((await claimJobs(t.db, 'q', 5, LEASE, { onDead })).map((j) => j.key)).toEqual(['poison']);
    await expireLeases();
    expect(await claimJobs(t.db, 'q', 5, LEASE, { onDead })).toEqual([]);
    expect(seen.sort()).toEqual(['late:dead', 'poison:dead']);
  });

  it('onDead 抛错：整次领取回滚，活还在、下次再报', async () => {
    await schedule(t.db, { queue: 'q', key: 'late', payload: {} });
    await t.db.update(jobs).set({ deadlineAt: sql`now() - interval '1 second'` }).where(eq(jobs.key, 'late'));
    const boom = async () => {
      throw new Error('收件箱写不进');
    };
    await expect(claimJobs(t.db, 'q', 5, LEASE, { onDead: boom })).rejects.toThrow('收件箱写不进');
    expect((await stateOf('late'))?.state).toBe('pending');
    const seen: string[] = [];
    await claimJobs(t.db, 'q', 5, LEASE, {
      onDead: async (_tx, d) => void seen.push(...d.map((x) => x.key)),
    });
    expect(seen).toEqual(['late']);
  });
});

describe('健康数字', () => {
  it('看得出积压、租约过期还挂着的、dead', async () => {
    await schedule(t.db, { queue: 'q', key: 'x', payload: {} });
    await schedule(t.db, { queue: 'q', key: 'y', payload: {} });
    await t.db.update(jobs).set({ dueAt: sql`now() - interval '120 seconds'` }).where(eq(jobs.key, 'x'));
    expect((await queueHealth(t.db, 'q')).oldestDueSeconds).toBeGreaterThanOrEqual(119);
    await claimJobs(t.db, 'q', 5, LEASE);
    await expireLeases();
    expect(await queueHealth(t.db, 'q')).toMatchObject({ inflight: 0, expiredLeases: 2, dead: 0 });
  });
});
