// 验收：网关的真客户端（packages/feishu 的 createBackend，香港那边跑的同一份代码）对着后端跑一遍，库是 PGlite 上的真迁移。
// 记一句 → 回复确认卡改一句 → 卡上改一下 → 确认（开成任务）→ 查任务 → 关注 → 盘面 → 推送与回执 → 卡片登记。
// 开单（开 issue、建任务、拉起工作流）归 #43 接，这里用假的：像真的一样在库里建一行任务。
// 只有真库才试得出的（半个 emoji 进 jsonb 被拒）也放这里。
import {
  asks,
  feishuDrafts,
  feishuFollows,
  idempotencyKeys,
  notificationDeliveries,
  tasks,
} from '@fleet-dao/db';
import { createTestDb, TEST_DB_TIMEOUT_MS, type TestDb } from '@fleet-dao/db/testing';
import { BackendError, createBackend } from '@fleet-dao/feishu';
import { AskResponse, FeishuDraftConflictDetails } from '@fleet-dao/shared';
import { count, eq, like } from 'drizzle-orm';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import {
  type DraftOpener,
  DraftOpenerUnavailableError,
  type DraftOpenRequest,
  type DraftOpenResult,
} from '../src/ports.ts';
import type { Harness } from './harness.ts';
import { agentRequest, GATEWAY_PASS, IDS, pgHarness, T0 } from './harness.ts';

const A = { openId: 'ou_dev_founder_a' };
const B = { openId: 'ou_dev_founder_b' };

let t: TestDb;
beforeAll(async () => {
  t = await createTestDb();
}, TEST_DB_TIMEOUT_MS);
afterAll(() => t.close());

let current: Awaited<ReturnType<typeof pgHarness>> | undefined;
afterEach(async () => {
  await current?.stop();
  current = undefined;
});

/** 网关的真客户端；fetch 直接交给后端的 Hono 应用（不开端口），其余（通行证、代表人头、超时、按约定校验返回）照原样。 */
function gatewayClient(h: Harness) {
  const doFetch = (async (input: Parameters<typeof fetch>[0], init?: RequestInit) =>
    h.cockpit.request(input, init)) as typeof fetch;
  return createBackend({
    baseUrl: 'http://fleet-api.test',
    gatewayToken: GATEWAY_PASS,
    fetch: doFetch,
    timeoutMs: 5_000,
  });
}

/**
 * 假开单：没接上时抛「没接上」；接上后在库里建一行任务（像 #43 的真实现一样）。按草稿编号幂等，而且记在库里
 * （idempotency_keys）：后端发版重启后会马上再调（ports.ts 的 DraftOpener），记在进程内存里的扛不住。
 * 这里的「issue」就是库里那行任务，和记号同一个事务写；真实现的 issue 开在 GitHub 上、进不了这个事务，
 * 要先在库里占住再开、开出来马上记下 issue 号，或者 issue 正文带上草稿编号、再来时查回来。
 */
function fakeOpener() {
  let wired = false;
  const calls: DraftOpenRequest[] = [];
  const opener: DraftOpener = {
    async check() {
      if (!wired) throw new Error('开单还没接上（测试）');
    },
    async open(req) {
      calls.push(req);
      if (!wired) throw new DraftOpenerUnavailableError('开单还没接上（测试）');
      return t.db.transaction(async (tx) => {
        const key = `test-draft-open:${req.draftId}`;
        const [seen] = await tx
          .select({ result: idempotencyKeys.result })
          .from(idempotencyKeys)
          .where(eq(idempotencyKeys.key, key));
        if (seen) return seen.result as DraftOpenResult;
        const [before] = await tx
          .select({ n: count() })
          .from(idempotencyKeys)
          .where(like(idempotencyKeys.key, 'test-draft-open:%'));
        const issueNumber = 44 + (before?.n ?? 0);
        const [row] = await tx
          .insert(tasks)
          .values({
            repoId: req.repo.id,
            issueNumber,
            title: req.title,
            rawRequest: req.rawText,
            requestedBy: req.proposedBy.userId,
            priority: 5,
          })
          .returning({ id: tasks.id });
        if (!row) throw new Error('任务行没建成');
        const result: DraftOpenResult = { taskId: row.id, issueNumber };
        await tx.insert(idempotencyKeys).values({
          key,
          action: 'test.draft_open',
          target: `draft:${req.draftId}`,
          completedAt: new Date(),
          result,
        });
        return result;
      });
    },
  };
  return {
    opener,
    calls,
    wire() {
      wired = true;
    },
  };
}

