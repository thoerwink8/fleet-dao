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
import { createHash, randomUUID } from 'node:crypto';
import { existsSync, readdirSync, readFileSync, renameSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
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

/**
 * 迁移跑完的 PGlite 数据目录快照放在系统临时目录里，跨测试文件（vitest 每个文件一个新进程）共用：
 * 没有它，每个用 PGlite 的测试文件都从头 initdb + 跑全部迁移（本机量：新进程冷建 2.3 秒，从快照载入 0.5 秒）。
 * 改这里之前必须知道：
 * - 文件名里带「迁移目录全部内容 + PGlite 版本」的哈希：迁移、PGlite 一变就是另一个文件，不会拿旧库顶新迁移；
 *   写的时候先写临时名再改名，别的进程读到的要么没有、要么是完整的一份；并发的几个进程同时建就各建各的、后改名的盖掉先改名的。
 * - 快照读不出来（半截、坏了）就删掉重建，不当成没事用；FLEET_TEST_PGLITE_SNAPSHOT=off 关掉快照，一律冷建（查迁移本身时用）。
 */
export function pgliteSnapshotKey(
  migrationsFolder: string = MIGRATIONS_FOLDER,
  pgliteVersion: string = installedPgliteVersion(),
): string {
  const hash = createHash('sha256').update(`pglite@${pgliteVersion}\n`);
  const walk = (dir: string): void => {
    for (const e of readdirSync(dir, { withFileTypes: true }).sort((a, b) => (a.name < b.name ? -1 : 1))) {
      const p = join(dir, e.name);
      if (e.isDirectory()) walk(p);
      else if (e.name.endsWith('.sql') || e.name === '_journal.json') {
        hash.update(`${e.name}\n`).update(readFileSync(p)).update('\n');
      }
    }
  };
  walk(migrationsFolder);
  return hash.digest('hex').slice(0, 16);
}

function installedPgliteVersion(): string {
  // 包的 exports 没开 ./package.json：从入口文件往上找到那一份
  let dir = dirname(createRequire(import.meta.url).resolve('@electric-sql/pglite'));
  for (;;) {
    const file = join(dir, 'package.json');
    if (existsSync(file)) {
      const pkg = JSON.parse(readFileSync(file, 'utf8')) as { name?: string; version?: string };
      if (pkg.name === '@electric-sql/pglite') {
        if (!pkg.version) throw new Error('@electric-sql/pglite 的 package.json 里没有版本');
        return pkg.version;
      }
    }
    const up = dirname(dir);
    if (up === dir) throw new Error('找不到 @electric-sql/pglite 的 package.json，快照认不出是哪一版建的');
    dir = up;
  }
}

const SNAPSHOT_PREFIX = 'fleet-pglite-';

export async function coldMigratedPglite(): Promise<PGlite> {
  const pg = new PGlite();
  await migratePglite(drizzlePglite(pg, { schema }), { migrationsFolder: MIGRATIONS_FOLDER });
  return pg;
}

/** 载入快照；没有这份快照返回 undefined，有但读不出来（半截、坏了）先删掉再返回 undefined。 */
export async function loadPgliteSnapshot(file: string): Promise<PGlite | undefined> {
  if (!existsSync(file)) return undefined;
  let pg: PGlite | undefined;
  try {
    pg = new PGlite({ loadDataDir: new Blob([readFileSync(file)]) });
    await pg.waitReady;
    // 认一下确实是迁移跑完的库：迁移记录条数要等于日志里的条数
    const journal = JSON.parse(readFileSync(join(MIGRATIONS_FOLDER, 'meta', '_journal.json'), 'utf8')) as {
      entries: unknown[];
    };
    const applied = await pg.query<{ n: number }>(
      'select count(*)::int as n from drizzle.__drizzle_migrations',
    );
    if (applied.rows[0]?.n !== journal.entries.length) throw new Error('快照里的迁移记录条数和日志对不上');
    return pg;
  } catch {
    await pg?.close().catch(() => {});
    rmSync(file, { force: true });
    return undefined;
  }
}

export async function savePgliteSnapshot(pg: PGlite, file: string): Promise<void> {
  const blob = await pg.dumpDataDir('none');
  const tmp = `${file}.${process.pid}.${randomUUID().slice(0, 8)}.tmp`;
  writeFileSync(tmp, Buffer.from(await blob.arrayBuffer()));
  renameSync(tmp, file);
  // 别的迁移版本留下的旧快照（每份 40 多 MB）超过一天的顺手清掉（一天内的可能是别的检出正在用，不动）；清不掉不影响这一次
  for (const name of readdirSync(tmpdir())) {
    const old = join(tmpdir(), name);
    if (!name.startsWith(SNAPSHOT_PREFIX) || old === file) continue;
    try {
      if (Date.now() - statSync(old).mtimeMs > 24 * 3_600_000) rmSync(old, { force: true });
    } catch {
      // 被别的进程占着或刚被删：下次再清
    }
  }
}

/** 每个进程只建一次（优先从快照载入，没有就冷建并存快照），之后克隆。 */
async function migratedPgliteTemplate(): Promise<PGlite> {
  pgliteTemplate ??= (async () => {
    if (process.env.FLEET_TEST_PGLITE_SNAPSHOT === 'off') return coldMigratedPglite();
    const file = join(tmpdir(), `${SNAPSHOT_PREFIX}${pgliteSnapshotKey()}.tar`);
    const loaded = await loadPgliteSnapshot(file);
    if (loaded) return loaded;
    const pg = await coldMigratedPglite();
    try {
      await savePgliteSnapshot(pg, file);
    } catch (err) {
      // 存不了（盘满、临时目录只读）不挡测试：这个进程照样拿冷建的用，只是下一个文件还得冷建
      process.stderr.write(
        `PGlite 快照没存成（${err instanceof Error ? err.message : String(err)}），照冷建用\n`,
      );
    }
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

/** 模板库名：固定一个，连真库时并发的多个进程共用。
 *  要独占模板的测试（比如「故意写脏模板验证 createTestDb 拒绝」）走 createTestDbFromTemplate + ensureTemplateDb，
 *  用 dirty_template_<UUID> 这类自己的名，不动这个。 */
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
    throw new Error(`FLEET_TEST_PG_URL 里没写库名（要 postgres://…/<库>）；测试要从它克隆出模板库`);
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

  /**
   * 建一份从模板克隆的测试库。
   * @param url 真 Postgres 的连接串（指向 admin 库）
   * @param templateName 可选：模板库名。不传走 ensureTemplate + 进程级缓存（默认共享模板）；
   *                     传了直接用这个名字（调用方得先建好，见 ensureTemplateDb），用于「要独占模板」的测试。
   */
  static async create(url: string, templateName?: string): Promise<RealTestClient> {
    let template: string;
    if (templateName !== undefined) {
      template = templateName;
    } else {
      realTemplate ??= ensureTemplate(url);
      template = await realTemplate;
    }
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

/**
 * 测试专用：直接指定一个模板库名克隆。给「故意把模板写脏、验证 createTestDb 拒绝」这类用例：
 * 它需要一个独占的模板（不污染共享那个），又不想动 realTemplate 的进程级缓存影响别的用例。
 * 只在真 Postgres 后端下用；url 为空就抛错（不要让本机 PGlite 调用方误用）。
 *
 * 调用方负责：
 * - 先 ensureTemplateDb(url, templateName) 把模板建好；
 * - 给一个独占的模板名（比如 `dirty_template_<UUID>`），别用共享那个；
 * - 跑完之后自己 dropDatabaseForce(url, templateName) 把模板收掉（这个函数不会替它清）。
 */
export async function createTestDbFromTemplate(url: string, templateName: string): Promise<TestDb> {
  const client = await RealTestClient.create(url, templateName);
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

/**
 * 测试专用：在指定 url 上建一份新模板（建库 + 跑迁移），返回模板名。
 * 给「我要造一个独立模板」配合 createTestDbFromTemplate 使用。
 */
export async function ensureTemplateDb(url: string, templateName: string): Promise<string> {
  await withAdminClient(url, async (sql) => {
    const exists = await sql<{ n: number }[]>`
      select count(*)::int as n from pg_database where datname = ${templateName}
    `;
    if ((exists[0]?.n ?? 0) === 0) {
      await sql.unsafe(`create database ${templateName}`);
    }
  });
  const tpl = postgres(urlForDb(url, templateName), { max: 1, onnotice: () => {} });
  try {
    await migratePostgres(drizzlePostgres(tpl, { schema }), { migrationsFolder: MIGRATIONS_FOLDER });
  } finally {
    await tpl.end({ timeout: 5 });
  }
  return templateName;
}

/** 测试专用：drop 一个数据库（WITH FORCE），不存在就当成功。给 ensureTemplateDb 的清理侧。 */
export async function dropDatabaseForce(url: string, dbName: string): Promise<void> {
  await withAdminClient(url, async (sql) => {
    await sql.unsafe(`drop database if exists ${dbName} with (force)`);
  });
}

/**
 * 清空所有表（迁移记录在 drizzle 模式里，不动），自增序号从头来。比每个测试克隆一份快一个数量级。
 * 只 truncate 有行的表、序号一律拨回起点：真 Postgres 上 truncate 每张表都要换新文件、落盘，四十多张表一起清
 * 一次要几百毫秒（CI 的 db 分片每条测试都付这一笔），而一条测试通常只写了几张表。清完的样子和全表 truncate 一样：
 * 每张表都空，每个序号（失败的插入也会推进序号，表空着不代表序号没动）都回到起点。
 */
export async function resetTestDb(t: TestDb): Promise<void> {
  const tables = await t.client.query<{ name: string }>(
    "select quote_ident(tablename) as name from pg_tables where schemaname = 'public'",
  );
  if (tables.rows.length === 0) throw new Error('测试库里一张表都没有：迁移没跑？');
  const filled = await t.client.query<{ name: string }>(
    tables.rows
      .map((r) => `select ${quoteLiteral(r.name)} as name where exists (select 1 from ${r.name})`)
      .join(' union all '),
  );
  if (filled.rows.length > 0) {
    await t.client.exec(`truncate ${filled.rows.map((r) => r.name).join(', ')} cascade`);
  }
  await t.client.query(
    "select setval(format('%I.%I', schemaname, sequencename), start_value, false) from pg_sequences where schemaname = 'public'",
  );
}

function quoteLiteral(s: string): string {
  return `'${s.replaceAll("'", "''")}'`;
}
