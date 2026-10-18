// 「要你拍」带选项：接口给出选项（带 action）和执行结果。自己写的、没有具体动作的交给指挥官，卡上写「已转给指挥官」，
// 进度单 #1055 收到一条待处理的创始人引导，挂了任务的任务单也收到一句。执行失败不转已处理。没接上 GitHub 的照实写。
import { progressKindOf, progressOwnerOf } from '@fleet-dao/conventions';
import {
  AnswerNotificationResponse,
  AuditResponse,
  HANDED_TO_COMMANDER,
  NO_OPTIONS_TEXT,
  NotificationsResponse,
  WORKTREE_DELETE_QUEUED,
} from '@fleet-dao/shared';
import { describe, expect, it, vi } from 'vitest';
import type { DecisionCommenter } from '../src/decision-handoff.ts';
import { HANDOFF_NOT_WIRED } from '../src/decision-handoff.ts';
import { DEV_USER_ID, errorCode, harness, IDS, write } from './harness.ts';

const SELF_REPO_ID = '11111111-0000-4000-8000-0000000f1ee7';

type Posted = Parameters<DecisionCommenter['comment']>[0];

function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

function recorder(fail?: string): { commenter: DecisionCommenter; posted: Posted[] } {
  const posted: Posted[] = [];
  return {
    posted,
    commenter: {
      async comment(input) {
        if (fail) throw new Error(fail);
        posted.push(input);
        return {
          url: `https://github.com/${input.repo.owner}/${input.repo.name}/issues/${input.issueNumber}#c${posted.length}`,
        };
      },
    },
  };
}

function withSelfRepo(h: ReturnType<typeof harness>) {
  h.store.data.repos.push({
    id: SELF_REPO_ID,
    owner: 'thoerwink8',
    name: 'fleet-dao',
    defaultBranch: 'main',
    testCommand: 'pnpm check',
  });
}

async function answer(
  h: ReturnType<typeof harness>,
  s: { cookie: string; csrf: string },
  id: string,
  body: unknown,
) {
  return h.cockpit.request(`/api/notifications/${id}/answer`, write('POST', s, body));
}

