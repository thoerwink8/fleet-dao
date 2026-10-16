// @vitest-environment happy-dom
// 设置页全程模式开关（engine.flowMode，#2828）：三段 / 对半分 / 全程，先写原因再二次确认。
// 改不成回到原来按下的那一档，并写出原因。认不出的值、不是 50% 的对半都不冒充成这三个档位。
import { cleanup, fireEvent, screen, waitFor, within } from '@testing-library/react';
import { afterEach, describe, expect, test, vi } from 'vitest';
import { ApiError } from '../api/client';
import { createMockApi } from '../api/mock/server';
import SettingsPage from '../routes/settings';
import { renderApp } from './harness';

afterEach(cleanup);

// 确认框打开时 Radix 给这一行加上 aria-hidden，可访问名算成空的，getByRole 对不上「全程模式开关」。
const form = () => {
  const el = document.querySelector('form[aria-label="全程模式开关"]');
  if (!(el instanceof HTMLElement)) throw new Error('没有全程模式开关');
  return el;
};
const choice = (name: string) => {
  const btn = [...form().querySelectorAll('button')].find((b) => b.textContent?.trim() === name);
  if (!btn) throw new Error(`没有「${name}」`);
  return btn;
};
const pressed = (name: string) => choice(name).getAttribute('aria-pressed');

describe('设置页全程模式开关', () => {
  test('没设过默认三段；点全程先确认，没写原因不改', async () => {
    const api = createMockApi({ live: false });
    const spy = vi.spyOn(api, 'updateSetting');
    renderApp(<SettingsPage />, { api, route: '/settings' });
    expect(await screen.findByRole('form', { name: '全程模式开关' })).toBeTruthy();
    await waitFor(() => expect(pressed('三段')).toBe('true'));
    expect(pressed('对半分')).toBe('false');
    expect(pressed('全程')).toBe('false');
    expect(document.querySelector('[data-flow-mode-current]')?.textContent).toContain('还没设过');

    fireEvent.click(choice('三段'));
    expect(screen.queryByRole('alertdialog')).toBeNull();

    fireEvent.click(choice('全程'));
    const dialog = await screen.findByRole('alertdialog');
    expect(dialog.textContent).toContain('写成 full');
    expect(pressed('三段')).toBe('true');
    const confirm = within(dialog).getByRole('button', { name: '确认改成全程' });
    expect((confirm as HTMLButtonElement).disabled).toBe(true);
    fireEvent.click(confirm);
    expect(spy).not.toHaveBeenCalled();
    expect(pressed('三段')).toBe('true');
  });

  test('写了原因才改成对半分，请求带上 split:50 和原因', async () => {
    const api = createMockApi({ live: false });
    const spy = vi.spyOn(api, 'updateSetting');
    renderApp(<SettingsPage />, { api, route: '/settings' });
    await screen.findByRole('form', { name: '全程模式开关' });
    await waitFor(() => expect(pressed('三段')).toBe('true'));
    fireEvent.click(choice('对半分'));
    const dialog = await screen.findByRole('alertdialog');
    fireEvent.change(within(dialog).getByLabelText('原因'), { target: { value: '试点对半' } });
    fireEvent.click(within(dialog).getByRole('button', { name: '确认改成对半分' }));
    await waitFor(() => expect(spy).toHaveBeenCalledTimes(1));
    expect(spy.mock.calls[0]?.[0]).toBe('engine.flowMode');
    expect(spy.mock.calls[0]?.[1]).toEqual({ value: 'split:50', version: 0, reason: '试点对半' });
    await waitFor(() => expect(pressed('对半分')).toBe('true'));
    expect(pressed('三段')).toBe('false');
    expect(pressed('全程')).toBe('false');
  });

  test('先不：不写设置，还停在原来的档', async () => {
    const api = createMockApi({ live: false });
    const spy = vi.spyOn(api, 'updateSetting');
    renderApp(<SettingsPage />, { api, route: '/settings' });
    await screen.findByRole('form', { name: '全程模式开关' });
    await waitFor(() => expect(pressed('三段')).toBe('true'));
    fireEvent.click(choice('全程'));
    fireEvent.click(within(await screen.findByRole('alertdialog')).getByRole('button', { name: '先不' }));
    await waitFor(() => expect(screen.queryByRole('alertdialog')).toBeNull());
    expect(spy).not.toHaveBeenCalled();
    expect(pressed('三段')).toBe('true');
    expect(pressed('全程')).toBe('false');
  });

  test('【故意造出的失败】改不成就回到原来的档，并写出原因', async () => {
    const api = createMockApi({ live: false });
    api.updateSetting = async () => {
      throw new ApiError(500, 'internal', '库连不上');
    };
    renderApp(<SettingsPage />, { api, route: '/settings' });
    await screen.findByRole('form', { name: '全程模式开关' });
    await waitFor(() => expect(pressed('三段')).toBe('true'));
    fireEvent.click(choice('全程'));
    const dialog = await screen.findByRole('alertdialog');
    fireEvent.change(within(dialog).getByLabelText('原因'), { target: { value: '想改全程' } });
    fireEvent.click(within(dialog).getByRole('button', { name: '确认改成全程' }));
    expect(await screen.findByText('没成功：库连不上')).toBeTruthy();
    expect(pressed('三段')).toBe('true');
    expect(pressed('全程')).toBe('false');
    fireEvent.click(within(dialog).getByRole('button', { name: '先不' }));
    await waitFor(() => expect(screen.queryByRole('alertdialog')).toBeNull());
    expect(within(form()).getByRole('alert').textContent).toContain('库连不上');
    expect(pressed('三段')).toBe('true');
    expect(pressed('全程')).toBe('false');
  });

  test('库里是 split:40：三个档位都不按下，不当成对半分', async () => {
    const api = createMockApi({ live: false });
    const real = api.settings.bind(api);
    api.settings = async () => {
      const got = await real();
      return {
        settings: got.settings.map((s) =>
          s.key === 'engine.flowMode' ? { ...s, value: 'split:40', version: 3 } : s,
        ),
      };
    };
    renderApp(<SettingsPage />, { api, route: '/settings' });
    await screen.findByRole('form', { name: '全程模式开关' });
    await waitFor(() =>
      expect(document.querySelector('[data-flow-mode-current]')?.textContent).toContain('split:40'),
    );
    expect(pressed('三段')).toBe('false');
    expect(pressed('对半分')).toBe('false');
    expect(pressed('全程')).toBe('false');
    expect(document.querySelector('[data-flow-mode-current]')?.textContent).not.toContain('对半分');
  });

  test('库里的值认不出：三个档位都不按下，不冒充已经选了三段', async () => {
    const api = createMockApi({ live: false });
    const real = api.settings.bind(api);
    api.settings = async () => {
      const got = await real();
      return {
        settings: got.settings.map((s) =>
          s.key === 'engine.flowMode' ? { ...s, value: 'nope', version: 4 } : s,
        ),
      };
    };
    renderApp(<SettingsPage />, { api, route: '/settings' });
    await screen.findByRole('form', { name: '全程模式开关' });
    await waitFor(() =>
      expect(document.querySelector('[data-flow-mode-current]')?.textContent).toContain('认不出'),
    );
    expect(pressed('三段')).toBe('false');
    expect(pressed('对半分')).toBe('false');
    expect(pressed('全程')).toBe('false');
  });
});
