import { readFileSync } from 'node:fs';
import { describe, expect, it, vi } from 'vitest';
import { verifyMigrationBudget } from '../src/migration-budget.ts';
import {
  type MigrationBudgetData,
  migrationPaths,
  verifyMigrationData,
} from '../src/migration-budget-data.ts';

function fixture(): MigrationBudgetData {
  const read = (p: string) => readFileSync(new URL(`../migrations/${p}`, import.meta.url), 'utf8');
  const journal = JSON.parse(read('meta/_journal.json'));
  return {
    baseJournal: JSON.stringify({ ...journal, entries: journal.entries.slice(0, 94) }),
    headJournal: JSON.stringify({ ...journal, entries: journal.entries.slice(0, 95) }),
    baseSnapshot: read('meta/0093_snapshot.json'),
    headSnapshot: read('meta/0094_snapshot.json'),
    sql: read('0094_acceptance_duty_supersession.sql'),
    snapshotPath: 'packages/db/migrations/meta/0094_snapshot.json',
    sqlPath: 'packages/db/migrations/0094_acceptance_duty_supersession.sql',
  };
}
const record = (value: unknown): Record<string, unknown> => value as Record<string, unknown>;
const values = (value: unknown): unknown[] => Object.values(record(value));

describe('可信迁移数据核验', () => {
  it('真实已提交 PG7 快照独立生成 SQL，逐字节完全相等', async () => {
    await expect(verifyMigrationData(fixture())).resolves.toBeUndefined();
    await expect(verifyMigrationBudget(fixture())).resolves.toEqual({ verified: true });
  });
  it.each(['top', 'table', 'column', 'meta', 'indexColumn', 'identity', 'defaultObject'])(
    '未知 %s 不被库的strip静默丢掉',
    async (kind) => {
      const data = fixture(),
        snap = JSON.parse(data.headSnapshot);
      const first = record(values(snap.tables)[0]);
      if (kind === 'top') snap.unreviewed = 'payload';
      if (kind === 'table') first.unreviewed = 'payload';
      if (kind === 'column') record(values(first.columns)[0]).unreviewed = 'payload';
      if (kind === 'meta') snap._meta.unreviewed = 'payload';
      if (kind === 'indexColumn')
        record(
          (
            record(
              values(record(values(snap.tables).find((t) => values(record(t).indexes).length)).indexes)[0],
            ).columns as unknown[]
          )[0],
        ).unreviewed = 'payload';
      if (kind === 'identity')
        record(
          record(
            values(snap.tables)
              .flatMap((t) => values(record(t).columns))
              .find((c) => record(c).identity),
          ).identity,
        ).unreviewed = 'payload';
      if (kind === 'defaultObject') record(values(first.columns)[0]).default = { arbitrary: 'payload' };
      data.headSnapshot = JSON.stringify(snap);
      await expect(verifyMigrationData(data)).rejects.toThrow(/未知|未支持/);
    },
  );
  it.each(['id', '\\u0069d'])('重复键 %s（含转义）明确拒绝', async (key) => {
    const data = fixture();
    data.headSnapshot = data.headSnapshot.replace('{', `{"${key}":"a",`);
    await expect(verifyMigrationData(data)).rejects.toThrow('DUPLICATE_KEY');
  });
  it.each(['extra-entry', 'old-entry', 'wrong-tag', 'unknown-field', 'duplicate-key'])(
    'journal %s 不给予折扣',
    async (kind) => {
      const data = fixture(),
        journal = JSON.parse(data.headJournal);
      if (kind === 'extra-entry') journal.entries.push(journal.entries.at(-1));
      if (kind === 'old-entry') journal.entries[0].when += 1;
      if (kind === 'wrong-tag') journal.entries.at(-1).tag = '0093_wrong';
      if (kind === 'unknown-field') journal.unreviewed = true;
      data.headJournal = JSON.stringify(journal);
      if (kind === 'duplicate-key') data.headJournal = data.headJournal.replace('{', '{"version":"7",');
      await expect(verifyMigrationData(data)).rejects.toThrow();
    },
  );
  it('新增文件名必须来自 journal；prevId 断链、复用id、SQL多一句都拒绝', async () => {
    for (const kind of ['path', 'prevId', 'id', 'sql']) {
      const data = fixture(),
        snap = JSON.parse(data.headSnapshot);
      if (kind === 'path') data.sqlPath += '.other';
      if (kind === 'prevId') snap.prevId = '00000000-0000-0000-0000-000000000000';
      if (kind === 'id') snap.id = JSON.parse(data.baseSnapshot).id;
      if (kind === 'sql') data.sql += '\nSELECT 1;';
      data.headSnapshot = JSON.stringify(snap);
      await expect(verifyMigrationData(data)).rejects.toThrow();
    }
    expect(migrationPaths(fixture().baseJournal, fixture().headJournal).snapshotPath).toContain(
      '0094_snapshot',
    );
  });
  it('可信child不继承NODE_OPTIONS/NODE_PATH；超时/预取消如实失败', async () => {
    vi.stubEnv('NODE_OPTIONS', '--import=./candidate-loader-does-not-exist.mjs');
    vi.stubEnv('NODE_PATH', './candidate-node-modules');
    try {
      expect(await verifyMigrationBudget(fixture())).toEqual({ verified: true });
    } finally {
      vi.unstubAllEnvs();
    }
    expect(await verifyMigrationBudget(fixture(), { timeoutMs: 1 })).toMatchObject({
      verified: false,
      reason: expect.stringContaining('超时'),
    });
    expect(await verifyMigrationBudget(fixture(), { signal: AbortSignal.abort() })).toMatchObject({
      verified: false,
      reason: expect.stringContaining('取消'),
    });
  });
});
