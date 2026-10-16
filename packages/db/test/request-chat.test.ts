// 指挥官会话（#2061）引擎那头的读写：接手排着的一轮、写回话和草稿补丁（白名单、人改过的转「建议改」）、
// 没接上写「指挥官暂停了」、闲置收会话、引擎重启收卡住的；表上的约束。
import { eq } from 'drizzle-orm';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import type { Db } from '../src/client.ts';
import {
  claimRequestChat,
  failRequestChat,
  finishCommanderReply,
  finishRequestReview,
  forgetRequestChatSession,
  idleRequestChats,
  recoverRunningRequestChats,
  requestChatStopRequested,
  writeRequestChatProgress,
} from '../src/queries/request-chat.ts';
import { auditLog, requestChats, requestMessages, requests, users } from '../src/schema/index.ts';
import { createTestDb, resetTestDb, TEST_DB_TIMEOUT_MS, type TestDb } from '../src/testing.ts';
import { addRepo, ago, DAY, expectViolation, NOW } from './helpers.ts';

let t: TestDb;
beforeAll(async () => {
  t = await createTestDb();
}, TEST_DB_TIMEOUT_MS);
afterAll(() => t.close());
beforeEach(() => resetTestDb(t));

const MIN = 60_000;
const NO_SESSION = { sessionId: null, routeId: null, modelId: null, workdir: null };

async function fixture(db: Db, over: Partial<typeof requests.$inferInsert> = {}) {
  const repo = await addRepo(db, 'canary');
  const [founder] = await db.insert(users).values({ displayName: '甲', role: 'founder' }).returning();
  if (!founder) throw new Error('没建成用户');
  const [r] = await db
    .insert(requests)
    .values({
      repoId: repo.id,
      initiatorId: founder.id,
      draftJson: { title: '导出', scene: '人写的场景' },
      humanEditedFields: ['scene'],
      lastActivityAt: ago(DAY),
      ...over,
    })
    .returning();
  if (!r) throw new Error('没建成需求');
  await db.insert(requestMessages).values({
    requestId: r.id,
    kind: 'human',
    authorId: founder.id,
    channel: 'web',
    body: '想要一个导出按钮',
    createdAt: ago(MIN),
  });
  return { repo, founder, r };
}

async function queue(db: Db, requestId: string, job: 'reply' | 'review' = 'reply') {
  await db.insert(requestChats).values({ requestId, state: 'queued', job, queuedAt: ago(MIN) });
}

describe('接手排着的一轮', () => {
  it('最早排的那条改成 running，交回草稿、人改过的栏、全部消息；没有排着的回 null', async () => {
    const { r } = await fixture(t.db);
    await queue(t.db, r.id);
    const got = await claimRequestChat(t.db, NOW);
    expect(got).toMatchObject({
      requestId: r.id,
      seq: r.seq,
      job: 'reply',
      draft: { title: '导出' },
      humanEdited: ['scene'],
      repo: { owner: 'acme', name: 'canary' },
      session: NO_SESSION,
    });
    expect(got?.messages.map((m) => [m.kind, m.authorName, m.body])).toEqual([
      ['human', '甲', '想要一个导出按钮'],
    ]);
    const [chat] = await t.db.select().from(requestChats);
    expect(chat).toMatchObject({ state: 'running', phase: 'thinking', streamText: '' });
    expect(await claimRequestChat(t.db, NOW)).toBeNull();
  });

  it('需求删了或结案了：不接，撤回 idle，接着找下一条', async () => {
    const { r } = await fixture(t.db, { deletedAt: ago(MIN) });
    await queue(t.db, r.id);
    expect(await claimRequestChat(t.db, NOW)).toBeNull();
    const [chat] = await t.db.select().from(requestChats);
    expect(chat).toMatchObject({ state: 'idle', job: null });
  });
});

