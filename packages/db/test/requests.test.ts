// 需求表（#2049）：定时任务 request-sweep 的一轮（删了满 30 天硬删连消息、写操作记录；已结案·不做马上归档；
// 已结案·做的单子上线或关掉满 3 天归档）、单子状态的写入口、表上的约束、迁移 0065 设的拍板人。
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { PGlite } from '@electric-sql/pglite';
import { eq } from 'drizzle-orm';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import type { Db } from '../src/client.ts';
import { MIGRATIONS_FOLDER } from '../src/migrate.ts';
import { recordRequestIssueState, sweepRequests } from '../src/queries/requests.ts';
import { auditLog, requestMessages, requests, requestUserState, users } from '../src/schema/index.ts';
import { createTestDb, resetTestDb, TEST_DB_TIMEOUT_MS, type TestDb } from '../src/testing.ts';
import { addRepo, DAY, expectViolation, NOW } from './helpers.ts';

let t: TestDb;
beforeAll(async () => {
  t = await createTestDb();
}, TEST_DB_TIMEOUT_MS);
afterAll(() => t.close());
beforeEach(() => resetTestDb(t));

const ago = (ms: number) => new Date(NOW.getTime() - ms);

async function fixture(db: Db) {
  const repo = await addRepo(db, 'canary');
  const [founder] = await db
    .insert(users)
    .values({ displayName: '创始人', role: 'founder', decidesRequests: true })
    .returning();
  if (!founder) throw new Error('没建成用户');
  return { repo, founder };
}

async function addRequest(
  db: Db,
  f: Awaited<ReturnType<typeof fixture>>,
  over: Partial<typeof requests.$inferInsert> = {},
) {
  const [r] = await db
    .insert(requests)
    .values({
      repoId: f.repo.id,
      initiatorId: f.founder.id,
      draftJson: { title: '一条需求' },
      lastActivityAt: ago(DAY),
      ...over,
    })
    .returning();
  if (!r) throw new Error('没建成需求');
  await db.insert(requestMessages).values({
    requestId: r.id,
    kind: 'human',
    authorId: f.founder.id,
    channel: 'web',
    body: '想要一个按钮',
    createdAt: ago(DAY),
  });
  await db.insert(requestUserState).values({ requestId: r.id, userId: f.founder.id, pinnedAt: ago(DAY) });
  return r;
}

describe('sweepRequests：硬删', () => {
  it('删了满 30 天的连消息、个人状态一起删掉，写一条操作记录；不满 30 天、没删的不动', async () => {
    const f = await fixture(t.db);
    const old = await addRequest(t.db, f, { deletedAt: ago(30 * DAY) });
    const fresh = await addRequest(t.db, f, { deletedAt: ago(29 * DAY) });
    const live = await addRequest(t.db, f);

    const result = await sweepRequests(t.db, NOW);
    expect(result).toEqual({ scanned: 3, purged: [old.seq], archived: [] });

    const left = await t.db.select({ id: requests.id }).from(requests);
    expect(left.map((r) => r.id).sort()).toEqual([fresh.id, live.id].sort());
    expect(await t.db.select().from(requestMessages).where(eq(requestMessages.requestId, old.id))).toEqual(
      [],
    );
    expect(await t.db.select().from(requestUserState).where(eq(requestUserState.requestId, old.id))).toEqual(
      [],
    );

    const audits = await t.db.select().from(auditLog);
    expect(audits).toHaveLength(1);
    expect(audits[0]).toMatchObject({
      actorKind: 'engine',
      actorId: 'request-sweep',
      action: 'request.purge',
      target: `request:${old.seq}`,
      via: 'engine',
      ok: true,
    });
    expect(audits[0]?.before).toMatchObject({
      seq: old.seq,
      title: '一条需求',
      repo: `${f.repo.owner}/canary`,
      messages: 1,
    });
  });

  it('「接着这条提」指着被硬删的那条：新的那条留着，指向置空', async () => {
    const f = await fixture(t.db);
    const old = await addRequest(t.db, f, { deletedAt: ago(31 * DAY) });
    const next = await addRequest(t.db, f, { continuesRequestId: old.id });
    await sweepRequests(t.db, NOW);
    const [row] = await t.db.select().from(requests).where(eq(requests.id, next.id));
    expect(row?.continuesRequestId).toBeNull();
  });
});

