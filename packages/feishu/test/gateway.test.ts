// 网关收原话（#553 第 4 条 PR-2）：创始人说的每一句原样转后端 intake，不再出「我理解为」草稿卡。
// 用真实形状的事件喂进来（SDK 的分发器和归一化），后端是真 HTTP 的假服务器，飞书是假的。
// 每条「读不到 / 认不出 / 存不进」的路径都配【故意造出的失败】测试。
import { afterEach, describe, expect, it } from 'vitest';
import { NOT_STORED_EMOJI, TARGET_ACK_MS } from '../src/gateway.ts';
import { FeishuError } from '../src/port.ts';
import {
  A,
  asAction,
  asMenu,
  asMessage,
  asRecall,
  B,
  cardEvent,
  menuEvent,
  messageEvent,
  recallEvent,
  STRANGER,
  TEAM,
  TEST_GROUP,
} from './events.ts';
import { apiError } from './fake-backend.ts';
import { FakeFeishu, textIn, unavailable } from './fake-feishu.ts';
import { type Harness, harness, quietCards, TOKEN, until } from './harness.ts';

let h: Harness;
afterEach(async () => {
  await h?.close();
});

/** 存成功时后端回的那个形状（收原话）。 */
const STORED = { body: { status: 'stored', intentSeq: 1 } };

async function say(text: string, o: Partial<Parameters<typeof messageEvent>[0]> = {}) {
  const msg = await asMessage(messageEvent({ ...o, text }));
  const t0 = h.feishu.elapsed();
  h.gateway.onMessage(msg);
  await h.gateway.idle();
  return { msg, t0 };
}

async function click(
  messageId: string,
  value: unknown,
  o: { from?: string; form?: Record<string, unknown> } = {},
) {
  const evt = await asAction(cardEvent({ messageId, value, ...o }));
  const t0 = h.feishu.elapsed();
  h.gateway.onCardAction(evt);
  await h.gateway.idle();
  return t0;
}

async function openMenu(key: string, o: { from?: string; eventId?: string } = {}) {
  const evt = await asMenu(menuEvent({ key, ...o }));
  h.gateway.onMenu(evt);
  await h.gateway.idle();
}

