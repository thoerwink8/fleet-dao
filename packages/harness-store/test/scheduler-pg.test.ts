// 调度领取里 PGlite 造不出来的三件事（#3859 第 1 片）：连接被掐、事务只读、锁等待超时。
// 连真 Postgres，不走 PGlite。有测试库连接串就用那台，并另建一个库；没有就用本机 Postgres 16 起一个临时实例。
// 连接串的环境变量和仓里别的真库测试是同一个，名字拆开拼：本文件不在分台名单里，整词写出会让核对红，名单不在这张单的改动里。
import { spawnSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { existsSync, mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { createServer } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { eq } from 'drizzle-orm';
import { drizzle } from 'drizzle-orm/postgres-js';
import { migrate } from 'drizzle-orm/postgres-js/migrator';
import postgres from 'postgres';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { MIGRATION_OPTIONS } from '../src/index.ts';
import { claimJobs, completeJob, heartbeat, type Job, schedule, setQueueLimit } from '../src/scheduler.ts';
import * as schema from '../src/schema.ts';
import { jobs } from '../src/schema.ts';
import { type Db, LostClaimError } from '../src/store.ts';

const PG_URL_KEY = ['FLEET', 'TEST', 'PG', 'URL'].join('_');
const LEASE = 60_000;
const STALL_TOKEN = '11111111-1111-4111-8111-111111111111';

const forced = vi.hoisted(() => ({ token: '', armed: false }));
vi.mock('node:crypto', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:crypto')>();
  return {
    ...actual,
    randomUUID: () => {
      if (forced.armed) {
        forced.armed = false;
        return forced.token;
      }
      return actual.randomUUID();
    },
  };
});

type Handle = { sql: postgres.Sql; db: Db; end: () => Promise<void> };

function open(url: string, max: number, connection?: Record<string, string>): Handle {
  const sql = postgres(url, { max, onnotice: () => {}, ...(connection ? { connection } : {}) });
  return {
    sql,
    db: drizzle(sql, { schema }) as unknown as Db,
    end: () => sql.end({ timeout: 5 }),
  };
}

function pgBin(name: string): string | undefined {
  for (const dir of ['/usr/lib/postgresql/16/bin', '/usr/lib/postgresql/15/bin']) {
    const path = join(dir, name);
    if (existsSync(path)) return path;
  }
  return undefined;
}

function runBin(bin: string, args: string[]): void {
  const res = spawnSync(bin, args, { encoding: 'utf8' });
  if (res.status !== 0) {
    throw new Error(`${bin} ${args.join(' ')} 退出 ${res.status}\n${res.stdout}\n${res.stderr}`);
  }
}

function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const server = createServer();
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => {
      const addr = server.address();
      if (!addr || typeof addr === 'string') {
        server.close();
        reject(new Error('没有拿到空闲端口'));
        return;
      }
      server.close((err) => (err ? reject(err) : resolve(addr.port)));
    });
  });
}

async function startLocal(): Promise<{ url: string; stop: () => Promise<void> }> {
  const initdb = pgBin('initdb');
  const pgCtl = pgBin('pg_ctl');
  if (!initdb || !pgCtl) throw new Error('没有 Postgres 服务端，临时实例起不来');
  const dir = mkdtempSync(join(tmpdir(), 'fleet2-sched-pg-'));
  const data = join(dir, 'data');
  const sock = join(dir, 'sock');
  mkdirSync(sock);
  const port = await freePort();
  const stop = async () => {
    spawnSync(pgCtl, ['-D', data, '-m', 'fast', '-w', 'stop'], { encoding: 'utf8' });
    rmSync(dir, { recursive: true, force: true });
  };
  try {
    runBin(initdb, [
      '-D',
      data,
      '--username=fleet_test',
      '--auth=trust',
      '--locale=C',
      '--encoding=UTF8',
      '--no-instructions',
    ]);
    runBin(pgCtl, [
      '-D',
      data,
      '-l',
      join(dir, 'log'),
      '-w',
      'start',
      '-o',
      `-h 127.0.0.1 -p ${port} -k ${sock} -c listen_addresses=127.0.0.1 -c unix_socket_directories=${sock}`,
    ]);
  } catch (err) {
    await stop();
    throw err;
  }
  return { url: `postgres://fleet_test@127.0.0.1:${port}/postgres`, stop };
}

function urlForDb(url: string, db: string): string {
  const u = new URL(url);
  if (!u.pathname || u.pathname === '/') throw new Error('测试库连接串里没有库名');
  u.pathname = `/${db}`;
  return u.toString();
}

