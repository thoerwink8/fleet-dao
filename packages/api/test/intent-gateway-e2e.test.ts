// 网关的真客户端（packages/feishu 的 createBackend，香港跑的同一份）对着真后端的五条意图接口（#553 第 4 条）走一遍：
// 两边各按 shared 的 intent-api.ts 解析，对不上当场红。没存成、读不了库都要在客户端变成抛出来的错，不能变成「好了」或空列表。
import { BackendError, createBackend } from '@fleet-dao/feishu';
import { describe, expect, it } from 'vitest';
import { createMemoryIntentStore, type IntentStore } from '../src/intent-store.ts';
import { CARD_QUIET_MS } from '../src/intents.ts';
import { GATEWAY_PASS, type Harness, harness, T0 } from './harness.ts';

const FOUNDER_A = { openId: 'ou_dev_founder_a' };

function gatewayClient(h: Harness) {
  const doFetch = (async (input: Parameters<typeof fetch>[0], init?: RequestInit) =>
    h.cockpit.request(input, init)) as typeof fetch;
  return createBackend({ baseUrl: 'http://fleet-api.test', gatewayToken: GATEWAY_PASS, fetch: doFetch });
}

let n = 0;
function said(over: Record<string, unknown> = {}) {
  n += 1;
  const text = `第 ${n} 句`;
  return {
    messageId: `om_e2e${n}`,
    chatId: 'oc_team',
    chatKind: 'group' as const,
    sentAt: T0.toISOString(),
    source: 'event' as const,
    msgType: 'text',
    text,
    rawContent: JSON.stringify({ text }),
    atBot: false,
    newSegment: false,
    ...over,
  };
}

describe('网关客户端 ⇄ 后端的意图接口', () => {
  it('收原话、重放、补漏游标、撤回：两边按同一份约定对得上', async () => {
    const h = harness();
    const gw = gatewayClient(h);
    const m = said();
    expect(await gw.intake(FOUNDER_A, m)).toEqual({ status: 'stored', intentSeq: 1 });
    expect(await gw.intake(FOUNDER_A, m)).toEqual({ status: 'replayed', intentSeq: 1 });
    const cursors = await gw.intakeCursors('oc_team');
    expect(cursors.chats).toEqual([
      {
        known: true,
        chatId: 'oc_team',
        chatKind: 'group',
        lastSentAt: T0.toISOString(),
        lastMessageId: m.messageId,
        messages: 1,
      },
    ]);
    expect((await gw.intakeCursors('oc_never')).chats).toEqual([{ known: false, chatId: 'oc_never' }]);
    expect(
      await gw.intakeRecall({
        messageId: m.messageId,
        chatId: 'oc_team',
        recalledAt: T0.toISOString(),
        source: 'event',
      }),
    ).toEqual({ status: 'recalled', intentSeq: 1 });
  });

  it('意图卡：停下来后长轮询拿到卡，回执记上；再取就没有了', async () => {
    const h = harness();
    const gw = gatewayClient(h);
    await gw.intake(FOUNDER_A, said());
    expect((await gw.intentCards(0)).items).toEqual([]);
    h.clock.now = new Date(T0.getTime() + CARD_QUIET_MS.group);
    const [card] = (await gw.intentCards(0)).items;
    if (!card) throw new Error('该给的卡没给');
    expect(card.title).toBe('意图 1 · 已存 1 条原话');
    expect(
      await gw.ackIntentCards([
        { intentId: card.intentId, cardRev: card.cardRev, result: { status: 'sent', messageId: 'om_card' } },
      ]),
    ).toEqual({ applied: 1, skipped: 0 });
    expect((await gw.intentCards(0)).items).toEqual([]);
  });

  it('【故意造出的失败】同编号换了内容：客户端抛 rejected（409 message_reused），网关据此标「没记成」、不重试', async () => {
    const h = harness();
    const gw = gatewayClient(h);
    const m = said();
    await gw.intake(FOUNDER_A, m);
    const err = await gw
      .intake(FOUNDER_A, { ...m, rawContent: '{"text":"换了"}', text: '换了' })
      .catch((e: unknown) => e);
    expect(err).toBeInstanceOf(BackendError);
    expect(err).toMatchObject({ kind: 'rejected', status: 409, code: 'message_reused' });
  });

  it('【故意造出的失败】代表的不是创始人：rejected 403，不存', async () => {
    const intents = createMemoryIntentStore();
    const h = harness({ intents });
    const err = await gatewayClient(h)
      .intake({ openId: 'ou_stranger' }, said())
      .catch((e: unknown) => e);
    expect(err).toMatchObject({ kind: 'rejected', status: 403, code: 'not_whitelisted' });
    expect(intents.data.messages).toEqual([]);
  });

  it('【故意造出的失败】后端存不进、读不了库：客户端抛 server（5xx），不是「好了」也不是空列表', async () => {
    const memory = createMemoryIntentStore();
    const broken: IntentStore = {
      ...memory,
      intakeMessage: async () => {
        throw new Error('库连不上');
      },
      dueCards: async () => {
        throw new Error('connection refused');
      },
    };
    const gw = gatewayClient(harness({ intents: broken }));
    await expect(gw.intake(FOUNDER_A, said())).rejects.toMatchObject({ kind: 'server', status: 500 });
    await expect(gw.intentCards(0)).rejects.toMatchObject({
      kind: 'server',
      status: 503,
      code: 'intent_cards_unreadable',
    });
    const notWired = gatewayClient(harness({ intents: null }));
    await expect(notWired.intake(FOUNDER_A, said())).rejects.toMatchObject({
      kind: 'server',
      status: 503,
      code: 'intents_not_wired',
    });
  });
});
