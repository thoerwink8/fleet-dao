// 看门狗的「主线 N 小时没合 PR」（决定 0093，jobs/merge-stall.ts）：判法的纯函数，加真库上看门狗一轮的报、撤（real/watchdog.ts）。
// 需求里的每一种都故意造一次：超过 N 小时没合、有待做的单 → 报一条；没活干 → 不报；合了 → 撤并写为什么；
// 开关关了 → 撤；人处理过的同一段不再打开；正文不带每轮变的数、没变不改卡；读不到事实 → 这一轮没跑成、开着的不撤。
import { rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  notifications,
  pullRequests,
  registerScheduledJobs,
  repos,
  resolveAlertWithReason,
  tasks,
  writeIntakeWaiting,
} from '@fleet-dao/db';
import { createTestDb, resetTestDb, TEST_DB_TIMEOUT_MS, type TestDb } from '@fleet-dao/db/testing';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import {
  judgeMergeStall,
  MERGE_STALL_HOURS,
  mergeStallKey,
  repoOfMergeStallKey,
} from '../src/jobs/merge-stall.ts';
import {
  runWatchdogJob,
  WATCHDOG_JOB,
  type WatchdogDeps,
  WatchdogFailedError,
} from '../src/jobs/watchdog.ts';
import { watchdogJob } from '../src/real/watchdog.ts';

/** 北京时间 10-14 20:00。 */
const T0 = new Date('2026-10-14T12:00:00.000Z');
const HOUR = 3_600_000;
const at = (h: number) => new Date(T0.getTime() + h * HOUR);

describe('judgeMergeStall（纯函数）', () => {
  const base = { repoId: 'r1', repo: 'acme/app', dispatchSince: at(-48), inFlight: 1, waiting: 0 };

  it('N 是 4 小时', () => {
    expect(MERGE_STALL_HOURS).toBe(4);
  });

  it('【故意造出的失败】最近合并超过 4 小时、手上有单：报，键按最近合的 PR 分段，正文不带几张、多久', () => {
    const v = judgeMergeStall({ ...base, lastMerged: { number: 42, at: at(-5) } }, T0);
    expect(v).toMatchObject({
      kind: 'alert',
      key: 'watchdog:merge:acme/app:after-42',
      title: '「acme/app」超过 4 小时没合 PR',
    });
    if (v.kind !== 'alert') throw new Error('应当报');
    expect(v.body).toContain('最近合的是 #42（10-14 15:00）');
    expect(v.body).not.toMatch(/张|小时 \d+ 分/);
  });

  it('只有在等空位的单（手上没在做的）也算有活', () => {
    const v = judgeMergeStall(
      { ...base, inFlight: 0, waiting: 3, lastMerged: { number: 1, at: at(-6) } },
      T0,
    );
    expect(v.kind).toBe('alert');
  });

  it('没超过 4 小时：不报', () => {
    const v = judgeMergeStall({ ...base, lastMerged: { number: 9, at: at(-3.9) } }, T0);
    expect(v).toMatchObject({ kind: 'fine' });
  });

  it('超过 4 小时但没活干（没在做、没在等）：不报，夜里空闲不算断', () => {
    const v = judgeMergeStall(
      { ...base, inFlight: 0, waiting: null, lastMerged: { number: 9, at: at(-9) } },
      T0,
    );
    expect(v).toMatchObject({ kind: 'fine', why: expect.stringContaining('没活干') });
  });

  it('开关是后来打开的：从打开那一刻算，键还是按最近合的 PR', () => {
    const f = { ...base, dispatchSince: at(-2), lastMerged: { number: 7, at: at(-30) } };
    expect(judgeMergeStall(f, T0).kind).toBe('fine');
    const later = judgeMergeStall(f, at(3));
    expect(later).toMatchObject({ kind: 'alert', key: 'watchdog:merge:acme/app:after-7' });
    if (later.kind !== 'alert') throw new Error('应当报');
    expect(later.body).toContain('打开「让 AI 接活」以来一个都没合过');
  });

  it('从没合过：键按开关打开的时刻分段；键里认得出仓', () => {
    const key = mergeStallKey({ repo: 'acme/app', lastMerged: null, dispatchSince: at(-10) });
    expect(key).toBe(`watchdog:merge:acme/app:since-${at(-10).getTime()}`);
    expect(repoOfMergeStallKey(key)).toBe('acme/app');
  });
});

