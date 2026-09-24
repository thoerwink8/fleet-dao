// 推送出口：一件事一张卡、原地更新不重发、14 天后改不了就换新卡、免打扰、求人卡预算、送达只认 message_id。
import { afterEach, describe, expect, it } from 'vitest';
import { checkCard } from '../src/cards.ts';
import { A, STRANGER, TEAM } from './events.ts';
import { apiError, type Reply } from './fake-backend.ts';
import { buttonsOf, textIn, titleOf, tooOld, unavailable } from './fake-feishu.ts';
import { type Harness, harness, outboxItem } from './harness.ts';

const DAY = 24 * 60 * 60 * 1000;

let h: Harness;
afterEach(async () => {
  await h?.close();
});

type Item = ReturnType<typeof outboxItem>;

/** 后端这一轮给哪些待推送；回执记下来。 */
function serve(batches: Array<{ items: Item[]; quietHours?: { start: string; end: string } | null }>) {
  let i = 0;
  h.backend.on('GET', '/feishu/outbox', (): Reply => {
    const b = batches[i++] ?? { items: [] };
    return { body: { items: b.items, quietHours: b.quietHours ?? null, asOf: new Date().toISOString() } };
  });
  h.backend.on('POST', '/feishu/outbox/acks', { body: { ok: true } });
}

function acks(): Array<{ itemId: string; revision: number; result: Record<string, unknown> }> {
  return h.backend.calls('POST', '/feishu/outbox/acks').flatMap((r) => (r.body as { acks: never[] }).acks);
}

/** 北京时间某一刻（今天）。 */
function beijing(hhmm: string): number {
  const [hh, mm] = hhmm.split(':').map(Number);
  const now = new Date();
  const d = new Date(
    Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate(), (hh ?? 0) - 8, mm ?? 0),
  );
  return d.getTime();
}

