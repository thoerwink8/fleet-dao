// 飞书网关的 9 条接口（shared/feishu-api.ts）：按路由表放行；每条的正常路径，和故意造出来的「参数认不出、库读不到、状态冲突」。
import {
  FeishuBoardSnapshotSchema,
  FeishuConfirmDraftResponse,
  FeishuDraftConflictDetails,
  FeishuFollowResponse,
  FeishuMessageResponse,
  FeishuOutboxResponse,
  FeishuReviseDraftResponse,
  FeishuRoutes,
  FeishuTaskLookupResponse,
} from '@fleet-dao/shared';
import { describe, expect, it, vi } from 'vitest';
import { devFixtures } from '../src/dev-fixtures.ts';
import { feishuMessageKey } from '../src/feishu-records.ts';
import { ANSWER_TEXTS } from '../src/feishu-views.ts';
import type { MemoryData } from '../src/memory-store.ts';
import {
  type DraftOpener,
  DraftOpenerUnavailableError,
  type DraftOpenRequest,
  type DraftOpenResult,
} from '../src/ports.ts';
import { errorCode, GATEWAY_PASS, harness, IDS, T0 } from './harness.ts';
import { FEISHU_IDS, feishuData } from './store-contract-feishu.ts';

const A = 'ou_dev_founder_a';
const B = 'ou_dev_founder_b';
const MIN = 60_000;
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

function gw(
  method: 'GET' | 'POST' | 'PUT',
  body?: unknown,
  acting: string | null = A,
  pass: string = GATEWAY_PASS,
): RequestInit {
  return {
    method,
    headers: {
      authorization: `Bearer ${pass}`,
      ...(acting === null ? {} : { 'x-fleet-acting-feishu': acting }),
      ...(body === undefined ? {} : { 'content-type': 'application/json' }),
    },
    ...(body === undefined ? {} : { body: typeof body === 'string' ? body : JSON.stringify(body) }),
  };
}

/** 可以换行为的假开单：默认「还没接上」。 */
function openerStub() {
  const calls: DraftOpenRequest[] = [];
  let behave: (req: DraftOpenRequest) => Promise<DraftOpenResult> = async () => {
    throw new DraftOpenerUnavailableError('开单还没接上（测试）');
  };
  const opener: DraftOpener = {
    async open(req) {
      calls.push(req);
      return behave(req);
    },
    async check() {},
  };
  return {
    opener,
    calls,
    set(fn: (req: DraftOpenRequest) => Promise<DraftOpenResult>) {
      behave = fn;
    },
  };
}

type H = ReturnType<typeof harness>;

/** 让假开单像真的一样建一行任务（内存版），返回它的号。 */
function opensTask(h: () => H, issueNumber = 44) {
  return async (req: DraftOpenRequest): Promise<DraftOpenResult> => {
    const id = `b0000000-0000-4000-8000-0000000000${String(issueNumber).padStart(2, '0')}`;
    if (!h().store.data.tasks.some((t) => t.id === id)) {
      h().store.data.tasks.push({
        id,
        repoId: req.repo.id,
        issueNumber,
        title: req.title,
        rawRequest: req.rawText,
        requestedBy: req.proposedBy.userId,
        state: 'queued',
        priority: 5,
        acceptance: [],
        createdAt: T0.toISOString(),
      });
    }
    return { taskId: id, issueNumber };
  };
}

async function say(h: H, text: string, extra: Record<string, unknown> = {}, acting = A) {
  return h.cockpit.request(
    '/api/feishu/messages',
    gw(
      'POST',
      { sourceMessageId: `om_${text.length}_${Math.random()}`, text, chatType: 'group', ...extra },
      acting,
    ),
  );
}

async function newDraft(h: H, text = '给登录页加手机验证码', sourceMessageId = 'om_new') {
  const res = await h.cockpit.request(
    '/api/feishu/messages',
    gw('POST', { sourceMessageId, text, chatType: 'p2p' }),
  );
  expect(res.status).toBe(200);
  const body = FeishuMessageResponse.parse(await res.json());
  if (body.kind !== 'draft') throw new Error('应当记成草稿');
  return body.draft;
}

describe('门：按路由表逐条放行', () => {
  /** 每条路由都能走到自己的处理函数：故意给个认不出的请求，拿到的是处理函数的 400，不是 404 / 401 / 403。 */
  const probes: Record<
    keyof typeof FeishuRoutes,
    { path: string; body?: unknown; status: number; code?: string }
  > = {
    message: { path: '/api/feishu/messages', body: {}, status: 400, code: 'invalid_request' },
    reviseDraft: {
      path: `/api/feishu/drafts/${FEISHU_IDS.draft1}/revise`,
      body: {},
      status: 400,
      code: 'invalid_request',
    },
    confirmDraft: {
      path: `/api/feishu/drafts/${FEISHU_IDS.draft1}/confirm`,
      body: {},
      status: 400,
      code: 'invalid_request',
    },
    findTasks: { path: '/api/feishu/tasks', status: 400, code: 'invalid_query' },
    follow: { path: '/api/feishu/follows', body: {}, status: 400, code: 'invalid_request' },
    board: { path: '/api/feishu/board', status: 200 },
    outbox: { path: '/api/feishu/outbox?waitSeconds=0', status: 200 },
    ackOutbox: { path: '/api/feishu/outbox/acks', body: {}, status: 400, code: 'invalid_request' },
    putCard: { path: '/api/feishu/cards/om_1', body: {}, status: 400, code: 'invalid_request' },
  };

  it('每条都按表里的方法挂上了；acting=none 的不带代表人也进得去，带了陌生人也不认人', async () => {
    const h = harness();
    for (const [name, route] of Object.entries(FeishuRoutes) as Array<
      [keyof typeof FeishuRoutes, (typeof FeishuRoutes)[keyof typeof FeishuRoutes]]
    >) {
      const probe = probes[name];
      const actings = route.acting === 'required' ? [A] : [null, 'ou_nobody'];
      for (const acting of actings) {
        const res = await h.cockpit.request(probe.path, gw(route.method, probe.body, acting));
        const got = { name, acting, status: res.status, code: probe.code ? await errorCode(res) : undefined };
        expect(got).toEqual({ name, acting, status: probe.status, code: probe.code });
      }
    }
  });

  it('acting=required 的：没说代表谁 403；不是创始人（查不到、停用、协作者）403，什么都不做', async () => {
    const h = harness();
    const required = Object.entries(FeishuRoutes).filter(([, r]) => r.acting === 'required');
    expect(required.map(([n]) => n).sort()).toEqual([
      'confirmDraft',
      'findTasks',
      'follow',
      'message',
      'reviseDraft',
    ]);
    for (const [name, route] of required) {
      const probe = probes[name as keyof typeof FeishuRoutes];
      const missing = await h.cockpit.request(probe.path, gw(route.method, probe.body, null));
      expect({ name, status: missing.status, code: await errorCode(missing) }).toEqual({
        name,
        status: 403,
        code: 'acting_missing',
      });
      const stranger = await h.cockpit.request(probe.path, gw(route.method, probe.body, 'ou_nobody'));
      expect({ name, code: await errorCode(stranger) }).toEqual({ name, code: 'not_whitelisted' });
    }
    const founder = h.store.data.users.find((u) => u.id === IDS.founderA);
    if (!founder) throw new Error('样例里没有创始人甲');
    founder.role = 'collaborator';
    expect(await errorCode(await say(h, '协作者说的话'))).toBe('not_whitelisted');
    expect(h.store.data.feishuDrafts).toHaveLength(0);
  });

  it('不带通行证（浏览器登录也不行）401；通行证不对 401；没配通行证 401', async () => {
    const h = harness();
    const { cookie } = await h.login();
    for (const [name, route] of Object.entries(FeishuRoutes)) {
      const probe = probes[name as keyof typeof FeishuRoutes];
      const noPass = await h.cockpit.request(probe.path, {
        method: route.method,
        headers: { cookie, 'content-type': 'application/json' },
        ...(probe.body === undefined ? {} : { body: JSON.stringify(probe.body) }),
      });
      expect({ name, status: noPass.status, code: await errorCode(noPass) }).toEqual({
        name,
        status: 401,
        code: 'gateway_pass_missing',
      });
      const wrong = await h.cockpit.request(probe.path, gw(route.method, probe.body, A, `${GATEWAY_PASS}x`));
      expect({ name, code: await errorCode(wrong) }).toEqual({ name, code: 'bearer_not_allowed' });
    }
    const off = harness({ config: { feishuGatewayToken: null } });
    expect(await errorCode(await off.cockpit.request('/api/feishu/board', gw('GET', undefined, null)))).toBe(
      'bearer_not_allowed',
    );
  });
});

