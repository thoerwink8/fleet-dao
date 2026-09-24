import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { generateMigration } from 'drizzle-kit/api';
import { eq, is } from 'drizzle-orm';
import { getTableConfig, PgTable } from 'drizzle-orm/pg-core';
import { afterAll, beforeAll, describe, expect, expectTypeOf, it } from 'vitest';
import { createDb, type Db } from '../src/client.ts';
import { MIGRATIONS_FOLDER } from '../src/migrate.ts';
import * as schema from '../src/schema/index.ts';
import { createTestDb, resetTestDb, TEST_DB_TIMEOUT_MS, type TestDb } from '../src/testing.ts';
import { addRepo, addTask } from './helpers.ts';

const schemaTables = Object.values(schema as Record<string, unknown>)
  .filter((v) => is(v, PgTable))
  .map((t) => getTableConfig(t as PgTable).name)
  .sort();

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
