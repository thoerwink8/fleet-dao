// 网关的四件事，用真实形状的事件喂进去（SDK 的分发器和归一化），后端是真 HTTP 的假服务器，飞书是假的。
// 每一步断言回应、次数和耗时预算：先回应 ≤2 秒、确认卡 ≤10 秒——后端慢也一样。
import { afterEach, describe, expect, it } from 'vitest';
import { checkCard } from '../src/cards.ts';
import { TARGET_ACK_MS, TARGET_CARD_MS } from '../src/gateway.ts';
import {
  A,
  asAction,
  asMenu,
  asMessage,
  B,
  cardEvent,
  menuEvent,
  messageEvent,
  STRANGER,
  TEAM,
  TEST_GROUP,
} from './events.ts';
import { apiError } from './fake-backend.ts';
import { buttonsOf, textIn, titleOf } from './fake-feishu.ts';
import {
  confirmed,
  draft,
  type Harness,
  harness,
  outboxItem,
  REPO_API,
  snapshot,
  TOKEN,
  taskDetail,
  until,
} from './harness.ts';

let h: Harness;
afterEach(async () => {
  await h?.close();
});

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

/** 网关回在用户那条消息下面的卡（确认卡、进度卡……）。 */
function cardReplyTo(userMessageId: string): string {
  const stored = [...h.feishu.messages.values()].find(
    (m) => m.replyTo === userMessageId && 'card' in m.message,
  );
  if (!stored) throw new Error(`${userMessageId} 下面没有回卡`);
  return stored.messageId;
}

function buttonValue(cardMessageId: string, label: string): unknown {
  const b = buttonsOf(h.feishu.cardOf(cardMessageId)).find((x) => x.label === label);
  if (!b?.value) throw new Error(`卡上没有「${label}」按钮`);
  return b.value;
}