describe('推送出口', () => {
  it('同一件事只一张卡：第一次发新卡；状态变了原地更新、不重发；处理完卡变灰、收起按钮', async () => {
    h = await harness();
    const rev1 = outboxItem();
    serve([{ items: [rev1] }]);
    await h.gateway.outbox.runOnce();
    const [send] = h.feishu.of('send');
    expect(send?.to).toEqual({ chatId: TEAM });
    const cardId = send?.sentId ?? '';
    const card = h.feishu.cardOf(cardId);
    expect(checkCard(card)).toEqual([]);
    expect(buttonsOf(card).map((b) => [b.label, b.primary])).toEqual([
      ['批准', true],
      ['拒绝', false],
      ['打开驾驶舱', false],
    ]);
    expect(acks()[0]).toMatchObject({
      itemId: 'ask:1',
      revision: 1,
      result: { status: 'sent', messageId: cardId, chatId: TEAM },
    });

    const delivered = { messageId: cardId, chatId: TEAM, sentAt: new Date().toISOString(), revision: 1 };
    serve([
      { items: [{ ...rev1, revision: 2, lines: ['又补了一句'], delivered }] },
      { items: [{ ...rev1, revision: 3, status: 'done', doneText: '已批准 · 甲 · 14:02', delivered }] },
    ]);
    await h.gateway.outbox.runOnce();
    await h.gateway.outbox.runOnce();
    expect(h.feishu.of('send')).toHaveLength(1);
    expect(h.feishu.of('update').map((u) => u.messageId)).toEqual([cardId, cardId]);
    const done = h.feishu.cardOf(cardId);
    expect(textIn(done)).toContain('已批准 · 甲 · 14:02');
    expect(buttonsOf(done).map((b) => b.label)).toEqual(['打开驾驶舱']);
    expect(acks().map((a) => a.result.status)).toEqual(['sent', 'updated', 'updated']);
  });

  it('回执没送到后端、同一版又来了：不再动飞书，回执照原样再送', async () => {
    h = await harness();
    const item = outboxItem();
    let acked = 0;
    h.backend.on('GET', '/feishu/outbox', {
      body: { items: [item], quietHours: null, asOf: new Date().toISOString() },
    });
    h.backend.on('POST', '/feishu/outbox/acks', () =>
      ++acked === 1 ? apiError(503, 'unavailable', '后端暂时不可用') : { body: { ok: true } },
    );
    await h.gateway.outbox.runOnce();
    await h.gateway.outbox.runOnce();
    expect(h.feishu.of('send')).toHaveLength(1);
    expect(h.feishu.of('update')).toHaveLength(0);
    const posted = h.backend
      .calls('POST', '/feishu/outbox/acks')
      .map((r) => (r.body as { acks: unknown[] }).acks);
    // 第一次没送到；第二轮先补送上一轮的，再送这一轮的（同一个 sent 回执）。
    expect(posted.map((a) => a.length)).toEqual([1, 1, 1]);
    expect(posted[1]).toEqual(posted[2]);
  });

  it('送达只认飞书回的 message_id：飞书没发成就回 failed，不说 sent', async () => {
    h = await harness();
    serve([{ items: [outboxItem()] }]);
    h.feishu.fail('send', unavailable());
    await h.gateway.outbox.runOnce();
    const [ack] = acks();
    expect(ack?.result).toMatchObject({ status: 'failed', error: expect.stringContaining('连不上飞书') });
    expect(Date.parse(String(ack?.result.retryAfter))).toBeGreaterThan(Date.now());
  });

  it('卡片发出超过 14 天改不了：发一张新卡；还没到 14 天但飞书说改不了（230031），也换新卡', async () => {
    h = await harness();
    const old = {
      messageId: 'om_old',
      chatId: TEAM,
      sentAt: new Date(Date.now() - 15 * DAY).toISOString(),
      revision: 1,
    };
    serve([{ items: [outboxItem({ revision: 2, delivered: old })] }]);
    await h.gateway.outbox.runOnce();
    expect(h.feishu.of('update')).toHaveLength(0);
    expect(h.feishu.of('send')).toHaveLength(1);
    expect(acks()[0]?.result).toMatchObject({ status: 'sent' });

    const recent = { ...old, messageId: 'om_recent', sentAt: new Date(Date.now() - 10 * DAY).toISOString() };
    serve([{ items: [outboxItem({ id: 'ask:9', askId: 'ask-9', revision: 2, delivered: recent })] }]);
    h.feishu.fail('update', tooOld());
    await h.gateway.outbox.runOnce();
    expect(h.feishu.of('update').map((u) => u.messageId)).toEqual(['om_recent']);
    expect(h.feishu.of('send')).toHaveLength(2);
  });

  it('免打扰时段：不发新卡，回执 deferred 到结束；已发过的卡照样原地更新（改卡不响铃）', async () => {
    let now = beijing('23:30');
    h = await harness({ now: () => now });
    const delivered = {
      messageId: 'om_sent',
      chatId: TEAM,
      sentAt: new Date(now - DAY).toISOString(),
      revision: 1,
    };
    serve([
      {
        items: [outboxItem({ id: 'ask:new' }), outboxItem({ id: 'ask:old', revision: 2, delivered })],
        quietHours: { start: '23:00', end: '08:00' },
      },
    ]);
    await h.gateway.outbox.runOnce();
    expect(h.feishu.of('send')).toHaveLength(0);
    expect(h.feishu.of('update').map((u) => u.messageId)).toEqual(['om_sent']);
    const [deferred, updated] = acks();
    expect(deferred?.result).toMatchObject({ status: 'deferred', reason: 'quiet_hours' });
    expect(Date.parse(String(deferred?.result.until))).toBe(beijing('08:00') + DAY);
    expect(updated?.result).toMatchObject({ status: 'updated' });

    now = beijing('08:00') + DAY;
    serve([{ items: [outboxItem({ id: 'ask:new' })], quietHours: { start: '23:00', end: '08:00' } }]);
    await h.gateway.outbox.runOnce();
    expect(h.feishu.of('send')).toHaveLength(1);
  });

  it('只发给创始人：私聊对象不在白名单就不发；关注推送私聊发给关注的人', async () => {
    h = await harness();
    serve([
      {
        items: [
          outboxItem({ id: 'follow:t:x', kind: 'follow', to: { type: 'user', openId: STRANGER } }),
          outboxItem({
            id: 'follow:t:a',
            kind: 'follow',
            to: { type: 'user', openId: A },
            title: '#12 PR 开了',
          }),
        ],
      },
    ]);
    await h.gateway.outbox.runOnce();
    expect(acks().map((a) => a.result)).toEqual([
      { status: 'dropped', reason: 'not_founder' },
      expect.objectContaining({ status: 'sent' }),
    ]);
    expect(h.feishu.of('send').map((s) => s.to)).toEqual([{ openId: A }]);
  });

  it('还没发过卡就已处理完的：不再发新卡（只进日报和驾驶舱）', async () => {
    h = await harness();
    serve([{ items: [outboxItem({ status: 'done', doneText: '已在驾驶舱批准' })] }]);
    await h.gateway.outbox.runOnce();
    expect(h.feishu.of('send')).toHaveLength(0);
    expect(acks()[0]?.result).toEqual({ status: 'dropped', reason: 'already_done' });
  });

  it('求人的卡超预算：超出的不单独发卡，团队群只收到一张「超预算」提醒', async () => {
    h = await harness({ askBudgetPerDay: 2 });
    const items = [1, 2, 3, 4].map((i) => outboxItem({ id: `ask:${i}`, askId: `ask-${i}` }));
    serve([
      { items: items.slice(0, 3) },
      { items: [items[3] as Item, outboxItem({ id: 'daily:1', kind: 'daily' })] },
    ]);
    await h.gateway.outbox.runOnce();
    await h.gateway.outbox.runOnce();
    expect(acks().map((a) => [a.itemId, a.result.status])).toEqual([
      ['ask:1', 'sent'],
      ['ask:2', 'sent'],
      ['ask:3', 'dropped'],
      ['ask:4', 'dropped'],
      ['daily:1', 'sent'],
    ]);
    const alerts = h.feishu
      .of('send')
      .filter((s) => s.message && 'card' in s.message && titleOf(s.message.card).includes('超预算'));
    expect(alerts).toHaveLength(1);
    expect(alerts[0]?.to).toEqual({ chatId: TEAM });
  });

  it('后端给的待推送认不出（不在约定里的种类）：这批明确报错，不发卡、不回执，不当成「没有待推送」', async () => {
    h = await harness();
    h.backend.on('GET', '/feishu/outbox', {
      body: {
        items: [{ ...outboxItem(), kind: 'gossip' }],
        quietHours: null,
        asOf: new Date().toISOString(),
      },
    });
    await expect(h.gateway.outbox.runOnce()).rejects.toMatchObject({ kind: 'bad_response' });
    expect(h.feishu.calls).toHaveLength(0);
    expect(h.backend.calls('POST', '/feishu/outbox/acks')).toHaveLength(0);
  });

  it('后端连不上：退避重试，不原地打转', async () => {
    h = await harness();
    h.backend.on('GET', '/feishu/outbox', apiError(503, 'unavailable', '后端暂时不可用'));
    const stop = new AbortController();
    const run = h.gateway.outbox.run(stop.signal);
    await new Promise((r) => setTimeout(r, 1_500));
    stop.abort();
    await run;
    // 退避是 1 秒、2 秒……：1.5 秒里最多问两次。
    expect(h.backend.calls('GET', '/feishu/outbox').length).toBeLessThanOrEqual(2);
    expect(h.logs.some((l) => l.message === '取待推送没成功，稍后重试')).toBe(true);
  });
});
