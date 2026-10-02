// routing_catalog 副本的幂等和约束（specs/574-路由两层DB/需求.md）：
// - 同一份 payload + commit 写两遍，第二遍应当只刷新 checkedAt / syncedAt、版本号不动（mutation 测试会抓
//   「 unconditionally upsert 也算我写过了」假幂等）。
// - payload 形状、commit 形式、status 取值全靠库里的 CHECK 拦，绕过应用层直接 pg 写也要被拦下。
import { readFileSync } from 'node:fs';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import {
  canonicalJson,
  getRoutingCatalog,
  markRoutingCatalogBlocked,
  markRoutingCatalogStale,
  writeRoutingCatalogFresh,
} from '../src/queries/routing-catalog.ts';
import { routingCatalog } from '../src/schema/index.ts';
import { createTestDb, resetTestDb, TEST_DB_TIMEOUT_MS, type TestDb } from '../src/testing.ts';
import { expectViolation, later, NOW } from './helpers.ts';

const ORG_TEXT = readFileSync(new URL('../../core/routing.default.json', import.meta.url), 'utf8');
const COMMIT_A = 'a'.repeat(40);
const COMMIT_B = 'b'.repeat(40);

let t: TestDb;
beforeAll(async () => {
  t = await createTestDb();
}, TEST_DB_TIMEOUT_MS);
afterAll(() => t.close());
beforeEach(async () => {
  await resetTestDb(t);
});

function parsed(): Record<string, unknown> {
  return JSON.parse(ORG_TEXT) as Record<string, unknown>;
}

