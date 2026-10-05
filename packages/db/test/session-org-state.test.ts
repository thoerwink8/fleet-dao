// 切号账本和锁（#194）：存取原样、锁单飞、过期的能接手、只放自己的锁。
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { readOrgState, releaseOrgLock, saveOrgState, takeOrgLock } from '../src/queries/session-org-state.ts';
import { createTestDb, resetTestDb, TEST_DB_TIMEOUT_MS, type TestDb } from '../src/testing.ts';
import { MIN, NOW } from './helpers.ts';

let t: TestDb;
beforeAll(async () => {
  t = await createTestDb();
}, TEST_DB_TIMEOUT_MS);
afterAll(() => t.close());
beforeEach(() => resetTestDb(t));

const USER = 'fleet-agent-carpool';
const EMPTY = { v: 1 };

describe('账本存取', () => {
  it('没有这一行回 null，不当成空账本', async () => {
    expect(await readOrgState(t.db, USER)).toBeNull();
  });

  it('存了原样读回，再存换掉', async () => {
    await saveOrgState(t.db, USER, { v: 1, outage: { kind: 'E1' } }, NOW);
    const first = await readOrgState(t.db, USER);
    expect(first?.doc).toEqual({ v: 1, outage: { kind: 'E1' } });
    await saveOrgState(t.db, USER, { v: 1 }, new Date(NOW.getTime() + MIN));
    const second = await readOrgState(t.db, USER);
    expect(second?.doc).toEqual({ v: 1 });
    expect(second?.updatedAt.getTime()).toBe(NOW.getTime() + MIN);
  });
});

describe('切号的锁（单飞）', () => {
  const take = (holder: string, at: Date, ttlMs = 5 * MIN) =>
    takeOrgLock(t.db, USER, { holder, now: at, ttlMs, emptyDoc: EMPTY });

  it('第一个拿得到，没过期时第二个拿不到', async () => {
    expect(await take('a', NOW)).toBe(true);
    expect(await take('b', new Date(NOW.getTime() + MIN))).toBe(false);
  });

  it('同一个持有人再拿算续期', async () => {
    expect(await take('a', NOW)).toBe(true);
    expect(await take('a', new Date(NOW.getTime() + MIN))).toBe(true);
    const row = await readOrgState(t.db, USER);
    expect(row?.lockUntil?.getTime()).toBe(NOW.getTime() + 6 * MIN);
  });

  it('【故意造出失败】拿着锁的进程没放就没了（引擎重启）：锁没过期前别人拿不到，过期后能接手', async () => {
    expect(await take('dead', NOW)).toBe(true);
    expect(await take('new', new Date(NOW.getTime() + 4 * MIN))).toBe(false);
    expect(await take('new', new Date(NOW.getTime() + 6 * MIN))).toBe(true);
    expect((await readOrgState(t.db, USER))?.lockHolder).toBe('new');
  });

  it('放锁只放自己的：被别人接手后，旧持有人放锁不动人家的', async () => {
    await take('dead', NOW);
    await take('new', new Date(NOW.getTime() + 6 * MIN));
    await releaseOrgLock(t.db, USER, 'dead');
    expect((await readOrgState(t.db, USER))?.lockHolder).toBe('new');
    await releaseOrgLock(t.db, USER, 'new');
    expect((await readOrgState(t.db, USER))?.lockHolder).toBeNull();
  });

  it('拿锁不动账本本体；存账本不动锁', async () => {
    await saveOrgState(t.db, USER, { v: 1, keep: true }, NOW);
    await take('a', NOW);
    expect((await readOrgState(t.db, USER))?.doc).toEqual({ v: 1, keep: true });
    await saveOrgState(t.db, USER, { v: 1, keep: false }, NOW);
    expect((await readOrgState(t.db, USER))?.lockHolder).toBe('a');
  });
});
