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

const ordered = [...journal.entries].sort((a, b) => a.idx - b.idx);

/** 原样跑一条迁移文件（按 drizzle 的分句标记切开逐句跑），不记迁移日志：「在旧库上升级」的用例要停在某一条之前插旧数据。 */
async function runMigration(pg: PGlite, tag: string) {
  const text = readFileSync(join(MIGRATIONS_FOLDER, `${tag}.sql`), 'utf8');
  for (const statement of text.split('--> statement-breakpoint')) await pg.exec(statement);
}

/**
 * 跑到第 target 条之前（不含它）的一份独占 PGlite。几条「在旧库上升级」的用例原来各起一份 PGlite、各自从第 0 条跑起
 * （一条一秒多）；现在共用一份底库按序号往前走，走到要的那一条之前 clone 一份交出去，交出去的和从头跑的是同一个库。
 * 要的比底库已经走到的还早（单跑某一条、用例换了顺序），底库从头再建一份，不拿跑过头的库凑。
 */
let base: { pg: PGlite; next: number } | undefined;
async function migratedBefore(target: number): Promise<PGlite> {
  if (!base || base.next > target) {
    await base?.pg.close();
    base = { pg: new PGlite(), next: 0 };
  }
  for (; base.next < target; base.next += 1) await runMigration(base.pg, ordered[base.next]?.tag ?? '');
  return (await base.pg.clone()) as PGlite;
}
afterAll(() => base?.pg.close());

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

  it(
    '触发器迁移单独再跑一遍不报错，也不会装出重复的触发器',
    async () => {
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
    },
    TEST_DB_TIMEOUT_MS,
  );

  it(
    '删一个状态枚举值（drizzle-kit 生成的改列类型）不会被触发器挡住',
    async () => {
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
    },
    TEST_DB_TIMEOUT_MS,
  );

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
  const target = ordered.findIndex((e) => e.tag === '0002_quota_labels');

  it(
    '在已有旧数据的库上跑得通：旧行补上原名、单位、读法，池补上最近读成时刻，主键换成（池, 原名）',
    async () => {
      expect(target).toBeGreaterThan(0);
      const pg = await migratedBefore(target);
      try {
        await pg.exec(`
        insert into channels (id, name, billing) values ('relay', '中转', 'subscription');
        insert into pools (id, channel_id, max_concurrency) values
          ('relay-a', 'relay', 2), ('relay-b', 'relay', 1), ('relay-c', 'relay', 1);
        insert into quota_windows (pool_id, "window", scope, utilization, used, "limit", reading, read_at) values
          ('relay-a', '5h', '', null, 1140, 143528, 'measured', '2026-09-20T10:00:00Z'),
          ('relay-a', '7d', '', 0.4, null, null, 'measured', '2026-09-20T11:00:00Z'),
          ('relay-a', '7d_model', 'claude', null, 510000, 512600, 'measured', '2026-09-20T10:00:00Z'),
          ('relay-a', '7d_model', 'fable', 0.2, null, null, 'measured', '2026-09-20T10:00:00Z'),
          ('relay-b', 'month_usd', '', 0.55, 222, 400, 'estimated', '2026-09-19T08:00:00Z'),
          ('relay-b', 'period_usd', '', null, 3, 10, 'measured', '2026-09-19T08:00:00Z'),
          ('relay-b', 'points', '', null, 10, 100, 'measured', '2026-09-19T08:00:00Z');
      `);
        await runMigration(pg, '0002_quota_labels');

        const rows = await pg.query<{ row: string }>(
          `select concat_ws(' ', pool_id, label, "window", nullif(scope, ''), unit, source, stale_since) as row
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
        // 池的最近读成时刻取它窗口里最新的读数时刻；没有窗口的池留空（从没读成过）。
        const poolRows = await pg.query<{ id: string; at: string | null }>(
          `select id, to_char(last_read_ok_at at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI') as at from pools order by id`,
        );
        expect(poolRows.rows.map((r) => [r.id, r.at])).toEqual([
          ['relay-a', '2026-09-20T11:00'],
          ['relay-b', '2026-09-19T08:00'],
          ['relay-c', null],
        ]);

        // 补值的两条 UPDATE 再单独跑一遍（不在事务里逐条重跑）：已有的原名、单位不被改写，读成时刻不倒退。
        const backfills = readFileSync(join(MIGRATIONS_FOLDER, '0002_quota_labels.sql'), 'utf8')
          .split('--> statement-breakpoint')
          .filter((s) => /^UPDATE /m.test(s));
        expect(backfills).toHaveLength(2);
        await pg.exec(`
          update quota_windows set unit = 'tokens' where pool_id = 'relay-a' and label = '5h';
          update pools set last_read_ok_at = '2026-09-21T09:00:00Z' where id = 'relay-a';
        `);
        for (const statement of backfills) await pg.exec(statement);
        const after = await pg.query<{ unit: string; at: string }>(
          `select w.unit, to_char(p.last_read_ok_at at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI') as at
             from quota_windows w join pools p on p.id = w.pool_id
            where w.pool_id = 'relay-a' and w.label = '5h'`,
        );
        expect(after.rows).toEqual([{ unit: 'tokens', at: '2026-09-21T09:00' }]);

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

describe('0003：目录装载器要的三列', () => {
  const target = ordered.findIndex((e) => e.tag === '0003_catalog');

  it(
    '已有的阶段顺序回填成开着，之后不再有默认值；会话用户按列名读得回来、只许两个值',
    async () => {
      expect(target).toBeGreaterThan(0);
      const pg = await migratedBefore(target);
      try {
        await pg.exec(`
        insert into families (id, display_name, vendor) values ('claude', 'Claude', 'Anthropic');
        insert into channels (id, name, billing) values ('sub', '订阅', 'subscription');
        insert into pools (id, channel_id, max_concurrency) values ('solo', 'sub', 1);
        insert into models (id, family, display_name) values ('opus', 'claude', 'Opus');
        insert into routes (id, channel_id, pool_id, model_id, host_id) values ('r1', 'sub', 'solo', 'opus', 'claude-code');
        insert into stage_policies (stage) values ('execute');
        insert into stage_policy_routes (stage, route_id, position) values ('execute', 'r1', 0);
      `);
        await runMigration(pg, '0003_catalog');

        expect((await pg.query(`select route_id, enabled from stage_policy_routes`)).rows).toEqual([
          { route_id: 'r1', enabled: true },
        ]);
        // 没有默认值：重写顺序时漏带开关就插不进去，不会悄悄全打开。
        await pg.exec(`delete from stage_policy_routes`);
        await expect(
          pg.exec(`insert into stage_policy_routes (stage, route_id, position) values ('execute', 'r1', 0)`),
        ).rejects.toThrow(/enabled/);

        await pg.exec(`update pools set run_as_user = 'fleet-agent-carpool' where id = 'solo'`);
        expect((await pg.query(`select run_as_user from pools`)).rows).toEqual([
          { run_as_user: 'fleet-agent-carpool' },
        ]);
        await expect(pg.exec(`update pools set run_as_user = 'root'`)).rejects.toThrow(
          /pools_run_as_user_known/,
        );
      } finally {
        await pg.close();
      }
    },
    TEST_DB_TIMEOUT_MS,
  );
});

describe('0005：接活入口（GitHub 事件原文、自动派活开关）', () => {
  const target = ordered.findIndex((e) => e.tag === '0005_github_intake');

  it(
    '已有的仓一律是关着的（不会一升级就开始自动派活）；事件表不收没原因的「不收」「出错」、处理中不许有收尾时刻',
    async () => {
      expect(target).toBeGreaterThan(0);
      const pg = await migratedBefore(target);
      try {
        await pg.exec(
          `insert into repos (owner, name, test_command) values ('acme', 'widgets', 'pnpm check')`,
        );
        // github_events 是这一条建的表，装之前不存在；升级时的仓和别的行都留着
        await runMigration(pg, '0005_github_intake');

        expect((await pg.query(`select auto_dispatch_since from repos`)).rows).toEqual([
          { auto_dispatch_since: null },
        ]);
        const insert = (id: string, status: string, reason: string | null, finished: boolean) =>
          pg.query(
            `insert into github_events (delivery_id, event, source, payload, status, reason, finished_at)
             values ($1, 'issues', 'webhook', '{}'::jsonb, $2, $3, ${finished ? 'now()' : 'null'})`,
            [id, status, reason],
          );
        await insert('ok-processing', 'processing', null, false);
        await insert('ok-accepted', 'accepted', null, true);
        await insert('ok-failed', 'failed', '库连不上', true);
        await expect(insert('no-reason', 'failed', null, true)).rejects.toThrow(
          /github_events_reason_when_not_taken/,
        );
        await expect(insert('empty-reason', 'ignored', '', true)).rejects.toThrow(
          /github_events_reason_when_not_taken/,
        );
        await expect(insert('processing-done', 'processing', null, true)).rejects.toThrow(
          /github_events_finished_iff_done/,
        );
        await expect(insert('accepted-open', 'accepted', null, false)).rejects.toThrow(
          /github_events_finished_iff_done/,
        );
        await expect(insert('odd-status', 'lost', 'x', true)).rejects.toThrow(/github_events_status_known/);
        // 等着（重开时上一轮还没结束）：也得写在等什么、也得有收尾时刻
        await insert('ok-waiting', 'waiting', '上一轮还没结束', true);
        await expect(insert('waiting-no-reason', 'waiting', null, true)).rejects.toThrow(
          /github_events_reason_when_not_taken/,
        );
        await expect(insert('waiting-open', 'waiting', '上一轮还没结束', false)).rejects.toThrow(
          /github_events_finished_iff_done/,
        );

        // 每次投递带着的对象版本：一次投递里一个对象只记一版；开关状态只认 open/closed；投递删了版本跟着删
        const version = (id: string, object: string, state: string | null) =>
          pg.query(
            `insert into github_event_versions (delivery_id, object, version, state) values ($1, $2, now(), $3)`,
            [id, object, state],
          );
        await version('ok-accepted', 'acme/widgets:issue:1', 'open');
        await version('ok-accepted', 'acme/widgets:comment:9', null);
        await expect(version('ok-accepted', 'acme/widgets:issue:1', 'closed')).rejects.toThrow(
          /github_event_versions_delivery_id_object_pk/,
        );
        await expect(version('ok-failed', 'acme/widgets:pull:2', 'merged')).rejects.toThrow(
          /github_event_versions_state_known/,
        );
        await expect(version('never-delivered', 'acme/widgets:issue:3', 'open')).rejects.toThrow(
          /github_event_versions_delivery_id_github_events_delivery_id_fk/,
        );
        await pg.exec(`delete from github_events where delivery_id = 'ok-accepted'`);
        expect((await pg.query(`select count(*)::int as n from github_event_versions`)).rows).toEqual([
          { n: 0 },
        ]);
      } finally {
        await pg.close();
      }
    },
    TEST_DB_TIMEOUT_MS,
  );
});

describe('0007：法国只留一个会话用户（创始人 2026-09-26）', () => {
  const target = ordered.findIndex((e) => e.tag === '0007_one_session_user');

  it(
    '挂在停用用户下的池改到唯一的会话用户、按原来的用户记下组织类型；历史会话行照留；之后池只收这一个用户',
    async () => {
      expect(target).toBeGreaterThan(0);
      const pg = await migratedBefore(target);
      try {
        await pg.exec(`
        insert into families (id, display_name, vendor) values ('claude', 'Claude', 'Anthropic');
        insert into channels (id, name, billing) values ('sub', '订阅', 'subscription');
        insert into pools (id, channel_id, max_concurrency, run_as_user) values
          ('solo', 'sub', 4, 'fleet-agent-dedicated'),
          ('car', 'sub', 2, 'fleet-agent-carpool'),
          ('relay', 'sub', 5, null);
        insert into models (id, family, display_name) values ('opus', 'claude', 'Opus');
        insert into routes (id, channel_id, pool_id, model_id, host_id) values ('r1', 'sub', 'solo', 'opus', 'claude-code');
        insert into session_runs (stage, route_id, why_route, run_as_user) values ('execute', 'r1', '测试', 'fleet-agent-dedicated');
      `);
        await runMigration(pg, '0007_one_session_user');

        expect((await pg.query(`select id, run_as_user, org_kind from pools order by id`)).rows).toEqual([
          { id: 'car', run_as_user: 'fleet-agent-carpool', org_kind: 'carpool' },
          { id: 'relay', run_as_user: null, org_kind: null },
          { id: 'solo', run_as_user: 'fleet-agent-carpool', org_kind: 'solo' },
        ]);
        // 历史会话行不改写：那一轮确实跑在旧用户下
        expect((await pg.query(`select run_as_user from session_runs`)).rows).toEqual([
          { run_as_user: 'fleet-agent-dedicated' },
        ]);
        await expect(
          pg.exec(`update pools set run_as_user = 'fleet-agent-dedicated' where id = 'solo'`),
        ).rejects.toThrow(/pools_run_as_user_known/);
        await expect(pg.exec(`update pools set org_kind = 'team' where id = 'solo'`)).rejects.toThrow(
          /pools_org_kind_known/,
        );
        // 跑会话的池必须写明组织类型：漏了选路判不了会话用户挂没挂着它
        await expect(pg.exec(`update pools set org_kind = null where id = 'solo'`)).rejects.toThrow(
          /pools_session_pool_org_kind_together/,
        );
        // 反过来：不跑会话的池不许写组织类型（会被选路当成 Claude 组织池错挡、错放）
        await expect(pg.exec(`update pools set org_kind = 'solo' where id = 'relay'`)).rejects.toThrow(
          /pools_session_pool_org_kind_together/,
        );
        await expect(
          pg.exec(
            `insert into session_runs (stage, route_id, why_route, run_as_user) values ('execute', 'r1', '测试', 'root')`,
          ),
        ).rejects.toThrow(/session_runs_run_as_user_known/);
      } finally {
        await pg.close();
      }
    },
    TEST_DB_TIMEOUT_MS,
  );
});

describe('0011：流程配置副本、会话记下的测试命令（只加列）', () => {
  const target = ordered.findIndex((e) => e.tag === '0011_flow_replica');

  it(
    '升级时已有的仓一律是「还没同步过」（派活前按停派算，等对账读成一次），手写的 test_command 照留；已有的会话行没记测试命令',
    async () => {
      expect(target).toBeGreaterThan(0);
      const pg = await migratedBefore(target);
      try {
        await pg.exec(`
        insert into repos (owner, name, test_command) values ('acme', 'widgets', 'pnpm check');
        insert into families (id, display_name, vendor) values ('claude', 'Claude', 'Anthropic');
        insert into channels (id, name, billing) values ('sub', '订阅', 'subscription');
        insert into pools (id, channel_id, max_concurrency) values ('relay', 'sub', 5);
        insert into models (id, family, display_name) values ('opus', 'claude', 'Opus');
        insert into routes (id, channel_id, pool_id, model_id, host_id) values ('r1', 'sub', 'relay', 'opus', 'claude-code');
        insert into session_runs (stage, route_id, why_route) values ('execute', 'r1', '测试');
      `);
        await runMigration(pg, '0011_flow_replica');

        expect(
          (
            await pg.query(
              `select test_command, flow_config, flow_source, flow_commit, flow_synced_at, flow_error, flow_checked_at, flow_unread from repos`,
            )
          ).rows,
        ).toEqual([
          {
            test_command: 'pnpm check',
            flow_config: null,
            flow_source: null,
            flow_commit: null,
            flow_synced_at: null,
            flow_error: null,
            flow_checked_at: null,
            flow_unread: null,
          },
        ]);
        expect((await pg.query(`select test_command from session_runs`)).rows).toEqual([
          { test_command: null },
        ]);
        // 只有配置、没有读自哪个提交、什么时候读的：进不了库
        await expect(pg.exec(`update repos set flow_config = '{"formatVersion": 1}'::jsonb`)).rejects.toThrow(
          /repos_flow_synced_together/,
        );
      } finally {
        await pg.close();
      }
    },
    TEST_DB_TIMEOUT_MS,
  );
});

describe('0013：会话记缓存读写 token（只加列，#216）', () => {
  const target = ordered.findIndex((e) => e.tag === '0013_cache_tokens');

  it(
    '升级前的会话行缓存读写是空（没读到），不是 0，输入输出照留；之后写负数被拒',
    async () => {
      expect(target).toBeGreaterThan(0);
      const pg = await migratedBefore(target);
      try {
        await pg.exec(`
        insert into families (id, display_name, vendor) values ('claude', 'Claude', 'Anthropic');
        insert into channels (id, name, billing) values ('sub', '订阅', 'subscription');
        insert into pools (id, channel_id, max_concurrency) values ('relay', 'sub', 5);
        insert into models (id, family, display_name) values ('opus', 'claude', 'Opus');
        insert into routes (id, channel_id, pool_id, model_id, host_id) values ('r1', 'sub', 'relay', 'opus', 'claude-code');
        insert into session_runs (stage, route_id, why_route, input_tokens, output_tokens) values ('execute', 'r1', '测试', 1200, 300);
      `);
        await runMigration(pg, '0013_cache_tokens');

        expect(
          (
            await pg.query(
              `select input_tokens, output_tokens, cache_read_tokens, cache_write_tokens from session_runs`,
            )
          ).rows,
        ).toEqual([
          { input_tokens: 1200, output_tokens: 300, cache_read_tokens: null, cache_write_tokens: null },
        ]);
        await expect(pg.exec(`update session_runs set cache_read_tokens = -1`)).rejects.toThrow(
          /session_runs_cache_nonneg/,
        );
        await expect(pg.exec(`update session_runs set cache_write_tokens = -1`)).rejects.toThrow(
          /session_runs_cache_nonneg/,
        );
      } finally {
        await pg.close();
      }
    },
    TEST_DB_TIMEOUT_MS,
  );
});

describe('0025：路由两层（只加表、加一条唯一约束，#574）', () => {
  const target = ordered.findIndex((e) => e.tag.startsWith('0025_'));

  it(
    '旧库升级：路由、旧的阶段顺序一行不丢；新表是空的；新表的外键能指到路由（复合唯一约束在外键之前建好）',
    async () => {
      expect(target).toBeGreaterThan(0);
      const pg = await migratedBefore(target);
      try {
        await pg.exec(`
        insert into families (id, display_name, vendor) values ('claude', 'Claude', 'Anthropic');
        insert into channels (id, name, billing) values ('sub', '订阅', 'subscription');
        insert into pools (id, channel_id, max_concurrency) values ('relay', 'sub', 5);
        insert into models (id, family, display_name) values ('opus', 'claude', 'Opus');
        insert into routes (id, channel_id, pool_id, model_id, host_id) values ('r1', 'sub', 'relay', 'opus', 'claude-code');
        insert into stage_policies (stage) values ('execute');
        insert into stage_policy_routes (stage, route_id, position, enabled) values ('execute', 'r1', 0, true);
      `);
        await runMigration(pg, ordered[target]?.tag ?? '');

        expect((await pg.query('select id from routes')).rows).toEqual([{ id: 'r1' }]);
        expect((await pg.query('select route_id from stage_policy_routes')).rows).toEqual([
          { route_id: 'r1' },
        ]);
        expect((await pg.query('select count(*)::int as n from routing_catalog')).rows).toEqual([{ n: 0 }]);
        expect((await pg.query('select count(*)::int as n from routing_purpose_models')).rows).toEqual([
          { n: 0 },
        ]);
        await pg.exec(
          `insert into routing_catalog (model_id, route_id, position, enabled) values ('opus', 'r1', 0, true)`,
        );
        await expect(
          pg.exec(
            `insert into routing_catalog (model_id, route_id, position, enabled) values ('opus', 'nope', 1, true)`,
          ),
        ).rejects.toThrow(/routing_catalog_route_of_model_fk/);
      } finally {
        await pg.close();
      }
    },
    TEST_DB_TIMEOUT_MS,
  );
});

describe('0037：删八张没人读写的表（只放删表语句）', () => {
  const target = ordered.findIndex((e) => e.tag.startsWith('0037_'));
  const DROPPED = [
    'feishu_cards',
    'feishu_drafts',
    'feishu_follows',
    'feishu_outbox',
    'session_stops',
    'stage_policies',
    'stage_policy_routes',
    'verify_rounds',
  ];
  const exists = async (pg: PGlite, name: string) =>
    (await pg.query<{ r: string | null }>(`select to_regclass('public.${name}')::text as r`)).rows[0]?.r !==
    null;

  it(
    '旧库升级：八张表连旧行一起没了；别的表（session_runs、routes）和它们的行原样在；删过的表读不了',
    async () => {
      expect(target).toBeGreaterThan(0);
      const pg = await migratedBefore(target);
      try {
        await pg.exec(`
        insert into families (id, display_name, vendor) values ('claude', 'Claude', 'Anthropic');
        insert into channels (id, name, billing) values ('sub', '订阅', 'subscription');
        insert into pools (id, channel_id, max_concurrency) values ('relay', 'sub', 5);
        insert into models (id, family, display_name) values ('opus', 'claude', 'Opus');
        insert into routes (id, channel_id, pool_id, model_id, host_id) values ('r1', 'sub', 'relay', 'opus', 'claude-code');
        insert into stage_policies (stage) values ('execute');
        insert into stage_policy_routes (stage, route_id, position, enabled) values ('execute', 'r1', 0, true);
        insert into session_stops (run_id, reason) values (gen_random_uuid(), 'x');
      `);
        for (const name of DROPPED) expect(await exists(pg, name), name).toBe(true);

        await runMigration(pg, ordered[target]?.tag ?? '');

        for (const name of DROPPED) expect(await exists(pg, name), name).toBe(false);
        expect(await exists(pg, 'session_runs')).toBe(true);
        expect((await pg.query('select id from routes')).rows).toEqual([{ id: 'r1' }]);
        await expect(pg.query('select * from stage_policy_routes')).rejects.toThrow(/does not exist/);
      } finally {
        await pg.close();
      }
    },
    TEST_DB_TIMEOUT_MS,
  );

  it('【故意造出的失败】schema 里不许再有这八张表，也不许少了 session_runs（它还有读方）', () => {
    for (const name of DROPPED) expect(schemaTables).not.toContain(name);
    expect(schemaTables).toContain('session_runs');
  });
});

describe('0056：探针结论删掉 on_demand（#1798 片 8，#1843）', () => {
  const target = ordered.findIndex((e) => e.tag.startsWith('0056_'));
  const enumLabels = async (pg: PGlite) =>
    (
      await pg.query<{ v: string }>(
        `select e.enumlabel as v from pg_enum e join pg_type t on t.oid = e.enumtypid
         where t.typname = 'route_probe_state' order by e.enumsortorder`,
      )
    ).rows.map((r) => r.v);
  const seedRoutes = `
    insert into families (id, display_name, vendor) values ('claude', 'Claude', 'Anthropic');
    insert into channels (id, name, billing) values ('sub', '订阅', 'subscription');
    insert into pools (id, channel_id, max_concurrency) values ('relay', 'sub', 5);
    insert into models (id, family, display_name) values ('opus', 'claude', 'Opus'), ('sonnet', 'claude', 'Sonnet'),
      ('haiku', 'claude', 'Haiku'), ('fable', 'claude', 'Fable');
    insert into routes (id, channel_id, pool_id, model_id, host_id, alive, probe_state, probed_at, probe_detail) values
      ('r-demand', 'sub', 'relay', 'opus', 'claude-code', false, 'on_demand', '2026-10-10T01:05:00Z',
        '不主动探，要派给它时先探一次。还没真探过'),
      ('r-ok', 'sub', 'relay', 'sonnet', 'claude-code', true, 'ok', '2026-10-11T08:00:00Z', '答上了：pong'),
      ('r-failed', 'sub', 'relay', 'haiku', 'claude-code', false, 'failed', '2026-10-11T08:00:00Z', '网络不通'),
      ('r-never', 'sub', 'relay', 'fable', 'claude-code', false, null, null, null);
  `;

  it(
    '旧库升级：on_demand 那行改成 skipped、原文写「改版后等下一轮探」、时刻不动；别的行原样；枚举里没有 on_demand，约束照旧',
    async () => {
      expect(target).toBeGreaterThan(0);
      const pg = await migratedBefore(target);
      try {
        await pg.exec(seedRoutes);
        expect(await enumLabels(pg)).toContain('on_demand');

        await runMigration(pg, ordered[target]?.tag ?? '');

        expect(
          (
            await pg.query(
              `select id, alive, probe_state::text as state, (probed_at at time zone 'UTC')::text as at, probe_detail as detail
               from routes order by id`,
            )
          ).rows,
        ).toEqual([
          {
            id: 'r-demand',
            alive: false,
            state: 'skipped',
            at: '2026-10-10 01:05:00',
            detail: '改版后等下一轮探',
          },
          { id: 'r-failed', alive: false, state: 'failed', at: '2026-10-11 08:00:00', detail: '网络不通' },
          { id: 'r-never', alive: false, state: null, at: null, detail: null },
          { id: 'r-ok', alive: true, state: 'ok', at: '2026-10-11 08:00:00', detail: '答上了：pong' },
        ]);
        expect(await enumLabels(pg)).toEqual(['ok', 'failed', 'not_wired', 'skipped']);
        await expect(
          pg.exec(`update routes set probe_state = 'on_demand' where id = 'r-never'`),
        ).rejects.toThrow(/invalid input value for enum/);
        // 重建枚举时摘下又装回的三条约束还在
        await expect(pg.exec(`update routes set alive = true where id = 'r-demand'`)).rejects.toThrow(
          /routes_alive_needs_probe_ok/,
        );
        await expect(pg.exec(`update routes set probed_at = null where id = 'r-demand'`)).rejects.toThrow(
          /routes_probe_state_at_together/,
        );
        await expect(pg.exec(`update routes set probe_detail = '' where id = 'r-demand'`)).rejects.toThrow(
          /routes_probe_not_ok_has_detail/,
        );
      } finally {
        await pg.close();
      }
    },
    TEST_DB_TIMEOUT_MS,
  );

  it(
    '【故意造出的失败】少了先改写那一句，库里还有 on_demand 行时重建枚举会失败（迁移不能只在空库上能跑）',
    async () => {
      expect(target).toBeGreaterThan(0);
      const pg = await migratedBefore(target);
      try {
        await pg.exec(seedRoutes);
        const text = readFileSync(join(MIGRATIONS_FOLDER, `${ordered[target]?.tag}.sql`), 'utf8');
        const statements = text.split('--> statement-breakpoint');
        const rewrite = statements.filter((s) => /^\s*update\s+"?routes"?/im.test(s));
        expect(rewrite).toHaveLength(1);
        const rest = statements.filter((s) => !rewrite.includes(s));
        await expect(
          (async () => {
            for (const s of rest) await pg.exec(s);
          })(),
        ).rejects.toThrow(/invalid input value for enum/);
      } finally {
        await pg.close();
      }
    },
    TEST_DB_TIMEOUT_MS,
  );

  it('schema 里的探针结论不再有 on_demand', () => {
    expect([...schema.ROUTE_PROBE_STATES]).toEqual(['ok', 'failed', 'not_wired', 'skipped']);
  });
});

describe('测试库', () => {
  it(
    '两份测试库互相看不见对方的数据',
    async () => {
      const other = await createTestDb();
      try {
        // 本机内存 PGlite：dataDir 必须是 memory://（防 PGlite 落到磁盘）。真 Postgres：一份独立的库（CREATE DATABASE … TEMPLATE
        // 克隆出来的），dataDir 字段没有，隔离由「各拿一份库」这条断言本身验。
        if (t.client.dataDir !== undefined) expect(t.client.dataDir).toMatch(/^memory:\/\//);
        await t.db.insert(schema.families).values({ id: 'only-in-t', displayName: 'T', vendor: 'T' });
        expect(await other.db.select().from(schema.families)).toEqual([]);
      } finally {
        await other.close();
      }
    },
    TEST_DB_TIMEOUT_MS,
  );

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

  it('【故意造出的失败】清空后自增序号回到起点：表里有行的、表空着但序号被失败的插入推进过的，都从 1 起', async () => {
    const row = { actorKind: 'engine', actorId: 't', action: 'x', target: 't', via: 'engine' } as const;
    // 违反 audit_log_failure_has_error：插不进去，序号却已经推进了。表是空的，只清有行的表时最容易漏掉它。
    await expect(t.db.insert(schema.auditLog).values({ ...row, ok: false })).rejects.toThrow();
    await resetTestDb(t);
    const [first] = await t.db.insert(schema.auditLog).values(row).returning();
    expect(first?.id).toBe(1);
    await t.db.insert(schema.auditLog).values(row);
    await resetTestDb(t);
    const [again] = await t.db.insert(schema.auditLog).values(row).returning();
    expect(again?.id).toBe(1);
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

describe('0072：已删功能留下的开着的提醒标成已撤', () => {
  const tag = '0072_resolve_retired_alert_keys';
  const target = ordered.findIndex((e) => e.tag === tag);

  const snapshot = async (pg: PGlite) => {
    const notes = await pg.query<{
      id: string;
      dedupe_key: string;
      level: string;
      title: string;
      body: string;
      link: string | null;
      created_at: string;
      updated_at: string;
      resolved_at: string | null;
      resolved_by: string | null;
    }>(
      `select id, dedupe_key, level, title, body, link,
              to_char(created_at at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS"Z"') as created_at,
              to_char(updated_at at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS"Z"') as updated_at,
              to_char(resolved_at at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS"Z"') as resolved_at,
              resolved_by
         from notifications order by dedupe_key`,
    );
    const audit = await pg.query<{
      actor_kind: string;
      actor_id: string;
      action: string;
      target: string;
      reason: string | null;
      via: string;
    }>(`select actor_kind, actor_id, action, target, reason, via from audit_log order by target, action`);
    return { notes: notes.rows, audit: audit.rows };
  };

  it(
    '三种前缀里还开着的标成已撤、写明功能已删，不删行；别的键和已经撤的不动；再跑一遍无副作用',
    async () => {
      expect(target).toBeGreaterThanOrEqual(0);
      const sqlText = readFileSync(join(MIGRATIONS_FOLDER, `${tag}.sql`), 'utf8');
      expect(sqlText.toLowerCase()).not.toContain('delete');
      const pg = await migratedBefore(target);
      try {
        await pg.exec(`
          insert into notifications (level, dedupe_key, title, body, link, created_at, updated_at) values
            ('alert', 'canary:broken', '巡检断了', '断在执行', 'https://example/canary', '2026-09-01T00:00:00Z', '2026-09-01T01:00:00Z'),
            ('alert', 'canary:', '只有前缀', '', null, '2026-09-01T00:00:00Z', '2026-09-01T01:00:00Z'),
            ('alert', 'canary:leftover-pr:acme/widgets#7', '没合的巡检 PR', '留下的', null, '2026-09-02T00:00:00Z', '2026-09-02T00:00:00Z'),
            ('alert', 'no-verifier:aaaaaaaa-1111-4222-8333-444444444444', '没人能验', '原来的正文', null, '2026-09-03T00:00:00Z', '2026-09-03T00:00:00Z'),
            ('daily', 'retired-schedule:nightly', '删不掉', 'Temporal 报错', null, '2026-09-04T00:00:00Z', '2026-09-04T00:00:00Z'),
            ('alert', 'canary:old', '已经撤过', '原来的正文', null, '2026-08-01T00:00:00Z', '2026-08-02T00:00:00Z'),
            ('alert', 'watchdog:merge:acme/widgets:after-1', '主线没合', '还在', null, '2026-09-05T00:00:00Z', '2026-09-05T00:00:00Z'),
            ('alert', 'not-canary:broken', '不是巡检', '别动', null, '2026-09-06T00:00:00Z', '2026-09-06T00:00:00Z'),
            ('alert', 'no-verifier-without-colon', '没有冒号', '别动', null, '2026-09-07T00:00:00Z', '2026-09-07T00:00:00Z'),
            ('alert', 'Canary:broken', '大小写不同', '别动', null, '2026-09-08T00:00:00Z', '2026-09-08T00:00:00Z');
          update notifications
             set resolved_at = '2026-08-03T00:00:00Z', resolved_by = 'someone'
           where dedupe_key = 'canary:old';
        `);
        const idsBefore = (
          await pg.query<{ id: string }>(`select id from notifications order by dedupe_key`)
        ).rows.map((r) => r.id);
        expect(idsBefore).toHaveLength(10);

        await runMigration(pg, tag);

        const once = await snapshot(pg);
        const byKey = new Map(once.notes.map((r) => [r.dedupe_key, r]));
        const closedKeys = [
          'canary:broken',
          'canary:',
          'canary:leftover-pr:acme/widgets#7',
          'no-verifier:aaaaaaaa-1111-4222-8333-444444444444',
          'retired-schedule:nightly',
        ];
        const updatedBefore: Record<string, string> = {
          'canary:broken': '2026-09-01T01:00:00Z',
          'canary:': '2026-09-01T01:00:00Z',
          'canary:leftover-pr:acme/widgets#7': '2026-09-02T00:00:00Z',
          'no-verifier:aaaaaaaa-1111-4222-8333-444444444444': '2026-09-03T00:00:00Z',
          'retired-schedule:nightly': '2026-09-04T00:00:00Z',
        };
        for (const key of closedKeys) {
          const row = byKey.get(key);
          expect(row?.resolved_by, key).toBe('migration:0072');
          expect(row?.resolved_at, key).not.toBeNull();
          expect(row?.updated_at, key).not.toBe(updatedBefore[key]);
        }
        expect(byKey.get('canary:broken')).toMatchObject({
          title: '巡检断了',
          body: '已撤：功能已删\n\n断在执行',
          link: 'https://example/canary',
          level: 'alert',
          created_at: '2026-09-01T00:00:00Z',
        });
        expect(byKey.get('canary:')?.body).toBe('已撤：功能已删');
        expect(byKey.get('canary:leftover-pr:acme/widgets#7')?.body).toBe('已撤：功能已删\n\n留下的');
        expect(byKey.get('no-verifier:aaaaaaaa-1111-4222-8333-444444444444')?.body).toBe(
          '已撤：功能已删\n\n原来的正文',
        );
        expect(byKey.get('retired-schedule:nightly')).toMatchObject({
          level: 'daily',
          title: '删不掉',
          body: '已撤：功能已删\n\nTemporal 报错',
        });
        expect(byKey.get('canary:old')).toMatchObject({
          title: '已经撤过',
          body: '原来的正文',
          resolved_at: '2026-08-03T00:00:00Z',
          resolved_by: 'someone',
          updated_at: '2026-08-02T00:00:00Z',
          created_at: '2026-08-01T00:00:00Z',
        });
        for (const key of [
          'watchdog:merge:acme/widgets:after-1',
          'not-canary:broken',
          'no-verifier-without-colon',
          'Canary:broken',
        ]) {
          expect(byKey.get(key)?.resolved_at, key).toBeNull();
          expect(byKey.get(key)?.resolved_by, key).toBeNull();
          expect(byKey.get(key)?.body, key).not.toContain('功能已删');
        }
        expect(byKey.get('watchdog:merge:acme/widgets:after-1')?.body).toBe('还在');
        expect(once.notes.map((r) => r.id)).toEqual(idsBefore);
        expect(once.audit).toHaveLength(closedKeys.length);
        expect(once.audit).toEqual(
          expect.arrayContaining(
            closedKeys.map((key) => ({
              actor_kind: 'engine',
              actor_id: 'migration:0072',
              action: 'notification.resolve',
              target: `notification:${byKey.get(key)?.id}`,
              reason: '功能已删',
              via: 'engine',
            })),
          ),
        );

        await runMigration(pg, tag);
        const twice = await snapshot(pg);
        expect(twice).toEqual(once);
      } finally {
        await pg.close();
      }
    },
    TEST_DB_TIMEOUT_MS,
  );
});

describe('0073：提醒这一次挂起的时刻回填成建立时刻', () => {
  const tag = '0073_notification_raised_at';

  it('已有行的 raised_at 等于 created_at，不写成迁移时刻', async () => {
    const target = ordered.findIndex((e) => e.tag === tag);
    expect(target).toBeGreaterThanOrEqual(0);
    const pg = await migratedBefore(target);
    try {
      await pg.exec(`
        insert into notifications (level, dedupe_key, title, created_at, updated_at)
        values ('alert', 'quota-read:grok', '额度读不到', '2026-10-14T00:00:00Z', '2026-10-15T17:19:00Z')
      `);
      await runMigration(pg, tag);
      const rows = await pg.query<{ created_at: string; raised_at: string }>(`
        select to_char(created_at at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS"Z"') as created_at,
               to_char(raised_at at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS"Z"') as raised_at
          from notifications
         where dedupe_key = 'quota-read:grok'
      `);
      expect(rows.rows).toEqual([{ created_at: '2026-10-14T00:00:00Z', raised_at: '2026-10-14T00:00:00Z' }]);
    } finally {
      await pg.close();
    }
  });
});
