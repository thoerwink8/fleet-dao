// @vitest-environment happy-dom
// 主页（/）三块骨架的测试：
// - 路由进来的四种状态：loading（骨架屏）/ error（照实说没读成）/ notWired（整块待实现）/ data（真的有数据，三块各自画出来）。
// - 「verify_pending」「还没验」不画成失败红：卡片上有专属的 badge，不接 fail 颜色。
// - 持续状态条有问题也用提示色，不伪装成失败。

import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { cleanup, render, screen } from '@testing-library/react';
import { MemoryRouter } from 'react-router';
import { afterEach, describe, expect, test, vi } from 'vitest';
import { ApiProvider } from '../src/api/client';
import { createMockApi } from '../src/api/mock/server';
import type { HomeData, HomeState } from '../src/components/home/types';
import { ThemeProvider } from '../src/components/theme-provider';
import { TooltipProvider } from '../src/components/ui/tooltip';
import Home from '../src/routes/home';

// 每次测试换掉 useHome 的返回——home-api 切片还没出来，真的 useHome 写死 NotWired，这里把四态各造一次。
vi.mock('../src/api/client', async () => {
  const actual = await vi.importActual<typeof import('../src/api/client')>('../src/api/client');
  return { ...actual, useHome: vi.fn() };
});

import { useHome } from '../src/api/client';

afterEach(cleanup);

function renderHome(state: HomeState) {
  vi.mocked(useHome).mockReturnValue({ data: state });
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  const api = createMockApi({ live: false });
  return render(
    <MemoryRouter initialEntries={['/']}>
      <QueryClientProvider client={qc}>
        <ApiProvider api={api}>
          <ThemeProvider>
            <TooltipProvider>
              <Home />
            </TooltipProvider>
          </ThemeProvider>
        </ApiProvider>
      </QueryClientProvider>
    </MemoryRouter>,
  );
}

const SAMPLE: HomeData = {
  health: {
    quota: { state: 'tight', detail: '2 个池快清零' },
    routes: { state: 'degraded', detail: '12 在线 · 2 探不通' },
    engine: { state: 'off', detail: '临时调整 · 到 2026-10-05' },
  },
  decisions: [
    {
      kind: 'approval',
      id: 'a-1',
      title: 'PR #421「把路由配置改两层」要审',
      context: 'fleet-dao · 改了调度台的路由装配方式，审一轮再挂自动合并。',
      since: '2026-10-02T08:12:00Z',
      link: '/home3',
    },
    {
      kind: 'ask',
      id: 'q-1',
      title: '#509：v3 第三阶段要不要先开演练场？',
      since: '2026-10-02T06:00:00Z',
      link: '/notifications',
    },
  ],
  running: [
    {
      issueNumber: 556,
      title: '清理：删编排层、删 Fusion',
      repo: 'thoerwink8/fleet-dao',
      segment: 'doing',
      waitingReason: 'nothing',
      link: '/home3',
    },
    {
      issueNumber: 76,
      title: '路由配置改两层',
      repo: 'thoerwink8/fleet-dao',
      segment: 'verify_pending',
      waitingReason: 'ci',
      waitingSince: '2026-10-02T08:30:00Z',
      link: '/home3',
    },
    {
      issueNumber: 450,
      title: '演练场跑通一次三段一条龙',
      repo: 'thoerwink8/fleet-dao',
      segment: 'scoping',
      waitingReason: 'founder_decision',
      waitingSince: '2026-10-01T22:00:00Z',
      link: '/home3',
    },
  ],
  done: [
    {
      prNumber: 421,
      title: 'feat(routing): 把路由配置拆成两层',
      repo: 'thoerwink8/fleet-dao',
      mergedAt: '2026-10-02T04:10:00Z',
      link: 'https://github.com/thoerwink8/fleet-dao/pull/421',
    },
  ],
};

describe('home（/）：四种状态', () => {
  test('loading：三块各给一块骨架屏', () => {
    renderHome({ status: 'loading' });
    expect(document.querySelectorAll('[aria-busy]').length).toBeGreaterThan(0);
    expect(screen.queryByText(/没查成/)).toBeNull();
  });

  test('error：写「没读成」，没有待实现占位', () => {
    renderHome({ status: 'error', error: new Error('500') });
    expect(screen.getByText(/主页没读成/)).toBeTruthy();
    expect(screen.queryByText(/这块还没做/)).toBeNull();
  });

  test('notWired：整块待实现，写明排期和单号；不说没查成', () => {
    renderHome({
      status: 'notWired',
      notWired: { what: '新主页（要你拍的 / 在跑的 / 做完的）', phase: 'v3 主页轮', issue: 556 },
    });
    expect(screen.getByText(/新主页（要你拍的 \/ 在跑的 \/ 做完的） · 待实现/)).toBeTruthy();
    expect(screen.getByText(/#556/)).toBeTruthy();
    expect(screen.queryByText(/没查成/)).toBeNull();
  });

  test('empty：三块都是空的，各自写「还没有」', () => {
    const empty: HomeData = {
      health: SAMPLE.health,
      decisions: [],
      running: [],
      done: [],
    };
    renderHome({ status: 'data', data: empty });
    expect(screen.getByText(/没有要你拍的/)).toBeTruthy();
    expect(screen.getByText(/现在没有在跑的单/)).toBeTruthy();
    expect(screen.getByText(/最近没有合进的 PR/)).toBeTruthy();
    // 状态条是持续显示的，空了三块也还是它。
    expect(screen.getByText(/2 个池快清零/)).toBeTruthy();
  });

  test('data：三块各画出有数据的样子', () => {
    renderHome({ status: 'data', data: SAMPLE });
    // 决策块
    expect(screen.getByText(/PR #421「把路由配置改两层」要审/)).toBeTruthy();
    expect(screen.getByText(/#509：v3 第三阶段要不要先开演练场/)).toBeTruthy();
    // 在跑的块
    expect(screen.getByText('清理：删编排层、删 Fusion')).toBeTruthy();
    expect(screen.getByText('路由配置改两层')).toBeTruthy();
    // 验证 verify_pending 和 founder_decision 可见
    expect(screen.getByText(/还没验/)).toBeTruthy();
    expect(screen.getByText(/等你拍/)).toBeTruthy();
    // 做完的块
    expect(screen.getByText(/feat\(routing\): 把路由配置拆成两层/)).toBeTruthy();
    // 状态条
    expect(screen.getByText(/2 个池快清零/)).toBeTruthy();
    expect(screen.getByText(/12 在线 · 2 探不通/)).toBeTruthy();
    expect(screen.getByText(/引擎关着/)).toBeTruthy();
  });

  test('verify_pending 卡片的 badge 不是 fail 红色（还没验不显示成失败）', () => {
    renderHome({ status: 'data', data: SAMPLE });
    const card = document.querySelector('[data-running-card="verify_pending"]');
    expect(card).toBeTruthy();
    const chip = card?.querySelector('[class*="bg-st-"]');
    expect(chip?.className).toContain('bg-st-stall');
    expect(chip?.className).not.toContain('bg-st-fail');
  });

  test('持续状态条引擎关时用「提示」色（不是失败红）', () => {
    renderHome({ status: 'data', data: SAMPLE });
    const chip = Array.from(document.querySelectorAll('[data-health-chip]')).find((el) =>
      el.textContent?.includes('引擎'),
    );
    expect(chip?.getAttribute('data-health-chip')).toBe('warn');
  });
});
