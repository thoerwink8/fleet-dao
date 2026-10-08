// @vitest-environment happy-dom
// 用途里加 / 移模型、选档位，目录按厂家、渠道、状态筛并按变体折叠，没有名册的渠道手工登记（#1380）。
import type { Route } from '@fleet-dao/shared';
import { cleanup, fireEvent, screen, waitFor, within } from '@testing-library/react';
import { afterEach, describe, expect, test, vi } from 'vitest';
import { ApiError } from '../api/client';
import { createMockApi, type MockApi } from '../api/mock/server';
import type { RoutingLayerModel, RoutingLayerRoute, RoutingLayers } from '../api/types';
import RoutingPage from '../routes/routing';
import { renderApp } from './harness';

afterEach(() => {
  cleanup();
});

const fact = (verdict: 'live' | 'dead' | 'unknown', reason: string) => ({ verdict, reason });

function layerRoute(id: string, enabled: boolean): RoutingLayerRoute {
  return {
    routeId: id,
    channelId: 'ch-claude',
    channelName: 'Claude 订阅',
    poolId: 'claude-a',
    hostId: 'claude-code',
    enabled,
    verdict: 'live',
    connect: fact('live', '探针探通了'),
    quota: fact('live', '额度读数新、窗口有余'),
    ban: fact('live', '没有禁令、开关开着'),
    exhausted: [],
    inFlight: 0,
    reserved: 0,
    maxConcurrency: 2,
  };
}

/** n 个模型、每个一条路由；每第三个开着。编号互不相像，不会被收成变体组。 */
function manyModels(n: number): RoutingLayerModel[] {
  return Array.from({ length: n }, (_, i) => {
    const pad = String(i).padStart(3, '0');
    return {
      modelId: `m-${pad}`,
      displayName: `Model ${pad}`,
      family: 'claude',
      verdict: 'live' as const,
      routes: [layerRoute(`r-${pad}`, i % 3 === 0)],
    };
  });
}

function withModels(n: number): MockApi {
  const layers: RoutingLayers = {
    asOf: new Date().toISOString(),
    purposes: [{ purpose: 'execute', version: 0, verdict: 'live', problems: [], models: manyModels(n) }],
  };
  const api = createMockApi({ live: false });
  return Object.assign(api, { routingLayers: async () => layers });
}

const catalogIds = () =>
  Array.from(document.querySelectorAll('li[data-catalog]')).map((el) => el.getAttribute('data-catalog'));

describe('用途：添加、移出、档位', () => {
  test('添加模型：选择器只列还没排进这个用途的，搜得到；选定后调用 addPurposeModel，行出现在用途里', async () => {
    const { api } = renderApp(<RoutingPage />, { route: '/routing?purpose=execute' });
    await screen.findByRole('navigation', { name: '用途' });
    expect(document.querySelector('li[data-model="sonnet-5"]')).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: '添加模型' }));
    const dialog = await screen.findByRole('dialog');
    const fable = await within(dialog).findByRole('button', { name: '把 Fable 5.1 加进用途' });
    expect(within(dialog).queryByRole('button', { name: '把 Opus 5.5 加进用途' })).toBeNull();
    await waitFor(() => expect((fable as HTMLButtonElement).disabled).toBe(false));
    fireEvent.change(within(dialog).getByRole('searchbox', { name: '搜索要添加的模型' }), {
      target: { value: 'sonnet' },
    });
    expect(within(dialog).queryByRole('button', { name: '把 Fable 5.1 加进用途' })).toBeNull();
    fireEvent.click(within(dialog).getByRole('button', { name: '把 Sonnet 5 加进用途' }));
    await waitFor(() => expect(document.querySelector('li[data-model="sonnet-5"]')).toBeTruthy());
    expect(api.state().purposes.execute).toEqual([
      'opus-5.5',
      'kimi-k3',
      'cursor-auto',
      'opus-5',
      'sonnet-5',
    ]);
    expect(screen.queryByRole('dialog')).toBeNull();
  });

  test('移出用途要先确认，确认后调用 removePurposeModel，这一行没了', async () => {
    renderApp(<RoutingPage />, { route: '/routing?purpose=execute' });
    await screen.findByRole('navigation', { name: '用途' });
    fireEvent.click(screen.getByRole('button', { name: '把 Kimi k3 移出用途' }));
    const dialog = await screen.findByRole('alertdialog');
    expect(dialog.textContent).toContain('Kimi k3');
    fireEvent.click(within(dialog).getByRole('button', { name: '先不' }));
    expect(document.querySelector('li[data-model="kimi-k3"]')).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: '把 Kimi k3 移出用途' }));
    fireEvent.click(within(await screen.findByRole('alertdialog')).getByRole('button', { name: '移出' }));
    await waitFor(() => expect(document.querySelector('li[data-model="kimi-k3"]')).toBeNull());
  });

  test('档位下拉只列这个模型认的档，选定后调用 setPurposeModelEffort', async () => {
    const execute = renderApp(<RoutingPage />, { route: '/routing?purpose=execute' });
    await screen.findByRole('navigation', { name: '用途' });
    const cursor = screen.getByRole('combobox', { name: 'Cursor Auto 的档位' }) as HTMLSelectElement;
    expect(
      within(cursor)
        .getAllByRole('option')
        .map((o) => o.textContent),
    ).toEqual(['不另配']);
    expect(cursor.disabled).toBe(true);
    expect(cursor.closest('li')?.textContent).toContain('不带方括号');
    execute.unmount();
    const verify = renderApp(<RoutingPage />, { route: '/routing?purpose=verify' });
    const setEffort = vi.spyOn(verify.api, 'setPurposeModelEffort');
    await screen.findByRole('navigation', { name: '用途' });
    const grok = screen.getByRole('combobox', { name: 'Grok 4.7 的档位' });
    const grokOptions = within(grok).getAllByRole('option');
    expect(grokOptions.map((o) => o.textContent)).toEqual(['不另配', '低', '中', '高', '很高']);
    expect(grokOptions.map((o) => (o as HTMLOptionElement).value)).toEqual([
      '',
      'low',
      'medium',
      'high',
      'xhigh',
    ]);
    expect((grok as HTMLSelectElement).disabled).toBe(false);
    fireEvent.change(grok, { target: { value: 'high' } });
    await waitFor(() =>
      expect(setEffort).toHaveBeenCalledWith('verify', 'grok-4.7', { effort: 'high', version: 0 }),
    );
    await waitFor(() =>
      expect((screen.getByRole('combobox', { name: 'Grok 4.7 的档位' }) as HTMLSelectElement).value).toBe(
        'high',
      ),
    );
  });
});

