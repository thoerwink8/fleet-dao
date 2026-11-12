import { fileURLToPath } from 'node:url';

export * from './ade.ts';
export * from './real.ts';
export * from './scheduler.ts';
export * from './schema.ts';
export * from './shadow.ts';
export * from './store.ts';

/** 从某个模块的位置找它上一级的 migrations 目录；按文件 URL 解码（空格、中文、8.3 短名的 ~ 在 URL 里都被转义）。 */
export function migrationsFolderOf(moduleUrl: string | URL): string {
  return fileURLToPath(new URL('../migrations', moduleUrl));
}

/** 迁移目录（发布时由部署脚本对 fleet2 跑；记账表在 fleet2.__migrations，不和旧库的混）。 */
export const MIGRATIONS_FOLDER = migrationsFolderOf(import.meta.url);

/** 生产（bin/migrate.ts）和测试（testing.ts）跑同一份迁移、同一个记账表。 */
export const MIGRATION_OPTIONS = {
  migrationsFolder: MIGRATIONS_FOLDER,
  migrationsSchema: 'fleet2',
  migrationsTable: '__migrations',
} as const;
