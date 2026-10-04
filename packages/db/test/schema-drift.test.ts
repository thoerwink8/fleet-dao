// 改了表结构（src/schema）却没生成迁移：测试库和生产库都按迁移建，代码却按新表结构写，这里当场红。
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { generateDrizzleJson, generateMigration } from 'drizzle-kit/api';
import { describe, expect, it } from 'vitest';
import { MIGRATIONS_FOLDER } from '../src/migrate.ts';
import * as schema from '../src/schema/index.ts';

interface SnapshotInfo {
  id: string;
  prevId: string;
}

/**
 * journal 每一条都要有同号快照、快照的 prevId 接上前一条的 id。漏了快照（手写迁移时不会生成）：
 * 下次 drizzle-kit generate 会相对更早的快照做 diff，重复生成已经落库的改动（#0033 漏过一次）。
 */
function journalSnapshotProblems(
  idxs: readonly number[],
  snapshots: ReadonlyMap<number, SnapshotInfo>,
): string[] {
  const problems: string[] = [];
  let prev: SnapshotInfo | undefined;
  for (const idx of idxs) {
    const snap = snapshots.get(idx);
    if (!snap) {
      problems.push(`journal 有 idx ${idx}，缺 ${String(idx).padStart(4, '0')}_snapshot.json`);
      continue;
    }
    if (prev && snap.prevId !== prev.id) problems.push(`idx ${idx} 的 prevId 没接上 idx ${idx - 1} 的 id`);
    prev = snap;
  }
  return problems;
}

describe('journal 和快照对齐', () => {
  it('journal 每一条都有同号快照，prevId 链连续', () => {
    const metaDir = join(MIGRATIONS_FOLDER, 'meta');
    const journal = JSON.parse(readFileSync(join(metaDir, '_journal.json'), 'utf8')) as {
      entries: { idx: number }[];
    };
    const idxs = journal.entries.map((e) => e.idx).sort((a, b) => a - b);
    const snapshots = new Map<number, SnapshotInfo>();
    for (const f of readdirSync(metaDir).filter((n) => n.endsWith('_snapshot.json'))) {
      const s = JSON.parse(readFileSync(join(metaDir, f), 'utf8')) as SnapshotInfo;
      snapshots.set(Number(f.slice(0, 4)), s);
    }
    expect(journalSnapshotProblems(idxs, snapshots)).toEqual([]);
    expect(snapshots.size).toBe(idxs.length);
  });

  it('故意造出缺快照和断链：判得出来', () => {
    const snaps = new Map<number, SnapshotInfo>([
      [0, { id: 'a', prevId: '0' }],
      [1, { id: 'b', prevId: 'a' }],
      [3, { id: 'd', prevId: 'zzz' }],
    ]);
    const problems = journalSnapshotProblems([0, 1, 2, 3], snaps);
    expect(problems).toHaveLength(2);
    expect(problems[0]).toContain('缺 0002_snapshot.json');
    expect(problems[1]).toContain('idx 3 的 prevId');
  });
});

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
