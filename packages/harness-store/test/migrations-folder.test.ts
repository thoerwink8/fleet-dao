// 迁移目录的解析（#3889）：内核装到带空格、中文的路径时 URL 里是 %20、%E5…，必须解码成真路径再交给迁移器。
import { cpSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { PGlite } from '@electric-sql/pglite';
import { drizzle } from 'drizzle-orm/pglite';
import { migrate } from 'drizzle-orm/pglite/migrator';
import { afterAll, describe, expect, it } from 'vitest';
import { MIGRATION_OPTIONS, MIGRATIONS_FOLDER, migrationsFolderOf } from '../src/index.ts';

const root = mkdtempSync(join(tmpdir(), 'fleet2-迁移 目录-'));
afterAll(() => rmSync(root, { recursive: true, force: true }));

describe('migrationsFolderOf', () => {
  it('带空格和中文的安装目录解码成真路径，真起 PGlite 跑得动迁移', async () => {
    const install = join(root, '内核 安装', 'app');
    cpSync(MIGRATIONS_FOLDER, join(install, 'migrations'), { recursive: true });
    const moduleUrl = pathToFileURL(join(install, 'kernel', 'index.mjs')).href;
    expect(moduleUrl).toMatch(/%20|%E5/); // 前提：URL 里确实被转义了
    const folder = migrationsFolderOf(moduleUrl);
    expect(folder).toBe(join(install, 'migrations'));
    const pg = new PGlite();
    try {
      await migrate(drizzle(pg), { ...MIGRATION_OPTIONS, migrationsFolder: folder });
      const r = await pg.query<{ n: number }>('select count(*)::int as n from fleet2.__migrations');
      expect(r.rows[0]?.n).toBeGreaterThan(0);
    } finally {
      await pg.close();
    }
  }, 60_000);

  it('仓内默认目录没有残留的 URL 转义', () => {
    expect(MIGRATIONS_FOLDER.endsWith(join('harness-store', 'migrations'))).toBe(true);
    expect(MIGRATIONS_FOLDER).not.toMatch(/%[0-9A-F]{2}/);
  });
});
