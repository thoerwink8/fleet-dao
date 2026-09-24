import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { PGlite } from '@electric-sql/pglite';
import { generateMigration } from 'drizzle-kit/api';
import { eq, is } from 'drizzle-orm';
import { getTableConfig, isPgEnum, PgTable } from 'drizzle-orm/pg-core';
import { afterAll, beforeAll, describe, expect, expectTypeOf, it } from 'vitest';
import { createDb, type Db } from '../src/client.ts';
import { MIGRATIONS_FOLDER } from '../src/migrate.ts';
import * as schema from '../src/schema/index.ts';
import { createTestDb, resetTestDb, TEST_DB_TIMEOUT_MS, type TestDb } from '../src/testing.ts';
import { addRepo, addTask } from './helpers.ts';

const tableConfigs = Object.values(schema as Record<string, unknown>)
  .filter((v) => is(v, PgTable))
  .map((t) => getTableConfig(t as PgTable));
const schemaTables = tableConfigs.map((c) => c.name).sort();

interface JournalEntry {
  idx: number;
  when: number;
  tag: string;
}
const journal = JSON.parse(readFileSync(join(MIGRATIONS_FOLDER, 'meta', '_journal.json'), 'utf8')) as {
  entries: JournalEntry[];
};
const triggerSql = readFileSync(join(MIGRATIONS_FOLDER, '0001_triggers.sql'), 'utf8');

let t: TestDb;
beforeAll(async () => {
  t = await createTestDb();
}, TEST_DB_TIMEOUT_MS);
afterAll(() => t.close());

async function runEach(db: TestDb, statements: readonly string[]) {
  for (const s of statements) await db.client.exec(s);
}

