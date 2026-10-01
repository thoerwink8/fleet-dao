// 测试专用：PGlite（内存里的 Postgres）上跑真迁移。不连任何真库，不写任何目录。
// 生产代码不要 import 这里（PGlite 只是开发依赖）。
//
// 两种后端：
// - 默认（本机）：每个测试文件一份 PGlite，内存里建、跑完克隆。占内存大（每个测试进程峰值 GB 级，#220）。
// - 设了 FLEET_TEST_PG_URL（CI 的 db 测试分片）：连一个真 Postgres（CI 用 postgres:16 容器起的服务），
//   第一次建一个模板库跑一次迁移，之后每个测试文件 CREATE DATABASE <随机名> TEMPLATE 模板库 克隆一份。
//   真库只有一个，CI 起；本机没配就照 PGlite 走，本机不强制起服务。
// 没设 URL 时不会去找库，URL 连不上、迁移没跑成当场抛错，不静默退回 PGlite 冒充——#220「测试库连不上要明确报错」。
//
// 用法：每个测试文件一份库，每个测试前清空。
//   let t: TestDb;
//   beforeAll(async () => { t = await createTestDb(); }, TEST_DB_TIMEOUT_MS);
//   afterAll(() => t.close());
//   beforeEach(() => resetTestDb(t));
import { randomUUID } from 'node:crypto';
import { PGlite } from '@electric-sql/pglite';
import { drizzle as drizzlePglite } from 'drizzle-orm/pglite';
import { migrate as migratePglite } from 'drizzle-orm/pglite/migrator';
import { drizzle as drizzlePostgres } from 'drizzle-orm/postgres-js';
import { migrate as migratePostgres } from 'drizzle-orm/postgres-js/migrator';
import postgres from 'postgres';
import type { Db } from './client.ts';
import { MIGRATIONS_FOLDER } from './migrate.ts';
import * as schema from './schema/index.ts';

/** 测试库暴露给测试的最小接口：PGlite、真 Postgres 各实现一份。 */
export interface TestClient {
  query<R = Record<string, unknown>>(sql: string, params?: unknown[]): Promise<{ rows: R[] }>;
  /** 跑一段（可能多个语句的）SQL，不回行。 */
  exec(sql: string): Promise<void>;
  /** LISTEN 一个频道。返回取消函数。 */
  listen(channel: string, onNotify: (payload: string) => void): Promise<() => Promise<void>>;
  /** 只有 PGlite 有；测试里用它检查库在内存里。 */
  dataDir: string | undefined;
}

export interface TestDb {
  /** client.ts 的 Db 是 PgDatabase<…>（postgres.js、PGlite 都吃它）：查询函数都按它收。两种后端实际返回的都是。 */
  db: Db;
  client: TestClient;
  close: () => Promise<void>;
}

/** 第一次建库要初始化 PGlite 并跑迁移，一两秒；测试文件并行、机器忙时更久。放 beforeAll 并给这个超时。 */
export const TEST_DB_TIMEOUT_MS = 60_000;

/** 读 FLEET_TEST_PG_URL：设了就用真 Postgres；空串视为没设。 */
export function realTestPgUrl(
  env: Readonly<Record<string, string | undefined>> = process.env,
): string | undefined {
  const url = env.FLEET_TEST_PG_URL?.trim();
  return url ? url : undefined;
}

let pgliteTemplate: Promise<PGlite> | undefined;

/** 每个进程只建一次 PGlite、跑一次迁移，之后克隆。 */
async function migratedPgliteTemplate(): Promise<PGlite> {
  pgliteTemplate ??= (async () => {
    const pg = new PGlite();
    await migratePglite(drizzlePglite(pg, { schema }), { migrationsFolder: MIGRATIONS_FOLDER });
    return pg;
  })();
  return pgliteTemplate;
}

/**
 * 生产用的 postgres.js 驱动（drizzle 关掉了它的日期转换）收到 Date 参数会直接报错，PGlite 却照收：
 * 原样写在 sql`` 模板里的 Date 在测试里全绿、上了生产才炸（09-26 健康检查的 github_events 就是这么红的）。
 * 测试库照生产的样子拒收；列映射过的值 drizzle 会先转成字符串，到不了这里。要传时刻就写 `${d.toISOString()}::timestamptz`。
 * 真 Postgres 走 postgres.js 自己拒，不用这层。
 */
