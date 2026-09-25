// 推送出口：一件事一张卡、原地更新不重发、14 天后改不了就换新卡、免打扰、求人卡预算、送达只认 message_id。
import { afterEach, describe, expect, it } from 'vitest';
import { createBackend } from '../src/backend.ts';
import { checkCard } from '../src/cards.ts';
import { createOutbox } from '../src/outbox.ts';
import { A, STRANGER, TEAM } from './events.ts';
import { apiError, type Reply } from './fake-backend.ts';
import { buttonsOf, textIn, titleOf, tooOld, unavailable } from './fake-feishu.ts';
import { type Harness, harness, memoryLogger, outboxItem, TOKEN } from './harness.ts';

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

  it('回执送不到（5xx）：这一轮报没走通（调用方退避）；回执留着下轮先补，同一件事同一版只送一条；同一版再来不再动飞书', async () => {
    h = await harness();
    const item = outboxItem();
    const recorded = new Set<string>();
    let ackCalls = 0;
    // 像真后端：回执收下之前，这件事一直算待推送。
    h.backend.on('GET', '/feishu/outbox', () => ({
      body: {
        items: recorded.has('ask:1#1') ? [] : [item],
        quietHours: null,
        asOf: new Date().toISOString(),
      },
    }));
    h.backend.on('POST', '/feishu/outbox/acks', (req) => {
      if (++ackCalls <= 2) return apiError(503, 'unavailable', '后端暂时不可用');
      for (const a of (req.body as { acks: Array<{ itemId: string; revision: number }> }).acks) {
        recorded.add(`${a.itemId}#${a.revision}`);
      }
      return { body: { ok: true } };
    });
    await expect(h.gateway.outbox.runOnce()).rejects.toThrow('回执没送到后端');
    await expect(h.gateway.outbox.runOnce()).rejects.toThrow('回执没送到后端');
    expect(await h.gateway.outbox.runOnce()).toBe(0);
    expect(h.feishu.of('send')).toHaveLength(1);
    expect(h.feishu.of('update')).toHaveLength(0);
    const posted = h.backend
      .calls('POST', '/feishu/outbox/acks')
      .map((r) => (r.body as { acks: unknown[] }).acks);
    expect(posted.map((a) => a.length)).toEqual([1, 1, 1]);
    expect(posted[0]).toEqual(posted[2]);
    // 第二轮回执没送到就退避了，没有去取新的待推送。
    expect(h.backend.calls('GET', '/feishu/outbox')).toHaveLength(2);
  });

  it('回执被后端拒收（4xx）：记错误、丢掉这批、退避——不再一秒上千次地刷后端，积压不涨', async () => {
    h = await harness();
    h.backend.on('GET', '/feishu/outbox', {
      body: { items: [outboxItem()], quietHours: null, asOf: new Date().toISOString() },
    });
    h.backend.on('POST', '/feishu/outbox/acks', apiError(400, 'invalid_request', '请求内容不符合约定'));
    const stop = new AbortController();
    const run = h.gateway.outbox.run(stop.signal);
    await new Promise((r) => setTimeout(r, 1_500));
    stop.abort();
    await run;
    const posted = h.backend
      .calls('POST', '/feishu/outbox/acks')
      .map((r) => (r.body as { acks: unknown[] }).acks);
    // 退避是 1 秒、2 秒……：1.5 秒里最多两轮；每轮只送这一条，没有越积越多。
    expect(posted.length).toBeGreaterThanOrEqual(1);
    expect(posted.length).toBeLessThanOrEqual(2);
    expect(posted.every((a) => a.length === 1)).toBe(true);
    expect(h.backend.calls('GET', '/feishu/outbox').length).toBeLessThanOrEqual(2);
    expect(h.feishu.of('send')).toHaveLength(1);
    expect(
      h.logs.filter((l) => l.level === 'error' && l.message.includes('被后端拒收')).length,
    ).toBeGreaterThan(0);
  });

  it('被拒收（4xx）的那批回执直接丢掉：报「被后端拒收」，后端恢复后也不再重送这批', async () => {
    h = await harness();
    let reject = true;
    let served = false;
    h.backend.on('GET', '/feishu/outbox', () => {
      const items = served ? [] : [outboxItem()];
      served = true;
      return { body: { items, quietHours: null, asOf: new Date().toISOString() } };
    });
    h.backend.on('POST', '/feishu/outbox/acks', () =>
      reject ? apiError(422, 'unknown_item', '没有这件待推送') : { body: { ok: true } },
    );
    await expect(h.gateway.outbox.runOnce()).rejects.toThrow('被后端拒收');
    reject = false;
    expect(await h.gateway.outbox.runOnce()).toBe(0);
    expect(h.backend.calls('POST', '/feishu/outbox/acks')).toHaveLength(1);
  });

  it('私聊卡飞书没带回 chat_id，回执不合约定：丢掉这条并记错误，后面的推送照常走（不许永远卡在队列里）', async () => {
    h = await harness();
    const send = h.feishu.send.bind(h.feishu);
    h.feishu.send = async (to, message, opts) => {
      const sent = await send(to, message, opts);
      return 'openId' in to ? { ...sent, chatId: '' } : sent;
    };
    serve([
      { items: [outboxItem({ id: 'follow:t:a', kind: 'follow', to: { type: 'user', openId: A } })] },
      {
        items: [
          outboxItem({ id: 'follow:t:b', kind: 'follow', to: { type: 'user', openId: A } }),
          outboxItem({ id: 'daily:2', kind: 'daily' }),
        ],
      },
    ]);
    await h.gateway.outbox.runOnce();
    // 下一轮照常取、照常发；同一批里好的回执不被坏的连累。
    await h.gateway.outbox.runOnce();
    expect(h.feishu.of('send')).toHaveLength(3);
    expect(acks().map((a) => a.itemId)).toEqual(['daily:2']);
    expect(h.logs.some((l) => l.level === 'error' && l.message.includes('回执不合约定'))).toBe(true);
  });

  it('送回执时出了不是后端的错（例如本地校验）：这批丢掉并记错误，不当成「没送到」永远留着', async () => {
    h = await harness();
    const backend = createBackend({ baseUrl: h.backend.url, gatewayToken: TOKEN });
    let ackCalls = 0;
    const outbox = createOutbox({
      backend: {
        ...backend,
        async ackOutbox() {
          ackCalls += 1;
          throw new TypeError('本地出错');
        },
      },
      feishu: h.feishu,
      registry: { remember() {} },
      log: memoryLogger(h.logs),
      now: Date.now,
      teamChatId: TEAM,
      founders: new Set([A]),
      publicUrl: 'https://cockpit.example.test',
      askBudgetPerDay: 10,
      waitSeconds: 0,
    });
    serve([{ items: [outboxItem({ id: 'daily:1', kind: 'daily' })] }, { items: [] }]);
    await expect(outbox.runOnce()).rejects.toThrow('回执没送成');
    expect(await outbox.runOnce()).toBe(0);
    expect(ackCalls).toBe(1);
    expect(h.logs.some((l) => l.level === 'error' && l.message.includes('这批丢掉'))).toBe(true);
  });

  it('积压的回执有上限：后端一直不收，超了丢最早的并记错误', async () => {
    h = await harness();
    const backend = createBackend({ baseUrl: h.backend.url, gatewayToken: TOKEN });
    const outbox = createOutbox({
      backend,
      feishu: h.feishu,
      registry: { remember() {} },
      log: memoryLogger(h.logs),
      now: Date.now,
      teamChatId: TEAM,
      founders: new Set([A]),
      publicUrl: 'https://cockpit.example.test',
      askBudgetPerDay: 10,
      waitSeconds: 0,
      maxPendingAcks: 2,
    });
    let up = false;
    serve([{ items: [1, 2, 3].map((i) => outboxItem({ id: `daily:${i}`, kind: 'daily' })) }]);
    h.backend.on('POST', '/feishu/outbox/acks', () =>
      up ? { body: { ok: true } } : apiError(503, 'x', '暂时不可用'),
    );
    await expect(outbox.runOnce()).rejects.toThrow('回执没送到后端');
    expect(h.logs.some((l) => l.level === 'error' && l.message.includes('超过上限'))).toBe(true);
    up = true;
    await outbox.runOnce();
    const last = h.backend.calls('POST', '/feishu/outbox/acks').at(-1)?.body as {
      acks: Array<{ itemId: string }>;
    };
    expect(last.acks.map((a) => a.itemId)).toEqual(['daily:2', 'daily:3']);
  });

  it('后端收了回执、却又把同一版当待推送给过来：报出来并退避，不原地打转', async () => {
    h = await harness();
    h.backend.on('GET', '/feishu/outbox', {
      body: { items: [outboxItem()], quietHours: null, asOf: new Date().toISOString() },
    });
    h.backend.on('POST', '/feishu/outbox/acks', { body: { ok: true } });
    const stop = new AbortController();
    const run = h.gateway.outbox.run(stop.signal);
    await new Promise((r) => setTimeout(r, 1_500));
    stop.abort();
    await run;
    expect(h.backend.calls('GET', '/feishu/outbox').length).toBeLessThanOrEqual(3);
    expect(h.feishu.of('send')).toHaveLength(1);
    expect(h.logs.some((l) => l.level === 'error' && l.message.includes('已经回执过'))).toBe(true);
  });

  it('免打扰推迟了的，后端没到 until 又给回来：算重复、退避，不原地打转', async () => {
    h = await harness({ now: () => beijing('23:30') });
    // 照最直白的写法：后端不看 until，每次都把这件事给回来。
    h.backend.on('GET', '/feishu/outbox', {
      body: {
        items: [outboxItem({ id: 'ask:new' })],
        quietHours: { start: '23:00', end: '08:00' },
        asOf: new Date().toISOString(),
      },
    });
    h.backend.on('POST', '/feishu/outbox/acks', { body: { ok: true } });
    const stop = new AbortController();
    const run = h.gateway.outbox.run(stop.signal);
    await new Promise((r) => setTimeout(r, 1_500));
    stop.abort();
    await run;
    // 退避是 1 秒、2 秒……：1.5 秒里最多三轮（第一轮推迟、之后每轮都算重复）。
    expect(h.backend.calls('GET', '/feishu/outbox').length).toBeLessThanOrEqual(3);
    expect(h.feishu.of('send')).toHaveLength(0);
    // 重复给回来的，把上次那条回执原样再送一遍（后端弄丢了还能补上），不重新算。
    const sentAcks = acks();
    expect(sentAcks.length).toBeGreaterThanOrEqual(2);
    expect(sentAcks.every((a) => JSON.stringify(a) === JSON.stringify(sentAcks[0]))).toBe(true);
    expect(sentAcks[0]?.result).toMatchObject({ status: 'deferred', reason: 'quiet_hours' });
    expect(h.logs.some((l) => l.level === 'error' && l.message.includes('已经回执过'))).toBe(true);
  });

  it('飞书没发成的，后端没到 retryAfter 又给回来：算重复、退避，不再调飞书；过了 retryAfter 照常重发', async () => {
    let now = Date.now();
    h = await harness({ now: () => now });
    h.backend.on('GET', '/feishu/outbox', {
      body: { items: [outboxItem()], quietHours: null, asOf: new Date().toISOString() },
    });
    h.backend.on('POST', '/feishu/outbox/acks', { body: { ok: true } });
    h.feishu.fail('send', ...Array.from({ length: 5_000 }, () => unavailable()));
    const stop = new AbortController();
    const run = h.gateway.outbox.run(stop.signal);
    await new Promise((r) => setTimeout(r, 1_500));
    stop.abort();
    await run;
    expect(h.feishu.of('send')).toHaveLength(1);
    expect(h.backend.calls('GET', '/feishu/outbox').length).toBeLessThanOrEqual(3);
    const [first] = acks();
    expect(first?.result).toMatchObject({ status: 'failed' });

    // 过了约定的 retryAfter，同一版再来就照常重发。
    now = Date.parse(String(first?.result.retryAfter));
    h.feishu.failures.send = [];
    await h.gateway.outbox.runOnce();
    expect(h.feishu.of('send')).toHaveLength(2);
    expect(acks().at(-1)?.result).toMatchObject({ status: 'sent' });
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
    expect(h.logs.some((l) => l.message === '推送这一轮没走通，退避后重试')).toBe(true);
  });
});