describe('随手记任务', () => {
  it('私聊一句话：2 秒内加表情回应，10 秒内回一张「我理解为」确认卡；调后端带通行证、注明代表谁', async () => {
    h = await harness();
    h.backend.on('POST', '/feishu/messages', { body: { kind: 'draft', draft: draft() }, delayMs: 50 });
    const { msg, t0 } = await say('给登录页加手机验证码');

    const react = h.feishu.of('react');
    expect(react).toHaveLength(1);
    expect(react[0]).toMatchObject({ messageId: msg.messageId, emoji: 'Get' });
    expect((react[0]?.at ?? Infinity) - t0).toBeLessThanOrEqual(TARGET_ACK_MS);

    const replies = h.feishu.of('reply');
    expect(replies).toHaveLength(1);
    expect((replies[0]?.at ?? Infinity) - t0).toBeLessThanOrEqual(TARGET_CARD_MS);
    const cardId = cardReplyTo(msg.messageId);
    const card = h.feishu.cardOf(cardId);
    expect(titleOf(card)).toBe('我理解为');
    expect(textIn(card)).toContain('放在：acme/web');
    expect(buttonsOf(card).map((b) => [b.label, b.primary])).toEqual([
      ['确认', true],
      ['改一下', false],
    ]);
    expect(checkCard(card)).toEqual([]);
    // 不另发「收到」：群里只多这一张卡。
    expect(h.feishu.newMessages()).toHaveLength(1);

    const [call] = h.backend.calls('POST', '/feishu/messages');
    expect(call?.headers.authorization).toBe(`Bearer ${TOKEN}`);
    expect(call?.headers['x-fleet-acting-feishu']).toBe(A);
    expect(call?.body).toEqual({
      sourceMessageId: msg.messageId,
      text: '给登录页加手机验证码',
      chatType: 'p2p',
    });

    await until(() => h.backend.calls('PUT', `/feishu/cards/${cardId}`).length === 1);
    expect(h.backend.calls('PUT', `/feishu/cards/${cardId}`)[0]?.body).toMatchObject({
      kind: 'draft',
      ref: { draftId: 'draft-1' },
    });
  });

  it('后端慢（第一次一直不回）：表情照样马上加；先回「正在理解」卡守住 10 秒；后端好了原地改成确认卡，全程一张卡', async () => {
    h = await harness({ timing: { understandWaitMs: 300, understandRetryMs: 50 } });
    let n = 0;
    h.backend.on('POST', '/feishu/messages', () =>
      ++n === 1 ? 'hang' : { body: { kind: 'draft', draft: draft() } },
    );
    const { msg, t0 } = await say('给登录页加手机验证码');

    expect((h.feishu.of('react')[0]?.at ?? Infinity) - t0).toBeLessThan(TARGET_ACK_MS);
    const [placeholder] = h.feishu.of('reply');
    expect(placeholder?.message && 'card' in placeholder.message && titleOf(placeholder.message.card)).toBe(
      '收到，正在理解…',
    );
    expect((placeholder?.at ?? Infinity) - t0).toBeLessThan(TARGET_CARD_MS);

    const cardId = cardReplyTo(msg.messageId);
    expect(titleOf(h.feishu.cardOf(cardId))).toBe('我理解为');
    expect(h.feishu.newMessages()).toHaveLength(1);
    // 重试用同一个消息编号，后端据此不开第二个草稿。
    const ids = h.backend
      .calls('POST', '/feishu/messages')
      .map((r) => (r.body as { sourceMessageId: string }).sourceMessageId);
    expect(new Set(ids)).toEqual(new Set([msg.messageId]));
  });

  it('后端一直连不上：卡最后改成「没记成」，不装作记下了', async () => {
    h = await harness({ timing: { understandWaitMs: 100, understandRetryMs: 20, understandGiveUpMs: 200 } });
    h.backend.on('POST', '/feishu/messages', apiError(503, 'unavailable', '后端暂时不可用'));
    const { msg } = await say('给登录页加手机验证码');
    const card = h.feishu.cardOf(cardReplyTo(msg.messageId));
    expect(titleOf(card)).toBe('这句话没记成');
    expect(textIn(card)).toContain('给登录页加手机验证码');
    expect(h.gateway.stats.understand_gave_up).toBe(1);
  });

  it('后端说这不是任务（问题、闲聊）：直接回那段话，不出确认卡、不出盘面数字', async () => {
    h = await harness();
    h.backend.on('POST', '/feishu/messages', { body: { kind: 'answer', text: '你好，有事直接说。' } });
    const { msg } = await say('你好');
    const [r] = h.feishu.of('reply');
    expect(r?.messageId).toBe(msg.messageId);
    expect(r?.message).toEqual({ text: '你好，有事直接说。' });
  });

  it('群里 @我 就记；群里不 @ 的、不在允许的群里的、机器人自己发的，一律不理', async () => {
    h = await harness();
    h.backend.on('POST', '/feishu/messages', { body: { kind: 'draft', draft: draft() } });
    await say('给登录页加验证码', { chat: 'group', chatId: TEAM });
    await say('给登录页加验证码', { chat: 'group', chatId: TEST_GROUP });
    await say('随便聊聊', { chat: 'group', chatId: TEAM, mentionBot: false });
    await say('给登录页加验证码', { chat: 'group', chatId: 'oc_other_group' });
    await say('我是机器人', { senderType: 'app' });
    expect(h.backend.calls('POST', '/feishu/messages')).toHaveLength(2);
    expect(h.gateway.stats).toMatchObject({ ignored_no_mention: 1, ignored_group: 1, ignored_bot: 1 });
  });

  it('陌生人：礼貌拒绝一次，不调后端；同一天再说不再回，免得来回刷', async () => {
    h = await harness();
    await say('帮我开个任务', { from: STRANGER });
    await say('在吗', { from: STRANGER });
    expect(h.backend.requests).toHaveLength(0);
    const replies = h.feishu.of('reply');
    expect(replies).toHaveLength(1);
    expect(replies[0]?.message).toEqual({ text: expect.stringContaining('只替两位创始人办事') });
    expect(h.feishu.of('react')).toHaveLength(0);
  });

  it('后端不认这个人（403）：说清楚，不说「稍后重试」', async () => {
    h = await harness();
    h.backend.on('POST', '/feishu/messages', apiError(403, 'not_whitelisted', '这个飞书账号不是创始人'));
    await say('给登录页加手机验证码');
    expect(h.feishu.of('reply')[0]?.message).toEqual({ text: expect.stringContaining('不在创始人白名单里') });
  });

  it('确认：卡片当场变「正在开成任务」，后端回了改成「已开成任务 #12」；两个人都点也只开一个', async () => {
    h = await harness();
    h.backend.on('POST', '/feishu/messages', { body: { kind: 'draft', draft: draft() } });
    let n = 0;
    h.backend.on('POST', '/feishu/drafts/:draftId/confirm', () => ({
      body: { draft: confirmed(), alreadyConfirmed: ++n > 1 },
    }));
    const { msg } = await say('给登录页加手机验证码');
    const cardId = cardReplyTo(msg.messageId);
    const value = buttonValue(cardId, '确认');

    await click(cardId, value, { form: {} });
    const titles = h.feishu
      .of('update')
      .filter((u) => u.messageId === cardId)
      .map((u) => titleOf(u.card ?? {}));
    expect(titles).toEqual(['正在开成任务…', '已开成任务 #12']);
    const done = h.feishu.cardOf(cardId);
    expect(checkCard(done)).toEqual([]);
    expect(buttonsOf(done).map((b) => b.label)).toEqual(['打开驾驶舱', '关注']);
    expect(buttonsOf(done)[0]?.url).toBe('https://cockpit.example.test/tasks/task-12');

    await click(cardId, value, { from: B, form: {} });
    expect(textIn(h.feishu.cardOf(cardId))).toContain('没有重复开任务');
    const confirms = h.backend.calls('POST', '/feishu/drafts/draft-1/confirm');
    expect(confirms.map((c) => c.headers['x-fleet-acting-feishu'])).toEqual([A, B]);
    expect(confirms[0]?.body).toEqual({ revision: 1 });
    expect(h.feishu.newMessages()).toHaveLength(1);
    await until(() =>
      h.backend
        .calls('PUT', `/feishu/cards/${cardId}`)
        .some((r) => (r.body as { ref: { taskId?: string } }).ref.taskId === 'task-12'),
    );
  });

  it('点按钮的回调立刻返回；后端慢时卡片先改成「正在…」，不等后端（旧系统点了按钮飞书报超时）', async () => {
    h = await harness();
    h.backend.on('POST', '/feishu/messages', { body: { kind: 'draft', draft: draft() } });
    h.backend.on('POST', '/feishu/drafts/:draftId/confirm', {
      body: { draft: confirmed(), alreadyConfirmed: false },
      delayMs: 1_500,
    });
    const { msg } = await say('给登录页加手机验证码');
    const cardId = cardReplyTo(msg.messageId);
    const evt = await asAction(
      cardEvent({ messageId: cardId, value: buttonValue(cardId, '确认'), form: {} }),
    );
    const t0 = h.feishu.elapsed();
    const started = Date.now();
    h.gateway.onCardAction(evt);
    expect(Date.now() - started).toBeLessThan(50);
    await until(() => h.feishu.of('update').length > 0);
    expect((h.feishu.of('update')[0]?.at ?? Infinity) - t0).toBeLessThan(500);
    expect(titleOf(h.feishu.of('update')[0]?.card ?? {})).toBe('正在开成任务…');
    await h.gateway.idle();
    expect(titleOf(h.feishu.cardOf(cardId))).toBe('已开成任务 #12');
  });

  it('改一下（卡内输入框）：按补充重新理解，卡原地更新；换了仓也带上；什么都没写就提示', async () => {
    h = await harness();
    h.backend.on('POST', '/feishu/messages', { body: { kind: 'draft', draft: draft() } });
    h.backend.on('POST', '/feishu/drafts/:draftId/revise', {
      body: {
        draft: draft({ revision: 2, understanding: '只在网页版登录页加短信验证码。', repo: REPO_API }),
      },
    });
    const { msg } = await say('给登录页加手机验证码');
    const cardId = cardReplyTo(msg.messageId);

    await click(cardId, buttonValue(cardId, '改一下'), { form: { note: '  ', repo: 'repo-web' } });
    expect(h.backend.calls('POST', '/feishu/drafts/draft-1/revise')).toHaveLength(0);
    expect(textIn(h.feishu.cardOf(cardId))).toContain('在输入框里写上要改哪里');

    await click(cardId, buttonValue(cardId, '改一下'), { form: { note: '只做网页版', repo: 'repo-api' } });
    const [rev] = h.backend.calls('POST', '/feishu/drafts/draft-1/revise');
    expect(rev?.body).toMatchObject({ note: '只做网页版', repoId: 'repo-api' });
    expect(rev?.body).toHaveProperty('requestId', expect.stringMatching(/^[0-9a-f]{32}$/));
    const card = h.feishu.cardOf(cardId);
    expect(textIn(card)).toContain('只在网页版登录页加短信验证码。');
    expect(textIn(card)).toContain('放在：acme/api');
    // 新一版的按钮带新的 revision：确认的就是卡上看到的这一版。
    expect(buttonValue(cardId, '确认')).toMatchObject({ a: 'draft.confirm', r: 2 });
  });

  it('写了补充却点了「确认」：先按补充改，请他再看一眼，不直接开任务', async () => {
    h = await harness();
    h.backend.on('POST', '/feishu/messages', { body: { kind: 'draft', draft: draft() } });
    h.backend.on('POST', '/feishu/drafts/:draftId/revise', { body: { draft: draft({ revision: 2 }) } });
    const { msg } = await say('给登录页加手机验证码');
    const cardId = cardReplyTo(msg.messageId);
    await click(cardId, buttonValue(cardId, '确认'), { form: { note: '先不做小程序' } });
    expect(h.backend.calls('POST', '/feishu/drafts/draft-1/confirm')).toHaveLength(0);
    expect(h.backend.calls('POST', '/feishu/drafts/draft-1/revise')).toHaveLength(1);
    expect(textIn(h.feishu.cardOf(cardId))).toContain('看一眼再确认');
  });

  it('确认时草稿刚被另一位改过（409）：卡换成最新一版，请他再确认', async () => {
    h = await harness();
    h.backend.on('POST', '/feishu/messages', { body: { kind: 'draft', draft: draft() } });
    h.backend.on(
      'POST',
      '/feishu/drafts/:draftId/confirm',
      apiError(409, 'draft_changed', '草稿刚被改过', {
        draft: draft({ revision: 3, understanding: '乙改过的理解' }),
      }),
    );
    const { msg } = await say('给登录页加手机验证码');
    const cardId = cardReplyTo(msg.messageId);
    await click(cardId, buttonValue(cardId, '确认'), { form: {} });
    expect(textIn(h.feishu.cardOf(cardId))).toContain('乙改过的理解');
    expect(buttonValue(cardId, '确认')).toMatchObject({ r: 3 });
  });

  it('回复确认卡 = 改一下（回复归到原来那件事，不当成新需求）', async () => {
    h = await harness();
    h.backend.on('POST', '/feishu/messages', { body: { kind: 'draft', draft: draft() } });
    h.backend.on('POST', '/feishu/drafts/:draftId/revise', { body: { draft: draft({ revision: 2 }) } });
    const { msg } = await say('给登录页加手机验证码');
    const cardId = cardReplyTo(msg.messageId);
    const { msg: reply } = await say('只做网页版', { replyTo: cardId });
    expect(h.backend.calls('POST', '/feishu/messages')).toHaveLength(1);
    const [rev] = h.backend.calls('POST', '/feishu/drafts/draft-1/revise');
    expect(rev?.body).toEqual({ requestId: reply.messageId, note: '只做网页版' });
    expect(h.feishu.newMessages()).toHaveLength(1);
  });

  it('回复了一张卡、可卡片登记没查成（后端挂了）：说清楚这条没记，不把「批准」当成新需求', async () => {
    h = await harness();
    h.backend.on('GET', '/feishu/cards/:messageId', apiError(503, 'unavailable', '后端暂时不可用'));
    h.backend.on('POST', '/feishu/messages', { body: { kind: 'draft', draft: draft({ rawText: '批准' }) } });
    const { msg } = await say('批准', { replyTo: 'om_some_card' });
    expect(h.backend.calls('POST', '/feishu/messages')).toHaveLength(0);
    expect(h.feishu.of('reply')).toEqual([
      expect.objectContaining({
        messageId: msg.messageId,
        message: { text: expect.stringContaining('没查到它在说哪件事') },
      }),
    ]);
    expect(h.gateway.stats.reply_context_unknown).toBe(1);
  });

  it('回复的不是我们发的卡（登记里查无此卡）：当成新的一句话', async () => {
    h = await harness();
    h.backend.on('POST', '/feishu/messages', { body: { kind: 'draft', draft: draft() } });
    await say('给登录页加手机验证码', { replyTo: 'om_someone_elses_message' });
    expect(h.backend.calls('GET', '/feishu/cards/om_someone_elses_message')).toHaveLength(1);
    expect(h.backend.calls('POST', '/feishu/messages')[0]?.body).not.toHaveProperty('replyTo');
  });

  it('网关重启后（本地没缓存）回复卡片：从后端的卡片登记查回来历', async () => {
    h = await harness();
    h.backend.on('GET', '/feishu/cards/:messageId', (_, p) => ({
      body: {
        messageId: p.messageId,
        chatId: 'oc_p2p_founder_a',
        kind: 'progress',
        ref: { taskId: 'task-12' },
        sentAt: new Date().toISOString(),
      },
    }));
    h.backend.on('POST', '/feishu/messages', {
      body: { kind: 'answer', text: '卡在测试：验证码过期那条一直红。' },
    });
    await say('12 为什么卡住？', { replyTo: 'om_card_sent_before_restart' });
    expect(h.backend.calls('POST', '/feishu/messages')[0]?.body).toMatchObject({
      replyTo: { kind: 'progress', ref: { taskId: 'task-12' } },
    });
  });
});