describe('POST /feishu/messages：一句话', () => {
  it('记成草稿：按原话、标拿不准；只有一个仓就放那个仓；留操作记录（via=feishu）', async () => {
    const h = harness();
    const draft = await newDraft(h);
    expect(draft).toMatchObject({
      revision: 1,
      status: 'open',
      rawText: '给登录页加手机验证码',
      understanding: '给登录页加手机验证码',
      unsure: true,
      repo: { id: IDS.repo, fullName: 'example/canary' },
      repoOptions: [{ id: IDS.repo, fullName: 'example/canary' }],
      proposedBy: '创始人甲',
      updatedAt: T0.toISOString(),
    });
    expect(draft.cardMessageId).toBeUndefined();
    expect(draft.task).toBeUndefined();
    expect(h.store.data.audit.at(-1)).toMatchObject({
      action: 'draft.create',
      target: `draft:${draft.id}`,
      via: 'feishu',
      actor: { kind: 'user', id: IDS.founderA },
    });
  });

  it('同一条消息再来（网关重试、飞书重投）：同一个草稿，不开第二个；换了话或换了人拿同一个编号来：409', async () => {
    const h = harness();
    const first = await newDraft(h, '加个导出按钮', 'om_dup');
    const again = await newDraft(h, '加个导出按钮', 'om_dup');
    expect(again.id).toBe(first.id);
    expect(h.store.data.feishuDrafts).toHaveLength(1);
    const changed = await h.cockpit.request(
      '/api/feishu/messages',
      gw('POST', { sourceMessageId: 'om_dup', text: '别的话', chatType: 'p2p' }),
    );
    expect(changed.status).toBe(409);
    expect(await errorCode(changed)).toBe('message_reused');
    const otherFounder = await h.cockpit.request(
      '/api/feishu/messages',
      gw('POST', { sourceMessageId: 'om_dup', text: '加个导出按钮', chatType: 'p2p' }, B),
    );
    expect(await errorCode(otherFounder)).toBe('message_reused');
    expect(h.store.data.feishuDrafts).toHaveLength(1);
  });

  it('参数认不出：400，不记草稿', async () => {
    const h = harness();
    const post = (body: unknown) => h.cockpit.request('/api/feishu/messages', gw('POST', body));
    for (const body of [
      {},
      { sourceMessageId: 'om_1', text: '', chatType: 'p2p' },
      { sourceMessageId: 'om_1', text: '   ', chatType: 'p2p' },
      { sourceMessageId: 'om_1', text: 'x'.repeat(4001), chatType: 'p2p' },
      { sourceMessageId: 'om_1', text: '你好', chatType: 'channel' },
      { sourceMessageId: '', text: '你好', chatType: 'p2p' },
    ]) {
      const res = await post(body);
      expect({ body, status: res.status, code: await errorCode(res) }).toEqual({
        body,
        status: 400,
        code: 'invalid_request',
      });
    }
    const notJson = await post('{不是 JSON');
    expect(await errorCode(notJson)).toBe('invalid_json');
    expect(h.store.data.feishuDrafts).toHaveLength(0);
  });

  it('几个仓：原话里恰好提到一个仓名就放那个仓，否则留空（确认时必须选）', async () => {
    const h = harness({ data: feishuData() });
    expect((await newDraft(h, '给登录页加验证码', 'om_a')).repo).toBeNull();
    expect((await newDraft(h, 'another 仓的 README 改一下', 'om_b')).repo).toEqual({
      id: FEISHU_IDS.repo2,
      fullName: 'example/another',
    });
  });

  it('回复还没确认的草稿卡：按这句话改理解，交回带 cardMessageId 的草稿（网关原地更新那张卡）；重投不再改', async () => {
    const h = harness();
    const draft = await newDraft(h);
    await h.store.putCard({
      messageId: 'om_card',
      chatId: 'oc_team',
      kind: 'draft',
      ref: { draftId: draft.id },
      sentAt: T0.toISOString(),
    });
    const reply = () =>
      h.cockpit.request(
        '/api/feishu/messages',
        gw('POST', {
          sourceMessageId: 'om_reply',
          text: '验证码要 6 位',
          chatType: 'group',
          replyToMessageId: 'om_card',
        }),
      );
    const body = FeishuMessageResponse.parse(await (await reply()).json());
    expect(body).toMatchObject({
      kind: 'draft',
      draft: {
        id: draft.id,
        revision: 2,
        understanding: '给登录页加手机验证码\n补充：验证码要 6 位',
        cardMessageId: 'om_card',
      },
    });
    const again = FeishuMessageResponse.parse(await (await reply()).json());
    expect(again).toMatchObject({ kind: 'draft', draft: { revision: 2 } });
    expect(h.store.data.feishuDrafts).toHaveLength(1);
  });

  it('回复已经确认的草稿卡：不改，回一句「待开单（会自动补开）/ 已经开成任务」', async () => {
    const stub = openerStub();
    const h = harness({ draftOpener: stub.opener });
    const draft = await newDraft(h);
    await h.store.putCard({
      messageId: 'om_card',
      chatId: 'oc_team',
      kind: 'draft',
      ref: { draftId: draft.id },
      sentAt: T0.toISOString(),
    });
    await h.cockpit.request(`/api/feishu/drafts/${draft.id}/confirm`, gw('POST', { revision: 1 }));
    const pending = FeishuMessageResponse.parse(
      await (await say(h, '再加一条', { replyToMessageId: 'om_card' })).json(),
    );
    expect(pending).toEqual({
      kind: 'answer',
      text: '这张卡已经确认了，待开单：开 issue 那一步还没做成，后台会自动补开，不会丢；开好后驾驶舱里就有这个任务。',
    });
    stub.set(opensTask(() => h));
    await h.draftOpening.runPending(true);
    const opened = FeishuMessageResponse.parse(
      await (await say(h, '再加一条', { replyToMessageId: 'om_card' })).json(),
    );
    expect(opened).toMatchObject({ kind: 'answer', text: expect.stringContaining('#44（example/canary）') });
    expect(h.store.data.feishuDrafts[0]?.revision).toBe(1);
  });

  it('回复 AI 追问卡：这句话就是回答——写库、留操作记录、发信号给工作流；重投不记两次', async () => {
    const h = harness({ data: feishuData() });
    await h.store.putCard({
      messageId: 'om_ask_card',
      chatId: 'oc_team',
      kind: 'ask',
      ref: { askId: FEISHU_IDS.askOpen, taskId: IDS.task12, outboxId: `ask:${FEISHU_IDS.askOpen}` },
      sentAt: T0.toISOString(),
    });
    const reply = () =>
      h.cockpit.request(
        '/api/feishu/messages',
        gw('POST', {
          sourceMessageId: 'om_answer',
          text: '6 位',
          chatType: 'group',
          replyToMessageId: 'om_ask_card',
        }),
      );
    const body = FeishuMessageResponse.parse(await (await reply()).json());
    expect(body).toEqual({ kind: 'answer', text: '已记下你的回答，AI 会接着干。', taskId: IDS.task12 });
    expect(h.store.data.asks.find((a) => a.id === FEISHU_IDS.askOpen)).toMatchObject({
      answer: '6 位',
      answeredBy: IDS.founderA,
    });
    expect(h.store.data.audit.at(-1)).toMatchObject({
      action: 'ask.answer',
      via: 'feishu',
      target: `task:${IDS.task12}`,
    });
    expect(h.signals).toEqual([
      {
        taskId: IDS.task12,
        signal: { name: 'answer', by: IDS.founderA, askId: FEISHU_IDS.askOpen, answer: '6 位' },
      },
    ]);
    expect(FeishuMessageResponse.parse(await (await reply()).json())).toEqual(body);
    expect(h.signals).toHaveLength(1);
    expect(h.store.data.audit.filter((a) => a.action === 'ask.answer')).toHaveLength(1);
  });

  it('回复别人已经答过的追问卡：不改答案，明说已经有人答了', async () => {
    const h = harness({ data: feishuData() });
    await h.store.putCard({
      messageId: 'om_ask_card',
      chatId: 'oc_team',
      kind: 'ask',
      ref: { askId: FEISHU_IDS.askAnswered },
      sentAt: T0.toISOString(),
    });
    const body = FeishuMessageResponse.parse(
      await (await say(h, '用腾讯云', { replyToMessageId: 'om_ask_card' })).json(),
    );
    expect(body).toEqual({
      kind: 'answer',
      text: '这个问题已经回答过了（创始人乙：阿里云），这句没有记成新的回答。',
      taskId: IDS.task12,
    });
    expect(h.store.data.asks.find((a) => a.id === FEISHU_IDS.askAnswered)?.answer).toBe('阿里云');
    expect(h.signals).toHaveLength(0);
  });

  it('回复「要人拍」的卡只算追问、不算拍板；回复别的卡（进度卡）带着这张卡的任务回一句答不了的实话', async () => {
    const h = harness({ data: feishuData() });
    await h.store.putCard({
      messageId: 'om_decision',
      chatId: 'oc_team',
      kind: 'decision',
      ref: { askId: FEISHU_IDS.askOpen, taskId: IDS.task12 },
      sentAt: T0.toISOString(),
    });
    await h.store.putCard({
      messageId: 'om_progress',
      chatId: 'oc_x',
      kind: 'progress',
      ref: { taskId: IDS.task12 },
      sentAt: T0.toISOString(),
    });
    const decision = FeishuMessageResponse.parse(
      await (await say(h, '批准', { replyToMessageId: 'om_decision' })).json(),
    );
    expect(decision).toMatchObject({
      kind: 'answer',
      text: expect.stringContaining('回复不算拍板'),
      taskId: IDS.task12,
    });
    expect(h.store.data.asks.find((a) => a.id === FEISHU_IDS.askOpen)?.answer).toBeUndefined();
    const progress = FeishuMessageResponse.parse(
      await (await say(h, '为什么卡住？', { replyToMessageId: 'om_progress' })).json(),
    );
    expect(progress).toMatchObject({
      kind: 'answer',
      text: expect.stringContaining('还答不了追问'),
      taskId: IDS.task12,
    });
    expect(h.store.data.feishuDrafts).toHaveLength(0);
  });

  it('回复的不是登记过的卡（回复了别人的话）：当成新的一句话', async () => {
    const h = harness();
    const body = FeishuMessageResponse.parse(
      await (await say(h, '加个导出', { replyToMessageId: 'om_someone' })).json(),
    );
    expect(body.kind).toBe('draft');
  });

  it('回复的草稿卡对应的草稿读不到：如实说这句没记下（记日志），不另起一张新草稿；重投回同一句', async () => {
    const h = harness();
    await h.store.putCard({
      messageId: 'om_ghost_draft',
      chatId: 'oc_team',
      kind: 'draft',
      ref: { draftId: FEISHU_IDS.draft2 },
      sentAt: T0.toISOString(),
    });
    const reply = () =>
      say(h, '验证码要 6 位', { replyToMessageId: 'om_ghost_draft', sourceMessageId: 'om_r' });
    const body = FeishuMessageResponse.parse(await (await reply()).json());
    expect(body).toEqual({ kind: 'answer', text: ANSWER_TEXTS.draftMissing });
    expect(h.store.data.feishuDrafts).toHaveLength(0);
    expect(h.logs.find((l) => l.message.includes('草稿读不到'))).toMatchObject({
      level: 'warn',
      fields: { draftId: FEISHU_IDS.draft2, cardMessageId: 'om_ghost_draft' },
    });
    expect(FeishuMessageResponse.parse(await (await reply()).json())).toEqual(body);
    expect(h.store.data.feishuDrafts).toHaveLength(0);
  });

  it('回复没确认的草稿卡、改的那一刻草稿没了（改草稿回 not_found）：一样如实说没记下，不另起草稿', async () => {
    const h = harness();
    const draft = await newDraft(h);
    await h.store.putCard({
      messageId: 'om_card',
      chatId: 'oc_team',
      kind: 'draft',
      ref: { draftId: draft.id },
      sentAt: T0.toISOString(),
    });
    vi.spyOn(h.store, 'reviseDraft').mockResolvedValueOnce({ status: 'not_found' });
    const body = FeishuMessageResponse.parse(
      await (await say(h, '改成 6 位', { replyToMessageId: 'om_card' })).json(),
    );
    expect(body).toEqual({ kind: 'answer', text: ANSWER_TEXTS.draftMissing });
    expect(h.store.data.feishuDrafts).toHaveLength(1);
  });

  it('回复的追问卡对应的追问读不到（登记里有、库里没有，或答的那一刻没了）：如实说没记成回答，不回「还答不了」把回答吞掉', async () => {
    const h = harness({ data: feishuData() });
    await h.store.putCard({
      messageId: 'om_ghost_ask',
      chatId: 'oc_team',
      kind: 'ask',
      ref: { askId: '10000000-0000-4000-8000-0000000000ff', taskId: IDS.task12 },
      sentAt: T0.toISOString(),
    });
    const ghost = FeishuMessageResponse.parse(
      await (await say(h, '6 位', { replyToMessageId: 'om_ghost_ask' })).json(),
    );
    expect(ghost).toEqual({ kind: 'answer', text: ANSWER_TEXTS.askMissing, taskId: IDS.task12 });
    expect(h.logs.find((l) => l.message.includes('追问读不到'))?.level).toBe('warn');

    await h.store.putCard({
      messageId: 'om_ask_card',
      chatId: 'oc_team',
      kind: 'ask',
      ref: { askId: FEISHU_IDS.askOpen },
      sentAt: T0.toISOString(),
    });
    vi.spyOn(h.store, 'answerAsk').mockResolvedValueOnce('not_found');
    const gone = FeishuMessageResponse.parse(
      await (await say(h, '6 位', { replyToMessageId: 'om_ask_card' })).json(),
    );
    expect(gone).toEqual({ kind: 'answer', text: ANSWER_TEXTS.askMissing, taskId: IDS.task12 });
    expect(h.signals).toEqual([]);
    expect(h.store.data.asks.find((a) => a.id === FEISHU_IDS.askOpen)?.answer).toBeUndefined();
  });

  it('原话里有孤立的半个 emoji（被截成两半）：入口换成 �、记日志，照样记成草稿；回复草稿卡、改一下也一样', async () => {
    const h = harness();
    const res = await h.cockpit.request(
      '/api/feishu/messages',
      gw('POST', { sourceMessageId: 'om_lone', text: '加验证码\ud83d', chatType: 'p2p' }),
    );
    expect(res.status).toBe(200);
    const body = FeishuMessageResponse.parse(await res.json());
    if (body.kind !== 'draft') throw new Error('应当记成草稿');
    expect(body.draft.rawText).toBe('加验证码�');
    expect(body.draft.understanding).toBe('加验证码�');
    expect(h.logs.find((l) => l.message.includes('半个 emoji'))?.fields).toMatchObject({
      sourceMessageId: 'om_lone',
      replaced: 1,
    });
    // 同一条消息再来（原话还是那半个 emoji）：认得出是同一条，不 409。
    const again = await h.cockpit.request(
      '/api/feishu/messages',
      gw('POST', { sourceMessageId: 'om_lone', text: '加验证码\ud83d', chatType: 'p2p' }),
    );
    expect(FeishuMessageResponse.parse(await again.json())).toMatchObject({ draft: { id: body.draft.id } });

    const revised = FeishuReviseDraftResponse.parse(
      await (
        await h.cockpit.request(
          `/api/feishu/drafts/${body.draft.id}/revise`,
          gw('POST', { requestId: 'r1', note: '\ude00要 6 位' }),
        )
      ).json(),
    );
    expect(revised.draft.understanding).toBe('加验证码�\n补充：�要 6 位');
    expect(h.store.data.audit.at(-1)).toMatchObject({ action: 'draft.revise', after: { note: '�要 6 位' } });
  });

  it('库读不到：500，不回草稿也不回「记下了」', async () => {
    const h = harness();
    vi.spyOn(h.store, 'getFeishuMessage').mockRejectedValueOnce(new Error('connection refused'));
    const res = await say(h, '加个导出');
    expect(res.status).toBe(500);
    expect(await errorCode(res)).toBe('internal');
    vi.spyOn(h.store, 'createDraft').mockRejectedValueOnce(new Error('connection refused'));
    expect((await say(h, '加个导出')).status).toBe(500);
    expect(h.store.data.feishuDrafts).toHaveLength(0);
  });

  it('这条消息的幂等记录认不出、幂等键被别的命令占着：500，不当成「没处理过」再记一遍', async () => {
    const h = harness();
    h.store.data.idempotency.set(feishuMessageKey('om_broken'), {
      action: 'feishu.message',
      claimedAt: T0.toISOString(),
      completedAt: T0.toISOString(),
      result: { userId: IDS.founderA, result: { kind: '别的' } },
    });
    h.store.data.idempotency.set(feishuMessageKey('om_taken'), {
      action: 'fleet.say',
      claimedAt: T0.toISOString(),
    });
    for (const sourceMessageId of ['om_broken', 'om_taken']) {
      const res = await say(h, '加个导出', { sourceMessageId });
      expect({ sourceMessageId, status: res.status, code: await errorCode(res) }).toEqual({
        sourceMessageId,
        status: 500,
        code: 'internal',
      });
    }
    expect(h.logs.some((l) => String(l.fields?.error).includes('格式认不出'))).toBe(true);
    expect(h.logs.some((l) => String(l.fields?.error).includes('被别的命令（fleet.say）占着'))).toBe(true);
    expect(h.store.data.feishuDrafts).toHaveLength(0);
  });

  it('消息记成的草稿库里没有（draft_missing）、草稿读不全（draft_unreadable）：500，不编一张草稿', async () => {
    const h = harness();
    const draft = await newDraft(h, '加个导出', 'om_x');
    // 草稿放的仓不在了：卡片要的仓名查不出来。
    const repos = h.store.data.repos;
    h.store.data.repos = [];
    const unreadable = await h.cockpit.request(
      '/api/feishu/messages',
      gw('POST', { sourceMessageId: 'om_x', text: '加个导出', chatType: 'p2p' }),
    );
    expect({ status: unreadable.status, code: await errorCode(unreadable) }).toEqual({
      status: 500,
      code: 'draft_unreadable',
    });
    h.store.data.repos = repos;
    h.store.data.feishuDrafts = h.store.data.feishuDrafts.filter((d) => d.id !== draft.id);
    const missing = await h.cockpit.request(
      '/api/feishu/messages',
      gw('POST', { sourceMessageId: 'om_x', text: '加个导出', chatType: 'p2p' }),
    );
    expect({ status: missing.status, code: await errorCode(missing) }).toEqual({
      status: 500,
      code: 'draft_missing',
    });
    expect(h.store.data.feishuDrafts).toHaveLength(0);
  });
});

