// 本机库（#3858）：PGlite 落文件，关了再开事件还在；强杀留下的锁能接手，活着的进程占着的不许抢。
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import { LocalDbBusyError, openLocalDb } from '../src/local-db.ts';
import { appendEvents, readStream } from '../src/store.ts';

const root = mkdtempSync(join(tmpdir(), 'fleet2-localdb-'));
afterAll(() => rmSync(root, { recursive: true, force: true }));

describe('openLocalDb', () => {
  it('写了事件、关库、再开，事件还在，事件号接着走', async () => {
    const dir = join(root, 'persist');
    const a = await openLocalDb(dir);
    const ev = (n: number) => ({ type: 'session.turn.started', schemaVersion: 1, payload: { n } }) as never;
    await appendEvents(a.db, 'session:p1', 0, [ev(1)]);
    await appendEvents(a.db, 'session:p1', 1, [ev(2)]);
    await a.close();
    const b = await openLocalDb(dir);
    const rows = await readStream(b.db, 'session:p1', 0);
    expect(rows.map((r) => (r.payload as { n: number }).n)).toEqual([1, 2]);
    const next = await appendEvents(b.db, 'session:p1', 2, [ev(3)]);
    expect(next.map((r) => r.seq)).toEqual([3]);
    await b.close();
  }, 60_000);

  it('同一个目录同时只许一个进程开', async () => {
    const dir = join(root, 'busy');
    const a = await openLocalDb(dir);
    await expect(openLocalDb(dir)).rejects.toBeInstanceOf(LocalDbBusyError);
    await a.close();
    await (await openLocalDb(dir)).close();
  }, 60_000);

  it('上一个进程被杀留下的锁（pid 已不在）直接接手', async () => {
    const dir = join(root, 'stale');
    await (await openLocalDb(dir)).close();
    writeFileSync(join(dir, 'fleet2.lock'), '2147483646'); // 不存在的 pid
    const a = await openLocalDb(dir);
    await a.close();
  }, 60_000);
});