async function rejected(p: Promise<unknown>): Promise<BackendError> {
  try {
    await p;
  } catch (err) {
    if (err instanceof BackendError) return err;
    throw err;
  }
  throw new Error('应当被后端拒收，却成功了');
}

describe('网关的真客户端对着后端跑一遍（真库）', () => {
  it('记一句 → 确认 → 查任务 → 关注 → 盘面 → 推送与回执 → 卡片登记，全通', async () => {
    const opener = fakeOpener();
    opener.wire();
    const h = await pgHarness(t, { draftOpener: opener.opener });
    current = h;
    const gateway = gatewayClient(h);

    // —— 记一句：按原话记成草稿，标拿不准；样例只有一个仓，就放那个仓 ——
    const said = await gateway.understand(A, {
      sourceMessageId: 'om_e2e_1',
      text: '给登录页加手机验证码',
      chatType: 'group',
    });
    if (said.kind !== 'draft') throw new Error('应当记成草稿');
    const draftId = said.draft.id;
    expect(said.draft).toMatchObject({
      revision: 1,
      status: 'open',
      unsure: true,
      repo: { id: IDS.repo, fullName: 'example/canary' },
      proposedBy: '创始人甲',
    });
    // 网关重试同一条消息：同一个草稿。
    const retried = await gateway.understand(A, {
      sourceMessageId: 'om_e2e_1',
      text: '给登录页加手机验证码',
      chatType: 'group',
    });
    expect(retried.kind === 'draft' && retried.draft.id).toBe(draftId);

    // —— 卡片登记：网关回了确认卡，登记它；回复这张卡就是改理解，交回带 cardMessageId 的草稿 ——
    await gateway.putCard({
      messageId: 'om_card_1',
      chatId: 'oc_team',
      kind: 'draft',
      ref: { draftId },
      sentAt: T0.toISOString(),
    });
    const replied = await gateway.understand(A, {
      sourceMessageId: 'om_e2e_2',
      text: '验证码要 6 位',
      chatType: 'group',
      replyToMessageId: 'om_card_1',
    });
    expect(replied).toMatchObject({
      kind: 'draft',
      draft: { id: draftId, revision: 2, cardMessageId: 'om_card_1' },
    });

    // —— 卡上「改一下」，同一个请求编号重试只改一次 ——
    const revised = await gateway.reviseDraft(A, draftId, {
      requestId: 'req-1',
      note: '同一手机号 60 秒只能发一次',
    });
    expect(revised.revision).toBe(3);
    expect(
      (await gateway.reviseDraft(A, draftId, { requestId: 'req-1', note: '同一手机号 60 秒只能发一次' }))
        .revision,
    ).toBe(3);
    expect(revised.understanding).toBe(
      '给登录页加手机验证码\n补充：验证码要 6 位\n补充：同一手机号 60 秒只能发一次',
    );

    // —— 确认：看的是旧版本就 409（带上新的，网关换卡）；看的是新版本就开成任务 ——
    const stale = await rejected(gateway.confirmDraft(B, draftId, { revision: 1 }));
    expect({ status: stale.status, code: stale.code }).toEqual({ status: 409, code: 'draft_changed' });
    expect(FeishuDraftConflictDetails.parse(stale.details).draft.revision).toBe(3);
    const confirmed = await gateway.confirmDraft(B, draftId, { revision: 3 });
    expect(confirmed).toMatchObject({
      alreadyConfirmed: false,
      draft: {
        status: 'confirmed',
        confirmedBy: '创始人乙',
        task: { repo: 'example/canary', issueNumber: 44 },
      },
    });
    const taskId = confirmed.draft.task?.taskId;
    if (!taskId) throw new Error('应当开成任务');
    expect(opener.calls.map((c) => [c.draftId, c.title, c.confirmedBy.name])).toEqual([
      [draftId, '给登录页加手机验证码', '创始人乙'],
    ]);
    // 另一位也点了确认：同一个任务，不开第二个。
    expect(await gateway.confirmDraft(A, draftId, { revision: 3 })).toMatchObject({
      alreadyConfirmed: true,
      draft: { task: { taskId } },
    });
    const [row] = await t.db.select().from(feishuDrafts).where(eq(feishuDrafts.id, draftId));
    expect(row).toMatchObject({ status: 'confirmed', taskId, confirmedBy: IDS.founderB });

    // —— 查任务、看详情（驾驶舱接口）——
    expect((await gateway.findTasks(A, 44)).matches).toEqual([
      { taskId, repo: 'example/canary', issueNumber: 44, title: '给登录页加手机验证码', state: 'queued' },
    ]);
    expect((await gateway.task(A, taskId)).task).toMatchObject({ id: taskId, issueNumber: 44 });

    // —— 关注 ——
    expect(await gateway.follow(A, taskId, true)).toBe(true);
    expect(await gateway.follow(A, taskId, true)).toBe(true);
    expect(await t.db.select().from(feishuFollows)).toMatchObject([
      { taskId, userId: IDS.founderA, following: true },
    ]);

    // —— 盘面：从库里算；置顶的盘面卡登记后，快照里找得回来 ——
    const board = await gateway.board();
    expect(board.counts).toMatchObject({ running: 2, stalled: 0 });
    expect(board.active.map((a) => a.issueNumber).sort()).toEqual([12, 44]);
    expect(board.teamBoardCard).toBeNull();
    await gateway.putCard({
      messageId: 'om_board',
      chatId: 'oc_team',
      kind: 'board',
      ref: {},
      sentAt: T0.toISOString(),
    });
    expect((await gateway.board()).teamBoardCard).toEqual({
      messageId: 'om_board',
      sentAt: T0.toISOString(),
    });

    // —— 推送与回执：会话里 AI 追问一句 → 待推送里有一张问题卡 → 回执「发了」→ 不再给 ——
    const asked = AskResponse.parse(
      await (
        await h.agent.request(
          '/agent/v1/ask',
          agentRequest(h.agentToken(), 'POST', {
            question: '验证码用哪家短信？',
            options: ['阿里云', '腾讯云'],
            blocking: false,
          }),
        )
      ).json(),
    );
    const askItemId = `ask:${asked.askId}`;
    const first = await gateway.outbox(0);
    expect(first.items.map((i) => i.id).sort()).toEqual(
      [askItemId, `notification:${IDS.notification1}`].sort(),
    );
    expect(first.items.find((i) => i.id === askItemId)).toMatchObject({
      kind: 'ask',
      revision: 1,
      title: '验证码用哪家短信？',
      options: ['阿里云', '腾讯云'],
      askId: asked.askId,
      issueNumber: 12,
    });
    await gateway.ackOutbox(
      first.items.map((item, n) => ({
        itemId: item.id,
        revision: item.revision,
        result: { status: 'sent', messageId: `om_push_${n}`, chatId: 'oc_team', sentAt: T0.toISOString() },
      })),
    );
    expect((await gateway.outbox(0)).items).toEqual([]);
    // 通知类的送达记进了通知的送达记录。
    expect(
      await t.db
        .select({ target: notificationDeliveries.target, messageId: notificationDeliveries.messageId })
        .from(notificationDeliveries)
        .where(eq(notificationDeliveries.notificationId, IDS.notification1)),
    ).toContainEqual({ target: 'team', messageId: expect.stringMatching(/^om_push_/) });

    // 卡上点了「阿里云」（驾驶舱接口回答追问）→ 这张卡的下一版是「已回答」，带上次送到的卡，网关原地改 → 回执「改了」→ 不再给。
    await gateway.answerAsk(A, asked.askId, '阿里云');
    const next = await gateway.outbox(0);
    expect(next.items).toHaveLength(1);
    expect(next.items[0]).toMatchObject({
      id: askItemId,
      revision: 2,
      status: 'done',
      doneText: expect.stringContaining('已回答：阿里云 · 创始人甲'),
      delivered: { chatId: 'oc_team', revision: 1 },
    });
    const done = next.items[0];
    if (!done?.delivered) throw new Error('应当带上次送到的卡');
    await gateway.ackOutbox([
      { itemId: askItemId, revision: 2, result: { status: 'updated', messageId: done.delivered.messageId } },
    ]);
    expect((await gateway.outbox(0)).items).toEqual([]);

    // —— 后端拒收时，网关拿到的是带 code 的明确错误 ——
    const badQuery = await rejected(gateway.findTasks(A, 0));
    expect({ status: badQuery.status, code: badQuery.code }).toEqual({ status: 400, code: 'invalid_query' });
    const stranger = await rejected(gateway.findTasks({ openId: 'ou_nobody' }, 12));
    expect({ status: stranger.status, code: stranger.code }).toEqual({
      status: 403,
      code: 'not_whitelisted',
    });
  });

  it('开单还没接上：确认照样记下、进「待开单」；接上后补开，任务查得到，不丢', async () => {
    const opener = fakeOpener();
    const h = await pgHarness(t, { draftOpener: opener.opener });
    current = h;
    const gateway = gatewayClient(h);
    const said = await gateway.understand(A, {
      sourceMessageId: 'om_pending',
      text: '加个导出按钮',
      chatType: 'p2p',
    });
    if (said.kind !== 'draft') throw new Error('应当记成草稿');
    const pending = await gateway.confirmDraft(A, said.draft.id, { revision: 1 });
    expect(pending).toMatchObject({ alreadyConfirmed: false, draft: { status: 'confirmed' } });
    expect(pending.draft.task).toBeUndefined();
    const [row] = await t.db.select().from(feishuDrafts).where(eq(feishuDrafts.id, said.draft.id));
    expect(row).toMatchObject({ taskId: null, openAttempts: 1, openError: '开单还没接上（测试）' });

    opener.wire();
    expect(await h.draftOpening.runPending(true)).toEqual({ opened: 1, failed: 0 });
    const after = await gateway.confirmDraft(B, said.draft.id, { revision: 1 });
    expect(after).toMatchObject({
      alreadyConfirmed: true,
      draft: { confirmedBy: '创始人甲', task: { issueNumber: 44 } },
    });
    expect((await gateway.findTasks(A, 44)).matches.map((m) => m.title)).toEqual(['加个导出按钮']);

    // 发版重启后同一张草稿又来（新进程里的开单器，手上什么都没记）：按库里记下的交回同一个任务，不开第二张。
    const request = opener.calls.at(-1);
    if (!request) throw new Error('应当调过开单');
    const restarted = fakeOpener();
    restarted.wire();
    expect(await restarted.opener.open(request, new AbortController().signal)).toEqual({
      taskId: after.draft.task?.taskId,
      issueNumber: 44,
    });
    expect(await t.db.select({ id: tasks.id }).from(tasks).where(eq(tasks.issueNumber, 44))).toHaveLength(1);
  });

  it('原话、补充、回答里有孤立的半个 emoji（被截成两半）：库版照样记下、读得回，不 500', async () => {
    const h = await pgHarness(t, { draftOpener: fakeOpener().opener });
    current = h;
    const gateway = gatewayClient(h);
    const said = await gateway.understand(A, {
      sourceMessageId: 'om_lone_1',
      text: '加验证码\ud83d',
      chatType: 'group',
    });
    if (said.kind !== 'draft') throw new Error('应当记成草稿');
    expect(said.draft.rawText).toBe('加验证码�');

    // 回复确认卡补一句：补充写进操作记录（jsonb），半个代理对在那里会被库整条拒收。
    await gateway.putCard({
      messageId: 'om_card_lone',
      chatId: 'oc_team',
      kind: 'draft',
      ref: { draftId: said.draft.id },
      sentAt: T0.toISOString(),
    });
    expect(
      await gateway.understand(A, {
        sourceMessageId: 'om_lone_2',
        text: '\udc00只做短信',
        chatType: 'group',
        replyToMessageId: 'om_card_lone',
      }),
    ).toMatchObject({
      kind: 'draft',
      draft: { revision: 2, understanding: '加验证码�\n补充：�只做短信' },
    });

    // 回复追问卡作答：回答同样写进操作记录。
    const asked = AskResponse.parse(
      await (
        await h.agent.request(
          '/agent/v1/ask',
          agentRequest(h.agentToken(), 'POST', { question: '用哪家短信？', options: [], blocking: false }),
        )
      ).json(),
    );
    await gateway.putCard({
      messageId: 'om_ask_lone',
      chatId: 'oc_team',
      kind: 'ask',
      ref: { askId: asked.askId },
      sentAt: T0.toISOString(),
    });
    expect(
      await gateway.understand(A, {
        sourceMessageId: 'om_lone_3',
        text: '阿里云\ud83d',
        chatType: 'group',
        replyToMessageId: 'om_ask_lone',
      }),
    ).toMatchObject({ kind: 'answer', text: '已记下你的回答，AI 会接着干。' });
    const [ask] = await t.db.select().from(asks).where(eq(asks.id, asked.askId));
    expect(ask?.answer).toBe('阿里云�');
  });
});