describe('sweepRequests：自动归档', () => {
  it('已结案·不做马上归档；已结案·做，单子上线满 3 天归档、不满不归；讨论中不归档', async () => {
    const f = await fixture(t.db);
    const closed = { closedAt: ago(DAY), deciderId: f.founder.id };
    const drop = await addRequest(t.db, f, { status: 'closed_drop', closeReason: '不做了', ...closed });
    const shipped = await addRequest(t.db, f, {
      status: 'closed_do',
      ...closed,
      issueRefs: [{ repo: 'o/r', number: 12, state: 'deployed', stateAt: ago(3 * DAY).toISOString() }],
    });
    const recent = await addRequest(t.db, f, {
      status: 'closed_do',
      ...closed,
      issueRefs: [{ repo: 'o/r', number: 13, state: 'closed', stateAt: ago(2 * DAY).toISOString() }],
    });
    const noIssue = await addRequest(t.db, f, { status: 'closed_do', ...closed });
    await addRequest(t.db, f, { lastActivityAt: ago(40 * DAY) });

    const result = await sweepRequests(t.db, NOW);
    expect(result.archived.sort()).toEqual([drop.seq, shipped.seq].sort());
    expect(result.purged).toEqual([]);
    const rows = await t.db.select({ seq: requests.seq, archivedAt: requests.archivedAt }).from(requests);
    const archived = rows.filter((r) => r.archivedAt !== null).map((r) => r.seq);
    expect(archived.sort()).toEqual([drop.seq, shipped.seq].sort());
    expect(archived).not.toContain(recent.seq);
    expect(archived).not.toContain(noIssue.seq);
    const audits = await t.db.select().from(auditLog);
    expect(audits.map((a) => a.action)).toEqual(['request.auto_archive', 'request.auto_archive']);

    // 再跑一轮：归档过的不再记
    expect((await sweepRequests(t.db, NOW)).archived).toEqual([]);
  });

  it('表里一条都没有：scanned 是 0，不抛', async () => {
    expect(await sweepRequests(t.db, NOW)).toEqual({ scanned: 0, purged: [], archived: [] });
  });
});

describe('recordRequestIssueState：单子状态的写入口（B 片调）', () => {
  it('没有就加上，有就改状态和时刻；状态没变不改时刻；没有这条需求回 false', async () => {
    const f = await fixture(t.db);
    const r = await addRequest(t.db, f);
    expect(
      await recordRequestIssueState(t.db, {
        seq: r.seq,
        repo: 'o/r',
        number: 12,
        state: 'open',
        at: ago(5 * DAY),
      }),
    ).toBe(true);
    await recordRequestIssueState(t.db, {
      seq: r.seq,
      repo: 'O/R',
      number: 12,
      state: 'deployed',
      at: ago(4 * DAY),
    });
    await recordRequestIssueState(t.db, {
      seq: r.seq,
      repo: 'o/r',
      number: 12,
      state: 'deployed',
      at: ago(DAY),
    });
    const [row] = await t.db.select().from(requests).where(eq(requests.id, r.id));
    expect(row?.issueRefs).toEqual([
      { repo: 'O/R', number: 12, state: 'deployed', stateAt: ago(4 * DAY).toISOString() },
    ]);
    expect(
      await recordRequestIssueState(t.db, { seq: 999, repo: 'o/r', number: 1, state: 'open', at: NOW }),
    ).toBe(false);
  });
});

describe('表上的约束', () => {
  it('讨论中的不能归档；不做没写理由写不进；人话没有说话人写不进', async () => {
    const f = await fixture(t.db);
    await expectViolation(addRequest(t.db, f, { archivedAt: NOW }), 'requests_archive_only_closed');
    await expectViolation(
      addRequest(t.db, f, { status: 'closed_drop', closedAt: NOW }),
      'requests_drop_has_reason',
    );
    const r = await addRequest(t.db, f);
    await expectViolation(
      t.db
        .insert(requestMessages)
        .values({ requestId: r.id, kind: 'human', channel: 'web', body: '谁说的？', createdAt: NOW }),
      'request_messages_human_shape',
    );
  });
});

describe('迁移 0065：拍板人', () => {
  it(
    '最早建的、在用的创始人设成拍板人，后加的合伙人、停用的、机器人不设',
    async () => {
      const journal = JSON.parse(readFileSync(join(MIGRATIONS_FOLDER, 'meta', '_journal.json'), 'utf8')) as {
        entries: { idx: number; tag: string }[];
      };
      const ordered = [...journal.entries].sort((a, b) => a.idx - b.idx);
      const target = ordered.findIndex((e) => e.tag === '0065_intake_requests');
      expect(target).toBeGreaterThan(0);
      const run = async (pg: PGlite, tag: string) => {
        const text = readFileSync(join(MIGRATIONS_FOLDER, `${tag}.sql`), 'utf8');
        for (const statement of text.split('--> statement-breakpoint')) await pg.exec(statement);
      };
      const pg = new PGlite();
      try {
        for (const e of ordered.slice(0, target)) await run(pg, e.tag);
        await pg.exec(`
          insert into users (display_name, role, active, created_at) values
            ('停用的老创始人', 'founder', false, '2026-01-01T00:00:00Z'),
            ('机器人', 'bot', true, '2026-01-02T00:00:00Z'),
            ('创始人', 'founder', true, '2026-02-01T00:00:00Z'),
            ('合伙人', 'founder', true, '2026-03-01T00:00:00Z');
        `);
        await run(pg, '0065_intake_requests');
        const rows = await pg.query<{ display_name: string; decides_requests: boolean }>(
          'select display_name, decides_requests from users order by created_at',
        );
        expect(rows.rows.map((r) => [r.display_name, r.decides_requests])).toEqual([
          ['停用的老创始人', false],
          ['机器人', false],
          ['创始人', true],
          ['合伙人', false],
        ]);
      } finally {
        await pg.close();
      }
    },
    TEST_DB_TIMEOUT_MS,
  );
});
