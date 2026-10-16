// @vitest-environment happy-dom
// 通知中心「要你拍」的卡（#1950 起两行收起；#2353 改成选项直接摆在卡上）：标题加「等你拍板」、一行灰字写推荐哪项，
// 下面直接是选项和「自己写一句」，没有「看选项」、也没有「处理了」（创始人 2026-10-16：只让用户填写或者选择）。
// 选完系统照着做，结果写回卡上：做成了转已处理；没做成卡留着、写原因、还能再选；交给引擎的（删工作树）写「交给引擎了」。
// #1931 的行为（留着的项、自己写的去向）照旧。
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
const APP = 'acme/fluxwatch：机器人还没装（还没装：「干活的」机器人）'; // n-11：上次「再查一次」没查成
const TREE = '工作树里有没推的东西，删不删要你拍：acme_orbit/11-callback'; // n-12：删掉交给引擎
const rowOf = (title: string) => screen.getByText(title).closest('li[data-notice-row]') as HTMLElement;

describe('「要你拍」选项直接摆在卡上（#2353）', () => {
  test('标题加「等你拍板」、灰字写推荐哪项；选项、自己写一句、正文都直接在；没有「看选项」「处理了」，「打开」照旧在', async () => {
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
    const picker = within(row).getByTestId('decision-picker');
    expect(within(picker).getByRole('textbox', { name: '自己写一句' })).toBeTruthy();
    expect(within(row).getByText('对外发布到生产，能一键回滚到上一版。')).toBeTruthy();
    expect(within(row).queryByRole('button', { name: '看选项' })).toBeNull();
    expect(within(row).queryByRole('button', { name: '处理了' })).toBeNull();
    expect(within(row).getByRole('button', { name: '打开' })).toBeTruthy();
    // 每个选项一行：名字、一句效果；推荐项带「推荐」；整行是按钮、占满一行，可点区至少 40 高（手机 44）
    const options = within(picker).getAllByRole('listitem');
    expect(options).toHaveLength(3);
    expect(within(options[0] as HTMLElement).getByText('推荐')).toBeTruthy();
    expect(options[2]?.textContent).toContain('这条留着，这一版先压着，等我看过改动再拍');
    for (const li of options) {
      const b = within(li as HTMLElement).getByRole('button');
      expect(b.className).toContain('w-full');
      expect(b.className).toContain('min-h-10');
      expect(b.className).toContain('max-md:min-h-11');
    }
    // 卡住报警：没有选项区，「处理了」照旧
    const alert = rowOf('#17 子任务 A 停滞 22 分钟');
    expect(within(alert).queryByTestId('decision-picker')).toBeNull();
    expect(within(alert).getByRole('button', { name: '处理了' })).toBeTruthy();
    expect(within(alert).getByText('最后一步在等 ssh 连备份机；调度员建议重试。')).toBeTruthy();
  });

  test('键盘：选项是原生按钮（Enter/Space 可点、Tab 可到），效果说明挂在按钮的描述上', async () => {
    renderApp(<NotificationsPage />, { api: createMockApi({ live: false }), route: '/notifications' });
    await screen.findByText(RELEASE);
    const option = within(rowOf(RELEASE)).getByRole('button', { name: '今晚再发' });
    expect(option.tagName).toBe('BUTTON');
    expect(option.getAttribute('type')).toBe('button');
    const describedBy = option.getAttribute('aria-describedby') ?? '';
    expect(document.getElementById(describedBy)?.textContent).toContain('等晚上没人用的时候发');
  });

  test('上次选了没做成：卡上红框写「没做成」和原因、标出上次选的，还在待处理里，能再选', async () => {
    const api = createMockApi({ live: false });
    const answer = vi.spyOn(api, 'answerNotification');
    renderApp(<NotificationsPage />, { api, route: '/notifications' });
    await screen.findByText(APP);
    const row = rowOf(APP);
    const result = within(row).getByTestId('decision-answer');
    expect(result.getAttribute('data-result')).toBe('failed');
    expect(result.textContent).toContain('没做成：');
    expect(result.textContent).toContain('我装好了，再查一次');
    expect(within(row).getByTestId('decision-result').textContent).toContain(
      '「干活的」机器人 还没装到 acme/fluxwatch',
    );
    expect(within(row).getByText('上次选的')).toBeTruthy();
    // 再选一次：假数据没接 GitHub，照实说没查成，红色提示，卡还在
    fireEvent.click(within(row).getByRole('button', { name: '我装好了，再查一次' }));
    await waitFor(() => expect(answer).toHaveBeenCalledExactlyOnceWith('n-11', { optionId: 'recheck' }));
    await waitFor(() =>
      expect(toast.error).toHaveBeenCalledWith('没做成：我装好了，再查一次', {
        description: '假数据：没接 GitHub，acme/fluxwatch 的 GitHub App 没查成',
      }),
    );
    expect(screen.getByText(APP)).toBeTruthy();
  });

  test('删掉工作树交给引擎：卡上写「交给引擎了」，选项先收起，点「改主意」再摆出来', async () => {
    const api = createMockApi({ live: false });
    renderApp(<NotificationsPage />, { api, route: '/notifications' });
    await screen.findByText(TREE);
    fireEvent.click(within(rowOf(TREE)).getByRole('button', { name: '删掉' }));
    await waitFor(() =>
      expect(within(rowOf(TREE)).getByTestId('decision-answer').getAttribute('data-result')).toBe('queued'),
    );
    expect(toast.info).toHaveBeenCalledWith('交给引擎了：删掉', {
      description: expect.stringContaining('下一轮每小时对账删掉这棵树'),
    });
    expect(within(rowOf(TREE)).queryByTestId('decision-picker')).toBeNull();
    fireEvent.click(within(rowOf(TREE)).getByRole('button', { name: '改主意' }));
    expect(within(rowOf(TREE)).getByTestId('decision-picker')).toBeTruthy();
  });

  test('选了要留着的项：卡上写「照做了」，不再写推荐；仍是「等你拍板」，还能再拍', async () => {
    const api = createMockApi({ live: false });
    const answer = vi.spyOn(api, 'answerNotification');
    renderApp(<NotificationsPage />, { api, route: '/notifications' });
    await screen.findByText(RELEASE);
    fireEvent.click(within(rowOf(RELEASE)).getByRole('button', { name: '先不发' }));
    await waitFor(() => expect(answer).toHaveBeenCalledExactlyOnceWith('n-1', { optionId: 'hold' }));
    await waitFor(() =>
      expect(within(rowOf(RELEASE)).getByTestId('decision-answer').textContent).toContain('我选了：先不发'),
    );
    expect(within(rowOf(RELEASE)).getByTestId('decision-answer').getAttribute('data-result')).toBe('done');
    expect(within(rowOf(RELEASE)).queryByTestId('decision-hint')).toBeNull();
    expect(within(rowOf(RELEASE)).getByRole('button', { name: '发布' })).toBeTruthy();
  });

  test('照做了：弹「照做了」并写结果', async () => {
    const api = createMockApi({ live: false });
    vi.spyOn(api, 'answerNotification').mockResolvedValueOnce({
      ok: true,
      answer: {
        optionId: 'release',
        text: '发布',
        at: '2026-10-12T00:00:00.000Z',
        by: 'u-me',
        execution: { ok: true, text: '已转给指挥官', at: '2026-10-12T00:00:00.000Z' },
      },
      handoff: { progress: { ok: true, url: 'https://github.com/o/r/issues/1055#c1' } },
    } as Awaited<ReturnType<typeof api.answerNotification>>);
    renderApp(<NotificationsPage />, { api, route: '/notifications' });
    await screen.findByText(RELEASE);
    fireEvent.click(within(rowOf(RELEASE)).getByRole('button', { name: '发布' }));
    await waitFor(() =>
      expect(toast.success).toHaveBeenCalledWith('照做了：发布', { description: '已转给指挥官' }),
    );
    expect(toast.error).not.toHaveBeenCalled();
  });

  test('自己写的草稿：没做成、再答时还在', async () => {
    renderApp(<NotificationsPage />, { api: createMockApi({ live: false }), route: '/notifications' });
    await screen.findByText(OLD);
    fireEvent.change(within(rowOf(OLD)).getByRole('textbox', { name: '自己写一句' }), {
      target: { value: '发新消息' },
    });
    expect((within(rowOf(OLD)).getByRole('textbox', { name: '自己写一句' }) as HTMLInputElement).value).toBe(
      '发新消息',
    );
  });

  test('已处理的「要你拍」：没有选项区，一行写「选了：…」和结果，正文照旧', async () => {
    const api = createMockApi({ live: false });
    renderApp(<NotificationsPage />, { api, route: '/notifications' });
    await screen.findByText(RELEASE);
    fireEvent.click(within(rowOf(RELEASE)).getByRole('button', { name: '今晚再发' }));
    await waitFor(() => expect(screen.queryByText(RELEASE)).toBeNull());
    cleanup();
    renderApp(<NotificationsPage />, { api, route: '/notifications?status=all' });
    await screen.findByText(RELEASE);
    const row = rowOf(RELEASE);
    expect(within(row).queryByTestId('decision-picker')).toBeNull();
    expect(within(row).getByTestId('decision-answer').textContent).toContain('选了：今晚再发');
    expect(within(row).getByTestId('decision-answer').textContent).toContain('已转给指挥官');
    expect(within(row).getByText('对外发布到生产，能一键回滚到上一版。')).toBeTruthy();
  });
});