describe('写回话：草稿补丁只改那九栏，人改过的转「建议改」', () => {
  it('能改的改进草稿（版本加 1），人改过的「场景」不改、另起一条建议改，白名单外的拒掉记操作记录', async () => {
    const { r } = await fixture(t.db);
    await queue(t.db, r.id);
    await claimRequestChat(t.db, NOW);
    const got = await finishCommanderReply(t.db, {
      requestId: r.id,
      reply: '我看了导出那块，先问一个。',
      question: { text: '导出给谁？', options: ['自己', '客户'] },
      patch: { title: '订单导出按钮', scene: '指挥官想改场景', status: 'closed_do' },
      session: { sessionId: 's-1', routeId: 'route-1', modelId: 'sonnet-5.5', workdir: '/w/1' },
      now: NOW,
    });
    expect(got).toMatchObject({ written: true, applied: ['title'], suggested: ['scene'], draftVersion: 2 });
    expect(got.rejected).toEqual([{ field: 'status', why: '不在指挥官能改的栏里' }]);

    const [after] = await t.db.select().from(requests).where(eq(requests.id, r.id));
    expect(after?.draftJson).toEqual({ title: '订单导出按钮', scene: '人写的场景' });
    expect(after?.draftVersion).toBe(2);
    expect(after?.humanEditedFields).toEqual(['scene']);

    const msgs = await t.db.select().from(requestMessages).where(eq(requestMessages.requestId, r.id));
    const commander = msgs.filter((m) => m.kind === 'commander');
    expect(commander[0]).toMatchObject({
      body: '我看了导出那块，先问一个。',
      draftPatch: { title: '订单导出按钮' },
      card: { type: 'question', question: '导出给谁？', options: ['自己', '客户'], allowOwn: true },
    });
    expect(commander[1]?.card).toEqual({ type: 'suggest', field: 'scene', value: '指挥官想改场景' });
    expect(commander[1]?.body).toContain('建议改「场景」');

    const audits = await t.db.select().from(auditLog);
    expect(audits.map((a) => a.action)).toEqual(['request.commander_patch_rejected']);
    // 没改上的栏在对话里也写一行，不只记在操作记录里
    const system = msgs.filter((m) => m.kind === 'system').map((m) => m.body);
    expect(system).toEqual(['指挥官改单子有 1 栏没改上：「status」（格式不合规矩，单子里还是原样）']);

    const [chat] = await t.db.select().from(requestChats);
    expect(chat).toMatchObject({
      state: 'idle',
      job: null,
      turns: 1,
      sessionId: 's-1',
      routeId: 'route-1',
      workdir: '/w/1',
      lastMessageId: Math.max(...msgs.map((m) => m.id)),
      pausedWhy: null,
      streamText: '',
    });
  });

  it('方案卡记下写回后的草稿版本（补丁让版本加 1），不再另挂问题卡', async () => {
    const { r } = await fixture(t.db);
    await queue(t.db, r.id);
    await claimRequestChat(t.db, NOW);
    const got = await finishCommanderReply(t.db, {
      requestId: r.id,
      reply: '方案齐了。',
      proposal: { summary: '标题：订单导出\n场景：人写的场景' },
      question: { text: '还问吗？', options: ['问', '不问'] },
      patch: { title: '订单导出' },
      session: NO_SESSION,
      now: NOW,
    });
    expect(got).toMatchObject({ written: true, applied: ['title'], draftVersion: 2 });
    const msgs = await t.db.select().from(requestMessages).where(eq(requestMessages.kind, 'commander'));
    expect(msgs[0]?.card).toEqual({
      type: 'proposal',
      draftVersion: 2,
      summary: '标题：订单导出\n场景：人写的场景',
    });
  });

  it('会话跑着时需求结案了：回话不写进去，记操作记录，会话回 idle、不算轮数', async () => {
    const { r } = await fixture(t.db);
    await queue(t.db, r.id);
    await claimRequestChat(t.db, NOW);
    await t.db
      .update(requests)
      .set({ status: 'closed_drop', closedAt: NOW, closeReason: '不要了', archivedAt: NOW })
      .where(eq(requests.id, r.id));
    const got = await finishCommanderReply(t.db, {
      requestId: r.id,
      reply: '晚到的话',
      patch: { title: '改不了' },
      session: NO_SESSION,
      now: NOW,
    });
    expect(got.written).toBe(false);
    const msgs = await t.db.select().from(requestMessages).where(eq(requestMessages.kind, 'commander'));
    expect(msgs).toEqual([]);
    expect((await t.db.select().from(auditLog)).map((a) => a.action)).toEqual([
      'request.commander_reply_dropped',
    ]);
    const [chat] = await t.db.select().from(requestChats);
    expect(chat).toMatchObject({ state: 'idle', turns: 0 });
  });
});

