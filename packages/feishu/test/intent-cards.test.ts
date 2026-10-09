// 意图卡（#553 第 4 条）：长轮询后端要发、要改的意图卡，第一次回复在那段第一条原话下面、之后原地改；卡上没有按钮。
// 送达只认飞书回的 message_id；没发成照样回执（failed 带原因）；取不到、回执送不上去要抛出来让 run() 退避，不当成「没有要发的」。
import { IntentCardSchema } from '@fleet-dao/shared';
import { afterEach, describe, expect, it } from 'vitest';
import { BackendError, createBackend } from '../src/backend.ts';
import { checkCard } from '../src/cards.ts';
import { createIntentCards, intentCard } from '../src/intent-cards.ts';
import { apiError, type FakeBackend, startFakeBackend } from './fake-backend.ts';
import { buttonsOf, FakeFeishu, textIn, titleOf, tooOld, unavailable } from './fake-feishu.ts';
import { type LogLine, memoryLogger, quietCards, TOKEN } from './harness.ts';

const ITEM = IntentCardSchema.parse({
  intentId: '11111111-0000-4000-8000-000000000001',
  seq: 42,
  cardRev: 1,
  chatId: 'oc_team',
  replyToMessageId: 'om_first',
  title: '意图 42 · 已存 3 条原话',
  lines: [
    '甲 2 条、乙 1 条 · 10-04 14:02–14:09（北京时间）',
    'AI 归纳：对题开单时由指挥官写，写好会更新在这里。',
  ],
});

let backend: FakeBackend;
afterEach(async () => {
  await backend?.close();
});

async function setup(
  items: unknown[],
  ack: Parameters<FakeBackend['on']>[2] = { body: { applied: 1, skipped: 0 } },
) {
  backend = await startFakeBackend();
  backend.on('GET', '/feishu/intent-cards', { body: quietCards(items) });
  backend.on('POST', '/feishu/intent-cards/acks', ack);
  const feishu = new FakeFeishu();
  const logs: LogLine[] = [];
  const watched: string[] = [];
  const loop = createIntentCards({
    backend: createBackend({ baseUrl: backend.url, gatewayToken: TOKEN }),
    feishu,
    log: memoryLogger(logs),
    now: Date.now,
    waitSeconds: 0,
    watch: { ok: (l) => watched.push(`ok:${l}`), fail: (l) => watched.push(`fail:${l}`) },
  });
  const acks = () =>
    backend.calls('POST', '/feishu/intent-cards/acks').map((r) => (r.body as { acks: unknown[] }).acks);
  return { feishu, logs, loop, acks, watched };
}

describe('意图卡长什么样', () => {
  it('后端拼好的标题和每行原样摆上，纯文字、没有按钮，飞书认的卡', () => {
    const card = intentCard(ITEM);
    expect(titleOf(card)).toBe('意图 42 · 已存 3 条原话');
    expect(textIn(card)).toContain('甲 2 条、乙 1 条 · 10-04 14:02–14:09（北京时间）');
    expect(textIn(card)).toContain('AI 归纳：对题开单时由指挥官写');
    expect(buttonsOf(card)).toEqual([]);
    expect(checkCard(card, { buttons: 'none' })).toEqual([]);
    const linked = intentCard({ ...ITEM, title: '意图 42 · 已开成 o/r#812' });
    expect((linked.header as { template: string }).template).toBe('green');
  });

  it('【故意造出的失败】不该有按钮的卡上混进一个按钮：查得出来', () => {
    const card = intentCard(ITEM);
    const body = card.body as { elements: unknown[] };
    body.elements.push({
      tag: 'button',
      text: { tag: 'plain_text', content: '确认开单' },
      type: 'primary_filled',
      behaviors: [{ type: 'open_url', default_url: 'https://cockpit.example.test/' }],
    });
    expect(checkCard(card, { buttons: 'none' })).toEqual(['这张卡不该有按钮，却有 1 个']);
  });
});