describe('模型目录：厂家、渠道、状态、变体', () => {
  test('按厂家、按渠道筛；锁住、已下架有标记，Fable 仍只标仅创始人可开', async () => {
    renderApp(<RoutingPage />, { route: '/routing?tab=models' });
    await screen.findByRole('list', { name: '目录里的模型' });
    fireEvent.change(screen.getByRole('combobox', { name: '按厂家筛选' }), { target: { value: 'grok' } });
    await waitFor(() => expect(catalogIds()).toEqual(['grok-4.7']));
    fireEvent.change(screen.getByRole('combobox', { name: '按厂家筛选' }), { target: { value: '' } });
    fireEvent.change(screen.getByRole('combobox', { name: '按渠道筛选' }), {
      target: { value: 'ch-cursor' },
    });
    await waitFor(() => expect(catalogIds()).toEqual(['cursor-auto']));
    fireEvent.change(screen.getByRole('combobox', { name: '按渠道筛选' }), { target: { value: '' } });
    fireEvent.click(screen.getByRole('button', { name: '已下架' }));
    await waitFor(() => expect(catalogIds()).toEqual(['opus-5']));
    expect(document.querySelector('li[data-catalog="opus-5"]')?.textContent).toContain('已下架');
    fireEvent.click(screen.getByRole('button', { name: '已下架' }));
    fireEvent.click(screen.getByRole('button', { name: '锁住' }));
    await waitFor(() => expect(catalogIds()).toEqual(['gpt-5.6-luna', 'fable-5.1']));
    const gpt = document.querySelector('li[data-catalog="gpt-5.6-luna"]');
    const fable = document.querySelector('li[data-catalog="fable-5.1"]');
    expect(gpt?.textContent).toContain('锁住');
    expect(gpt?.textContent).toContain('GPT');
    expect(fable?.textContent).toContain('仅创始人可开');
    expect(fable?.textContent).not.toContain('锁住');
  });

  test('新发现只留路由编号以 auto: 开头的，行上标新发现', async () => {
    const api = createMockApi({ live: false });
    const routing = api.routing.bind(api);
    api.routing = async () => {
      const base = await routing();
      const sample = base.routes[0] as Route;
      return {
        ...base,
        routes: [...base.routes, { ...sample, id: 'auto:ch-claude:extra', modelId: 'sonnet-5' }],
      };
    };
    renderApp(<RoutingPage />, { route: '/routing?tab=models', api });
    await screen.findByRole('list', { name: '目录里的模型' });
    fireEvent.click(screen.getByRole('button', { name: '新发现' }));
    await waitFor(() => expect(catalogIds()).toEqual(['sonnet-5']));
    expect(document.querySelector('li[data-catalog="sonnet-5"]')?.textContent).toContain('新发现');
  });

  test('同一模型的变体收成一组，默认折着，展开才画出成员', async () => {
    const api = createMockApi({ live: false });
    const routing = api.routing.bind(api);
    api.routing = async () => {
      const base = await routing();
      const sample = base.routes.find((r) => r.modelId === 'grok-4.7') as Route;
      return {
        ...base,
        models: [...base.models, { id: 'grok-4.7-fast', family: 'grok', displayName: 'Grok 4.7 fast' }],
        routes: [...base.routes, { ...sample, id: 'r-grok-fast', modelId: 'grok-4.7-fast' }],
      };
    };
    renderApp(<RoutingPage />, { route: '/routing?tab=models', api });
    await screen.findByRole('list', { name: '目录里的模型' });
    await screen.findByRole('button', { name: '展开 Grok 4.7 的变体' });
    expect(document.querySelector('li[data-catalog="grok-4.7"]')).toBeNull();
    expect(document.querySelector('li[data-catalog="grok-4.7-fast"]')).toBeNull();
    const folded = screen.getByRole('button', { name: '展开 Grok 4.7 的变体' });
    expect(folded.textContent).toMatch(/\d+ 个已开/);
    expect(folded.querySelector('[data-variant-arrow]')?.getAttribute('data-variant-arrow')).toBe('closed');
    fireEvent.click(folded);
    await waitFor(() => expect(document.querySelector('li[data-catalog="grok-4.7-fast"]')).toBeTruthy());
    const opened = screen.getByRole('button', { name: '收起 Grok 4.7 的变体' });
    expect(opened.querySelector('[data-variant-arrow]')?.getAttribute('data-variant-arrow')).toBe('open');
    expect(opened.textContent).toMatch(/\d+ 个已开/);
    expect(document.querySelector('li[data-catalog="grok-4.7"]')).toBeTruthy();
    expect(document.querySelector('li[data-catalog-group]')).toBeTruthy();
    const fast = document.querySelector('li[data-catalog="grok-4.7-fast"]') as HTMLElement;
    expect(fast.textContent).toContain('没配进用途');
    expect((within(fast).getByRole('switch') as HTMLButtonElement).disabled).toBe(true);
  });

  test('300 行按厂家筛完，仍只画窗口里的行', async () => {
    renderApp(<RoutingPage />, { route: '/routing?tab=models', api: withModels(300) });
    await screen.findByRole('list', { name: '目录里的模型' });
    fireEvent.change(screen.getByRole('combobox', { name: '按厂家筛选' }), { target: { value: 'claude' } });
    await waitFor(() => expect(screen.getByText(/^显示 30\d \/ 共 3\d\d 个$/)).toBeTruthy());
    const drawn = document.querySelectorAll('li[data-catalog]');
    expect(drawn.length).toBeGreaterThan(5);
    expect(drawn.length).toBeLessThan(30);
    expect(document.querySelector('[data-windowed="true"]')).toBeTruthy();
    expect(drawn[0]?.getAttribute('data-catalog')).toBe('m-000');
  });
});

