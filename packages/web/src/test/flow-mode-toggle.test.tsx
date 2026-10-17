// @vitest-environment happy-dom
// 驾驶舱「全程 / 三步法」全局开关：没设过显示三步法且不写入；确认后才改 engine.flowMode。
// 只影响之后新派的单。对半分两个按钮都不按下。看远程快照时不能改。
import { cleanup, fireEvent, screen, waitFor, within } from '@testing-library/react';
import { afterEach, describe, expect, test, vi } from 'vitest';
import { createMockApi } from '../api/mock/server';
import { FlowModeToggle } from '../components/flow-mode-toggle';
import { renderApp } from './harness';

afterEach(cleanup);

const group = () => screen.getByRole('group', { name: '全程或三步法' });
const choice = (name: string) => {
  const btn = within(group()).getByRole('button', { name });
  return btn;
};
const pressed = (name: string) => choice(name).getAttribute('aria-pressed');

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

describe('全程 / 三步法全局开关', () => {
  test('没设过显示三步法，进来不写设置', async () => {
    const api = createMockApi({ live: false });
    const spy = vi.spyOn(api, 'updateSetting');
    renderApp(<FlowModeToggle />, { api, route: '/' });
    expect(await screen.findByRole('group', { name: '全程或三步法' })).toBeTruthy();
    await waitFor(() => expect(pressed('三步法')).toBe('true'));
    expect(pressed('全程')).toBe('false');
    expect(document.querySelector('[data-flow-mode-current]')?.textContent).toContain('还没设过');
    expect(document.querySelector('[data-flow-mode-current]')?.textContent).toContain('三步法');
    fireEvent.click(choice('三步法'));
    expect(screen.queryByRole('alertdialog')).toBeNull();
    expect(spy).not.toHaveBeenCalled();
  });

  test('点全程先确认；确认后写成 full，正在跑的不变写在确认里', async () => {
    const api = createMockApi({ live: false });
    const spy = vi.spyOn(api, 'updateSetting');
    renderApp(<FlowModeToggle />, { api, route: '/' });
    await waitFor(() => expect(pressed('三步法')).toBe('true'));
    fireEvent.click(choice('全程'));
    const dialog = await screen.findByRole('alertdialog');
    expect(dialog.textContent).toContain('已经在跑的');
    expect(dialog.textContent).toContain('已经分过组');
    expect(spy).not.toHaveBeenCalled();
    fireEvent.click(within(dialog).getByRole('button', { name: '确认改成全程' }));
    await waitFor(() => expect(spy).toHaveBeenCalledTimes(1));
    expect(spy.mock.calls[0]?.[0]).toBe('engine.flowMode');
    expect(spy.mock.calls[0]?.[1]).toEqual({
      value: 'full',
      version: 0,
      reason: '驾驶舱上切到全程',
    });
    await waitFor(() => expect(pressed('全程')).toBe('true'));
    expect(pressed('三步法')).toBe('false');
  });

  test('先不：不写设置', async () => {
    const api = createMockApi({ live: false });
    const spy = vi.spyOn(api, 'updateSetting');
    renderApp(<FlowModeToggle />, { api, route: '/' });
    await waitFor(() => expect(pressed('三步法')).toBe('true'));
    fireEvent.click(choice('全程'));
    fireEvent.click(within(await screen.findByRole('alertdialog')).getByRole('button', { name: '先不' }));
    await waitFor(() => expect(screen.queryByRole('alertdialog')).toBeNull());
    expect(spy).not.toHaveBeenCalled();
    expect(pressed('三步法')).toBe('true');
  });

  test('当前是全程时按下全程；改回三步法写成 three', async () => {
    const api = withMode('full', 4);
    const spy = vi.spyOn(api, 'updateSetting');
    renderApp(<FlowModeToggle />, { api, route: '/' });
    await waitFor(() => expect(pressed('全程')).toBe('true'));
    expect(document.querySelector('[data-flow-mode-current]')?.textContent).toContain('当前是全程');
    fireEvent.click(choice('三步法'));
    fireEvent.click(
      within(await screen.findByRole('alertdialog')).getByRole('button', { name: '确认改成三步法' }),
    );
    await waitFor(() => expect(spy).toHaveBeenCalledTimes(1));
    expect(spy.mock.calls[0]?.[1]).toEqual({
      value: 'three',
      version: 4,
      reason: '驾驶舱上切到三步法',
    });
  });

  test('对半分两个都不按下；split:40 不叫对半分', async () => {
    const half = withMode('split:50', 2);
    renderApp(<FlowModeToggle />, { api: half, route: '/' });
    await waitFor(() =>
      expect(document.querySelector('[data-flow-mode-current]')?.textContent).toContain('对半分'),
    );
    expect(pressed('三步法')).toBe('false');
    expect(pressed('全程')).toBe('false');
    cleanup();

    const other = withMode('split:40', 3);
    renderApp(<FlowModeToggle />, { api: other, route: '/' });
    await waitFor(() =>
      expect(document.querySelector('[data-flow-mode-current]')?.textContent).toContain('split:40'),
    );
    expect(document.querySelector('[data-flow-mode-current]')?.textContent).not.toContain('对半分');
    expect(pressed('三步法')).toBe('false');
    expect(pressed('全程')).toBe('false');
  });

  test('看远程环境的快照时不能改，也不把本台的模式当成那台的', async () => {
    const api = withMode('full', 2);
    const spy = vi.spyOn(api, 'updateSetting');
    renderApp(<FlowModeToggle />, { api, route: '/?node=other' });
    await waitFor(() =>
      expect(document.querySelector('[data-flow-mode-current]')?.textContent).toContain('快照'),
    );
    expect(pressed('全程')).toBe('false');
    expect(pressed('三步法')).toBe('false');
    fireEvent.click(choice('全程'));
    expect(screen.queryByRole('alertdialog')).toBeNull();
    expect(spy).not.toHaveBeenCalled();
  });
});