describe('POST /feishu/drafts/:draftId/revise：改一下', () => {
  it('按补充改、换仓；同一个请求编号再来只改一次', async () => {
    const h = harness({ data: feishuData() });
    const draft = await newDraft(h);
    const revise = (body: unknown) =>
      h.cockpit.request(`/api/feishu/drafts/${draft.id}/revise`, gw('POST', body));
    const r1 = FeishuReviseDraftResponse.parse(
      await (await revise({ requestId: 'r1', note: '只做短信' })).json(),
    );
    expect(r1.draft).toMatchObject({ revision: 2, understanding: '给登录页加手机验证码\n补充：只做短信' });
    const again = FeishuReviseDraftResponse.parse(
      await (await revise({ requestId: 'r1', note: '只做短信' })).json(),
    );
    expect(again.draft.revision).toBe(2);
    const moved = FeishuReviseDraftResponse.parse(
      await (await revise({ requestId: 'r2', repoId: FEISHU_IDS.repo2 })).json(),
    );
    expect(moved.draft).toMatchObject({
      revision: 3,
      repo: { id: FEISHU_IDS.repo2, fullName: 'example/another' },
    });
    expect(h.store.data.audit.filter((a) => a.action === 'draft.revise')).toHaveLength(2);
  });

  it('参数认不出 400；没有这张草稿 404；没有这个仓 422；已确认的 409（带上现在的草稿）', async () => {
    const h = harness();
    const draft = await newDraft(h);
    const revise = (id: string, body: unknown) =>
      h.cockpit.request(`/api/feishu/drafts/${id}/revise`, gw('POST', body));
    for (const body of [
      { requestId: 'r' },
      { requestId: 'r', note: '   ' },
      { note: 'x' },
      { requestId: '', note: 'x' },
    ]) {
      expect({ body, code: await errorCode(await revise(draft.id, body)) }).toEqual({
        body,
        code: 'invalid_request',
      });
    }
    for (const id of ['not-a-uuid', FEISHU_IDS.draft2]) {
      const res = await revise(id, { requestId: 'r', note: 'x' });
      expect({ id, status: res.status, code: await errorCode(res) }).toEqual({
        id,
        status: 404,
        code: 'draft_not_found',
      });
    }
    const noRepo = await revise(draft.id, { requestId: 'r', repoId: FEISHU_IDS.repo2 });
    expect({ status: noRepo.status, code: await errorCode(noRepo) }).toEqual({
      status: 422,
      code: 'repo_not_found',
    });
    await h.cockpit.request(`/api/feishu/drafts/${draft.id}/confirm`, gw('POST', { revision: 1 }));
    const late = await revise(draft.id, { requestId: 'r-late', note: '晚了' });
    expect(late.status).toBe(409);
    const body = (await late.json()) as { error: { code: string; message: string; details: unknown } };
    expect(body.error.code).toBe('draft_confirmed');
    // 待开单时不说「已经开成任务」。
    expect(body.error.message).toBe('已经确认了（待开单），这张卡改不了；开好后驾驶舱里就有这个任务');
    expect(FeishuDraftConflictDetails.parse(body.error.details).draft).toMatchObject({
      id: draft.id,
      status: 'confirmed',
    });
  });

  it('已开成任务的再改：409 写明开成了哪一号', async () => {
    const stub = openerStub();
    const h = harness({ draftOpener: stub.opener });
    stub.set(opensTask(() => h));
    const draft = await newDraft(h);
    await h.cockpit.request(`/api/feishu/drafts/${draft.id}/confirm`, gw('POST', { revision: 1 }));
    const late = await h.cockpit.request(
      `/api/feishu/drafts/${draft.id}/revise`,
      gw('POST', { requestId: 'r-late', note: '晚了' }),
    );
    const body = (await late.json()) as { error: { code: string; message: string } };
    expect(body.error).toMatchObject({
      code: 'draft_confirmed',
      message: '已经确认了（已开成 #44），这张卡改不了；要改需求请在驾驶舱里改',
    });
  });

  it('长原话（「我理解为」已经截满 1000 字）再改一下：补的这句整句留下（接在原话后面、理解里截旧的），不被吞', async () => {
    const h = harness();
    const long = '原'.repeat(1500);
    const draft = await newDraft(h, long);
    expect(draft.understanding).toHaveLength(1000);
    const revised = FeishuReviseDraftResponse.parse(
      await (
        await h.cockpit.request(
          `/api/feishu/drafts/${draft.id}/revise`,
          gw('POST', { requestId: 'r1', note: '验证码要 6 位' }),
        )
      ).json(),
    );
    expect(revised.draft.revision).toBe(2);
    expect(revised.draft.understanding.length).toBeLessThanOrEqual(1000);
    expect(revised.draft.understanding.endsWith('…\n补充：验证码要 6 位')).toBe(true);
    expect(revised.draft.rawText).toBe(`${long}\n补充：验证码要 6 位`);

    // 回复确认卡补一句也一样。
    await h.store.putCard({
      messageId: 'om_card',
      chatId: 'oc_team',
      kind: 'draft',
      ref: { draftId: draft.id },
      sentAt: T0.toISOString(),
    });
    const replied = FeishuMessageResponse.parse(
      await (await say(h, '同一手机号 60 秒只能发一次', { replyToMessageId: 'om_card' })).json(),
    );
    if (replied.kind !== 'draft') throw new Error('应当交回改好的草稿');
    expect(replied.draft.understanding.endsWith('…\n补充：同一手机号 60 秒只能发一次')).toBe(true);
    expect(replied.draft.rawText).toBe(`${long}\n补充：验证码要 6 位\n补充：同一手机号 60 秒只能发一次`);
  });

  it('补的这句本身超过 800 字：不改（「我理解为」放不下整句），卡上改一下 422、回复卡回一句说明；原来的草稿不动', async () => {
    const h = harness();
    const draft = await newDraft(h);
    const tooLong = '补'.repeat(801);
    const res = await h.cockpit.request(
      `/api/feishu/drafts/${draft.id}/revise`,
      gw('POST', { requestId: 'r1', note: tooLong }),
    );
    expect({ status: res.status, code: await errorCode(res) }).toEqual({
      status: 422,
      code: 'note_too_long',
    });
    await h.store.putCard({
      messageId: 'om_card',
      chatId: 'oc_team',
      kind: 'draft',
      ref: { draftId: draft.id },
      sentAt: T0.toISOString(),
    });
    const replied = FeishuMessageResponse.parse(
      await (await say(h, tooLong, { replyToMessageId: 'om_card' })).json(),
    );
    expect(replied).toEqual({ kind: 'answer', text: ANSWER_TEXTS.noteTooLong });
    expect(h.store.data.feishuDrafts[0]).toMatchObject({ revision: 1, rawText: '给登录页加手机验证码' });
    // 正好 800 字的照样整句留下。
    const fits = FeishuReviseDraftResponse.parse(
      await (
        await h.cockpit.request(
          `/api/feishu/drafts/${draft.id}/revise`,
          gw('POST', { requestId: 'r2', note: '补'.repeat(800) }),
        )
      ).json(),
    );
    expect(fits.draft.understanding).toBe(`给登录页加手机验证码\n补充：${'补'.repeat(800)}`);
  });

  it('库读不到：500，不回旧草稿冒充改好了', async () => {
    const h = harness();
    const draft = await newDraft(h);
    vi.spyOn(h.store, 'reviseDraft').mockRejectedValueOnce(new Error('connection refused'));
    const res = await h.cockpit.request(
      `/api/feishu/drafts/${draft.id}/revise`,
      gw('POST', { requestId: 'r', note: 'x' }),
    );
    expect({ status: res.status, code: await errorCode(res) }).toEqual({ status: 500, code: 'internal' });
  });
});