describe('收原话：每一句原样转后端', () => {
  it('私聊一句话：2 秒内加「收到」表情，不再出草稿卡；原话一个字不动地转给后端，注明代表谁', async () => {
    h = await harness();
    h.backend.on('POST', '/feishu/intake/messages', STORED);
    const { msg, t0 } = await say('给登录页加手机验证码');

    const react = h.feishu.of('react');
    expect(react).toHaveLength(1);
    expect(react[0]).toMatchObject({ messageId: msg.messageId, emoji: 'Get' });
    expect((react[0]?.at ?? Infinity) - t0).toBeLessThanOrEqual(TARGET_ACK_MS);
    // 不再回卡、不再发「收到」那句：飞书上只多了一个表情。
    expect(h.feishu.of('reply')).toHaveLength(0);
    expect(h.feishu.newMessages()).toHaveLength(0);

    const [call] = h.backend.calls('POST', '/feishu/intake/messages');
    expect(call).toBeDefined();
    const body = call?.body as {
      sentAt: string;
      rawContent: string;
      messageId: string;
      chatKind: string;
      source: string;
      msgType: string;
      text: string;
      atBot: boolean;
      newSegment: boolean;
    };
    expect(call?.headers.authorization).toBe(`Bearer ${TOKEN}`);
    expect(call?.headers['x-fleet-acting-feishu']).toBe(A);
    expect(body).toMatchObject({
      messageId: msg.messageId,
      chatKind: 'p2p',
      source: 'event',
      msgType: 'text',
      text: '给登录页加手机验证码',
      atBot: false,
      newSegment: false,
    });
    expect(typeof body.sentAt).toBe('string');
    // 原始 content 一个字不动地带上（后端靠它判同一条消息内容变没变）。
    expect(body.rawContent).toBe(JSON.stringify({ text: '给登录页加手机验证码' }));
    // 存下了：心跳里记一笔（看守按它报「后端通不通」），没有任何「没记成」的计数
    h.gateway.watch.heartbeat();
    const beat = h.logs.filter((l) => l.message === '网关心跳').at(-1);
    expect(beat?.fields).toMatchObject({ intake: { stored: 1, failed: 0 } });
    expect(h.gateway.stats.intake_failed ?? 0).toBe(0);
    expect(h.gateway.stats.intake_refused ?? 0).toBe(0);
  });

  it('群里不 @ 也收：原话照转，但群里不逐句打扰（不加「收到」表情）', async () => {
    h = await harness();
    h.backend.on('POST', '/feishu/intake/messages', STORED);
    await say('给登录页加验证码', { chat: 'group', chatId: TEAM, mentionBot: false });

    expect(h.feishu.of('react')).toHaveLength(0);
    const [call] = h.backend.calls('POST', '/feishu/intake/messages');
    expect(call?.body).toMatchObject({
      chatKind: 'group',
      text: '给登录页加验证码',
      atBot: false,
    });
  });

  it('群里 @了机器人：照样转，atBot 为真；@机器人 另起 = 口令，从这句另起一段', async () => {
    h = await harness();
    h.backend.on('POST', '/feishu/intake/messages', STORED);
    await say('给登录页加验证码', { chat: 'group', chatId: TEAM, mentionBot: true });
    expect(h.backend.calls('POST', '/feishu/intake/messages')[0]?.body).toMatchObject({ atBot: true });
    // @机器人 的那句也给回「收到」（这是有人明确对机器人说话）
    expect(h.feishu.of('react')).toHaveLength(1);

    await say('另起', { chat: 'group', chatId: TEAM, mentionBot: true });
    const second = h.backend.calls('POST', '/feishu/intake/messages')[1];
    expect(second).toBeDefined();
    const body = second?.body as { text: string; newSegment: boolean; atBot: boolean };
    expect(body).toMatchObject({ newSegment: true, atBot: true });
    // 「另起」去掉那个 @ 之后整句就是这两个字：归一化把 @机器人 去掉了
    expect(body.text).toBe('另起');
  });

  it('回复某条：回复的是哪条一起转（后端据此归段）；在话题里的带上话题编号', async () => {
    h = await harness();
    h.backend.on('POST', '/feishu/intake/messages', STORED);
    await say('只做网页版', { replyTo: 'om_earlier', rootId: 'om_root', thread: 'omt_1' });
    expect(h.backend.calls('POST', '/feishu/intake/messages')[0]?.body).toMatchObject({
      parentId: 'om_earlier',
      threadId: 'omt_1',
    });
  });

  it('非文字消息不丢、不悄悄跳过：给一句明说是什么的占位，原始 content 照带', async () => {
    h = await harness();
    h.backend.on('POST', '/feishu/intake/messages', STORED);
    await say('', { type: 'image', content: JSON.stringify({ image_key: 'img_v2_placeholder' }) });
    const body = h.backend.calls('POST', '/feishu/intake/messages')[0]?.body as {
      text: string;
      rawContent: string;
      msgType: string;
    };
    expect(body.msgType).toBe('image');
    expect(body.text).toBe('[图片]');
    expect(JSON.parse(body.rawContent)).toEqual({ image_key: 'img_v2_placeholder' });
  });

  it('群里别的人说话：入口就丢，不转、不存、不回话，也不记原文和长度', async () => {
    h = await harness();
    h.backend.on('POST', '/feishu/intake/messages', STORED);
    h.backend.on('POST', '/feishu/intake/rejections', { body: { recorded: true } });
    await say('我要开个任务', { chat: 'group', chatId: TEAM, from: STRANGER });
    expect(h.backend.calls('POST', '/feishu/intake/messages')).toHaveLength(0);
    const rejected = h.backend.calls('POST', '/feishu/intake/rejections');
    expect(rejected).toHaveLength(1);
    const body = rejected[0]?.body as Record<string, unknown>;
    expect(Object.keys(body).sort()).toEqual(['at', 'chatId', 'openIdTail', 'reason']);
    expect(body.openIdTail).toBe('nger');
    expect(body.chatId).toBe(TEAM);
    const dumped = JSON.stringify(body);
    expect(dumped).not.toContain('我要开个任务');
    expect(dumped).not.toContain('length');
    expect(body).not.toHaveProperty('text');
    expect(h.feishu.of('reply')).toHaveLength(0);
    expect(h.feishu.of('react')).toHaveLength(0);
    expect(h.gateway.stats).toMatchObject({ dropped_not_founder: 1 });
    // 日志里不落原话，也不落长度：只说会话和尾号四位。
    const line = h.logs.find((l) => l.message === '群里有不是创始人的人说话：没转、没存');
    expect(line).toBeDefined();
    expect(JSON.stringify(line?.fields)).not.toContain('我要开个任务');
  });

  it('不在允许的群、机器人自己发的：一律不理', async () => {
    h = await harness();
    h.backend.on('POST', '/feishu/intake/messages', STORED);
    await say('给登录页加验证码', { chat: 'group', chatId: 'oc_other_group' });
    await say('我是机器人', { senderType: 'app' });
    expect(h.backend.requests).toHaveLength(0);
    expect(h.gateway.stats).toMatchObject({ ignored_group: 1, ignored_bot: 1 });
  });

  it('允许的测试群也收（白名单群不只是团队群）', async () => {
    h = await harness();
    h.backend.on('POST', '/feishu/intake/messages', STORED);
    await say('给登录页加验证码', { chat: 'group', chatId: TEST_GROUP });
    expect(h.backend.calls('POST', '/feishu/intake/messages')).toHaveLength(1);
  });

  it('私聊里的陌生人：礼貌拒绝一次，不调后端；同一天再说不再回，免得来回刷', async () => {
    h = await harness();
    await say('帮我开个任务', { from: STRANGER });
    await say('在吗', { from: STRANGER });
    expect(h.backend.requests).toHaveLength(0);
    const replies = h.feishu.of('reply');
    expect(replies).toHaveLength(1);
    expect(replies[0]?.message).toEqual({ text: expect.stringContaining('只替两位创始人办事') });
    expect(h.feishu.of('react')).toHaveLength(0);
  });
});

