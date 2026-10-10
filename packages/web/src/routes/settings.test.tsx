// @vitest-environment happy-dom
// 设置页两处难看：仓库一节仓列表和「让 AI 接活」都读失败时叠两条红横幅，合成一条；
// 留量线窗口名把字段名 7d_model 漏到界面上，改成中文。
import { cleanup, screen, waitFor, within } from '@testing-library/react';
import { afterEach, describe, expect, test } from 'vitest';
import { ApiError, type FleetApi } from '../api/client';
import { createMockApi } from '../api/mock/server';
import SettingsPage from '../routes/settings';
import { renderApp } from '../test/harness';

afterEach(cleanup);

const boom = (message: string) => async () => {
  throw new ApiError(500, 'internal', message);
};

function reposSection(): HTMLElement {
  const el = document.getElementById('repos');
  if (!el) throw new Error('设置页缺仓库一节');
  return el;
}

describe('设置页仓库一节的读失败横幅', () => {
  test('仓列表和接活开关都读失败时只出一条红横幅，两条信息都在里面', async () => {
    const api = createMockApi({ live: false });
    api.repos = boom('仓列表后端挂了');
    api.repoDispatch = boom('接活开关后端挂了');
    renderApp(<SettingsPage />, { api: api as unknown as FleetApi, route: '/settings' });
    await waitFor(() => {
      expect(within(reposSection()).getAllByRole('alert')).toHaveLength(1);
    });
    const alert = within(reposSection()).getByRole('alert');
    const text = alert.textContent ?? '';
    expect(text).toContain('仓列表没读成：仓列表后端挂了');
    expect(text).toContain('「让 AI 接活」开关没读成：接活开关后端挂了');
    expect(within(alert).getByRole('button', { name: '重试' })).toBeTruthy();
  });

  test('两条失败原因一样时仍然只出一条，两边的名字都在、原因不重复', async () => {
    const api = createMockApi({ live: false });
    api.repos = boom('后端出错了');
    api.repoDispatch = boom('后端出错了');
    renderApp(<SettingsPage />, { api: api as unknown as FleetApi, route: '/settings' });
    await waitFor(() => {
      expect(within(reposSection()).getAllByRole('alert')).toHaveLength(1);
    });
    const text = within(reposSection()).getByRole('alert').textContent ?? '';
    expect(text).toContain('仓列表');
    expect(text).toContain('「让 AI 接活」开关');
    expect(text).toContain('后端出错了');
    expect(text.match(/后端出错了/g)).toHaveLength(1);
  });

  test('只有仓列表读失败时只出仓列表那一条', async () => {
    const api = createMockApi({ live: false });
    api.repos = boom('仓列表后端挂了');
    renderApp(<SettingsPage />, { api: api as unknown as FleetApi, route: '/settings' });
    await waitFor(() => {
      expect(within(reposSection()).getAllByRole('alert')).toHaveLength(1);
    });
    const text = within(reposSection()).getByRole('alert').textContent ?? '';
    expect(text).toContain('仓列表没读成：仓列表后端挂了');
    expect(text).not.toContain('让 AI 接活');
  });

  test('只有接活开关读失败时只出接活开关那一条', async () => {
    const api = createMockApi({ live: false });
    api.repoDispatch = boom('接活开关后端挂了');
    renderApp(<SettingsPage />, { api: api as unknown as FleetApi, route: '/settings' });
    await waitFor(() => {
      expect(within(reposSection()).getAllByRole('alert')).toHaveLength(1);
    });
    const text = within(reposSection()).getByRole('alert').textContent ?? '';
    expect(text).toContain('「让 AI 接活」开关没读成：接活开关后端挂了');
    expect(text).not.toContain('仓列表没读成');
  });
});

