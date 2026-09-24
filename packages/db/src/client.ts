// 生产连接：引擎和驾驶舱后端都用 createDb()。连接串只从 DATABASE_URL 读，没有默认值。
import type { PgDatabase, PgQueryResultHKT } from 'drizzle-orm/pg-core';
import { drizzle } from 'drizzle-orm/postgres-js';
import postgres from 'postgres';
import * as schema from './schema/index.ts';

export type Schema = typeof schema;

/** 查询函数收的库：生产的 postgres.js、测试的 PGlite、事务，都能传。 */
export type Db = PgDatabase<PgQueryResultHKT, Schema>;

export interface CreateDbOptions {
  /** 不传就读 env.DATABASE_URL。 */
  url?: string;
  /** 默认 process.env；测试传假的 env，不碰真环境。 */
  env?: Record<string, string | undefined>;
  /** 连接池上限，默认 10。 */
  max?: number;
}

/**
 * LISTEN 一个频道（通常是 FLEET_CHANGES_CHANNEL）。每次（重新）连上并 LISTEN 成功都调 onListen：
 * 第二次起说明断过线，断线期间的通知已经丢了，订阅方该全量重拉。整个进程用一条这样的连接就够。
 */
export type PgListen = (
  channel: string,
  onNotify: (payload: string) => void,
  onListen: () => void,
) => Promise<{ unlisten: () => Promise<void> }>;

export function createDb(options: CreateDbOptions = {}) {
  const url = options.url ?? (options.env ?? process.env).DATABASE_URL;
  if (!url) {
    throw new Error('DATABASE_URL 没设。连接串没有默认值；测试请用 @fleet-dao/db/testing 的内存库。');
  }
  // postgres.js 到第一次查询才真连，所以这里不会碰网络。
  const client = postgres(url, { max: options.max ?? 10 });
  const db = drizzle(client, { schema });
  const listen: PgListen = (channel, onNotify, onListen) => client.listen(channel, onNotify, onListen);
  return { db, client, listen, close: () => client.end() };
}