describe('查进度与回复即追问', () => {
  it('「进度 12」：回一张进度卡，状态是白话，写明现在在干什么', async () => {
    h = await harness();
    h.backend.on('GET', '/feishu/tasks', {
      body: {
        matches: [
          { taskId: 'task-12', repo: 'acme/web', issueNumber: 12, title: '登录验证码', state: 'running' },
        ],
      },
    });
    h.backend.on('GET', '/tasks/:taskId', { body: taskDetail() });
    const { msg } = await say('进度 12');
    expect(h.backend.calls('POST', '/feishu/messages')).toHaveLength(0);
    expect(h.backend.calls('GET', '/feishu/tasks')[0]?.query.get('issue')).toBe('12');
    const card = h.feishu.cardOf(cardReplyTo(msg.messageId));
    expect(titleOf(card)).toBe('#12 登录验证码');
    const text = textIn(card);
    expect(text).toContain('状态：在干活 · 子任务合并 1/3');
    expect(text).toContain('Opus 5.5 正在写登录页，已 12 分钟');
    expect(text).toContain('等前面的做完');
    expect(checkCard(card)).toEqual([]);
    expect(buttonsOf(card).map((b) => b.label)).toEqual(['打开驾驶舱', '关注', '叫停']);
  });

  it('「进度 404」查无此号、后端挂了：分别说「没找到」和「没查成」', async () => {
    h = await harness();
    h.backend.on('GET', '/feishu/tasks', { body: { matches: [] } });
    await say('进度 404');
    expect(h.feishu.of('reply')[0]?.message).toEqual({ text: expect.stringContaining('没找到 #404') });
    h.backend.on('GET', '/feishu/tasks', apiError(503, 'unavailable', '后端暂时不可用'));
    await say('查进度12');
    expect(h.feishu.of('reply')[1]?.message).toEqual({ text: expect.stringContaining('没查成') });
  });

  it('几个仓都有 #12：出一张挑选卡，点哪个就把这张卡换成它的进度', async () => {
    h = await harness();
    h.backend.on('GET', '/feishu/tasks', {
      body: {
        matches: [
          { taskId: 'task-12', repo: 'acme/web', issueNumber: 12, title: '登录验证码', state: 'running' },
          { taskId: 'task-99', repo: 'acme/api', issueNumber: 12, title: '限流', state: 'done' },
        ],
      },
    });
    h.backend.on('GET', '/tasks/:taskId', { body: taskDetail() });
    const { msg } = await say('进度 #12');
    const pickId = cardReplyTo(msg.messageId);
    expect(titleOf(h.feishu.cardOf(pickId))).toBe('有 2 个 #12');
    await click(pickId, buttonValue(pickId, '看 web'));
    expect(titleOf(h.feishu.cardOf(pickId))).toBe('#12 登录验证码');
  });

  it('私聊里回复进度卡就是追问：带着这张卡的来历问后端，回答回在这条下面', async () => {
    h = await harness();
    h.backend.on('GET', '/feishu/tasks', {
      body: {
        matches: [
          { taskId: 'task-12', repo: 'acme/web', issueNumber: 12, title: '登录验证码', state: 'running' },
        ],
      },
    });
    h.backend.on('GET', '/tasks/:taskId', { body: taskDetail() });
    h.backend.on('POST', '/feishu/messages', {
      body: { kind: 'answer', text: '在等验证码服务的 PR 合并。', taskId: 'task-12' },
    });
    const { msg } = await say('进度 12');
    const progressId = cardReplyTo(msg.messageId);
    const { msg: q } = await say('为什么这么慢？', { replyTo: progressId });
    expect(h.backend.calls('POST', '/feishu/messages')[0]?.body).toEqual({
      sourceMessageId: q.messageId,
      text: '为什么这么慢？',
      chatType: 'p2p',
      replyTo: { kind: 'progress', ref: { taskId: 'task-12' } },
    });
    expect(h.feishu.of('reply').at(-1)).toMatchObject({
      messageId: q.messageId,
      message: { text: '在等验证码服务的 PR 合并。' },
    });
  });

  it('群里回复卡片也行（要 @我）', async () => {
    h = await harness();
    h.backend.on('GET', '/feishu/cards/:messageId', (_, p) => ({
      body: {
        messageId: p.messageId,
        chatId: TEAM,
        kind: 'board',
        ref: {},
        sentAt: new Date().toISOString(),
      },
    }));
    h.backend.on('POST', '/feishu/messages', { body: { kind: 'answer', text: 'Cursor 今天用了 40%。' } });
    await say('今天 Cursor 用了多少？', { chat: 'group', chatId: TEAM, replyTo: 'om_board_card', from: B });
    expect(h.backend.calls('POST', '/feishu/messages')[0]?.body).toMatchObject({
      chatType: 'group',
      text: '今天 Cursor 用了多少？',
      replyTo: { kind: 'board', ref: {} },
    });
    expect(h.backend.calls('POST', '/feishu/messages')[0]?.headers['x-fleet-acting-feishu']).toBe(B);
  });
});