describe('POST /feishu/drafts/:draftId/confirm：确认', () => {
  it('开单接上了：当场开成任务，记下确认人，查得到任务', async () => {
    const stub = openerStub();
    const h = harness({ draftOpener: stub.opener });
    stub.set(opensTask(() => h));
    const draft = await newDraft(h, '给登录页加手机验证码\n要 6 位');
    const res = await h.cockpit.request(
      `/api/feishu/drafts/${draft.id}/confirm`,
      gw('POST', { revision: 1 }, B),
    );
    expect(res.status).toBe(200);
    const body = FeishuConfirmDraftResponse.parse(await res.json());
    expect(body).toMatchObject({
      alreadyConfirmed: false,
      draft: {
        status: 'confirmed',
        confirmedBy: '创始人乙',
        proposedBy: '创始人甲',
        task: { repo: 'example/canary', issueNumber: 44 },
      },
    });
    expect(stub.calls).toEqual([
      {
        draftId: draft.id,
        repo: expect.objectContaining({ id: IDS.repo }),
        title: '给登录页加手机验证码',
        rawText: '给登录页加手机验证码\n要 6 位',
        understanding: '给登录页加手机验证码\n要 6 位',
        proposedBy: { userId: IDS.founderA, name: '创始人甲' },
        confirmedBy: { userId: IDS.founderB, name: '创始人乙' },
      },
    ]);
    const found = FeishuTaskLookupResponse.parse(
      await (await h.cockpit.request('/api/feishu/tasks?issue=44', gw('GET'))).json(),
    );
    expect(found.matches).toEqual([
      {
        taskId: body.draft.task?.taskId,
        repo: 'example/canary',
        issueNumber: 44,
        title: '给登录页加手机验证码',
        state: 'queued',
      },
    ]);
    expect(h.store.data.audit.at(-1)).toMatchObject({
      action: 'draft.confirm',
      via: 'feishu',
      actor: { id: IDS.founderB },
    });
  });

  it('开单还没接上：确认照样记下，进「待开单」（原因记在草稿上）；接上后补开，不丢', async () => {
    const stub = openerStub();
    const h = harness({ draftOpener: stub.opener });
    const draft = await newDraft(h);
    const body = FeishuConfirmDraftResponse.parse(
      await (
        await h.cockpit.request(`/api/feishu/drafts/${draft.id}/confirm`, gw('POST', { revision: 1 }))
      ).json(),
    );
    expect(body.alreadyConfirmed).toBe(false);
    expect(body.draft.status).toBe('confirmed');
    expect(body.draft.task).toBeUndefined();
    expect(h.store.data.feishuDrafts[0]).toMatchObject({
      openAttempts: 1,
      openError: '开单还没接上（测试）',
    });
    expect((await h.store.listDraftsToOpen(10)).map((d) => d.id)).toEqual([draft.id]);

    // 退避：刚失败过，这一轮不到点不试。
    expect(await h.draftOpening.runPending()).toEqual({ opened: 0, failed: 0 });
    stub.set(opensTask(() => h));
    expect(await h.draftOpening.runPending(true)).toEqual({ opened: 1, failed: 0 });
    expect(await h.store.listDraftsToOpen(10)).toEqual([]);
    const again = FeishuConfirmDraftResponse.parse(
      await (
        await h.cockpit.request(`/api/feishu/drafts/${draft.id}/confirm`, gw('POST', { revision: 1 }, B))
      ).json(),
    );
    expect(again).toMatchObject({
      alreadyConfirmed: true,
      draft: { confirmedBy: '创始人甲', task: { issueNumber: 44 } },
    });
  });

  it('开单出别的错、回的任务库里没有：都留在待开单、记下原因，不装作开成了', async () => {
    const stub = openerStub();
    const h = harness({ draftOpener: stub.opener });
    stub.set(async () => {
      throw new Error('GitHub 502');
    });
    const d1 = await newDraft(h, '第一句', 'om_1');
    const r1 = FeishuConfirmDraftResponse.parse(
      await (
        await h.cockpit.request(`/api/feishu/drafts/${d1.id}/confirm`, gw('POST', { revision: 1 }))
      ).json(),
    );
    expect(r1.draft.task).toBeUndefined();
    expect(h.store.data.feishuDrafts[0]?.openError).toBe('开单出错：GitHub 502');
    stub.set(async () => ({ taskId: '99999999-0000-4000-8000-000000000000', issueNumber: 9 }));
    const d2 = await newDraft(h, '第二句', 'om_2');
    const r2 = FeishuConfirmDraftResponse.parse(
      await (
        await h.cockpit.request(`/api/feishu/drafts/${d2.id}/confirm`, gw('POST', { revision: 1 }))
      ).json(),
    );
    expect(r2.draft.task).toBeUndefined();
    expect(h.store.data.feishuDrafts[1]?.openError).toContain('在库里找不到');
    expect(h.logs.some((l) => l.level === 'error' && l.message.includes('待开单'))).toBe(true);
  });

  it('开单实现永远不回：确认只等几秒就回「待开单」；到一次开单的时限记「开单超时」，算没成', async () => {
    const stub = openerStub();
    stub.set(() => new Promise(() => {}));
    const h = harness({ draftOpener: stub.opener, draftOpenLimits: { confirmWaitMs: 50, callLimitMs: 200 } });
    const draft = await newDraft(h);
    const started = Date.now();
    const body = FeishuConfirmDraftResponse.parse(
      await (
        await h.cockpit.request(`/api/feishu/drafts/${draft.id}/confirm`, gw('POST', { revision: 1 }))
      ).json(),
    );
    expect(Date.now() - started).toBeLessThan(1_000);
    expect(body.draft.status).toBe('confirmed');
    expect(body.draft.task).toBeUndefined();
    // 没等到结果不等于没成：到时限之前不记失败。
    expect(h.store.data.feishuDrafts[0]?.openAttempts).toBe(0);
    await sleep(350);
    expect(h.store.data.feishuDrafts[0]).toMatchObject({
      openAttempts: 1,
      openError: '开单超时：0.2 秒没回',
    });
    expect(h.logs.find((l) => l.fields?.error === '开单超时：0.2 秒没回')?.level).toBe('warn');
  });

  it('超时的那次调用还挂着：再点确认、补开都不开第二次，也不干等；补开一轮照样跑完', async () => {
    const stub = openerStub();
    stub.set(() => new Promise(() => {}));
    const h = harness({
      draftOpener: stub.opener,
      draftOpenLimits: { confirmWaitMs: 300, callLimitMs: 100 },
    });
    const draft = await newDraft(h);
    const confirm = (as: string) =>
      h.cockpit.request(`/api/feishu/drafts/${draft.id}/confirm`, gw('POST', { revision: 1 }, as));
    // 确认等得比一次开单的时限还久：到时限就记超时、回「待开单」。
    expect((await confirm(A)).status).toBe(200);
    expect(h.store.data.feishuDrafts[0]).toMatchObject({
      openAttempts: 1,
      openError: '开单超时：0.1 秒没回',
    });
    const t1 = Date.now();
    const again = FeishuConfirmDraftResponse.parse(await (await confirm(B)).json());
    expect(again).toMatchObject({ alreadyConfirmed: true, draft: { status: 'confirmed' } });
    expect(Date.now() - t1).toBeLessThan(250);
    expect(await h.draftOpening.runPending(true)).toEqual({ opened: 0, failed: 0 });
    expect(stub.calls).toHaveLength(1);
    expect(h.store.data.feishuDrafts[0]?.openAttempts).toBe(1);
  });

  it('超时之后实现又开成了：照样记上任务，不丢', async () => {
    const stub = openerStub();
    const h = harness({ draftOpener: stub.opener, draftOpenLimits: { confirmWaitMs: 20, callLimitMs: 50 } });
    const open = opensTask(() => h);
    stub.set(async (req) => {
      await sleep(150);
      return open(req);
    });
    const draft = await newDraft(h);
    await h.cockpit.request(`/api/feishu/drafts/${draft.id}/confirm`, gw('POST', { revision: 1 }));
    await sleep(100);
    expect(h.store.data.feishuDrafts[0]).toMatchObject({
      openAttempts: 1,
      openError: '开单超时：0.05 秒没回',
    });
    await sleep(200);
    expect(h.store.data.feishuDrafts[0]).toMatchObject({ taskId: 'b0000000-0000-4000-8000-000000000044' });
    expect(h.store.data.feishuDrafts[0]?.openError).toBeUndefined();
    expect(await h.store.listDraftsToOpen(10)).toEqual([]);
  });

  it('后台补开正开着（慢）时又点确认：确认只等几秒，不跟着后台等到网关超时；不开第二次', async () => {
    const stub = openerStub();
    const h = harness({
      draftOpener: stub.opener,
      draftOpenLimits: { confirmWaitMs: 50, callLimitMs: 5_000 },
    });
    const draft = await newDraft(h);
    await h.cockpit.request(`/api/feishu/drafts/${draft.id}/confirm`, gw('POST', { revision: 1 }));
    const open = opensTask(() => h);
    stub.set(async (req) => {
      await sleep(400);
      return open(req);
    });
    const round = h.draftOpening.runPending(true);
    await sleep(20);
    const t1 = Date.now();
    const again = FeishuConfirmDraftResponse.parse(
      await (
        await h.cockpit.request(`/api/feishu/drafts/${draft.id}/confirm`, gw('POST', { revision: 1 }, B))
      ).json(),
    );
    expect(Date.now() - t1).toBeLessThan(300);
    expect(again.draft.task).toBeUndefined();
    expect(await round).toEqual({ opened: 1, failed: 0 });
    // 一次「还没接上」加一次后台的慢调用：确认没有再开第二次。
    expect(stub.calls).toHaveLength(2);
  });

  it('草稿刚被改过（版本对不上）409 带上新的；没选仓 422 带上草稿；没有这个仓 422；没有这张草稿 404；参数认不出 400', async () => {
    const h = harness({ data: feishuData() });
    const draft = await newDraft(h);
    const confirm = (id: string, body: unknown) =>
      h.cockpit.request(`/api/feishu/drafts/${id}/confirm`, gw('POST', body));
    const noRepo = await confirm(draft.id, { revision: 1 });
    expect(noRepo.status).toBe(422);
    const noRepoBody = (await noRepo.json()) as { error: { code: string; details: unknown } };
    expect(noRepoBody.error.code).toBe('repo_required');
    expect(FeishuDraftConflictDetails.parse(noRepoBody.error.details).draft.id).toBe(draft.id);
    expect(await errorCode(await confirm(draft.id, { revision: 1, repoId: IDS.task12 }))).toBe(
      'repo_not_found',
    );

    await h.cockpit.request(
      `/api/feishu/drafts/${draft.id}/revise`,
      gw('POST', { requestId: 'r1', note: '改一下' }),
    );
    const stale = await confirm(draft.id, { revision: 1, repoId: IDS.repo });
    expect(stale.status).toBe(409);
    const staleBody = (await stale.json()) as { error: { code: string; details: unknown } };
    expect(staleBody.error.code).toBe('draft_changed');
    expect(FeishuDraftConflictDetails.parse(staleBody.error.details).draft).toMatchObject({
      revision: 2,
      status: 'open',
    });

    for (const id of ['nope', FEISHU_IDS.draft2]) {
      expect(await errorCode(await confirm(id, { revision: 1 }))).toBe('draft_not_found');
    }
    for (const body of [{}, { revision: 0 }, { revision: 'x' }]) {
      expect(await errorCode(await confirm(draft.id, body))).toBe('invalid_request');
    }
    const ok = await confirm(draft.id, { revision: 2, repoId: IDS.repo });
    expect(ok.status).toBe(200);
  });

  it('库读不到：500，不回「已确认」', async () => {
    const h = harness();
    const draft = await newDraft(h);
    vi.spyOn(h.store, 'confirmDraft').mockRejectedValueOnce(new Error('connection refused'));
    const res = await h.cockpit.request(
      `/api/feishu/drafts/${draft.id}/confirm`,
      gw('POST', { revision: 1 }),
    );
    expect({ status: res.status, code: await errorCode(res) }).toEqual({ status: 500, code: 'internal' });
    expect(h.store.data.feishuDrafts[0]?.status).toBe('open');
  });
});