describe('「要你拍」带选项（#1915）', () => {
  it('HTTP在途重复/不同答案不重复执行，完成后同请求重放原回执，新答案独立交接', async () => {
    const entered = deferred();
    const release = deferred();
    const { posted, commenter } = recorder();
    const original = commenter.comment;
    let calls = 0;
    commenter.comment = async (input) => {
      if (++calls === 1) {
        entered.resolve();
        await release.promise;
      }
      return original(input);
    };
    const h = harness({ decisionCommenter: commenter });
    withSelfRepo(h);
    const s = await h.login();
    const body = {
      optionId: 'review',
      requestId: 'a1111111-0000-4000-8000-000000000001',
      expectedAnswerId: null,
    };
    const a = answer(h, s, IDS.notification2, body);
    await entered.promise;
    expect(await errorCode(await answer(h, s, IDS.notification2, body))).toBe('decision_in_flight');
    expect(await errorCode(await answer(h, s, IDS.notification2, { optionId: 'approve' }))).toBe(
      'decision_in_flight',
    );
    release.resolve();
    const first = AnswerNotificationResponse.parse(await (await a).json());
    expect(first.answer.attempt?.state).toBe('succeeded');
    const before = calls;
    const replay = AnswerNotificationResponse.parse(
      await (await answer(h, s, IDS.notification2, body)).json(),
    );
    expect(replay.answer).toEqual(first.answer);
    expect(calls).toBe(before);
    const b = AnswerNotificationResponse.parse(
      await (
        await answer(h, s, IDS.notification2, {
          text: '改成周一',
          requestId: 'a1111111-0000-4000-8000-000000000002',
          expectedAnswerId: first.answer.id,
        })
      ).json(),
    );
    expect(b.answer.id).not.toBe(first.answer.id);
    expect(posted[0]?.key).toBe(`decision-answer:${IDS.notification2}:${first.answer.id}`);
    expect(posted[2]?.key).toBe(`decision-answer:${IDS.notification2}:${b.answer.id}`);
    expect(posted[2]?.body).toContain('改成周一');
    const count = calls;
    expect(await errorCode(await answer(h, s, IDS.notification2, body))).toBe('decision_answer_conflict');
    expect(
      await errorCode(
        await answer(h, s, IDS.notification2, { optionId: 'review', requestId: body.requestId }),
      ),
    ).toBe('invalid_request');
    expect(calls).toBe(count);
  });

  it('答案保存失败不执行；动作后结算读写失败保留持久在途，重试不能重放', async () => {
    const { commenter, posted } = recorder();
    const h = harness({ decisionCommenter: commenter });
    withSelfRepo(h);
    const s = await h.login();
    const save = vi.spyOn(h.store, 'answerNotification').mockRejectedValueOnce(new Error('数据库写失败'));
    expect((await answer(h, s, IDS.notification2, { optionId: 'review' })).status).toBe(500);
    expect(posted).toHaveLength(0);
    save.mockRestore();
    vi.spyOn(h.store, 'settleDecision').mockRejectedValueOnce(new Error('提交结果未知'));
    const body = {
      optionId: 'review',
      requestId: 'a1111111-0000-4000-8000-000000000003',
      expectedAnswerId: null,
    };
    expect((await answer(h, s, IDS.notification2, body)).status).toBe(500);
    expect(posted).toHaveLength(2);
    expect(await errorCode(await answer(h, s, IDS.notification2, body))).toBe('decision_in_flight');
    expect(posted).toHaveLength(2);
    expect(h.store.data.notifications.find((n) => n.id === IDS.notification2)?.answer?.attempt?.state).toBe(
      'executing',
    );
  });

  it('确定交接失败重试沿同一答案key；不会把新答案吞进旧幂等账', async () => {
    const keys: string[] = [];
    let fail = true;
    const h = harness({
      decisionCommenter: {
        async comment(x) {
          keys.push(x.key);
          if (fail) throw new Error('没接上');
          return { url: 'https://example.test/comment' };
        },
      },
    });
    withSelfRepo(h);
    const s = await h.login();
    const a = AnswerNotificationResponse.parse(
      await (await answer(h, s, IDS.notification2, { optionId: 'review' })).json(),
    );
    fail = false;
    const retry = AnswerNotificationResponse.parse(
      await (await answer(h, s, IDS.notification2, { optionId: 'review' })).json(),
    );
    expect(retry.answer.id).toBe(a.answer.id);
    expect(keys[0]).toBe(keys[2]);
    expect(retry.answer.attempt?.id).not.toBe(a.answer.attempt?.id);
    expect(retry.answer.execution?.ok).toBe(true);
  });

  it('A保存后B先保存，A接活失败不会产生外部动作，B仍可独立执行', async () => {
    const { commenter, posted } = recorder();
    const h = harness({ decisionCommenter: commenter });
    withSelfRepo(h);
    const s = await h.login();
    const claim = h.store.claimDecision.bind(h.store);
    vi.spyOn(h.store, 'claimDecision').mockImplementationOnce(async (input) => {
      await h.store.answerNotification(
        { id: input.id, by: { kind: 'user', id: DEV_USER_ID }, text: 'B最新答案' },
        {
          actor: { kind: 'user', id: DEV_USER_ID },
          action: 'notification.answer',
          target: `notification:${input.id}`,
          via: 'cockpit',
          ok: true,
        },
      );
      return claim(input);
    });
    expect(await errorCode(await answer(h, s, IDS.notification2, { optionId: 'review' }))).toBe(
      'decision_answer_stale',
    );
    expect(posted).toHaveLength(0);
    const b = AnswerNotificationResponse.parse(
      await (await answer(h, s, IDS.notification2, { text: 'B最新答案' })).json(),
    );
    expect(b.answer.text).toBe('B最新答案');
    expect(b.answer.execution?.ok).toBe(true);
    expect(posted[0]?.body).toContain('B最新答案');
  });

  it('写口提交后抛错保留unknown，重复请求不能再写或伪装已处理', async () => {
    const h = harness();
    const n = h.store.data.notifications.find((n) => n.id === IDS.notification2);
    if (!n?.options?.[0]) throw new Error('缺测试选项');
    n.options[0].action = { kind: 'pause-pool', poolId: 'test-pool' };
    const write = h.store.putSetting.bind(h.store);
    const spy = vi.spyOn(h.store, 'putSetting').mockImplementation(async (...args) => {
      await write(...args);
      throw new Error('提交回执断连');
    });
    const s = await h.login();
    const body = {
      optionId: n.options[0].id,
      requestId: 'a1111111-0000-4000-8000-000000000004',
      expectedAnswerId: null,
    };
    const first = AnswerNotificationResponse.parse(
      await (await answer(h, s, IDS.notification2, body)).json(),
    );
    expect(first.answer.execution).toMatchObject({ ok: false, unknown: true });
    expect(first.answer.attempt?.state).toBe('unknown');
    expect(n.resolvedAt).toBeUndefined();
    expect(await errorCode(await answer(h, s, IDS.notification2, body))).toBe('decision_in_flight');
    expect(spy).toHaveBeenCalledTimes(1);
  });

  it('通知撤销重开后旧claim回执失效，不把已开始的副作用谎称取消', async () => {
    const entered = deferred();
    const release = deferred();
    const h = harness({
      decisionCapabilities: {
        async recheckGitHubApp() {
          entered.resolve();
          await release.promise;
        },
        async recheckFeishuPush() {},
      },
    });
    const n = h.store.data.notifications.find((n) => n.id === IDS.notification2);
    if (!n?.options?.[0]) throw new Error('缺测试选项');
    n.options[0].action = { kind: 'recheck', what: 'github-app', repo: 'example/canary' };
    const s = await h.login();
    const a = answer(h, s, IDS.notification2, { optionId: n.options[0].id });
    await entered.promise;
    const oldId = n.answer?.id;
    // 与 upsertAlert 重开语义一致：清空旧答案；新回答须重新存代次。
    delete n.answer;
    const b = await h.store.answerNotification(
      { id: n.id, by: { kind: 'user', id: DEV_USER_ID }, text: '重开后新答案' },
      {
        actor: { kind: 'user', id: DEV_USER_ID },
        action: 'notification.answer',
        target: `notification:${n.id}`,
        via: 'cockpit',
        ok: true,
      },
    );
    expect(b.kind === 'ok' && b.notification.answer?.id).not.toBe(oldId);
    release.resolve();
    expect(await errorCode(await a)).toBe('decision_answer_stale');
    const reopened = h.store.data.notifications.find((row) => row.id === n.id);
    expect(reopened?.answer?.text).toBe('重开后新答案');
    expect(reopened?.answer?.execution).toBeUndefined();
    expect(n.resolvedAt).toBeUndefined();
  });
  it('列表里带选项：每项一句话，恰好一项推荐并写理由', async () => {
    const h = harness();
    const s = await h.login();
    const list = NotificationsResponse.parse(
      await (await h.cockpit.request('/api/notifications', { headers: { cookie: s.cookie } })).json(),
    );
    const decision = list.items.find((n) => n.id === IDS.notification2);
    expect(decision?.options?.length).toBeGreaterThanOrEqual(2);
    expect(decision?.options?.every((o) => o.detail.length > 0)).toBe(true);
    expect(decision?.options?.filter((o) => o.recommended)).toHaveLength(1);
    // 老选项没写 action：读出来按只留言，列表接口把动作带上
    expect(decision?.options?.every((o) => o.action?.kind === 'note-only')).toBe(true);
  });

  it('点选项记下答案：转已处理、记操作记录，进度单 #1055 收到一条「创始人已选」，任务单也收到一句', async () => {
    const { commenter, posted } = recorder();
    const h = harness({ decisionCommenter: commenter });
    withSelfRepo(h);
    const s = await h.login();
    const res = await answer(h, s, IDS.notification2, { optionId: 'approve' });
    expect(res.status).toBe(200);
    const body = AnswerNotificationResponse.parse(await res.json());
    expect(body.answer).toMatchObject({
      optionId: 'approve',
      text: '批，合进去',
      at: h.clock.now.toISOString(),
      by: DEV_USER_ID,
      execution: { ok: true, text: HANDED_TO_COMMANDER, at: h.clock.now.toISOString() },
    });
    expect(body.handoff?.progress).toEqual({
      ok: true,
      url: 'https://github.com/thoerwink8/fleet-dao/issues/1055#c1',
    });
    expect(body.handoff?.task?.ok).toBe(true);

    // 选了以后进度单收到一条：在 fleet-dao 的 #1055 下，是待处理的创始人引导（无主），原话写明选了什么、哪条通知
    const progress = posted[0];
    expect(progress?.repo).toEqual({ owner: 'thoerwink8', name: 'fleet-dao' });
    expect(progress?.issueNumber).toBe(1055);
    expect(progress?.body).toContain(`创始人已选：批，合进去（通知 ${IDS.notification2}）`);
    expect(progressKindOf(progress?.body ?? '')).toBe('pending');
    expect(progressOwnerOf(progress?.body ?? '')).toBe('无主');
    // 通知挂了任务 12：那张单（example/canary#12）也收到一句
    expect(posted[1]).toMatchObject({ repo: { owner: 'example', name: 'canary' }, issueNumber: 12 });
    expect(posted[1]?.body).toContain('批，合进去');

    // 页面上看得到他选了什么；转已处理
    const all = NotificationsResponse.parse(
      await (
        await h.cockpit.request('/api/notifications?status=all', { headers: { cookie: s.cookie } })
      ).json(),
    );
    const n = all.items.find((x) => x.id === IDS.notification2);
    expect(n?.answer?.optionId).toBe('approve');
    expect(n?.resolvedAt).toBe(h.clock.now.toISOString());
    expect(n?.answer?.execution).toMatchObject({ ok: true, text: HANDED_TO_COMMANDER });
    const audit = AuditResponse.parse(
      await (
        await h.cockpit.request(`/api/audit?target=notification:${IDS.notification2}`, {
          headers: { cookie: s.cookie },
        })
      ).json(),
    );
    expect(audit.items.map((a) => a.action)).toEqual(['notification.answer']);

    // 再拍一次：已处理，答案不改
    expect(await errorCode(await answer(h, s, IDS.notification2, { text: '改主意了' }))).toBe(
      'notification_already_resolved',
    );
  });

  it('自定义输入记下答案：记原文、不带选项编号，进度单那条写「自己输入」', async () => {
    const { commenter, posted } = recorder();
    const h = harness({ decisionCommenter: commenter });
    withSelfRepo(h);
    const s = await h.login();
    const res = await answer(h, s, IDS.notification2, { text: '  先别合，等我周一看  ' });
    expect(res.status).toBe(200);
    const body = AnswerNotificationResponse.parse(await res.json());
    expect(body.answer).toMatchObject({
      text: '先别合，等我周一看',
      at: h.clock.now.toISOString(),
      by: DEV_USER_ID,
    });
    expect(body.answer.optionId).toBeUndefined();
    expect(posted[0]?.body).toContain(
      `创始人已选：自己输入：先别合，等我周一看（通知 ${IDS.notification2}）`,
    );
    // 这条有「先留着」的选项：自己写的交给指挥官，卡上写明，但不转已处理
    expect(body.answer.execution).toMatchObject({ ok: true, text: HANDED_TO_COMMANDER });
    const open = NotificationsResponse.parse(
      await (await h.cockpit.request('/api/notifications', { headers: { cookie: s.cookie } })).json(),
    );
    const n = open.items.find((x) => x.id === IDS.notification2);
    expect(n?.resolvedAt).toBeUndefined();
    expect(n?.answer?.execution?.text).toBe(HANDED_TO_COMMANDER);
  });

  it('没有选项的老通知照旧列出；能自己输入回答', async () => {
    const h = harness();
    const s = await h.login();
    h.store.data.notifications.push({
      id: 'n-old',
      level: 'decision',
      title: '要不要买域名',
      body: '花钱，等你们拍',
      createdAt: h.clock.now.toISOString(),
      deliveries: [],
    });
    const list = NotificationsResponse.parse(
      await (await h.cockpit.request('/api/notifications', { headers: { cookie: s.cookie } })).json(),
    );
    const old = list.items.find((n) => n.id === 'n-old');
    expect(old).toMatchObject({ level: 'decision', title: '要不要买域名', body: '花钱，等你们拍' });
    expect(old?.options).toBeUndefined();
    expect(NO_OPTIONS_TEXT).toBe('没有选项，请直接回复');
    // 没有选项就不能点选项，只能自己输入
    expect(await errorCode(await answer(h, s, 'n-old', { optionId: 'yes' }))).toBe('unknown_option');
    const res = await answer(h, s, 'n-old', { text: '买' });
    expect(res.status).toBe(200);
    // 没接上 GitHub：答案存下了，handoff 照实写没接上，不冒充记上了
    const body = AnswerNotificationResponse.parse(await res.json());
    expect(body.handoff?.progress).toEqual({ ok: false, why: HANDOFF_NOT_WIRED });
    // 交给指挥官没写成：不转已处理，卡上写失败原因
    expect(body.answer.execution).toMatchObject({ ok: false, text: HANDOFF_NOT_WIRED });
    const open = NotificationsResponse.parse(
      await (await h.cockpit.request('/api/notifications', { headers: { cookie: s.cookie } })).json(),
    );
    const still = open.items.find((n) => n.id === 'n-old');
    expect(still?.resolvedAt).toBeUndefined();
    expect(still?.answer?.execution).toMatchObject({ ok: false, text: HANDOFF_NOT_WIRED });
  });

  it('请求不对、不是要人拍的、没有这条：分开报', async () => {
    const h = harness();
    const s = await h.login();
    expect(await errorCode(await answer(h, s, IDS.notification2, {}))).toBe('invalid_request');
    expect(
      await errorCode(await answer(h, s, IDS.notification2, { optionId: 'approve', text: '也写了字' })),
    ).toBe('invalid_request');
    expect(await errorCode(await answer(h, s, IDS.notification1, { text: '好' }))).toBe(
      'notification_not_decision',
    );
    expect(await errorCode(await answer(h, s, 'nope', { text: '好' }))).toBe('notification_not_found');
  });

  it('留言没写成：答案照样存下，handoff 写为什么', async () => {
    const { commenter } = recorder('GitHub 限流了');
    const h = harness({ decisionCommenter: commenter });
    withSelfRepo(h);
    const s = await h.login();
    const body = AnswerNotificationResponse.parse(
      await (await answer(h, s, IDS.notification2, { optionId: 'review' })).json(),
    );
    expect(body.handoff?.progress).toEqual({ ok: false, why: 'GitHub 限流了' });
    expect(body.handoff?.task).toEqual({ ok: false, why: 'GitHub 限流了' });
    expect(h.store.data.notifications.find((n) => n.id === IDS.notification2)?.answer?.optionId).toBe(
      'review',
    );
    expect(h.store.data.notifications.find((n) => n.id === IDS.notification2)?.resolvedAt).toBeUndefined();
    expect(body.answer.execution).toMatchObject({ ok: false, text: 'GitHub 限流了' });
  });

  it('删工作树交给引擎：卡上写「已交给引擎」，不留言、不转已处理，选项的 action 带给界面', async () => {
    const h = harness();
    const s = await h.login();
    h.store.data.notifications.push({
      id: 'n-del',
      level: 'decision',
      title: '工作树删不删',
      body: '要你拍',
      createdAt: h.clock.now.toISOString(),
      deliveries: [],
      options: [
        {
          id: 'keep',
          label: '留着',
          detail: '这条转已处理',
          recommended: '删了就没了',
          action: { kind: 'keep' },
        },
        {
          id: 'remove',
          label: '删掉',
          detail: '系统删掉这棵工作树',
          action: { kind: 'delete-worktree', path: '/tmp/fleet-tree' },
        },
      ],
    });
    const res = await answer(h, s, 'n-del', { optionId: 'remove' });
    expect(res.status).toBe(200);
    const body = AnswerNotificationResponse.parse(await res.json());
    expect(body.answer.execution).toEqual({
      ok: true,
      queued: true,
      text: WORKTREE_DELETE_QUEUED,
      at: h.clock.now.toISOString(),
    });
    expect(body.handoff).toBeUndefined();
    const open = NotificationsResponse.parse(
      await (await h.cockpit.request('/api/notifications', { headers: { cookie: s.cookie } })).json(),
    );
    const card = open.items.find((n) => n.id === 'n-del');
    expect(card?.resolvedAt).toBeUndefined();
    expect(card?.answer?.execution?.queued).toBe(true);
    expect(card?.options?.find((o) => o.id === 'remove')?.action).toEqual({
      kind: 'delete-worktree',
      path: '/tmp/fleet-tree',
    });
  });
});