describe('推送卡上的按钮：回答追问、叫停、关注', () => {
  async function pushed(item: ReturnType<typeof outboxItem>): Promise<string> {
    let served = false;
    h.backend.on('GET', '/feishu/outbox', () => {
      if (served) return { body: { items: [], quietHours: null, asOf: new Date().toISOString() } };
      served = true;
      return { body: { items: [item], quietHours: null, asOf: new Date().toISOString() } };
    });
    h.backend.on('POST', '/feishu/outbox/acks', { body: { ok: true } });
    await h.gateway.outbox.runOnce();
    const id = h.feishu.of('send').at(-1)?.sentId;
    if (!id) throw new Error('推送卡没发出去');
    return id;
  }

  it('AI 追问卡：直接回复就是回答；点选项也行；别人答过了就说明，不重复落', async () => {
    h = await harness();
    const askCard = await pushed(
      outboxItem({ id: 'ask:2', kind: 'ask', askId: 'ask-2', options: ['阿里云', '腾讯云'] }),
    );
    h.backend.on('POST', '/asks/:askId/answer', { body: { ok: true } });
    await say('用阿里云的', { replyTo: askCard });
    const [ans] = h.backend.calls('POST', '/asks/ask-2/answer');
    expect(ans?.body).toEqual({ answer: '用阿里云的' });
    expect(ans?.headers['x-fleet-acting-feishu']).toBe(A);
    const card = h.feishu.cardOf(askCard);
    expect(textIn(card)).toContain('已回答：用阿里云的 · 甲');
    expect(buttonsOf(card).map((b) => b.label)).toEqual(['打开驾驶舱']);
    expect(h.backend.calls('POST', '/feishu/messages')).toHaveLength(0);

    const decision = await pushed(outboxItem({ id: 'ask:1' }));
    h.backend.on('POST', '/asks/:askId/answer', apiError(409, 'already_answered', '这条追问已经有人回答了'));
    await click(decision, buttonValue(decision, '批准'), { from: B });
    expect(h.backend.calls('POST', '/asks/ask-1/answer')[0]?.body).toEqual({ answer: '批准' });
    expect(textIn(h.feishu.cardOf(decision))).toContain('已经有人回答过了');
  });

  it('卡住报警上点「叫停」：调叫停接口，卡当场标上已叫停', async () => {
    h = await harness();
    const item = outboxItem({ id: 'alert:9', kind: 'alert', title: '#9 卡住了', taskId: 'task-9' });
    delete item.askId;
    delete item.options;
    const alert = await pushed(item);
    h.backend.on('POST', '/tasks/:taskId/actions', { body: { ok: true } });
    await click(alert, buttonValue(alert, '叫停'));
    expect(h.backend.calls('POST', '/tasks/task-9/actions')[0]?.body).toEqual({
      action: 'stop',
      reason: '飞书上叫停（甲）',
    });
    const card = h.feishu.cardOf(alert);
    expect(textIn(card)).toContain('已叫停 · 甲');
    expect(buttonsOf(card).map((b) => b.label)).toEqual(['打开驾驶舱']);
  });

  it('进度卡上点「关注」：调关注接口，卡上写明谁关注了', async () => {
    h = await harness();
    h.backend.on('GET', '/feishu/tasks', {
      body: {
        matches: [
          { taskId: 'task-12', repo: 'acme/web', issueNumber: 12, title: '登录验证码', state: 'running' },
        ],
      },
    });
    h.backend.on('GET', '/tasks/:taskId', { body: taskDetail() });
    h.backend.on('POST', '/feishu/follows', { body: { taskId: 'task-12', following: true } });
    const { msg } = await say('进度 12');
    const card = cardReplyTo(msg.messageId);
    await click(card, buttonValue(card, '关注'), { from: B });
    expect(h.backend.calls('POST', '/feishu/follows')[0]?.body).toEqual({ taskId: 'task-12', follow: true });
    expect(textIn(h.feishu.cardOf(card))).toContain('乙 已关注');
  });

  it('认不出的按钮回传值、陌生人点按钮：都不调后端', async () => {
    h = await harness();
    await click('om_whatever', { a: 'launch.missiles' });
    await click('om_whatever', { a: 'board.refresh', n: 'x' }, { from: STRANGER });
    expect(h.backend.requests).toHaveLength(0);
    expect(h.gateway.stats).toMatchObject({ unknown_action: 1, stranger: 1 });
  });
});