describe('迁移', () => {
  it('迁移目录里的每一条都真跑了', async () => {
    const applied = await t.client.query<{ n: number }>(
      'select count(*)::int as n from drizzle.__drizzle_migrations',
    );
    expect(journal.entries.length).toBeGreaterThan(0);
    expect(applied.rows[0]?.n).toBe(journal.entries.length);
  });

  it('迁移日志的时间戳随序号严格递增，序号连续，和 SQL 文件一一对应', () => {
    // 迁移器只跑「比库里最后一条晚」的迁移，时间戳倒挂的那条会被静默跳过；并行分支各自生成迁移时最容易踩。
    const entries = [...journal.entries].sort((a, b) => a.idx - b.idx);
    expect(entries.map((e) => e.idx)).toEqual(entries.map((_, i) => i));
    for (const [i, e] of entries.entries()) {
      if (i > 0) expect(e.when).toBeGreaterThan(entries[i - 1]?.when ?? Number.POSITIVE_INFINITY);
    }
    const sqlFiles = readdirSync(MIGRATIONS_FOLDER)
      .filter((f) => f.endsWith('.sql'))
      .sort();
    expect(sqlFiles).toEqual(entries.map((e) => `${e.tag}.sql`));
  });

  it('触发器迁移单独再跑一遍不报错，也不会装出重复的触发器', async () => {
    const db = await createTestDb();
    try {
      const count = async () =>
        (
          await db.client.query<{ n: number }>(
            'select count(*)::int as n from pg_trigger where not tgisinternal',
          )
        ).rows[0]?.n;
      const before = await count();
      await db.client.exec(triggerSql);
      expect(await count()).toBe(before);
      // 状态变化仍然只记一行。
      const repo = await addRepo(db.db);
      const task = await addTask(db.db, repo.id);
      await db.db.update(schema.tasks).set({ state: 'running' }).where(eq(schema.tasks.id, task.id));
      const changes = await db.db.select().from(schema.stateChanges);
      expect(changes.map((c) => c.toState)).toEqual(['queued', 'running']);
    } finally {
      await db.close();
    }
  });

  it('删一个状态枚举值（drizzle-kit 生成的改列类型）不会被触发器挡住', async () => {
    const snapshots = readdirSync(join(MIGRATIONS_FOLDER, 'meta'))
      .filter((f) => f.endsWith('_snapshot.json'))
      .sort();
    const latest = JSON.parse(
      readFileSync(join(MIGRATIONS_FOLDER, 'meta', snapshots.at(-1) as string), 'utf8'),
    );
    const next = structuredClone(latest);
    next.enums['public.task_state'].values = next.enums['public.task_state'].values.filter(
      (v: string) => v !== 'stalled',
    );
    const statements = await generateMigration(latest, next);
    expect(statements[0]).toContain('SET DATA TYPE text');

    // 对照：触发器要是把 state 列绑住（UPDATE OF state / WHEN），同一批语句就过不去。
    const bound = await createTestDb();
    try {
      await bound.client.exec(
        "create trigger bound_to_state after update of state on tasks for each row execute function fleet_record_state_change('task')",
      );
      await expect(runEach(bound, statements)).rejects.toThrow(/trigger/);
    } finally {
      await bound.close();
    }

    const db = await createTestDb();
    try {
      const repo = await addRepo(db.db);
      const task = await addTask(db.db, repo.id);
      await runEach(db, statements);
      await db.db.update(schema.tasks).set({ state: 'running' }).where(eq(schema.tasks.id, task.id));
      const changes = await db.db.select().from(schema.stateChanges);
      expect(changes.map((c) => c.toState)).toEqual(['queued', 'running']);
    } finally {
      await db.close();
    }
  });

  it('表结构里的每张表迁移后都在库里，库里也没有多出来的表', async () => {
    const rows = await t.client.query<{ name: string }>(
      "select table_name as name from information_schema.tables where table_schema = 'public' order by 1",
    );
    // 先确认真的扫到了表，免得两边都是空列表也「相等」。
    expect(schemaTables.length).toBeGreaterThan(20);
    expect(rows.rows.map((r) => r.name)).toEqual(schemaTables);
  });

  // 快照一致性（schema-drift）只核「表结构 ↔ 快照」；迁移 SQL 手改过（如 0002 为了在有数据的库上跑通调了顺序）就核不到了。
  // 这里拿真跑完迁移的库逐项对照表结构。
  describe('跑完迁移的库和表结构逐项对得上', () => {
    const rowsOf = async <R>(text: string) => (await t.client.query<R>(text)).rows;
    /** Postgres 把超过 63 字节的名字截短。 */
    const pgName = (name: string) => name.slice(0, 63);

    it('每一列的类型和非空', async () => {
      const expected = tableConfigs.flatMap((cfg) => {
        // 组合主键的列 Postgres 自动设非空。
        const inPk = new Set(cfg.primaryKeys.flatMap((pk) => pk.columns.map((c) => c.name)));
        return cfg.columns.map(
          (c) =>
            `${cfg.name}.${c.name} ${c.getSQLType().replace(/,\s+/g, ',')}${c.notNull || inPk.has(c.name) ? ' not null' : ''}`,
        );
      });
      const actual = (
        await rowsOf<{ tbl: string; col: string; type: string; nn: boolean }>(
          `select c.relname as tbl, a.attname as col, format_type(a.atttypid, a.atttypmod) as type, a.attnotnull as nn
             from pg_attribute a join pg_class c on c.oid = a.attrelid join pg_namespace n on n.oid = c.relnamespace
            where n.nspname = 'public' and c.relkind = 'r' and a.attnum > 0 and not a.attisdropped`,
        )
      ).map((r) => `${r.tbl}.${r.col} ${r.type}${r.nn ? ' not null' : ''}`);
      expect(actual.length).toBeGreaterThan(100);
      expect(actual.sort()).toEqual(expected.sort());
    });

    it('主键、唯一、外键、检查约束，按名字一一对上', async () => {
      const expected = tableConfigs.flatMap((cfg) =>
        [
          ...cfg.columns.filter((c) => c.primary).map(() => `${cfg.name}_pkey`),
          ...cfg.primaryKeys.map((pk) => pk.getName()),
          ...cfg.columns.filter((c) => c.isUnique).map((c) => c.uniqueName ?? `${cfg.name}_${c.name}_unique`),
          ...cfg.uniqueConstraints.map(
            (u) => u.getName() ?? `${cfg.name}_${u.columns.map((c) => c.name).join('_')}_unique`,
          ),
          ...cfg.foreignKeys.map((fk) => fk.getName()),
          ...cfg.checks.map((ck) => ck.name),
        ].map((name) => `${cfg.name}: ${pgName(name)}`),
      );
      const actual = (
        await rowsOf<{ tbl: string; name: string }>(
          `select c.relname as tbl, k.conname as name
             from pg_constraint k join pg_class c on c.oid = k.conrelid join pg_namespace n on n.oid = c.relnamespace
            where n.nspname = 'public' and k.contype in ('p', 'u', 'f', 'c')`,
        )
      ).map((r) => `${r.tbl}: ${r.name}`);
      expect(actual.length).toBeGreaterThan(50);
      expect(actual.sort()).toEqual(expected.sort());
    });

    it('索引（约束自带的除外）按名字一一对上', async () => {
      const expected = tableConfigs.flatMap((cfg) =>
        cfg.indexes.map((i) => `${cfg.name}: ${pgName(i.config.name ?? '（没起名）')}`),
      );
      const actual = (
        await rowsOf<{ tbl: string; name: string }>(
          `select c.relname as tbl, i.relname as name
             from pg_index x join pg_class i on i.oid = x.indexrelid join pg_class c on c.oid = x.indrelid
             join pg_namespace n on n.oid = c.relnamespace
            where n.nspname = 'public'
              and not exists (select 1 from pg_constraint k where k.conindid = x.indexrelid and k.conrelid = x.indrelid)`,
        )
      ).map((r) => `${r.tbl}: ${r.name}`);
      expect(actual.length).toBeGreaterThan(5);
      expect(actual.sort()).toEqual(expected.sort());
    });

    it('枚举的值和顺序', async () => {
      const expected = Object.values(schema as Record<string, unknown>)
        .filter(isPgEnum)
        .map((e) => `${e.enumName}: ${e.enumValues.join(',')}`);
      const actual = (
        await rowsOf<{ name: string; vals: string }>(
          `select t.typname as name, string_agg(e.enumlabel, ',' order by e.enumsortorder) as vals
             from pg_type t join pg_enum e on e.enumtypid = t.oid join pg_namespace n on n.oid = t.typnamespace
            where n.nspname = 'public' group by t.typname`,
        )
      ).map((r) => `${r.name}: ${r.vals}`);
      expect(actual.length).toBeGreaterThan(5);
      expect(actual.sort()).toEqual(expected.sort());
    });
  });
});

