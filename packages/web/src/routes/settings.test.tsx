// @vitest-environment happy-dom
// 设置页两处难看：仓库一节仓列表和「让 AI 接活」都读失败时叠两条红横幅，合成一条；
// 留量线窗口名把字段名 7d_model 漏到界面上，改成中文。
import { act, cleanup, fireEvent, screen, waitFor, within } from '@testing-library/react';
import { afterEach, describe, expect, test, vi } from 'vitest';
import { ApiError, type FleetApi, keys } from '../api/client';
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
    // 表头是各渠道的组名合在一起；每个格子的名字（读屏、悬停）带自己那个渠道的组名
    expect(within(form).getAllByLabelText(/单模型周额度（opus）/).length).toBeGreaterThan(0);
    expect(within(form).getAllByLabelText(/单模型周额度（fable）/).length).toBeGreaterThan(0);
    expect(within(form).getAllByText('5 小时额度').length).toBeGreaterThan(0);
    expect(within(form).getAllByText('周额度').length).toBeGreaterThan(0);
    expect(within(form).getAllByText('月额度').length).toBeGreaterThan(0);
    expect(within(form).getAllByText('账期额度').length).toBeGreaterThan(0);
  });
});

describe('设置页留量线：格子空着显示占位「—」（#1805；#3533 起照样稿，格子一直是输入框，不再点一下才变）', () => {
  test('未配置的格子是空输入框、占位「—」；这个渠道没有的窗写「无此窗」；填了保存仍走 updateSetting(engine.quotaReserve)', async () => {
    const api = createMockApi({ live: false });
    const spy = vi.spyOn(api, 'updateSetting');
    renderApp(<SettingsPage />, { api: api as unknown as FleetApi, route: '/settings' });
    const form = (await screen.findByTestId('reserve-source')).closest('form');
    if (!form) throw new Error('留量线没有表单');
    await waitFor(() => expect(within(form).queryAllByPlaceholderText('—').length).toBeGreaterThan(0));
    // 没有的窗和「未配置」分开写
    expect(within(form).getAllByText('无此窗').length).toBeGreaterThan(0);
    const empty = within(form)
      .getAllByPlaceholderText('—')
      .filter((i) => (i as HTMLInputElement).value === '');
    expect(empty.length).toBeGreaterThan(0);
    // 填 80、保存
    fireEvent.change(empty[0] as HTMLInputElement, { target: { value: '80' } });
    fireEvent.click(within(form).getByRole('button', { name: '保存留量线' }));
    await waitFor(() => expect(spy).toHaveBeenCalledTimes(1));
    const [key, body] = spy.mock.calls[0] ?? [];
    expect(key).toBe('engine.quotaReserve');
    expect(typeof (body as { version: number }).version).toBe('number');
    expect(JSON.stringify((body as { value: unknown }).value)).toContain('0.8');
  });
});

describe('设置页留量线：后台刷新池数据不清用户正在填的（#1871）', () => {
  async function openAndType(api: FleetApi) {
    const view = renderApp(<SettingsPage />, { api, route: '/settings' });
    const form = (await screen.findByTestId('reserve-source')).closest('form');
    if (!form) throw new Error('留量线没有表单');
    await waitFor(() => expect(within(form).queryAllByPlaceholderText('—').length).toBeGreaterThan(0));
    const boxes = within(form).queryAllByRole('textbox').length - 1;
    const empty = within(form)
      .getAllByPlaceholderText('—')
      .filter((i) => (i as HTMLInputElement).value === '');
    fireEvent.change(empty[0] as HTMLInputElement, { target: { value: '77' } });
    await waitFor(() =>
      expect(
        within(form)
          .queryAllByRole('textbox')
          .map((i) => (i as HTMLInputElement).value),
      ).toContain('77'),
    );
    return { ...view, form, boxes };
  }

  const values = (form: HTMLElement) =>
    within(form)
      .queryAllByRole('textbox')
      .map((i) => (i as HTMLInputElement).value);

  test('池数据只是用量数字变、换了新引用：输入框还在，填的数还在', async () => {
    const api = createMockApi({ live: false });
    const orig = api.pools.bind(api);
    let calls = 0;
    api.pools = async () => {
      const r = await orig();
      calls += 1;
      return {
        ...r,
        asOf: `2026-10-11T00:00:${String(calls).padStart(2, '0')}.000Z`,
        pools: r.pools.map((p) => ({ ...p, running: p.running + calls })),
      };
    };
    const { form, boxes, qc } = await openAndType(api as unknown as FleetApi);
    const seen = calls;
    await act(async () => {
      await qc.invalidateQueries({ queryKey: keys.pools });
    });
    await waitFor(() => expect(calls).toBeGreaterThan(seen));
    expect(within(form).queryAllByRole('textbox')).toHaveLength(boxes + 1);
    expect(values(form)).toContain('77');
  });

  test('池集合真变了（新增一个池）才重置草稿', async () => {
    const api = createMockApi({ live: false });
    const orig = api.pools.bind(api);
    let extra = false;
    api.pools = async () => {
      const r = await orig();
      const first = r.pools[0];
      if (!extra || !first) return r;
      return { ...r, pools: [...r.pools, { ...first, id: `${first.id}-new` }] };
    };
    const { form, qc } = await openAndType(api as unknown as FleetApi);
    extra = true;
    await act(async () => {
      await qc.invalidateQueries({ queryKey: keys.pools });
    });
    await waitFor(() => expect(values(form)).not.toContain('77'));
  });

  test('服务端版本号变了才重置草稿', async () => {
    const api = createMockApi({ live: false });
    const { form, qc } = await openAndType(api as unknown as FleetApi);
    const cur = (await api.settings()).settings.find((x) => x.key === 'engine.quotaReserve');
    if (!cur) throw new Error('假数据缺留量线');
    await api.updateSetting('engine.quotaReserve', {
      value: { 'claude-a': { other: 0.5 } },
      version: cur.version,
    });
    await act(async () => {
      await qc.invalidateQueries({ queryKey: keys.settings });
    });
    await waitFor(() => expect(values(form)).not.toContain('77'));
  });
});

