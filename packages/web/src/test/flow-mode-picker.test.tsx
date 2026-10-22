// @vitest-environment happy-dom
// 法国页引擎卡里的「派单方式」（engine.flowMode，原工作台页头的「三步法 / 全程」开关挪到这里，#3509）：
// 没设过按下三段且不写入；选了先弹确认框，原因必填，确认后才改 engine.flowMode；只影响之后新派的单。
// 对半分（split:50）是第三档；别的百分比、认不出的三档都不按下；看远程快照时不能改。
import { cleanup, fireEvent, screen, waitFor, within } from '@testing-library/react';
import { afterEach, describe, expect, test, vi } from 'vitest';
import { ApiError } from '../api/client';
import { createMockApi } from '../api/mock/server';
import { FlowModePicker } from '../components/flow-mode-picker';
import { renderApp } from './harness';

afterEach(cleanup);

// 确认框开着时，框外的内容对读屏是 aria-hidden：找按钮时带上 hidden，好在框留着的情况下也能看选项没变
const group = () => screen.getByRole('group', { name: '派单方式', hidden: true });
const choice = (name: string) => within(group()).getByRole('button', { name, hidden: true });
const pressed = (name: string) => choice(name).getAttribute('aria-pressed');
const current = () => document.querySelector('[data-flow-mode-current]')?.textContent ?? '';

function withMode(value: string | null, version = 1) {
  const api = createMockApi({ live: false });
  const real = api.settings.bind(api);
  api.settings = async () => {
    const got = await real();
    return {
      settings: got.settings.map((s) => (s.key === 'engine.flowMode' ? { ...s, value, version } : s)),
    };
  };
  return api;
}

const writeReason = async (text: string) => {
  const dialog = await screen.findByRole('alertdialog');
  fireEvent.change(within(dialog).getByRole('textbox', { name: /原因/ }), { target: { value: text } });
  return dialog;
};