describe('GET /feishu/tasks：按 issue 号查', () => {
  it('几个仓都有这个号就都给，按仓名排；没有就是空列表（查过了，真没有）', async () => {
    const h = harness({ data: feishuData() });
    const body = FeishuTaskLookupResponse.parse(
      await (await h.cockpit.request('/api/feishu/tasks?issue=12', gw('GET'))).json(),
    );
    expect(body.matches).toEqual([
      {
        taskId: FEISHU_IDS.task2of12,
        repo: 'example/another',
        issueNumber: 12,
        title: '另一个仓的 12 号',
        state: 'queued',
      },
      {
        taskId: IDS.task12,
        repo: 'example/canary',
        issueNumber: 12,
        title: '登录页加验证码',
        state: 'running',
      },
    ]);
    const none = FeishuTaskLookupResponse.parse(
      await (await h.cockpit.request('/api/feishu/tasks?issue=999', gw('GET'))).json(),
    );
    expect(none.matches).toEqual([]);
  });

  it('参数认不出 400；库读不到 500（不回空列表）；任务挂的仓不在库里 500（不编仓名）', async () => {
    const h = harness();
    for (const q of ['', '?issue=', '?issue=abc', '?issue=0', '?issue=-3', '?issue=1.5']) {
      const res = await h.cockpit.request(`/api/feishu/tasks${q}`, gw('GET'));
      expect({ q, status: res.status, code: await errorCode(res) }).toEqual({
        q,
        status: 400,
        code: 'invalid_query',
      });
    }
    const repos = h.store.data.repos;
    h.store.data.repos = [];
    const orphan = await h.cockpit.request('/api/feishu/tasks?issue=12', gw('GET'));
    expect({ status: orphan.status, code: await errorCode(orphan) }).toEqual({
      status: 500,
      code: 'repo_missing',
    });
    h.store.data.repos = repos;
    vi.spyOn(h.store, 'findTasksByIssue').mockRejectedValueOnce(new Error('connection refused'));
    const res = await h.cockpit.request('/api/feishu/tasks?issue=12', gw('GET'));
    expect({ status: res.status, code: await errorCode(res) }).toEqual({ status: 500, code: 'internal' });
  });
});