describe('没存成要看得见', () => {
  it('后端连不上：在那句上加「没记成」表情，记下这个会话要补漏；不装作记下了', async () => {
    h = await harness();
    h.backend.on('POST', '/feishu/intake/messages', apiError(503, 'unavailable', '后端暂时不可用'));
    const { msg } = await say('给登录页加手机验证码');

    expect(h.feishu.reactionsOn(msg.messageId)).toEqual(['Get', NOT_STORED_EMOJI]);
    expect(h.gateway.stats).toMatchObject({ intake_failed: 1 });
    // 记下这个会话要补漏，且记下了那句的发出时刻（补漏从这里往后翻）。
    const missed = h.gateway.missed.chats();
    expect(missed).toHaveLength(1);
    expect(missed[0]?.chatId).toBe(msg.chatId);
    expect(missed[0]?.sinceMs).toBe(msg.createTime);
    // 没存成也不回卡：飞书上只有两个表情。
    expect(h.feishu.of('reply')).toHaveLength(0);
    // 日志里不落原话正文，只记长度。
    const line = h.logs.find((l) => l.message === '原话没存成：记下这个会话要补漏');
    expect(line).toBeDefined();
    expect(JSON.stringify(line?.fields)).not.toContain('给登录页加手机验证码');
  });

  it('后端拒收（4xx）：加「没记成」但**不**记补漏（再送也一样），只记原因', async () => {
    h = await harness();
    h.backend.on(
      'POST',
      '/feishu/intake/messages',
      apiError(403, 'not_whitelisted', '这个飞书账号不是创始人'),
    );
    const { msg } = await say('给登录页加手机验证码');
    expect(h.feishu.reactionsOn(msg.messageId)).toContain(NOT_STORED_EMOJI);
    expect(h.gateway.missed.chats()).toHaveLength(0);
    expect(h.gateway.stats).toMatchObject({ intake_refused: 1 });
  });

  it('后端回的认不出（形状不对）：加「没记成」、只记原因不补漏（回成这样再送也一样）【故意造出的失败】', async () => {
    h = await harness();
    h.backend.on('POST', '/feishu/intake/messages', { body: { nope: true } });
    const { msg } = await say('给登录页加手机验证码');
    expect(h.feishu.reactionsOn(msg.messageId)).toContain(NOT_STORED_EMOJI);
    expect(h.gateway.missed.chats()).toHaveLength(0);
    expect(h.gateway.stats).toMatchObject({ intake_refused: 1 });
    expect(h.logs.some((l) => l.message === '原话后端没收下（再送也一样，不补漏）')).toBe(true);
  });

  it('事件残缺（没带发出时刻）：认不出这句话，不拿收到时刻顶，照样标「没记成」并记补漏【故意造出的失败】', async () => {
    h = await harness();
    h.backend.on('POST', '/feishu/intake/messages', STORED);
    const { msg } = await say('给登录页加手机验证码', { createTime: null });
    // 一个字都没转给后端（缺发出时刻转不成收原话的请求）
    expect(h.backend.requests).toHaveLength(0);
    expect(h.feishu.reactionsOn(msg.messageId)).toContain(NOT_STORED_EMOJI);
    const missed = h.gateway.missed.chats();
    expect(missed).toHaveLength(1);
    // 不拿收到时刻顶：按飞书最晚会推迟多久往前翻
    expect(missed[0]?.sinceMs).toBeLessThan(Date.now());
    expect(h.gateway.stats).toMatchObject({ intake_failed: 1 });
    expect(h.logs.some((l) => l.message === '原话没存成：记下这个会话要补漏')).toBe(true);
  });

  it('「没记成」表情加不上：记错误，不装作标上了', async () => {
    h = await harness();
    h.backend.on('POST', '/feishu/intake/messages', apiError(503, 'unavailable', '后端暂时不可用'));
    // 两个表情都加不上：先加「收到」失败（改回一句「收到」也不再是重点），再加「没记成」也失败
    h.feishu.fail('react', unavailable(), unavailable());
    await say('给登录页加手机验证码');
    expect(h.gateway.stats).toMatchObject({ not_stored_mark_failed: 1 });
    expect(h.logs.some((l) => l.message === '「没记成」表情没加上')).toBe(true);
  });
});

describe('撤回', () => {
  it('撤回事件转给后端（不带代表人）；不在允许的群、也不在见过的私聊里的，不碰', async () => {
    h = await harness();
    h.backend.on('POST', '/feishu/intake/recalls', { body: { status: 'recalled', intentSeq: 1 } });
    // 先在团队群里说一句，让网关认得这个会话
    h.backend.on('POST', '/feishu/intake/messages', STORED);
    await say('给登录页加验证码', { chat: 'group', chatId: TEAM });

    const evt = await asRecall(recallEvent({ messageId: 'om_gone', chatId: TEAM }));
    h.gateway.onRecall(evt);
    await h.gateway.idle();
    const [call] = h.backend.calls('POST', '/feishu/intake/recalls');
    expect(call?.headers['x-fleet-acting-feishu']).toBeUndefined();
    expect(call?.body).toMatchObject({ messageId: 'om_gone', chatId: TEAM, source: 'event' });
    expect(h.gateway.stats).toMatchObject({ recall_recalled: 1 });

    // 不认得的会话：不转
    const before = h.backend.calls('POST', '/feishu/intake/recalls').length;
    h.gateway.onRecall(await asRecall(recallEvent({ messageId: 'om_x', chatId: 'oc_other_group' })));
    await h.gateway.idle();
    expect(h.backend.calls('POST', '/feishu/intake/recalls')).toHaveLength(before);
    expect(h.gateway.stats).toMatchObject({ recall_ignored: 1 });
  });

  it('撤回没转成（后端连不上）：记下来，补漏时再转一次', async () => {
    h = await harness();
    h.backend.on('POST', '/feishu/intake/messages', STORED);
    await say('给登录页加验证码', { chat: 'group', chatId: TEAM });
    h.backend.on('POST', '/feishu/intake/recalls', apiError(503, 'unavailable', '后端暂时不可用'));
    h.gateway.onRecall(await asRecall(recallEvent({ messageId: 'om_gone', chatId: TEAM })));
    await h.gateway.idle();
    expect(h.gateway.missed.recalls()).toHaveLength(1);
    expect(h.gateway.stats).toMatchObject({ recall_failed: 1 });

    // 后端好了：补漏一轮把它转出去，之后清掉
    h.backend.on('POST', '/feishu/intake/recalls', { body: { status: 'recalled', intentSeq: 1 } });
    h.backend.on('GET', '/feishu/intake/cursors', { body: { chats: [], asOf: new Date().toISOString() } });
    await h.gateway.backfill('test');
    await h.gateway.idle();
    expect(h.gateway.missed.recalls()).toHaveLength(0);
  });
});

