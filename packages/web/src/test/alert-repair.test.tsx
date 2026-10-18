// @vitest-environment happy-dom
// 看门狗提醒卡上的受控修复（#3034，后端 #3033）：后端现算能点的动作和实际后果；点之前先重读、按钮过期不发；
// 原卡写排队 → 执行 → 核验中 → 已修复 / 没修成 / 结果未知；只有后端 verified 才写已修复；手动「处理了」不冒充修好；
// 没动作、没接上照实说并留「打开」和「提需求」出口；要本人拍的才写为什么要你拍，「先不动」不执行。
import { cleanup, fireEvent, screen, waitFor, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';

const { toast } = vi.hoisted(() => ({
  toast: Object.assign(vi.fn(), { success: vi.fn(), error: vi.fn(), info: vi.fn(), warning: vi.fn() }),
}));
vi.mock('sonner', () => ({ toast, Toaster: () => null }));

import { ApiError } from '../api/client';
import { createMockApi } from '../api/mock/server';
import type { ExecuteAlertRepairBody, ExecuteAlertRepairResult, Notification } from '../api/types';
import { type RepairAction, type RepairRecord, type RepairView, recommendation } from '../lib/alert-repair';
import NotificationsPage from '../routes/notifications';
import { renderApp } from './harness';

afterEach(cleanup);
beforeEach(() => {
  for (const f of [toast.success, toast.error, toast.info, toast.warning]) f.mockClear();
});

const TITLE = '#17 子任务 A 停滞 22 分钟'; // 假数据里的卡住报警，这里改成看门狗的 idle-running
const INCIDENT = 'inc-1';
const RECOVER: RepairAction = {
  id: 'task-recover:aaa',
  kind: 'task-recover',
  label: '叫醒任务继续',
  detail: '给任务 #17 的当前工作流发「继续」和路由叫醒（同任务页的继续）；任务行动起来才算修好',
  target: {
    taskId: 't-17',
    issueNumber: 17,
    workflowId: 'task-17',
    workflowRunId: 'run-1',
    repo: { owner: 'acme', name: 'orbit' },
  },
};
const HAND: RepairAction = {
  id: 'hand-to-repair:bbb',
  kind: 'hand-to-repair',
  label: '交给修复',
  detail: '在 fleet-dao 开一张四节修复单，立刻调用 dispatch-issue 准入派工；同一次事故只开一张',
  target: { repo: { owner: 'acme', name: 'fleet-dao' } },
};
const RESTORE: RepairAction = {
  id: 'release-restore:ccc',
  kind: 'release-restore',
  label: '恢复引擎开关',
  detail: '把引擎总开关恢复成发版前的样子：写恢复请求，法国上的单元接活',
  target: { sha: 'abcdef1234567890', releaseStartedAt: '2026-10-18T08:00:00.000Z' },
  choice: {
    allowText: true,
    options: [
      {
        id: 'do',
        label: '执行：恢复引擎开关',
        detail: '写恢复请求',
        recommended: '提醒的条件已核实，这是现有的恢复入口',
      },
      { id: 'hold', label: '先不动', detail: '什么都不做，提醒留着', keepsOpen: true },
    ],
  },
};

const rec = (over: Partial<RepairRecord>): RepairRecord => ({
  incident: INCIDENT,
  actionId: RECOVER.id,
  kind: 'task-recover',
  requestId: '11111111-1111-4111-8111-111111111111',
  state: 'accepted',
  text: '继续信号已受理（收到了，不等于修好）',
  at: new Date().toISOString(),
  by: 'founder',
  target: RECOVER.target,
  ...over,
});

/** 假后端：列表里那条卡住报警换成看门狗的，repair 由 view() 现给；执行由 exec 决定。 */
function setup(opts: {
  view: () => RepairView | undefined;
  exec?: (body: ExecuteAlertRepairBody) => Promise<ExecuteAlertRepairResult>;
  patch?: (n: Notification) => Notification;
}) {
  const api = createMockApi({ live: false });
  const list = api.notifications;
  let reads = 0;
  api.notifications = async (query) => {
    reads += 1;
    const page = await list(query);
    return {
      ...page,
      items: page.items.map((n) => {
        if (n.title !== TITLE) return n;
        const { repair: _r, ...rest } = n;
        const v = opts.view();
        const w: Notification = {
          ...rest,
          dedupeKey: 'watchdog:idle-running:t-17',
          ...(v ? { repair: v } : {}),
        };
        return opts.patch ? opts.patch(w) : w;
      }),
    };
  };
  const bodies: ExecuteAlertRepairBody[] = [];
  api.executeAlertRepair = async (_id, body) => {
    bodies.push(body);
    if (!opts.exec) throw new Error('不该执行');
    return opts.exec(body);
  };
  renderApp(<NotificationsPage />, { api, route: '/notifications' });
  return { api, bodies, reads: () => reads };
}

const card = async () => {
  const t = await screen.findByText(TITLE);
  return t.closest('li[data-notice-row]') as HTMLElement;
};

describe('看门狗提醒：后端给的动作和后果、推荐、要不要你拍', () => {
  test('多个动作：每个写实际后果，推荐直接恢复的那个并写理由；不带 choice 的不写「要你拍」', async () => {
    setup({ view: () => ({ incident: INCIDENT, actions: [RECOVER, HAND], problems: [] }) });
    const row = await card();
    const list = within(row).getByTestId('repair-actions');
    expect(within(list).getByText(RECOVER.detail, { exact: false })).toBeTruthy();
    expect(within(list).getByText(HAND.detail)).toBeTruthy();
    const first = within(list).getByRole('button', { name: '叫醒任务继续' });
    expect(within(first).getByText('推荐')).toBeTruthy();
    expect(first.textContent).toContain('推荐：现有的恢复入口');
    expect(within(list).queryByText('要你拍')).toBeNull();
    // 普通 alert 不借「等你拍板」
    expect(within(row).queryByText('等你拍板')).toBeNull();
  });

  test('只有一个动作不写推荐；要本人拍的动作点开才摆选项，并写为什么要你拍', async () => {
    expect(recommendation([RECOVER])).toBeUndefined();
    setup({ view: () => ({ incident: INCIDENT, actions: [RESTORE], problems: [] }) });
    const row = await card();
    const btn = within(row).getByRole('button', { name: '恢复引擎开关' });
    expect(within(btn).getByText('要你拍')).toBeTruthy();
    expect(within(btn).queryByText('推荐')).toBeNull();
    expect(within(row).queryByTestId('decision-picker')).toBeNull();
    fireEvent.click(btn);
    expect(within(row).getByTestId('repair-why-you').textContent).toContain('会动引擎总开关');
    expect(within(row).getByRole('button', { name: '先不动' })).toBeTruthy();
  });
});

describe('点了以后原卡写到哪一步', () => {
  test('先重读再发；连点只发一次；送的是服务端给的编号、incident、新的 requestId；受理只写核验中，不写已修复', async () => {
    let state: RepairRecord | undefined;
    let release: () => void = () => undefined;
    const { bodies } = setup({
      view: () => ({
        incident: INCIDENT,
        actions: state ? [] : [RECOVER, HAND],
        problems: [],
        ...(state ? { last: state } : {}),
      }),
      exec: async (body) => {
        await new Promise<void>((r) => {
          release = r;
        });
        state = rec({ requestId: body.requestId });
        return { ok: true, repair: state, replayed: false };
      },
    });
    const row = await card();
    const btn = within(row).getByRole('button', { name: '叫醒任务继续' });
    fireEvent.click(btn);
    fireEvent.click(btn);
    await waitFor(() => expect(within(row).getByTestId('repair-busy').dataset.step).toBe('sent'));
    expect(within(row).getByText(/已排队：叫醒任务继续/)).toBeTruthy();
    expect(within(row).queryByTestId('repair-actions')).toBeNull();
    release();
    await waitFor(() => expect(within(row).getByTestId('repair-record').dataset.phase).toBe('verifying'));
    expect(bodies).toHaveLength(1);
    expect(bodies[0]?.actionId).toBe(RECOVER.id);
    expect(bodies[0]?.incident).toBe(INCIDENT);
    expect(bodies[0]?.requestId).toMatch(/^[0-9a-f-]{36}$/);
    expect(within(row).getByText('核验中')).toBeTruthy();
    expect(within(row).queryByText('已修复')).toBeNull();
    expect(within(row).getByText(/收到了不等于修好/)).toBeTruthy();
    expect(toast.info).toHaveBeenCalled();
  });

  test('后端核验成功（verified）才写已修复', async () => {
    setup({
      view: () => ({
        incident: INCIDENT,
        actions: [],
        problems: [],
        last: rec({ state: 'verified', text: '核实恢复：原检测条件已恢复' }),
      }),
    });
    const row = await card();
    expect(within(row).getByTestId('repair-record').dataset.phase).toBe('verified');
    expect(within(row).getByText('已修复')).toBeTruthy();
  });

  test('点之前重读发现动作已经变了：不发，写现场变了', async () => {
    let n = 0;
    const { bodies } = setup({
      view: () => {
        n += 1;
        return {
          incident: INCIDENT,
          actions: [n === 1 ? RECOVER : { ...RECOVER, id: 'task-recover:new' }],
          problems: [],
        };
      },
      exec: async () => {
        throw new Error('不该到这');
      },
    });
    const row = await card();
    fireEvent.click(within(row).getByRole('button', { name: '叫醒任务继续' }));
    await waitFor(() => expect(within(row).getByTestId('repair-note').textContent).toContain('现场变了'));
    expect(bodies).toHaveLength(0);
  });

  test('后端回 409 过期：卡上写原话，已刷新，不沿旧编号重发', async () => {
    const { bodies, reads } = setup({
      view: () => ({ incident: INCIDENT, actions: [RECOVER], problems: [] }),
      exec: async () => {
        throw new ApiError(409, 'action_expired', '这个动作已经过期（现场条件变了）：刷新后看当前能点的');
      },
    });
    const row = await card();
    const before = reads();
    fireEvent.click(within(row).getByRole('button', { name: '叫醒任务继续' }));
    await waitFor(() =>
      expect(within(row).getByTestId('repair-note').textContent).toContain('已刷新，按现在能点的重选'),
    );
    expect(bodies).toHaveLength(1);
    expect(reads()).toBeGreaterThanOrEqual(before + 2);
  });

  test('超时没收到回执：写没收到回执、不给新按钮；「再问一次」用同一个 requestId', async () => {
    let first = true;
    const { bodies } = setup({
      view: () => ({ incident: INCIDENT, actions: [RECOVER], problems: [] }),
      exec: async (body) => {
        if (first) {
          first = false;
          throw new ApiError(0, 'timeout', '后端 30 秒没回话');
        }
        return { ok: true, repair: rec({ requestId: body.requestId }), replayed: true };
      },
    });
    const row = await card();
    fireEvent.click(within(row).getByRole('button', { name: '叫醒任务继续' }));
    await waitFor(() => expect(within(row).getByTestId('repair-record').dataset.phase).toBe('no-receipt'));
    expect(within(row).queryByTestId('repair-actions')).toBeNull();
    fireEvent.click(within(row).getByRole('button', { name: '再问一次（同一请求）' }));
    await waitFor(() => expect(within(row).getByTestId('repair-record').dataset.phase).toBe('verifying'));
    expect(bodies).toHaveLength(2);
    expect(bodies[1]?.requestId).toBe(bodies[0]?.requestId);
    expect(toast.info.mock.calls.at(-1)?.[1]?.description).toContain('没有再执行');
  });

  test('没修成：中文原因留在卡上，「具体操作」写目标、请求编号和操作记录链接，还能再选', async () => {
    setup({
      view: () => ({
        incident: INCIDENT,
        actions: [RECOVER],
        problems: [],
        last: rec({ state: 'failed', text: '信号没发出去：工作流不在了' }),
      }),
    });
    const row = await card();
    expect(within(row).getByTestId('repair-record').dataset.phase).toBe('failed');
    expect(within(row).getByText('信号没发出去：工作流不在了')).toBeTruthy();
    const detail = within(row).getByTestId('repair-detail');
    expect(detail.textContent).toContain('任务 #17（acme/orbit）');
    expect(detail.textContent).toContain('run run-1');
    expect(
      within(detail)
        .getByRole('link', { name: /查这条的操作记录/ })
        .getAttribute('href'),
    ).toMatch(/^\/audit\?target=notification%3A/);
    expect(within(row).getByRole('button', { name: '叫醒任务继续' })).toBeTruthy();
  });

  test('结果未知：不给按钮、写不会自动重试', async () => {
    setup({
      view: () => ({
        incident: INCIDENT,
        actions: [],
        problems: [],
        last: rec({ state: 'unknown', text: '执行结果未知' }),
      }),
    });
    const row = await card();
    expect(within(row).getByText('结果未知')).toBeTruthy();
    expect(within(row).getByText(/不会自动重试/)).toBeTruthy();
    expect(within(row).queryByTestId('repair-actions')).toBeNull();
    expect(within(row).queryByTestId('repair-none')).toBeNull();
  });

  test('交给修复：写真实单号链接和处理人', async () => {
    setup({
      view: () => ({
        incident: INCIDENT,
        actions: [],
        problems: [],
        last: rec({
          kind: 'hand-to-repair',
          actionId: HAND.id,
          state: 'handed',
          text: '修复单 #3100：已由 dispatch-issue 接手',
          issue: {
            repo: { owner: 'acme', name: 'fleet-dao' },
            number: 3100,
            url: 'https://github.com/acme/fleet-dao/issues/3100',
            created: true,
          },
        }),
      }),
    });
    const row = await card();
    const issue = within(row).getByTestId('repair-issue');
    expect(within(issue).getByText('acme/fleet-dao#3100')).toBeTruthy();
    expect(issue.textContent).toContain('处理人：');
    expect(within(row).getByText('已交给修复')).toBeTruthy();
  });

  test('要本人拍的：选「先不动」送 optionId=hold，后端记没执行', async () => {
    const { bodies } = setup({
      view: () => ({ incident: INCIDENT, actions: [RESTORE], problems: [] }),
      exec: async (body) => ({
        ok: true,
        repair: rec({
          kind: 'release-restore',
          actionId: RESTORE.id,
          state: 'declined',
          text: '你选了「先不动」，没有执行',
          requestId: body.requestId,
        }),
        replayed: false,
      }),
    });
    const row = await card();
    fireEvent.click(within(row).getByRole('button', { name: '恢复引擎开关' }));
    fireEvent.click(within(row).getByRole('button', { name: '先不动' }));
    await waitFor(() => expect(within(row).getByTestId('repair-record').dataset.phase).toBe('declined'));
    expect(bodies[0]?.optionId).toBe('hold');
    expect(within(row).getByText('没执行')).toBeTruthy();
  });
});

describe('没有能点的、没接上、手动处理', () => {
  test('看门狗提醒没带 repair：写修复能力没接上，留「打开」和「提需求」出口', async () => {
    setup({ view: () => undefined });
    const row = await card();
    const none = within(row).getByTestId('repair-none');
    expect(row.textContent).toContain('修复能力没接上');
    expect(within(none).getByRole('link', { name: '到「提需求」写一句' }).getAttribute('href')).toBe(
      '/intake',
    );
    expect(within(row).getByRole('button', { name: '打开' })).toBeTruthy();
  });

  test('带了 repair 但没有动作：照实列后端给的原因', async () => {
    setup({
      view: () => ({
        incident: INCIDENT,
        actions: [],
        problems: ['没接上任务现读（开发环境），「任务继续」用不了'],
      }),
    });
    const row = await card();
    expect(row.textContent).toContain('现在没有能直接点的修复');
    expect(within(row).getByText('没接上任务现读（开发环境），「任务继续」用不了')).toBeTruthy();
  });

  test('手动标了已处理：不写已修复，写没核实修好', async () => {
    setup({
      view: () => ({ incident: INCIDENT, actions: [], problems: [] }),
      patch: (n) => ({ ...n, resolvedAt: new Date().toISOString(), resolvedBy: 'founder' }),
    });
    fireEvent.click(await screen.findByRole('tab', { name: '连已处理的一起看' }));
    const row = await card();
    expect(within(row).getByTestId('repair-manual').textContent).toContain('没核实修好');
    expect(within(row).queryByText('已修复')).toBeNull();
  });

  test('别的提醒（不是看门狗的）不出修复区', async () => {
    setup({ view: () => undefined, patch: (n) => ({ ...n, dedupeKey: 'stalled:17' }) });
    const row = await card();
    expect(within(row).queryByTestId('alert-repair')).toBeNull();
  });
});
