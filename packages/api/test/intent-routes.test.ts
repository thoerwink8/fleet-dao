// 网关的意图接口（#553 第 4 条，#795 补拒收、进群、用量）：门、收原话、撤回、补漏游标、意图卡、回执。
// 方案第六节 B1–B6、B9、B11、B12 落在接口这一层的那半；存储那半在 intent-store-contract.ts。
import {
  FEISHU_JOIN_REASON,
  FEISHU_MONTHLY_CALL_LIMIT,
  FEISHU_OUTSIDER_JOINED_TITLE,
  FEISHU_OUTSIDER_SPOKE_TITLE,
  FEISHU_REJECTION_REASON,
  FEISHU_USAGE_ALERT_TITLE,
} from '@fleet-dao/shared';
import { describe, expect, it } from 'vitest';
import { createMemoryIntentStore, type IntentStore } from '../src/intent-store.ts';
import { CARD_QUIET_MS } from '../src/intents.ts';
import { GATEWAY_PASS, type Harness, harness, T0 } from './harness.ts';

const FOUNDER_A = 'ou_dev_founder_a';

function call(
  h: Harness,
  path: string,
  init: { method?: string; body?: unknown; acting?: string | null; pass?: string | null } = {},
) {
  const headers: Record<string, string> = { 'content-type': 'application/json' };
  if (init.pass !== null) headers.authorization = `Bearer ${init.pass ?? GATEWAY_PASS}`;
  if (init.acting !== null && init.acting !== undefined) headers['X-Fleet-Acting-Feishu'] = init.acting;
  return h.cockpit.request(path, {
    method: init.method ?? (init.body === undefined ? 'GET' : 'POST'),
    headers,
    ...(init.body === undefined ? {} : { body: JSON.stringify(init.body) }),
  });
}

let n = 0;
function message(over: Record<string, unknown> = {}) {
  n += 1;
  const text = (over.text as string | undefined) ?? `第 ${n} 句`;
  return {
    messageId: `om_r${n}`,
    chatId: 'oc_team',
    chatKind: 'group',
    sentAt: T0.toISOString(),
    source: 'event',
    msgType: 'text',
    text,
    rawContent: JSON.stringify({ text }),
    atBot: false,
    newSegment: false,
    ...over,
  };
}

const intake = (h: Harness, body: unknown, acting: string | null = FOUNDER_A) =>
  call(h, '/api/feishu/intake/messages', { body, acting });

describe('意图接口的门', () => {
  it('【故意造出的失败】没带通行证 401、通行证不对 401，什么都不存', async () => {
    const intents = createMemoryIntentStore();
    const h = harness({ intents });
    expect(
      (await call(h, '/api/feishu/intake/messages', { body: message(), acting: FOUNDER_A, pass: null }))
        .status,
    ).toBe(401);
    expect(
      (
        await call(h, '/api/feishu/intake/messages', {
          body: message(),
          acting: FOUNDER_A,
          pass: 'wrong-pass-0123456789abcdef0123',
        })
      ).status,
    ).toBe(401);
    expect((await call(h, '/api/feishu/intent-cards?waitSeconds=0', { pass: null })).status).toBe(401);
    expect(intents.data.messages).toEqual([]);
  });

  it('【故意造出的失败】收原话没说代表谁 403、代表的不是创始人 403（B3）', async () => {
    const intents = createMemoryIntentStore();
    const h = harness({ intents });
    const none = await intake(h, message(), null);
    expect(none.status).toBe(403);
    expect(await none.json()).toMatchObject({ error: { code: 'acting_missing' } });
    const stranger = await intake(h, message(), 'ou_stranger');
    expect(stranger.status).toBe(403);
    expect(await stranger.json()).toMatchObject({ error: { code: 'not_whitelisted' } });
    expect(intents.data.messages).toEqual([]);
  });

  it('【故意造出的失败】意图存储没接上：503 写明没存，不回 200', async () => {
    const h = harness({ intents: null });
    const res = await intake(h, message());
    expect(res.status).toBe(503);
    expect(await res.json()).toMatchObject({ error: { code: 'intents_not_wired' } });
    expect((await call(h, '/api/feishu/intent-cards?waitSeconds=0')).status).toBe(503);
  });
});