describe('意图卡长轮询', () => {
  it('第一次：回复在那段第一条原话下面，回执带飞书回的编号', async () => {
    const s = await setup([ITEM]);
    expect(await s.loop.runOnce()).toBe(1);
    const [reply] = s.feishu.of('reply');
    expect(reply?.messageId).toBe('om_first');
    expect(s.acks()).toEqual([
      [{ intentId: ITEM.intentId, cardRev: 1, result: { status: 'sent', messageId: reply?.sentId } }],
    ]);
  });

  it('已经发过：原地改同一张，不发第二张', async () => {
    const s = await setup([{ ...ITEM, cardRev: 3, cardMessageId: 'om_card' }]);
    await s.loop.runOnce();
    expect(s.feishu.of('reply')).toEqual([]);
    expect(s.feishu.of('update').map((c) => c.messageId)).toEqual(['om_card']);
    expect(s.acks()[0]).toEqual([
      { intentId: ITEM.intentId, cardRev: 3, result: { status: 'updated', messageId: 'om_card' } },
    ]);
  });

  it('超过 14 天飞书不让改：新发一张，回执带新编号', async () => {
    const s = await setup([{ ...ITEM, cardRev: 2, cardMessageId: 'om_old_card' }]);
    s.feishu.fail('update', tooOld());
    await s.loop.runOnce();
    const [reply] = s.feishu.of('reply');
    expect(reply?.messageId).toBe('om_first');
    expect(s.acks()[0]).toEqual([
      { intentId: ITEM.intentId, cardRev: 2, result: { status: 'sent', messageId: reply?.sentId } },
    ]);
  });

  it('【故意造出的失败】飞书发不出去：照样回执 failed 带原因（后端过一阵再给），这一轮不算没走通', async () => {
    const s = await setup([ITEM]);
    s.feishu.fail('reply', unavailable());
    expect(await s.loop.runOnce()).toBe(1);
    expect(s.acks()[0]).toEqual([
      {
        intentId: ITEM.intentId,
        cardRev: 1,
        result: { status: 'failed', error: expect.stringContaining('连不上飞书') },
      },
    ]);
    expect(s.logs.some((l) => l.message === '意图卡没发出去')).toBe(true);
  });

  it('没有要发的：回 0，不回执', async () => {
    const s = await setup([]);
    expect(await s.loop.runOnce()).toBe(0);
    expect(s.acks()).toEqual([]);
  });

  it('【故意造出的失败】后端读不了库（503）：抛出来，不当成「没有要发的」，也不碰飞书', async () => {
    const s = await setup([]);
    backend.on(
      'GET',
      '/feishu/intent-cards',
      apiError(503, 'intent_cards_unreadable', '要发的意图卡读不出来'),
    );
    await expect(s.loop.runOnce()).rejects.toMatchObject({ kind: 'server', status: 503 });
    expect(s.feishu.calls).toEqual([]);
  });

  it('【故意造出的失败】回执送不上去：抛出来（run 会退避），卡已经发了的下一轮同一版再来不会发第二张', async () => {
    const s = await setup([ITEM], apiError(500, 'internal', '后端出错了'));
    const err = await s.loop.runOnce().catch((e: unknown) => e);
    expect(err).toBeInstanceOf(BackendError);
    // 回执没送到，后端下一轮还会给同一版：同一个 uuid，飞书一小时内只发一条
    backend.on('POST', '/feishu/intent-cards/acks', { body: { applied: 1, skipped: 0 } });
    await s.loop.runOnce();
    const replies = s.feishu.of('reply');
    expect(replies).toHaveLength(2);
    expect(replies[0]?.uuid).toBe(replies[1]?.uuid);
    expect(s.feishu.newMessages()).toHaveLength(1);
  });

  it('run：没走通记给看守、退避；走通了记一次走通', async () => {
    const s = await setup([]);
    backend.on('GET', '/feishu/intent-cards', apiError(503, 'unavailable', '后端暂时不可用'));
    const stop = new AbortController();
    const running = s.loop.run(stop.signal);
    await new Promise((r) => setTimeout(r, 100));
    backend.on('GET', '/feishu/intent-cards', { body: quietCards() });
    await new Promise((r) => setTimeout(r, 1_300));
    stop.abort();
    await running;
    expect(s.watched[0]).toBe('fail:intents');
    expect(s.watched).toContain('ok:intents');
  });
});