describe('POST /feishu/follows：关注', () => {
  it('关注、取消关注；重复点不重复记操作记录', async () => {
    const h = harness();
    const follow = async (f: boolean) =>
      FeishuFollowResponse.parse(
        await (
          await h.cockpit.request('/api/feishu/follows', gw('POST', { taskId: IDS.task12, follow: f }))
        ).json(),
      );
    expect(await follow(true)).toEqual({ taskId: IDS.task12, following: true });
    expect(await follow(true)).toEqual({ taskId: IDS.task12, following: true });
    expect(h.store.data.feishuFollows).toEqual([
      { taskId: IDS.task12, userId: IDS.founderA, following: true, updatedAt: T0.toISOString() },
    ]);
    expect(await follow(false)).toEqual({ taskId: IDS.task12, following: false });
    expect(h.store.data.audit.map((a) => [a.action, a.target, a.via])).toEqual([
      ['task.follow', `task:${IDS.task12}`, 'feishu'],
      ['task.unfollow', `task:${IDS.task12}`, 'feishu'],
    ]);
  });

  it('没有这个任务 404；参数认不出 400；库读不到 500', async () => {
    const h = harness();
    const post = (body: unknown) => h.cockpit.request('/api/feishu/follows', gw('POST', body));
    expect(await errorCode(await post({ taskId: FEISHU_IDS.draft1, follow: true }))).toBe('task_not_found');
    for (const body of [
      {},
      { taskId: IDS.task12 },
      { taskId: '', follow: true },
      { taskId: IDS.task12, follow: 'yes' },
    ]) {
      expect(await errorCode(await post(body))).toBe('invalid_request');
    }
    vi.spyOn(h.store, 'setFollow').mockRejectedValueOnce(new Error('connection refused'));
    expect((await post({ taskId: IDS.task12, follow: true })).status).toBe(500);
  });
});