describe('收原话', () => {
  it('存下：回第几段；说话人是代表的那位创始人；日志只记长度不记原文', async () => {
    const intents = createMemoryIntentStore();
    const h = harness({ intents });
    const res = await intake(h, message({ text: '只有创始人知道的一句话' }));
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ status: 'stored', intentSeq: 1 });
    expect(intents.data.messages[0]).toMatchObject({
      senderName: '创始人甲',
      text: '只有创始人知道的一句话',
    });
    expect(JSON.stringify(h.logs)).not.toContain('只有创始人知道的一句话');
    expect(h.logs.find((l) => l.message === '收下一条原话')?.fields).toMatchObject({
      chars: 11,
      intentSeq: 1,
    });
  });

  it('【故意造出的失败】文字消息却没有字：400，不存（B1）；图片这类没给字的照存，写明是什么', async () => {
    const intents = createMemoryIntentStore();
    const h = harness({ intents });
    const empty = await intake(h, message({ text: '   ', rawContent: '{"text":"   "}' }));
    expect(empty.status).toBe(400);
    expect(await empty.json()).toMatchObject({ error: { code: 'empty_text' } });
    expect(intents.data.messages).toEqual([]);
    const image = await intake(
      h,
      message({ msgType: 'image', text: '', rawContent: '{"image_key":"img_1"}' }),
    );
    expect(image.status).toBe(200);
    expect(intents.data.messages[0]?.text).toBe('[image 消息：网关没给文字]');
  });

  it('同一条再来是 replayed；【故意造出的失败】同一个编号换了内容又没说改过：409，原来那条不动（B2）', async () => {
    const intents = createMemoryIntentStore();
    const h = harness({ intents });
    const m = message();
    await intake(h, m);
    expect(await (await intake(h, m)).json()).toEqual({ status: 'replayed', intentSeq: 1 });
    const reused = await intake(h, { ...m, text: '换了', rawContent: '{"text":"换了"}' });
    expect(reused.status).toBe(409);
    expect(await reused.json()).toMatchObject({ error: { code: 'message_reused' } });
    expect(intents.data.messages.map((x) => x.text)).toEqual([m.text]);
  });

  it('改过的一版（带 editedAt）：edited，原来那版留着（B12）', async () => {
    const intents = createMemoryIntentStore();
    const h = harness({ intents });
    const m = message({ text: '原来', rawContent: '{"text":"原来"}' });
    await intake(h, m);
    const res = await intake(h, {
      ...m,
      text: '改了',
      rawContent: '{"text":"改了"}',
      editedAt: '2026-09-25T08:01:00.000Z',
    });
    expect(await res.json()).toEqual({ status: 'edited', intentSeq: 1 });
    expect(intents.data.messages[0]).toMatchObject({ text: '改了', edits: [{ text: '原来' }] });
  });

  it('超过旧的 4000 字照样整段存；半个 emoji 换成 � 并记一笔；【故意造出的失败】超过上限整条拒收，不截（B9）', async () => {
    const intents = createMemoryIntentStore();
    const h = harness({ intents });
    const long = '一'.repeat(10_000);
    expect(
      (await intake(h, message({ text: long, rawContent: JSON.stringify({ text: long }) }))).status,
    ).toBe(200);
    expect(intents.data.messages[0]?.text).toBe(long);

    const broken = `半个表情\ud83d在这`;
    expect((await intake(h, message({ text: broken, rawContent: '{"text":"x"}' }))).status).toBe(200);
    expect(intents.data.messages[1]?.text).toBe('半个表情�在这');
    expect(h.logs.some((l) => l.message.includes('残缺的字符') && l.fields?.replaced === 1)).toBe(true);

    const huge = 'x'.repeat(150_001);
    const tooLong = await intake(h, message({ text: huge, rawContent: '{}' }));
    expect(tooLong.status).toBe(400);
    expect(intents.data.messages).toHaveLength(2);
  });

  it('【故意造出的失败】写库失败：500，不回 200（B4）', async () => {
    const memory = createMemoryIntentStore();
    const intents: IntentStore = {
      ...memory,
      intakeMessage: async () => {
        throw new Error('库连不上');
      },
    };
    const h = harness({ intents });
    const res = await intake(h, message());
    expect(res.status).toBe(500);
  });
});

