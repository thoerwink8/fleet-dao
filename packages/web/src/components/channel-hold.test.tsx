// @vitest-environment happy-dom
// 额度页渠道组头的整渠道暂停 / 放开（#2900）：一次写这个渠道下所有池的 engine.poolHolds。
// 全开只有「全部暂停」，全停只有「全部放开」，混合两个都有、各只动自己那一半；原因必填、复查日期可不填；
// 认不出的项和封号提醒原样留着；整份认不出或读不到时点不了；设置版本撞了弹重来的提示、不覆盖别人刚写的。
import { cleanup, fireEvent, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';

const { toast } = vi.hoisted(() => ({
  toast: Object.assign(vi.fn(), { success: vi.fn(), error: vi.fn(), info: vi.fn(), warning: vi.fn() }),
}));
vi.mock('sonner', () => ({ toast, Toaster: () => null }));

import { ApiError } from '../api/client';
import { createMockApi, type MockApi } from '../api/mock/server';
import { SWITCH_DECIDED_BY, SWITCH_REVOKE_WHEN } from '../lib/pool-holds';
import QuotaPage from '../routes/quota';
import { renderApp } from '../test/harness';

beforeEach(() => {
  for (const f of [toast.success, toast.error, toast.info, toast.warning]) f.mockClear();
});
afterEach(cleanup);

const KEY = 'engine.poolHolds';
const entry = (reason: string, reviewBy?: string) => ({
  reason,
  decidedBy: SWITCH_DECIDED_BY,
  revokeWhen: SWITCH_REVOKE_WHEN,
  ...(reviewBy ? { reviewBy } : {}),
});

/** 页面把库里已有的暂停原样写回时，视图补的默认负责人也跟着写回（和单个池的开关同一个写法）。 */
const kept = (e: ReturnType<typeof entry>) => ({ ...e, owner: '指挥官' });

/** 渠道 ch-claude 下有 claude-a、claude-b 两个池；ch-relay 下只有 relay。 */
const seed = async (api: MockApi, value: Record<string, unknown>) => {
  await api.updateSetting(KEY, { value, version: 0 });
};
const stored = async (api: MockApi) => (await api.settings()).settings.find((s) => s.key === KEY);
const pauseBtn = () => screen.queryByTestId('channel-pause-ch-claude') as HTMLButtonElement | null;
const resumeBtn = () => screen.queryByTestId('channel-resume-ch-claude') as HTMLButtonElement | null;
const switchOf = (poolId: string) => screen.getByRole('switch', { name: `${poolId} 的开关` });
const state = () => document.querySelector('[data-channel-controls="ch-claude"] [data-channel-hold-state]');
const body = (spy: { mock: { calls: unknown[][] } }, n = 0) =>
  spy.mock.calls[n]?.[1] as { value: Record<string, unknown>; version: number; reason?: string };

/** 渲染额度页并等暂停设置读到（渠道头的按钮从「没查成」的禁用变成可点）。 */
async function open(api: MockApi) {
  renderApp(<QuotaPage />, { api });
  await screen.findByRole('columnheader', { name: '周期美元' });
  await waitFor(() => {
    const b = pauseBtn() ?? resumeBtn();
    expect(b).toBeTruthy();
    expect((b as HTMLButtonElement).disabled).toBe(false);
  });
}

const fill = (label: string, value: string) =>
  fireEvent.change(screen.getByLabelText(label), { target: { value } });

describe('整渠道暂停：全开', () => {
  test('头上只有「全部暂停」；原因必填，复查日期可不填；写进这个渠道所有池、不碰别的渠道', async () => {
    const api = createMockApi({ live: false });
    const spy = vi.spyOn(api, 'updateSetting');
    await open(api);
    expect(pauseBtn()?.textContent).toBe('全部暂停');
    expect(resumeBtn()).toBeNull();
    expect(state()).toBeNull();

    fireEvent.click(pauseBtn() as HTMLButtonElement);
    expect(await screen.findByText(/将暂停 2 个池：claude-a、claude-b/)).toBeTruthy();
    const confirm = screen.getByRole('button', { name: '确认暂停整渠道' }) as HTMLButtonElement;
    expect(confirm.disabled).toBe(true);
    fireEvent.click(confirm);
    expect(spy).not.toHaveBeenCalled();

    fill('原因', '这个渠道先停');
    expect(confirm.disabled).toBe(false);
    fireEvent.click(confirm);
    await waitFor(() => expect(spy).toHaveBeenCalledTimes(1));
    expect(spy.mock.calls[0]?.[0]).toBe(KEY);
    expect(body(spy)).toEqual({
      value: { 'claude-a': entry('这个渠道先停'), 'claude-b': entry('这个渠道先停') },
      version: 0,
      reason: '这个渠道先停',
    });
    await waitFor(() => expect(switchOf('claude-a').getAttribute('aria-checked')).toBe('false'));
    expect(switchOf('claude-b').getAttribute('aria-checked')).toBe('false');
    expect(switchOf('relay').getAttribute('aria-checked')).toBe('true');
    expect(toast.success).toHaveBeenCalledWith('已暂停 Claude 订阅：2 个池');
    // 写完变成全停：只剩「全部放开」
    await waitFor(() => expect(resumeBtn()?.textContent).toBe('全部放开'));
    expect(pauseBtn()).toBeNull();
    expect(state()?.getAttribute('data-channel-hold-state')).toBe('paused');
  });

  test('复查日期填错点不下去；填对一起存到每个池', async () => {
    const api = createMockApi({ live: false });
    const spy = vi.spyOn(api, 'updateSetting');
    await open(api);
    fireEvent.click(pauseBtn() as HTMLButtonElement);
    fill('原因', '先停');
    fill('复查日期（可不填）', '2026-13-45');
    const confirm = (await screen.findByRole('button', { name: '确认暂停整渠道' })) as HTMLButtonElement;
    expect(confirm.disabled).toBe(true);
    fill('复查日期（可不填）', '2026-12-01');
    expect(confirm.disabled).toBe(false);
    fireEvent.click(confirm);
    await waitFor(() => expect(spy).toHaveBeenCalledTimes(1));
    expect(body(spy).value).toEqual({
      'claude-a': entry('先停', '2026-12-01'),
      'claude-b': entry('先停', '2026-12-01'),
    });
  });

  test('点取消什么都不写；渠道表单和池表单不会同时开', async () => {
    const api = createMockApi({ live: false });
    const spy = vi.spyOn(api, 'updateSetting');
    await open(api);
    fireEvent.click(pauseBtn() as HTMLButtonElement);
    await screen.findByRole('group', { name: 'Claude 订阅 的整渠道暂停' });
    fireEvent.click(switchOf('relay'));
    expect(await screen.findByRole('group', { name: 'relay 的停用' })).toBeTruthy();
    expect(screen.queryByRole('group', { name: 'Claude 订阅 的整渠道暂停' })).toBeNull();
    fireEvent.click(pauseBtn() as HTMLButtonElement);
    fireEvent.click(await screen.findByRole('button', { name: '取消' }));
    expect(screen.queryByRole('group', { name: 'Claude 订阅 的整渠道暂停' })).toBeNull();
    expect(spy).not.toHaveBeenCalled();
  });
});

describe('整渠道放开：全停', () => {
  test('头上只有「全部放开」；原因必填；只撤这个渠道，别的渠道的暂停原样留着', async () => {
    const api = createMockApi({ live: false });
    await seed(api, {
      'claude-a': entry('A 停', '2026-12-01'),
      'claude-b': entry('B 停'),
      relay: entry('中转站另有原因'),
    });
    const spy = vi.spyOn(api, 'updateSetting');
    await open(api);
    expect(resumeBtn()?.textContent).toBe('全部放开');
    expect(pauseBtn()).toBeNull();
    expect(state()?.getAttribute('data-channel-hold-state')).toBe('paused');

    fireEvent.click(resumeBtn() as HTMLButtonElement);
    expect(await screen.findByText(/将放开 2 个池：claude-a、claude-b/)).toBeTruthy();
    const confirm = screen.getByRole('button', { name: '确认放开整渠道' }) as HTMLButtonElement;
    expect(confirm.disabled).toBe(true);
    expect(screen.queryByLabelText('复查日期（可不填）')).toBeNull();
    fireEvent.click(confirm);
    expect(spy).not.toHaveBeenCalled();

    fill('为什么现在能开', '号已解开');
    fireEvent.click(confirm);
    await waitFor(() => expect(spy).toHaveBeenCalledTimes(1));
    expect(body(spy)).toEqual({
      value: { relay: kept(entry('中转站另有原因')) },
      version: 1,
      reason: '号已解开',
    });
    await waitFor(() => expect(switchOf('claude-a').getAttribute('aria-checked')).toBe('true'));
    expect(switchOf('claude-b').getAttribute('aria-checked')).toBe('true');
    expect(switchOf('relay').getAttribute('aria-checked')).toBe('false');
    expect(toast.success).toHaveBeenCalledWith('已放开 Claude 订阅：2 个池');
    await waitFor(() => expect(pauseBtn()?.textContent).toBe('全部暂停'));
    expect(resumeBtn()).toBeNull();
  });
});

describe('整渠道：混合状态', () => {
  test('头上写已停几个，两个按钮都在；「暂停其余」只补没停的，已停那个的原因和日期不动', async () => {
    const api = createMockApi({ live: false });
    await seed(api, { 'claude-a': entry('A 原来的原因', '2026-12-01') });
    const spy = vi.spyOn(api, 'updateSetting');
    await open(api);
    expect(pauseBtn()?.textContent).toBe('暂停其余');
    expect(resumeBtn()?.textContent).toBe('放开已停');
    expect(state()?.textContent).toContain('已停 1/2');

    fireEvent.click(pauseBtn() as HTMLButtonElement);
    expect(await screen.findByText(/将暂停 1 个池：claude-b/)).toBeTruthy();
    expect(screen.getByText(/已经停着的 claude-a 原样不动/)).toBeTruthy();
    fill('原因', '补停');
    fireEvent.click(screen.getByRole('button', { name: '确认暂停整渠道' }));
    await waitFor(() => expect(spy).toHaveBeenCalledTimes(1));
    expect(body(spy).value).toEqual({
      'claude-a': kept(entry('A 原来的原因', '2026-12-01')),
      'claude-b': entry('补停'),
    });
  });

  test('「放开已停」只撤已停的，没停的不会被写成暂停', async () => {
    const api = createMockApi({ live: false });
    await seed(api, { 'claude-a': entry('A 停'), relay: entry('中转站另有原因') });
    const spy = vi.spyOn(api, 'updateSetting');
    await open(api);
    fireEvent.click(resumeBtn() as HTMLButtonElement);
    expect(await screen.findByText(/将放开 1 个池：claude-a/)).toBeTruthy();
    fill('为什么现在能开', '号已解开');
    fireEvent.click(screen.getByRole('button', { name: '确认放开整渠道' }));
    await waitFor(() => expect(spy).toHaveBeenCalledTimes(1));
    expect(body(spy).value).toEqual({ relay: kept(entry('中转站另有原因')) });
  });
});

describe('整渠道：认不出的项和封号原样留着', () => {
  const bad = { reason: '被封号' }; // 缺 decidedBy、revokeWhen：认不出
  const withOpaque = (api: MockApi, poolId: string) => {
    const real = api.poolHolds.bind(api);
    api.poolHolds = async () => {
      const v = await real();
      return {
        ...v,
        problems: [...v.problems, { poolId, why: '缺 decidedBy，这个池照样按暂停办' }],
        opaque: { ...v.opaque, [poolId]: bad },
      };
    };
  };

  test('暂停：认不出的 claude-b 原样写回，不当成没停去覆盖；只补写 claude-a', async () => {
    const api = createMockApi({ live: false });
    withOpaque(api, 'claude-b');
    const spy = vi.spyOn(api, 'updateSetting');
    await open(api);
    expect(state()?.textContent).toContain('已停 1/2');
    fireEvent.click(pauseBtn() as HTMLButtonElement);
    expect(await screen.findByText(/将暂停 1 个池：claude-a/)).toBeTruthy();
    expect(screen.getByText(/claude-b 的暂停认不出，原样留着，不会放开/)).toBeTruthy();
    fill('原因', '先停');
    fireEvent.click(screen.getByRole('button', { name: '确认暂停整渠道' }));
    await waitFor(() => expect(spy).toHaveBeenCalledTimes(1));
    expect(body(spy).value['claude-b']).toEqual(bad);
    expect(body(spy).value['claude-a']).toMatchObject({ reason: '先停' });
  });

  test('放开：认不出的 claude-b 不放开、原样写回，按钮字写「放开已停」不写「全部」', async () => {
    const api = createMockApi({ live: false });
    await seed(api, { 'claude-a': entry('A 停') });
    withOpaque(api, 'claude-b');
    const spy = vi.spyOn(api, 'updateSetting');
    await open(api);
    // 一个认得出的已停 + 一个认不出的：整渠道算全停，但放开的字不写「全部」，因为认不出的放不开
    expect(state()?.getAttribute('data-channel-hold-state')).toBe('paused');
    expect(resumeBtn()?.textContent).toBe('放开已停');
    fireEvent.click(resumeBtn() as HTMLButtonElement);
    expect(await screen.findByText(/将放开 1 个池：claude-a/)).toBeTruthy();
    expect(screen.getByText(/claude-b 的暂停认不出，原样留着，不会放开/)).toBeTruthy();
    fill('为什么现在能开', '号已解开');
    fireEvent.click(screen.getByRole('button', { name: '确认放开整渠道' }));
    await waitFor(() => expect(spy).toHaveBeenCalledTimes(1));
    expect(body(spy).value).toEqual({ 'claude-b': bad });
  });

  test('只有认不出的：头上写全部已停，没有任何批量按钮可点', async () => {
    const api = createMockApi({ live: false });
    const real = api.poolHolds.bind(api);
    api.poolHolds = async () => {
      const v = await real();
      return {
        ...v,
        problems: ['claude-a', 'claude-b'].map((poolId) => ({ poolId, why: '认不出' })),
        opaque: { 'claude-a': bad, 'claude-b': bad },
      };
    };
    renderApp(<QuotaPage />, { api });
    await waitFor(() => expect(state()?.getAttribute('data-channel-hold-state')).toBe('paused'));
    expect(pauseBtn()).toBeNull();
    expect(resumeBtn()).toBeNull();
  });

  test('封号提醒顶着的池：放开时提示不会解除，也不会被写进设置', async () => {
    const api = createMockApi({ live: false });
    await seed(api, { 'claude-a': entry('A 停') });
    const real = api.poolHolds.bind(api);
    api.poolHolds = async () => {
      const v = await real();
      return {
        ...v,
        legacy: [
          {
            poolId: 'claude-b',
            title: '账号池 claude-b 整池暂停：登录失效',
            since: '2026-10-01T00:00:00.000Z',
            alsoSwitched: false,
          },
        ],
      };
    };
    const spy = vi.spyOn(api, 'updateSetting');
    await open(api);
    fireEvent.click(resumeBtn() as HTMLButtonElement);
    expect(await screen.findByText(/claude-b 还挂着引擎探到的封号等提醒，不会因此解除/)).toBeTruthy();
    fill('为什么现在能开', 'A 号已解开');
    fireEvent.click(screen.getByRole('button', { name: '确认放开整渠道' }));
    await waitFor(() => expect(spy).toHaveBeenCalledTimes(1));
    expect(body(spy).value).toEqual({});
    expect(document.querySelector('tr[data-pool="claude-b"] [data-pool-flag="封号"]')).toBeTruthy();
  });
});

describe('整渠道：整份认不出或读不到', () => {
  test('【故意造出的失败】holdAll：批量按钮在但点不了，点了也开不出表单、不写设置', async () => {
    const api = createMockApi({ live: false });
    const real = api.poolHolds.bind(api);
    api.poolHolds = async () => {
      const v = await real();
      return { ...v, holdAll: true, problems: [{ poolId: null, why: '整份不是对象，所有池按暂停办' }] };
    };
    const spy = vi.spyOn(api, 'updateSetting');
    renderApp(<QuotaPage />, { api });
    await screen.findByRole('columnheader', { name: '周期美元' });
    await waitFor(() => expect(pauseBtn()?.title).toContain('暂停设置没查成'));
    expect(pauseBtn()?.disabled).toBe(true);
    expect(resumeBtn()?.disabled).toBe(true);
    expect(state()).toBeNull();
    fireEvent.click(pauseBtn() as HTMLButtonElement);
    fireEvent.click(resumeBtn() as HTMLButtonElement);
    expect(screen.queryByRole('group', { name: /整渠道/ })).toBeNull();
    expect(spy).not.toHaveBeenCalled();
  });

  test('【故意造出的失败】暂停设置读不到：批量按钮点不了', async () => {
    const api = createMockApi({ live: false });
    api.poolHolds = async () => {
      throw new Error('库连不上');
    };
    renderApp(<QuotaPage />, { api });
    await screen.findByRole('columnheader', { name: '周期美元' });
    await waitFor(() =>
      expect(document.querySelectorAll('[data-pool-flag="没查成"]').length).toBeGreaterThan(0),
    );
    expect(pauseBtn()?.disabled).toBe(true);
    expect(resumeBtn()?.disabled).toBe(true);
  });
});

describe('整渠道：设置版本冲突', () => {
  test('【故意造出的失败】别人先写了：弹重来的提示、表单和原因留着、刷新后预览带上别人写的，再点一次不覆盖它', async () => {
    const api = createMockApi({ live: false });
    const spy = vi.spyOn(api, 'updateSetting');
    await open(api);
    fireEvent.click(pauseBtn() as HTMLButtonElement);
    fill('原因', '整个渠道先停');
    // 表单开着的时候，别人把 claude-a 先停了（版本 0 → 1），这一页手里还是版本 0
    await api.updateSetting(KEY, { value: { 'claude-a': entry('别人写的') }, version: 0 });
    fireEvent.click(screen.getByRole('button', { name: '确认暂停整渠道' }));
    await waitFor(() =>
      expect(toast.error).toHaveBeenCalledWith(
        '这项设置刚被别人改过，已刷新，请再改一次',
        expect.objectContaining({ description: expect.stringContaining('刚被别人改过') }),
      ),
    );
    expect(toast.success).not.toHaveBeenCalled();
    expect(body(spy, 1).version).toBe(0);
    // 别人写的没被覆盖
    expect((await stored(api))?.value).toEqual({ 'claude-a': entry('别人写的') });
    // 刷新后：表单还在、原因还在，预览只剩 claude-b，claude-a 变成「原样不动」
    expect(await screen.findByText(/将暂停 1 个池：claude-b/)).toBeTruthy();
    expect(screen.getByText(/已经停着的 claude-a 原样不动/)).toBeTruthy();
    expect((screen.getByLabelText('原因') as HTMLInputElement).value).toBe('整个渠道先停');

    fireEvent.click(screen.getByRole('button', { name: '确认暂停整渠道' }));
    await waitFor(() => expect(toast.success).toHaveBeenCalledWith('已暂停 Claude 订阅：1 个池'));
    expect(body(spy, 2).version).toBe(1);
    expect((await stored(api))?.value).toEqual({
      'claude-a': kept(entry('别人写的')),
      'claude-b': entry('整个渠道先停'),
    });
  });

  test('后端拒绝（500）：不冒充成功，表单留着', async () => {
    const api = createMockApi({ live: false });
    vi.spyOn(api, 'updateSetting').mockRejectedValueOnce(new ApiError(500, 'internal', '后端出错了'));
    await open(api);
    fireEvent.click(pauseBtn() as HTMLButtonElement);
    fill('原因', '先停');
    fireEvent.click(screen.getByRole('button', { name: '确认暂停整渠道' }));
    await waitFor(() => expect(toast.error).toHaveBeenCalledWith('没保存上', { description: '后端出错了' }));
    expect(toast.success).not.toHaveBeenCalled();
    expect(screen.getByRole('group', { name: 'Claude 订阅 的整渠道暂停' })).toBeTruthy();
  });
});
