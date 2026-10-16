// 需求表（#2049）：定时任务 request-sweep 的一轮（删了满 30 天硬删连消息、写操作记录；已结案·不做马上归档；
// 已结案·做的单子上线或关掉满 3 天归档）、单子状态的写入口、表上的约束、迁移 0065 设的拍板人。
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { PGlite } from '@electric-sql/pglite';
import { eq } from 'drizzle-orm';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import type { Db } from '../src/client.ts';
import { MIGRATIONS_FOLDER } from '../src/migrate.ts';
import {
  appendProgressCard,
  listRequestIssuesToSync,
  readIssueTaskFacts,
  recordEngineAsk,
  recordRequestIssueState,
  requesterForRequestIssue,
  requestSeqFromIssueBody,
  sweepRequests,
} from '../src/queries/requests.ts';
import {
  asks,
  auditLog,
  requestIssueOpenings,
  requestMessages,
  requests,
  requestUserState,
  tasks,
  users,
} from '../src/schema/index.ts';
import { createTestDb, resetTestDb, TEST_DB_TIMEOUT_MS, type TestDb } from '../src/testing.ts';
import { addRepo, addSubtask, addTask, DAY, expectViolation, later, MIN, NOW } from './helpers.ts';

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
    expect(result).toEqual({ scanned: 3, purged: [old.seq], archived: [], idleClosed: [] });

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
  it('已结案·不做马上归档；已结案·做，单子上线满 3 天归档、不满不归；不满 3 天的讨论中不归档', async () => {
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
    await addRequest(t.db, f, { lastActivityAt: ago(2 * DAY) });

    const result = await sweepRequests(t.db, NOW);
    expect(result.archived.sort()).toEqual([drop.seq, shipped.seq].sort());
    expect(result.idleClosed).toEqual([]);
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
    expect(await sweepRequests(t.db, NOW)).toEqual({ scanned: 0, purged: [], archived: [], idleClosed: [] });
  });
});