describe('机器人菜单（只在私聊里）', () => {
  async function menu(key: string, o: { from?: string; eventId?: string } = {}) {
    const evt = await asMenu(menuEvent({ key, ...o }));
    const t0 = h.feishu.elapsed();
    h.gateway.onMenu(evt);
    await h.gateway.idle();
    return t0;
  }

  it('盘面、我的待办、查进度、新任务：都回到点菜单的人的私聊；盘面快照缓存在本地，第二次不再问后端', async () => {
    h = await harness();
    h.backend.on('GET', '/feishu/board', { body: snapshot() });
    const t0 = await menu('board');
    const [board] = h.feishu.of('send');
    expect(board?.to).toEqual({ openId: A });
    expect(board && board.at - t0).toBeLessThan(3_000);
    const boardCard = board?.message && 'card' in board.message ? board.message.card : {};
    expect(titleOf(boardCard)).toBe('盘面');
    expect(textIn(boardCard)).toContain('在干 3 · 卡住 1 · 等你们点头 2 · 今天合并 4');
    expect(textIn(boardCard)).toContain('Claude A 号 周额度：剩 40%');
    expect(checkCard(boardCard)).toEqual([]);

    await menu('todo', { from: B });
    const todo = h.feishu.of('send')[1];
    expect(todo?.to).toEqual({ openId: B });
    const todoCard = todo?.message && 'card' in todo.message ? todo.message.card : {};
    expect(titleOf(todoCard)).toBe('我的待办 2 件');
    expect(textIn(todoCard)).toContain('要拍：发布到正式环境？ · #7');
    expect(textIn(todoCard)).toContain('要答：验证码用哪家短信？');

    await menu('progress');
    const active = h.feishu.of('send')[2];
    expect(titleOf(active?.message && 'card' in active.message ? active.message.card : {})).toBe(
      '在干的 3 件',
    );

    await menu('new_task');
    expect(h.feishu.of('send')[3]?.message).toEqual({
      text: expect.stringContaining('直接发一句话给我就行'),
    });

    expect(h.backend.calls('GET', '/feishu/board')).toHaveLength(1);
  });

  it('待办以后端库里的为准：总数比列出来的多时写明还有几件，不许回「没有」', async () => {
    h = await harness();
    h.backend.on('GET', '/feishu/board', {
      body: snapshot({ counts: { running: 0, stalled: 0, waitingForYou: 25, mergedToday: 0 } }),
    });
    await menu('todo');
    const todo = h.feishu.of('send')[0];
    const text = textIn(todo?.message && 'card' in todo.message ? todo.message.card : {});
    expect(text).toContain('还有 23 件');
    expect(text).not.toContain('现在没有');
  });

  it('同一个菜单事件重投只回一次；认不出的菜单说明一句并计数；陌生人点菜单礼貌拒绝', async () => {
    h = await harness();
    h.backend.on('GET', '/feishu/board', { body: snapshot() });
    await menu('board', { eventId: 'evt_same' });
    await menu('board', { eventId: 'evt_same' });
    expect(h.feishu.of('send')).toHaveLength(1);
    await menu('lottery');
    expect(h.feishu.of('send')[1]?.message).toEqual({ text: expect.stringContaining('还没接上') });
    await menu('board', { from: STRANGER });
    expect(h.feishu.of('send')[2]).toMatchObject({
      to: { openId: STRANGER },
      message: { text: expect.stringContaining('只替两位创始人') },
    });
    expect(h.gateway.stats).toMatchObject({ menu_duplicate: 1, unknown_menu: 1, stranger: 1 });
  });

  it('后端挂了、本地也没缓存：回「没取到」，不给空盘面', async () => {
    h = await harness();
    h.backend.on('GET', '/feishu/board', apiError(503, 'unavailable', '后端暂时不可用'));
    await menu('board');
    expect(h.feishu.of('send')[0]?.message).toEqual({ text: expect.stringContaining('盘面还没取到') });
  });
});

