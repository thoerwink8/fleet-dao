// @vitest-environment happy-dom
// 通知中心「要你拍」选项默认收起（#1950）：一条只两行（标题加「等你拍板」、一行灰字写推荐哪项加时间），
// 点「看选项」才展开选项、自己写的框；能再收起、几条能同时开着；Esc 收起、焦点回按钮；读屏有 aria-expanded、aria-controls。
// #1931 的行为（记答案、留着的项、交给指挥官的提示、「处理了」）一个不少。
import { cleanup, fireEvent, screen, waitFor, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';

const { toast } = vi.hoisted(() => ({
  toast: Object.assign(vi.fn(), { success: vi.fn(), error: vi.fn(), info: vi.fn(), warning: vi.fn() }),
}));
vi.mock('sonner', () => ({ toast, Toaster: () => null }));

import { createMockApi } from '../api/mock/server';
import NotificationsPage from '../routes/notifications';
import { renderApp } from './harness';

afterEach(cleanup);
beforeEach(() => {
  for (const f of [toast.success, toast.error, toast.info, toast.warning]) f.mockClear();
});

const RELEASE = '等你点头：发布 v2.3'; // 假数据里带选项的那条（n-1），「先不发」要留着
const OLD = '#15 在问你：发新消息还是把旧的顶上来？'; // 没有选项的老通知（n-4）
const rowOf = (title: string) => screen.getByText(title).closest('li[data-notice-row]') as HTMLElement;
const toggleOf = (title: string) => within(rowOf(title)).getByRole('button', { name: '看选项' });

describe('「要你拍」默认收起（#1950）', () => {
  test('收起时：标题加「等你拍板」，灰字写推荐哪项和理由，选项、输入框、正文都不在；「处理了」「打开」照旧在', async () => {
    renderApp(<NotificationsPage />, { api: createMockApi({ live: false }), route: '/notifications' });
    await screen.findByText(RELEASE);
    const row = rowOf(RELEASE);
    const nameLine = row.querySelector('[data-row-name-line]') as HTMLElement;
    expect(nameLine.querySelector('[data-tone="human"]')?.textContent).toBe('等你拍板');
    const hint = within(row).getByTestId('decision-hint');
    expect(hint.textContent).toBe('推荐：发布。CI 全绿、金丝雀跑过，能一键回滚，风险小');
    expect(hint.className).toContain('truncate');
    expect(hint.getAttribute('title')).toBe(hint.textContent);
    expect(row.querySelector('[data-row-meta]')?.textContent).toContain('分钟前');
    // 收起时手机上「飞书已送到」让位给推荐理由（展开后回来），没送到的红标签不藏
    expect(row.querySelector('[data-delivery="ok"]')?.className).toContain('max-md:hidden');
    expect(within(row).queryByTestId('decision-picker')).toBeNull();
    expect(within(row).queryByRole('textbox')).toBeNull();
    expect(within(row).queryByText('对外发布到生产，能一键回滚到上一版。')).toBeNull();
    const toggle = toggleOf(RELEASE);
    expect(toggle.getAttribute('aria-expanded')).toBe('false');
    expect(toggle.getAttribute('data-variant')).toBe('brand');
    expect(within(row).getByRole('button', { name: '处理了' })).toBeTruthy();
    expect(within(row).getByRole('button', { name: '打开' })).toBeTruthy();
    // 卡住报警不收：没有「看选项」，正文照旧直接看得到
    const alert = rowOf('#17 子任务 A 停滞 22 分钟');
    expect(within(alert).queryByRole('button', { name: '看选项' })).toBeNull();
    expect(within(alert).getByText('最后一步在等 ssh 连备份机；调度员建议重试。')).toBeTruthy();
  });

  test('点「看选项」展开、再点收起；aria-expanded 跟着变，aria-controls 指向选项区；两条能同时开着', async () => {
    renderApp(<NotificationsPage />, { api: createMockApi({ live: false }), route: '/notifications' });
    await screen.findByText(RELEASE);
    const toggle = toggleOf(RELEASE);
    fireEvent.click(toggle);
    expect(toggle.getAttribute('aria-expanded')).toBe('true');
    const picker = within(rowOf(RELEASE)).getByTestId('decision-picker');
    expect(toggle.getAttribute('aria-controls')).toBe(picker.id);
    expect(within(rowOf(RELEASE)).getByText('对外发布到生产，能一键回滚到上一版。')).toBeTruthy();
    // 每个选项一行：名字、一句效果；推荐项带「推荐」
    const options = within(picker).getAllByRole('listitem');
    expect(options).toHaveLength(3);
    expect(within(options[0] as HTMLElement).getByText('推荐')).toBeTruthy();
    expect(options[2]?.textContent).toContain('这条留着，这一版先压着，等我看过改动再拍');
    // 选项整行是按钮、占满一行，可点区至少 40 高（手机 44）
    for (const li of options) {
      const b = within(li as HTMLElement).getByRole('button');
      expect(b.className).toContain('w-full');
      expect(b.className).toContain('min-h-10');
      expect(b.className).toContain('max-md:min-h-11');
    }
    expect(rowOf(RELEASE).querySelector('[data-delivery="ok"]')?.className).not.toContain('max-md:hidden');

    fireEvent.click(toggleOf(OLD));
    expect(within(rowOf(OLD)).getByTestId('decision-picker')).toBeTruthy();
    expect(within(rowOf(RELEASE)).getByTestId('decision-picker')).toBeTruthy();

    fireEvent.click(toggle);
    expect(toggle.getAttribute('aria-expanded')).toBe('false');
    expect(toggle.hasAttribute('aria-controls')).toBe(false);
    expect(within(rowOf(RELEASE)).queryByTestId('decision-picker')).toBeNull();
    expect(within(rowOf(OLD)).getByTestId('decision-picker')).toBeTruthy();
  });

  test('键盘：选项是原生按钮（Enter/Space 可点、Tab 可到）；在选项区里按 Esc 收起，焦点回到「看选项」', async () => {
    renderApp(<NotificationsPage />, { api: createMockApi({ live: false }), route: '/notifications' });
    await screen.findByText(RELEASE);
    const toggle = toggleOf(RELEASE);
    expect(toggle.tagName).toBe('BUTTON');
    fireEvent.click(toggle);
    const option = within(rowOf(RELEASE)).getByRole('button', { name: '今晚再发' });
    expect(option.tagName).toBe('BUTTON');
    expect(option.getAttribute('type')).toBe('button');
    // 读屏：选项的效果说明挂在按钮的描述上
    const describedBy = option.getAttribute('aria-describedby') ?? '';
    expect(document.getElementById(describedBy)?.textContent).toContain('等晚上没人用的时候发');
    option.focus();
    fireEvent.keyDown(option, { key: 'Escape' });
    expect(toggle.getAttribute('aria-expanded')).toBe('false');
    expect(document.activeElement).toBe(toggle);
    // 焦点在按钮上按 Esc 也收起
    fireEvent.click(toggle);
    fireEvent.keyDown(toggle, { key: 'Escape' });
    expect(toggle.getAttribute('aria-expanded')).toBe('false');
  });

  test('自己写的草稿收起再展开还在', async () => {
    renderApp(<NotificationsPage />, { api: createMockApi({ live: false }), route: '/notifications' });
    await screen.findByText(OLD);
    fireEvent.click(toggleOf(OLD));
    fireEvent.change(within(rowOf(OLD)).getByRole('textbox', { name: '自己输入' }), {
      target: { value: '发新消息' },
    });
    fireEvent.click(toggleOf(OLD));
    fireEvent.click(toggleOf(OLD));
    expect((within(rowOf(OLD)).getByRole('textbox', { name: '自己输入' }) as HTMLInputElement).value).toBe(
      '发新消息',
    );
  });

  test('选了要留着的项：收起那一行改写「我选了：先不发」、不再写推荐；仍是「等你拍板」，还能再拍', async () => {
    const api = createMockApi({ live: false });
    const answer = vi.spyOn(api, 'answerNotification');
    renderApp(<NotificationsPage />, { api, route: '/notifications' });
    await screen.findByText(RELEASE);
    fireEvent.click(toggleOf(RELEASE));
    fireEvent.click(within(rowOf(RELEASE)).getByRole('button', { name: '先不发' }));
    await waitFor(() => expect(answer).toHaveBeenCalledExactlyOnceWith('n-1', { optionId: 'hold' }));
    await waitFor(() =>
      expect(within(rowOf(RELEASE)).getByTestId('decision-answer').textContent).toContain('我选了：先不发'),
    );
    expect(within(rowOf(RELEASE)).queryByTestId('decision-hint')).toBeNull();
    fireEvent.click(toggleOf(RELEASE)); // 收起：答案那一行还在
    expect(within(rowOf(RELEASE)).getByTestId('decision-answer')).toBeTruthy();
    fireEvent.click(toggleOf(RELEASE));
    expect(within(rowOf(RELEASE)).getByRole('button', { name: '发布' })).toBeTruthy();
  });

  test('交给指挥官成了：弹「记下了」并写已交给进度单 #1055', async () => {
    const api = createMockApi({ live: false });
    vi.spyOn(api, 'answerNotification').mockResolvedValueOnce({
      ok: true,
      answer: { optionId: 'release', text: '发布', at: '2026-10-12T00:00:00.000Z', by: 'u-me' },
      handoff: { progress: { ok: true, url: 'https://github.com/o/r/issues/1055#c1' } },
    } as Awaited<ReturnType<typeof api.answerNotification>>);
    renderApp(<NotificationsPage />, { api, route: '/notifications' });
    await screen.findByText(RELEASE);
    fireEvent.click(toggleOf(RELEASE));
    fireEvent.click(within(rowOf(RELEASE)).getByRole('button', { name: '发布' }));
    await waitFor(() =>
      expect(toast.success).toHaveBeenCalledWith('记下了：发布', {
        description: '已交给指挥官（进度单 #1055）',
      }),
    );
    expect(toast.warning).not.toHaveBeenCalled();
  });

  test('已处理的「要你拍」不收：没有「看选项」，写「选了：…」和正文', async () => {
    const api = createMockApi({ live: false });
    renderApp(<NotificationsPage />, { api, route: '/notifications' });
    await screen.findByText(RELEASE);
    fireEvent.click(toggleOf(RELEASE));
    fireEvent.click(within(rowOf(RELEASE)).getByRole('button', { name: '今晚再发' }));
    await waitFor(() => expect(screen.queryByText(RELEASE)).toBeNull());
    cleanup();
    renderApp(<NotificationsPage />, { api, route: '/notifications?status=all' });
    await screen.findByText(RELEASE);
    const row = rowOf(RELEASE);
    expect(within(row).queryByRole('button', { name: '看选项' })).toBeNull();
    expect(within(row).getByTestId('decision-answer').textContent).toContain('选了：今晚再发');
    expect(within(row).getByText('对外发布到生产，能一键回滚到上一版。')).toBeTruthy();
  });
});
