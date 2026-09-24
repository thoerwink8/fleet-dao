// 改了表结构（src/schema）却没生成迁移：测试库和生产库都按迁移建，代码却按新表结构写，这里当场红。
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { generateDrizzleJson, generateMigration } from 'drizzle-kit/api';
import { describe, expect, it } from 'vitest';
import { MIGRATIONS_FOLDER } from '../src/migrate.ts';
import * as schema from '../src/schema/index.ts';

describe('表结构和迁移一致', () => {
  it('按当前表结构再生成一次迁移，应当一条语句都没有', async () => {
    const snapshots = readdirSync(join(MIGRATIONS_FOLDER, 'meta'))
      .filter((f) => f.endsWith('_snapshot.json'))
      .sort();
    expect(snapshots.length).toBeGreaterThan(0);
    const latest = JSON.parse(
      readFileSync(join(MIGRATIONS_FOLDER, 'meta', snapshots.at(-1) as string), 'utf8'),
    );
    const current = generateDrizzleJson({ ...schema });
    const pending = await generateMigration(latest, current);
    expect(
      pending,
      `表结构改了但没生成迁移：pnpm --filter @fleet-dao/db db:generate\n${pending.join('\n')}`,
    ).toEqual([]);
  });
});