describe('补漏：从后端游标往后翻飞书历史补上', () => {
  /** 摆好后端游标：说这个会话存到哪了。 */
  function cursors(chatId: string, lastSentAt: number) {
    h.backend.on('GET', '/feishu/intake/cursors', {
      body: {
        chats: [
          {
            known: true,
            chatId,
            chatKind: 'p2p',
            lastSentAt: new Date(lastSentAt).toISOString(),
            lastMessageId: 'om_stored',
            messages: 1,
          },
        ],
        asOf: new Date().toISOString(),
      },
    });
  }

  it('没存成的会话：按后端游标往后翻，按原顺序补送；补上了撤掉「没记成」', async () => {
    h = await harness();
    const chatId = 'oc_p2p_founder_a';
    const t = Date.now() - 60_000;
    // 第一句没存下
    h.backend.on('POST', '/feishu/intake/messages', apiError(503, 'unavailable', '后端暂时不可用'));
    const { msg } = await say('第一句', { chatId, createTime: t });
    expect(h.gateway.missed.marks()).toHaveLength(1);

    // 后端好了；游标说存到 t 之前（所以从 t 附近往后翻）
    h.backend.on('POST', '/feishu/intake/messages', STORED);
    cursors(chatId, t - 1_000);
    // 历史里有乱序的两条：网关要按发出时刻从早到晚送
    h.feishu.scriptHistory({
      messages: [
        FakeFeishu.historyMessage({
          messageId: 'om_late',
          chatId,
          senderId: A,
          text: '后说的',
          createTime: t + 2_000,
        }),
        FakeFeishu.historyMessage({
          messageId: msg.messageId,
          chatId,
          senderId: A,
          text: '第一句',
          createTime: t,
        }),
      ],
      unrecognized: 0,
    });
    await h.gateway.backfill('test');
    await h.gateway.idle();

    const sent = h.backend
      .calls('POST', '/feishu/intake/messages')
      .slice(1)
      .map((r) => (r.body as { messageId: string }).messageId);
    expect(sent).toEqual([msg.messageId, 'om_late']);
    // 补漏送的显式注明来源是补漏
    const bodies = h.backend.calls('POST', '/feishu/intake/messages').slice(1);
    expect(bodies.every((b) => (b.body as { source: string }).source === 'backfill')).toBe(true);
    // 补上了：撤掉「没记成」，标记也清掉
    expect(h.feishu.of('unreact')).toHaveLength(1);
    expect(h.gateway.missed.marks()).toHaveLength(0);
    expect(h.gateway.stats).toMatchObject({ not_stored_cleared: 1, backfill_stored: 2 });
    expect(h.gateway.missed.chats()).toHaveLength(0);
  });

  it('翻历史翻不动（飞书报错）：留着标记下一轮再来，整轮按没走通算', async () => {
    h = await harness();
    const chatId = 'oc_p2p_founder_a';
    const t = Date.now() - 60_000;
    h.backend.on('POST', '/feishu/intake/messages', apiError(503, 'unavailable', '后端暂时不可用'));
    await say('第一句', { chatId, createTime: t });
    h.backend.on('GET', '/feishu/intake/cursors', { body: { chats: [], asOf: new Date().toISOString() } });
    h.feishu.fail('history', unavailable());

    await h.gateway.backfill('test');
    await h.gateway.idle();
    expect(h.gateway.stats).toMatchObject({ backfill_failed_round: 1 });
    // 标记留着：下一轮还要补
    expect(h.gateway.missed.chats()).toHaveLength(1);
    expect(h.logs.some((l) => l.message === '补漏这一轮没走通，过一阵再试')).toBe(true);
  });

  it('历史里有认不出的行：不悄悄少算，报出来并计数【故意造出的失败】', async () => {
    h = await harness();
    const chatId = 'oc_p2p_founder_a';
    const t = Date.now() - 60_000;
    h.backend.on('POST', '/feishu/intake/messages', apiError(503, 'unavailable', '后端暂时不可用'));
    await say('第一句', { chatId, createTime: t });
    // 后端好了：补漏这一轮能存下
    h.backend.on('POST', '/feishu/intake/messages', STORED);
    h.backend.on('GET', '/feishu/intake/cursors', { body: { chats: [], asOf: new Date().toISOString() } });
    h.feishu.scriptHistory({
      messages: [FakeFeishu.historyMessage({ messageId: 'om_one', chatId, senderId: A, createTime: t + 1 })],
      unrecognized: 2,
    });
    await h.gateway.backfill('test');
    await h.gateway.idle();
    expect(h.gateway.stats).toMatchObject({ backfill_unrecognized: 1 });
    expect(h.logs.some((l) => l.message === '补漏翻到的历史里有认不出的行：跳过这些')).toBe(true);
    // 认得出的那条照样补上了
    expect(h.gateway.stats).toMatchObject({ backfill_stored: 1 });
  });

  it('补漏时后端还是连不上：那一条算没补成，「没记成」不动，下一轮再来', async () => {
    h = await harness();
    const chatId = 'oc_p2p_founder_a';
    const t = Date.now() - 60_000;
    h.backend.on('POST', '/feishu/intake/messages', apiError(503, 'unavailable', '后端暂时不可用'));
    const { msg } = await say('第一句', { chatId, createTime: t });
    h.backend.on('GET', '/feishu/intake/cursors', { body: { chats: [], asOf: new Date().toISOString() } });
    h.feishu.scriptHistory({
      messages: [FakeFeishu.historyMessage({ messageId: msg.messageId, chatId, senderId: A, createTime: t })],
      unrecognized: 0,
    });
    await h.gateway.backfill('test');
    await h.gateway.idle();
    expect(h.feishu.of('unreact')).toHaveLength(0);
    expect(h.feishu.reactionsOn(msg.messageId)).toContain(NOT_STORED_EMOJI);
    expect(h.gateway.stats).toMatchObject({ backfill_failed: 1 });
  });

  it('补漏只认创始人、只认允许的群、机器人自己发的跳过（不乱补）', async () => {
    h = await harness();
    const chatId = TEAM;
    const t = Date.now() - 60_000;
    h.backend.on('POST', '/feishu/intake/messages', apiError(503, 'unavailable', '后端暂时不可用'));
    await say('第一句', { chat: 'group', chatId, createTime: t });
    h.backend.on('GET', '/feishu/intake/cursors', { body: { chats: [], asOf: new Date().toISOString() } });
    h.feishu.scriptHistory({
      messages: [
        FakeFeishu.historyMessage({ messageId: 'om_s1', chatId, senderId: STRANGER, createTime: t + 1 }),
        FakeFeishu.historyMessage({
          messageId: 'om_s2',
          chatId,
          senderId: A,
          fromBot: true,
          createTime: t + 2,
        }),
        FakeFeishu.historyMessage({ messageId: 'om_s3', chatId: 'oc_other', senderId: A, createTime: t + 3 }),
        FakeFeishu.historyMessage({ messageId: 'om_s4', chatId, senderId: A, createTime: t + 4 }),
      ],
      unrecognized: 0,
    });
    h.backend.on('POST', '/feishu/intake/messages', STORED);
    await h.gateway.backfill('test');
    await h.gateway.idle();
    const sent = h.backend
      .calls('POST', '/feishu/intake/messages')
      .slice(1)
      .map((r) => (r.body as { messageId: string }).messageId);
    expect(sent).toEqual(['om_s4']);
  });

  it('话题里的回复：按会话翻之外，还要按话题再翻一遍', async () => {
    h = await harness();
    const chatId = 'oc_p2p_founder_a';
    const t = Date.now() - 60_000;
    h.backend.on('POST', '/feishu/intake/messages', apiError(503, 'unavailable', '后端暂时不可用'));
    await say('第一句', { chatId, createTime: t, thread: 'omt_9' });
    h.backend.on('POST', '/feishu/intake/messages', STORED);
    h.backend.on('GET', '/feishu/intake/cursors', {
      body: {
        chats: [
          {
            known: true,
            chatId,
            chatKind: 'p2p',
            lastSentAt: new Date(t - 1_000).toISOString(),
            lastMessageId: 'om_stored',
            messages: 1,
          },
        ],
        asOf: new Date().toISOString(),
      },
    });
    h.feishu.scriptHistory({ messages: [], unrecognized: 0 });
    h.feishu.scriptHistory({ messages: [], unrecognized: 0 });
    await h.gateway.backfill('test');
    await h.gateway.idle();
    const folded = h.feishu.of('history').map((c) => [c.history?.containerId, c.history?.container]);
    expect(folded).toEqual([
      [chatId, 'chat'],
      ['omt_9', 'thread'],
    ]);
  });

  it('后端从连不上变连得上：手上一存下就自己跑一轮补漏', async () => {
    h = await harness();
    const chatId = 'oc_p2p_founder_a';
    const t = Date.now() - 60_000;
    h.backend.on('POST', '/feishu/intake/messages', apiError(503, 'unavailable', '后端暂时不可用'));
    await say('第一句', { chatId, createTime: t });
    expect(h.gateway.missed.chats()).toHaveLength(1);

    h.backend.on('POST', '/feishu/intake/messages', STORED);
    h.backend.on('GET', '/feishu/intake/cursors', { body: { chats: [], asOf: new Date().toISOString() } });
    h.feishu.scriptHistory({ messages: [], unrecognized: 0 });
    await say('第二句', { chatId, createTime: t + 1_000 });
    await until(() => h.feishu.of('history').length >= 1);
    await h.gateway.idle();
    expect(h.feishu.of('history').length).toBeGreaterThanOrEqual(1);
  });

  it('补漏一轮翻不完（页数上限）：记账说翻不完，下一轮接着翻', async () => {
    h = await harness({ timing: { backfillPages: 1 } });
    const chatId = 'oc_p2p_founder_a';
    const t = Date.now() - 60_000;
    h.backend.on('POST', '/feishu/intake/messages', apiError(503, 'unavailable', '后端暂时不可用'));
    await say('第一句', { chatId, createTime: t });
    h.backend.on('GET', '/feishu/intake/cursors', { body: { chats: [], asOf: new Date().toISOString() } });
    h.feishu.scriptHistory({
      messages: [FakeFeishu.historyMessage({ messageId: 'om_p1', chatId, senderId: A, createTime: t })],
      nextPageToken: 'page-2',
      unrecognized: 0,
    });
    h.backend.on('POST', '/feishu/intake/messages', STORED);
    await h.gateway.backfill('test');
    await h.gateway.idle();
    expect(h.gateway.stats).toMatchObject({ backfill_page_limit: 1 });
    expect(h.logs.some((l) => l.message === '补漏一轮翻不完，下一轮接着翻')).toBe(true);
  });

  it('后端游标读不到：整轮按没走通算，退避之后再来', async () => {
    h = await harness();
    h.backend.on('GET', '/feishu/intake/cursors', apiError(503, 'unavailable', '后端暂时不可用'));
    await h.gateway.backfill('test');
    expect(h.gateway.stats).toMatchObject({ backfill_failed_round: 1 });
    // 退避期内再喊也不跑（不给后端添乱）
    await h.gateway.backfill('test');
    expect(h.gateway.stats.backfill_failed_round).toBe(1);
  });

  it('改过的消息（历史接口给了 update_time）：带上 editedAt，后端另存一版', async () => {
    h = await harness();
    const chatId = 'oc_p2p_founder_a';
    const t = Date.now() - 60_000;
    h.backend.on('POST', '/feishu/intake/messages', apiError(503, 'unavailable', '后端暂时不可用'));
    await say('第一句', { chatId, createTime: t });
    h.backend.on('GET', '/feishu/intake/cursors', { body: { chats: [], asOf: new Date().toISOString() } });
    h.feishu.scriptHistory({
      messages: [
        {
          ...FakeFeishu.historyMessage({ messageId: 'om_edit', chatId, senderId: A, createTime: t + 1 }),
          editedAt: t + 5_000,
        },
      ],
      unrecognized: 0,
    });
    h.backend.on('POST', '/feishu/intake/messages', STORED);
    await h.gateway.backfill('test');
    await h.gateway.idle();
    const body = h.backend.calls('POST', '/feishu/intake/messages')[1]?.body as { editedAt: string };
    expect(Date.parse(body.editedAt)).toBe(t + 5_000);
  });

  it('补漏同时只跑一轮：喊两次不会重复翻', async () => {
    h = await harness();
    h.backend.on('GET', '/feishu/intake/cursors', { body: { chats: [], asOf: new Date().toISOString() } });
    const first = h.gateway.backfill('test');
    const second = h.gateway.backfill('test');
    expect(second).toBe(first);
    await first;
  });
});

