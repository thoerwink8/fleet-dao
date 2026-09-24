// 迁移：SQL 文件在 packages/db/migrations（drizzle-kit 生成 + 手写的触发器），生产和测试跑的是同一批。
import { fileURLToPath } from 'node:url';
import type { PostgresJsDatabase } from 'drizzle-orm/postgres-js';
import { migrate } from 'drizzle-orm/postgres-js/migrator';
import type { Schema } from './client.ts';

export const MIGRATIONS_FOLDER = fileURLToPath(new URL('../migrations', import.meta.url));

export async function runMigrations(db: PostgresJsDatabase<Schema>): Promise<void> {
  await migrate(db, { migrationsFolder: MIGRATIONS_FOLDER });
}