describe('撤回、补漏游标', () => {
  it('撤回存下的：recalled；还没到的：tombstone；【故意造出的失败】会话对不上：409（B11）', async () => {
    const h = harness();
    const m = message();
    await intake(h, m);
    const recall = (body: Record<string, unknown>) => call(h, '/api/feishu/intake/recalls', { body });
    const base = { chatId: 'oc_team', recalledAt: '2026-09-25T08:02:00.000Z', source: 'event' };
    expect(await (await recall({ ...base, messageId: m.messageId })).json()).toEqual({
      status: 'recalled',
      intentSeq: 1,
    });
    expect(await (await recall({ ...base, messageId: 'om_not_yet' })).json()).toEqual({
      status: 'tombstone',
    });
    const wrong = await recall({ ...base, chatId: 'oc_other', messageId: m.messageId });
    expect(wrong.status).toBe(409);
    expect(await wrong.json()).toMatchObject({ error: { code: 'recall_mismatch' } });
  });

  it('游标：没见过的会话写明 known=false（不回 0、不回 1970 年）；见过的给最晚一条（B5）', async () => {
    const h = harness();
    const unknown = await call(h, '/api/feishu/intake/cursors?chatId=oc_never');
    expect(await unknown.json()).toMatchObject({ chats: [{ known: false, chatId: 'oc_never' }] });
    const m = message({ sentAt: '2026-09-25T07:59:00.000Z' });
    await intake(h, m);
    const known = (await (await call(h, '/api/feishu/intake/cursors?chatId=oc_team')).json()) as {
      chats: unknown[];
    };
    expect(known.chats).toEqual([
      {
        known: true,
        chatId: 'oc_team',
        chatKind: 'group',
        lastSentAt: '2026-09-25T07:59:00.000Z',
        lastMessageId: m.messageId,
        messages: 1,
      },
    ]);
    const all = (await (await call(h, '/api/feishu/intake/cursors')).json()) as { chats: unknown[] };
    expect(all.chats).toHaveLength(1);
  });
});

describe('意图卡长轮询、回执', () => {
  it('停下来之前没有卡；到点了给一张没有按钮的卡（标题、条数、等指挥官写归纳）；回执后不再给', async () => {
    const h = harness();
    await intake(h, message());
    const empty = await call(h, '/api/feishu/intent-cards?waitSeconds=0');
    expect(empty.status).toBe(200);
    expect(await empty.json()).toMatchObject({ items: [] });

    h.clock.now = new Date(T0.getTime() + CARD_QUIET_MS.group);
    const body = (await (await call(h, '/api/feishu/intent-cards?waitSeconds=0')).json()) as {
      items: {
        intentId: string;
        cardRev: number;
        title: string;
        lines: string[];
        replyToMessageId: string;
      }[];
    };
    expect(body.items).toHaveLength(1);
    const card = body.items[0];
    expect(card).toMatchObject({ title: '意图 1 · 已存 1 条原话', cardRev: 1 });
    expect(card?.lines).toEqual([
      '创始人甲 1 条 · 09-25 16:00（北京时间）',
      'AI 归纳：对题开单时由指挥官写，写好会更新在这里。',
    ]);

    const ack = await call(h, '/api/feishu/intent-cards/acks', {
      body: {
        acks: [
          { intentId: card?.intentId, cardRev: 1, result: { status: 'sent', messageId: 'om_card_1' } },
          { intentId: 'no-such-intent', cardRev: 1, result: { status: 'sent', messageId: 'om_card_2' } },
        ],
      },
    });
    expect(await ack.json()).toEqual({ applied: 1, skipped: 1 });
    expect(h.logs.some((l) => l.message.includes('回执里有认不出的'))).toBe(true);
    expect(await (await call(h, '/api/feishu/intent-cards?waitSeconds=0')).json()).toMatchObject({
      items: [],
    });
  });

  it('在等的长轮询：有人 @机器人 就马上醒、把卡给出去，不等满', async () => {
    const h = harness();
    const started = Date.now();
    const waiting = call(h, '/api/feishu/intent-cards?waitSeconds=10');
    await new Promise((r) => setTimeout(r, 100));
    await intake(h, message({ atBot: true }));
    const res = await waiting;
    expect(((await res.json()) as { items: unknown[] }).items).toHaveLength(1);
    expect(Date.now() - started).toBeLessThan(5_000);
  });

  it('【故意造出的失败】读不了库：503 写明原因，不回空列表（B6）', async () => {
    const memory = createMemoryIntentStore();
    const intents: IntentStore = {
      ...memory,
      dueCards: async () => {
        throw new Error('connection refused');
      },
    };
    const h = harness({ intents });
    const res = await call(h, '/api/feishu/intent-cards?waitSeconds=0');
    expect(res.status).toBe(503);
    const body = (await res.json()) as { error: { code: string; message: string } };
    expect(body.error.code).toBe('intent_cards_unreadable');
    expect(body.error.message).toContain('connection refused');
  });
});