describe('看门狗一轮里的「多久没合 PR」（真库）', () => {
  let t: TestDb;
  let clock = T0;
  /** 不看法国发布目录：目录在时简报和发版会卷进来，扫到的条数对不上。那两条另有用例。 */
  const NO_RELEASES = join(tmpdir(), 'merge-stall-test-no-releases');

  beforeAll(async () => {
    t = await createTestDb();
  }, TEST_DB_TIMEOUT_MS);
  afterAll(() => t.close());
  beforeEach(async () => {
    await resetTestDb(t);
    rmSync(NO_RELEASES, { recursive: true, force: true });
    clock = T0;
    await registerScheduledJobs(t.db, [{ ...WATCHDOG_JOB, registeredAt: at(-24 * 30) }]);
  });

  function deps(over: Partial<WatchdogDeps> = {}): WatchdogDeps {
    return {
      ...watchdogJob({ db: t.db, now: () => clock, log: () => {}, releasesDir: NO_RELEASES })(),
      ...over,
    };
  }

  async function repo(name: string, since: Date | null) {
    const [r] = await t.db
      .insert(repos)
      .values({ owner: 'acme', name, testCommand: 'pnpm check', autoDispatchSince: since })
      .returning();
    if (!r) throw new Error('仓没写进去');
    return r;
  }

  async function merged(repoId: string, number: number, when: Date) {
    await t.db.insert(pullRequests).values({
      repoId,
      number,
      state: 'merged',
      headRef: `fleet/${number}`,
      headSha: 'a'.repeat(40),
      updatedAt: when,
      mergedAt: when,
    });
  }

  let issue = 1;
  async function task(repoId: string, state: typeof tasks.$inferInsert.state) {
    await t.db.insert(tasks).values({
      repoId,
      issueNumber: issue++,
      title: '给登录页加验证码',
      rawRequest: '登录页加一个手机验证码',
      requestedBy: 'founder-a',
      priority: 10,
      state,
    });
  }

  const merges = async () =>
    (await t.db.select().from(notifications)).filter((n) => n.dedupeKey.startsWith('watchdog:merge:'));

  it('【故意造出的失败】有单在做、5 小时没合：报一条卡住报警（点进去任务页）；下一轮没变不改卡；合了一个就撤、写为什么', async () => {
    const r = await repo('app', at(-48));
    await merged(r.id, 41, at(-5));
    await task(r.id, 'running');

    expect(await runWatchdogJob(deps())).toMatchObject({ outcome: 'ok', scanned: 1, found: 1 });
    const [a] = await merges();
    expect(a).toMatchObject({
      dedupeKey: 'watchdog:merge:acme/app:after-41',
      level: 'alert',
      title: '「acme/app」超过 4 小时没合 PR',
      link: '/tasks',
      resolvedAt: null,
    });

    clock = at(1);
    await runWatchdogJob(deps());
    const [same] = await merges();
    expect(same?.updatedAt).toEqual(a?.updatedAt);

    await merged(r.id, 42, at(1.5));
    clock = at(2);
    expect(await runWatchdogJob(deps())).toMatchObject({ outcome: 'ok', found: 0 });
    const [done] = await merges();
    expect(done?.resolvedAt).not.toBeNull();
    expect(done?.resolvedBy).toBe('engine:watchdog');
    expect(done?.body.split('\n')[0]).toContain('合了 #42');
  });

  it('只有拉单记下的等空位的单也报；没活干（只有在等人回的单）不报', async () => {
    const busy = await repo('busy', at(-48));
    const idle = await repo('idle', at(-48));
    await merged(busy.id, 3, at(-6));
    await merged(idle.id, 4, at(-6));
    await task(idle.id, 'stalled');
    await writeIntakeWaiting(t.db, { at: at(-0.1), byRepo: { [busy.id]: 2, [idle.id]: 0 }, by: 'test' });

    await runWatchdogJob(deps());
    expect((await merges()).map((n) => n.dedupeKey)).toEqual(['watchdog:merge:acme/busy:after-3']);
  });

  it('开关关了：撤，写明不再看', async () => {
    const r = await repo('app', at(-48));
    await merged(r.id, 5, at(-5));
    await task(r.id, 'running');
    await runWatchdogJob(deps());
    await t.client.query('update repos set auto_dispatch_since = null where id = $1', [r.id]);
    await runWatchdogJob(deps());
    const [n] = await merges();
    expect(n?.resolvedAt).not.toBeNull();
    expect(n?.body.split('\n')[0]).toContain('「让 AI 接活」关了');
  });

  it('同一段人点了处理：不再打开（人接手了）', async () => {
    const r = await repo('app', at(-48));
    await merged(r.id, 5, at(-5));
    await task(r.id, 'running');
    await runWatchdogJob(deps());
    await resolveAlertWithReason(t.db, {
      dedupeKey: 'watchdog:merge:acme/app:after-5',
      by: 'founder-a',
      why: '在看',
      at: at(0.1),
    });
    clock = at(1);
    await runWatchdogJob(deps());
    const [n] = await merges();
    expect(n?.resolvedBy).toBe('founder-a');
  });

  it('【故意造出的失败】读不到事实：这一轮记没跑成，开着的那条不撤', async () => {
    const r = await repo('app', at(-48));
    await merged(r.id, 5, at(-5));
    await task(r.id, 'running');
    await runWatchdogJob(deps());
    await expect(
      runWatchdogJob(
        deps({
          mergeStall: async () => {
            throw new Error('库断了');
          },
        }),
      ),
    ).rejects.toThrow(WatchdogFailedError);
    const [n] = await merges();
    expect(n?.resolvedAt).toBeNull();
  });
});