describe('设置页字段行和页内导航（#1805）', () => {
  test('每节的字段是标签左、控件右的表单项；页内导航（Anchor）有六个锚点，吸在左边', async () => {
    renderApp(<SettingsPage />, { route: '/settings' });
    const concurrent = await screen.findByText('同时跑的会话上限');
    const item = concurrent.closest('[data-layout]');
    expect(item?.getAttribute('data-layout')).toBe('horizontal');
    const nav = screen.getByRole('navigation', { name: '本页目录' });
    expect(nav.className).toContain('lg:sticky');
    const hrefs = [...nav.querySelectorAll('a')].map((a) => a.getAttribute('href'));
    expect(hrefs).toEqual(['#repos', '#run', '#reserve', '#notify', '#account', '#about']);
    for (const h of hrefs) expect(document.getElementById((h ?? '').slice(1))).toBeTruthy();
  });
});

describe('设置页外观只剩减少动效（#3509：主题只有一套，亮暗跟随系统；#3533 起并进「关于」那一节）', () => {
  test('外观没有主题色、深浅、密度，只有「减少动效」开关', async () => {
    renderApp(<SettingsPage />, { route: '/settings' });
    const look = await waitFor(() => {
      const el = document.getElementById('about');
      expect(el).toBeTruthy();
      return el as HTMLElement;
    });
    expect(within(look).getByRole('switch', { name: '减少动效' })).toBeTruthy();
    expect(within(look).queryByRole('radiogroup')).toBeNull();
    expect(within(look).queryByText('Tokyo Night')).toBeNull();
    expect(within(look).queryByText('密度')).toBeNull();
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

describe('设置页保存按钮：能存和不能存分得清（#1904；#3533 起设置页的保存键是次按钮，不和页面的主操作抢）', () => {
  test('没改动时禁用（data-state=disabled、灰底）；填了新值才变成能点（data-state=ready）', async () => {
    const api = createMockApi({ live: false });
    renderApp(<SettingsPage />, { api: api as unknown as FleetApi, route: '/settings' });
    const input = (await screen.findByPlaceholderText('没设')) as HTMLInputElement;
    const form = input.closest('form') as HTMLElement;
    const save = within(form).getByRole('button', { name: '保存' }) as HTMLButtonElement;
    expect(save.disabled).toBe(true);
    expect(save.getAttribute('data-state')).toBe('disabled');
    expect(save.className).toContain('bg-muted');
    expect(save.className).not.toContain('bg-brand');
    fireEvent.change(input, { target: { value: '9' } });
    await waitFor(() => expect(save.disabled).toBe(false));
    expect(save.getAttribute('data-state')).toBe('ready');
    expect(save.className).not.toContain('bg-brand');
    expect(save.className).not.toContain('bg-muted');
  });

  test('留量线一块和别的区块一样用 Section 标题（text-heading），不再是自己写的小字标题', async () => {
    const api = createMockApi({ live: false });
    renderApp(<SettingsPage />, { api: api as unknown as FleetApi, route: '/settings' });
    const form = (await screen.findByTestId('reserve-source')).closest('form') as HTMLElement;
    // 标题在表单里（e2e 按「带这个标题的表单」找留量线）
    const title = form.querySelector('section > header h2');
    expect(title?.textContent).toBe('各渠道的额度留量线');
    expect(title?.className).toContain('text-heading');
  });
});