describe('旧卡上的按钮、旧菜单：都回「已停用」，不悄悄不理', () => {
  it('旧卡上的按钮：回一句说清楚（同一张卡同一天只说一次），不调后端、不认按钮是什么', async () => {
    h = await harness();
    await click('om_old_card', { a: 'draft.confirm', d: 'draft-1', r: 1, _n: 'n1' }, { form: {} });
    expect(h.backend.requests).toHaveLength(0);
    const [reply] = h.feishu.of('reply');
    expect(reply?.messageId).toBe('om_old_card');
    expect(reply?.message).toEqual({ text: expect.stringContaining('已经停用') });
    expect(reply?.message && 'text' in reply.message && reply.message.text).toContain('飞书现在只收原话');
    expect(h.gateway.stats).toMatchObject({ disabled_button: 1 });

    // 同一天、同一张卡再点：不再回
    await click('om_old_card', { a: 'draft.confirm', d: 'draft-1', r: 1, _n: 'n2' }, { form: {} });
    expect(h.feishu.of('reply')).toHaveLength(1);
    expect(h.gateway.stats).toMatchObject({ disabled_button: 2 });
  });

  it('认不出的按钮回传值也回「已停用」并计数，不调后端【故意造出的失败】', async () => {
    h = await harness();
    await click('om_weird', { hello: 'world' });
    expect(h.backend.requests).toHaveLength(0);
    expect(h.feishu.of('reply')[0]?.message).toEqual({ text: expect.stringContaining('已经停用') });
    expect(h.gateway.stats).toMatchObject({ disabled_button: 1 });
  });

  it('陌生人点按钮：礼貌拒绝，不回「已停用」', async () => {
    h = await harness();
    await click('om_old_card', { hello: 'world' }, { from: STRANGER });
    // 陌生人没在白名单里：私聊拒一次，不在那张卡下面回话
    expect(h.feishu.of('reply')).toHaveLength(0);
    expect(h.feishu.of('send')[0]).toMatchObject({
      to: { openId: STRANGER },
      message: { text: expect.stringContaining('只替两位创始人') },
    });
    expect(h.gateway.stats).toMatchObject({ stranger: 1 });
  });

  it('旧菜单：回到点菜单的人的私聊说「已停用」（每人每天一次），不认 key', async () => {
    h = await harness();
    await openMenu('new_task');
    const [send] = h.feishu.of('send');
    expect(send?.to).toEqual({ openId: A });
    expect(send?.message).toEqual({ text: expect.stringContaining('已经停用') });
    expect(h.backend.requests).toHaveLength(0);
    expect(h.gateway.stats).toMatchObject({ disabled_menu: 1 });

    await openMenu('board', { eventId: 'evt_2' });
    expect(h.feishu.of('send')).toHaveLength(1);
    expect(h.gateway.stats).toMatchObject({ disabled_menu: 2 });
  });

  it('同一个菜单事件重投：只回一次；陌生人点菜单礼貌拒绝', async () => {
    h = await harness();
    await openMenu('new_task', { eventId: 'evt_same' });
    await openMenu('new_task', { eventId: 'evt_same' });
    expect(h.feishu.of('send')).toHaveLength(1);
    expect(h.gateway.stats).toMatchObject({ menu_duplicate: 1 });

    await openMenu('new_task', { from: STRANGER, eventId: 'evt_other' });
    expect(h.feishu.of('send')[1]).toMatchObject({
      to: { openId: STRANGER },
      message: { text: expect.stringContaining('只替两位创始人') },
    });
    expect(h.gateway.stats).toMatchObject({ stranger: 1 });
  });
});