describe('0002：额度窗改按上游原名存', () => {
  const entries = [...journal.entries].sort((a, b) => a.idx - b.idx);
  const target = entries.findIndex((e) => e.tag === '0002_quota_labels');

  async function runMigration(pg: PGlite, tag: string) {
    const text = readFileSync(join(MIGRATIONS_FOLDER, `${tag}.sql`), 'utf8');
    for (const statement of text.split('--> statement-breakpoint')) await pg.exec(statement);
  }

  it(
    '在已有旧数据的库上跑得通：旧行补上原名、单位、读法，主键换成（池, 原名）',
    async () => {
      expect(target).toBeGreaterThan(0);
      const pg = new PGlite();
      try {
        for (const e of entries.slice(0, target)) await runMigration(pg, e.tag);
        await pg.exec(`
        insert into channels (id, name, billing) values ('relay', '中转', 'subscription');
        insert into pools (id, channel_id, max_concurrency) values ('relay-a', 'relay', 2), ('relay-b', 'relay', 1);
        insert into quota_windows (pool_id, "window", scope, utilization, used, "limit", reading, read_at) values
          ('relay-a', '5h', '', null, 1140, 143528, 'measured', now()),
          ('relay-a', '7d', '', 0.4, null, null, 'measured', now()),
          ('relay-a', '7d_model', 'claude', null, 510000, 512600, 'measured', now()),
          ('relay-a', '7d_model', 'fable', 0.2, null, null, 'measured', now()),
          ('relay-b', 'month_usd', '', 0.55, 222, 400, 'estimated', now()),
          ('relay-b', 'period_usd', '', null, 3, 10, 'measured', now()),
          ('relay-b', 'points', '', null, 10, 100, 'measured', now());
      `);
        await runMigration(pg, '0002_quota_labels');

        const rows = await pg.query<{ row: string }>(
          `select concat_ws(' ', pool_id, label, "window", nullif(scope, ''), unit, source) as row
           from quota_windows order by pool_id, label collate "C"`,
        );
        expect(rows.rows.map((r) => r.row)).toEqual([
          'relay-a 5h 5h points legacy',
          'relay-a 7d 7d percent legacy',
          'relay-a 7d_claude 7d_model claude points legacy',
          'relay-a 7d_fable 7d_model fable percent legacy',
          'relay-b month_usd month_usd usd legacy',
          'relay-b period_usd period_usd usd legacy',
          'relay-b points points points legacy',
        ]);

        // 迁移后：other 窗口可以带组名；同一个池里原名不能重复（换个类型也不行），别的池可以同名。
        const insert = (pool: string, label: string, window: string, scope = '') =>
          pg.exec(
            `insert into quota_windows (pool_id, label, "window", scope, unit, reading, source, read_at)
           values ('${pool}', '${label}', '${window}', '${scope}', 'percent', 'measured', 'test', now())`,
          );
        await insert('relay-a', 'auto_percent', 'other', 'auto');
        await insert('relay-b', '5h', '5h');
        await expect(insert('relay-a', '5h', 'other')).rejects.toThrow(/quota_windows_pool_id_label_pk/);
      } finally {
        await pg.close();
      }
    },
    TEST_DB_TIMEOUT_MS,
  );
});

