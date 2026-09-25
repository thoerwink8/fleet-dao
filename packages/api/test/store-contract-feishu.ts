// Store 契约（飞书那一块）：草稿、收到的话的幂等、关注、卡片登记、盘面要的查询、推送的送达状态与回执。
// 内存版（参照实现）和 Postgres 版过同一套，入口在 store.memory.test.ts / store.pg.test.ts。
import { beforeEach, describe, expect, it } from 'vitest';
import { DEV_USER_ID, devFixtures, IDS } from '../src/dev-fixtures.ts';
import { ANSWER_TEXTS } from '../src/feishu-views.ts';
import type { MemoryData } from '../src/memory-store.ts';
import type { FeishuMessageKey, NewAuditEntry, NewDraft, Store } from '../src/ports.ts';
import type { MakeStore, StoreUnderTest } from './store-contract.ts';

export const T0 = new Date('2026-09-25T08:00:00.000Z');
const MIN = 60_000;
const DAY = 24 * 60 * MIN;
const OTHER_UUID = '99999999-0000-4000-8000-000000000000';

export const FEISHU_IDS = {
  repo2: 'a0000000-0000-4000-8000-000000000002',
  task2of12: 'b0000000-0000-4000-8000-000000000212',
  askOpen: '10000000-0000-4000-8000-000000000001',
  askAnswered: '10000000-0000-4000-8000-000000000002',
  askOld: '10000000-0000-4000-8000-000000000003',
  decision: 'f0000000-0000-4000-8000-000000000002',
  oldAlert: 'f0000000-0000-4000-8000-000000000003',
  draft1: '20000000-0000-4000-8000-000000000001',
  draft2: '20000000-0000-4000-8000-000000000002',
} as const;

const ago = (ms: number) => new Date(T0.getTime() - ms).toISOString();

/** 样例数据再加：第二个仓（也有 12 号）、三条追问（没答的、刚答的、很久以前答的）、要人拍的通知、很久以前处理掉的报警。 */
export function feishuData(): Partial<MemoryData> {
  const data = devFixtures(T0);
  data.repos = [
    ...(data.repos ?? []),
    {
      id: FEISHU_IDS.repo2,
      owner: 'example',
      name: 'another',
      defaultBranch: 'main',
      testCommand: 'pnpm test',
    },
  ];
  data.tasks = [
    ...(data.tasks ?? []),
    {
      id: FEISHU_IDS.task2of12,
      repoId: FEISHU_IDS.repo2,
      issueNumber: 12,
      title: '另一个仓的 12 号',
      rawRequest: '另一个仓的活',
      requestedBy: IDS.founderB,
      state: 'queued',
      priority: 3,
      acceptance: [],
      createdAt: ago(30 * MIN),
    },
  ];
  data.asks = [
    {
      id: FEISHU_IDS.askOpen,
      taskId: IDS.task12,
      runId: IDS.run1,
      question: '验证码几位？\n4 位还是 6 位',
      options: ['4 位', '6 位'],
      askedAt: ago(5 * MIN),
    },
    {
      id: FEISHU_IDS.askAnswered,
      taskId: IDS.task12,
      question: '用哪家短信？',
      options: [],
      askedAt: ago(60 * MIN),
      answer: '阿里云',
      answeredBy: IDS.founderB,
      answeredAt: ago(50 * MIN),
    },
    {
      id: FEISHU_IDS.askOld,
      taskId: IDS.task12,
      question: '很久以前的问题',
      options: [],
      askedAt: ago(40 * DAY),
      answer: '早答了',
      answeredBy: IDS.founderA,
      answeredAt: ago(39 * DAY),
    },
  ];
  data.notifications = [
    ...(data.notifications ?? []),
    {
      id: FEISHU_IDS.decision,
      level: 'decision',
      title: '要批：发版',
      body: '第一行\n第二行',
      taskId: IDS.task12,
      createdAt: ago(3 * MIN),
      deliveries: [],
    },
    {
      id: FEISHU_IDS.oldAlert,
      level: 'alert',
      title: '旧报警',
      body: '',
      createdAt: ago(40 * DAY),
      resolvedAt: ago(39 * DAY),
      resolvedBy: IDS.founderA,
      deliveries: [],
    },
  ];
  return data;
}

const audit = (over: Partial<NewAuditEntry> = {}): NewAuditEntry => ({
  actor: { kind: 'user', id: DEV_USER_ID },
  action: 'test.feishu',
  target: `draft:${FEISHU_IDS.draft1}`,
  via: 'feishu',
  ok: true,
  ...over,
});
/** 违反「ok=false 必须带原因」：拿它测「操作记录写不进，改动一起回滚」。 */
const badAudit = (): NewAuditEntry => audit({ ok: false });

const msg = (sourceMessageId: string, over: Partial<FeishuMessageKey> = {}): FeishuMessageKey => ({
  sourceMessageId,
  userId: IDS.founderA,
  textHash: `hash-${sourceMessageId}`,
  ...over,
});

