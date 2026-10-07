// @vitest-environment happy-dom
// 页面上会改服务端状态的操作：设置（保存数字、免打扰时段）、通知（处理了）、
// 退出登录。每个操作断言发出去的请求；失败时（校验不过、版本冲突、后端拒绝、断网）必须弹出后端的原因，不吞错、不冒充成功。
import { cleanup, fireEvent, screen, waitFor, within } from '@testing-library/react';
import { Route, Routes } from 'react-router';
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';

const { toast } = vi.hoisted(() => ({
  toast: Object.assign(vi.fn(), { success: vi.fn(), error: vi.fn(), info: vi.fn(), warning: vi.fn() }),
}));
vi.mock('sonner', () => ({ toast, Toaster: () => null }));

import { ApiError, type FleetApi } from '../api/client';
import { createMockApi, type MockApi } from '../api/mock/server';
import { Topbar } from '../components/shell/topbar';
import { settingLabel } from '../lib/audit';
import NotificationsPage from '../routes/notifications';
import SettingsPage from '../routes/settings';
import { renderApp } from './harness';

beforeEach(() => {
  for (const f of [toast.success, toast.error, toast.info, toast.warning]) f.mockClear();
});
afterEach(cleanup);

const formOf = (el: HTMLElement) => {
  const form = el.closest('form');
  if (!form) throw new Error('不在表单里');
  return form;
};

describe('设置：保存', () => {
  const MAX = 'sessions.maxConcurrent';
  const field = () => screen.getByLabelText(settingLabel[MAX]) as HTMLInputElement;
  const save = () => within(formOf(field())).getByRole('button', { name: '保存' });
  const versionOf = async (api: MockApi, key: string) =>
    (await api.settings()).settings.find((s) => s.key === key)?.version ?? 0;

  test('改并发上限点保存：带上改之前看到的版本号，成功提示写设置名；没改动时保存点不了', async () => {
    const api = createMockApi({ live: false });
    const update = vi.spyOn(api, 'updateSetting');
    const version = await versionOf(api, MAX);
    renderApp(<SettingsPage />, { api });
    await screen.findByLabelText(settingLabel[MAX]);
    await waitFor(() => expect(field().value).not.toBe(''));
    expect(save()).toHaveProperty('disabled', true);
    fireEvent.change(field(), { target: { value: '12' } });
    fireEvent.click(save());
    await waitFor(() => expect(toast.success).toHaveBeenCalledWith(`已保存：${settingLabel[MAX]}`));
    expect(update).toHaveBeenCalledExactlyOnceWith(MAX, { value: 12, version });
    expect(toast.error).not.toHaveBeenCalled();
  });

  test('【故意造出的失败】超出约定（上限 32）：弹「这个值不行」和原因，一个请求都不发', async () => {
    const api = createMockApi({ live: false });
    const update = vi.spyOn(api, 'updateSetting');
    renderApp(<SettingsPage />, { api });
    await waitFor(() => expect(field().value).not.toBe(''));
    fireEvent.change(field(), { target: { value: '99' } });
    fireEvent.click(save());
    expect(toast.error).toHaveBeenCalledWith('这个值不行', { description: '最多 32' });
    expect(update).not.toHaveBeenCalled();
    expect(toast.success).not.toHaveBeenCalled();
  });

  test('【故意造出的失败】别人刚改过（409 conflict）：弹「刚被别人改过，已刷新，请再改一次」和后端的话', async () => {
    const api = createMockApi({ live: false });
    vi.spyOn(api, 'updateSetting').mockRejectedValueOnce(
      new ApiError(409, 'conflict', '这项设置刚被别人改过，刷新后再改'),
    );
    renderApp(<SettingsPage />, { api });
    await waitFor(() => expect(field().value).not.toBe(''));
    fireEvent.change(field(), { target: { value: '12' } });
    fireEvent.click(save());
    await waitFor(() =>
      expect(toast.error).toHaveBeenCalledWith('这项设置刚被别人改过，已刷新，请再改一次', {
        description: '这项设置刚被别人改过，刷新后再改',
      }),
    );
    expect(toast.success).not.toHaveBeenCalled();
  });

  test.each([
    ['后端 500', new ApiError(500, 'internal', '后端出错了'), '后端出错了'],
    ['无权限 403', new ApiError(403, 'forbidden', '你没有这个权限'), '你没有这个权限'],
    [
      '断网',
      new ApiError(0, 'network', '连不上驾驶舱后端：Failed to fetch'),
      '连不上驾驶舱后端：Failed to fetch',
    ],
  ])('【故意造出的失败】%s：弹「没保存上」和原因，不弹成功', async (_name, error, text) => {
    const api = createMockApi({ live: false });
    vi.spyOn(api, 'updateSetting').mockRejectedValueOnce(error);
    renderApp(<SettingsPage />, { api });
    await waitFor(() => expect(field().value).not.toBe(''));
    fireEvent.change(field(), { target: { value: '12' } });
    fireEvent.click(save());
    await waitFor(() => expect(toast.error).toHaveBeenCalledWith('没保存上', { description: text }));
    expect(toast.success).not.toHaveBeenCalled();
  });

  test('免打扰时段：打开开关再保存，发 {start,end}；关掉再保存发 null', async () => {
    const api = createMockApi({ live: false });
    const update = vi.spyOn(api, 'updateSetting');
    renderApp(<SettingsPage />, { api });
    const sw = await screen.findByRole('switch', { name: '开免打扰时段' });
    const quiet = () => within(formOf(sw)).getByRole('button', { name: '保存' });
    const key = 'notify.quietHours';
    const wasOn = sw.getAttribute('aria-checked') === 'true';
    expect(quiet()).toHaveProperty('disabled', true);
    fireEvent.click(sw);
    fireEvent.click(quiet());
    await waitFor(() => expect(toast.success).toHaveBeenCalledTimes(1));
    const [, first] = update.mock.calls[0] ?? [];
    expect(update.mock.calls[0]?.[0]).toBe(key);
    expect(first?.value).toEqual(wasOn ? null : { start: '23:00', end: '08:00' });
  });
});

