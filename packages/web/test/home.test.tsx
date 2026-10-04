// @vitest-environment happy-dom
// 主页（/）三块骨架的测试：
// - 路由进来的四种状态：loading（骨架屏）/ error（照实说没读成）/ notWired（整块待实现）/ data（真的有数据，三块各自画出来）。
// - 「verify_pending」「还没验」不画成失败红：卡片上有专属的 badge，不接 fail 颜色。
// - 持续状态条有问题也用提示色，不伪装成失败。

import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
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
  flow: [
    { segment: 'scope', inFlight: 1, avgMs: 8 * 60_000, samples: 5 },
    { segment: 'manual', inFlight: 1, avgMs: 41 * 60_000, samples: 4 },
    { segment: 'verify', inFlight: 1, samples: 0 },
  ],
  running: [
    {
      issueNumber: 556,
      title: '清理：删编排层、删 Fusion',
      repo: 'thoerwink8/fleet-dao',
      segment: 'doing',
      waitingReason: 'nothing',
      taskSince: '2026-10-02T02:00:00Z',
      stageSince: '2026-10-02T08:00:00Z',
      worker: 'Opus 5.5',
      lastEvent: { text: '动手开跑 · Opus 5.5', at: '2026-10-02T08:00:00Z', tone: 'ok' },
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
      pendingDecision: '要不要先开演练场？',
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
      flow: SAMPLE.flow,
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
    expect(document.querySelector('[data-running-card="verify_pending"]')?.textContent).toContain('还没验');
    expect(document.querySelector('[data-running-card="scoping"]')?.textContent).toContain('等你拍');
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

function ticket(n: number, over: Partial<HomeData['running'][number]> = {}): HomeData['running'][number] {
  return {
    issueNumber: n,
    title: `第 ${n} 张单`,
    repo: 'thoerwink8/fleet-dao',
    segment: 'doing',
    waitingReason: 'nothing',
    link: `/tasks/t-${n}`,
    ...over,
  };
}

describe('home（/）：三段流水线图', () => {
  test('三条泳道固定对题 → 动手 → 验收，头上写在途数和平均耗时；没有样本写「还没有跑完的样本」，不写 0', () => {
    renderHome({ status: 'data', data: SAMPLE });
    const lanes = Array.from(document.querySelectorAll('[data-flow-lane]'));
    expect(lanes.map((l) => l.getAttribute('data-flow-lane'))).toEqual(['scope', 'manual', 'verify']);
    expect(lanes[0]?.textContent).toContain('对题');
    expect(lanes[0]?.textContent).toContain('平均 8 分钟 · 5 笔');
    expect(lanes[1]?.textContent).toContain('平均 41 分钟 · 4 笔');
    expect(lanes[2]?.textContent).toContain('还没有跑完的样本');
    expect(lanes[2]?.textContent).not.toMatch(/平均 0/);
  });

  test('对题没有样本（#761：在对话里做的，runs 里本来就没有）写「不计」；动手、验收没有样本照旧写「还没有跑完的样本」，不写成不计', () => {
    renderHome({
      status: 'data',
      data: {
        ...SAMPLE,
        flow: [
          { segment: 'scope', inFlight: 0, samples: 0 },
          { segment: 'manual', inFlight: 0, samples: 0 },
          { segment: 'verify', inFlight: 0, samples: 0 },
        ],
      },
    });
    const lanes = Array.from(document.querySelectorAll('[data-flow-lane]'));
    expect(lanes[0]?.textContent).toContain('在对话里做的，不计耗时');
    expect(lanes[0]?.textContent).not.toContain('还没有跑完的样本');
    expect(lanes[1]?.textContent).toContain('还没有跑完的样本');
    expect(lanes[1]?.textContent).not.toContain('不计');
    expect(lanes[2]?.textContent).toContain('还没有跑完的样本');
    expect(lanes[2]?.textContent).not.toContain('不计');
  });

  test('卡片：单号、标题、谁在做、本段待了多久、最近事件；等你拍的有标记和要拍的事', () => {
    renderHome({ status: 'data', data: SAMPLE });
    const doing = document.querySelector('[data-id^="ticket:556"]');
    expect(doing?.textContent).toContain('#556');
    expect(doing?.textContent).toContain('Opus 5.5');
    expect(doing?.textContent).toContain('本段');
    expect(doing?.textContent).toContain('最近：动手开跑 · Opus 5.5');
    const asking = document.querySelector('[data-id^="ticket:450"]');
    expect(asking?.querySelector('[data-needs-founder="true"]')).toBeTruthy();
    expect(asking?.textContent).toContain('要你拍：要不要先开演练场？');
    expect(asking?.textContent).toContain('没有进程在跑');
  });

  test('点卡片进单子详情（链接指向任务页）', () => {
    renderHome({ status: 'data', data: SAMPLE });
    const link = document.querySelector('[data-id^="ticket:556"] a');
    expect(link?.getAttribute('href')).toBe('/home3');
  });

  test('出问题（超时 / 失败）的卡画成 fail 红，和「还没验」「在等」分开', () => {
    renderHome({
      status: 'data',
      data: {
        ...SAMPLE,
        running: [
          ticket(1, {
            lastEvent: { text: '动手超时：30 分钟没交活', at: '2026-10-02T08:00:00Z', tone: 'trouble' },
          }),
          ticket(2, { segment: 'verify_pending', waitingReason: 'verify_round' }),
        ],
      },
    });
    const bad = document.querySelector('[data-id^="ticket:1:"]');
    expect(bad?.querySelector('[class*="bg-st-fail"]')).toBeTruthy();
    expect(bad?.textContent).toContain('动手超时：30 分钟没交活');
    const pending = document.querySelector('[data-id^="ticket:2:"]');
    expect(pending?.querySelector('[class*="bg-st-fail"]')).toBeNull();
    expect(pending?.textContent).toContain('等第二意见');
  });

  test('一条泳道里单子多：只摆前 5 张，多的合成「还有 N 张」，不是丢掉', () => {
    const running = Array.from({ length: 8 }, (_, i) => ticket(100 + i));
    renderHome({ status: 'data', data: { ...SAMPLE, running } });
    expect(document.querySelectorAll('[data-id^="ticket:"]').length).toBe(5);
    expect(document.querySelector('[data-id="more:manual"]')?.textContent).toContain('还有 3 张');
  });

  test('超长标题：一行截断、悬停能看全，不撑破卡片', () => {
    const long = '一个非常非常长的标题'.repeat(12);
    renderHome({ status: 'data', data: { ...SAMPLE, running: [ticket(7, { title: long })] } });
    const link = document.querySelector('[data-id^="ticket:7:"] a');
    expect(link?.getAttribute('title')).toBe(long);
    const titleEl = Array.from(link?.querySelectorAll('span') ?? []).find((el) => el.textContent === long);
    expect(titleEl?.className).toContain('truncate');
  });

  test('推不出在哪一段的单（segment=null）落进「还没分段」泳道，且只在有这样的单时才出现', () => {
    renderHome({ status: 'data', data: { ...SAMPLE, running: [ticket(9, { segment: null })] } });
    const lanes = Array.from(document.querySelectorAll('[data-flow-lane]')).map((l) =>
      l.getAttribute('data-flow-lane'),
    );
    expect(lanes).toEqual(['scope', 'manual', 'verify', 'none']);
    expect(screen.getByText('还没分段')).toBeTruthy();
    cleanup();
    renderHome({ status: 'data', data: SAMPLE });
    expect(document.querySelector('[data-flow-lane="none"]')).toBeNull();
  });

  test('读不到：写明没读成并带「重试」，点了真的重试；不是空图', () => {
    const retry = vi.fn();
    renderHome({ status: 'error', error: new Error('500'), retry });
    expect(screen.getByText(/主页没读成：500/)).toBeTruthy();
    expect(document.querySelector('[data-flow-board]')).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: '重试' }));
    expect(retry).toHaveBeenCalledTimes(1);
  });

  test('没给重试函数时「重试」照样有：点了重读所有读失败的查询（LoadError 的兜底，#902 D5），不是点了没用的按钮', () => {
    renderHome({ status: 'error', error: new Error('500') });
    expect(screen.getByRole('button', { name: '重试' })).toBeTruthy();
  });
});
