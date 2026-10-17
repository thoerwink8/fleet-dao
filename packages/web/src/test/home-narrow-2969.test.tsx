// @vitest-environment happy-dom
// 首页窄屏页头（#2969）：流程开关、状态、刷新原来和标题挤在一行，开关被压扁后盖住状态。
// 手机上标题单独一行，开关占满下一行，状态和刷新靠右。happy-dom 没有版面，这里钉结构和交互；
// 框有没有叠、有没有横滚，由 e2e 02c-home-narrow 量。
import { cleanup, fireEvent, screen, waitFor, within } from '@testing-library/react';
import { afterEach, describe, expect, test, vi } from 'vitest';
import { ApiError, useHome } from '../api/client';
import { createMockApi } from '../api/mock/server';
import HomePage from '../routes/home';
import { renderApp } from './harness';

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

function viewport(width: number) {
  vi.spyOn(window, 'matchMedia').mockImplementation(
    (query: string) =>
      ({
        matches: [...query.matchAll(/\((min|max)-width:\s*(\d+)px\)/g)].every(([, kind, px]) =>
          kind === 'min' ? width >= Number(px) : width <= Number(px),
        ),
        media: query,
        onchange: null,
        addEventListener() {},
        removeEventListener() {},
        addListener() {},
        removeListener() {},
        dispatchEvent: () => false,
      }) as MediaQueryList,
  );
}

const actions = () => document.querySelector('[data-page-actions]') as HTMLElement;
const header = () => document.querySelector('[data-page-titlebar]')?.parentElement as HTMLElement;

async function ready() {
  await waitFor(() =>
    expect(screen.getByRole('button', { name: '刷新' }).getAttribute('aria-busy')).toBe('false'),
  );
  await waitFor(() => expect(document.querySelector('[data-health-strip]')).toBeTruthy());
  await waitFor(() =>
    expect(screen.getByRole('button', { name: '三步法' }).getAttribute('aria-pressed')).toBe('true'),
  );
}

describe('窄屏页头结构', () => {
  for (const width of [320, 360, 390]) {
    test(`${width}：标题和操作区分开，开关、状态、刷新都在操作区里`, async () => {
      viewport(width);
      renderApp(<HomePage />);
      await ready();
      const bar = actions();
      expect(bar.getAttribute('data-actions-layout')).toBe('stack');
      expect(bar.className).toContain('max-md:w-full');
      expect(header().className).toContain('max-md:flex-col');
      expect(header().className).not.toMatch(/(^|\s)flex-col(\s|$)/);
      const sw = document.querySelector('[data-flow-mode-switch]') as HTMLElement;
      const health = document.querySelector('[data-health-strip-box]') as HTMLElement;
      const refresh = document.querySelector('[data-refresh-bar]') as HTMLElement;
      expect(bar.contains(sw)).toBe(true);
      expect(bar.contains(health)).toBe(true);
      expect(bar.contains(refresh)).toBe(true);
      expect(health.contains(document.querySelector('[data-health-strip]'))).toBe(true);
      expect(bar.contains(screen.getByRole('heading', { name: '主页' }))).toBe(false);
      // 两个选择和刷新都还在，名字没被收掉
      expect(screen.getByRole('button', { name: '全程' })).toBeTruthy();
      expect(screen.getByRole('button', { name: '刷新' })).toBeTruthy();
      expect(document.querySelector('[data-flow-mode-current]')?.textContent).toMatch(/三步法/);
    });
  }

  test('宽屏：操作区仍跟标题并排的那一套类，不改成始终上下堆', async () => {
    viewport(1366);
    renderApp(<HomePage />);
    await ready();
    const bar = header();
    expect(bar.className).toContain('justify-between');
    expect(bar.className).toContain('lg:flex-nowrap');
    expect(bar.className).not.toMatch(/(^|\s)flex-col(\s|$)/);
    expect(actions().getAttribute('data-actions-layout')).toBe('stack');
  });
});

describe('窄屏上切换、刷新、读失败仍在', () => {
  test('390：点全程先确认，先不关掉，不写设置', async () => {
    viewport(390);
    const api = createMockApi({ live: false });
    const spy = vi.spyOn(api, 'updateSetting');
    renderApp(<HomePage />, { api });
    await ready();
    fireEvent.click(screen.getByRole('button', { name: '全程' }));
    const dialog = await screen.findByRole('alertdialog');
    expect(dialog.textContent).toContain('已经在跑的');
    expect(spy).not.toHaveBeenCalled();
    fireEvent.click(within(dialog).getByRole('button', { name: '先不' }));
    await waitFor(() => expect(screen.queryByRole('alertdialog')).toBeNull());
    expect(spy).not.toHaveBeenCalled();
    expect(screen.getByRole('button', { name: '三步法' }).getAttribute('aria-pressed')).toBe('true');
  });

  test('390：点刷新，调用主页主查询的 refetch', async () => {
    viewport(390);
    function Probe() {
      useHome();
      return null;
    }
    const probe = renderApp(<Probe />);
    const observer = probe.qc.getQueryCache().find({ queryKey: ['home'] })?.observers[0];
    if (!observer) throw new Error('探针没有主查询');
    const refetch = vi.spyOn(Object.getPrototypeOf(observer), 'refetch');
    probe.unmount();

    const api = createMockApi({ live: false });
    const home = vi.spyOn(api, 'home');
    renderApp(<HomePage />, { api });
    await ready();
    refetch.mockClear();
    const before = home.mock.calls.length;
    fireEvent.click(screen.getByRole('button', { name: '刷新' }));
    expect(refetch).toHaveBeenCalledTimes(1);
    await waitFor(() => expect(home.mock.calls.length).toBe(before + 1));
    expect(document.querySelector('[data-health-strip]')).toBeTruthy();
    expect(screen.getByRole('button', { name: '全程' })).toBeTruthy();
  });

  test('390：【故意造出的失败】主页没读成仍显示原因，开关和刷新还在，不拿状态条冒充', async () => {
    viewport(390);
    const api = createMockApi({ live: false });
    api.home = () => Promise.reject(new ApiError(500, 'internal', '后端出错了'));
    renderApp(<HomePage />, { api });
    const alert = await screen.findByRole('alert');
    expect(alert.textContent).toContain('主页没读成');
    expect(alert.textContent).toContain('后端出错了');
    expect(screen.getByRole('button', { name: '重试' })).toBeTruthy();
    expect(actions().contains(document.querySelector('[data-flow-mode-switch]'))).toBe(true);
    expect(actions().contains(document.querySelector('[data-refresh-bar]'))).toBe(true);
    expect(document.querySelector('[data-health-strip]')).toBeNull();
    expect(screen.getByRole('button', { name: '刷新' })).toBeTruthy();
  });
});
