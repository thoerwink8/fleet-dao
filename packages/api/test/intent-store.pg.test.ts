// Postgres 版意图存储过同一套契约：PGlite 上跑真迁移（和生产同一批 SQL），每个测试前清空、写进两位创始人。
// 另加只有库里才会出的：jsonb 列被改坏了要认不出、明说，不当成空的。
import { auditLog, intentMessages, intents, users } from '@fleet-dao/db';
import { createTestDb, resetTestDb, TEST_DB_TIMEOUT_MS, type TestDb } from '@fleet-dao/db/testing';
import { IDS } from '@fleet-dao/store';
import { asc, eq, like, sql } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createPgIntentStore } from '../src/intent-store-pg.ts';
import { describeIntentStoreContract, said, T0 } from './intent-store-contract.ts';

let t: TestDb;
beforeAll(async () => {
  t = await createTestDb();
}, TEST_DB_TIMEOUT_MS);
afterAll(() => t.close());

async function fresh() {
  await resetTestDb(t);
  await t.db.insert(users).values([
    { id: IDS.founderA, displayName: '创始人甲', role: 'founder', feishuOpenId: 'ou_dev_founder_a' },
    { id: IDS.founderB, displayName: '创始人乙', role: 'founder', feishuOpenId: 'ou_dev_founder_b' },
  ]);
}

describeIntentStoreContract('Postgres 版', async (clock) => {
  await fresh();
  return {
    store: createPgIntentStore(t.db, { now: () => new Date(clock.now) }),
    async audits() {
      const rows = await t.db
        .select()
        .from(auditLog)
        .where(like(auditLog.action, 'intent.%'))
        .orderBy(asc(auditLog.id));
      return rows.map((r) => ({ action: r.action, target: r.target, before: r.before, after: r.after }));
    },
  };
});

describe('意图存储（Postgres 版）：库里的东西认不出', () => {
  it('【故意造出的失败】links 被改成认不出的样子：读的时候抛、写明哪一段哪一列，不当成没挂单', async () => {
    await fresh();
    const store = createPgIntentStore(t.db, { now: () => new Date(T0) });
    await store.intakeMessage(said());
    await t.db.execute(sql`alter table intents drop constraint intents_linked_has_links`);
    try {
      await t.db.update(intents).set({ links: sql`'[{"nope":1}]'::jsonb` }).where(eq(intents.seq, 1));
      await expect(store.get(1)).rejects.toThrow(/意图 1 的 links 认不出/);
      await expect(store.list({ status: 'all', limit: 10 })).rejects.toThrow(/links 认不出/);
    } finally {
      await t.db.update(intents).set({ links: [] }).where(eq(intents.seq, 1));
      await t.db.execute(
        sql`alter table intents add constraint intents_linked_has_links check ((status = 'linked') = (jsonb_array_length(links) > 0))`,
      );
    }
  });

  it('【故意造出的失败】原话的 edits 被改坏：读的时候抛，写明哪条原话', async () => {
    await fresh();
    const store = createPgIntentStore(t.db, { now: () => new Date(T0) });
    const m = said();
    await store.intakeMessage(m);
    await t.db
      .update(intentMessages)
      .set({ edits: sql`'["不是一版"]'::jsonb`, editedAt: T0 })
      .where(eq(intentMessages.messageId, m.messageId));
    await expect(store.get(1)).rejects.toThrow(new RegExp(`原话 ${m.messageId} 的 edits 认不出`));
  });

  it('【故意造出的失败】写回时操作记录写不进：归纳和开成的单一起不改', async () => {
    await fresh();
    const store = createPgIntentStore(t.db, { now: () => new Date(T0) });
    await store.intakeMessage(said());
    await expect(
      store.link(
        {
          seq: 1,
          issue: 'o/r#5',
          summary: { text: '归纳', by: '指挥官会话' },
          operator: 'root',
          relink: false,
        },
        // via 不在库里认的取值（audit_via 枚举）里：操作记录那一句会被库拒掉
        {
          actor: { kind: 'engine', id: 'ops:intent' },
          action: 'intent.link',
          target: 'intent',
          via: 'bogus' as never,
          ok: true,
        },
      ),
    ).rejects.toThrow();
    const got = await store.get(1);
    expect(got?.intent.status).toBe('new');
    expect(got?.intent.summary).toBeUndefined();
    expect(got?.intent.links).toEqual([]);
  });
});
