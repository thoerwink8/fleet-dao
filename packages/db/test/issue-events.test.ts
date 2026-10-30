// 开单账本的读口（决定 0122，queries/issue-events.ts）：读 audit_log 里 target 以 issue: 开头的行，按 id 往后读。
// 要核的是「读的行数只跟返回条数有关，不跟表多大有关」：EXPLAIN (ANALYZE) 里走部分索引、没有顺序扫、没有被过滤掉的行。
import { sql } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { appendLedgerNote, issueEventsFilter, listIssueEvents } from '../src/queries/issue-events.ts';
import { auditLog } from '../src/schema/ops.ts';
import { createTestDb, TEST_DB_TIMEOUT_MS, type TestDb } from '../src/testing.ts';

let t: TestDb;
beforeAll(async () => {
  t = await createTestDb();
}, TEST_DB_TIMEOUT_MS);
afterAll(async () => {
  await t?.close();
});

const audit = (action: string, target: string) => ({
  actorKind: 'agent' as const,
  actorId: 'node:test',
  action,
  target,
  via: 'agent' as const,
  after: { n: target },
});

const rowsOf = (res: unknown): Record<string, string>[] =>
  (Array.isArray(res) ? res : (res as { rows: unknown[] }).rows) as Record<string, string>[];

describe('listIssueEvents', () => {
  it('只给 issue: 开头的行，按 id 升序，after 之后、limit 条', async () => {
    await t.db
      .insert(auditLog)
      .values([
        audit('issue.open', 'issue:a/b#1'),
        audit('task.pause', 'task:1'),
        audit('issue.merge', 'issue:a/b#2'),
        audit('login', 'issuer:9'),
        audit('issue.duplicate_refused', 'issue:a/b#3'),
      ]);
    const all = await listIssueEvents(t.db, { after: 0, limit: 100 });
    expect(all.map((e) => e.target)).toEqual(['issue:a/b#1', 'issue:a/b#2', 'issue:a/b#3']);
    expect(all.map((e) => e.id)).toEqual([...all.map((e) => e.id)].sort((x, y) => x - y));
    const page = await listIssueEvents(t.db, { after: all[0]?.id ?? 0, limit: 1 });
    expect(page.map((e) => e.target)).toEqual(['issue:a/b#2']);
    expect(page[0]).toMatchObject({
      action: 'issue.merge',
      actorKind: 'agent',
      actorId: 'node:test',
      ok: true,
    });
    expect(await listIssueEvents(t.db, { after: all.at(-1)?.id ?? 0, limit: 10 })).toEqual([]);
  });

  it('issue: 和 progress: 两个前缀的行一起读，别的前缀（含只是长得像的）不读', async () => {
    await t.db
      .insert(auditLog)
      .values([
        audit('progress.note', 'progress:p/q'),
        audit('login', 'progressive:1'),
        audit('decision.handoff', 'issue:p/q#9'),
        audit('report.daily', 'progress:p/r'),
      ]);
    const got = (await listIssueEvents(t.db, { after: 0, limit: 1000 })).filter((e) =>
      e.target.includes('p/'),
    );
    expect(got.map((e) => e.target)).toEqual(['progress:p/q', 'issue:p/q#9', 'progress:p/r']);
  });

  it('appendLedgerNote 幂等：同一个 repo + key 回原来那行；换 key、换仓是新行；issue.* 行同 key 不受约束', async () => {
    const mk = (over: Record<string, unknown> = {}) => ({
      at: new Date(),
      actorKind: 'agent' as const,
      actorId: 'node:test',
      action: 'progress.note',
      target: 'progress:n/m',
      after: { repo: 'n/m', idempotencyKey: 'key-note-0001', text: 't' },
      ...over,
    });
    const first = await appendLedgerNote(t.db, mk());
    expect(first.created).toBe(true);
    expect(await appendLedgerNote(t.db, mk({ action: 'report.daily' }))).toEqual({
      id: first.id,
      created: false,
    });
    const otherKey = await appendLedgerNote(
      t.db,
      mk({ after: { repo: 'n/m', idempotencyKey: 'key-note-0002' } }),
    );
    const otherRepo = await appendLedgerNote(
      t.db,
      mk({ target: 'progress:n/o', after: { repo: 'n/o', idempotencyKey: 'key-note-0001' } }),
    );
    expect([otherKey.created, otherRepo.created]).toEqual([true, true]);
    // 开单账本的 issue.open 同 repo 同 key 重放会记两行，不能被唯一索引挡住
    const issueRow = {
      ...audit('issue.open', 'issue:n/m#1'),
      after: { repo: 'n/m', idempotencyKey: 'key-note-0001' },
    };
    await t.db.insert(auditLog).values([issueRow, issueRow]);
    // 并发重放只有一个写进去
    const racing = await Promise.all(
      [1, 2, 3].map(() =>
        appendLedgerNote(t.db, mk({ after: { repo: 'n/m', idempotencyKey: 'key-note-race1' } })),
      ),
    );
    expect(racing.filter((r) => r.created)).toHaveLength(1);
    expect(new Set(racing.map((r) => r.id)).size).toBe(1);
  });

  it('appendLedgerNote 对 directive（#3764）同样幂等：同一个 repo + key 只留一行，回原来那行', async () => {
    const mk = () => ({
      at: new Date(),
      actorKind: 'agent' as const,
      actorId: 'node:test',
      action: 'directive',
      target: 'issue:n/d#3764',
      after: { repo: 'n/d', idempotencyKey: 'directive:202610301000-aaaa', text: 't', meaning: 'm' },
    });
    const first = await appendLedgerNote(t.db, mk());
    expect(first.created).toBe(true);
    expect(await appendLedgerNote(t.db, mk())).toEqual({ id: first.id, created: false });
    const racing = await Promise.all(
      [1, 2, 3].map(() =>
        appendLedgerNote(t.db, {
          ...mk(),
          after: { repo: 'n/d', idempotencyKey: 'directive:202610301001-race' },
        }),
      ),
    );
    expect(racing.filter((r) => r.created)).toHaveLength(1);
  });

  it('两个前缀的读都走部分索引，读的行数和 limit 成正比（limit 3 读 3 行、limit 6 读 6 行）', async () => {
    await t.db.execute(sql`
      insert into audit_log (actor_kind, actor_id, action, target, via)
      select 'ops', 'x', 'noise', 'task:' || g, 'ops' from generate_series(1, 30000) g`);
    await t.db
      .insert(auditLog)
      .values(
        [1, 2, 3, 4, 5, 6, 7, 8].flatMap((n) => [
          audit('progress.note', `progress:plan/repo`),
          audit('issue.open', `issue:plan/repo#${n}`),
        ]),
      );
    await t.db.execute(sql`analyze audit_log`);
    for (const limit of [3, 6]) {
      const plan = rowsOf(
        await t.db.execute(sql`
          explain (analyze, costs off, timing off, summary off)
          select id, at, actor_kind, actor_id, action, target, after, ok from audit_log
          where id > 0 and ${issueEventsFilter}
          order by id asc limit ${sql.raw(String(limit))}`),
      )
        .map((r) => Object.values(r).join(' '))
        .join('\n');
      expect(plan).toContain('audit_log_ledger_events_idx');
      expect(plan).not.toMatch(/Seq Scan/);
      expect(plan).not.toMatch(/Rows Removed by Filter/);
      expect(plan).toMatch(new RegExp(`actual rows=${limit}\\b`));
    }
    // 只收 progress: 的读（比如以后单独筛）也走同一个索引
    const planProgress = rowsOf(
      await t.db.execute(sql`
        explain (analyze, costs off, timing off, summary off)
        select id from audit_log where id > 0 and ${issueEventsFilter} order by id asc limit 4`),
    )
      .map((r) => Object.values(r).join(' '))
      .join('\n');
    expect(planProgress).toContain('audit_log_ledger_events_idx');
  });

  it('表里有大批别的操作记录时，读口照样走部分索引：没有顺序扫、没有被过滤掉的行，读的行数等于返回条数', async () => {
    // 前面五个账本行之后，塞三万条不相干的记录，再放五条账本行：往后读时必须跳过这三万条而不是一条条扫过去
    const lastLedgerBeforeNoise = (await listIssueEvents(t.db, { after: 0, limit: 1000 })).at(-1)?.id ?? 0;
    await t.db.execute(sql`
      insert into audit_log (actor_kind, actor_id, action, target, via)
      select 'ops', 'x', 'noise', 'task:' || g, 'ops' from generate_series(1, 30000) g`);
    await t.db
      .insert(auditLog)
      .values([1, 2, 3, 4, 5].map((n) => audit('issue.open', `issue:late/repo#${n}`)));
    await t.db.execute(sql`analyze audit_log`);

    const lastId = (await listIssueEvents(t.db, { after: 0, limit: 1000 })).at(-1)?.id ?? 0;
    // 往后读：after 落在噪声之前（前面几条测试留下的最后一条账本行），要读到的是噪声后面的账本行
    const skipFrom = lastLedgerBeforeNoise;
    const probe = await listIssueEvents(t.db, { after: skipFrom, limit: 3 });
    expect(probe.map((e) => e.target)).toEqual([
      'issue:late/repo#1',
      'issue:late/repo#2',
      'issue:late/repo#3',
    ]);
    expect(lastId).toBeGreaterThan(30000);

    // 和读口同一个 where / order / limit，换成 EXPLAIN (ANALYZE)（参数代成字面量）
    const plan = rowsOf(
      await t.db.execute(sql`
        explain (analyze, costs off, timing off, summary off)
        select id, at, actor_kind, actor_id, action, target, after, ok from audit_log
        where id > ${skipFrom} and ${issueEventsFilter}
        order by id asc limit 3`),
    )
      .map((r) => Object.values(r).join(' '))
      .join('\n');
    expect(plan).toContain('audit_log_ledger_events_idx');
    expect(plan).not.toMatch(/Seq Scan/);
    expect(plan).not.toMatch(/Rows Removed by Filter/);
    expect(plan).toMatch(/actual rows=3\b/);
  });
});
