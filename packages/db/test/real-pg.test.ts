// FLEET_TEST_PG_URL 指着的那个真 Postgres：这条文件只在设了这个环境变量（CI 的 db 测试分片）时跑，
// 没设（本机）整体跳过——本机照 PGlite 走、不起服务，本测试文件没有可测的。
// 故意造出失败的测试（#220）：模板库里要是读得到正式库的数据，一定红——这意味着测试不小心连着生产、或
// 克隆拿错了源库。设了 URL 连不上、认不出也当场红（不静默退回 PGlite 冒充）。

import { randomUUID } from 'node:crypto';
import postgres from 'postgres';
import { describe, expect, it } from 'vitest';
import {
  createTestDb,
  createTestDbFromTemplate,
  dropDatabaseForce,
  ensureTemplateDb,
  realTestPgUrl,
  TEST_DB_TIMEOUT_MS,
} from '../src/testing.ts';

const url = realTestPgUrl();
const run = url ? describe : describe.skip;

run('真 Postgres 后端（设了 FLEET_TEST_PG_URL 才跑，CI 的 db 分片）', () => {
  it(
    '连接串指着一个连得上的库：连不上当场红，不退回内存库冒充',
    async () => {
      // 走到这里 url 一定非空（describe.skip 之外的分支），做不到这一点是测试文件自己写错了。
      if (!url) throw new Error('FLEET_TEST_PG_URL 没设：这条不该跑到（应在 describe.skip 的那一支）');
      const sql = postgres(url, { max: 1, connect_timeout: 5 });
      try {
        const rows = await sql`select 1::int as ok`;
        expect(rows).toEqual([{ ok: 1 }]);
      } finally {
        await sql.end({ timeout: 5 });
      }
    },
    TEST_DB_TIMEOUT_MS,
  );

  it(
    '故意造出失败：模板库里的业务表必须全是空的——要是读到正式库的数据，一定红',
    async () => {
      const t = await createTestDb();
      try {
        // 模板克隆出来的测试库跳过种子：业务表一张都是空。读得到任务、仓、账号任一非空，说明连着生产、
        // 或克隆拿错了源库——#220「AI 会话碰不到正式库」的最小验证。
        for (const table of ['tasks', 'repos', 'users', 'pools', 'routes', 'session_runs']) {
          const rows = await t.client.query<{ n: number }>(`select count(*)::int as n from ${table}`);
          expect(
            rows.rows[0]?.n,
            `测试库的 ${table} 表应该是空的（克隆自刚迁移完、未播种的模板），却读到 ${rows.rows[0]?.n} 行：` +
              '很可能是 FLEET_TEST_PG_URL 指着生产库，或克隆前没建干净的模板',
          ).toBe(0);
        }
      } finally {
        await t.close();
      }
    },
    TEST_DB_TIMEOUT_MS,
  );

  it(
    '故意造出失败：模板库被写过一行，createTestDb 必须当场拒绝（不把脏库发给调用方）',
    async () => {
      if (!url) throw new Error('FLEET_TEST_PG_URL 没设：这条不该跑到');
      // 用一个独占的模板名：这条用例要把它写脏，如果还动共享的 fleet_test_template，和本测试文件
      // 并发跑的其他文件正好在克隆会被 assertCleanClone 拒掉，无关用例偶发红（PR #562 review 第三条）。
      const dirtyTemplate = `dirty_template_${randomUUID().replace(/-/g, '')}`;
      // 先建一份干净的（结构跟共享模板一样：跑同一批迁移），等会儿往里写一行脏数据。
      await ensureTemplateDb(url, dirtyTemplate);
      try {
        // 直接往这份独占的模板库里写一行业务数据，模拟「上一次跑崩留下来 / 有人把模板库当正式库」。
        const tpl = new URL(url);
        tpl.pathname = `/${dirtyTemplate}`;
        const tplSql = postgres(tpl.toString(), { max: 1, onnotice: () => {} });
        try {
          await tplSql`insert into families (id, display_name, vendor) values ('dirty-row', 'dirty', 'dirty')`;
        } finally {
          await tplSql.end({ timeout: 5 });
        }
        // 从这份脏模板克隆必须当场抛 ERR_DIRTY_TEMPLATE 并把克隆库回收，不能把脏库发给测试。
        await expect(
          createTestDbFromTemplate(url, dirtyTemplate),
          '模板被写脏了，createTestDbFromTemplate 必须拒绝而不是发还脏库',
        ).rejects.toThrow(/ERR_DIRTY_TEMPLATE/);
      } finally {
        // 只回收这条用例自己的那份模板（不重建：它和共享模板无关，别的用例也不用它）。
        await dropDatabaseForce(url, dirtyTemplate);
      }
    },
    TEST_DB_TIMEOUT_MS,
  );

  it(
    '两份测试库各自独立：一份写的东西另一份看不见',
    async () => {
      // 这条和 migrations.test.ts 那条同形，这里复测一次是因为真库多了「两个库其实是同一个」「克隆退化
      // 成直连同一个 schema」等出错方式，PGlite 那条只验内存里的隔离。
      const a = await createTestDb();
      const b = await createTestDb();
      try {
        await a.client.exec(`insert into families (id, display_name, vendor) values ('only-in-a', 'A', 'A')`);
        const seenInB = await b.client.query<{ n: number }>(
          `select count(*)::int as n from families where id = 'only-in-a'`,
        );
        expect(seenInB.rows[0]?.n).toBe(0);
      } finally {
        await a.close();
        await b.close();
      }
    },
    TEST_DB_TIMEOUT_MS,
  );
});