describe('GET /feishu/board：盘面快照', () => {
  it('从库里算：在干的（带此刻在干什么）、快清零还剩不少的额度；读数太旧的额度不上；还没发过盘面卡', async () => {
    const h = harness();
    const snap = FeishuBoardSnapshotSchema.parse(
      await (await h.cockpit.request('/api/feishu/board', gw('GET', undefined, null))).json(),
    );
    expect(snap.asOf).toBe(T0.toISOString());
    expect(snap.counts).toEqual({ running: 1, stalled: 0, waitingForYou: 0, mergedToday: 0 });
    expect(snap.active).toEqual([
      {
        taskId: IDS.task12,
        repo: 'example/canary',
        issueNumber: 12,
        title: '登录页加验证码',
        state: 'running',
        progress: { done: 0, total: 2 },
        activity: 'Opus 5.5 正在写验证码过期的测试',
      },
    ]);
    expect(snap.quota).toEqual([
      {
        poolName: 'Claude 订阅',
        window: '5h',
        label: '5h',
        remaining: expect.closeTo(0.58, 5),
        resetsAt: new Date(T0.getTime() + 120 * MIN).toISOString(),
        reading: 'measured',
      },
    ]);
    expect(snap.teamBoardCard).toBeNull();
    expect(snap.stalled).toEqual([]);
    expect(snap.waiting).toEqual([]);
  });

  it('卡住的（最久的在前、写明卡在哪）、等你们的（追问 + 要人拍，最早的在前）、今天合并的、置顶的盘面卡', async () => {
    const h = harness({ data: feishuData() });
    const task12 = h.store.data.tasks.find((t) => t.id === IDS.task12);
    if (!task12) throw new Error('没有 12');
    task12.state = 'stalled';
    h.store.data.stateChanges.push(
      {
        id: '901',
        entity: 'task',
        entityId: IDS.task12,
        taskId: IDS.task12,
        from: 'running',
        to: 'stalled',
        at: new Date(T0.getTime() - 20 * MIN).toISOString(),
      },
      // 北京时间今天（T0 是 16:00）合并的一个，昨天合并的一个。
      {
        id: '902',
        entity: 'subtask',
        entityId: IDS.sub12a,
        taskId: IDS.task12,
        from: 'in_merge_queue',
        to: 'merged',
        at: new Date(T0.getTime() - 60 * MIN).toISOString(),
      },
      {
        id: '903',
        entity: 'subtask',
        entityId: IDS.sub12b,
        taskId: IDS.task12,
        from: 'in_merge_queue',
        to: 'merged',
        at: new Date(T0.getTime() - 17 * 60 * MIN).toISOString(),
      },
    );
    await h.store.putCard({
      messageId: 'om_board',
      chatId: 'oc_team',
      kind: 'board',
      ref: {},
      sentAt: T0.toISOString(),
    });
    const snap = FeishuBoardSnapshotSchema.parse(
      await (await h.cockpit.request('/api/feishu/board', gw('GET', undefined, null))).json(),
    );
    expect(snap.counts).toEqual({ running: 1, stalled: 1, waitingForYou: 2, mergedToday: 1 });
    expect(snap.stalled).toEqual([
      {
        taskId: IDS.task12,
        repo: 'example/canary',
        issueNumber: 12,
        title: '登录页加验证码',
        since: new Date(T0.getTime() - 20 * MIN).toISOString(),
        why: '任务 12 卡住了',
      },
    ]);
    expect(snap.waiting).toEqual([
      {
        kind: 'ask',
        askId: FEISHU_IDS.askOpen,
        taskId: IDS.task12,
        repo: 'example/canary',
        issueNumber: 12,
        title: '验证码几位？\n4 位还是 6 位',
        since: new Date(T0.getTime() - 5 * MIN).toISOString(),
      },
      {
        kind: 'decision',
        notificationId: FEISHU_IDS.decision,
        taskId: IDS.task12,
        repo: 'example/canary',
        issueNumber: 12,
        title: '要批：发版',
        since: new Date(T0.getTime() - 3 * MIN).toISOString(),
      },
    ]);
    expect(snap.active.map((t) => t.taskId)).toEqual([FEISHU_IDS.task2of12]);
    expect(snap.teamBoardCard).toEqual({ messageId: 'om_board', sentAt: T0.toISOString() });
  });

  it('库读不到：500，不回一份全是 0 的盘面', async () => {
    const h = harness();
    vi.spyOn(h.store, 'listOutboxSources').mockRejectedValueOnce(new Error('connection refused'));
    const res = await h.cockpit.request('/api/feishu/board', gw('GET', undefined, null));
    expect({ status: res.status, code: await errorCode(res) }).toEqual({ status: 500, code: 'internal' });
    vi.spyOn(h.store, 'countMergedSubtasksSince').mockRejectedValueOnce(new Error('connection refused'));
    expect((await h.cockpit.request('/api/feishu/board', gw('GET', undefined, null))).status).toBe(500);
  });
});