describe('sweepRequests：讨论中闲置满 3 天收口', () => {
  it('满 3 天转成收口，写上闲置几天、最后一句是谁说的，并归档；差 1 毫秒、删了的、待拍板的不动', async () => {
    const f = await fixture(t.db);
    const stale = await addRequest(t.db, f, { lastActivityAt: ago(3 * DAY) });
    const almost = await addRequest(t.db, f, { lastActivityAt: ago(3 * DAY - 1) });
    const gone = await addRequest(t.db, f, { lastActivityAt: ago(10 * DAY), deletedAt: ago(DAY) });
    const pending = await addRequest(t.db, f, {
      status: 'pending_decision',
      deciderId: f.founder.id,
      lastActivityAt: ago(10 * DAY),
    });
    const commander = await addRequest(t.db, f, { lastActivityAt: ago(5 * DAY) });
    await t.db.insert(requestMessages).values({
      requestId: commander.id,
      kind: 'commander',
      body: '你要哪种？',
      createdAt: ago(4 * DAY),
    });
    const silent = await addRequest(t.db, f, { lastActivityAt: ago(4 * DAY) });
    await t.db.delete(requestMessages).where(eq(requestMessages.requestId, silent.id));

    const result = await sweepRequests(t.db, NOW);
    expect(result.idleClosed?.sort()).toEqual([stale.seq, commander.seq, silent.seq].sort());
    expect(result.archived.sort()).toEqual([stale.seq, commander.seq, silent.seq].sort());
    expect(result.purged).toEqual([]);

    const rows = await t.db.select().from(requests);
    const bySeq = new Map(rows.map((r) => [r.seq, r]));
    expect(bySeq.get(stale.seq)).toMatchObject({
      status: 'idle_closed',
      closeReason: '闲置 3 天没动静，自动收口；最后一句是创始人说的',
    });
    expect(bySeq.get(stale.seq)?.archivedAt).toEqual(NOW);
    expect(bySeq.get(stale.seq)?.closedAt).toEqual(NOW);
    expect(bySeq.get(commander.seq)?.closeReason).toBe('闲置 5 天没动静，自动收口；最后一句是指挥官说的');
    expect(bySeq.get(silent.seq)?.closeReason).toBe('闲置 4 天没动静，自动收口；还没有人说过话');
    expect(bySeq.get(almost.seq)?.status).toBe('discussing');
    expect(bySeq.get(gone.seq)?.status).toBe('discussing');
    expect(bySeq.get(pending.seq)?.status).toBe('pending_decision');

    const sys = await t.db.select().from(requestMessages).where(eq(requestMessages.requestId, stale.id));
    expect(sys.filter((m) => m.kind === 'system').map((m) => m.body)).toEqual([
      '闲置 3 天没动静，自动收口；最后一句是创始人说的',
    ]);
    const audits = await t.db.select().from(auditLog);
    expect(audits.map((a) => a.action).sort()).toEqual([
      'request.idle_close',
      'request.idle_close',
      'request.idle_close',
    ]);

    expect((await sweepRequests(t.db, NOW)).idleClosed).toEqual([]);
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
    await expectViolation(
      addRequest(t.db, f, { status: 'idle_closed', closedAt: NOW }),
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

// —— 开单之后的联动（#2060）——

/** 一条已结案·做的需求，开出了 #12。 */
async function closedDo(f: Awaited<ReturnType<typeof fixture>>, issueNumber = 12) {
  return addRequest(t.db, f, {
    status: 'closed_do',
    deciderId: f.founder.id,
    closedAt: ago(DAY),
    issueRefs: [
      {
        repo: `${f.repo.owner}/${f.repo.name}`,
        number: issueNumber,
        state: 'open',
        stateAt: ago(DAY).toISOString(),
      },
    ],
  });
}

describe('listRequestIssuesToSync：进度同步要看的单', () => {
  it('已结案·做的需求里没上线、没关掉的单（含已合并）；上线了、关掉了、讨论中、删了、归档了的不看', async () => {
    const f = await fixture(t.db);
    const slug = `${f.repo.owner}/${f.repo.name}`;
    const ref = (number: number, state: 'open' | 'merged' | 'deployed' | 'closed') => ({
      repo: slug,
      number,
      state,
      stateAt: ago(DAY).toISOString(),
    });
    const a = await addRequest(t.db, f, {
      status: 'closed_do',
      deciderId: f.founder.id,
      closedAt: ago(DAY),
      issueRefs: [ref(1, 'open'), ref(2, 'merged'), ref(3, 'deployed'), ref(4, 'closed')],
    });
    await addRequest(t.db, f, { issueRefs: [ref(5, 'open')] });
    await addRequest(t.db, f, {
      status: 'closed_do',
      deciderId: f.founder.id,
      closedAt: ago(DAY),
      deletedAt: ago(DAY),
      issueRefs: [ref(6, 'open')],
    });
    await addRequest(t.db, f, {
      status: 'closed_do',
      deciderId: f.founder.id,
      closedAt: ago(DAY),
      archivedAt: ago(DAY),
      issueRefs: [ref(7, 'open')],
    });
    const got = await listRequestIssuesToSync(t.db);
    expect(got.map((g) => [g.seq, g.number, g.state])).toEqual([
      [a.seq, 1, 'open'],
      [a.seq, 2, 'merged'],
    ]);
    expect(got[0]).toMatchObject({ owner: f.repo.owner, name: f.repo.name, repoId: f.repo.id });
  });
});

describe('readIssueTaskFacts：引擎任务表里这张单的现状', () => {
  it('没有任务行是 null（引擎还没接），不是空对象', async () => {
    const f = await fixture(t.db);
    expect(await readIssueTaskFacts(t.db, { repoId: f.repo.id, issueNumber: 12 })).toBeNull();
  });

  it('任务状态、子任务合了几个（作废的不算）、做完的时刻、没人答的追问、卡住的原因', async () => {
    const f = await fixture(t.db);
    const task = await addTask(t.db, f.repo.id, {
      issueNumber: 12,
      state: 'running',
      lastProblem: '检查红了：lint',
    });
    await addSubtask(t.db, task.id, { index: 0, state: 'merged' });
    await addSubtask(t.db, task.id, { index: 1, state: 'running' });
    await addSubtask(t.db, task.id, { index: 2, state: 'merged', supersededAt: NOW });
    await t.db.insert(asks).values([
      { taskId: task.id, question: '要不要兼容旧接口？', options: ['要', '不要'] },
      { taskId: task.id, question: '已经答过的', answer: '好', answeredBy: 'u', answeredAt: NOW },
    ]);
    const facts = await readIssueTaskFacts(t.db, { repoId: f.repo.id, issueNumber: 12 });
    expect(facts).toMatchObject({
      taskId: task.id,
      state: 'running',
      why: '检查红了：lint',
      subtasks: { total: 2, merged: 1 },
      doneAt: null,
    });
    expect(facts?.openAsks.map((a) => [a.question, a.options])).toEqual([
      ['要不要兼容旧接口？', ['要', '不要']],
    ]);

    await t.db.update(tasks).set({ state: 'done' }).where(eq(tasks.id, task.id));
    const done = await readIssueTaskFacts(t.db, { repoId: f.repo.id, issueNumber: 12 });
    expect(done?.state).toBe('done');
    expect(done?.doneAt).toBeInstanceOf(Date);
  });
});

describe('appendProgressCard：对话里的进度卡', () => {
  it('追加一条系统消息并改 last_activity_at；同一张单上一张一模一样就不重复；变了再追加；别的单的卡互不影响', async () => {
    const f = await fixture(t.db);
    const r = await closedDo(f);
    const at = (n: number) => new Date(NOW.getTime() + n * 1000);
    const card = (issueNumber: number, body: string, n: number) =>
      appendProgressCard(t.db, { seq: r.seq, issueNumber, body, at: at(n) });
    expect(await card(12, '#12 动手中', 1)).toBe('appended');
    expect(await card(12, '#12 动手中', 2)).toBe('unchanged');
    expect(await card(13, '#13 动手中', 3)).toBe('appended');
    expect(await card(12, '#12 已合并，等上线', 4)).toBe('appended');
    const msgs = await t.db
      .select()
      .from(requestMessages)
      .where(eq(requestMessages.requestId, r.id))
      .orderBy(requestMessages.id);
    expect(msgs.filter((m) => m.kind === 'system').map((m) => m.body)).toEqual([
      '#12 动手中',
      '#13 动手中',
      '#12 已合并，等上线',
    ]);
    const [row] = await t.db.select().from(requests).where(eq(requests.id, r.id));
    expect(row?.lastActivityAt).toEqual(at(4));
  });

  it('【故意造出的失败】没有这条需求：返回 no_request，不抛也不写', async () => {
    expect(await appendProgressCard(t.db, { seq: 999, issueNumber: 12, body: '#12 x', at: NOW })).toBe(
      'no_request',
    );
  });
});

describe('recordEngineAsk：引擎提问进对话，绑定评论', () => {
  const url = 'https://github.com/acme/canary/issues/12#issuecomment-345';

  it('生成一条 engine_ask：绑评论网址、答复状态待答、没有说话人；同一条评论只生成一条', async () => {
    const f = await fixture(t.db);
    const r = await closedDo(f);
    expect(
      await recordEngineAsk(t.db, { seq: r.seq, commentUrl: url, body: '要不要兼容旧接口？', at: NOW }),
    ).toBe('created');
    expect(
      await recordEngineAsk(t.db, {
        seq: r.seq,
        commentUrl: url,
        body: '要不要兼容旧接口？',
        at: later(MIN),
      }),
    ).toBe('exists');
    const out = await t.db.select().from(requestMessages).where(eq(requestMessages.kind, 'engine_ask'));
    expect(out).toHaveLength(1);
    expect(out[0]).toMatchObject({
      githubCommentRef: url,
      answerState: 'pending',
      authorId: null,
      body: '要不要兼容旧接口？',
    });
    const [row] = await t.db.select().from(requests).where(eq(requests.id, r.id));
    expect(row?.lastActivityAt).toEqual(NOW);
  });

  it('【故意造出的失败】没有这条需求：返回 no_request', async () => {
    expect(await recordEngineAsk(t.db, { seq: 999, commentUrl: url, body: '?', at: NOW })).toBe('no_request');
  });

  it('表上的约束：引擎提问一定绑评论、有答复状态；别的种类不许带；答复只能记在引擎提问上', async () => {
    const f = await fixture(t.db);
    const r = await closedDo(f);
    await expectViolation(
      t.db.insert(requestMessages).values({ requestId: r.id, kind: 'engine_ask', body: '?', createdAt: NOW }),
      'request_messages_engine_ask_shape',
    );
    await expectViolation(
      t.db
        .insert(requestMessages)
        .values({ requestId: r.id, kind: 'system', body: 'x', answerState: 'pending', createdAt: NOW }),
      'request_messages_engine_ask_shape',
    );
    await expectViolation(
      t.db
        .insert(requestMessages)
        .values({ requestId: r.id, kind: 'system', body: 'x', answerText: '答', createdAt: NOW }),
      'request_messages_answer_only_on_ask',
    );
  });
});

describe('开单记录 request_issue_openings 和 requesterForRequestIssue（引擎认提出人）', () => {
  const body = (seq: number) =>
    `## 场景\n\n…\n\n## 来源\n\n提出人：乙\n来自驾驶舱 需求 ${seq}：https://fleet.example.com/intake?r=${seq}\n`;

  async function open(
    f: Awaited<ReturnType<typeof fixture>>,
    r: { id: string },
    over: Partial<typeof requestIssueOpenings.$inferInsert> = {},
  ) {
    const [p] = await t.db.insert(users).values({ displayName: '合伙人', role: 'founder' }).returning();
    if (!p) throw new Error('没建成用户');
    await t.db.insert(requestIssueOpenings).values({
      requestId: r.id,
      draftVersion: 1,
      state: 'opened',
      requestedBy: p.id,
      openedBy: f.founder.id,
      issueNumber: 12,
      issueUrl: 'https://github.com/acme/canary/issues/12',
      createdAt: NOW,
      updatedAt: NOW,
      ...over,
    });
    return p;
  }

  it('正文末尾「来自驾驶舱 需求 N」对上开单记录：返回点按钮那刻写下的提出人', async () => {
    const f = await fixture(t.db);
    const r = await closedDo(f);
    const p = await open(f, r);
    expect(
      await requesterForRequestIssue(t.db, { repoId: f.repo.id, issueNumber: 12, body: body(r.seq) }),
    ).toEqual({ requestedBy: p.id, seq: r.seq });
  });

  it('正在开（还没记号）也认：GitHub 那边单建好了、库里还没记，引擎先到的那一下', async () => {
    const f = await fixture(t.db);
    const r = await closedDo(f);
    const p = await open(f, r, { state: 'opening', issueNumber: null, issueUrl: null });
    expect(
      await requesterForRequestIssue(t.db, { repoId: f.repo.id, issueNumber: 77, body: body(r.seq) }),
    ).toEqual({ requestedBy: p.id, seq: r.seq });
  });

  it('【故意造出的失败】认不得的情形都回 null，不猜：号对不上、仓对不上、没写来源、需求号对不上', async () => {
    const f = await fixture(t.db);
    const r = await closedDo(f);
    await open(f, r);
    const ask = (over: Partial<{ repoId: string; issueNumber: number; body: string }>) =>
      requesterForRequestIssue(t.db, { repoId: f.repo.id, issueNumber: 12, body: body(r.seq), ...over });
    expect(await ask({ issueNumber: 13 })).toBeNull();
    expect(await ask({ repoId: (await addRepo(t.db, 'other')).id })).toBeNull();
    expect(await ask({ body: '## 场景\n\n没有来源\n' })).toBeNull();
    expect(await ask({ body: body(r.seq + 100) })).toBeNull();
  });

  it('开失败的记录不认：失败的那一键没有开出单', async () => {
    const f = await fixture(t.db);
    const r = await closedDo(f);
    await open(f, r, { state: 'failed', issueNumber: null, issueUrl: null, error: 'GitHub 503' });
    expect(
      await requesterForRequestIssue(t.db, { repoId: f.repo.id, issueNumber: 12, body: body(r.seq) }),
    ).toBeNull();
  });

  it('原话里引用别人的「来自驾驶舱 需求 7：」不算：认最后一处（我们自己写的来源）', async () => {
    const f = await fixture(t.db);
    const r = await closedDo(f);
    const p = await open(f, r);
    const quoted = `> 来自驾驶舱 需求 7：https://x/intake?r=7\n\n${body(r.seq)}`;
    expect(
      await requesterForRequestIssue(t.db, { repoId: f.repo.id, issueNumber: 12, body: quoted }),
    ).toEqual({
      requestedBy: p.id,
      seq: r.seq,
    });
    expect(requestSeqFromIssueBody(quoted)).toBe(r.seq);
    expect(requestSeqFromIssueBody('没有')).toBeNull();
  });

  it('开单记录上的约束：开成了一定有号和网址；没开成一定有原因；一键只有一行', async () => {
    const f = await fixture(t.db);
    const r = await closedDo(f);
    await expectViolation(open(f, r, { issueNumber: null }), 'request_issue_openings_opened_shape');
    await expectViolation(
      open(f, r, { state: 'failed', issueNumber: null, issueUrl: null, error: null }),
      'request_issue_openings_failed_has_error',
    );
    await open(f, r);
    await expectViolation(open(f, r), 'request_issue_openings_request_id_draft_version_pk');
  });
});
