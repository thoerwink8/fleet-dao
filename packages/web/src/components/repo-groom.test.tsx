// @vitest-environment happy-dom
// 设置页「仓库」一节：每个仓的「指挥官整理待办」（母单 #1335 第 4 片）。
// 次数和最近结果来自 GET；按钮二次确认后 POST。409/429/503 把后端的中文原因露出来，不吞。
import { cleanup, fireEvent, screen, waitFor, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';

const { toast } = vi.hoisted(() => ({
  toast: Object.assign(vi.fn(), { success: vi.fn(), error: vi.fn(), info: vi.fn(), warning: vi.fn() }),
}));
vi.mock('sonner', () => ({ toast, Toaster: () => null }));

import { ApiError } from '../api/client';
import { createMockApi, type MockApi } from '../api/mock/server';
import { formatDateTime } from '../lib/format';
import SettingsPage from '../routes/settings';
import { renderApp } from '../test/harness';

beforeEach(() => {
  for (const f of [toast.success, toast.error, toast.info, toast.warning]) f.mockClear();
});
afterEach(cleanup);

const ORBIT = 'r-orbit';

function groomButton(panel: HTMLElement): HTMLButtonElement {
  const btn = within(panel).getByRole('button', { name: /让指挥官整理/ });
  if (!(btn instanceof HTMLButtonElement)) throw new Error('整理按钮不是 button');
  return btn;
}

/** 行尾只有一句状态：整理记录和长说明点「详情」才展开（#1805）。 */
function openDetails(panel: HTMLElement) {
  const toggle = within(panel).getByRole('button', { name: /的整理详情$/ });
  if (toggle.getAttribute('aria-expanded') !== 'true') fireEvent.click(toggle);
}

async function confirm(panel: HTMLElement, reason?: string) {
  fireEvent.click(groomButton(panel));
  const dialog = await screen.findByRole('alertdialog');
  if (reason !== undefined) {
    fireEvent.change(within(dialog).getByLabelText('原因（可以不填）'), { target: { value: reason } });
  }
  fireEvent.click(within(dialog).getByRole('button', { name: '确认整理' }));
}

/** 假后端默认总开关关着：点整理会被拒。成功那条先打开。 */
async function engineOn(api: MockApi) {
  const version = (await api.settings()).settings.find((s) => s.key === 'engine.master')?.version ?? 0;
  await api.updateSetting('engine.master', { value: true, version });
}

describe('设置页：指挥官整理待办', () => {
  test('今日剩余、最近一次做成的结果（单号链到 GitHub）和更早一次没做成都在', async () => {
    const api = createMockApi({ live: false });
    const status = await api.groomStatus(ORBIT);
    const latest = status.recent[0];
    if (!latest?.finishedAt || !latest.result) throw new Error('假数据里最近一次该是做成的');
    renderApp(<SettingsPage />, { api, route: '/settings' });
    const panel = await screen.findByTestId(`groom-${ORBIT}`);
    await waitFor(() =>
      expect(panel.textContent).toContain(`今日剩余 ${status.quota.remaining}/${status.quota.max}`),
    );
    expect(status.quota).toMatchObject({ remaining: 1, max: 3 });
    // 收起时行尾只有一句状态
    expect(panel.textContent).toContain('做成了');
    expect(panel.textContent).not.toContain('开了 1 张');
    openDetails(panel);
    expect(panel.textContent).toContain(formatDateTime(latest.finishedAt));
    expect(panel.textContent).toContain('开了 1 张');
    expect(panel.textContent).toContain('补了 2 张');
    expect(panel.textContent).toContain('建议关 1 张');
    expect(panel.textContent).toContain('贴要人拍 1 张');
    const link = within(panel).getByRole('link', { name: '#1402' });
    expect(link.getAttribute('href')).toBe('https://github.com/acme/orbit/issues/1402');
    expect(link.getAttribute('target')).toBe('_blank');
    expect(within(panel).getByRole('link', { name: '#1338' }).getAttribute('href')).toBe(
      'https://github.com/acme/orbit/issues/1338',
    );
    expect(within(panel).getByRole('link', { name: '#900' }).getAttribute('href')).toBe(
      'https://github.com/acme/orbit/issues/900',
    );
    expect(within(panel).getByRole('link', { name: '#901' }).getAttribute('href')).toBe(
      'https://github.com/acme/orbit/issues/901',
    );
    expect(panel.textContent).toContain('没做成');
    expect(panel.textContent).toContain('选不到路由（用途 groom）：没有能用的路由');
    expect(panel.textContent).not.toContain('整理中');
  });

  test('关着的说明是新规则：开着自己挑单，关着只有本机点名派', async () => {
    const api = createMockApi({ live: false });
    renderApp(<SettingsPage />, { api, route: '/settings' });
    const panel = await screen.findByTestId(`groom-${ORBIT}`);
    // 长说明已从仓库一节常显挪进「指挥官整理待办」折叠块：点「详情」再点「展开」才有新规则全文。
    openDetails(panel);
    fireEvent.click(within(panel).getByRole('button', { name: '展开' }));
    await waitFor(() => {
      expect(panel.textContent).toContain('引擎每 5 分钟自己按准入和排序挑单');
      expect(panel.textContent).toContain('老单要指挥官整理过');
      expect(panel.textContent).toContain('没单可挑会自动叫指挥官整理');
    });
    const off = screen.getByTestId('dispatch-r-canary');
    expect(off.textContent).toContain('fleet-api dispatch-issue');
    expect(off.textContent).not.toContain('只收单、不派活');
  });

  test('点「让指挥官整理」先确认、可填原因；成功后这一块变成整理中、按钮置灰', async () => {
    const api = createMockApi({ live: false });
    await engineOn(api);
    const groomNow = vi.spyOn(api, 'groomNow');
    renderApp(<SettingsPage />, { api, route: '/settings' });
    const panel = await screen.findByTestId(`groom-${ORBIT}`);
    await waitFor(() => expect(groomButton(panel).disabled).toBe(false));

    fireEvent.click(groomButton(panel));
    fireEvent.click(within(await screen.findByRole('alertdialog')).getByRole('button', { name: '先不' }));
    expect(groomNow).not.toHaveBeenCalled();
    expect(screen.queryByRole('alertdialog')).toBeNull();

    await confirm(panel, '老单堆了');
    await waitFor(() => expect(groomNow).toHaveBeenCalledExactlyOnceWith(ORBIT, { reason: '老单堆了' }));
    await waitFor(() => expect(panel.textContent).toContain('整理中'));
    expect(groomButton(panel).disabled).toBe(true);
    expect(toast.success).toHaveBeenCalled();
    expect(toast.error).not.toHaveBeenCalled();
    // 锁是全局的：别的仓这一块也变成整理中
    expect((await screen.findByTestId('groom-r-canary')).textContent).toContain('整理中');
  });

  test('原因留空就不带 reason', async () => {
    const api = createMockApi({ live: false });
    await engineOn(api);
    const groomNow = vi.spyOn(api, 'groomNow');
    renderApp(<SettingsPage />, { api, route: '/settings' });
    const panel = await screen.findByTestId(`groom-${ORBIT}`);
    await waitFor(() => expect(groomButton(panel).disabled).toBe(false));
    await confirm(panel, '   ');
    await waitFor(() => expect(groomNow).toHaveBeenCalledExactlyOnceWith(ORBIT, {}));
  });

  test.each([
    [409, 'engine_off', '整理不了：这台机器的引擎按配置没开，没人接这次整理'],
    [
      409,
      'groom_busy',
      '已经有一次整理在做（acme/orbit，2026-10-08T01:00:00.000Z）：同一时刻只做一个，等它做完',
    ],
    [
      429,
      'groom_daily_cap',
      'acme/orbit 最近 24 小时已经整理了 3 次（每天最多 3 次）：等最早那次滚出 24 小时',
    ],
    [503, 'groom_unreadable', '整理待办的记录没读成：库连不上'],
  ])('%s %s：把后端的原因显示出来，不报成功', async (status, code, message) => {
    const api = createMockApi({ live: false });
    // 总开关关着时按钮提前置灰，点不到确认；这条测的是后端拒了以后的红字，先把总开关打开。
    await engineOn(api);
    vi.spyOn(api, 'groomNow').mockRejectedValueOnce(new ApiError(status, code, message));
    renderApp(<SettingsPage />, { api, route: '/settings' });
    const panel = await screen.findByTestId(`groom-${ORBIT}`);
    await waitFor(() => expect(groomButton(panel).disabled).toBe(false));
    await confirm(panel);
    const alert = await within(panel).findByRole('alert');
    expect(alert.textContent).toContain(message);
    expect(toast.error).toHaveBeenCalledWith('没叫成', { description: message });
    expect(toast.success).not.toHaveBeenCalled();
    expect(panel.textContent).not.toContain('整理中');
  });

  test('已经有一次在排队或在做：写「整理中」，按钮置灰，点不开确认', async () => {
    const api = createMockApi({ live: false });
    const inner = api.groomStatus.bind(api);
    api.groomStatus = async (repoId) => ({ ...(await inner(repoId)), busy: true });
    renderApp(<SettingsPage />, { api, route: '/settings' });
    const panel = await screen.findByTestId(`groom-${ORBIT}`);
    await waitFor(() => expect(panel.textContent).toContain('整理中'));
    expect(groomButton(panel).disabled).toBe(true);
    fireEvent.click(groomButton(panel));
    expect(screen.queryByRole('alertdialog')).toBeNull();
  });

  test('引擎总开关关着：「让指挥官整理」置灰，旁边写明不整理', async () => {
    const api = createMockApi({ live: false });
    renderApp(<SettingsPage />, { api, route: '/settings' });
    const panel = await screen.findByTestId(`groom-${ORBIT}`);
    await waitFor(() => {
      expect(panel.textContent).toContain('今日剩余');
      expect(panel.textContent).toContain('引擎总开关关着，不整理');
      expect(groomButton(panel).disabled).toBe(true);
    });
    fireEvent.click(groomButton(panel));
    expect(screen.queryByRole('alertdialog')).toBeNull();
  });

  test('引擎总开关开着：「让指挥官整理」不因此禁用', async () => {
    const api = createMockApi({ live: false });
    await engineOn(api);
    renderApp(<SettingsPage />, { api, route: '/settings' });
    const panel = await screen.findByTestId(`groom-${ORBIT}`);
    await waitFor(() => expect(groomButton(panel).disabled).toBe(false));
    expect(panel.textContent).not.toContain('引擎总开关关着，不整理');
  });

  test('总开关读不到：不把「让指挥官整理」置灰', async () => {
    const api = createMockApi({ live: false });
    api.settings = async () => {
      throw new ApiError(500, 'internal', '库连不上（测试故意造的）');
    };
    renderApp(<SettingsPage />, { api, route: '/settings' });
    const panel = await screen.findByTestId(`groom-${ORBIT}`);
    await waitFor(() => expect(groomButton(panel).disabled).toBe(false));
    expect(panel.textContent).not.toContain('引擎总开关关着，不整理');
  });

  test('记录没读成：写明原因，不画成「还没整理过」', async () => {
    const api = createMockApi({ live: false });
    api.groomStatus = async () => {
      throw new ApiError(503, 'groom_unreadable', '整理待办的记录没读成：库连不上');
    };
    renderApp(<SettingsPage />, { api, route: '/settings' });
    const panel = await screen.findByTestId(`groom-${ORBIT}`);
    const alert = await within(panel).findByRole('alert');
    expect(alert.textContent).toContain('指挥官整理待办没读成');
    expect(alert.textContent).toContain('整理待办的记录没读成：库连不上');
    expect(panel.textContent).not.toContain('还没整理过');
    expect(panel.textContent).not.toContain('今日剩余');
  });

  test('长说明默认折叠', async () => {
    const api = createMockApi({ live: false });
    renderApp(<SettingsPage />, { api, route: '/settings' });
    const panel = await screen.findByTestId(`groom-${ORBIT}`);
    // 收起时：只有行尾一句状态，说明正文和「展开」都不在
    expect(within(panel).queryByRole('button', { name: '展开' })).toBeNull();
    expect(panel.textContent).not.toContain('老单要整理过才能进队');
    expect(
      within(panel)
        .getByRole('button', { name: /的整理详情$/ })
        .getAttribute('aria-expanded'),
    ).toBe('false');
    openDetails(panel);
    const toggle = await within(panel).findByRole('button', { name: '展开' });
    expect(toggle.getAttribute('aria-expanded')).toBe('false');
    // 折叠时：一行摘要在，长说明正文不露；仓库一节也不再常显那段长文。
    expect(panel.textContent).toContain('老单要整理过才能进队');
    expect(panel.textContent).not.toContain('没单可挑会自动叫指挥官整理');
    const section = document.getElementById('repos');
    expect(section?.textContent).not.toContain('引擎每 5 分钟自己按准入和排序挑单');
    fireEvent.click(toggle);
    await waitFor(() => {
      expect(toggle.getAttribute('aria-expanded')).toBe('true');
      expect(panel.textContent).toContain('没单可挑会自动叫指挥官整理');
      expect(panel.textContent).toContain('引擎每 5 分钟自己按准入和排序挑单');
    });
    expect(within(panel).getByRole('button', { name: '收起' })).toBeTruthy();
  });
});
