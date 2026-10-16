// @vitest-environment happy-dom
// 通知中心筛选条：提醒没读成时四个数写「—」，不拿 0 冒充「没有提醒」；真的一条都没有才写 0。
// 全部/待处理视图里日报默认收成一行，点开展开；日报标签页直接铺开。
import { cleanup, fireEvent, screen, waitFor, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';

const { toast } = vi.hoisted(() => ({
  toast: Object.assign(vi.fn(), { success: vi.fn(), error: vi.fn(), info: vi.fn(), warning: vi.fn() }),
}));
vi.mock('sonner', () => ({ toast, Toaster: () => null }));

import { ApiError } from '../api/client';
import { createMockApi } from '../api/mock/server';
import type { Notification } from '../api/types';
import { SidebarNav } from '../components/shell/sidebar';
import { Topbar } from '../components/shell/topbar';
import { renderApp } from '../test/harness';
import NotificationsPage from './notifications';

afterEach(cleanup);
beforeEach(() => {
  for (const f of [toast.success, toast.error, toast.info, toast.warning]) f.mockClear();
});

const LABELS = ['全部', '要你拍', '卡住报警', '日报'] as const;

/** 筛选按钮上的计数（「全部 5」这种名字里的那一截）。带 aria-pressed，别跟列表里「日报 N 条」折叠行混。 */
function countOf(label: string): string {
  const button = screen
    .getAllByRole('button', { name: new RegExp(`^${label}\\s`) })
    .find((b) => b.getAttribute('aria-pressed') != null);
  if (!button) throw new Error(`${label} 没有筛选按钮`);
  const num = button.querySelector('.num');
  if (!num) throw new Error(`${label} 没有计数`);
  return num.textContent ?? '';
}

/** 级别筛选条上的「日报」按钮（不是列表里的折叠行）。 */
function dailyTab(): HTMLElement {
  const button = screen
    .getAllByRole('button', { name: /^日报\s/ })
    .find((b) => b.getAttribute('aria-pressed') != null);
  if (!button) throw new Error('没有日报筛选按钮');
  return button;
}

const ONE: Notification = {
  id: 'n-x',
  level: 'decision',
  title: '等你拍一件',
  body: '有一件要拍。',
  createdAt: '2026-10-10T00:00:00.000Z',
  deliveries: [],
};

const MIXED: Notification[] = [
  {
    id: 'n-decision',
    level: 'decision',
    title: '等你拍：发不发版',
    body: '要拍一发。',
    createdAt: '2026-10-10T12:00:00.000Z',
    deliveries: [],
  },
  {
    id: 'n-daily-1',
    level: 'daily',
    title: '今日日报甲',
    body: '合并了几条。',
    createdAt: '2026-10-10T11:00:00.000Z',
    deliveries: [],
  },
  {
    id: 'n-alert',
    level: 'alert',
    title: '卡住：测试没过',
    body: '有任务挂了。',
    createdAt: '2026-10-10T10:00:00.000Z',
    deliveries: [],
  },
  {
    id: 'n-daily-2',
    level: 'daily',
    title: '今日日报乙',
    body: '额度还剩一点。',
    createdAt: '2026-10-10T09:00:00.000Z',
    deliveries: [],
  },
];

const MIXED_COUNTS = { decision: 1, alert: 1, daily: 2 };

describe('通知中心筛选条计数', () => {
  test('读失败显示 — 且有重试', async () => {
    // 四个数仍写 0，或点重试不再请求，这一条会红。
    const api = createMockApi({ live: false });
    let calls = 0;
    let fail = true;
    api.notifications = () => {
      calls += 1;
      if (fail) return Promise.reject(new ApiError(500, 'internal', '后端出错了'));
      return Promise.resolve({ items: [ONE], counts: { decision: 1, alert: 0, daily: 0 } });
    };
    renderApp(<NotificationsPage />, { api });

    expect(await screen.findByRole('alert')).toBeTruthy();
    expect(screen.getByRole('alert').textContent).toContain('提醒没读成');
    expect(screen.getByRole('button', { name: '重试' })).toBeTruthy();
    for (const label of LABELS) expect(countOf(label)).toBe('—');
    expect(screen.queryByText('没有待处理的提醒')).toBeNull();

    const before = calls;
    fail = false;
    fireEvent.click(screen.getByRole('button', { name: '重试' }));
    await waitFor(() => expect(calls).toBeGreaterThan(before));
    await waitFor(() => expect(countOf('全部')).toBe('1'));
    expect(countOf('要你拍')).toBe('1');
    expect(countOf('卡住报警')).toBe('0');
    expect(countOf('日报')).toBe('0');
    expect(screen.queryByRole('alert')).toBeNull();
    expect(screen.getByText('等你拍一件')).toBeTruthy();
  });

  test('读成功无提醒显示 0', async () => {
    // 真的没有提醒时改成「—」，或空态文案变了，这一条会红。
    const api = createMockApi({ live: false });
    api.notifications = () => Promise.resolve({ items: [], counts: { decision: 0, alert: 0, daily: 0 } });
    renderApp(<NotificationsPage />, { api });

    expect(await screen.findByText('没有待处理的提醒')).toBeTruthy();
    expect(screen.getByText('要你拍板或有东西卡住时，这里和飞书会同时提醒。')).toBeTruthy();
    for (const label of LABELS) expect(countOf(label)).toBe('0');
    expect(screen.queryByText('—')).toBeNull();
    expect(screen.queryByRole('alert')).toBeNull();
  });
});

describe('通知数同一口径（#1745）', () => {
  /** 接口只取回前 2 条，但真实总数是 1 + 8 + 8 = 17。 */
  function truncatedApi() {
    const api = createMockApi({ live: false });
    const calls: number[] = [];
    api.notifications = (q) => {
      const limit = q?.limit ?? 0;
      calls.push(limit);
      const items = [ONE, { ...ONE, id: 'n-y', level: 'alert' as const, title: '卡住了' }].slice(0, limit);
      return Promise.resolve({
        items,
        nextCursor: 'more',
        counts: { decision: 1, alert: 8, daily: 8 },
      });
    };
    return { api, calls };
  }

  test('计数用接口总数，不拿这一页的条数封顶；待处理不含日报', async () => {
    // 计数改回数 items.length，会是 2 而不是 17，这一条会红。
    const { api } = truncatedApi();
    renderApp(<NotificationsPage />, { api });
    await waitFor(() => expect(countOf('全部')).toBe('17'));
    expect(countOf('要你拍')).toBe('1');
    expect(countOf('卡住报警')).toBe('8');
    expect(countOf('日报')).toBe('8');
    expect(screen.getByTestId('pending-rule').textContent).toContain('待处理 9 条');
    // 说明行是写给创始人的白话，不再提「铃铛和侧栏角标同数」（#1821）
    expect(screen.getByTestId('pending-rule').textContent).toContain(
      '要你拍的和卡住的，处理了就从这里消失。',
    );
    expect(screen.getByTestId('pending-rule').textContent).not.toContain('角标');
    expect(screen.getByText(/只取回了最近/).textContent).toContain('共 17 条');
  });

  test('铃铛、侧栏角标、通知中心三处待处理同数，日报不算', async () => {
    // 任何一处改回数 items.length 或把日报算进去，这一条会红。
    const api = createMockApi({ live: false });
    api.notifications = () =>
      Promise.resolve({
        items: [ONE],
        nextCursor: 'more',
        counts: { decision: 1, alert: 8, daily: 8 },
      });
    renderApp(
      <>
        <Topbar onSearch={() => {}} />
        <SidebarNav />
        <NotificationsPage />
      </>,
      { api },
    );
    const bell = await screen.findByRole('button', { name: '提醒，9 条待处理' });
    expect(bell.textContent).toBe('9');
    // 侧栏「更多」收着时角标挂在它上面（决定 0093），点开后挂在「通知中心」上
    const more = screen.getByRole('button', { name: /更多/ });
    expect(more.textContent).toContain('9');
    fireEvent.click(more);
    const side = screen
      .getAllByRole('link')
      .find((a) => a.getAttribute('href')?.startsWith('/notifications'));
    expect(side?.textContent).toContain('9');
    await waitFor(() => expect(screen.getByTestId('pending-rule').textContent).toContain('待处理 9 条'));
    fireEvent.click(bell);
    expect((await screen.findByText('待处理的提醒')).parentElement?.textContent).toContain('9，另有日报 8');
  });

  test('只取了一部分时能往下翻：点「再多看」再要更多条', async () => {
    const { api, calls } = truncatedApi();
    renderApp(<NotificationsPage />, { api });
    const more = await screen.findByRole('button', { name: /再多看/ });
    const before = calls.length;
    fireEvent.click(more);
    await waitFor(() => expect(calls.length).toBeGreaterThan(before));
    expect(calls.at(-1)).toBeGreaterThan(calls[0] ?? 0);
  });
});

describe('通知中心日报折叠', () => {
  test('全部视图里日报默认折叠、点开后展开、日报标签页直接展开', async () => {
    // 全部里仍把日报一条条铺开、折叠后标题还露着、或日报页还出「日报 N 条」，这一条会红。
    const api = createMockApi({ live: false });
    api.notifications = () => Promise.resolve({ items: MIXED, counts: MIXED_COUNTS });
    renderApp(<NotificationsPage />, { api });

    expect(await screen.findByText('等你拍：发不发版')).toBeTruthy();
    expect(screen.getByText('卡住：测试没过')).toBeTruthy();
    // 标签计数口径不变：全部 4、要你拍 1、卡住报警 1、日报 2。
    expect(countOf('全部')).toBe('4');
    expect(countOf('要你拍')).toBe('1');
    expect(countOf('卡住报警')).toBe('1');
    expect(countOf('日报')).toBe('2');

    const fold = screen.getByTestId('daily-fold');
    expect(fold.textContent).toMatch(/日报\s*2\s*条/);
    expect(fold.getAttribute('aria-expanded')).toBe('false');
    expect(screen.queryByText('今日日报甲')).toBeNull();
    expect(screen.queryByText('今日日报乙')).toBeNull();

    fireEvent.click(fold);
    expect(fold.getAttribute('aria-expanded')).toBe('true');
    expect(screen.getByText('今日日报甲')).toBeTruthy();
    expect(screen.getByText('今日日报乙')).toBeTruthy();

    fireEvent.click(dailyTab());
    await waitFor(() => expect(screen.queryByTestId('daily-fold')).toBeNull());
    expect(screen.getByText('今日日报甲')).toBeTruthy();
    expect(screen.getByText('今日日报乙')).toBeTruthy();
    expect(screen.queryByText('等你拍：发不发版')).toBeNull();
    expect(screen.queryByText('卡住：测试没过')).toBeNull();
    // 切到日报页后计数仍按接口 counts 算。
    expect(countOf('全部')).toBe('4');
    expect(countOf('日报')).toBe('2');
  });

  test('待处理视图同样折叠日报，要你拍和卡住报警仍在列表里', async () => {
    const api = createMockApi({ live: false });
    api.notifications = () => Promise.resolve({ items: MIXED, counts: MIXED_COUNTS });
    renderApp(<NotificationsPage />, { api, route: '/notifications' });

    const pending = await screen.findByRole('tab', { name: '待处理' });
    expect(pending.getAttribute('aria-selected')).toBe('true');
    const fold = await screen.findByTestId('daily-fold');
    expect(fold.textContent).toMatch(/日报\s*2\s*条/);
    expect(fold.getAttribute('aria-expanded')).toBe('false');
    expect(screen.getByText('等你拍：发不发版')).toBeTruthy();
    expect(screen.getByText('卡住：测试没过')).toBeTruthy();
    // 折叠行在动作项之后：先看到要你拍/报警，再是日报折叠。
    const actionTitle = screen.getByText('卡住：测试没过');
    expect(fold.compareDocumentPosition(actionTitle) & Node.DOCUMENT_POSITION_PRECEDING).toBeTruthy();
    expect(within(fold).getByText('2')).toBeTruthy();
  });
});

describe('通知卡：正文限两行、主操作带字、两组筛选分主次（#1904）', () => {
  const LONG = Array.from({ length: 12 }, (_, i) => `第 ${i + 1} 行很长的说明`).join('\n');

  test('正文默认只显两行，点一下展开、再点收起；「处理了」「打开」按钮上有字（要你拍的没有「处理了」，#2353）', async () => {
    const api = createMockApi({ live: false });
    api.notifications = () =>
      Promise.resolve({
        items: [
          { ...ONE, body: LONG, link: '/tasks' },
          { ...ONE, id: 'n-alert', level: 'alert', title: '卡住：长正文', body: LONG, link: '/tasks' },
        ],
        counts: { decision: 1, alert: 1, daily: 0 },
      });
    renderApp(<NotificationsPage />, { api, route: '/notifications' });

    // ONE 是待拍的「要你拍」：正文直接在卡上（#2353）
    const body = (await screen.findAllByText(/第 1 行很长的说明/))[0]?.closest('button') as HTMLElement;
    expect(body.className).toContain('line-clamp-2');
    expect(body.getAttribute('aria-expanded')).toBe('false');
    fireEvent.click(body);
    expect(body.className).not.toContain('line-clamp-2');
    expect(body.getAttribute('aria-expanded')).toBe('true');
    fireEvent.click(body);
    expect(body.className).toContain('line-clamp-2');

    const row = body.closest('li[data-notice-row]') as HTMLElement;
    expect(within(row).queryByRole('button', { name: '处理了' })).toBeNull();
    expect(within(row).getByRole('button', { name: '打开' }).textContent).toBe('打开');
    const alertRow = screen.getByText('卡住：长正文').closest('li[data-notice-row]') as HTMLElement;
    expect(within(alertRow).getByRole('button', { name: '处理了' }).textContent).toBe('处理了');
  });

  test('处理状态是主筛选（灰底轨道），级别是次级筛选（没有轨道）；级别标签的色和圆点同一个状态色', async () => {
    const api = createMockApi({ live: false });
    api.notifications = () => Promise.resolve({ items: MIXED, counts: MIXED_COUNTS });
    renderApp(<NotificationsPage />, { api, route: '/notifications' });
    await screen.findByText('等你拍：发不发版');
    expect(screen.getByRole('tablist', { name: '处理状态' }).getAttribute('data-variant')).toBe('primary');
    expect(screen.getByRole('group', { name: '按级别' }).getAttribute('data-variant')).toBe('secondary');
    const row = screen.getByText('卡住：测试没过').closest('li') as HTMLElement;
    const dotTone = row.querySelector('span[data-tone][aria-hidden]')?.getAttribute('data-tone');
    const tagTone = Array.from(row.querySelectorAll('span[data-tone]'))
      .find((e) => e.textContent === '卡住报警')
      ?.getAttribute('data-tone');
    expect(tagTone).toBeTruthy();
    expect(tagTone).toBe(dotTone);
  });
});

describe('「要你拍」带选项（#1915）', () => {
  const RELEASE = '等你点头：发布 v2.3'; // 假数据里带选项的那条（n-1）
  const OLD = '#15 在问你：发新消息还是把旧的顶上来？'; // 假数据里没有选项的老通知（n-4）
  const rowOf = (title: string) => screen.getByText(title).closest('li[data-notice-row]') as HTMLElement;

  test('选项是可点的按钮，推荐那项标「推荐」并写理由；点选项记下答案，系统照着做、转已处理，页面上看得到选了什么', async () => {
    const api = createMockApi({ live: false });
    const answer = vi.spyOn(api, 'answerNotification');
    renderApp(<NotificationsPage />, { api, route: '/notifications' });
    await screen.findByText(RELEASE);
    const row = rowOf(RELEASE);
    const picker = within(row).getByTestId('decision-picker');
    // 选项整行是按钮（#1950），行里还有说明：按钮的名字（aria-label）仍是选项的字
    expect(
      within(picker)
        .getAllByRole('button')
        .map((b) => b.getAttribute('aria-label') ?? b.textContent),
    ).toEqual(['发布', '今晚再发', '先不发', '提交']);
    expect(within(picker).getByText('推荐')).toBeTruthy();
    expect(picker.textContent).toContain('CI 全绿、金丝雀跑过，能一键回滚，风险小');
    expect(within(picker).getByRole('textbox', { name: '自己写一句' })).toBeTruthy();

    fireEvent.click(within(picker).getByRole('button', { name: '今晚再发' }));
    await waitFor(() => expect(answer).toHaveBeenCalledExactlyOnceWith('n-1', { optionId: 'tonight' }));
    // 假数据没接 GitHub：交给指挥官按交出去了走，话里照实说没真留言
    await waitFor(() =>
      expect(toast.success).toHaveBeenCalledWith('照做了：今晚再发', {
        description: '已转给指挥官（假数据：没接 GitHub，没真留言）',
      }),
    );
    expect(toast.error).not.toHaveBeenCalled();
    // 转已处理：待处理里没了；连已处理的一起看能看到选了什么
    await waitFor(() => expect(screen.queryByText(RELEASE)).toBeNull());
    cleanup();
    renderApp(<NotificationsPage />, { api, route: '/notifications?status=all' });
    await screen.findByText(RELEASE);
    expect(within(rowOf(RELEASE)).getByTestId('decision-answer').textContent).toContain('选了：今晚再发');
    expect(within(rowOf(RELEASE)).queryByTestId('decision-picker')).toBeNull();
  });

  test('自定义输入记下答案：发原文，转已处理，页面写「自己写了」', async () => {
    const api = createMockApi({ live: false });
    const answer = vi.spyOn(api, 'answerNotification');
    renderApp(<NotificationsPage />, { api, route: '/notifications' });
    await screen.findByText(OLD);
    const picker = within(rowOf(OLD)).getByTestId('decision-picker');
    const submit = within(picker).getByRole('button', { name: '提交' });
    expect(submit).toHaveProperty('disabled', true); // 空的不能交
    // 这条没有要留着的选项：页面先说清自己写的会转已处理
    expect(within(picker).getByTestId('custom-effect').textContent).toBe(
      '自己写的：交给指挥官去办，交出去了这条转已处理',
    );
    fireEvent.change(within(picker).getByRole('textbox', { name: '自己写一句' }), {
      target: { value: '  发新消息  ' },
    });
    fireEvent.click(submit);
    await waitFor(() => expect(answer).toHaveBeenCalledExactlyOnceWith('n-4', { text: '发新消息' }));
    await waitFor(() => expect(screen.queryByText(OLD)).toBeNull());
    cleanup();
    renderApp(<NotificationsPage />, { api, route: '/notifications?status=all' });
    await screen.findByText(OLD);
    expect(within(rowOf(OLD)).getByTestId('decision-answer').textContent).toContain('自己写了：发新消息');
  });

  test('选了要留着的项（#1931）：答案记下、这条照旧在待处理里、还能再拍；有这种项时自己写的也说「先留着」', async () => {
    const api = createMockApi({ live: false });
    const answer = vi.spyOn(api, 'answerNotification');
    renderApp(<NotificationsPage />, { api, route: '/notifications' });
    await screen.findByText(RELEASE);
    expect(within(rowOf(RELEASE)).getByTestId('custom-effect').textContent).toBe(
      '自己写的：交给指挥官去办，这条先留着',
    );
    fireEvent.click(within(rowOf(RELEASE)).getByRole('button', { name: '先不发' }));
    await waitFor(() => expect(answer).toHaveBeenCalledExactlyOnceWith('n-1', { optionId: 'hold' }));
    await waitFor(() =>
      expect(within(rowOf(RELEASE)).getByTestId('decision-answer').textContent).toContain('选了：先不发'),
    );
    // 还在待处理里，选项还能点
    expect(within(rowOf(RELEASE)).getByRole('button', { name: '发布' })).toBeTruthy();
  });

  test('没有选项的老通知照旧显示：标题、正文都在，写明「没有选项，请直接回复」并给输入框；没有「处理了」（#2353）', async () => {
    const api = createMockApi({ live: false });
    renderApp(<NotificationsPage />, { api, route: '/notifications' });
    await screen.findByText(OLD);
    const row = rowOf(OLD);
    expect(within(row).getByTestId('no-options').textContent).toBe('没有选项，请直接回复');
    expect(within(row).getByText('再提醒时怎么处理旧消息。')).toBeTruthy();
    expect(within(row).queryByRole('button', { name: '处理了' })).toBeNull();
    expect(within(row).getByTestId('no-options').textContent).toBe('没有选项，请直接回复');
    expect(within(row).getByRole('textbox', { name: '自己写一句' })).toBeTruthy();
    // 卡住报警不是要人拍的：没有选项区
    expect(within(rowOf('#17 子任务 A 停滞 22 分钟')).queryByTestId('decision-picker')).toBeNull();
  });

  test('【故意造出的失败】后端拒了：弹「没记下」和原因，这条仍在待处理里', async () => {
    const api = createMockApi({ live: false });
    vi.spyOn(api, 'answerNotification').mockRejectedValueOnce(
      new ApiError(409, 'notification_already_resolved', '这条已经处理过了，答案没改'),
    );
    renderApp(<NotificationsPage />, { api, route: '/notifications' });
    await screen.findByText(RELEASE);
    fireEvent.click(within(rowOf(RELEASE)).getByRole('button', { name: '发布' }));
    await waitFor(() =>
      expect(toast.error).toHaveBeenCalledWith('没记下', { description: '这条已经处理过了，答案没改' }),
    );
    expect(toast.success).not.toHaveBeenCalled();
    expect(screen.getByText(RELEASE)).toBeTruthy();
  });
});
