// 意图存储契约（#553 第 4 条）：内存版（参照实现）和 Postgres 版过同一套，入口在 intent-store.memory.test.ts /
// intent-store.pg.test.ts。飞书收缩后网关不再写意图库（F1 #2051），这里只管读、写回、放下、进群记录和用量；接口那半在 intent-routes.test.ts。

import { beforeEach, describe, expect, it } from 'vitest';
import type { IntentAudit, IntentStore } from '../src/intent-store.ts';
import { composeCard, intentDetail } from '../src/intents.ts';
import type { SeedFn } from './intent-seed.ts';

export const T0 = new Date('2026-10-04T06:00:00.000Z');
const MIN = 60_000;

export interface IntentStoreUnderTest {
  store: IntentStore;
  /** 往库里放一段意图和它的原话（网关不再写，测试自己放）。 */
  seed: SeedFn;
  /** 写回、放下记下的操作记录（库里 audit_log 读回来的，或内存版记下的）。 */
  audits(): Promise<{ action: string; target: string; before: unknown; after: unknown }[]>;
}

/** 建一个全新的存储；clock.now 就是它的「现在」。Postgres 版要先有两位创始人（原话的说话人外键）。 */
export type MakeIntentStore = (clock: { now: Date }) => Promise<IntentStoreUnderTest>;

const at = (minutes: number) => new Date(T0.getTime() + minutes * MIN).toISOString();

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

    const seed = (...sentAts: string[]) =>
      s.seed({ messages: sentAts.map((sentAt, n) => ({ text: `第 ${n + 1} 句`, sentAt })) });
    async function intent(seq: number) {
      const got = await store.get(seq);
      if (!got) throw new Error(`读不到意图 ${seq}`);
      return got;
    }

    describe('指挥官：读、写回归纳和开成的单、放下', () => {
      it('list 按号排、按状态挑；get 读不到给 null', async () => {
        await seed(at(0));
        await seed(at(30));
        await store.drop({ seq: 2, reason: '闲聊', operator: 'root' }, AUDIT);
        expect((await store.list({ status: 'new', limit: 10 })).map((i) => i.intent.seq)).toEqual([1]);
        expect((await store.list({ status: 'all', limit: 10 })).map((i) => i.intent.seq)).toEqual([1, 2]);
        expect((await store.list({ status: 'all', limit: 1 })).map((i) => i.intent.seq)).toEqual([1]);
        expect(await store.get(99)).toBeNull();
        expect(await store.get(0)).toBeNull();
      });

      it('写回：归纳带谁写的、几点、覆盖到第几条；卡马上要改；同一张单再写只更新归纳；记操作记录', async () => {
        await seed(at(0), at(1));
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
        await seed(at(0));
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
        await s.seed({ messages: [{ text: '说了又撤回', sentAt: at(0), recalledAt: at(1) }] });
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
        await seed(at(0));
        await seed(at(30));
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

    describe('进群、用量（#795）', () => {
      const sep = '2026-09-30T15:59:59.000Z';
      const oct = '2026-09-30T16:00:00.000Z';
      const nov = '2026-10-31T16:00:00.000Z';

      it('进群只留下群、尾号、时刻、原因', async () => {
        expect(
          await store.recordJoins({
            chatId: 'oc_team',
            openIdTails: ['nger', 'abcd'],
            at: sep,
            reason: '白名单外的人进了群',
          }),
        ).toBe(2);
        if ('data' in store) {
          const data = (store as { data: { joins: Record<string, unknown>[] } }).data;
          expect(Object.keys(data.joins[0] ?? {}).sort()).toEqual([
            'at',
            'chatId',
            'openIdTail',
            'reason',
            'receivedAt',
          ]);
          expect(data.joins.map((row) => row.openIdTail)).toEqual(['nger', 'abcd']);
          const dumped = JSON.stringify(data.joins);
          expect(dumped).not.toContain('text');
          expect(dumped).not.toContain('length');
        }
      });

      it('用量按北京月累计；同一份上报再来不加第二次；没记过的月是 0；时刻认不出就抛', async () => {
        const once = '11111111-1111-4111-8111-111111111111';
        const more = '22222222-2222-4222-8222-222222222222';
        const next = '33333333-3333-4333-8333-333333333333';
        expect(await store.usageAt(sep)).toEqual({ month: '2026-09', calls: 0 });
        expect(await store.addUsage(once, 100, sep)).toEqual({ month: '2026-09', calls: 100 });
        expect(await store.addUsage(once, 100, sep)).toEqual({ month: '2026-09', calls: 100 });
        expect(await store.addUsage(once, 5000, sep)).toEqual({ month: '2026-09', calls: 100 });
        expect(await store.addUsage(more, 8000, sep)).toEqual({ month: '2026-09', calls: 8100 });
        expect(await store.addUsage(next, 5, oct)).toEqual({ month: '2026-10', calls: 5 });
        expect(await store.usageAt(sep)).toEqual({ month: '2026-09', calls: 8100 });
        expect(await store.usageAt(oct)).toEqual({ month: '2026-10', calls: 5 });
        expect(await store.usageAt(nov)).toEqual({ month: '2026-11', calls: 0 });
        await expect(store.addUsage(once, 1, 'not-a-time')).rejects.toThrow(RangeError);
        await expect(store.usageAt('not-a-time')).rejects.toThrow(RangeError);
      });
    });
  });
}
