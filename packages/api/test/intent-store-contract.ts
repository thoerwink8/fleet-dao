// 意图存储契约（#553 第 4 条）：内存版（参照实现）和 Postgres 版过同一套，入口在 intent-store.memory.test.ts /
// intent-store.pg.test.ts。方案第六节 B2、B5、B8、B9、B11、B12 落在存储这一层的那半在这里；接口那半在 intent-routes.test.ts。
import { beforeEach, describe, expect, it } from 'vitest';
import { IDS } from '../src/dev-fixtures.ts';
import type { IntakeMessage, IntentAudit, IntentStore } from '../src/intent-store.ts';
import { CARD_QUIET_MS, composeCard, intentDetail, SEGMENT_WINDOW_MS } from '../src/intents.ts';

export const T0 = new Date('2026-10-04T06:00:00.000Z');
const MIN = 60_000;

export interface IntentStoreUnderTest {
  store: IntentStore;
  /** 写回、放下记下的操作记录（库里 audit_log 读回来的，或内存版记下的）。 */
  audits(): Promise<{ action: string; target: string; before: unknown; after: unknown }[]>;
}

/** 建一个全新的存储；clock.now 就是它的「现在」。Postgres 版要先有两位创始人（原话的说话人外键）。 */
export type MakeIntentStore = (clock: { now: Date }) => Promise<IntentStoreUnderTest>;

const at = (minutes: number) => new Date(T0.getTime() + minutes * MIN).toISOString();

let counter = 0;
/** 一条原话；同一个 messageId 要原样重放就把整个对象再送一遍。 */
export function said(over: Partial<IntakeMessage> = {}): IntakeMessage {
  counter += 1;
  const text = over.text ?? `第 ${counter} 句`;
  return {
    messageId: `om_${counter}`,
    chatId: 'oc_team',
    chatKind: 'group',
    sentAt: T0.toISOString(),
    source: 'event',
    msgType: 'text',
    text,
    rawContent: JSON.stringify({ text }),
    atBot: false,
    newSegment: false,
    senderUserId: IDS.founderA,
    senderName: '创始人甲',
    ...over,
  };
}

const AUDIT: IntentAudit = {
  actor: { kind: 'engine', id: 'ops:intent' },
  action: 'intent.link',
  target: 'intent',
  reason: '测试',
  via: 'engine',
  ok: true,
};
const SUMMARY = { text: '首页改成一屏三块', by: '指挥官会话 · Claude Opus 5.5' };

