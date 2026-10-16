// 「要你拍」带选项：接口给出选项（带 action）和执行结果。自己写的、没有具体动作的交给指挥官，卡上写「已转给指挥官」，
// 进度单 #1055 收到一条待处理的创始人引导，挂了任务的任务单也收到一句。执行失败不转已处理。没接上 GitHub 的照实写。
import { progressKindOf, progressOwnerOf } from '@fleet-dao/conventions';
import {
  AnswerNotificationResponse,
  AuditResponse,
  HANDED_TO_COMMANDER,
  NO_OPTIONS_TEXT,
  NotificationsResponse,
} from '@fleet-dao/shared';
import { describe, expect, it } from 'vitest';
import type { DecisionCommenter } from '../src/decision-handoff.ts';
import { HANDOFF_NOT_WIRED } from '../src/decision-handoff.ts';
import { DEV_USER_ID, errorCode, harness, IDS, write } from './harness.ts';

const SELF_REPO_ID = '11111111-0000-4000-8000-0000000f1ee7';

type Posted = Parameters<DecisionCommenter['comment']>[0];

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
    expect(body.answer).toEqual({
      optionId: 'approve',
      text: '批，合进去',
      at: h.clock.now.toISOString(),
      by: DEV_USER_ID,
    });
    expect(body.handoff.progress).toEqual({
      ok: true,
      url: 'https://github.com/thoerwink8/fleet-dao/issues/1055#c1',
    });
    expect(body.handoff.task?.ok).toBe(true);
    expect(body.execution).toMatchObject({ ok: true, text: HANDED_TO_COMMANDER });

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
    expect(n?.execution).toMatchObject({ ok: true, text: HANDED_TO_COMMANDER });
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
    expect(body.answer).toEqual({
      text: '先别合，等我周一看',
      at: h.clock.now.toISOString(),
      by: DEV_USER_ID,
    });
    expect(posted[0]?.body).toContain(
      `创始人已选：自己输入：先别合，等我周一看（通知 ${IDS.notification2}）`,
    );
    // 这条有「先留着」的选项：自己写的交给指挥官，卡上写明，但不转已处理
    expect(body.execution).toMatchObject({ ok: true, text: HANDED_TO_COMMANDER });
    const open = NotificationsResponse.parse(
      await (await h.cockpit.request('/api/notifications', { headers: { cookie: s.cookie } })).json(),
    );
    const n = open.items.find((x) => x.id === IDS.notification2);
    expect(n?.resolvedAt).toBeUndefined();
    expect(n?.execution?.text).toBe(HANDED_TO_COMMANDER);
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
    expect(body.handoff.progress).toEqual({ ok: false, why: HANDOFF_NOT_WIRED });
    // 交给指挥官没写成：不转已处理，卡上写失败原因
    expect(body.execution).toMatchObject({ ok: false, text: HANDOFF_NOT_WIRED });
    const open = NotificationsResponse.parse(
      await (await h.cockpit.request('/api/notifications', { headers: { cookie: s.cookie } })).json(),
    );
    const still = open.items.find((n) => n.id === 'n-old');
    expect(still?.resolvedAt).toBeUndefined();
    expect(still?.execution).toMatchObject({ ok: false, text: HANDOFF_NOT_WIRED });
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
    expect(body.handoff.progress).toEqual({ ok: false, why: 'GitHub 限流了' });
    expect(body.handoff.task).toEqual({ ok: false, why: 'GitHub 限流了' });
    expect(h.store.data.notifications.find((n) => n.id === IDS.notification2)?.answer?.optionId).toBe(
      'review',
    );
    expect(h.store.data.notifications.find((n) => n.id === IDS.notification2)?.resolvedAt).toBeUndefined();
    expect(body.execution).toMatchObject({ ok: false, text: 'GitHub 限流了' });
  });

  it('删工作树没接上：执行失败，resolved_at 仍为空，卡还在未处理里', async () => {
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
    expect(body.execution?.ok).toBe(false);
    expect(body.execution?.text).toContain('没接上');
    expect(body.handoff.progress.ok).toBe(false);
    const open = NotificationsResponse.parse(
      await (await h.cockpit.request('/api/notifications', { headers: { cookie: s.cookie } })).json(),
    );
    const card = open.items.find((n) => n.id === 'n-del');
    expect(card?.resolvedAt).toBeUndefined();
    expect(card?.execution?.ok).toBe(false);
    expect(card?.execution?.text).toContain('没接上');
    expect(card?.options?.find((o) => o.id === 'remove')?.action).toEqual({
      kind: 'delete-worktree',
      path: '/tmp/fleet-tree',
    });
  });
});
