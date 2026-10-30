// 测试专用：PGlite（内存 Postgres）上跑 fleet2 的真迁移。生产代码不要 import 这里。
import { PGlite } from '@electric-sql/pglite';
import { drizzle } from 'drizzle-orm/pglite';
import { migrate } from 'drizzle-orm/pglite/migrator';
import { MIGRATION_OPTIONS } from './index.ts';
import * as schema from './schema.ts';
import type { Db } from './store.ts';

export interface TestDb {
  db: Db;
  pg: PGlite;
  close(): Promise<void>;
}

export async function createTestDb(): Promise<TestDb> {
  const pg = new PGlite();
  const db = drizzle(pg, { schema });
  await migrate(db, MIGRATION_OPTIONS);
  return { db: db as unknown as Db, pg, close: () => pg.close() };
}