const SECRET = '秘密原话不要出现在拒收记录里';

async function openAlerts(h: Harness) {
  const { cookie } = await h.login();
  const res = await h.cockpit.request('/api/notifications?status=open', { headers: { cookie } });
  expect(res.status).toBe(200);
  return (await res.json()) as { items: { title: string; body: string }[] };
}

describe('拒收、进群、用量（#795）', () => {
  it('白名单外的人说话：只存群、尾号、时刻、原因；多带原文或长度就 400，驾驶舱提醒一条', async () => {
    const intents = createMemoryIntentStore();
    const h = harness({ intents });
    const at = T0.toISOString();
    const ok = await call(h, '/api/feishu/intake/rejections', {
      body: { chatId: 'oc_team', openIdTail: 'nger', at, reason: FEISHU_REJECTION_REASON },
    });
    expect(ok.status).toBe(200);
    expect(await ok.json()).toEqual({ recorded: true });
    expect(intents.data.rejections).toHaveLength(1);
    expect(Object.keys(intents.data.rejections[0] ?? {}).sort()).toEqual([
      'at',
      'chatId',
      'openIdTail',
      'reason',
      'receivedAt',
    ]);
    expect(JSON.stringify(intents.data.rejections)).not.toContain(SECRET);
    expect(JSON.stringify(intents.data.rejections)).not.toContain('length');

    const again = await call(h, '/api/feishu/intake/rejections', {
      body: { chatId: 'oc_team', openIdTail: 'nger', at, reason: FEISHU_REJECTION_REASON },
    });
    expect(again.status).toBe(200);
    expect(intents.data.rejections).toHaveLength(2);

    const bad = await call(h, '/api/feishu/intake/rejections', {
      body: {
        chatId: 'oc_team',
        openIdTail: 'nger',
        at,
        reason: FEISHU_REJECTION_REASON,
        text: SECRET,
        length: SECRET.length,
      },
    });
    expect(bad.status).toBe(400);
    const badBody = (await bad.json()) as { error: { code: string } };
    expect(badBody.error.code).toBe('invalid_request');
    expect(JSON.stringify(badBody)).not.toContain(SECRET);
    expect(intents.data.rejections).toHaveLength(2);

    const notes = await openAlerts(h);
    const spoke = notes.items.filter((n) => n.title === FEISHU_OUTSIDER_SPOKE_TITLE);
    expect(spoke).toHaveLength(1);
    expect(spoke[0]?.body).toContain('nger');
    expect(spoke[0]?.body).toContain('oc_team');
    expect(spoke[0]?.body).not.toContain(SECRET);
    expect(JSON.stringify(h.logs)).not.toContain(SECRET);
  });

  it('白名单外的人进群：记下尾号，驾驶舱提醒那一句', async () => {
    const intents = createMemoryIntentStore();
    const h = harness({ intents });
    const at = T0.toISOString();
    const res = await call(h, '/api/feishu/intake/joins', {
      body: { chatId: 'oc_team', openIdTails: ['nger'], at, reason: FEISHU_JOIN_REASON },
    });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ recorded: 1 });
    expect(intents.data.joins.map((row) => row.openIdTail)).toEqual(['nger']);
    expect(JSON.stringify(intents.data.joins)).not.toContain(SECRET);
    const notes = await openAlerts(h);
    const joined = notes.items.filter((n) => n.title === FEISHU_OUTSIDER_JOINED_TITLE);
    expect(joined).toHaveLength(1);
    expect(joined[0]?.body).toContain('nger');
    expect(joined[0]?.body).toContain(FEISHU_JOIN_REASON);
  });

  it('用量按北京月累计：81% 驾驶舱报警，下一个月分开算；不到八成不报警；卡上能读出这个月的次数', async () => {
    expect(FEISHU_MONTHLY_CALL_LIMIT).toBe(10_000);
    const intents = createMemoryIntentStore();
    const h = harness({ intents });
    const sep = T0.toISOString();
    const over = await call(h, '/api/feishu/gateway/usage', {
      body: { reportId: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaa1', calls: 8100, at: sep },
    });
    expect(over.status).toBe(200);
    expect(await over.json()).toEqual({
      month: '2026-09',
      calls: 8100,
      limit: 10_000,
      readable: true,
    });
    const octAt = '2026-09-30T16:00:00.000Z';
    const oct = await call(h, '/api/feishu/gateway/usage', {
      body: { reportId: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaa2', calls: 5, at: octAt },
    });
    expect(await oct.json()).toEqual({ month: '2026-10', calls: 5, limit: 10_000, readable: true });

    const cards = (await (await call(h, '/api/feishu/intent-cards?waitSeconds=0')).json()) as {
      usage: { month: string; calls: number; limit: number; readable: boolean };
    };
    expect(cards.usage).toEqual({ month: '2026-09', calls: 8100, limit: 10_000, readable: true });
    h.clock.now = new Date(octAt);
    const cardsOct = (await (await call(h, '/api/feishu/intent-cards?waitSeconds=0')).json()) as {
      usage: { month: string; calls: number; readable: boolean };
    };
    expect(cardsOct.usage).toMatchObject({ month: '2026-10', calls: 5, readable: true });

    const notes = await openAlerts(h);
    const alerts = notes.items.filter((n) => n.title === FEISHU_USAGE_ALERT_TITLE);
    expect(alerts).toHaveLength(1);
    expect(alerts[0]?.body).toContain('8100/10000');
    expect(alerts[0]?.body).toContain('已按顺序降级');
    expect(intents.data.usage).toEqual([
      { month: '2026-09', calls: 8100 },
      { month: '2026-10', calls: 5 },
    ]);
  });

  it('不到八成不报警', async () => {
    const h = harness();
    const res = await call(h, '/api/feishu/gateway/usage', {
      body: { reportId: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaa3', calls: 100, at: T0.toISOString() },
    });
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ month: '2026-09', calls: 100, readable: true });
    const notes = await openAlerts(h);
    expect(notes.items.some((n) => n.title === FEISHU_USAGE_ALERT_TITLE)).toBe(false);
  });

  it('同一份用量上报再来一次不加第二次（回应丢了重报）', async () => {
    const intents = createMemoryIntentStore();
    const h = harness({ intents });
    const body = {
      reportId: 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb',
      calls: 8100,
      at: T0.toISOString(),
    };
    const first = await call(h, '/api/feishu/gateway/usage', { body });
    expect(first.status).toBe(200);
    expect(await first.json()).toMatchObject({ month: '2026-09', calls: 8100, readable: true });
    const again = await call(h, '/api/feishu/gateway/usage', { body: { ...body, calls: 8100 } });
    expect(again.status).toBe(200);
    expect(await again.json()).toMatchObject({ month: '2026-09', calls: 8100, readable: true });
    expect(intents.data.usage).toEqual([{ month: '2026-09', calls: 8100 }]);
    const notes = await openAlerts(h);
    expect(notes.items.filter((n) => n.title === FEISHU_USAGE_ALERT_TITLE)).toHaveLength(1);
  });

  it('【故意造出的失败】用量读不出来：意图卡照回，readable=false，不按八成报警', async () => {
    const memory = createMemoryIntentStore();
    const intents: IntentStore = {
      ...memory,
      usageAt: async () => {
        throw new Error('用量表读不了');
      },
    };
    const h = harness({ intents });
    const res = await call(h, '/api/feishu/intent-cards?waitSeconds=0');
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      items: unknown[];
      usage: { month: string; calls: number; limit: number; readable: boolean };
    };
    expect(body.items).toEqual([]);
    expect(body.usage).toEqual({ month: '2026-09', calls: 0, limit: 10_000, readable: false });
    const notes = await openAlerts(h);
    expect(notes.items.some((n) => n.title === FEISHU_USAGE_ALERT_TITLE)).toBe(false);
    expect(JSON.stringify(body)).not.toContain('用量表读不了');
  });
});
