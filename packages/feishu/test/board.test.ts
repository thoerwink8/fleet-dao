// 团队群置顶盘面卡：只有一张，原地刷新，满 13 天换新并重新置顶；重启后先查登记，查不成不发（免得两张）。
import { afterEach, describe, expect, it } from 'vitest';
import { BOARD_RESEND_AFTER_MS } from '../src/board.ts';
import { checkCard } from '../src/cards.ts';
import { A, asAction, cardEvent, TEAM } from './events.ts';
import { apiError, type Reply } from './fake-backend.ts';
import { buttonsOf, textIn, titleOf } from './fake-feishu.ts';
import { type Harness, harness, snapshot } from './harness.ts';

const DAY = 24 * 60 * 60 * 1000;

let h: Harness;
afterEach(async () => {
  await h?.close();
});

function boardCards(items: Array<{ messageId: string; sentAt: string }>): Reply {
  return {
    body: { items: items.map((i) => ({ ...i, chatId: TEAM, kind: 'board', ref: {} })) },
  };
}

describe('置顶盘面卡', () => {
  it('第一次：发到团队群、置顶、登记；卡上四个数、额度和四个按钮', async () => {
    h = await harness();
    h.backend.on('GET', '/feishu/board', { body: snapshot() });
    h.backend.on('GET', '/feishu/cards', boardCards([]));
    h.backend.on('PUT', '/feishu/cards/:messageId', { body: { ok: true } });
    await h.gateway.board.tick();
    await h.gateway.idle();

    const [send] = h.feishu.of('send');
    expect(send?.to).toEqual({ chatId: TEAM });
    const id = send?.sentId ?? '';
    expect(h.feishu.of('pin')).toEqual([expect.objectContaining({ messageId: id, to: { chatId: TEAM } })]);
    expect(h.backend.calls('GET', '/feishu/cards')[0]?.query.get('kind')).toBe('board');
    expect(h.backend.calls('PUT', `/feishu/cards/${id}`)[0]?.body).toMatchObject({
      kind: 'board',
      chatId: TEAM,
    });
    const card = h.feishu.cardOf(id);
    expect(titleOf(card)).toBe('盘面');
    expect(textIn(card)).toContain('在干 3 · 卡住 1 · 等你们点头 2 · 今天合并 4');
    expect(buttonsOf(card).map((b) => b.label)).toEqual(['打开驾驶舱', '刷新', '看卡住的', '看等我点头的']);
    expect(checkCard(card)).toEqual([]);
  });

  it('重启后：登记里有卡就原地刷新，不发第二张；内容没变不再改，变了才改（两次改卡至少隔 10 秒）', async () => {
    let now = Date.now();
    h = await harness({ now: () => now });
    let snap = snapshot();
    h.backend.on('GET', '/feishu/board', () => ({ body: snap }));
    h.backend.on(
      'GET',
      '/feishu/cards',
      boardCards([{ messageId: 'om_board', sentAt: new Date(now - DAY).toISOString() }]),
    );
    await h.gateway.board.tick();
    now += 1_000;
    await h.gateway.board.tick();
    expect(h.feishu.of('send')).toHaveLength(0);
    expect(h.feishu.of('update').map((u) => u.messageId)).toEqual(['om_board']);

    snap = snapshot({ counts: { running: 4, stalled: 0, waitingForYou: 2, mergedToday: 5 } });
    now += 1_000;
    await h.gateway.board.tick();
    expect(h.feishu.of('update')).toHaveLength(1);
    now += 9_000;
    await h.gateway.board.tick();
    expect(h.feishu.of('update').map((u) => u.messageId)).toEqual(['om_board', 'om_board']);
    expect(textIn(h.feishu.cardOf('om_board'))).toContain('在干 4 · 卡住 0');
  });

  it('盘面快照一直取不到：置顶卡不装作是新的，写明「这是多久前的数、后端没连上」', async () => {
    let now = Date.now();
    h = await harness({ now: () => now });
    let up = true;
    h.backend.on('GET', '/feishu/board', () =>
      up ? { body: snapshot() } : apiError(503, 'unavailable', '后端暂时不可用'),
    );
    h.backend.on(
      'GET',
      '/feishu/cards',
      boardCards([{ messageId: 'om_board', sentAt: new Date(now).toISOString() }]),
    );
    await h.gateway.board.tick();
    expect(textIn(h.feishu.cardOf('om_board'))).not.toContain('没连上');
    up = false;
    now += 11 * 60_000;
    await h.gateway.board.tick();
    expect(textIn(h.feishu.cardOf('om_board'))).toContain('这是 11 分钟前的数：后端现在没连上');
  });

  it('查登记没查成（后端挂了）：这轮不发新卡，免得群里出现两张', async () => {
    h = await harness();
    h.backend.on('GET', '/feishu/board', { body: snapshot() });
    h.backend.on('GET', '/feishu/cards', apiError(503, 'unavailable', '后端暂时不可用'));
    await h.gateway.board.tick();
    expect(h.feishu.of('send')).toHaveLength(0);
    expect(h.feishu.of('update')).toHaveLength(0);
    expect(h.logs.some((l) => l.message.includes('没查成'))).toBe(true);
  });

  it('满 13 天：发新卡、重新置顶、旧卡改成「已换新」（14 天后飞书就不让改了）', async () => {
    const sentAt = Date.now();
    let now = sentAt + DAY;
    h = await harness({ now: () => now });
    h.backend.on('GET', '/feishu/board', { body: snapshot() });
    h.backend.on(
      'GET',
      '/feishu/cards',
      boardCards([{ messageId: 'om_board_old', sentAt: new Date(sentAt).toISOString() }]),
    );
    await h.gateway.board.tick();
    expect(h.feishu.of('send')).toHaveLength(0);

    now = sentAt + BOARD_RESEND_AFTER_MS;
    await h.gateway.board.tick();
    await h.gateway.idle();
    const [send] = h.feishu.of('send');
    const fresh = send?.sentId ?? '';
    expect(send?.to).toEqual({ chatId: TEAM });
    expect(h.feishu.of('pin').map((p) => p.messageId)).toEqual([fresh]);
    expect(titleOf(h.feishu.cardOf(fresh))).toBe('盘面');
    const old = h.feishu
      .of('update')
      .filter((u) => u.messageId === 'om_board_old')
      .at(-1);
    expect(titleOf(old?.card ?? {})).toBe('盘面（旧卡）');
    expect(h.gateway.board.pinned()?.messageId).toBe(fresh);
    expect(h.backend.calls('PUT', `/feishu/cards/${fresh}`)).toHaveLength(1);

    // 再过一轮，不会又发一张。
    now += 60_000;
    await h.gateway.board.tick();
    expect(h.feishu.of('send')).toHaveLength(1);
  });

  it('盘面卡上的按钮：「看卡住的」私聊发清单并在卡上注明；「刷新」现取现改；点过的卡都换上新的回传值', async () => {
    h = await harness();
    h.backend.on('GET', '/feishu/board', { body: snapshot() });
    h.backend.on(
      'GET',
      '/feishu/cards',
      boardCards([{ messageId: 'om_board', sentAt: new Date().toISOString() }]),
    );
    await h.gateway.board.tick();
    const before = buttonsOf(h.feishu.cardOf('om_board') ?? {});

    const stalled = before.find((b) => b.label === '看卡住的')?.value;
    h.gateway.onCardAction(await asAction(cardEvent({ messageId: 'om_board', value: stalled })));
    await h.gateway.idle();
    const [dm] = h.feishu.of('send');
    expect(dm?.to).toEqual({ openId: A });
    const list = dm?.message && 'card' in dm.message ? dm.message.card : {};
    expect(titleOf(list)).toBe('卡住的 1 件');
    expect(textIn(list)).toContain('#9 账单导出（acme/api） — 卡了 3 小时：测试一直红');
    expect(checkCard(list)).toEqual([]);
    expect(textIn(h.feishu.cardOf('om_board'))).toContain('卡住的清单已私聊发给甲');

    const boardCalls = h.backend.calls('GET', '/feishu/board').length;
    const refresh = buttonsOf(h.feishu.cardOf('om_board')).find((b) => b.label === '刷新')?.value;
    expect(refresh).not.toEqual(before.find((b) => b.label === '刷新')?.value);
    h.gateway.onCardAction(await asAction(cardEvent({ messageId: 'om_board', value: refresh })));
    await h.gateway.idle();
    expect(h.backend.calls('GET', '/feishu/board').length).toBe(boardCalls + 1);
    expect(textIn(h.feishu.cardOf('om_board'))).not.toContain('卡住的清单已私聊');
  });
});