export function rejectDateParams(client: PGlite): void {
  const check = (params: unknown[] | undefined) => {
    if (params?.some((p) => p instanceof Date)) {
      throw new TypeError(
        'SQL 参数里有 Date：生产的 postgres.js 驱动会拒收（The "string" argument must be of type string…）。改成 d.toISOString() 再在 SQL 里 ::timestamptz',
      );
    }
  };
  const query = client.query.bind(client);
  client.query = ((q: string, params?: unknown[], options?: unknown) => {
    check(params);
    return query(q, params, options as never);
  }) as PGlite['query'];
  const transaction = client.transaction.bind(client);
  client.transaction = ((callback: Parameters<PGlite['transaction']>[0]) =>
    transaction((tx) => {
      const txQuery = tx.query.bind(tx);
      tx.query = ((q: string, params?: unknown[], options?: unknown) => {
        check(params);
        return txQuery(q, params, options as never);
      }) as typeof tx.query;
      return callback(tx);
    })) as PGlite['transaction'];
}

/** PGlite 后端的 TestClient 适配：把 PGlite 包成 TestClient 的样子。 */
function pgliteAsTestClient(client: PGlite): TestClient {
  return {
    query: <R>(sql: string, params?: unknown[]) => client.query<R>(sql, params as never[]),
    exec: async (sql: string) => {
      await client.exec(sql);
    },
    listen: async (channel: string, onNotify: (payload: string) => void) => client.listen(channel, onNotify),
    dataDir: client.dataDir,
  };
}

/** 一份独立的内存库（PGlite 模板的克隆）。 */
async function createPgliteTestDb(): Promise<TestDb> {
  const base = await migratedPgliteTemplate();
  const client = (await base.clone()) as PGlite;
  if (client.dataDir !== undefined && !client.dataDir.startsWith('memory://')) {
    throw new Error(`测试库必须在内存里，现在是 ${client.dataDir}`);
  }
  rejectDateParams(client);
  // drizzle 的 PGlite 驱动是 PgDatabase 家族（和 postgres.js 同一个抽象基底，函数签名兼容）；client.ts 的 Db 收它。
  const db = drizzlePglite(client, { schema }) as unknown as Db;
  return { db, client: pgliteAsTestClient(client), close: () => client.close() };
}

// ---------- 真 Postgres（CI） ----------

/** 模板库名：固定一个，连真库时并发的多个进程共用。 */
const TEMPLATE_DB = 'fleet_test_template';
/** 拿模板库的咨询锁：同时只有一个进程重建模板，其他进程等它建完直接用。 */
const TEMPLATE_LOCK_KEY = 818_220;

/** 每个进程一次：确保模板库建好、迁移跑过。同一个进程里第二次克隆不再去抢锁、不重复跑迁移。 */
let realTemplate: Promise<string> | undefined;

async function withAdminClient<T>(url: string, fn: (sql: postgres.Sql) => Promise<T>): Promise<T> {
  // postgres.js 的连接串写的是某个库；模板库要先在别的库上建，所以用连接串里那份库当 admin（一般是 postgres）。
  const sql = postgres(url, { max: 1, onnotice: () => {} });
  try {
    return await fn(sql);
  } finally {
    await sql.end({ timeout: 5 });
  }
}

/**
 * 模板库要是被别的测试当正式库写过东西（上一次跑崩了留下来的），不能继续用：把标记读出来对不上就重建。
 * 不核查模板是不是「干净」（没有正式数据）——那条是 real-pg.test.ts 的「造出失败」在测的事。
 */
async function ensureTemplate(url: string): Promise<string> {
  await withAdminClient(url, async (sql) => {
    await sql`select pg_advisory_lock(${TEMPLATE_LOCK_KEY})`;
    try {
      const exists = await sql<{ n: number }[]>`
        select count(*)::int as n from pg_database where datname = ${TEMPLATE_DB}
      `;
      if ((exists[0]?.n ?? 0) === 0) {
        await sql.unsafe(`create database ${TEMPLATE_DB}`);
      }
      // 迁移用同一批 SQL 跑：单开一个连接连模板库跑 migrate。已跑过的迁移它自己跳过。
      const tpl = postgres(urlForDb(url, TEMPLATE_DB), { max: 1, onnotice: () => {} });
      try {
        await migratePostgres(drizzlePostgres(tpl, { schema }), { migrationsFolder: MIGRATIONS_FOLDER });
      } finally {
        await tpl.end({ timeout: 5 });
      }
    } finally {
      await sql`select pg_advisory_unlock(${TEMPLATE_LOCK_KEY})`;
    }
  });
  return TEMPLATE_DB;
}

/** 把 URL 里的库名换成另一个（模板库、测试用的临时库）。连接串里没库名段直接报错。 */
function urlForDb(url: string, db: string): string {
  const u = new URL(url);
  if (!u.pathname || u.pathname === '/') {
    throw new Error(`FLEET_TEST_PG_URL 里没写库名：${url}（要 postgres://…/<库>）；测试要从它克隆出模板库`);
  }
  u.pathname = `/${db}`;
  return u.toString();
}