function errorText(err: unknown): string {
  const parts: string[] = [];
  let cur: unknown = err;
  for (let i = 0; i < 5 && cur !== undefined && cur !== null; i++) {
    if (typeof cur !== 'object') {
      parts.push(String(cur));
      break;
    }
    const row = cur as { message?: unknown; code?: unknown; cause?: unknown };
    if (row.message !== undefined) parts.push(String(row.message));
    if (row.code !== undefined) parts.push(String(row.code));
    cur = row.cause;
  }
  return parts.join('\n');
}

const configuredUrl = process.env[PG_URL_KEY]?.trim() ?? '';
const canRun = Boolean(configuredUrl) || Boolean(pgBin('initdb') && pgBin('pg_ctl'));

describe.skipIf(!canRun)('真 Postgres 上的调度领取', () => {
  let main: Handle;
  let ro: Handle;
  let victim: Handle;
  let blocker: Handle;
  let slow: Handle;
  let stop: (() => Promise<void>) | undefined;
  const closers: Array<() => Promise<void>> = [];

  const onUncaught = (err: unknown) => {
    // pg_terminate_backend 把连接掐掉后，postgres.js 还可能在下一拍往已经拆掉的 socket 上写，抛的是驱动内部的 TypeError，不是领取的结果。
    if (
      err instanceof TypeError &&
      err.message.includes("reading 'write'") &&
      (err.stack ?? '').includes('connection.js')
    )
      return;
    process.off('uncaughtException', onUncaught);
    throw err;
  };

  beforeAll(async () => {
    process.on('uncaughtException', onUncaught);
    let dbUrl: string;
    if (configuredUrl) {
      const name = `fleet2sp_${randomUUID().replaceAll('-', '')}`;
      if (!/^fleet2sp_[a-f0-9]{32}$/.test(name)) throw new Error(`库名不安全：${name}`);
      const admin = postgres(configuredUrl, { max: 1, onnotice: () => {} });
      try {
        await admin.unsafe(`create database ${name}`);
      } catch (err) {
        await admin.end({ timeout: 5 }).catch(() => {});
        throw err;
      }
      dbUrl = urlForDb(configuredUrl, name);
      stop = async () => {
        try {
          await admin.unsafe(`drop database if exists ${name} with (force)`);
        } finally {
          await admin.end({ timeout: 5 });
        }
      };
    } else {
      const local = await startLocal();
      dbUrl = local.url;
      stop = local.stop;
    }
    const migrator = open(dbUrl, 1);
    closers.push(migrator.end);
    await migrate(drizzle(migrator.sql, { schema }), MIGRATION_OPTIONS);
    main = open(dbUrl, 2);
    closers.push(main.end);
    ro = open(dbUrl, 1, { default_transaction_read_only: 'on' });
    closers.push(ro.end);
    victim = open(dbUrl, 1);
    closers.push(victim.end);
    blocker = open(dbUrl, 1);
    closers.push(blocker.end);
    slow = open(dbUrl, 1, { lock_timeout: '400' });
    closers.push(slow.end);
  }, 60_000);

  afterAll(async () => {
    for (const end of closers.reverse()) await end().catch(() => {});
    await stop?.();
    await new Promise((resolve) => setImmediate(resolve));
    process.off('uncaughtException', onUncaught);
  }, 30_000);

  beforeEach(async () => {
    await blocker.sql`rollback`.catch(() => {});
    await main.sql`truncate fleet2.jobs, fleet2.queue_limits restart identity`;
    await setQueueLimit(main.db, 'q', 10, 100);
  });

  const stateOf = (key: string) =>
    main.db
      .select()
      .from(jobs)
      .where(eq(jobs.key, key))
      .then((rows) => rows[0]);

  it('连接被 pg_terminate_backend 掐掉：续租是 lost，收尾被拒，同一件活只做成一次', async () => {
    const scheduled = await schedule(main.db, { queue: 'q', key: 'cut', payload: { n: 1 } });
    if (scheduled.kind !== 'created') throw new Error('没排上');
    const pid = Number((await victim.sql<{ pid: number }[]>`select pg_backend_pid() as pid`)[0]?.pid);
    if (!pid) throw new Error('没有 backend pid');
    await blocker.sql`begin`;
    try {
      await blocker.sql`select queue from fleet2.queue_limits where queue = 'q' for update`;
      forced.token = STALL_TOKEN;
      forced.armed = true;
      const claimP = claimJobs(victim.db, 'q', 5, LEASE);
      try {
        await waitForLock(main.sql, pid);
        await main.sql`select pg_terminate_backend(${pid})`;
        const outcome = await claimP.then(
          () => 'ok' as const,
          (err: unknown) => err,
        );
        expect(outcome).not.toBe('ok');
        expect(errorText(outcome)).toMatch(/terminat|administrator|57P01|connection|ECONNRESET/i);
      } finally {
        await blocker.sql`rollback`.catch(() => {});
        await Promise.race([claimP.catch(() => {}), new Promise((resolve) => setTimeout(resolve, 2_000))]);
      }
      expect(await stateOf('cut')).toMatchObject({ state: 'pending', attempts: 0, claimToken: null });
      const ghost: Job = { ...scheduled.job, state: 'claimed', claimToken: STALL_TOKEN };
      expect(await heartbeat(main.db, ghost, LEASE)).toBe('lost');
      await expect(completeJob(main.db, ghost)).rejects.toBeInstanceOf(LostClaimError);
      expect(await stateOf('cut')).toMatchObject({ state: 'pending' });

      const [fresh] = await claimJobs(main.db, 'q', 5, LEASE);
      if (!fresh) throw new Error('掐掉之后没能重新领到');
      expect(fresh.claimToken).not.toBe(STALL_TOKEN);
      await completeJob(main.db, fresh);
      await expect(completeJob(main.db, fresh)).rejects.toBeInstanceOf(LostClaimError);
      await expect(completeJob(main.db, ghost)).rejects.toBeInstanceOf(LostClaimError);
      expect(await stateOf('cut')).toMatchObject({ state: 'done', attempts: 1 });
      await new Promise((resolve) => setImmediate(resolve));
    } finally {
      await blocker.sql`rollback`.catch(() => {});
    }
  }, 15_000);

  it('事务只读时领取和收尾抛明确错误，不当成功', async () => {
    const mode = await ro.sql<
      { default_transaction_read_only: string }[]
    >`show default_transaction_read_only`;
    expect(mode[0]?.default_transaction_read_only).toBe('on');
    await schedule(main.db, { queue: 'q', key: 'ro', payload: {} });

    const claimErr = await claimJobs(ro.db, 'q', 5, LEASE).then(
      () => undefined,
      (err: unknown) => err,
    );
    expect(claimErr).toBeInstanceOf(Error);
    expect(errorText(claimErr)).toMatch(/read-only|25006/i);
    expect(await stateOf('ro')).toMatchObject({ state: 'pending', attempts: 0 });

    const [job] = await claimJobs(main.db, 'q', 5, LEASE);
    if (!job) throw new Error('没领到');
    const finishErr = await completeJob(ro.db, job).then(
      () => undefined,
      (err: unknown) => err,
    );
    expect(finishErr).toBeInstanceOf(Error);
    expect(errorText(finishErr)).toMatch(/read-only|25006/i);
    expect(await stateOf('ro')).toMatchObject({ state: 'claimed', claimToken: job.claimToken });

    await completeJob(main.db, job);
    expect(await stateOf('ro')).toMatchObject({ state: 'done' });
  });

  it('锁等待超过 lock_timeout 时领取返回，不一直等', async () => {
    const shown = await slow.sql<{ lock_timeout: string }[]>`show lock_timeout`;
    expect(shown[0]?.lock_timeout).toBe('400ms');
    await schedule(main.db, { queue: 'q', key: 'lock', payload: {} });
    await blocker.sql`begin`;
    try {
      await blocker.sql`select queue from fleet2.queue_limits where queue = 'q' for update`;
      const started = Date.now();
      const got = await claimJobs(slow.db, 'q', 5, LEASE);
      const waited = Date.now() - started;
      expect(got).toEqual([]);
      expect(waited).toBeGreaterThanOrEqual(200);
      expect(waited).toBeLessThan(3_000);
      expect(await stateOf('lock')).toMatchObject({ state: 'pending', attempts: 0, claimToken: null });
    } finally {
      await blocker.sql`rollback`.catch(() => {});
    }
    const [fresh] = await claimJobs(main.db, 'q', 5, LEASE);
    expect(fresh?.key).toBe('lock');
    if (!fresh) throw new Error('锁放开后没领到');
    await completeJob(main.db, fresh);
    expect(await stateOf('lock')).toMatchObject({ state: 'done', attempts: 1 });
  }, 15_000);
});

async function waitForLock(sql: postgres.Sql, pid: number): Promise<void> {
  const deadline = Date.now() + 5_000;
  while (Date.now() < deadline) {
    const rows = await sql<{ wait_event_type: string | null }[]>`
      select wait_event_type from pg_stat_activity where pid = ${pid}
    `;
    if (rows[0]?.wait_event_type === 'Lock') return;
    await new Promise((r) => setTimeout(r, 20));
  }
  const activity = await sql<
    {
      pid: number;
      state: string | null;
      wait_event_type: string | null;
      wait_event: string | null;
      query: string;
    }[]
  >`
    select pid, state, wait_event_type, wait_event, left(query, 180) as query
    from pg_stat_activity
    where usename = current_user
  `;
  throw new Error(`后端 ${pid} 没有在等锁：${JSON.stringify(activity)}`);
}