describe('派单方式', () => {
  test('没设过按下三段，进来不写设置；点已按下的那个不弹框', async () => {
    const api = createMockApi({ live: false });
    const spy = vi.spyOn(api, 'updateSetting');
    renderApp(<FlowModePicker />, { api, route: '/france' });
    await waitFor(() => expect(pressed('三段')).toBe('true'));
    expect(pressed('对半分')).toBe('false');
    expect(pressed('全程')).toBe('false');
    expect(current()).toContain('还没设过');
    fireEvent.click(choice('三段'));
    expect(screen.queryByRole('alertdialog')).toBeNull();
    expect(spy).not.toHaveBeenCalled();
  });

  test('点全程先确认；原因没写确认键灰着；写了才写成 full，带原因', async () => {
    const api = createMockApi({ live: false });
    const spy = vi.spyOn(api, 'updateSetting');
    renderApp(<FlowModePicker />, { api, route: '/france' });
    await waitFor(() => expect(pressed('三段')).toBe('true'));
    fireEvent.click(choice('全程'));
    const dialog = await screen.findByRole('alertdialog');
    expect(dialog.textContent).toContain('已经分过组');
    expect(dialog.textContent).toContain('正在跑');
    const ok = within(dialog).getByRole('button', { name: '确认改成全程' }) as HTMLButtonElement;
    expect(ok.disabled).toBe(true);
    fireEvent.click(ok);
    expect(spy).not.toHaveBeenCalled();
    await writeReason('全程更省事');
    expect((within(dialog).getByRole('button', { name: '确认改成全程' }) as HTMLButtonElement).disabled).toBe(
      false,
    );
    fireEvent.click(within(dialog).getByRole('button', { name: '确认改成全程' }));
    await waitFor(() => expect(spy).toHaveBeenCalledTimes(1));
    expect(spy.mock.calls[0]?.[0]).toBe('engine.flowMode');
    expect(spy.mock.calls[0]?.[1]).toEqual({ value: 'full', version: 0, reason: '全程更省事' });
    await waitFor(() => expect(pressed('全程')).toBe('true'));
    expect(pressed('三段')).toBe('false');
  });

  test('选对半分写成 split:50', async () => {
    const api = createMockApi({ live: false });
    const spy = vi.spyOn(api, 'updateSetting');
    renderApp(<FlowModePicker />, { api, route: '/france' });
    await waitFor(() => expect(pressed('三段')).toBe('true'));
    fireEvent.click(choice('对半分'));
    const dialog = await writeReason('试一半');
    fireEvent.click(within(dialog).getByRole('button', { name: '确认改成对半分' }));
    await waitFor(() => expect(spy).toHaveBeenCalledTimes(1));
    expect(spy.mock.calls[0]?.[1]).toEqual({ value: 'split:50', version: 0, reason: '试一半' });
  });

  test('先不：不写设置，按下的还是原来的', async () => {
    const api = createMockApi({ live: false });
    const spy = vi.spyOn(api, 'updateSetting');
    renderApp(<FlowModePicker />, { api, route: '/france' });
    await waitFor(() => expect(pressed('三段')).toBe('true'));
    fireEvent.click(choice('全程'));
    fireEvent.click(within(await screen.findByRole('alertdialog')).getByRole('button', { name: '先不' }));
    await waitFor(() => expect(screen.queryByRole('alertdialog')).toBeNull());
    expect(spy).not.toHaveBeenCalled();
    expect(pressed('三段')).toBe('true');
  });

  test('当前是全程时按下全程；改回三段写成 three，带上读到的版本号', async () => {
    const api = withMode('full', 4);
    const spy = vi.spyOn(api, 'updateSetting');
    renderApp(<FlowModePicker />, { api, route: '/france' });
    await waitFor(() => expect(pressed('全程')).toBe('true'));
    expect(current()).toContain('当前是全程');
    fireEvent.click(choice('三段'));
    const dialog = await writeReason('回到三段');
    fireEvent.click(within(dialog).getByRole('button', { name: '确认改成三段' }));
    await waitFor(() => expect(spy).toHaveBeenCalledTimes(1));
    expect(spy.mock.calls[0]?.[1]).toEqual({ value: 'three', version: 4, reason: '回到三段' });
  });

  test('当前是对半分按下对半分；split:40 不叫对半分、三个都不按下', async () => {
    renderApp(<FlowModePicker />, { api: withMode('split:50', 2), route: '/france' });
    await waitFor(() => expect(pressed('对半分')).toBe('true'));
    expect(current()).toContain('对半分');
    cleanup();

    renderApp(<FlowModePicker />, { api: withMode('split:40', 3), route: '/france' });
    await waitFor(() => expect(current()).toContain('split:40'));
    expect(current()).not.toContain('对半分');
    for (const name of ['三段', '对半分', '全程']) expect(pressed(name)).toBe('false');
  });

  test('【故意造出的失败】读不到当前值：写「当前值没查成」，三个都不按下', async () => {
    const api = createMockApi({ live: false });
    api.settings = async () => {
      throw new ApiError(500, 'internal', '库连不上（测试故意造的）');
    };
    renderApp(<FlowModePicker />, { api, route: '/france' });
    await waitFor(() => expect(current()).toContain('当前值没查成'));
    expect(current()).toContain('库连不上（测试故意造的）');
    for (const name of ['三段', '对半分', '全程']) expect(pressed(name)).toBe('false');
  });

  test('【故意造出的失败】后端拒了：确认框留着，选项还是原来的', async () => {
    const api = createMockApi({ live: false });
    api.updateSetting = async () => {
      throw new ApiError(409, 'version_conflict', '别人先改了');
    };
    renderApp(<FlowModePicker />, { api, route: '/france' });
    await waitFor(() => expect(pressed('三段')).toBe('true'));
    fireEvent.click(choice('全程'));
    const dialog = await writeReason('试试');
    fireEvent.click(within(dialog).getByRole('button', { name: '确认改成全程' }));
    await waitFor(() => expect(dialog.textContent).toContain('别人先改了'));
    expect(screen.getByRole('alertdialog')).toBeTruthy();
    expect(pressed('三段')).toBe('true');
    expect(pressed('全程')).toBe('false');
  });

  test('看远程环境的快照时不能改，也不把本台的模式当成那台的', async () => {
    const api = withMode('full', 2);
    const spy = vi.spyOn(api, 'updateSetting');
    renderApp(<FlowModePicker />, { api, route: '/france?node=other' });
    await waitFor(() => expect(current()).toContain('快照'));
    for (const name of ['三段', '对半分', '全程']) expect(pressed(name)).toBe('false');
    fireEvent.click(choice('全程'));
    expect(screen.queryByRole('alertdialog')).toBeNull();
    expect(spy).not.toHaveBeenCalled();
  });
});