describe('渠道：手工登记', () => {
  test('Claude 订阅可以登记模型串，再撤掉；有名册的渠道没有这张表', async () => {
    const { api } = renderApp(<RoutingPage />, { route: '/routing?tab=channels' });
    const register = vi.spyOn(api, 'registerChannelModel');
    const revoke = vi.spyOn(api, 'revokeChannelModel');
    await screen.findByRole('list', { name: '渠道列表' });
    fireEvent.click(screen.getByRole('button', { name: '查看 中转站 的路由' }));
    expect(screen.queryByRole('form', { name: '手工登记模型串' })).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: '查看 Claude 订阅 的路由' }));
    const form = await screen.findByRole('form', { name: '手工登记模型串' });
    fireEvent.change(within(form).getByRole('textbox', { name: '模型串' }), {
      target: { value: 'claude-sonnet-x' },
    });
    fireEvent.click(within(form).getByRole('button', { name: '登记' }));
    const list = await screen.findByRole('list', { name: '已登记的模型串' });
    await waitFor(() => expect(list.textContent).toContain('claude-sonnet-x'));
    expect(screen.getByText('已登记 claude-sonnet-x')).toBeTruthy();
    expect(screen.queryByRole('textbox', { name: '要撤掉的模型串' })).toBeNull();
    expect(screen.queryByPlaceholderText('撤一条以前登记的')).toBeNull();
    expect(register).toHaveBeenCalledWith('ch-claude', { modelKey: 'claude-sonnet-x' });
    const drop = within(list).getByRole('button', { name: '撤掉 claude-sonnet-x' });
    expect(drop.className.split(/\s+/)).toEqual(expect.arrayContaining(['min-h-9', 'min-w-9']));
    fireEvent.click(drop);
    await waitFor(() => expect(screen.queryByRole('list', { name: '已登记的模型串' })).toBeNull());
    expect(revoke).toHaveBeenCalledWith('ch-claude', { modelKey: 'claude-sonnet-x' });
    expect(api.state().channels.some((c) => c.id === 'ch-claude')).toBe(true);
  });
});

