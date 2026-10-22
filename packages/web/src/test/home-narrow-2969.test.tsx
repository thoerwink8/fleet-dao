// @vitest-environment happy-dom
// 工作台窄屏页头（#2969，#3533 改）：原来流程开关、状态、刷新和标题挤在一行，开关被压扁后盖住状态。
// 「三段 / 全程」开关已挪到法国页的引擎卡（test/flow-mode-picker.test.tsx），工作台页头只剩刷新：
// 手机上标题单独一行，刷新在下面，不横向撑出屏幕。happy-dom 没有版面，这里钉结构和交互；框有没有叠、有没有横滚，由 e2e 02c-home-narrow 量。
import { cleanup, fireEvent, screen, waitFor } from '@testing-library/react';
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

async function ready() {
  await waitFor(() =>
    expect(screen.getByRole('button', { name: '刷新' }).getAttribute('aria-busy')).toBeNull(),
  );
  // 系统状态读到了（健康条不再挤在页头，放进「系统状态」那一块）
  await waitFor(() => expect(screen.getByText('引擎进程')).toBeTruthy());
}

describe('窄屏页头结构', () => {
  for (const width of [320, 360, 390, 1366]) {
    test(`${width}：页头只有刷新，开关不在工作台（在法国页），标题和操作区分开`, async () => {
      viewport(width);
      renderApp(<HomePage />);
      await ready();
      const bar = actions();
      const refresh = document.querySelector('[data-refresh-bar]') as HTMLElement;
      expect(bar.contains(refresh)).toBe(true);
      expect(bar.contains(screen.getByRole('heading', { level: 1, name: '工作台' }))).toBe(false);
      // 页头不再叠状态，也没有派单方式开关（挪到了法国页的引擎卡）
      expect(bar.textContent).not.toContain('引擎进程');
      expect(document.querySelector('[data-flow-mode-switch]')).toBeNull();
      expect(screen.queryByRole('button', { name: '全程' })).toBeNull();
      expect(screen.getByRole('button', { name: '刷新' })).toBeTruthy();
    });
  }
});

describe('窄屏上刷新、读失败仍在', () => {
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
    expect(screen.getByText('引擎进程')).toBeTruthy();
  });

  test('390：【故意造出的失败】主页没读成仍显示原因，刷新还在，不拿状态条冒充', async () => {
    viewport(390);
    const api = createMockApi({ live: false });
    api.home = () => Promise.reject(new ApiError(500, 'internal', '后端出错了'));
    renderApp(<HomePage />, { api });
    const alerts = await screen.findAllByRole('alert');
    const alert = alerts.find((a) => a.textContent?.includes('主页没读成'));
    expect(alert?.textContent).toContain('后端出错了');
    expect(screen.getAllByRole('button', { name: '重试' }).length).toBeGreaterThan(0);
    expect(actions().contains(document.querySelector('[data-refresh-bar]'))).toBe(true);
    // 没读到系统状态就不画「引擎进程 运行中」这类状态，也不画额度和估算的数
    expect(screen.queryByText('引擎进程')).toBeNull();
    expect(document.querySelector('[data-spend-line]')).toBeNull();
    expect(screen.getByRole('button', { name: '刷新' })).toBeTruthy();
  });
});