/** 真 Postgres 后端的 TestClient：每个测试文件一份独立库（CREATE DATABASE … TEMPLATE）。 */
class RealTestClient implements TestClient {
  private readonly sql: postgres.Sql;
  readonly dbName: string;
  /** 真 Postgres 没有 dataDir；指明这一点测试就不会拿它当 PGlite 的内存库。 */
  readonly dataDir = undefined;

  private constructor(sql: postgres.Sql, dbName: string) {
    this.sql = sql;
    this.dbName = dbName;
  }

  static async create(url: string): Promise<RealTestClient> {
    realTemplate ??= ensureTemplate(url);
    const template = await realTemplate;
    const dbName = `fleet_test_${randomUUID().replace(/-/g, '')}`;
    await withAdminClient(url, async (sql) => {
      // 并发克隆同一个模板是安全的；模板库此时没被任何连接占着（ensureTemplate 跑完就关了自己的连接）。
      await sql.unsafe(`create database ${dbName} template ${template}`);
    });
    const sql = postgres(urlForDb(url, dbName), { max: 5, onnotice: () => {} });
    const client = new RealTestClient(sql, dbName);
    try {
      await client.assertCleanClone();
    } catch (err) {
      // 克隆出来的库里就算一行数据，说明模板库（上游）被当成正式库写过：这份测试库不能发还，回收后如实报错。
      await sql.end({ timeout: 5 }).catch(() => {});
      await withAdminClient(url, async (admin) => {
        await admin.unsafe(`drop database if exists ${dbName} with (force)`);
      });
      throw err;
    }
    return client;
  }

  /** 真克隆库必须在 public schema 下一张业务表的任何行都没有——有行就是模板被写脏过。 */
  private async assertCleanClone(): Promise<void> {
    const tables = await this.sql<{ tablename: string }[]>`
      select tablename from pg_tables where schemaname = 'public'
    `;
    for (const { tablename } of tables) {
      const rows = await this.sql.unsafe(`select 1 as x from "${tablename.replaceAll('"', '""')}" limit 1`);
      if (rows.length > 0) {
        throw new Error(
          `ERR_DIRTY_TEMPLATE ${this.dbName}：克隆库的 ${tablename} 表里有 ${rows.length} 行——` +
            '模板库很可能被当成正式库写过。把它删掉重建（drop database fleet_test_template），下一次跑测试会重跑迁移。',
        );
      }
    }
  }

  async query<R = Record<string, unknown>>(sql: string, params: unknown[] = []): Promise<{ rows: R[] }> {
    const rows = (await this.sql.unsafe(sql, params as never[])) as unknown as R[];
    return { rows };
  }

  async exec(sql: string): Promise<void> {
    await this.sql.unsafe(sql);
  }

  async listen(channel: string, onNotify: (payload: string) => void): Promise<() => Promise<void>> {
    const sub = await this.sql.listen(channel, onNotify);
    return () => sub.unlisten();
  }

  async close(url: string): Promise<void> {
    await this.sql.end({ timeout: 5 });
    // 测试库是一份独立库，关掉就把它删了，不要堆着（一次 CI 几百个文件各起一份，堆着会占盘上 G）。
    await withAdminClient(url, async (sql) => {
      await sql.unsafe(`drop database if exists ${this.dbName} with (force)`);
    });
  }
}

/** 一份独立的真库（模板库的克隆）。 */
async function createRealTestDb(url: string): Promise<TestDb> {
  const client = await RealTestClient.create(url);
  const sqlUnsafe = postgres(urlForDb(url, client.dbName), { max: 5, onnotice: () => {} });
  const db = drizzlePostgres(sqlUnsafe, { schema }) as unknown as Db;
  return {
    db,
    client,
    close: async () => {
      await sqlUnsafe.end({ timeout: 5 });
      await client.close(url);
    },
  };
}

/** 一份独立的库（模板的克隆）：别的库里写什么它都看不见。 */
export async function createTestDb(): Promise<TestDb> {
  const url = realTestPgUrl();
  if (url) return createRealTestDb(url);
  return createPgliteTestDb();
}

/** 清空所有表（迁移记录在 drizzle 模式里，不动），自增序号从头来。比每个测试克隆一份快一个数量级。 */
export async function resetTestDb(t: TestDb): Promise<void> {
  const tables = await t.client.query<{ name: string }>(
    "select quote_ident(tablename) as name from pg_tables where schemaname = 'public'",
  );
  if (tables.rows.length === 0) throw new Error('测试库里一张表都没有：迁移没跑？');
  await t.client.exec(`truncate ${tables.rows.map((r) => r.name).join(', ')} restart identity cascade`);
}
