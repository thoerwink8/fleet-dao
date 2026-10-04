// PGlite 迁移快照（src/testing.ts）：key 认迁移内容和 PGlite 版本；存了能原样载回；坏的、半截的、不是迁移跑完的快照读不出来
// 就删掉重建，不当成好的用。本文件不碰 createTestDb 的共享快照（用自己的临时文件）。
import { cpSync, existsSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { PGlite } from '@electric-sql/pglite';
import { afterAll, describe, expect, it } from 'vitest';
import { MIGRATIONS_FOLDER } from '../src/migrate.ts';
import {
  coldMigratedPglite,
  loadPgliteSnapshot,
  pgliteSnapshotKey,
  savePgliteSnapshot,
} from '../src/testing.ts';

const dirs: string[] = [];
const tmp = (): string => {
  const d = mkdtempSync(join(tmpdir(), 'pglite-snap-test-'));
  dirs.push(d);
  return d;
};
afterAll(() => {
  for (const d of dirs) rmSync(d, { recursive: true, force: true });
});

describe('快照 key', () => {
  it('默认参数（真迁移目录、装着的 PGlite 版本）算得出 key', () => {
    expect(pgliteSnapshotKey()).toMatch(/^[0-9a-f]{16}$/);
  });

  it('同样的迁移、同一版 PGlite：key 不变；PGlite 换版本 key 就变', () => {
    expect(pgliteSnapshotKey(MIGRATIONS_FOLDER, '1.0.0')).toBe(pgliteSnapshotKey(MIGRATIONS_FOLDER, '1.0.0'));
    expect(pgliteSnapshotKey(MIGRATIONS_FOLDER, '1.0.0')).not.toBe(
      pgliteSnapshotKey(MIGRATIONS_FOLDER, '1.0.1'),
    );
  });

  it('迁移 SQL 改一个字、多一条迁移，key 都变（不拿旧库顶新迁移）', () => {
    const copy = join(tmp(), 'migrations');
    cpSync(MIGRATIONS_FOLDER, copy, { recursive: true });
    const before = pgliteSnapshotKey(copy, '1.0.0');
    writeFileSync(join(copy, '9999_extra.sql'), 'select 1;\n');
    const added = pgliteSnapshotKey(copy, '1.0.0');
    expect(added).not.toBe(before);
    writeFileSync(join(copy, '9999_extra.sql'), 'select 2;\n');
    expect(pgliteSnapshotKey(copy, '1.0.0')).not.toBe(added);
  });

  it('迁移目录读不了：抛错，不给一个空目录的 key', () => {
    expect(() => pgliteSnapshotKey(join(tmp(), '不存在的目录'), '1.0.0')).toThrow();
  });
});

describe('快照存取', { timeout: 120_000 }, () => {
  it('存下来再载回：迁移跑完的库原样回来（表数、迁移记录条数一样），能写能读', async () => {
    const file = join(tmp(), 'a.tar');
    const cold = await coldMigratedPglite();
    await savePgliteSnapshot(cold, file);
    const loaded = await loadPgliteSnapshot(file);
    expect(loaded).toBeDefined();
    const count = (pg: PGlite) =>
      pg.query<{ tables: number; applied: number }>(
        `select (select count(*)::int from pg_tables where schemaname = 'public') as tables,
                (select count(*)::int from drizzle.__drizzle_migrations) as applied`,
      );
    expect((await count(loaded as PGlite)).rows).toEqual((await count(cold)).rows);
    await (loaded as PGlite).query('select 1');
    await cold.close();
    await loaded?.close();
  });

  it('【故意造出的失败】快照文件是一串垃圾：读不出来，返回 undefined 并把坏文件删掉', async () => {
    const file = join(tmp(), 'bad.tar');
    writeFileSync(file, 'not a pglite data dir');
    expect(await loadPgliteSnapshot(file)).toBeUndefined();
    expect(existsSync(file)).toBe(false);
  });

  it('【故意造出的失败】快照是个没跑过迁移的库：认出来、不当成迁移跑完的用，删掉', async () => {
    const file = join(tmp(), 'empty.tar');
    const bare = new PGlite();
    await bare.waitReady;
    await savePgliteSnapshot(bare, file);
    await bare.close();
    expect(await loadPgliteSnapshot(file)).toBeUndefined();
    expect(existsSync(file)).toBe(false);
  });

  it('没有这份快照：返回 undefined', async () => {
    expect(await loadPgliteSnapshot(join(tmp(), '没有.tar'))).toBeUndefined();
  });
});