describe('Fable 只有创始人能加', () => {
  test('不是创始人时，Fable 那一行的添加按钮不可用', async () => {
    const api = createMockApi({ live: false });
    const me = await api.me();
    api.me = async () => ({ ...me, user: { ...me.user, role: 'collaborator' as 'founder' } });
    renderApp(<RoutingPage />, { route: '/routing?purpose=execute', api });
    await screen.findByRole('navigation', { name: '用途' });
    fireEvent.click(screen.getByRole('button', { name: '添加模型' }));
    const dialog = await screen.findByRole('dialog');
    const fable = within(dialog).getByRole('button', { name: '把 Fable 5.1 加进用途' }) as HTMLButtonElement;
    expect(fable.disabled).toBe(true);
    expect(fable.getAttribute('title')).toContain('仅创始人可开');
  });
});

describe('写失败要露出来', () => {
  test('【故意造出的失败】添加接口报错：页面写出原因，用途里的模型还是原来那些', async () => {
    const api = createMockApi({ live: false });
    api.addPurposeModel = async () => {
      throw new ApiError(409, 'conflict', '这个用途刚被别人改过，刷新后再改');
    };
    renderApp(<RoutingPage />, { route: '/routing?purpose=execute', api });
    await screen.findByRole('navigation', { name: '用途' });
    const before = Array.from(document.querySelectorAll('li[data-model]')).map((el) =>
      el.getAttribute('data-model'),
    );
    fireEvent.click(screen.getByRole('button', { name: '添加模型' }));
    const dialog = await screen.findByRole('dialog');
    fireEvent.click(within(dialog).getByRole('button', { name: '把 Sonnet 5 加进用途' }));
    const alert = await screen.findByRole('alert');
    expect(alert.textContent).toContain('这个用途刚被别人改过，刷新后再改');
    expect(screen.queryByRole('dialog')).toBeNull();
    expect(
      Array.from(document.querySelectorAll('li[data-model]')).map((el) => el.getAttribute('data-model')),
    ).toEqual(before);
    expect(before).not.toContain('sonnet-5');
  });

  test('【故意造出的失败】登记或撤掉接口报错：写出原因，已登记的名单不动', async () => {
    const api = createMockApi({ live: false });
    const register = api.registerChannelModel.bind(api);
    const revoke = api.revokeChannelModel.bind(api);
    let failRegister = true;
    let failRevoke = false;
    api.registerChannelModel = async (channelId, body) => {
      if (failRegister) throw new ApiError(500, 'register_failed', '登记没写上');
      return register(channelId, body);
    };
    api.revokeChannelModel = async (channelId, body) => {
      if (failRevoke) throw new ApiError(500, 'revoke_failed', '撤掉没写上');
      return revoke(channelId, body);
    };
    renderApp(<RoutingPage />, { route: '/routing?tab=channels', api });
    await screen.findByRole('list', { name: '渠道列表' });
    fireEvent.click(screen.getByRole('button', { name: '查看 Claude 订阅 的路由' }));
    const form = await screen.findByRole('form', { name: '手工登记模型串' });
    fireEvent.change(within(form).getByRole('textbox', { name: '模型串' }), {
      target: { value: 'claude-sonnet-x' },
    });
    fireEvent.click(within(form).getByRole('button', { name: '登记' }));
    const failed = await screen.findByRole('alert');
    expect(failed.textContent).toContain('登记没写上');
    expect(screen.queryByText('已登记 claude-sonnet-x')).toBeNull();
    expect(screen.queryByRole('list', { name: '已登记的模型串' })).toBeNull();

    failRegister = false;
    fireEvent.click(within(form).getByRole('button', { name: '登记' }));
    const list = await screen.findByRole('list', { name: '已登记的模型串' });
    await waitFor(() => expect(list.textContent).toContain('claude-sonnet-x'));
    expect(screen.getByText('已登记 claude-sonnet-x')).toBeTruthy();

    failRevoke = true;
    fireEvent.click(within(list).getByRole('button', { name: '撤掉 claude-sonnet-x' }));
    const revokeAlert = await screen.findByRole('alert');
    expect(revokeAlert.textContent).toContain('撤掉没写上');
    expect(screen.getByRole('list', { name: '已登记的模型串' }).textContent).toContain('claude-sonnet-x');
    expect(screen.queryByText('已登记 claude-sonnet-x')).toBeTruthy();
  });
});