describe('通知中心：处理了', () => {
  test('点「处理了」：发 resolveNotification(那条的编号)，提示带标题；列表里这条消失', async () => {
    const api = createMockApi({ live: false });
    const resolve = vi.spyOn(api, 'resolveNotification');
    const open = (await api.notifications()).items;
    const first = open[0];
    if (!first) throw new Error('假数据里没有待处理的提醒');
    renderApp(<NotificationsPage />, { api });
    await screen.findByText(first.title);
    fireEvent.click(
      within(screen.getByText(first.title).closest('li') as HTMLElement).getByRole('button', {
        name: '处理了',
      }),
    );
    await waitFor(() => expect(toast.success).toHaveBeenCalledWith('处理了', { description: first.title }));
    expect(resolve).toHaveBeenCalledExactlyOnceWith(first.id);
    await waitFor(() => expect(screen.queryByText(first.title)).toBeNull());
  });

  test('【故意造出的失败】后端拒了（404 找不到这条）：弹「没处理成」和原因，这条仍在列表里，不弹成功', async () => {
    const api = createMockApi({ live: false });
    vi.spyOn(api, 'resolveNotification').mockRejectedValueOnce(
      new ApiError(404, 'notification_not_found', '没有这条通知'),
    );
    const first = (await api.notifications()).items[0];
    if (!first) throw new Error('假数据里没有待处理的提醒');
    renderApp(<NotificationsPage />, { api });
    await screen.findByText(first.title);
    fireEvent.click(
      within(screen.getByText(first.title).closest('li') as HTMLElement).getByRole('button', {
        name: '处理了',
      }),
    );
    await waitFor(() =>
      expect(toast.error).toHaveBeenCalledWith('没处理成', { description: '没有这条通知' }),
    );
    expect(toast.success).not.toHaveBeenCalled();
    expect(screen.getByText(first.title)).toBeTruthy();
  });

  test('已经处理过的（含已处理的列表）没有「处理了」按钮：按钮数 == 还没处理的条数', async () => {
    const api = createMockApi({ live: false });
    const all = (await api.notifications({ status: 'all' })).items;
    const unresolved = all.filter((n) => !n.resolvedAt).length;
    expect(all.length).toBeGreaterThan(unresolved); // 假数据里确有已处理的，否则这条测不出东西
    renderApp(<NotificationsPage />, { api, route: '/notifications?status=all' });
    await screen.findAllByRole('button', { name: '处理了' });
    expect(screen.getAllByRole('button', { name: '处理了' })).toHaveLength(unresolved);
  });
});

describe('通知中心：没有追问', () => {
  test('整页没有「回答」按钮、没有旧追问区块（#939：追问没有收信处，入口一个不留）', async () => {
    const api = createMockApi({ live: false });
    const { container } = renderApp(<NotificationsPage />, { api });
    await waitFor(() => expect(screen.getAllByRole('listitem').length).toBeGreaterThan(0));
    expect(screen.queryAllByRole('button', { name: /^回答/ })).toHaveLength(0);
    expect(container.querySelector('[data-legacy-asks]')).toBeNull();
  });
});

describe('退出登录', () => {
  /** 一个走真后端的外壳顶栏，旁边放一个登录页占位，看退出后落到哪。 */
  function topbar(api: FleetApi) {
    return renderApp(
      <>
        <Topbar onMenu={() => undefined} onSearch={() => undefined} />
        <Routes>
          <Route path="/login" element={<p>登录页占位</p>} />
          <Route path="*" element={null} />
        </Routes>
      </>,
      { api },
    );
  }
  const real = (over: Partial<FleetApi>): FleetApi => {
    const api = { ...createMockApi({ live: false }) } as FleetApi;
    return Object.assign(api, { source: 'http' as const }, over);
  };
  const openMenu = async () => {
    const trigger = await screen.findByRole('button', { name: '我的账号' });
    fireEvent.keyDown(trigger, { key: 'Enter' });
  };

  test('点「退出登录」：调 logout，成功后回登录页', async () => {
    const logout = vi.fn(() => Promise.resolve());
    topbar(real({ logout }));
    await openMenu();
    fireEvent.click(await screen.findByRole('menuitem', { name: /退出登录/ }));
    expect(await screen.findByText('登录页占位')).toBeTruthy();
    expect(logout).toHaveBeenCalledTimes(1);
    expect(toast.error).not.toHaveBeenCalled();
  });

  test('【故意造出的失败】退出被后端拒（500）：弹「退出没成功」和原因，不回登录页（会话其实还在）', async () => {
    const logout = vi.fn(() => Promise.reject(new ApiError(500, 'internal', '后端出错了')));
    topbar(real({ logout }));
    await openMenu();
    fireEvent.click(await screen.findByRole('menuitem', { name: /退出登录/ }));
    await waitFor(() =>
      expect(toast.error).toHaveBeenCalledWith('退出没成功', { description: '后端出错了' }),
    );
    expect(screen.queryByText('登录页占位')).toBeNull();
  });

  test('假数据模式：退出点不了、不调 logout', async () => {
    const logout = vi.fn(() => Promise.resolve());
    topbar(real({ logout, source: 'mock' }));
    await openMenu();
    const item = await screen.findByRole('menuitem', { name: /退出/ });
    expect(item.getAttribute('aria-disabled')).toBe('true');
    fireEvent.click(item);
    expect(logout).not.toHaveBeenCalled();
  });
});