describe('停机与重启', () => {
  it('停机时手上的活做完再退：在途的收原话不被掐断，照样落到后端', async () => {
    h = await harness();
    h.backend.on('POST', '/feishu/intake/messages', { ...STORED, delayMs: 300 });
    const msg = await asMessage(messageEvent({ text: '给登录页加手机验证码' }));
    h.gateway.onMessage(msg);
    await h.gateway.stop(5_000);
    expect(h.backend.calls('POST', '/feishu/intake/messages')).toHaveLength(1);
    h.gateway.watch.heartbeat();
    const beat = h.logs.filter((l) => l.message === '网关心跳').at(-1);
    expect(beat?.fields).toMatchObject({ intake: { stored: 1, failed: 0 } });
  });

  it('停机时后台在跑的补漏不被掐断', async () => {
    h = await harness();
    h.backend.on('GET', '/feishu/intake/cursors', { body: { chats: [], asOf: new Date().toISOString() } });
    h.backend.on('POST', '/feishu/intake/messages', apiError(503, 'unavailable', '后端暂时不可用'));
    await say('第一句', { chatId: 'oc_p2p_founder_a' });
    h.feishu.scriptHistory({ messages: [], unrecognized: 0 });
    const running = h.gateway.backfill('test');
    await h.gateway.stop(5_000);
    await running;
    expect(h.feishu.of('history').length).toBeGreaterThanOrEqual(1);
  });

  it('start() 起来就跑一轮补漏，之后按时再看一眼', async () => {
    h = await harness({ timing: { backfillRetryMs: 20 } });
    h.backend.on('GET', '/feishu/intake/cursors', { body: { chats: [], asOf: new Date().toISOString() } });
    h.gateway.start();
    await until(() => h.backend.calls('GET', '/feishu/intake/cursors').length >= 2);
    await h.gateway.stop(2_000);
    expect(h.backend.calls('GET', '/feishu/intake/cursors').length).toBeGreaterThanOrEqual(2);
  });
});

describe('意图卡循环起没起', () => {
  it('start() 之后长轮询意图卡在跑（后端没东西就空转）；stop() 之后停掉', async () => {
    h = await harness();
    h.backend.on('GET', '/feishu/intent-cards', { body: quietCards() });
    h.backend.on('GET', '/feishu/intake/cursors', { body: { chats: [], asOf: new Date().toISOString() } });
    h.gateway.start();
    await until(() => h.backend.calls('GET', '/feishu/intent-cards').length >= 1);
    await h.gateway.stop(2_000);
    const after = h.backend.calls('GET', '/feishu/intent-cards').length;
    await new Promise((r) => setTimeout(r, 60));
    expect(h.backend.calls('GET', '/feishu/intent-cards').length).toBe(after);
  });
});