describe('停机与重启', () => {
  it('停机时手上的活做完再退：在途的理解调用不被掐断，确认卡照样回', async () => {
    h = await harness();
    h.backend.on('POST', '/feishu/messages', { body: { kind: 'draft', draft: draft() }, delayMs: 300 });
    const msg = await asMessage(messageEvent({ text: '给登录页加手机验证码' }));
    h.gateway.onMessage(msg);
    await h.gateway.stop(5_000);
    expect(titleOf(h.feishu.cardOf(cardReplyTo(msg.messageId)))).toBe('我理解为');
  });

  it('「正在理解」卡还在等后端时停机：卡改成「网关正在重启，没来得及记下」，不留一张永远「正在理解」的卡', async () => {
    h = await harness({ timing: { understandWaitMs: 100, understandRetryMs: 5_000 } });
    h.backend.on('POST', '/feishu/messages', 'hang');
    const msg = await asMessage(messageEvent({ text: '给登录页加手机验证码' }));
    h.gateway.onMessage(msg);
    await until(() => h.feishu.of('reply').length === 1);
    await h.gateway.stop(5_000);
    const card = h.feishu.cardOf(cardReplyTo(msg.messageId));
    expect(titleOf(card)).toBe('这句话没记成');
    expect(textIn(card)).toContain('网关正在重启');
  });

  it('重启后回复问题卡作答（本地没这张卡的缓存）：回答照样提交，并在这条下面说一声', async () => {
    h = await harness();
    h.backend.on('GET', '/feishu/cards/:messageId', (_, p) => ({
      body: {
        messageId: p.messageId,
        chatId: TEAM,
        kind: 'ask',
        ref: { askId: 'ask-2', outboxId: 'ask:2' },
        sentAt: new Date().toISOString(),
      },
    }));
    h.backend.on('POST', '/asks/:askId/answer', { body: { ok: true } });
    const { msg } = await say('用阿里云的', { replyTo: 'om_ask_before_restart' });
    expect(h.backend.calls('POST', '/asks/ask-2/answer')[0]?.body).toEqual({ answer: '用阿里云的' });
    expect(h.feishu.of('reply')).toEqual([
      expect.objectContaining({
        messageId: msg.messageId,
        message: { text: expect.stringContaining('已回答：用阿里云的 · 甲') },
      }),
    ]);
  });
});