describe('没接上、停下、挑错', () => {
  it('没接上：系统消息「指挥官暂停了：原因」+ 暂停卡，会话回 idle，记下原因', async () => {
    const { r } = await fixture(t.db);
    await queue(t.db, r.id);
    await claimRequestChat(t.db, NOW);
    await failRequestChat(t.db, {
      requestId: r.id,
      why: '被切号停下：换组织',
      session: NO_SESSION,
      now: NOW,
    });
    const [m] = await t.db.select().from(requestMessages).where(eq(requestMessages.kind, 'system'));
    expect(m?.body).toBe('指挥官暂停了：被切号停下：换组织');
    expect(m?.card).toEqual({ type: 'paused', why: '指挥官暂停了：被切号停下：换组织' });
    const [chat] = await t.db.select().from(requestChats);
    expect(chat).toMatchObject({ state: 'idle', pausedWhy: '指挥官暂停了：被切号停下：换组织' });
  });

  it('有人点了停下：边跑边写那一下回 stop；只看停没停也认', async () => {
    const { r } = await fixture(t.db);
    await queue(t.db, r.id);
    await claimRequestChat(t.db, NOW);
    expect(await writeRequestChatProgress(t.db, r.id, { phase: 'reading_code', text: '' }, NOW)).toEqual({
      stop: false,
    });
    expect(await requestChatStopRequested(t.db, r.id)).toBe(false);
    await t.db.update(requestChats).set({ stopRequestedAt: NOW }).where(eq(requestChats.requestId, r.id));
    expect(await writeRequestChatProgress(t.db, r.id, { phase: 'writing', text: '写到一半' }, NOW)).toEqual({
      stop: true,
    });
    expect(await requestChatStopRequested(t.db, r.id)).toBe(true);
  });

  it('别家挑错回来：一张意见卡，每条没标；不算轮数', async () => {
    const { r } = await fixture(t.db);
    await queue(t.db, r.id, 'review');
    await claimRequestChat(t.db, NOW);
    await finishRequestReview(t.db, {
      requestId: r.id,
      draftVersion: 1,
      model: 'gpt-5.6-luna',
      items: ['缺回退', '验收条看不见'],
      now: NOW,
    });
    const [m] = await t.db.select().from(requestMessages).where(eq(requestMessages.kind, 'review'));
    expect(m?.card).toEqual({
      type: 'review',
      draftVersion: 1,
      model: 'gpt-5.6-luna',
      items: [
        { text: '缺回退', verdict: null },
        { text: '验收条看不见', verdict: null },
      ],
    });
    const [chat] = await t.db.select().from(requestChats);
    expect(chat).toMatchObject({ state: 'idle', turns: 0 });
  });
});

describe('闲置收会话、引擎重启', () => {
  it('闲着、会话活着、上一轮在 30 分钟前：列出来；清掉后会话号和检出都空了；中间又起了一轮的不清', async () => {
    const { r } = await fixture(t.db);
    await t.db.insert(requestChats).values({
      requestId: r.id,
      sessionId: 's',
      routeId: 'route',
      modelId: 'm',
      workdir: '/w/old',
      lastTurnAt: ago(31 * MIN),
    });
    const cutoff = ago(30 * MIN);
    expect(await idleRequestChats(t.db, cutoff)).toEqual([{ requestId: r.id, workdir: '/w/old' }]);

    await t.db
      .update(requestChats)
      .set({ state: 'queued', job: 'reply' })
      .where(eq(requestChats.requestId, r.id));
    expect(await forgetRequestChatSession(t.db, { requestId: r.id, workdir: '/w/old', now: NOW })).toBe(
      false,
    );

    await t.db.update(requestChats).set({ state: 'idle', job: null }).where(eq(requestChats.requestId, r.id));
    expect(await forgetRequestChatSession(t.db, { requestId: r.id, workdir: '/w/old', now: NOW })).toBe(true);
    const [chat] = await t.db.select().from(requestChats);
    expect(chat).toMatchObject(NO_SESSION);
    expect(await idleRequestChats(t.db, cutoff)).toEqual([]);
  });

  it('引擎重启：卡在 running 的写「指挥官暂停了：引擎重启了」，会话清掉', async () => {
    const { r } = await fixture(t.db);
    await t.db
      .insert(requestChats)
      .values({ requestId: r.id, state: 'running', job: 'reply', workdir: '/w/x', sessionId: 's' });
    expect(await recoverRunningRequestChats(t.db, NOW)).toBe(1);
    const [chat] = await t.db.select().from(requestChats);
    expect(chat).toMatchObject({ state: 'idle', ...NO_SESSION });
    expect(chat?.pausedWhy).toContain('引擎重启了');
  });
});

describe('表上的约束', () => {
  it('闲着不能挂着活、排着一定有活；状态认不出的拒；卡片要是对象', async () => {
    const { r } = await fixture(t.db);
    await expectViolation(
      t.db.insert(requestChats).values({ requestId: r.id, state: 'idle', job: 'reply' }),
      'request_chats_job_shape',
    );
    await expectViolation(
      t.db.insert(requestChats).values({ requestId: r.id, state: 'queued' }),
      'request_chats_job_shape',
    );
    await expectViolation(
      t.db.insert(requestChats).values({ requestId: r.id, state: 'paused' as never, job: 'reply' }),
      'request_chats_state_known',
    );
    await expectViolation(
      t.db.insert(requestMessages).values({
        requestId: r.id,
        kind: 'system',
        body: 'x',
        card: ['不是对象'] as never,
        createdAt: NOW,
      }),
      'request_messages_card_object',
    );
  });

  it('需求硬删时会话一起删（级联）', async () => {
    const { r } = await fixture(t.db);
    await queue(t.db, r.id);
    await t.db.delete(requests).where(eq(requests.id, r.id));
    expect(await t.db.select().from(requestChats)).toEqual([]);
  });
});