describe('不再调 #1022 删掉的旧接口', () => {
  /** 后端已经删了的九条旧飞书接口（旧推送、盘面、卡片登记、草稿、查进度、关注）：照现在的后端回 404。 */
  const RETIRED: Array<[string, string]> = [
    ['GET', '/feishu/outbox'],
    ['POST', '/feishu/outbox/acks'],
    ['GET', '/feishu/board'],
    ['PUT', '/feishu/cards/:messageId'],
    ['POST', '/feishu/messages'],
    ['POST', '/feishu/drafts/:draftId/revise'],
    ['POST', '/feishu/drafts/:draftId/confirm'],
    ['GET', '/feishu/tasks'],
    ['POST', '/feishu/follows'],
  ];

  it('起网关跑一轮（意图卡、补漏都走过）：旧接口一次都没调【故意造出的失败：旧路径回 404】', async () => {
    h = await harness();
    for (const [method, path] of RETIRED)
      h.backend.on(method, path, apiError(404, 'not_found', '没有这个接口'));
    h.backend.on('GET', '/feishu/intent-cards', { body: quietCards() });
    h.backend.on('GET', '/feishu/intake/cursors', { body: { chats: [], asOf: new Date().toISOString() } });
    h.gateway.start();
    await until(
      () =>
        h.backend.calls('GET', '/feishu/intent-cards').length >= 1 &&
        h.backend.calls('GET', '/feishu/intake/cursors').length >= 1,
    );
    await h.gateway.stop(2_000);
    const retired = h.backend.requests.filter(
      (r) =>
        !r.path.startsWith('/feishu/intake/') &&
        r.path !== '/feishu/intent-cards' &&
        r.path !== '/feishu/intent-cards/acks' &&
        r.path !== '/feishu/gateway/usage',
    );
    expect(retired.map((r) => `${r.method} ${r.path}`)).toEqual([]);
  });
});

describe('卡片的字没跑到别处', () => {
  it('「已停用」那句里带上了驾驶舱地址和「只收原话」', async () => {
    h = await harness();
    await click('om_old', { a: 'ask.answer', k: 'ask-1', o: '批准', _n: 'n1' });
    const sent = h.feishu.of('reply')[0]?.message as { text: string };
    expect(sent.text).toContain('https://cockpit.example.test');
    expect(sent.text).toContain('飞书现在只收原话');
  });

  it('不再有「我理解为」这种卡：任何一句话都不出卡', async () => {
    h = await harness();
    h.backend.on('POST', '/feishu/intake/messages', STORED);
    await say('给登录页加手机验证码');
    await say('进度 12');
    await say('你好');
    expect(h.feishu.of('reply')).toHaveLength(0);
    expect(h.feishu.of('update')).toHaveLength(0);
    expect(h.feishu.newMessages()).toHaveLength(0);
  });
});

const OVER = { month: '2026-10', calls: 8100, limit: 10_000, readable: true };
const UNREADABLE = { month: '2026-10', calls: 0, limit: 10_000, readable: false };
const USAGE_CARD = {
  intentId: '11111111-0000-4000-8000-000000000795',
  seq: 7,
  cardRev: 1,
  chatId: TEAM,
  replyToMessageId: 'om_first',
  title: '意图 7 · 已存 1 条原话',
  lines: ['甲 1 条 · 10-09 12:00（北京时间）', 'AI 归纳：对题开单时由指挥官写，写好会更新在这里。'],
};

function cardText(call: { message?: unknown; card?: unknown } | undefined): string {
  const direct = call?.card;
  const nested =
    call?.message && typeof call.message === 'object' && 'card' in call.message
      ? (call.message as { card: unknown }).card
      : undefined;
  const card = direct ?? nested;
  return card ? textIn(card as Parameters<typeof textIn>[0]) : '';
}