describe('GET /feishu/outbox 与 POST /feishu/outbox/acks：待推送与回执', () => {
  const outbox = async (h: H, query = '?waitSeconds=0') => {
    const res = await h.cockpit.request(`/api/feishu/outbox${query}`, gw('GET', undefined, null));
    expect(res.status).toBe(200);
    return FeishuOutboxResponse.parse(await res.json());
  };
  const ack = (h: H, acks: unknown[]) =>
    h.cockpit.request('/api/feishu/outbox/acks', gw('POST', { acks }, null));
  const sent = (itemId: string, revision: number, messageId: string) => ({
    itemId,
    revision,
    result: { status: 'sent', messageId, chatId: 'oc_team', sentAt: T0.toISOString() },
  });

  it('没答的追问、没处理的通知各一张卡（团队群），按建立先后；已经答了又从没发过卡的不给；没设免打扰就是 null', async () => {
    const h = harness({ data: feishuData() });
    const batch = await outbox(h);
    expect(batch.quietHours).toBeNull();
    expect(batch.asOf).toBe(T0.toISOString());
    expect(batch.items.map((i) => i.id)).toEqual([
      `notification:${IDS.notification1}`,
      `ask:${FEISHU_IDS.askOpen}`,
      `notification:${FEISHU_IDS.decision}`,
    ]);
    expect(batch.items[1]).toEqual({
      id: `ask:${FEISHU_IDS.askOpen}`,
      revision: 1,
      kind: 'ask',
      to: { type: 'team' },
      title: '验证码几位？',
      lines: ['4 位还是 6 位', '需求：登录页加验证码'],
      status: 'open',
      taskId: IDS.task12,
      repo: 'example/canary',
      issueNumber: 12,
      askId: FEISHU_IDS.askOpen,
      options: ['4 位', '6 位'],
      createdAt: new Date(T0.getTime() - 5 * MIN).toISOString(),
    });
    expect(batch.items[2]).toMatchObject({
      kind: 'decision',
      title: '要批：发版',
      lines: ['第一行', '第二行'],
      notificationId: FEISHU_IDS.decision,
    });
    expect(batch.items[0]).toMatchObject({ kind: 'alert', link: `/tasks/${IDS.task12}` });
  });

  it('发了就不再给；答了变成下一版（done、写明谁答的），带上上次送到的卡，网关原地改；改了也不再给', async () => {
    const h = harness({ data: feishuData() });
    const first = await outbox(h);
    const askId = `ask:${FEISHU_IDS.askOpen}`;
    expect(
      (
        await ack(
          h,
          first.items.map((i, n) => sent(i.id, i.revision, `om_${n}`)),
        )
      ).status,
    ).toBe(200);
    expect((await outbox(h)).items).toEqual([]);

    await h.store.answerAsk(
      { askId: FEISHU_IDS.askOpen, answer: '6 位', by: { kind: 'user', id: IDS.founderA } },
      {
        actor: { kind: 'user', id: IDS.founderA },
        action: 'ask.answer',
        target: `task:${IDS.task12}`,
        via: 'feishu',
        ok: true,
      },
    );
    const next = await outbox(h);
    expect(next.items).toEqual([
      expect.objectContaining({
        id: askId,
        revision: 2,
        status: 'done',
        doneText: '已回答：6 位 · 创始人甲 · 09-25 16:00',
        delivered: { messageId: 'om_1', chatId: 'oc_team', sentAt: T0.toISOString(), revision: 1 },
      }),
    ]);
    await ack(h, [{ itemId: askId, revision: 2, result: { status: 'updated', messageId: 'om_1' } }]);
    expect((await outbox(h)).items).toEqual([]);
  });

  it('免打扰推迟的到 until 之后才再给；没发成的到 retryAfter 之后再给（送不到留着下次再送）；不发了的记下原因、不再给', async () => {
    const h = harness({ data: feishuData() });
    const [n1, ask1, decision] = (await outbox(h)).items;
    if (!n1 || !ask1 || !decision) throw new Error('应当有三件');
    const alertNote = h.store.data.notifications.find((n) => n.id === IDS.notification1);
    const alertDeliveriesBefore = structuredClone(alertNote?.deliveries);
    const until = new Date(T0.getTime() + 30 * MIN).toISOString();
    await ack(h, [
      { itemId: n1.id, revision: 1, result: { status: 'deferred', until, reason: 'quiet_hours' } },
      { itemId: ask1.id, revision: 1, result: { status: 'failed', error: '飞书超时', retryAfter: until } },
      { itemId: decision.id, revision: 1, result: { status: 'dropped', reason: 'over_budget' } },
    ]);
    expect((await outbox(h)).items).toEqual([]);
    h.clock.now = new Date(T0.getTime() + 30 * MIN + 1_000);
    expect((await outbox(h)).items.map((i) => i.id)).toEqual([]);
    h.clock.now = new Date(T0.getTime() + 31 * MIN);
    expect((await outbox(h)).items.map((i) => [i.id, i.revision])).toEqual([
      [n1.id, 1],
      [ask1.id, 1],
    ]);
    // 「不发了」「推迟」都不是没送成：通知的送达记录不记这一笔（原因记在推送本身）。
    const decisionNote = h.store.data.notifications.find((n) => n.id === FEISHU_IDS.decision);
    expect(decisionNote?.deliveries).toEqual([]);
    expect(h.store.data.feishuOutbox.find((r) => r.id === decision.id)).toMatchObject({
      ackStatus: 'dropped',
      ackReason: 'over_budget',
    });
    expect(alertNote?.deliveries).toEqual(alertDeliveriesBefore);
    expect(h.store.data.feishuOutbox.find((r) => r.id === n1.id)).toMatchObject({
      ackStatus: 'deferred',
      ackReason: 'quiet_hours',
    });
  });

  it('回执没记上时按卡片登记补「上次送到的卡」：网关重启后改原卡，不再发一张', async () => {
    const h = harness({ data: feishuData() });
    await outbox(h);
    await h.store.putCard({
      messageId: 'om_pushed',
      chatId: 'oc_team',
      kind: 'ask',
      ref: { outboxId: `ask:${FEISHU_IDS.askOpen}`, askId: FEISHU_IDS.askOpen },
      sentAt: T0.toISOString(),
    });
    const item = (await outbox(h)).items.find((i) => i.id === `ask:${FEISHU_IDS.askOpen}`);
    expect(item?.delivered).toEqual({ messageId: 'om_pushed', chatId: 'oc_team', sentAt: T0.toISOString() });
  });

  it('长轮询：没有待推送就等着，一有（新的追问）马上回；一直没有就等满再回空的', async () => {
    const quiet = () => ({ ...devFixtures(T0), notifications: [] });
    const h = harness({ data: quiet() });
    const started = Date.now();
    const pending = outbox(h, '?waitSeconds=5');
    await new Promise((r) => setTimeout(r, 150));
    await h.store.openAsk({ runId: IDS.run1, taskId: IDS.task12, question: '用哪个短信商？', options: [] });
    const batch = await pending;
    expect(batch.items.map((i) => i.title)).toEqual(['用哪个短信商？']);
    expect(Date.now() - started).toBeLessThan(2_000);

    const h2 = harness({ data: quiet() });
    const t2 = Date.now();
    expect((await outbox(h2, '?waitSeconds=1')).items).toEqual([]);
    expect(Date.now() - t2).toBeGreaterThanOrEqual(900);
  });

  it('免打扰时段照设置给；设置读不懂 500（不当成「不设」，免得半夜推卡）；参数认不出 400', async () => {
    const h = harness();
    h.store.data.settings.push({
      key: 'notify.quietHours',
      value: { start: '22:00', end: '08:00' },
      version: 1,
    });
    expect((await outbox(h)).quietHours).toEqual({ start: '22:00', end: '08:00' });
    const broken = harness();
    broken.store.data.settings.push({ key: 'notify.quietHours', value: { start: '25:99' }, version: 1 });
    const res = await broken.cockpit.request('/api/feishu/outbox?waitSeconds=0', gw('GET', undefined, null));
    expect({ status: res.status, code: await errorCode(res) }).toEqual({
      status: 500,
      code: 'setting_invalid',
    });
    for (const q of ['?waitSeconds=26', '?waitSeconds=-1', '?waitSeconds=abc']) {
      const bad = await h.cockpit.request(`/api/feishu/outbox${q}`, gw('GET', undefined, null));
      expect({ q, code: await errorCode(bad) }).toEqual({ q, code: 'invalid_query' });
    }
  });

  it('库读不到：500，不回空的待推送（空的会被当成「没有要推的」）', async () => {
    const h = harness({ data: feishuData() });
    vi.spyOn(h.store, 'listOutboxSources').mockRejectedValueOnce(new Error('connection refused'));
    const res = await h.cockpit.request('/api/feishu/outbox?waitSeconds=0', gw('GET', undefined, null));
    expect({ status: res.status, code: await errorCode(res) }).toEqual({ status: 500, code: 'internal' });
    vi.spyOn(h.store, 'syncOutbox').mockRejectedValueOnce(new Error('connection refused'));
    expect(
      (await h.cockpit.request('/api/feishu/outbox?waitSeconds=0', gw('GET', undefined, null))).status,
    ).toBe(500);
  });

  it('回执按条处理：认不出的跳过（记日志），好的照记，整批不 4xx；格式认不出整批 400；库写不进 500（网关留着下次再送）', async () => {
    const h = harness({ data: feishuData() });
    const [first] = (await outbox(h)).items;
    if (!first) throw new Error('应当有待推送');
    const res = await ack(h, [
      sent('ask:not-there', 1, 'om_x'),
      sent(first.id, 1, 'om_ok'),
      sent(first.id, 9, 'om_future'),
    ]);
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true });
    expect((await outbox(h)).items.map((i) => i.id)).not.toContain(first.id);
    expect(h.logs.find((l) => l.message.includes('认不出'))?.fields).toMatchObject({
      skipped: 2,
      applied: 1,
    });

    for (const body of [
      { acks: [] },
      { acks: [{ itemId: 'x' }] },
      { acks: [{ itemId: 'x', revision: 1, result: { status: 'sent' } }] },
    ]) {
      const bad = await h.cockpit.request('/api/feishu/outbox/acks', gw('POST', body, null));
      expect({ body, code: await errorCode(bad) }).toEqual({ body, code: 'invalid_request' });
    }
    vi.spyOn(h.store, 'ackOutbox').mockRejectedValueOnce(new Error('connection refused'));
    const down = await ack(h, [sent(first.id, 1, 'om_ok')]);
    expect({ status: down.status, code: await errorCode(down) }).toEqual({ status: 500, code: 'internal' });
  });
});

describe('PUT /feishu/cards/:messageId：卡片登记', () => {
  const put = (h: H, messageId: string, body: unknown) =>
    h.cockpit.request(`/api/feishu/cards/${encodeURIComponent(messageId)}`, gw('PUT', body, null));

  it('登记；再登记同一条：种类、来历覆盖，发出时刻保留第一次的', async () => {
    const h = harness();
    const card = { chatId: 'oc_team', kind: 'draft', ref: {}, sentAt: T0.toISOString() };
    expect(await (await put(h, 'om_1', card)).json()).toEqual({ ok: true });
    await put(h, 'om_1', {
      ...card,
      ref: { draftId: FEISHU_IDS.draft1 },
      sentAt: new Date(T0.getTime() + MIN).toISOString(),
    });
    expect(await h.store.getCard('om_1')).toEqual({
      messageId: 'om_1',
      chatId: 'oc_team',
      kind: 'draft',
      ref: { draftId: FEISHU_IDS.draft1 },
      sentAt: T0.toISOString(),
    });
  });

  it('参数认不出 400（种类、时刻、消息编号）；库写不进 500', async () => {
    const h = harness();
    const good = { chatId: 'oc_team', kind: 'draft', ref: {}, sentAt: T0.toISOString() };
    for (const body of [
      { ...good, kind: 'nope' },
      { ...good, sentAt: '昨天' },
      { ...good, chatId: '' },
      { ...good, ref: { taskId: '' } },
    ]) {
      expect(await errorCode(await put(h, 'om_1', body))).toBe('invalid_request');
    }
    expect(await errorCode(await put(h, 'o'.repeat(101), good))).toBe('invalid_request');
    expect(h.store.data.feishuCards).toEqual([]);
    vi.spyOn(h.store, 'putCard').mockRejectedValueOnce(new Error('connection refused'));
    expect((await put(h, 'om_1', good)).status).toBe(500);
  });
});

/** 写进内存库之前按库的约束查一遍的，这里挑一条确认内存版照样拦（和库版一样整笔不做）。 */
describe('内存版照库的约束来', () => {
  it('草稿的「我理解为」超过 1000 字：拦下，不写', async () => {
    const data: Partial<MemoryData> = feishuData();
    const h = harness({ data });
    await expect(
      h.store.createDraft(
        {
          message: { sourceMessageId: 'om_long', userId: IDS.founderA, textHash: 'h' },
          draft: {
            id: FEISHU_IDS.draft1,
            rawText: 'x',
            understanding: 'x'.repeat(1001),
            unsure: true,
            chatType: 'p2p',
          },
        },
        {
          actor: { kind: 'user', id: IDS.founderA },
          action: 'draft.create',
          target: 'draft:x',
          via: 'feishu',
          ok: true,
        },
      ),
    ).rejects.toThrow(/understanding_length/);
    expect(h.store.data.feishuDrafts).toEqual([]);
  });
});