describe('测试库', () => {
  it('在内存里，两份测试库互相看不见对方的数据', async () => {
    const other = await createTestDb();
    try {
      expect(t.client.dataDir ?? 'memory://').toMatch(/^memory:\/\//);
      await t.db.insert(schema.families).values({ id: 'only-in-t', displayName: 'T', vendor: 'T' });
      expect(await other.db.select().from(schema.families)).toEqual([]);
    } finally {
      await other.close();
    }
  });

  it('清空后每张表都是空的，迁移记录还在', async () => {
    await t.db.insert(schema.families).values({ id: 'to-be-cleared', displayName: 'X', vendor: 'X' });
    await resetTestDb(t);
    const counts = await t.client.query<{ n: number }>(
      `select (${schemaTables.map((name) => `(select count(*) from "${name}")`).join(' + ')})::int as n`,
    );
    expect(counts.rows[0]?.n).toBe(0);
    const applied = await t.client.query<{ n: number }>(
      'select count(*)::int as n from drizzle.__drizzle_migrations',
    );
    expect(applied.rows[0]?.n).toBeGreaterThan(0);
  });
});

describe('createDb', () => {
  it('没有 DATABASE_URL 就报错，不回落到任何默认库', () => {
    expect(() => createDb({ env: {} })).toThrow(/DATABASE_URL/);
    expect(() => createDb({ env: { DATABASE_URL: '' } })).toThrow(/DATABASE_URL/);
  });

  it('从 env 读连接串，建好时还没连库', async () => {
    // 本机 9 号端口（discard）上没有 Postgres，真连就会失败；这里只建不查，证明创建本身不碰网络。
    const { db, close } = createDb({ env: { DATABASE_URL: 'postgres://nobody@localhost:9/none' } });
    expect(db).toBeDefined();
    await close();
  });

  it('生产连接和测试库都能直接传给查询函数（tsc 核对）', () => {
    expectTypeOf<ReturnType<typeof createDb>['db']>().toExtend<Db>();
    expectTypeOf<TestDb['db']>().toExtend<Db>();
  });
});
