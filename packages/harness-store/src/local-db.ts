// 本机装法的存储（#3858）：PGlite（内嵌 Postgres）落文件，跑和法国同一份 fleet2 迁移。
// 数据目录由调用方给（用户数据目录，不在安装目录）。一个目录同一时刻只许一个进程开：
// 用目录里的锁文件拦（PGlite 自己的 postmaster.pid 在进程被强杀后会残留，不能当锁用），锁里记 pid，
// 拿锁时发现 pid 已经不在了就接手。
import { closeSync, mkdirSync, openSync, readFileSync, rmSync, writeSync } from 'node:fs';
import { join } from 'node:path';
import { PGlite } from '@electric-sql/pglite';
import { drizzle } from 'drizzle-orm/pglite';
import { migrate } from 'drizzle-orm/pglite/migrator';
import { MIGRATION_OPTIONS } from './index.ts';
import * as schema from './schema.ts';
import type { Db } from './store.ts';

export interface LocalDb {
  db: Db;
  pg: PGlite;
  dir: string;
  close(): Promise<void>;
}

export class LocalDbBusyError extends Error {
  constructor(dir: string, pid: number) {
    super(`数据目录 ${dir} 已被进程 ${pid} 打开；一个目录只许一个内核用`);
    this.name = 'LocalDbBusyError';
  }
}

function alive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    return (err as NodeJS.ErrnoException).code === 'EPERM';
  }
}

function takeLock(dir: string): () => void {
  const lock = join(dir, 'fleet2.lock');
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      const fd = openSync(lock, 'wx');
      writeSync(fd, String(process.pid));
      closeSync(fd);
      return () => rmSync(lock, { force: true });
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== 'EEXIST') throw err;
      const pid = Number(readFileSync(lock, 'utf8').trim());
      if (Number.isInteger(pid) && alive(pid)) throw new LocalDbBusyError(dir, pid);
      rmSync(lock, { force: true }); // 上一个进程被杀没来得及放锁
    }
  }
  throw new Error(`拿不到数据目录的锁：${lock}`);
}

/** 开（没有就建）一个本机库并跑迁移。数据落在 `<dir>/pgdata`。 */
export async function openLocalDb(dir: string): Promise<LocalDb> {
  mkdirSync(dir, { recursive: true });
  const release = takeLock(dir);
  try {
    const pgdata = join(dir, 'pgdata');
    const pg = new PGlite(pgdata);
    await pg.waitReady;
    const db = drizzle(pg, { schema });
    await migrate(db, MIGRATION_OPTIONS);
    return {
      db: db as unknown as Db,
      pg,
      dir,
      async close() {
        try {
          await pg.close();
        } finally {
          release();
        }
      },
    };
  } catch (err) {
    release();
    throw err;
  }
}