describe('飞书用量：八成降级、读不到只停表情', () => {
  it('报到 81%：记上这次打出去的次数，status 写明三档一起停；补漏只在后端恢复时翻，已有的卡不再改', async () => {
    h = await harness();
    h.backend.on('POST', '/feishu/gateway/usage', { body: OVER });
    h.backend.on('POST', '/feishu/intake/messages', STORED);
    await say('给登录页加验证码');
    await h.gateway.reportUsage();

    const reported = h.backend.calls('POST', '/feishu/gateway/usage');
    expect(reported).toHaveLength(1);
    expect(reported[0]?.body).toMatchObject({ calls: 1 });
    expect(h.gateway.status.level).toBe('over');
    expect(h.gateway.status.calls).toBe(8100);
    expect(h.gateway.status.limit).toBe(10_000);
    expect(h.gateway.status.stopped).toEqual(['ack', 'card-update', 'backfill']);
    expect(h.gateway.status.sentence).toContain('已按顺序降级');
    expect(h.gateway.status.sentence).toContain('8100/10000');

    await say('第二句');
    expect(h.feishu.of('react').filter((c) => c.emoji === 'Get')).toHaveLength(1);
    expect(h.feishu.of('reply').filter((c) => c.message && 'text' in c.message)).toHaveLength(0);

    await h.gateway.backfill('tick');
    expect(h.feishu.of('history')).toHaveLength(0);
    expect(h.gateway.stats.backfill_narrowed).toBeGreaterThanOrEqual(1);

    h.backend.on('POST', '/feishu/intake/messages', apiError(503, 'unavailable', '后端暂时不可用'));
    const failed = await say('第一句没存成');
    expect(h.gateway.missed.chats()).toHaveLength(1);
    h.backend.on('GET', '/feishu/intake/cursors', { body: { chats: [], asOf: new Date().toISOString() } });
    h.feishu.scriptHistory({ messages: [], unrecognized: 0 });
    h.backend.on('POST', '/feishu/intake/messages', STORED);
    await say('后端好了', { chatId: failed.msg.chatId });
    await h.gateway.backfill('recovered');
    expect(h.feishu.of('history').length).toBeGreaterThanOrEqual(1);

    let polls = 0;
    h.backend.on('GET', '/feishu/intent-cards', () => {
      polls += 1;
      const item =
        polls === 1 ? USAGE_CARD : { ...USAGE_CARD, cardRev: 2, cardMessageId: 'om_card_existing' };
      return { body: { items: [item], asOf: new Date().toISOString(), usage: OVER } };
    });
    h.backend.on('POST', '/feishu/intent-cards/acks', { body: { applied: 1, skipped: 0 } });
    h.gateway.start();
    await until(() => h.feishu.of('reply').some((c) => cardText(c).includes('已按顺序降级')));
    await until(() =>
      h.backend
        .calls('POST', '/feishu/intent-cards/acks')
        .some((r) => JSON.stringify(r.body).includes('"failed"')),
    );
    expect(h.feishu.of('update')).toHaveLength(0);
    const failedAck = JSON.stringify(h.backend.calls('POST', '/feishu/intent-cards/acks').map((r) => r.body));
    expect(failedAck).toContain('已按顺序降级');
    expect(h.gateway.status.sentence).toContain('已按顺序降级');
  });

  it('【故意造出的失败】用量读不到：只停「收到」表情，改卡照旧，补漏照翻', async () => {
    h = await harness();
    h.backend.on('POST', '/feishu/gateway/usage', apiError(500, 'usage_down', '用量表读不了'));
    h.backend.on('GET', '/feishu/intent-cards', {
      body: {
        items: [{ ...USAGE_CARD, cardMessageId: 'om_card_existing' }],
        asOf: new Date().toISOString(),
        usage: UNREADABLE,
      },
    });
    h.backend.on('POST', '/feishu/intent-cards/acks', { body: { applied: 1, skipped: 0 } });
    h.backend.on('GET', '/feishu/intake/cursors', { body: { chats: [], asOf: new Date().toISOString() } });
    await h.gateway.reportUsage();
    expect(h.gateway.status).toMatchObject({
      level: 'unreadable',
      calls: null,
      stopped: ['ack'],
    });
    expect(h.gateway.status.sentence).toContain('只停「收到」');

    h.backend.on('POST', '/feishu/intake/messages', STORED);
    await say('还在说');
    expect(h.feishu.of('react').filter((c) => c.emoji === 'Get')).toHaveLength(0);
    expect(
      h.feishu.of('reply').filter((c) => c.message && 'text' in c.message && c.message.text === '收到。'),
    ).toHaveLength(0);

    h.gateway.start();
    await until(() => h.feishu.of('update').length >= 1);
    expect(cardText(h.feishu.of('update')[0])).toContain('只停「收到」');
    expect(h.gateway.status.stopped).toEqual(['ack']);

    h.backend.on('POST', '/feishu/intake/messages', apiError(503, 'unavailable', '后端暂时不可用'));
    await say('这句没存成');
    expect(h.feishu.of('react').some((c) => c.emoji === NOT_STORED_EMOJI)).toBe(true);
    h.feishu.scriptHistory({ messages: [], unrecognized: 0 });
    const before = h.feishu.of('history').length;
    await h.gateway.backfill('tick');
    expect(h.feishu.of('history').length).toBeGreaterThan(before);
    expect(h.gateway.stats.backfill_narrowed ?? 0).toBe(0);
    expect(h.feishu.of('react').filter((c) => c.emoji === 'Get')).toHaveLength(0);
  });

  it('已发出但超时或失败的飞书调用也计入用量，不因为没成功就漏报', async () => {
    h = await harness();
    h.feishu.fail('react', new FeishuError('timeout', '加表情回应：飞书没及时回应'));
    h.feishu.fail('reply', new FeishuError('timeout', '回复消息：飞书没及时回应'));
    h.backend.on('POST', '/feishu/intake/messages', STORED);
    h.backend.on('POST', '/feishu/gateway/usage', { body: OVER });
    await say('给登录页加验证码');
    await h.gateway.reportUsage();
    const reported = h.backend.calls('POST', '/feishu/gateway/usage');
    expect(reported).toHaveLength(1);
    // 表情超时之后改回「收到」也超时：两次都已经打出去。
    expect(reported[0]?.body).toMatchObject({ calls: 2 });
  });

  it('用量上报的回应丢了：同一份 reportId 和次数重报，期间新打的另算一批', async () => {
    h = await harness();
    h.backend.on('POST', '/feishu/intake/messages', STORED);
    h.backend.on('POST', '/feishu/gateway/usage', apiError(500, 'usage_down', '回应丢了'));
    await say('第一句');
    await h.gateway.reportUsage();
    const first = h.backend.calls('POST', '/feishu/gateway/usage')[0]?.body as {
      reportId?: string;
      calls?: number;
    };
    expect(first.reportId).toMatch(/^[0-9a-f-]{36}$/i);
    expect(first.calls).toBe(1);

    // 这一轮按读不到处理，停了「收到」。旧按钮的回复照样打出去，不并进还没确认的那一批。
    await click('om_old', { a: 'ask.answer', k: 'ask-1', o: '批准', _n: 'n1' });
    h.backend.on('POST', '/feishu/gateway/usage', { body: OVER });
    await h.gateway.reportUsage();
    const reported = h.backend.calls('POST', '/feishu/gateway/usage');
    const second = reported[1]?.body as { reportId?: string; calls?: number };
    expect(second).toEqual({ reportId: first.reportId, calls: 1, at: expect.any(String) });
    const third = reported[2]?.body as { reportId?: string; calls?: number };
    expect(third?.reportId).toMatch(/^[0-9a-f-]{36}$/i);
    expect(third?.reportId).not.toBe(first.reportId);
    expect(third?.calls).toBe(1);
    expect(reported).toHaveLength(3);
  });
});