describe('设置页留量线的窗口名', () => {
  test('7d_model 显示中文名，有组名带组名，其它窗口名不变', async () => {
    renderApp(<SettingsPage />, { route: '/settings' });
    const source = await screen.findByTestId('reserve-source');
    const form = source.closest('form');
    if (!form) throw new Error('留量线没有表单');
    await waitFor(() => {
      expect(form.textContent).toContain('单模型周额度');
    });
    expect(form.textContent).not.toContain('7d_model');
    expect(form.textContent).toContain('单模型周额度（opus）');
    expect(form.textContent).toContain('单模型周额度（fable）');
    expect(within(form).getAllByText('5 小时额度').length).toBeGreaterThan(0);
    expect(within(form).getAllByText('周额度').length).toBeGreaterThan(0);
    expect(within(form).getAllByText('月额度').length).toBeGreaterThan(0);
    expect(within(form).getAllByText('账期额度').length).toBeGreaterThan(0);
  });
});

describe('设置页主题色卡的英文名', () => {
  test('Graphite、Tokyo Night 不带省略号截断', async () => {
    renderApp(<SettingsPage />, { route: '/settings' });
    const tokyo = await screen.findByText('Tokyo Night');
    const graphite = screen.getByText('Graphite');
    for (const el of [tokyo, graphite]) {
      expect(el.className.split(/\s+/)).not.toContain('truncate');
      expect(el.className.split(/\s+/)).not.toContain('text-ellipsis');
    }
  });
});

describe('设置页谁改的、额度窗名、仓名悬停', () => {
  test('谁改的显示人名、other 显示其他窗口、仓名带悬停全名', async () => {
    const api = createMockApi({ live: false });
    const me = (await api.me()).user;
    const before = (await api.settings()).settings.find((s) => s.key === 'engine.quotaReserve');
    if (!before) throw new Error('假数据缺留量线');
    // 留量线里写上 other，界面上要出「其他窗口」；同时由自己改过，谁改的应是「我」。
    await api.updateSetting('engine.quotaReserve', {
      value: { 'claude-a': { other: 0.5 } },
      version: before.version,
    });
    // 别人改过的「同时跑的会话上限」假数据是 u-zhou / 老周：要显示人名，不露编号。
    renderApp(<SettingsPage />, { api: api as unknown as FleetApi, route: '/settings' });

    const concurrent = await screen.findByText('同时跑的会话上限');
    const concurrentCard = concurrent.closest('form');
    if (!concurrentCard) throw new Error('同时跑的会话上限没有表单');
    await waitFor(() => {
      expect(concurrentCard.textContent).toContain('老周');
      expect(concurrentCard.textContent).not.toContain('u-zhou');
    });

    const reserve = await screen.findByTestId('reserve-source');
    const reserveForm = reserve.closest('form');
    if (!reserveForm) throw new Error('留量线没有表单');
    await waitFor(() => {
      expect(reserveForm.textContent).toContain('其他窗口');
      expect(reserveForm.textContent).not.toMatch(/额度窗\s*other|\bother\b/);
      expect(reserveForm.textContent).toContain('我');
    });
    // 是自己改的：写「我」，不露自己的用户编号。
    expect(reserveForm.textContent).not.toContain(me.id);

    const canary = await screen.findByText('acme/orbit-canary');
    expect(canary.getAttribute('title')).toBe('acme/orbit-canary');
    expect(canary.className.split(/\s+/)).toContain('truncate');
  });

  test('查不到人名时缩短 uuid，悬停给全文', async () => {
    const api = createMockApi({ live: false });
    const unknown = 'aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee';
    const list = await api.settings();
    api.settings = async () => ({
      settings: list.settings.map((s) =>
        s.key === 'sessions.maxConcurrent' ? { ...s, updatedBy: unknown } : s,
      ),
    });
    renderApp(<SettingsPage />, { api: api as unknown as FleetApi, route: '/settings' });
    const concurrent = await screen.findByText('同时跑的会话上限');
    const card = concurrent.closest('form');
    if (!card) throw new Error('同时跑的会话上限没有表单');
    await waitFor(() => {
      expect(card.textContent).toContain('aaaaaaaa…');
      expect(card.textContent).not.toContain(unknown);
    });
    const short = within(card).getByTitle(unknown);
    expect(short.textContent).toBe('aaaaaaaa…');
  });
});