export function describeIntentStoreContract(name: string, make: MakeIntentStore): void {
  describe(`意图存储契约（${name}）`, () => {
    let clock: { now: Date };
    let s: IntentStoreUnderTest;
    let store: IntentStore;
    beforeEach(async () => {
      clock = { now: new Date(T0) };
      s = await make(clock);
      store = s.store;
    });

    async function seqOf(m: IntakeMessage): Promise<number> {
      const r = await store.intakeMessage(m);
      if (r.status === 'reused') throw new Error(`没存成：${r.why}`);
      return r.intentSeq;
    }
    async function intent(seq: number) {
      const got = await store.get(seq);
      if (!got) throw new Error(`读不到意图 ${seq}`);
      return got;
    }

    describe('收原话、重放、改过（B2、B9、B12）', () => {
      it('第一条另起一段：原话原样存（1 万字、带 emoji 也不截），卡等群里停 5 分钟再出', async () => {
        const long = `${'很长的一段话。'.repeat(1500)}😀`;
        const r = await store.intakeMessage(said({ text: long, rawContent: JSON.stringify({ text: long }) }));
        expect(r).toMatchObject({ status: 'stored', intentSeq: 1, rule: 'fresh' });
        const got = await intent(1);
        expect(got.messages.map((m) => m.text)).toEqual([long]);
        expect(got.messages[0]?.text.length).toBe(long.length);
        expect(got.intent).toMatchObject({
          status: 'new',
          revision: 1,
          links: [],
          card: { rev: 1, attempts: 0 },
        });
        expect(got.intent.card.dueAt).toBe(new Date(T0.getTime() + CARD_QUIET_MS.group).toISOString());
      });

      it('同一条再来（网关重试、飞书重投）：replayed，什么都不改', async () => {
        const m = said();
        await store.intakeMessage(m);
        clock.now = new Date(T0.getTime() + MIN);
        expect(await store.intakeMessage(m)).toMatchObject({ status: 'replayed', intentSeq: 1 });
        const got = await intent(1);
        expect(got.messages).toHaveLength(1);
        expect(got.intent.revision).toBe(1);
      });

      it('【故意造出的失败】同一个编号换了人、换了会话、换了内容又没说改过：reused，原来那条不动', async () => {
        const m = said();
        await store.intakeMessage(m);
        expect(
          await store.intakeMessage({ ...m, senderUserId: IDS.founderB, senderName: '创始人乙' }),
        ).toMatchObject({
          status: 'reused',
        });
        expect(await store.intakeMessage({ ...m, chatId: 'oc_other' })).toMatchObject({ status: 'reused' });
        expect(
          await store.intakeMessage({ ...m, text: '换了', rawContent: JSON.stringify({ text: '换了' }) }),
        ).toMatchObject({ status: 'reused' });
        const got = await intent(1);
        expect(got.messages.map((x) => [x.text, x.senderUserId, x.chatId])).toEqual([
          [m.text, IDS.founderA, 'oc_team'],
        ]);
      });

      it('改过的新一版另存，原来那版留在 edits；晚到的旧一版插进旧版本，最新的不动；卡不用重发', async () => {
        const m = said({ text: '第一版', rawContent: '{"text":"第一版"}' });
        await store.intakeMessage(m);
        const v3 = { ...m, text: '第三版', rawContent: '{"text":"第三版"}', editedAt: at(3) };
        expect(await store.intakeMessage(v3)).toMatchObject({ status: 'edited', intentSeq: 1 });
        const v2 = { ...m, text: '第二版', rawContent: '{"text":"第二版"}', editedAt: at(2) };
        expect(await store.intakeMessage(v2)).toMatchObject({ status: 'edited', intentSeq: 1 });
        // 任何一版再来都是重放
        expect(await store.intakeMessage(m)).toMatchObject({ status: 'replayed' });
        expect(await store.intakeMessage(v2)).toMatchObject({ status: 'replayed' });
        const got = await intent(1);
        const one = got.messages[0];
        expect(one?.text).toBe('第三版');
        expect(one?.editedAt).toBe(at(3));
        // 第一版从发出起到第二版改成（2 分），第二版到第三版改成（3 分）
        expect(one?.edits.map((e) => [e.text, e.replacedAt])).toEqual([
          ['第一版', at(2)],
          ['第二版', at(3)],
        ]);
        expect(got.intent.revision).toBe(3);
        expect(got.intent.card.rev).toBe(1);
      });

      it('第一次收到的就是改过的（原来那版没收到）：照存，记下改动时刻，旧版本是空的', async () => {
        await store.intakeMessage(said({ editedAt: at(1), sentAt: at(0) }));
        const got = await intent(1);
        expect(got.messages[0]?.editedAt).toBe(at(1));
        expect(got.messages[0]?.edits).toEqual([]);
      });
    });

    describe('切段（B8）', () => {
      it('同一会话 15 分钟内接着那段；隔了 15 分钟整另起；窗口边界差一毫秒还在里面', async () => {
        expect(await seqOf(said({ sentAt: at(0) }))).toBe(1);
        expect(await seqOf(said({ sentAt: at(14) }))).toBe(1);
        expect(
          await seqOf(said({ sentAt: new Date(Date.parse(at(14)) + SEGMENT_WINDOW_MS - 1).toISOString() })),
        ).toBe(1);
        expect(
          await seqOf(said({ sentAt: new Date(Date.parse(at(29)) + SEGMENT_WINDOW_MS).toISOString() })),
        ).toBe(2);
        const one = await intent(1);
        expect(intentDetail(one.intent, one.messages).messages.map((m) => m.ord)).toEqual([1, 2, 3]);
        expect(one.intent.lastMessageAt).toBe(
          new Date(Date.parse(at(14)) + SEGMENT_WINDOW_MS - 1).toISOString(),
        );
      });

      it('两位创始人各自的私聊各成一段，不串', async () => {
        const a = await seqOf(said({ chatId: 'oc_p2p_a', chatKind: 'p2p' }));
        const b = await seqOf(
          said({ chatId: 'oc_p2p_b', chatKind: 'p2p', senderUserId: IDS.founderB, senderName: '创始人乙' }),
        );
        expect(a).not.toBe(b);
        expect((await intent(a)).intent.card.dueAt).toBe(
          new Date(T0.getTime() + CARD_QUIET_MS.p2p).toISOString(),
        );
      });

      it('同一个话题算同一段，隔多久都一样；话题里的回复回到主流那段的话就把话题认到那段', async () => {
        const root = said({ sentAt: at(0) });
        expect(await seqOf(root)).toBe(1);
        // 话题里第一条回复：回复的是主流里的那条（parentId），进那段，那段认下这个话题
        expect(await seqOf(said({ sentAt: at(40), threadId: 'omt_1', parentId: root.messageId }))).toBe(1);
        expect((await intent(1)).intent.threadId).toBe('omt_1');
        // 同一个话题一小时后再说：还是那段
        expect(await seqOf(said({ sentAt: at(100), threadId: 'omt_1' }))).toBe(1);
        // 主流里过了 15 分钟另起，不进话题那段
        expect(await seqOf(said({ sentAt: at(100) }))).toBe(2);
        // 一个没见过的话题、回复的也不是存下的话：另起一段，记下话题
        const fresh = await seqOf(said({ sentAt: at(101), threadId: 'omt_2', parentId: 'om_unknown' }));
        expect(fresh).toBe(3);
        expect((await intent(3)).intent.threadId).toBe('omt_2');
      });

      it('回复了某段里的话、或回复了某段的意图卡：进那段，隔多久都一样', async () => {
        const first = said({ sentAt: at(0) });
        await store.intakeMessage(first);
        expect(await seqOf(said({ sentAt: at(60), parentId: first.messageId }))).toBe(1);
        await store.ackCards([
          {
            intentId: (await intent(1)).intent.id,
            cardRev: 1,
            result: { status: 'sent', messageId: 'om_card_1' },
          },
        ]);
        expect(await seqOf(said({ sentAt: at(200), parentId: 'om_card_1' }))).toBe(1);
      });

      it('「@机器人 另起」：15 分钟内、回复卡也另起一段', async () => {
        const first = said({ sentAt: at(0) });
        await store.intakeMessage(first);
        const r = await store.intakeMessage(
          said({ sentAt: at(1), atBot: true, newSegment: true, parentId: first.messageId }),
        );
        expect(r).toMatchObject({ status: 'stored', intentSeq: 2, rule: 'command' });
        // 另起之后的话接着新的那段
        expect(await seqOf(said({ sentAt: at(2) }))).toBe(2);
      });

      it('要接的那段已经开成单（或放下了）：另起一段、记下接着哪段，不往开成的单里塞', async () => {
        await store.intakeMessage(said({ sentAt: at(0) }));
        expect(
          await store.link(
            { seq: 1, issue: 'o/r#5', summary: SUMMARY, operator: 'root', relink: false },
            AUDIT,
          ),
        ).toMatchObject({
          status: 'linked',
        });
        expect(await seqOf(said({ sentAt: at(3) }))).toBe(2);
        expect((await intent(2)).intent.continuesSeq).toBe(1);
        expect(await store.drop({ seq: 2, reason: '闲聊', operator: 'root' }, AUDIT)).toMatchObject({
          status: 'dropped',
        });
        expect(await seqOf(said({ sentAt: at(4) }))).toBe(3);
        expect((await intent(3)).intent.continuesSeq).toBe(2);
      });

      it('补漏乱序：比存下的早、离后面那条不到 15 分钟的，进后面那段，这段的第一条跟着换', async () => {
        const later = said({ sentAt: at(30) });
        await store.intakeMessage(later);
        const early = said({ sentAt: at(20), source: 'backfill' });
        expect(await seqOf(early)).toBe(1);
        const got = await intent(1);
        expect(got.intent.firstMessageId).toBe(early.messageId);
        expect(got.intent.firstMessageAt).toBe(at(20));
        expect(got.messages.map((m) => m.messageId)).toEqual([early.messageId, later.messageId]);
      });
    });

    describe('撤回（B11）', () => {
      it('撤回存下的那条：只标撤回、行不删，卡跟着要改；再撤一次是 already', async () => {
        const m = said();
        await store.intakeMessage(m);
        clock.now = new Date(T0.getTime() + 2 * MIN);
        expect(
          await store.intakeRecall({
            messageId: m.messageId,
            chatId: 'oc_team',
            recalledAt: at(2),
            source: 'event',
          }),
        ).toEqual({
          status: 'recalled',
          intentSeq: 1,
        });
        expect(
          await store.intakeRecall({
            messageId: m.messageId,
            chatId: 'oc_team',
            recalledAt: at(2),
            source: 'event',
          }),
        ).toEqual({
          status: 'already',
          intentSeq: 1,
        });
        const got = await intent(1);
        expect(got.messages[0]?.recalledAt).toBe(at(2));
        expect(got.messages[0]?.text).toBe(m.text);
        expect(got.intent.card.rev).toBe(2);
      });

      it('撤回比原消息先到：先记墓碑，原消息后到直接按撤回存；墓碑再来还是墓碑', async () => {
        const m = said();
        const recall = {
          messageId: m.messageId,
          chatId: 'oc_team',
          recalledAt: at(1),
          source: 'backfill',
        } as const;
        expect(await store.intakeRecall(recall)).toEqual({ status: 'tombstone' });
        expect(await store.intakeRecall(recall)).toEqual({ status: 'tombstone' });
        expect(await store.intakeMessage(m)).toMatchObject({ status: 'recalled', intentSeq: 1 });
        expect((await intent(1)).messages[0]?.recalledAt).toBe(at(1));
        // 一条可读的原话都没有、卡也没发过：不出卡
        clock.now = new Date(T0.getTime() + 60 * MIN);
        expect((await store.dueCards(10)).items).toEqual([]);
      });

      it('【故意造出的失败】撤回说的会话和存下的对不上：reused，不标', async () => {
        const m = said();
        await store.intakeMessage(m);
        expect(
          await store.intakeRecall({
            messageId: m.messageId,
            chatId: 'oc_other',
            recalledAt: at(1),
            source: 'event',
          }),
        ).toMatchObject({
          status: 'reused',
        });
        expect((await intent(1)).messages[0]?.recalledAt).toBeUndefined();
      });

      it('开成单之后撤回：标「开单后在飞书撤回了」，要人定删不删', async () => {
        const m = said();
        await store.intakeMessage(m);
        await store.intakeMessage(said({ sentAt: at(1) }));
        clock.now = new Date(T0.getTime() + 5 * MIN);
        await store.link(
          { seq: 1, issue: 'o/r#5', summary: SUMMARY, operator: 'root', relink: false },
          AUDIT,
        );
        clock.now = new Date(T0.getTime() + 9 * MIN);
        await store.intakeRecall({
          messageId: m.messageId,
          chatId: 'oc_team',
          recalledAt: at(9),
          source: 'event',
        });
        const got = await intent(1);
        const shown = intentDetail(got.intent, got.messages).messages;
        expect(shown.map((x) => [x.messageId, x.recalledAt ?? null, x.recalledAfterLink])).toEqual([
          [m.messageId, at(9), true],
          [got.messages[1]?.messageId, null, false],
        ]);
      });
    });

    describe('补漏游标（B5）', () => {
      it('没见过的会话：空（接口回 known=false），不回 0、不回 1970 年', async () => {
        expect(await store.cursors('oc_never')).toEqual([]);
        expect(await store.cursors()).toEqual([]);
      });

      it('见过的：最晚一条的时刻和编号、共几条；补漏补进来更早的不会让游标往回退', async () => {
        await store.intakeMessage(said({ sentAt: at(5), messageId: 'om_b' }));
        await store.intakeMessage(said({ sentAt: at(1), messageId: 'om_a', source: 'backfill' }));
        await store.intakeMessage(
          said({ chatId: 'oc_p2p_a', chatKind: 'p2p', sentAt: at(2), messageId: 'om_p' }),
        );
        expect(await store.cursors('oc_team')).toEqual([
          { chatId: 'oc_team', chatKind: 'group', lastSentAt: at(5), lastMessageId: 'om_b', messages: 2 },
        ]);
        const all = await store.cursors();
        expect(all.map((c) => c.chatId).sort()).toEqual(['oc_p2p_a', 'oc_team']);
      });
    });

    describe('意图卡：什么时候给网关、回执', () => {
      it('停下来之前不给；到点了给，卡上是条数和「对题时由指挥官写」；@机器人 的马上给', async () => {
        await store.intakeMessage(said({ chatId: 'oc_p2p_a', chatKind: 'p2p' }));
        expect((await store.dueCards(10)).items).toEqual([]);
        expect((await store.dueCards(10)).nextDueAt).toBe(
          new Date(T0.getTime() + CARD_QUIET_MS.p2p).toISOString(),
        );
        clock.now = new Date(T0.getTime() + CARD_QUIET_MS.p2p);
        const due = await store.dueCards(10);
        expect(due.items.map((i) => i.intent.seq)).toEqual([1]);
        const card = composeCard(due.items[0]?.intent ?? (undefined as never), due.items[0]?.messages ?? []);
        expect(card.title).toBe('意图 1 · 已存 1 条原话');
        expect(card.lines.at(-1)).toBe('AI 归纳：对题开单时由指挥官写，写好会更新在这里。');
        expect(card.cardMessageId).toBeUndefined();

        await store.intakeMessage(said({ sentAt: at(20), atBot: true }));
        expect((await store.dueCards(10)).items.map((i) => i.intent.seq)).toEqual([1, 2]);
      });

      it('发了、是最新的：不再给；又来了新话：停下来后原地改同一张（带着卡的编号）', async () => {
        await store.intakeMessage(said({ atBot: true }));
        const [first] = (await store.dueCards(10)).items;
        if (!first) throw new Error('该给的卡没给');
        expect(
          await store.ackCards([
            { intentId: first.intent.id, cardRev: 1, result: { status: 'sent', messageId: 'om_card' } },
          ]),
        ).toEqual({
          applied: 1,
          skipped: [],
        });
        expect((await store.dueCards(10)).items).toEqual([]);
        await store.intakeMessage(said({ sentAt: at(1) }));
        clock.now = new Date(T0.getTime() + CARD_QUIET_MS.group);
        const [again] = (await store.dueCards(10)).items;
        expect(again?.intent.card).toMatchObject({ rev: 2, shownRev: 1, messageId: 'om_card' });
        await store.ackCards([
          { intentId: first.intent.id, cardRev: 2, result: { status: 'updated', messageId: 'om_card' } },
        ]);
        expect((await store.dueCards(10)).items).toEqual([]);
      });

      it('发卡时这段又变了（回执说的是旧版）：记下显示到旧版，接着排着', async () => {
        await store.intakeMessage(said({ atBot: true }));
        const [first] = (await store.dueCards(10)).items;
        if (!first) throw new Error('该给的卡没给');
        await store.intakeMessage(said({ sentAt: at(1), atBot: true }));
        await store.ackCards([
          { intentId: first.intent.id, cardRev: 1, result: { status: 'sent', messageId: 'om_card' } },
        ]);
        const [again] = (await store.dueCards(10)).items;
        expect(again?.intent.card).toMatchObject({ rev: 2, shownRev: 1, messageId: 'om_card' });
      });

      it('【故意造出的失败】没发成：记次数和原因，一分钟后再给；连着没成越隔越久；发成了清零', async () => {
        await store.intakeMessage(said({ atBot: true }));
        const id = (await intent(1)).intent.id;
        await store.ackCards([
          { intentId: id, cardRev: 1, result: { status: 'failed', error: '飞书 230031' } },
        ]);
        let got = await intent(1);
        expect(got.intent.card).toMatchObject({
          attempts: 1,
          error: '飞书 230031',
          dueAt: new Date(T0.getTime() + MIN).toISOString(),
        });
        expect((await store.dueCards(10)).items).toEqual([]);
        await store.ackCards([{ intentId: id, cardRev: 1, result: { status: 'failed', error: '还是不行' } }]);
        got = await intent(1);
        expect(got.intent.card).toMatchObject({
          attempts: 2,
          dueAt: new Date(T0.getTime() + 5 * MIN).toISOString(),
        });
        await store.ackCards([
          { intentId: id, cardRev: 1, result: { status: 'sent', messageId: 'om_card' } },
        ]);
        got = await intent(1);
        expect(got.intent.card).toMatchObject({ attempts: 0, shownRev: 1, messageId: 'om_card' });
        expect(got.intent.card.error).toBeUndefined();
        expect(got.intent.card.dueAt).toBeUndefined();
      });

      it('【故意造出的失败】认不出的回执（没有这段、编号不是这种格式、版本比库里新）：跳过并写明，其余照记', async () => {
        await store.intakeMessage(said({ atBot: true }));
        const id = (await intent(1)).intent.id;
        const report = await store.ackCards([
          {
            intentId: '00000000-0000-4000-8000-000000000000',
            cardRev: 1,
            result: { status: 'sent', messageId: 'om_x' },
          },
          { intentId: 'not-a-uuid', cardRev: 1, result: { status: 'sent', messageId: 'om_x' } },
          { intentId: id, cardRev: 9, result: { status: 'sent', messageId: 'om_x' } },
          { intentId: id, cardRev: 1, result: { status: 'sent', messageId: 'om_card' } },
        ]);
        expect(report.applied).toBe(1);
        expect(report.skipped.map((x) => x.intentId)).toEqual([
          '00000000-0000-4000-8000-000000000000',
          'not-a-uuid',
          id,
        ]);
        expect(report.skipped[2]?.why).toContain('第 9 版');
      });
    });

    describe('指挥官：读、写回归纳和开成的单、放下', () => {
      it('list 按号排、按状态挑；get 读不到给 null', async () => {
        await store.intakeMessage(said({ sentAt: at(0) }));
        await store.intakeMessage(said({ sentAt: at(30) }));
        await store.drop({ seq: 2, reason: '闲聊', operator: 'root' }, AUDIT);
        expect((await store.list({ status: 'new', limit: 10 })).map((i) => i.intent.seq)).toEqual([1]);
        expect((await store.list({ status: 'all', limit: 10 })).map((i) => i.intent.seq)).toEqual([1, 2]);
        expect((await store.list({ status: 'all', limit: 1 })).map((i) => i.intent.seq)).toEqual([1]);
        expect(await store.get(99)).toBeNull();
        expect(await store.get(0)).toBeNull();
      });

      it('写回：归纳带谁写的、几点、覆盖到第几条；卡马上要改；同一张单再写只更新归纳；记操作记录', async () => {
        await store.intakeMessage(said({ sentAt: at(0) }));
        await store.intakeMessage(said({ sentAt: at(1) }));
        clock.now = new Date(T0.getTime() + 10 * MIN);
        const r = await store.link(
          { seq: 1, issue: 'o/r#5', summary: SUMMARY, operator: 'root', relink: false },
          AUDIT,
        );
        expect(r.status).toBe('linked');
        let got = await intent(1);
        expect(got.intent).toMatchObject({
          status: 'linked',
          summary: { ...SUMMARY, at: at(10), covers: 2 },
          links: [{ issue: 'o/r#5', by: 'root', at: at(10) }],
        });
        expect(got.intent.card.dueAt).toBe(at(10));
        const card = composeCard(got.intent, got.messages);
        expect(card.title).toBe('意图 1 · 已开成 o/r#5');
        expect(card.lines.at(-1)).toContain('AI 归纳（指挥官会话 · Claude Opus 5.5 写的，不是原话');
        expect(card.lines.at(-1)).toContain('首页改成一屏三块');

        clock.now = new Date(T0.getTime() + 11 * MIN);
        const again = await store.link(
          {
            seq: 1,
            issue: 'o/r#5',
            summary: { text: '改写过的归纳', by: SUMMARY.by },
            operator: 'root',
            relink: false,
          },
          AUDIT,
        );
        expect(again.status).toBe('updated');
        got = await intent(1);
        expect(got.intent.links).toHaveLength(1);
        expect(got.intent.summary?.text).toBe('改写过的归纳');
        const audits = await s.audits();
        expect(audits).toHaveLength(2);
        expect(audits[0]).toMatchObject({
          action: 'intent.link',
          before: { status: 'new', links: [] },
          after: { status: 'linked', links: ['o/r#5'] },
        });
      });

      it('已经开成了别的单：不带 relink 不挂（写明挂在哪）；带了就再挂一张', async () => {
        await store.intakeMessage(said());
        await store.link(
          { seq: 1, issue: 'o/r#5', summary: SUMMARY, operator: 'root', relink: false },
          AUDIT,
        );
        expect(
          await store.link(
            { seq: 1, issue: 'o/r#6', summary: SUMMARY, operator: 'root', relink: false },
            AUDIT,
          ),
        ).toEqual({
          status: 'already_linked',
          issues: ['o/r#5'],
        });
        expect(
          (
            await store.link(
              { seq: 1, issue: 'o/r#6', summary: SUMMARY, operator: 'root', relink: true },
              AUDIT,
            )
          ).status,
        ).toBe('added');
        expect((await intent(1)).intent.links.map((l) => l.issue)).toEqual(['o/r#5', 'o/r#6']);
      });

      it('【故意造出的失败】没有这段、这段原话全撤回了：不写回、不记操作记录', async () => {
        expect(
          await store.link(
            { seq: 7, issue: 'o/r#5', summary: SUMMARY, operator: 'root', relink: false },
            AUDIT,
          ),
        ).toEqual({
          status: 'not_found',
        });
        const m = said();
        await store.intakeMessage(m);
        await store.intakeRecall({
          messageId: m.messageId,
          chatId: 'oc_team',
          recalledAt: at(1),
          source: 'event',
        });
        expect(
          await store.link(
            { seq: 1, issue: 'o/r#5', summary: SUMMARY, operator: 'root', relink: false },
            AUDIT,
          ),
        ).toEqual({
          status: 'empty',
        });
        expect((await intent(1)).intent.status).toBe('new');
        expect(await s.audits()).toEqual([]);
      });

      it('放下：带理由；再放一次是 already；开成单的不能放下；放下的还能开成单（理由留着）', async () => {
        await store.intakeMessage(said({ sentAt: at(0) }));
        await store.intakeMessage(said({ sentAt: at(30) }));
        clock.now = new Date(T0.getTime() + 40 * MIN);
        expect((await store.drop({ seq: 1, reason: '闲聊', operator: 'root' }, AUDIT)).status).toBe(
          'dropped',
        );
        expect((await store.drop({ seq: 1, reason: '换个理由', operator: 'root' }, AUDIT)).status).toBe(
          'already',
        );
        let got = await intent(1);
        expect(got.intent.dropped).toEqual({ reason: '闲聊', by: 'root', at: at(40) });
        expect(composeCard(got.intent, got.messages).lines).toContain('理由：闲聊');

        await store.link(
          { seq: 2, issue: 'o/r#5', summary: SUMMARY, operator: 'root', relink: false },
          AUDIT,
        );
        expect(await store.drop({ seq: 2, reason: '闲聊', operator: 'root' }, AUDIT)).toEqual({
          status: 'linked',
          issues: ['o/r#5'],
        });
        expect(
          (
            await store.link(
              { seq: 1, issue: 'o/r#9', summary: SUMMARY, operator: 'root', relink: false },
              AUDIT,
            )
          ).status,
        ).toBe('linked');
        got = await intent(1);
        expect(got.intent.status).toBe('linked');
        expect(got.intent.dropped?.reason).toBe('闲聊');
      });
    });
  });
}
