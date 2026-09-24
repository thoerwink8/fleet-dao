// 测试专用：PGlite（内存里的 Postgres）上跑真迁移。不连任何真库，不写任何目录。
// 生产代码不要 import 这里（PGlite 只是开发依赖）。
//
// 用法：每个测试文件一份库，每个测试前清空。
//   let t: TestDb;
//   beforeAll(async () => { t = await createTestDb(); }, TEST_DB_TIMEOUT_MS);
//   afterAll(() => t.close());
//   beforeEach(() => resetTestDb(t));
import { PGlite } from '@electric-sql/pglite';
import { drizzle } from 'drizzle-orm/pglite';
import { migrate } from 'drizzle-orm/pglite/migrator';
import type { Schema } from './client.ts';
import { MIGRATIONS_FOLDER } from './migrate.ts';
import * as schema from './schema/index.ts';

export interface TestDb {
  db: ReturnType<typeof drizzle<Schema, PGlite>>;
  /** PGlite 本身：LISTEN 等 drizzle 没包的功能用它。 */
  client: PGlite;
  close: () => Promise<void>;
}

/** 第一次建库要初始化 PGlite 并跑迁移，一两秒；测试文件并行、机器忙时更久。放 beforeAll 并给这个超时。 */
export const TEST_DB_TIMEOUT_MS = 60_000;

let template: Promise<PGlite> | undefined;

/** 每个进程只建一次库、跑一次迁移，之后克隆。 */
async function migratedTemplate(): Promise<PGlite> {
  template ??= (async () => {
    const pg = new PGlite();
    await migrate(drizzle(pg, { schema }), { migrationsFolder: MIGRATIONS_FOLDER });
    return pg;
  })();
  return template;
}

/** 一份独立的库（模板的克隆）：别的库里写什么它都看不见。 */
export async function createTestDb(): Promise<TestDb> {
  const base = await migratedTemplate();
  const client = (await base.clone()) as PGlite;
  if (client.dataDir !== undefined && !client.dataDir.startsWith('memory://')) {
    throw new Error(`测试库必须在内存里，现在是 ${client.dataDir}`);
  }
  const db = drizzle(client, { schema });
  return { db, client, close: () => client.close() };
}

/** 清空所有表（迁移记录在 drizzle 模式里，不动），自增序号从头来。比每个测试克隆一份快一个数量级。 */
export async function resetTestDb(t: TestDb): Promise<void> {
  const tables = await t.client.query<{ name: string }>(
    "select quote_ident(tablename) as name from pg_tables where schemaname = 'public'",
  );
  if (tables.rows.length === 0) throw new Error('测试库里一张表都没有：迁移没跑？');
  await t.client.exec(`truncate ${tables.rows.map((r) => r.name).join(', ')} restart identity cascade`);
}
