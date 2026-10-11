// @vitest-environment happy-dom
// 主页（/）三块骨架的测试：
// - 路由进来的四种状态：loading（骨架屏）/ error（照实说没读成）/ notWired（整块待实现）/ data（真的有数据，三块各自画出来）。
// - 「verify_pending」「还没验」不画成失败红：卡片上有专属的 badge，不接 fail 颜色。
// - 「在跑的」是初版那样的思维导图看板（中心 → 三段 → 单子）；手机上是树形列表。
// - 持续状态条有问题也用提示色，不伪装成失败。

import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { cleanup, configure, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { MotionGlobalConfig } from 'motion/react';
import { MemoryRouter } from 'react-router';
import { afterEach, describe, expect, test, vi } from 'vitest';
import { ApiProvider } from '../src/api/client';
import { createMockApi } from '../src/api/mock/server';
import type { HomeData, HomeState } from '../src/components/home/types';
import { TaskActionsProvider } from '../src/components/task-actions';
import { ThemeProvider } from '../src/components/theme-provider';
import { TooltipProvider } from '../src/components/ui/tooltip';
import Home from '../src/routes/home';

// 每次测试换掉 useHome 的返回——home-api 切片还没出来，真的 useHome 写死 NotWired，这里把四态各造一次。
vi.mock('../src/api/client', async () => {
  const actual = await vi.importActual<typeof import('../src/api/client')>('../src/api/client');
  return { ...actual, useHome: vi.fn() };
});

import { useHome } from '../src/api/client';

// 看板详情从右边滑进来（motion）：happy-dom 里卸载时取消动画会抛一个没人接的 AbortError，测试里不放动画
MotionGlobalConfig.skipAnimations = true;

// 画布按需加载，ELK 排完版才挂节点。findBy / waitFor 默认只等 1 秒，CI 上第一次排版会超过。
configure({ asyncUtilTimeout: 10_000 });

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

const openDrawer = (name: RegExp = /要你拍的/) => fireEvent.click(screen.getByRole('button', { name }));

/** 假装屏宽：happy-dom 的 matchMedia 不认我们的断点，按宽度手算 min-width / max-width。 */
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

/** 默认 1366×768（笔记本）：不是手机、不到 1920，抽屉是浮的、默认关着。 */
function renderHome(state: HomeState, width = 1366) {
  viewport(width);
  localStorage.clear();
  vi.mocked(useHome).mockReturnValue({
    data: state,
    refetch: () => Promise.resolve(undefined),
    isFetching: false,
    dataUpdatedAt: state.status === 'data' ? Date.now() : 0,
  });
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  const api = createMockApi({ live: false });
  return render(
    <MemoryRouter initialEntries={['/']}>
      <QueryClientProvider client={qc}>
        <ApiProvider api={api}>
          <ThemeProvider>
            <TooltipProvider>
              <TaskActionsProvider>
                <Home />
              </TaskActionsProvider>
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
    engine: { state: 'off', detail: '这台机器按配置（release.env 的 FLEET_SERVICES）没开引擎' },
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
      kind: 'notification',
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
    expect(screen.getByText(/现在没有在跑的单/)).toBeTruthy();
    // 抽屉里两页各自写「没有」；按钮上的数是 0，不拿空白冒充
    openDrawer();
    expect(screen.getByText(/没有要你拍的/)).toBeTruthy();
    fireEvent.click(screen.getByRole('tab', { name: /做完的/ }));
    expect(screen.getByText(/最近没有合进的 PR/)).toBeTruthy();
    // 状态条是持续显示的，空了三块也还是它。
    expect(screen.getByText(/2 个池快清零/)).toBeTruthy();
  });

  test('1366 宽：画布占满正文区，没有左列；抽屉默认收着，按钮上写要你拍的条数（#1801）', () => {
    renderHome({ status: 'data', data: SAMPLE });
    const body = document.querySelector('[data-home-body]');
    const wrap = document.querySelector('[data-home-canvas-wrap]');
    // 画布容器是正文区里唯一的一栏：撑满（flex-1），前面没有「要你拍的」「做完的」左列
    expect(wrap?.parentElement).toBe(body);
    expect(wrap?.className).toContain('flex-1');
    expect(body?.firstElementChild).toBe(wrap);
    expect(document.querySelector('[data-home-drawer]')).toBeNull();
    expect(document.querySelector('[data-decision-card]')).toBeNull();
    expect(document.querySelector('[class*="xl:grid-cols-3"]')).toBeNull();
    expect(document.querySelector('[class*="xl:col-start-1"]')).toBeNull();
    // 页面标题行去掉了，标题只留给读屏
    expect(document.querySelector('h1')?.className).toContain('sr-only');
    // 抽屉按钮：要你拍的 2 条（醒目色），旁边是做完的
    const button = screen.getByRole('button', { name: /要你拍的 2 条/ });
    expect(button.textContent).toContain('2');
    expect(button.className).toContain('text-ink-human');
    expect(screen.getByRole('button', { name: /做完的/ })).toBeTruthy();
  });

  test('没有要你拍的：按钮写 0、不用醒目色', () => {
    renderHome({ status: 'data', data: { ...SAMPLE, decisions: [] } });
    const button = screen.getByRole('button', { name: /要你拍的 0 条/ });
    expect(button.className).not.toContain('text-ink-human');
  });

  test('点按钮开抽屉：两个分页签，要你拍的单列通栏、时间不换行；Esc 关', () => {
    renderHome({ status: 'data', data: SAMPLE });
    openDrawer();
    const drawer = document.querySelector('[data-home-drawer]');
    expect(drawer?.getAttribute('data-home-drawer')).toBe('floating');
    expect(screen.getAllByRole('tab').map((t) => t.textContent)).toEqual(['要你拍的2', '做完的1']);
    const card = document.querySelector('[data-decision-card]');
    expect(card).toBeTruthy();
    const list = card?.parentElement;
    expect(list?.tagName).toBe('UL');
    expect(list?.className).toBe('grid grid-cols-1 gap-2');
    // 抽屉窄：卡片一直上文下按钮，不随屏宽改成左右排
    expect(card?.className).not.toContain('sm:flex-row');
    const time = card?.querySelector('.whitespace-nowrap');
    expect(time?.className).toContain('text-caption');
    fireEvent.click(screen.getByRole('tab', { name: /做完的/ }));
    expect(document.querySelector('[data-done-card]')).toBeTruthy();
    expect(document.querySelector('[data-decision-card]')).toBeNull();
    fireEvent.keyDown(drawer as Element, { key: 'Escape' });
    expect(document.querySelector('[data-home-drawer]')).toBeNull();
  });

  test('点画布空白处关抽屉；点抽屉按钮本身是切换', () => {
    renderHome({ status: 'data', data: SAMPLE });
    openDrawer();
    expect(document.querySelector('[data-home-drawer]')).toBeTruthy();
    fireEvent.pointerDown(document.querySelector('[data-home-canvas-wrap]') as Element);
    expect(document.querySelector('[data-home-drawer]')).toBeNull();
    openDrawer();
    openDrawer();
    expect(document.querySelector('[data-home-drawer]')).toBeNull();
  });

  test('≥1920 首次打开：抽屉是收起的，按钮照样写条数；点开才停靠成右侧一列（不盖画布），收起状态记在 localStorage（#1819）', async () => {
    renderHome({ status: 'data', data: SAMPLE }, 1920);
    await waitFor(() => expect(document.querySelector('[data-board-now]')).toBeTruthy());
    // 默认收起，和 1366 一致；「此刻」也是收成一行
    expect(document.querySelector('[data-home-drawer]')).toBeNull();
    expect(document.querySelector('[data-decision-card]')).toBeNull();
    const button = screen.getByRole('button', { name: /要你拍的 2 条/ });
    expect(button.className).toContain('text-ink-human');
    expect(document.querySelector('[data-board-now] [aria-expanded]')?.getAttribute('aria-expanded')).toBe(
      'false',
    );
    fireEvent.click(button);
    const drawer = document.querySelector('[data-home-drawer]');
    expect(drawer?.getAttribute('data-home-drawer')).toBe('docked');
    expect(drawer?.className).not.toContain('absolute');
    expect(document.querySelector('[data-decision-card]')).toBeTruthy();
    expect(localStorage.getItem('fleet-dao.home-drawer-collapsed')).toBe('false');
    fireEvent.click(screen.getByRole('button', { name: '收起抽屉' }));
    expect(document.querySelector('[data-home-drawer]')).toBeNull();
    expect(localStorage.getItem('fleet-dao.home-drawer-collapsed')).toBe('true');
  });

  test('1366 和 1920 默认状态一致：抽屉都收起、此刻都收成一行（#1819）', async () => {
    for (const width of [1366, 1920]) {
      renderHome({ status: 'data', data: SAMPLE }, width);
      await waitFor(() => expect(document.querySelector('[data-board-now]')).toBeTruthy());
      expect(document.querySelector('[data-home-drawer]')).toBeNull();
      expect(document.querySelector('[data-board-now] [aria-expanded]')?.getAttribute('aria-expanded')).toBe(
        'false',
      );
      cleanup();
    }
  });

  test('做完的：有标题显示「PR #号」加标题；标题就是「PR #号」时只写一次，并说标题没读到（#1744、#1819）', () => {
    const first = SAMPLE.done[0];
    if (!first) throw new Error('样例没有做完的');
    renderHome({
      status: 'data',
      data: { ...SAMPLE, done: [first, { ...first, prNumber: 1741, title: 'PR #1741' }] },
    });
    openDrawer(/做完的/);
    const cards = document.querySelectorAll('[data-done-card]');
    expect(cards).toHaveLength(2);
    expect(cards[0]?.textContent).toContain('PR #421');
    expect(cards[0]?.textContent).toContain('把路由配置拆成两层');
    expect(cards[0]?.textContent).not.toContain('标题没读到');
    expect(cards[1]?.textContent?.match(/PR #1741/g)).toHaveLength(1);
    expect(cards[1]?.textContent).toContain('（标题没读到）');
  });

  test('做完的：没有任务标题时后端给的是 PR 标题，卡片照写这个标题（#1819）', () => {
    const first = SAMPLE.done[0];
    if (!first) throw new Error('样例没有做完的');
    renderHome({
      status: 'data',
      data: { ...SAMPLE, done: [{ ...first, prNumber: 1742, title: '把夜间备份的超时改成 30 分钟' }] },
    });
    openDrawer(/做完的/);
    const card = document.querySelector('[data-done-card]');
    expect(card?.textContent).toContain('PR #1742');
    expect(card?.textContent).toContain('把夜间备份的超时改成 30 分钟');
    expect(card?.textContent).not.toContain('标题没读到');
  });

  test('手机宽度：健康条和刷新在同一行的同一个父容器里，刷新是图标按钮（#1819）', () => {
    renderHome({ status: 'data', data: SAMPLE }, 390);
    const bar = document.querySelector('[data-home-statusbar]');
    expect(bar).toBeTruthy();
    const strip = bar?.querySelector('[data-health-strip]');
    const refresh = bar?.querySelector('button[aria-label="刷新"]');
    expect(strip).toBeTruthy();
    expect(refresh).toBeTruthy();
    // 同一个父容器，且不换行
    expect(strip?.closest('[data-home-statusbar]')).toBe(refresh?.closest('[data-home-statusbar]'));
    expect(bar?.className).toContain('flex-nowrap');
    // 三个状态点（额度、中转、引擎），不是三格带字的药丸
    expect(strip?.querySelectorAll('[data-health-chip]')).toHaveLength(3);
    expect(strip?.textContent).toBe('');
    // 刷新是图标按钮：没有文字，只有 aria-label
    expect(refresh?.textContent).toBe('');
    expect(refresh?.querySelector('svg')).toBeTruthy();
    // 新鲜度点在同一行
    expect(bar?.querySelector('[data-freshness]')).toBeTruthy();
    expect(bar?.textContent).not.toContain('最后更新');
  });

  test('详情面板的操作行右边没有孤立的竖线（#1819）', async () => {
    const withTask = SAMPLE.running.map((r) => (r.issueNumber === 556 ? { ...r, taskId: 't-556' } : r));
    renderHome({ status: 'data', data: { ...SAMPLE, running: withTask } });
    const node = () => document.querySelector('.react-flow__node[data-id^="ticket:556"]');
    await waitFor(() => expect(node()).toBeTruthy());
    fireEvent.click(node() as Element);
    const actions = await waitFor(() => {
      const el = document.querySelector('[data-board-detail] [data-task-actions]');
      expect(el).toBeTruthy();
      return el as HTMLElement;
    });
    expect(actions?.className).not.toMatch(/(^|\s)border-r(\s|$)/);
    expect(actions?.className).not.toContain('pr-3');
  });

  test('data：三块各画出有数据的样子', async () => {
    renderHome({ status: 'data', data: SAMPLE });
    // 「在跑的」画布按需加载、排完版才有卡片
    await screen.findByText('清理：删编排层、删 Fusion');
    // 决策块（在抽屉里）
    openDrawer();
    expect(screen.getByText(/PR #421「把路由配置改两层」要审/)).toBeTruthy();
    expect(screen.getByText(/#509：v3 第三阶段要不要先开演练场/)).toBeTruthy();
    // 在跑的块
    expect(screen.getByText('清理：删编排层、删 Fusion')).toBeTruthy();
    expect(screen.getByText('路由配置改两层')).toBeTruthy();
    // 验证 verify_pending 和 founder_decision 可见
    expect(document.querySelector('[data-running-card="verify_pending"]')?.textContent).toContain('还没验');
    expect(document.querySelector('[data-running-card="scoping"]')?.textContent).toContain('等你拍');
    // 做完的块（抽屉里的另一页）
    fireEvent.click(screen.getByRole('tab', { name: /做完的/ }));
    expect(screen.getByText(/feat\(routing\): 把路由配置拆成两层/)).toBeTruthy();
    // 状态条
    expect(screen.getByText(/2 个池快清零/)).toBeTruthy();
    expect(screen.getByText(/12 在线 · 2 探不通/)).toBeTruthy();
    // 引擎那一格（看板中心节点上也写一遍，这里只认状态条里的）
    expect(
      Array.from(document.querySelectorAll('[data-health-chip]')).some((el) =>
        /引擎进程已停用/.test(el.textContent ?? ''),
      ),
    ).toBe(true);
  });

  test('verify_pending 卡片的 badge 不是 fail 红色（还没验不显示成失败）', async () => {
    renderHome({ status: 'data', data: SAMPLE });
    await waitFor(() => expect(document.querySelector('[data-running-card="verify_pending"]')).toBeTruthy());
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

describe('home（/）：在跑的思维导图看板（初版看板的样子，数据是三段流水）', () => {
  // 画布按需加载、ELK 排完版才挂节点：都要等
  const nodeOf = (prefix: string) => document.querySelector(`.react-flow__node[data-id^="${prefix}"]`);
  const waitBoard = () =>
    waitFor(() => expect(document.querySelector('[data-flow-lane="scope"]')).toBeTruthy());

  test('中心一个、三段固定对题 → 动手 → 验收，段上写在途数和平均耗时；没有样本写「还没有跑完的样本」，不写 0', async () => {
    renderHome({ status: 'data', data: SAMPLE });
    await waitBoard();
    expect(nodeOf('root')).toBeTruthy();
    const lanes = Array.from(document.querySelectorAll('[data-flow-lane]'));
    expect(lanes.map((l) => l.getAttribute('data-flow-lane'))).toEqual(['scope', 'manual', 'verify']);
    expect(lanes[0]?.textContent).toContain('对题');
    expect(lanes[0]?.textContent).toContain('平均 8 分钟 · 5 笔');
    expect(lanes[1]?.textContent).toContain('平均 41 分钟 · 4 笔');
    expect(lanes[2]?.textContent).toContain('还没有跑完的样本');
    expect(lanes[2]?.textContent).not.toMatch(/平均 0/);
  });

  test('此刻表头不换行：分钟列有表头，表头和耗时都单行', async () => {
    localStorage.clear();
    const since = new Date(Date.now() - 40 * 60_000).toISOString();
    renderHome({
      status: 'data',
      data: {
        ...SAMPLE,
        running: SAMPLE.running.map((item) => (item.worker ? { ...item, stageSince: since } : item)),
      },
    });
    const toggle = await screen.findByRole('button', { name: /个会话在干活/ });
    if (toggle.getAttribute('aria-expanded') !== 'true') fireEvent.click(toggle);
    const panel = document.querySelector('[data-board-now]');
    const heads = Array.from(panel?.querySelectorAll('th') ?? []);
    expect(heads.map((el) => el.textContent?.trim())).toEqual(['谁在做', '单', '在做什么', '分钟']);
    for (const th of heads) expect(th.className).toContain('whitespace-nowrap');
    const minuteHead = heads.find((el) => el.textContent?.trim() === '分钟');
    expect(minuteHead?.className).toContain('w-36');
    const minute = Array.from(panel?.querySelectorAll('td') ?? []).find(
      (el) => el.textContent?.trim() === '40 分钟',
    );
    expect(minute?.className).toContain('whitespace-nowrap');
    expect(minute?.className).toContain('w-36');
    localStorage.clear();
  });

  test('对题没有样本（#761：在对话里做的，runs 里本来就没有）写「不计」；动手、验收没有样本照旧写「还没有跑完的样本」', async () => {
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
    await waitBoard();
    const lanes = Array.from(document.querySelectorAll('[data-flow-lane]'));
    expect(lanes[0]?.textContent).toContain('在对话里做的，不计耗时');
    expect(lanes[1]?.textContent).toContain('还没有跑完的样本');
    expect(lanes[1]?.textContent).not.toContain('不计');
    expect(lanes[2]?.textContent).not.toContain('不计');
  });

  test('卡片：单号、标题、谁在做、本段待了多久、最近事件；等你拍的有标记、要拍的事另挂一片叶子', async () => {
    renderHome({ status: 'data', data: SAMPLE });
    await waitBoard();
    const doing = nodeOf('ticket:556');
    expect(doing?.textContent).toContain('#556');
    expect(doing?.textContent).toContain('Opus 5.5');
    expect(doing?.textContent).toContain('本段');
    const stage = Array.from(doing?.querySelectorAll('span') ?? []).find((el) =>
      (el.textContent ?? '').includes('本段'),
    );
    expect(stage?.className).toContain('whitespace-nowrap');
    expect(doing?.textContent).toContain('最近：动手开跑 · Opus 5.5');
    const asking = nodeOf('ticket:450');
    expect(asking?.querySelector('[data-needs-founder="true"]')).toBeTruthy();
    expect(asking?.textContent).toContain('要你拍：要不要先开演练场？');
    expect(asking?.textContent).toContain('没有进程在跑');
    expect(nodeOf('ask:450')?.textContent).toContain('要不要先开演练场？');
  });

  test('卡片右上角的链接进单子详情（站内任务页）', async () => {
    renderHome({ status: 'data', data: SAMPLE });
    await waitBoard();
    expect(nodeOf('ticket:556')?.querySelector('a')?.getAttribute('href')).toBe('/home3');
  });

  test('单击卡片：右边滑出详情，写在哪一段、谁在做、在等什么，底下「打开单子详情」', async () => {
    renderHome({ status: 'data', data: SAMPLE });
    await waitBoard();
    fireEvent.click(nodeOf('ticket:76') as Element);
    const panel = await waitFor(() => {
      const el = document.querySelector('[data-board-detail]');
      expect(el).toBeTruthy();
      return el as HTMLElement;
    });
    expect(panel.textContent).toContain('路由配置改两层');
    expect(panel.textContent).toContain('等 CI 走完');
    expect(panel.textContent).toContain('还没验');
    expect(
      within(panel)
        .getByRole('link', { name: /打开单子详情/ })
        .getAttribute('href'),
    ).toBe('/home3');
  });

  test('出问题（超时 / 失败）的卡画成 fail 红，和「还没验」「在等」分开', async () => {
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
    await waitFor(() => expect(nodeOf('ticket:1:')).toBeTruthy());
    const bad = nodeOf('ticket:1:');
    expect(bad?.querySelector('[class*="bg-st-fail"]')).toBeTruthy();
    expect(bad?.textContent).toContain('动手超时：30 分钟没交活');
    const pending = nodeOf('ticket:2:');
    expect(pending?.querySelector('[class*="bg-st-fail"]')).toBeNull();
    expect(pending?.textContent).toContain('等第二意见');
  });

  test('单子多：一张不少全画上（画布能缩放、收进视野），不合成「还有 N 张」', async () => {
    const running = Array.from({ length: 8 }, (_, i) => ticket(100 + i));
    renderHome({ status: 'data', data: { ...SAMPLE, running } });
    await waitFor(() =>
      expect(document.querySelectorAll('.react-flow__node[data-id^="ticket:"]').length).toBe(8),
    );
  });

  test('超长标题：最多两行截断、悬停能看全，不撑破卡片', async () => {
    const long = '一个非常非常长的标题'.repeat(12);
    renderHome({ status: 'data', data: { ...SAMPLE, running: [ticket(7, { title: long })] } });
    await waitFor(() => expect(nodeOf('ticket:7:')).toBeTruthy());
    const titleEl = nodeOf('ticket:7:')?.querySelector(`[title="${long}"]`);
    expect(titleEl?.className).toContain('line-clamp-2');
  });

  test('推不出在哪一段的单（segment=null）挂在「还没分段」下面，且只在有这样的单时才出现', async () => {
    renderHome({ status: 'data', data: { ...SAMPLE, running: [ticket(9, { segment: null })] } });
    await waitFor(() => expect(document.querySelector('[data-flow-lane="none"]')).toBeTruthy());
    expect(
      Array.from(document.querySelectorAll('[data-flow-lane]')).map((l) => l.getAttribute('data-flow-lane')),
    ).toEqual(['scope', 'manual', 'verify', 'none']);
    cleanup();
    renderHome({ status: 'data', data: SAMPLE });
    await waitBoard();
    expect(document.querySelector('[data-flow-lane="none"]')).toBeNull();
  });

  test('「只看卡住的」：只剩出问题的单，不含等你拍；三段还在；工具条写「几 / 几 张单」', async () => {
    const running = [
      ...SAMPLE.running,
      ticket(14, {
        lastEvent: { text: '动手超时：30 分钟没交活', at: '2026-10-02T08:00:00Z', tone: 'trouble' },
      }),
    ];
    renderHome({ status: 'data', data: { ...SAMPLE, running } });
    await waitBoard();
    fireEvent.click(screen.getByRole('button', { name: /只看卡住的/ }));
    await waitFor(() =>
      expect(
        Array.from(document.querySelectorAll('.react-flow__node[data-id^="ticket:"]')).map((n) =>
          n.getAttribute('data-id'),
        ),
      ).toEqual(['ticket:14:thoerwink8/fleet-dao']),
    );
    expect(document.querySelectorAll('[data-flow-lane]').length).toBe(3);
    expect(document.querySelector('[data-board-toolbar]')?.textContent).toMatch(/1\s*\/\s*4\s*张单/);
  });

  test('「只看等你的」：只剩等你拍的单，不含出问题', async () => {
    const running = [
      ...SAMPLE.running,
      ticket(14, {
        lastEvent: { text: '动手超时：30 分钟没交活', at: '2026-10-02T08:00:00Z', tone: 'trouble' },
      }),
    ];
    renderHome({ status: 'data', data: { ...SAMPLE, running } });
    await waitBoard();
    fireEvent.click(screen.getByRole('button', { name: /只看等你的/ }));
    await waitFor(() =>
      expect(
        Array.from(document.querySelectorAll('.react-flow__node[data-id^="ticket:"]')).map((n) =>
          n.getAttribute('data-id'),
        ),
      ).toEqual(['ticket:450:thoerwink8/fleet-dao']),
    );
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

describe('home（/）：引擎那一格（#902 D7）', () => {
  const engineChip = () =>
    Array.from(document.querySelectorAll('[data-health-chip]')).find((el) =>
      el.textContent?.includes('引擎'),
    );
  const withEngine = (engine: HomeData['health']['engine']): HomeData => ({
    ...SAMPLE,
    health: { ...SAMPLE.health, engine },
  });

  test('on：写「引擎进程 正常」，不标色', () => {
    renderHome({ status: 'data', data: withEngine({ state: 'on' }) });
    expect(engineChip()?.getAttribute('data-health-chip')).toBe('ok');
    expect(engineChip()?.textContent).toContain('引擎进程');
    expect(engineChip()?.textContent).toContain('正常');
  });

  test('down：写「引擎进程没连上」和原因，标红（bad），绝不写「正常」', () => {
    renderHome({
      status: 'data',
      data: withEngine({ state: 'down', detail: '任务队列上没有在拉活的引擎工人（没起来或卡住了）' }),
    });
    const chip = engineChip();
    expect(chip?.getAttribute('data-health-chip')).toBe('bad');
    expect(chip?.className).toContain('border-st-fail');
    expect(chip?.textContent).toContain('引擎进程没连上');
    expect(chip?.textContent).toContain('没有在拉活的引擎工人');
    expect(chip?.textContent).not.toContain('正常');
  });

  test('off：写「引擎进程已停用」，用提示色（warn）不是红', () => {
    renderHome({
      status: 'data',
      data: withEngine({ state: 'off', detail: '这台机器按配置（release.env 的 FLEET_SERVICES）没开引擎' }),
    });
    expect(engineChip()?.getAttribute('data-health-chip')).toBe('warn');
    expect(engineChip()?.textContent).toContain('引擎进程已停用');
    expect(engineChip()?.className).not.toContain('border-st-fail');
  });

  test('unknown：名字带「引擎进程」，写「没查成」，灰虚线，不写正常', () => {
    renderHome({ status: 'data', data: withEngine({ state: 'unknown' }) });
    expect(engineChip()?.getAttribute('data-health-chip')).toBe('muted');
    expect(engineChip()?.textContent).toContain('引擎进程');
    expect(engineChip()?.textContent).toContain('没查成');
    expect(engineChip()?.textContent).not.toContain('正常');
  });
});

describe('home（/）：手机上看板退化成树形列表，一张单一行（#1801）', () => {
  const PHONE = 390;
  const rows = () => Array.from(document.querySelectorAll('[data-ticket-row]'));

  test('手机宽度：没有画布，一段一组、每张单一行摘要，默认不展开细节', () => {
    renderHome({ status: 'data', data: SAMPLE }, PHONE);
    expect(document.querySelector('[data-board-tree]')).toBeTruthy();
    expect(document.querySelector('.react-flow')).toBeNull();
    expect(
      Array.from(document.querySelectorAll('[data-flow-lane]')).map((l) => l.getAttribute('data-flow-lane')),
    ).toEqual(['scope', 'manual', 'verify']);
    expect(rows()).toHaveLength(SAMPLE.running.length);
    // 默认不展开：整张卡（谁在做、最近事件）一张都没渲染
    expect(document.querySelector('[data-running-card]')).toBeNull();
    // 一行摘要：单号、标题、所处段
    const doing = document.querySelector('[data-ticket-row="556"]');
    expect(doing?.textContent).toContain('#556');
    expect(doing?.textContent).toContain('清理：删编排层、删 Fusion');
    expect(doing?.textContent).toContain('在动手');
    expect(doing?.querySelector('[data-ticket-toggle]')?.getAttribute('aria-expanded')).toBe('false');
  });

  test('点一行原地展开成整张卡（进详情的链接在里面），再点收回；别的行不受影响', () => {
    renderHome({ status: 'data', data: SAMPLE }, PHONE);
    const toggle = document.querySelector('[data-ticket-row="556"] [data-ticket-toggle]') as Element;
    fireEvent.click(toggle);
    expect(toggle.getAttribute('aria-expanded')).toBe('true');
    expect(document.querySelectorAll('[data-running-card]')).toHaveLength(1);
    const card = document.querySelector('[data-ticket-row="556"] [data-running-card="doing"]');
    expect(card?.textContent).toContain('Opus 5.5');
    expect(card?.querySelector('a')?.getAttribute('href')).toBe('/home3');
    fireEvent.click(toggle);
    expect(document.querySelector('[data-running-card]')).toBeNull();
  });

  test('手机上要你拍的是列表顶上一条横条（有才写件数），点开是底部抽屉；顶上没有画布右上角的按钮', async () => {
    renderHome({ status: 'data', data: SAMPLE }, PHONE);
    expect(screen.queryByRole('button', { name: /打开抽屉/ })).toBeNull();
    const strip = document.querySelector('[data-home-strip]') as HTMLElement;
    expect(strip.textContent).toContain('2 件要你拍的');
    fireEvent.click(strip);
    expect(await screen.findByRole('dialog')).toBeTruthy();
    expect(document.querySelector('[data-decision-card]')).toBeTruthy();
    cleanup();
    renderHome({ status: 'data', data: { ...SAMPLE, decisions: [] } }, PHONE);
    expect((document.querySelector('[data-home-strip]') as HTMLElement).textContent).not.toContain(
      '件要你拍的',
    );
  });

  test('手机上的按钮都不小于 40×40（diff 里看得见尺寸类）', () => {
    renderHome({ status: 'data', data: SAMPLE }, PHONE);
    for (const el of document.querySelectorAll(
      '[data-ticket-toggle], [data-home-strip], [data-board-tree] > div > button',
    )) {
      expect(el.className, el.textContent ?? '').toMatch(/\bmin-h-11\b|\bh-10\b/);
    }
  });

  test('手机上「只看卡住的」不含等你拍；「只看等你的」只留等你拍', () => {
    const running = [
      ...SAMPLE.running,
      ticket(14, {
        lastEvent: { text: '动手超时', at: '2026-10-02T08:00:00Z', tone: 'trouble' },
      }),
    ];
    renderHome({ status: 'data', data: { ...SAMPLE, running } }, PHONE);
    fireEvent.click(screen.getByRole('button', { name: /只看卡住的/ }));
    expect(rows()).toHaveLength(1);
    expect(rows()[0]?.textContent).toContain('#14');
    fireEvent.click(screen.getByRole('button', { name: /只看卡住的/ }));
    fireEvent.click(screen.getByRole('button', { name: /只看等你的/ }));
    expect(rows()).toHaveLength(1);
    expect(rows()[0]?.textContent).toContain('#450');
  });
});