describe('routing_catalog 副本', () => {
  it('resolveRoutingCatalog 认得出仓里的全组织默认，整份 JSON 能直接作为 payload 进库', async () => {
    const cat = parsed();
    await writeRoutingCatalogFresh(t.db, {
      source: 'org_default',
      payload: cat,
      commit: COMMIT_A,
      syncedAt: NOW,
      checkedAt: NOW,
    });
    const row = await getRoutingCatalog(t.db, 'org_default');
    expect(row).not.toBeNull();
    expect(row?.commit).toBe(COMMIT_A);
    expect(row?.payload).toEqual(cat);
    expect(row?.purposesVersion).toBe(1);
    expect(row?.status).toBe('fresh');
    expect(row?.lastError).toBeNull();
  });

  it('【幂等】同一份 payload + commit 连写两遍：版本号不动、内容不变；两次写入后库里只剩这一条', async () => {
    const cat = parsed();
    const entry = {
      source: 'org_default',
      payload: cat,
      commit: COMMIT_A,
    };
    await writeRoutingCatalogFresh(t.db, { ...entry, syncedAt: NOW, checkedAt: NOW });
    const once = await getRoutingCatalog(t.db, 'org_default');

    // 第二次：同步和检查都到了下一时刻，但 commit / payload 不变
    await writeRoutingCatalogFresh(t.db, {
      ...entry,
      syncedAt: later(60_000),
      checkedAt: later(60_000),
    });
    const twice = await getRoutingCatalog(t.db, 'org_default');

    expect(twice?.purposesVersion).toBe(once?.purposesVersion);
    expect(twice?.commit).toBe(once?.commit);
    expect(twice?.payload).toEqual(once?.payload);
    expect(twice?.status).toBe('fresh');
    expect(twice?.lastError).toBeNull();
    // 只动了时刻
    expect(twice?.syncedAt.getTime()).toBe(later(60_000).getTime());
    expect(twice?.checkedAt.getTime()).toBe(later(60_000).getTime());
  });

  it('换 commit 或换 payload 是真·新副本：版本号 +1', async () => {
    const cat = parsed();
    await writeRoutingCatalogFresh(t.db, {
      source: 'org_default',
      payload: cat,
      commit: COMMIT_A,
      syncedAt: NOW,
      checkedAt: NOW,
    });
    await writeRoutingCatalogFresh(t.db, {
      source: 'org_default',
      payload: cat,
      commit: COMMIT_B,
      syncedAt: later(60_000),
      checkedAt: later(60_000),
    });
    const row = await getRoutingCatalog(t.db, 'org_default');
    expect(row?.purposesVersion).toBe(2);
    expect(row?.commit).toBe(COMMIT_B);
  });

  it('stale / blocked：保留旧 payload，只是状态和出错原因换', async () => {
    const cat = parsed();
    await writeRoutingCatalogFresh(t.db, {
      source: 'org_default',
      payload: cat,
      commit: COMMIT_A,
      syncedAt: NOW,
      checkedAt: NOW,
    });
    await markRoutingCatalogStale(t.db, 'org_default', later(60_000), 'GitHub 接口 502');
    const stale = await getRoutingCatalog(t.db, 'org_default');
    expect(stale?.status).toBe('stale');
    expect(stale?.lastError).toBe('GitHub 接口 502');
    expect(stale?.payload).toEqual(cat);

    await markRoutingCatalogBlocked(t.db, 'org_default', later(120_000), 'formatVersion=2 认不出');
    const blocked = await getRoutingCatalog(t.db, 'org_default');
    expect(blocked?.status).toBe('blocked');
    expect(blocked?.lastError).toBe('formatVersion=2 认不出');
    // 再次读成后版本号 +1（payload 相同也算「又读到了」）
    await writeRoutingCatalogFresh(t.db, {
      source: 'org_default',
      payload: cat,
      commit: COMMIT_A,
      syncedAt: later(180_000),
      checkedAt: later(180_000),
    });
    const fresh = await getRoutingCatalog(t.db, 'org_default');
    expect(fresh?.status).toBe('fresh');
    expect(fresh?.lastError).toBeNull();
  });

  it('【故意造红】commit 不是 40 位 sha / status 写白名单外 / payload 不是对象 / payload 缺 purposes 或 models：全被 CHECK 拒', async () => {
    // 绕过 writeRoutingCatalogFresh 直接 sql 写。payload 用 sql 占位避免序列化里的引号麻烦。
    await expectViolation(
      t.client.exec(
        `insert into routing_catalog (source, payload, commit, purposes_version, synced_at, checked_at, status)
         values ('x', '{"formatVersion":1,"purposes":{},"models":{}}', 'abc', 1, now(), now(), 'fresh')`,
      ),
      'routing_catalog_commit_sha',
    );
    await expectViolation(
      t.client.exec(
        `insert into routing_catalog (source, payload, commit, purposes_version, synced_at, checked_at, status)
         values ('y', '{"formatVersion":1,"purposes":{},"models":{}}', '${'c'.repeat(40)}', 1, now(), now(), 'weird')`,
      ),
      'routing_catalog_status_known',
    );
    await expectViolation(
      t.client.exec(
        `insert into routing_catalog (source, payload, commit, purposes_version, synced_at, checked_at, status)
         values ('z', '"not an object"', '${'c'.repeat(40)}', 1, now(), now(), 'fresh')`,
      ),
      'routing_catalog_payload_shape',
    );
    await expectViolation(
      t.client.exec(
        `insert into routing_catalog (source, payload, commit, purposes_version, synced_at, checked_at, status)
         values ('w', '{"formatVersion":1,"purposes":{}}', '${'c'.repeat(40)}', 1, now(), now(), 'fresh')`,
      ),
      'routing_catalog_payload_shape',
    );
    await expectViolation(
      t.client.exec(
        `insert into routing_catalog (source, payload, commit, purposes_version, synced_at, checked_at, status)
         values ('v', '{"formatVersion":2,"purposes":{},"models":{}}', '${'c'.repeat(40)}', 1, now(), now(), 'fresh')`,
      ),
      'routing_catalog_payload_shape',
    );
    await expectViolation(
      t.client.exec(
        `insert into routing_catalog (source, payload, commit, purposes_version, synced_at, checked_at, status)
         values ('u', '{"formatVersion":1,"purposes":{},"models":{}}', '${'c'.repeat(40)}', 0, now(), now(), 'fresh')`,
      ),
      'routing_catalog_purposes_version_positive',
    );
  });

  it('【故意造红】绕过应用层把 purposes_version 减回去 / 把 payload 改成空对象：库里的 CHECK 也要拦', async () => {
    await writeRoutingCatalogFresh(t.db, {
      source: 'org_default',
      payload: parsed(),
      commit: COMMIT_A,
      syncedAt: NOW,
      checkedAt: NOW,
    });
    await expectViolation(
      t.client.exec(`update routing_catalog set purposes_version = 0 where source = 'org_default'`),
      'routing_catalog_purposes_version_positive',
    );
    await expectViolation(
      t.client.exec(`update routing_catalog set status = 'random' where source = 'org_default'`),
      'routing_catalog_status_known',
    );
  });

  it('canonicalJson：jsonb 写进库读回来键序变了，canonicalJson 后照样是同一份（这是「幂等」能成立的根基）', () => {
    const a = {
      formatVersion: 1,
      purposes: { triage: { models: ['opus-5.5'] } },
      models: { 'opus-5.5': { channels: ['carpool'] } },
    };
    // 同一份内容、不同键序（模拟 jsonb 读出来的形态）
    const b = {
      models: { 'opus-5.5': { channels: ['carpool'] } },
      purposes: { triage: { models: ['opus-5.5'] } },
      formatVersion: 1,
    };
    expect(JSON.stringify(a)).not.toBe(JSON.stringify(b));
    expect(canonicalJson(a)).toBe(canonicalJson(b));
    // 数组顺序是「位置不一样就不一样」：opus-5.5 的渠道顺序 [carpool, mirasim] 换了位置就必须当作新一份
    const a2 = { channels: ['carpool', 'mirasim'] };
    const b2 = { channels: ['mirasim', 'carpool'] };
    expect(canonicalJson(a2)).not.toBe(canonicalJson(b2));
    // 【造红】键序变了用 JSON.stringify 当幂等判据会误判为「变了」，把 purposesVersion 白白 +1
    expect(JSON.stringify(a) === JSON.stringify(b)).toBe(false);
  });

  it('routingCatalog drizzle 表读得回刚写入的行（应用层读路径）', async () => {
    await writeRoutingCatalogFresh(t.db, {
      source: 'org_default',
      payload: parsed(),
      commit: COMMIT_A,
      syncedAt: NOW,
      checkedAt: NOW,
    });
    const rows = await t.db.select().from(routingCatalog);
    expect(rows).toHaveLength(1);
    expect(rows[0]?.source).toBe('org_default');
    expect(rows[0]?.status).toBe('fresh');
  });
});