const newDraft = (over: Partial<NewDraft> = {}): NewDraft => ({
  id: FEISHU_IDS.draft1,
  rawText: '给登录页加手机验证码',
  understanding: '给登录页加手机验证码',
  unsure: true,
  chatType: 'group',
  ...over,
});

export function describeFeishuStoreContract(name: string, make: MakeStore): void {
  describe(`Store 契约（飞书）：${name}`, () => {
    let clock: { now: Date };
    let s: StoreUnderTest;
    let store: Store;

    beforeEach(async () => {
      clock = { now: new Date(T0) };
      s = await make(feishuData(), clock);
      store = s.store;
    });

    const tick = (ms = 1000) => {
      clock.now = new Date(clock.now.getTime() + ms);
    };
    const audits = async () => (await store.listAudit({ limit: 200 })).items.length;

    describe('草稿', () => {
      it('一条消息记一个草稿，和「这条消息处理过」同一事务；同一条消息再来不建第二个，交回当时的结果', async () => {
        const before = await audits();
        const created = await store.createDraft(
          { message: msg('om_1'), draft: newDraft({ repoId: IDS.repo }) },
          audit({ action: 'draft.create' }),
        );
        expect(created).toMatchObject({
          status: 'created',
          draft: {
            id: FEISHU_IDS.draft1,
            revision: 1,
            status: 'open',
            sourceMessageId: 'om_1',
            chatType: 'group',
            rawText: '给登录页加手机验证码',
            unsure: true,
            repoId: IDS.repo,
            proposedBy: IDS.founderA,
            opening: { attempts: 0 },
            createdAt: T0.toISOString(),
            updatedAt: T0.toISOString(),
          },
        });
        expect(await audits()).toBe(before + 1);
        const again = await store.createDraft(
          { message: msg('om_1'), draft: newDraft({ id: FEISHU_IDS.draft2 }) },
          audit(),
        );
        expect(again).toEqual({
          status: 'replayed',
          message: {
            sourceMessageId: 'om_1',
            userId: IDS.founderA,
            textHash: 'hash-om_1',
            result: { kind: 'draft', draftId: FEISHU_IDS.draft1 },
            at: T0.toISOString(),
          },
        });
        expect(await store.getDraft(FEISHU_IDS.draft2)).toBeNull();
        expect(await store.getFeishuMessage('om_1')).toMatchObject({
          result: { kind: 'draft', draftId: FEISHU_IDS.draft1 },
        });
        expect(await audits()).toBe(before + 1);
        expect(await store.getDraft(OTHER_UUID)).toBeNull();
        expect(await store.getDraft('not-a-uuid')).toBeNull();
      });

      it('操作记录写不进：草稿和「消息处理过」都不算（整笔回滚），重来能记成', async () => {
        await expect(
          store.createDraft({ message: msg('om_1'), draft: newDraft() }, badAudit()),
        ).rejects.toThrow();
        expect(await store.getDraft(FEISHU_IDS.draft1)).toBeNull();
        expect(await store.getFeishuMessage('om_1')).toBeNull();
        expect((await store.createDraft({ message: msg('om_1'), draft: newDraft() }, audit())).status).toBe(
          'created',
        );
      });

      it('同一个请求编号换了内容再来（补充不同、仓不同、少了仓）：request_reused，草稿不改、不写操作记录', async () => {
        await store.createDraft({ message: msg('om_1'), draft: newDraft() }, audit());
        const first = await store.reviseDraft(
          {
            draftId: FEISHU_IDS.draft1,
            note: '要 6 位',
            repoId: IDS.repo,
            key: { type: 'request', requestId: 'r1' },
          },
          audit(),
        );
        expect(first.status).toBe('revised');
        const before = await audits();
        tick();
        for (const change of [
          { note: '要 8 位', repoId: IDS.repo },
          { note: '要 6 位', repoId: FEISHU_IDS.repo2 },
          { note: '要 6 位' },
        ]) {
          const r = await store.reviseDraft(
            { draftId: FEISHU_IDS.draft1, ...change, key: { type: 'request', requestId: 'r1' } },
            audit(),
          );
          expect({ change, r }).toMatchObject({
            change,
            r: {
              status: 'request_reused',
              draft: { revision: 2, understanding: '给登录页加手机验证码\n补充：要 6 位', repoId: IDS.repo },
            },
          });
        }
        expect(await store.getDraft(FEISHU_IDS.draft1)).toMatchObject({
          revision: 2,
          understanding: '给登录页加手机验证码\n补充：要 6 位',
          repoId: IDS.repo,
        });
        expect(await audits()).toBe(before);
      });

      it('按请求编号改：补充接在「我理解为」后面、换仓、版本加 1；同一个编号再来不再改；草稿不在是 not_found', async () => {
        await store.createDraft({ message: msg('om_1'), draft: newDraft() }, audit());
        tick();
        const revised = await store.reviseDraft(
          {
            draftId: FEISHU_IDS.draft1,
            note: '要 6 位',
            repoId: IDS.repo,
            key: { type: 'request', requestId: 'r1' },
          },
          audit({ action: 'draft.revise' }),
        );
        expect(revised).toMatchObject({
          status: 'revised',
          draft: {
            revision: 2,
            understanding: '给登录页加手机验证码\n补充：要 6 位',
            repoId: IDS.repo,
            updatedAt: clock.now.toISOString(),
          },
        });
        tick();
        const replay = await store.reviseDraft(
          {
            draftId: FEISHU_IDS.draft1,
            note: '要 6 位',
            repoId: IDS.repo,
            key: { type: 'request', requestId: 'r1' },
          },
          audit(),
        );
        expect(replay).toMatchObject({ status: 'replayed', draft: { revision: 2 } });
        const next = await store.reviseDraft(
          { draftId: FEISHU_IDS.draft1, repoId: FEISHU_IDS.repo2, key: { type: 'request', requestId: 'r2' } },
          audit(),
        );
        expect(next).toMatchObject({
          status: 'revised',
          draft: {
            revision: 3,
            repoId: FEISHU_IDS.repo2,
            understanding: '给登录页加手机验证码\n补充：要 6 位',
          },
        });
        // 同一个请求编号用在别的草稿上不算重复。
        await store.createDraft(
          { message: msg('om_2'), draft: newDraft({ id: FEISHU_IDS.draft2 }) },
          audit(),
        );
        expect(
          (
            await store.reviseDraft(
              { draftId: FEISHU_IDS.draft2, note: 'x', key: { type: 'request', requestId: 'r1' } },
              audit(),
            )
          ).status,
        ).toBe('revised');
        for (const draftId of [OTHER_UUID, 'nope']) {
          expect(
            await store.reviseDraft(
              { draftId, note: 'x', key: { type: 'request', requestId: 'r9' } },
              audit(),
            ),
          ).toEqual({ status: 'not_found' });
        }
      });

      it('按补充改长原话：补充整句接在原话后面（原话不截）；「我理解为」已经满了就截旧的，新补的整句留着', async () => {
        const long = '原'.repeat(1500);
        await store.createDraft(
          {
            message: msg('om_1'),
            draft: newDraft({ rawText: long, understanding: `${'原'.repeat(999)}…` }),
          },
          audit(),
        );
        const r = await store.reviseDraft(
          { draftId: FEISHU_IDS.draft1, note: '  要 6 位 ', key: { type: 'request', requestId: 'r1' } },
          audit(),
        );
        if (r.status !== 'revised') throw new Error(`应当改成，却是 ${r.status}`);
        expect(r.draft.rawText).toBe(`${long}\n补充：要 6 位`);
        expect(r.draft.understanding).toHaveLength(1000);
        expect(r.draft.understanding.endsWith('原…\n补充：要 6 位')).toBe(true);
        expect(await store.getDraft(FEISHU_IDS.draft1)).toMatchObject({
          revision: 2,
          rawText: `${long}\n补充：要 6 位`,
          understanding: r.draft.understanding,
        });
      });

      it('按回复的消息改：同一条消息再来交回当时的结果（不再改）', async () => {
        await store.createDraft({ message: msg('om_1'), draft: newDraft() }, audit());
        const reply = msg('om_reply', { replyToMessageId: 'om_card' });
        const first = await store.reviseDraft(
          { draftId: FEISHU_IDS.draft1, note: '改成短信验证', key: { type: 'message', message: reply } },
          audit(),
        );
        expect(first).toMatchObject({ status: 'revised', draft: { revision: 2 } });
        const again = await store.reviseDraft(
          { draftId: FEISHU_IDS.draft1, note: '改成短信验证', key: { type: 'message', message: reply } },
          audit(),
        );
        expect(again).toMatchObject({
          status: 'replayed_message',
          message: { sourceMessageId: 'om_reply', replyToMessageId: 'om_card', result: { kind: 'draft' } },
        });
        expect((await store.getDraft(FEISHU_IDS.draft1))?.revision).toBe(2);
      });

      it('改草稿时操作记录写不进：一起回滚，同一个编号重来照样能改', async () => {
        await store.createDraft({ message: msg('om_1'), draft: newDraft() }, audit());
        const input = {
          draftId: FEISHU_IDS.draft1,
          note: 'x',
          key: { type: 'request' as const, requestId: 'r1' },
        };
        await expect(store.reviseDraft(input, badAudit())).rejects.toThrow();
        expect((await store.getDraft(FEISHU_IDS.draft1))?.revision).toBe(1);
        expect((await store.reviseDraft(input, audit())).status).toBe('revised');
      });

      it('确认：版本对不上 changed；对上了记下谁、什么时候、哪个仓；再确认是 already；确认过的不能再改', async () => {
        await store.createDraft({ message: msg('om_1'), draft: newDraft() }, audit());
        const before = await audits();
        expect(
          await store.confirmDraft(
            { draftId: FEISHU_IDS.draft1, revision: 2, repoId: IDS.repo, by: IDS.founderB },
            audit(),
          ),
        ).toMatchObject({ status: 'changed', draft: { revision: 1, status: 'open' } });
        tick();
        const ok = await store.confirmDraft(
          { draftId: FEISHU_IDS.draft1, revision: 1, repoId: IDS.repo, by: IDS.founderB },
          audit({ action: 'draft.confirm' }),
        );
        expect(ok).toMatchObject({
          status: 'confirmed',
          draft: {
            status: 'confirmed',
            confirmedBy: IDS.founderB,
            confirmedAt: clock.now.toISOString(),
            repoId: IDS.repo,
          },
        });
        expect(ok.status === 'confirmed' && ok.draft.taskId).toBeFalsy();
        expect(await audits()).toBe(before + 1);
        expect(
          await store.confirmDraft(
            { draftId: FEISHU_IDS.draft1, revision: 1, repoId: IDS.repo, by: IDS.founderA },
            audit(),
          ),
        ).toMatchObject({ status: 'already', draft: { confirmedBy: IDS.founderB } });
        expect(
          await store.reviseDraft(
            { draftId: FEISHU_IDS.draft1, note: 'x', key: { type: 'request', requestId: 'late' } },
            audit(),
          ),
        ).toMatchObject({ status: 'confirmed' });
        expect(await audits()).toBe(before + 1);
        expect(
          await store.confirmDraft(
            { draftId: 'nope', revision: 1, repoId: IDS.repo, by: IDS.founderA },
            audit(),
          ),
        ).toEqual({ status: 'not_found' });
      });

      it('确认时操作记录写不进：还是没确认', async () => {
        await store.createDraft({ message: msg('om_1'), draft: newDraft() }, audit());
        await expect(
          store.confirmDraft(
            { draftId: FEISHU_IDS.draft1, revision: 1, repoId: IDS.repo, by: IDS.founderA },
            badAudit(),
          ),
        ).rejects.toThrow();
        expect((await store.getDraft(FEISHU_IDS.draft1))?.status).toBe('open');
      });

      it('草稿的确认卡：按卡片登记取最新登记的那张（kind=draft、来历是这张草稿）', async () => {
        await store.createDraft({ message: msg('om_1'), draft: newDraft() }, audit());
        expect((await store.getDraft(FEISHU_IDS.draft1))?.cardMessageId).toBeUndefined();
        const card = (messageId: string, at: number, draftId: string = FEISHU_IDS.draft1) =>
          store.putCard({
            messageId,
            chatId: 'oc_team',
            kind: 'draft',
            ref: { draftId },
            sentAt: new Date(T0.getTime() + at).toISOString(),
          });
        await card('om_card_1', 1000);
        await card('om_card_2', 2000);
        await card('om_card_other', 3000, FEISHU_IDS.draft2);
        await store.putCard({
          messageId: 'om_answer',
          chatId: 'oc_team',
          kind: 'answer',
          ref: { draftId: FEISHU_IDS.draft1 },
          sentAt: new Date(T0.getTime() + 4000).toISOString(),
        });
        expect((await store.getDraft(FEISHU_IDS.draft1))?.cardMessageId).toBe('om_card_2');
      });

      it('待开单：确认了、还没任务的，先确认的在前；开成了记上任务就不在里面了；没成记下原因和次数', async () => {
        await store.createDraft({ message: msg('om_1'), draft: newDraft() }, audit());
        await store.createDraft(
          { message: msg('om_2'), draft: newDraft({ id: FEISHU_IDS.draft2 }) },
          audit(),
        );
        expect(await store.listDraftsToOpen(10)).toEqual([]);
        tick();
        await store.confirmDraft(
          { draftId: FEISHU_IDS.draft2, revision: 1, repoId: IDS.repo, by: IDS.founderA },
          audit(),
        );
        tick();
        await store.confirmDraft(
          { draftId: FEISHU_IDS.draft1, revision: 1, repoId: IDS.repo, by: IDS.founderA },
          audit(),
        );
        expect((await store.listDraftsToOpen(10)).map((d) => d.id)).toEqual([
          FEISHU_IDS.draft2,
          FEISHU_IDS.draft1,
        ]);
        expect((await store.listDraftsToOpen(1)).map((d) => d.id)).toEqual([FEISHU_IDS.draft2]);

        tick();
        await store.recordDraftOpenFailure({ draftId: FEISHU_IDS.draft2, error: '开单还没接上' });
        await store.recordDraftOpenFailure({ draftId: FEISHU_IDS.draft2, error: '还是没接上' });
        expect((await store.getDraft(FEISHU_IDS.draft2))?.opening).toEqual({
          attempts: 2,
          error: '还是没接上',
          triedAt: clock.now.toISOString(),
        });
        expect(await store.recordDraftOpened({ draftId: FEISHU_IDS.draft2, taskId: OTHER_UUID })).toBe(
          'task_not_found',
        );
        expect(await store.recordDraftOpened({ draftId: FEISHU_IDS.draft2, taskId: IDS.task13 })).toBe('ok');
        expect(await store.getDraft(FEISHU_IDS.draft2)).toMatchObject({
          taskId: IDS.task13,
          opening: { attempts: 2 },
        });
        expect((await store.getDraft(FEISHU_IDS.draft2))?.opening.error).toBeUndefined();
        expect(await store.recordDraftOpened({ draftId: FEISHU_IDS.draft2, taskId: IDS.task12 })).toBe(
          'not_pending',
        );
        expect((await store.listDraftsToOpen(10)).map((d) => d.id)).toEqual([FEISHU_IDS.draft1]);
        // 没确认的草稿、没有的草稿：谈不上开单。
        await store.createDraft(
          { message: msg('om_3'), draft: newDraft({ id: '20000000-0000-4000-8000-000000000003' }) },
          audit(),
        );
        expect(
          await store.recordDraftOpened({
            draftId: '20000000-0000-4000-8000-000000000003',
            taskId: IDS.task12,
          }),
        ).toBe('not_pending');
        expect(await store.recordDraftOpened({ draftId: OTHER_UUID, taskId: IDS.task12 })).toBe(
          'not_pending',
        );
      });
    });

    describe('收到的话', () => {
      it('回了一段话的也记下；再记同一条交回第一次的，不改', async () => {
        expect(await store.getFeishuMessage('om_q')).toBeNull();
        const first = await store.recordFeishuMessage({
          message: msg('om_q', { replyToMessageId: 'om_card' }),
          result: { kind: 'answer', text: '已记下你的回答', taskId: IDS.task12 },
        });
        expect(first).toEqual({
          sourceMessageId: 'om_q',
          userId: IDS.founderA,
          textHash: 'hash-om_q',
          replyToMessageId: 'om_card',
          result: { kind: 'answer', text: '已记下你的回答', taskId: IDS.task12 },
          at: T0.toISOString(),
        });
        tick();
        const again = await store.recordFeishuMessage({
          message: msg('om_q'),
          result: { kind: 'answer', text: '别的' },
        });
        expect(again).toEqual(first);
        expect(await store.getFeishuMessage('om_q')).toEqual(first);
      });

      it('回的话里截断过的 emoji 照样写得进、读得回（半个代理对进 jsonb 会被库拒收）', async () => {
        const text = ANSWER_TEXTS.askTaken('😀'.repeat(40), '创始人乙');
        const rec = await store.recordFeishuMessage({
          message: msg('om_emoji'),
          result: { kind: 'answer', text },
        });
        expect(rec.result).toEqual({ kind: 'answer', text });
        expect((await store.getFeishuMessage('om_emoji'))?.result).toEqual({ kind: 'answer', text });
      });
    });

    describe('查任务、关注', () => {
      it('按 issue 号找：几个仓都有就都给，按仓名排；没有就是空', async () => {
        expect((await store.findTasksByIssue(12)).map((t) => t.id)).toEqual([
          FEISHU_IDS.task2of12,
          IDS.task12,
        ]);
        expect(await store.findTasksByIssue(999)).toEqual([]);
      });

      it('关注、取消关注：和原来一样是 unchanged，不写操作记录；需求不在是 task_not_found', async () => {
        const before = await audits();
        const follow = (f: boolean, taskId: string = IDS.task12) =>
          store.setFollow(
            { taskId, userId: IDS.founderA, follow: f },
            audit({ action: f ? 'task.follow' : 'task.unfollow' }),
          );
        expect(await follow(false)).toBe('unchanged');
        expect(await follow(true)).toBe('changed');
        expect(await follow(true)).toBe('unchanged');
        expect(await follow(false)).toBe('changed');
        expect(await follow(false)).toBe('unchanged');
        expect(await audits()).toBe(before + 2);
        expect(await follow(true, OTHER_UUID)).toBe('task_not_found');
        expect(await follow(true, 'nope')).toBe('task_not_found');
        await expect(
          store.setFollow({ taskId: IDS.task12, userId: IDS.founderA, follow: true }, badAudit()),
        ).rejects.toThrow();
        expect(await follow(true)).toBe('changed');
      });
    });

    describe('卡片登记', () => {
      it('再登记同一条：种类和来历覆盖，发出时刻和会话保留第一次的；最新的盘面卡', async () => {
        await store.putCard({
          messageId: 'om_1',
          chatId: 'oc_team',
          kind: 'draft',
          ref: {},
          sentAt: T0.toISOString(),
        });
        tick();
        await store.putCard({
          messageId: 'om_1',
          chatId: 'oc_other',
          kind: 'draft',
          ref: { draftId: FEISHU_IDS.draft1, taskId: IDS.task12 },
          sentAt: clock.now.toISOString(),
        });
        expect(await store.getCard('om_1')).toEqual({
          messageId: 'om_1',
          chatId: 'oc_team',
          kind: 'draft',
          ref: { draftId: FEISHU_IDS.draft1, taskId: IDS.task12 },
          sentAt: T0.toISOString(),
        });
        expect(await store.getCard('om_none')).toBeNull();

        expect(await store.latestBoardCard()).toBeNull();
        for (const [id, offset] of [
          ['om_board_1', 1000],
          ['om_board_2', 5000],
          ['om_list', 9000],
        ] as const) {
          await store.putCard({
            messageId: id,
            chatId: 'oc_team',
            kind: id === 'om_list' ? 'list' : 'board',
            ref: {},
            sentAt: new Date(T0.getTime() + offset).toISOString(),
          });
        }
        expect(await store.latestBoardCard()).toEqual({
          messageId: 'om_board_2',
          sentAt: new Date(T0.getTime() + 5000).toISOString(),
        });
      });
    });

    describe('盘面要的查询', () => {
      it('进入当前状态的时刻：按编号给最近一次变化；没记录的不在结果里', async () => {
        const at = new Date(T0.getTime() - 3 * DAY);
        await s.backdateState(IDS.task12, at);
        const since = await store.stateSince([IDS.task12, OTHER_UUID, 'nope']);
        expect([...since.keys()]).toEqual([IDS.task12]);
        expect(since.get(IDS.task12)).toBe(at.toISOString());
      });

      it('今天合并了几个：数进入「已合并」的子任务', async () => {
        expect(await store.countMergedSubtasksSince('2000-01-01T00:00:00.000Z')).toBe(0);
        // 另起一份数据（库版是同一个库清空重来，所以先查完上面那句）。
        const data = feishuData();
        data.subtasks = (data.subtasks ?? []).map((st) =>
          st.id === IDS.sub12a ? { ...st, state: 'merged' } : st,
        );
        const merged = (await make(data, clock)).store;
        expect(await merged.countMergedSubtasksSince('2000-01-01T00:00:00.000Z')).toBe(1);
        expect(await merged.countMergedSubtasksSince('2999-01-01T00:00:00.000Z')).toBe(0);
      });
    });

    describe('推送的源头与送达状态', () => {
      const since = () => new Date(clock.now.getTime() - 15 * DAY).toISOString();

      it('源头：没答的和最近答的追问、没处理的和最近处理的通知；带需求信息和回答人、处理人的名字', async () => {
        const sources = await store.listOutboxSources(since());
        expect(sources.asks.map((a) => a.ask.id)).toEqual([FEISHU_IDS.askAnswered, FEISHU_IDS.askOpen]);
        expect(sources.asks[0]).toMatchObject({
          ask: { answer: '阿里云', answeredBy: IDS.founderB },
          task: {
            id: IDS.task12,
            title: '登录页加验证码',
            issueNumber: 12,
            state: 'running',
            repo: 'example/canary',
          },
          answeredByName: '创始人乙',
        });
        expect(sources.asks[1]?.answeredByName).toBeUndefined();
        expect(sources.notifications.map((n) => n.notification.id)).toEqual([
          IDS.notification1,
          FEISHU_IDS.decision,
        ]);
        expect(sources.notifications[0]).toMatchObject({
          notification: { level: 'alert', title: '任务 12 卡住了', link: `/tasks/${IDS.task12}` },
          task: { id: IDS.task12, repo: 'example/canary' },
        });
        expect(sources.notifications[0]?.notification).not.toHaveProperty('deliveries');
        // 往前看得够远，很久以前的也在。
        const all = await store.listOutboxSources(new Date(T0.getTime() - 100 * DAY).toISOString());
        expect(all.asks.map((a) => a.ask.id)).toContain(FEISHU_IDS.askOld);
        expect(all.notifications.find((n) => n.notification.id === FEISHU_IDS.oldAlert)).toMatchObject({
          resolvedByName: '创始人甲',
        });
      });

      it('送达状态：新的建成第 1 版（create=false 的不建）；指纹不变不动；变了版本加 1', async () => {
        const first = await store.syncOutbox([
          { id: 'ask:a', fingerprint: 'f1', create: true },
          { id: 'ask:b', fingerprint: 'f1', create: false },
        ]);
        expect([...first.keys()]).toEqual(['ask:a']);
        expect(first.get('ask:a')).toEqual({ id: 'ask:a', revision: 1, createdAt: T0.toISOString() });
        tick();
        expect(
          (await store.syncOutbox([{ id: 'ask:a', fingerprint: 'f1', create: true }])).get('ask:a')?.revision,
        ).toBe(1);
        expect(
          (await store.syncOutbox([{ id: 'ask:a', fingerprint: 'f2', create: false }])).get('ask:a'),
        ).toEqual({
          id: 'ask:a',
          revision: 2,
          createdAt: T0.toISOString(),
        });
        expect(await store.syncOutbox([])).toEqual(new Map());
      });

      it('回执没记上时，「上次送到的卡」按卡片登记里 ref.outboxId 补（不知道是哪一版）', async () => {
        await store.syncOutbox([{ id: 'ask:a', fingerprint: 'f1', create: true }]);
        await store.putCard({
          messageId: 'om_push',
          chatId: 'oc_team',
          kind: 'ask',
          ref: { outboxId: 'ask:a', askId: 'a' },
          sentAt: T0.toISOString(),
        });
        expect(
          (await store.syncOutbox([{ id: 'ask:a', fingerprint: 'f1', create: true }])).get('ask:a')
            ?.delivered,
        ).toEqual({
          messageId: 'om_push',
          chatId: 'oc_team',
          sentAt: T0.toISOString(),
        });
      });

      it('回执：当前版本的记下结果和等待期；旧版本的「发了」只记下送到的卡；认不出的跳过并写明原因', async () => {
        await store.syncOutbox([
          { id: 'ask:a', fingerprint: 'f1', create: true },
          { id: 'ask:b', fingerprint: 'f1', create: true },
          { id: 'ask:c', fingerprint: 'f1', create: true },
          { id: 'ask:d', fingerprint: 'f1', create: true },
        ]);
        const at = new Date(T0.getTime() + 5000).toISOString();
        const until = new Date(T0.getTime() + 8 * 60 * MIN).toISOString();
        const report = await store.ackOutbox(
          [
            {
              itemId: 'ask:a',
              revision: 1,
              result: { status: 'sent', messageId: 'om_a', chatId: 'oc_team', sentAt: at },
            },
            { itemId: 'ask:b', revision: 1, result: { status: 'deferred', until, reason: 'quiet_hours' } },
            {
              itemId: 'ask:c',
              revision: 1,
              result: { status: 'failed', error: '飞书超时', retryAfter: until },
            },
            { itemId: 'ask:d', revision: 1, result: { status: 'dropped', reason: 'over_budget' } },
            { itemId: 'ask:zzz', revision: 1, result: { status: 'dropped', reason: 'already_done' } },
            { itemId: 'ask:a', revision: 7, result: { status: 'updated', messageId: 'om_a' } },
          ],
          at,
        );
        expect(report).toEqual({
          applied: 4,
          skipped: [
            { itemId: 'ask:zzz', revision: 1, why: 'unknown_item' },
            { itemId: 'ask:a', revision: 7, why: 'future_revision' },
          ],
        });
        const states = await store.syncOutbox(
          ['a', 'b', 'c', 'd'].map((x) => ({ id: `ask:${x}`, fingerprint: 'f1', create: true })),
        );
        expect(states.get('ask:a')).toMatchObject({
          ack: { revision: 1, status: 'sent' },
          delivered: { messageId: 'om_a', chatId: 'oc_team', sentAt: at, revision: 1 },
        });
        expect(states.get('ask:b')).toMatchObject({
          ack: { revision: 1, status: 'deferred', reason: 'quiet_hours', holdUntil: until },
        });
        expect(states.get('ask:c')).toMatchObject({
          ack: { revision: 1, status: 'failed', reason: '飞书超时', holdUntil: until },
        });
        expect(states.get('ask:d')).toMatchObject({
          ack: { revision: 1, status: 'dropped', reason: 'over_budget' },
        });
        expect(states.get('ask:d')?.delivered).toBeUndefined();

        // 内容变了（第 2 版）之后才到的旧回执：「改了」记下送到的卡，不算了结第 2 版；别的旧回执跳过。
        await store.syncOutbox([
          { id: 'ask:a', fingerprint: 'f2', create: true },
          { id: 'ask:b', fingerprint: 'f2', create: true },
        ]);
        const late = await store.ackOutbox(
          [
            { itemId: 'ask:a', revision: 1, result: { status: 'updated', messageId: 'om_a' } },
            { itemId: 'ask:b', revision: 1, result: { status: 'dropped', reason: 'already_done' } },
          ],
          at,
        );
        expect(late).toEqual({
          applied: 1,
          skipped: [{ itemId: 'ask:b', revision: 1, why: 'stale_revision' }],
        });
        const after = await store.syncOutbox([
          { id: 'ask:a', fingerprint: 'f2', create: true },
          { id: 'ask:b', fingerprint: 'f2', create: true },
        ]);
        expect(after.get('ask:a')).toMatchObject({ revision: 2, ack: { revision: 1, status: 'sent' } });
        expect(after.get('ask:a')?.delivered).toMatchObject({ messageId: 'om_a', revision: 1 });
        expect(after.get('ask:b')).toMatchObject({ revision: 2, ack: { revision: 1, status: 'deferred' } });

        // 第 2 版改了卡：会话和发出时刻沿用记过的。
        await store.ackOutbox(
          [{ itemId: 'ask:a', revision: 2, result: { status: 'updated', messageId: 'om_a' } }],
          at,
        );
        expect(
          (await store.syncOutbox([{ id: 'ask:a', fingerprint: 'f2', create: true }])).get('ask:a'),
        ).toMatchObject({
          ack: { revision: 2, status: 'updated' },
          delivered: { messageId: 'om_a', chatId: 'oc_team', sentAt: at, revision: 2 },
        });
      });

      it('「改了」的卡回执没记过、卡片登记里也没有：只记结果，不编一张送到的卡', async () => {
        await store.syncOutbox([{ id: 'ask:a', fingerprint: 'f1', create: true }]);
        await store.ackOutbox(
          [{ itemId: 'ask:a', revision: 1, result: { status: 'updated', messageId: 'om_ghost' } }],
          T0.toISOString(),
        );
        const state = (await store.syncOutbox([{ id: 'ask:a', fingerprint: 'f1', create: true }])).get(
          'ask:a',
        );
        expect(state?.ack).toMatchObject({ status: 'updated' });
        expect(state?.delivered).toBeUndefined();
      });

      const deliveries = async () =>
        (await store.listNotifications({ status: 'all', limit: 50 })).items.find(
          (n) => n.id === FEISHU_IDS.decision,
        )?.deliveries;

      it('同一条回执重复到达（网关重发、两批叠上）：记过的不重复记，送达尝试数不加；同一版又没发成（等待期不同）算新的一次', async () => {
        const id = `notification:${FEISHU_IDS.decision}`;
        await store.syncOutbox([{ id, fingerprint: 'f1', create: true }]);
        const fail1 = {
          itemId: id,
          revision: 1,
          result: { status: 'failed', error: '飞书超时', retryAfter: T0.toISOString() },
        } as const;
        expect(await store.ackOutbox([fail1, fail1], T0.toISOString())).toEqual({ applied: 2, skipped: [] });
        tick();
        await store.ackOutbox([fail1], clock.now.toISOString());
        expect(await deliveries()).toMatchObject([{ attempts: 1, lastAttemptAt: T0.toISOString() }]);
        const fail2 = {
          ...fail1,
          result: { ...fail1.result, retryAfter: new Date(T0.getTime() + MIN).toISOString() },
        };
        await store.ackOutbox([fail2], clock.now.toISOString());
        expect(await deliveries()).toMatchObject([{ attempts: 2 }]);
        const sent = {
          itemId: id,
          revision: 1,
          result: { status: 'sent', messageId: 'om_n', chatId: 'oc_team', sentAt: T0.toISOString() },
        } as const;
        await store.ackOutbox([sent], clock.now.toISOString());
        await store.ackOutbox([sent, sent], clock.now.toISOString());
        expect(await deliveries()).toMatchObject([{ attempts: 3, messageId: 'om_n' }]);
        const state = (await store.syncOutbox([{ id, fingerprint: 'f1', create: true }])).get(id);
        expect(state).toMatchObject({
          ack: { revision: 1, status: 'sent' },
          delivered: { messageId: 'om_n' },
        });
      });

      it('推迟（免打扰）、不发了：不算送达尝试，通知的送达记录不动；原因记在推送本身', async () => {
        const id = `notification:${FEISHU_IDS.decision}`;
        await store.syncOutbox([{ id, fingerprint: 'f1', create: true }]);
        const until = new Date(T0.getTime() + 8 * 60 * MIN).toISOString();
        await store.ackOutbox(
          [{ itemId: id, revision: 1, result: { status: 'deferred', until, reason: 'quiet_hours' } }],
          T0.toISOString(),
        );
        expect(await deliveries()).toEqual([]);
        await store.ackOutbox(
          [{ itemId: id, revision: 1, result: { status: 'dropped', reason: 'over_budget' } }],
          T0.toISOString(),
        );
        expect(await deliveries()).toEqual([]);
        expect(
          (await store.syncOutbox([{ id, fingerprint: 'f1', create: true }])).get(id)?.ack,
        ).toMatchObject({
          status: 'dropped',
          reason: 'over_budget',
        });
      });

      it('通知类的回执同时记进这条通知的送达记录（驾驶舱「通知」页看得到）', async () => {
        const id = `notification:${FEISHU_IDS.decision}`;
        await store.syncOutbox([{ id, fingerprint: 'f1', create: true }]);
        await store.ackOutbox(
          [
            {
              itemId: id,
              revision: 1,
              result: { status: 'failed', error: '飞书超时', retryAfter: T0.toISOString() },
            },
          ],
          T0.toISOString(),
        );
        expect(await deliveries()).toEqual([
          { channel: 'feishu', attempts: 1, error: '飞书超时', lastAttemptAt: T0.toISOString() },
        ]);
        tick();
        await store.ackOutbox(
          [
            {
              itemId: id,
              revision: 1,
              result: {
                status: 'sent',
                messageId: 'om_n',
                chatId: 'oc_team',
                sentAt: clock.now.toISOString(),
              },
            },
          ],
          clock.now.toISOString(),
        );
        expect(await deliveries()).toEqual([
          { channel: 'feishu', messageId: 'om_n', attempts: 2, lastAttemptAt: clock.now.toISOString() },
        ]);
        // 追问类的不碰通知。
        await store.syncOutbox([{ id: 'ask:x', fingerprint: 'f1', create: true }]);
        await store.ackOutbox(
          [{ itemId: 'ask:x', revision: 1, result: { status: 'dropped', reason: 'over_budget' } }],
          T0.toISOString(),
        );
        expect(await deliveries()).toHaveLength(1);
      });
    });
  });
}
