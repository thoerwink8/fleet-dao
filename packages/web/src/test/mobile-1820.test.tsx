// @vitest-environment happy-dom
// 手机端通用（#1820）：筛选标签 ≥40、页头说明收起成「ⓘ」、刷新是图标按钮、任务详情首屏一行摘要、
// 通知操作和标题同一行、法国页「本台六项事实」一行一项、额度格点一下弹说明。
// 屏宽用 matchMedia 假装：happy-dom 不认我们的断点，按宽度手算 min-width / max-width。
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { Route, Routes } from 'react-router';
import { afterEach, describe, expect, test, vi } from 'vitest';
import type { EnvResponse, QuotaWindowView } from '../api/types';
import { factCells } from '../components/env-facts';
import { filterTabClass } from '../components/filter-tabs';
import { Page } from '../components/page';
import { QuotaLine } from '../components/quota';
import { RefreshBar } from '../components/refresh-bar';
import NotificationsPage from '../routes/notifications';
import TaskPage from '../routes/task';
import TasksPage from '../routes/tasks';
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

describe('筛选标签手机上不小于 40', () => {
  test('标签类名带 max-md:min-h-10；选中与否都带', () => {
    expect(filterTabClass(true)).toContain('max-md:min-h-10');
    expect(filterTabClass(false)).toContain('max-md:min-h-10');
  });

  test('任务列表的状态标签用的就是它，条上带渐隐提示用的类', async () => {
    renderApp(<TasksPage />, { route: '/tasks' });
    const tabs = await screen.findAllByRole('tab');
    expect(tabs.length).toBeGreaterThan(3);
    for (const tab of tabs) expect(tab.className).toContain('max-md:min-h-10');
    expect((screen.getByRole('tablist') as HTMLElement).className).toContain('fade-edges-x');
  });
});

describe('页头说明与刷新', () => {
  test('手机：说明收起，只有「ⓘ」；点开才看到', async () => {
    viewport(390);
    renderApp(
      <Page title="某页" description="这页是做什么的一句说明。">
        <p>正文</p>
      </Page>,
    );
    expect(screen.queryByText('这页是做什么的一句说明。')).toBeNull();
    fireEvent.click(document.querySelector('[data-description-hint]') as HTMLElement);
    expect(await screen.findByText('这页是做什么的一句说明。')).toBeTruthy();
  });

  test('电脑：说明直接写在标题下，没有「ⓘ」', () => {
    viewport(1366);
    renderApp(
      <Page title="某页" description="这页是做什么的一句说明。">
        <p>正文</p>
      </Page>,
    );
    expect(screen.getByText('这页是做什么的一句说明。')).toBeTruthy();
    expect(document.querySelector('[data-description-hint]')).toBeNull();
  });

  test('keepDescription：手机上说明也直接写出来', () => {
    viewport(390);
    renderApp(
      <Page title="某页" description="关键信息" keepDescription>
        <p>正文</p>
      </Page>,
    );
    expect(screen.getByText('关键信息')).toBeTruthy();
    expect(document.querySelector('[data-description-hint]')).toBeNull();
  });

  test('手机：刷新是图标按钮（名字留给读屏），「最后更新」还在；电脑是带字的按钮', () => {
    viewport(390);
    const onRefresh = vi.fn();
    const { unmount } = render(
      <RefreshBar
        onRefresh={onRefresh}
        isFetching={false}
        dataUpdatedAt={Date.now()}
        staleAfterMs={60_000}
      />,
    );
    const icon = screen.getByRole('button', { name: '刷新' });
    expect(icon.hasAttribute('data-refresh-icon')).toBe(true);
    expect(icon.textContent).toBe('');
    expect(screen.getByRole('status').textContent).toContain('最后更新');
    fireEvent.click(icon);
    expect(onRefresh).toHaveBeenCalledTimes(1);
    unmount();

    viewport(1366);
    render(
      <RefreshBar
        onRefresh={onRefresh}
        isFetching={false}
        dataUpdatedAt={Date.now()}
        staleAfterMs={60_000}
      />,
    );
    const word = screen.getByRole('button', { name: '刷新' });
    expect(word.hasAttribute('data-refresh-icon')).toBe(false);
    expect(word.textContent).toBe('刷新');
  });
});

describe('任务详情手机首屏一行摘要', () => {
  const open = () =>
    renderApp(
      <Routes>
        <Route path="/tasks/:taskId" element={<TaskPage />} />
      </Routes>,
      { route: '/tasks/t-c9' },
    );

  test('手机：默认一行摘要，统计卡收着；点开才出四张卡', async () => {
    viewport(390);
    open();
    const summary = await waitFor(() => {
      const el = document.querySelector('[data-stats-summary]');
      if (!el) throw new Error('还没出摘要');
      return el as HTMLElement;
    });
    expect(summary.getAttribute('aria-expanded')).toBe('false');
    // 耗时 · 花费 · 段，一行
    expect(summary.textContent).toMatch(/(共|已用) .+ · .+ · \d+ 段/);
    expect(document.querySelector('[data-segment-stats] .grid')).toBeNull();
    expect(screen.queryByText('输入当量')).toBeNull();

    fireEvent.click(summary);
    expect(summary.getAttribute('aria-expanded')).toBe('true');
    const grid = document.querySelector('[data-segment-stats] .grid') as HTMLElement;
    expect(grid.children.length).toBe(4);
    expect(screen.getByText('输入当量')).toBeTruthy();
  });

  test('电脑：没有摘要，四张卡直接铺开', async () => {
    viewport(1366);
    open();
    await screen.findByText('输入当量');
    expect(document.querySelector('[data-stats-summary]')).toBeNull();
  });

  test('手机：任务页头的状态行不收起（它是关键信息）', async () => {
    viewport(390);
    open();
    await screen.findByRole('heading', { name: '每一笔' });
    expect(document.querySelector('[data-description-hint]')).toBeNull();
    expect(screen.getByText(/开单/)).toBeTruthy();
  });
});

describe('通知操作和标题同一行', () => {
  test('一条通知是一行横排（不再 flex-col 把按钮挤到下一行），操作区在右侧、手机上是图标按钮', async () => {
    renderApp(<NotificationsPage />, { route: '/notifications' });
    const actions = await waitFor(() => {
      const el = document.querySelector('[data-notice-actions]');
      if (!el) throw new Error('还没出通知');
      return el as HTMLElement;
    });
    const row = actions.closest('li') as HTMLElement;
    expect(row.className).toContain('items-start');
    expect(row.className).not.toContain('flex-col');
    // 按钮的文字手机上只给读屏（sr-only），可见的是图标
    const done = within(actions).getByRole('button', { name: '处理了' });
    expect(done.className).toContain('max-md:w-10');
    expect(done.querySelector('.max-md\\:sr-only')?.textContent).toBe('处理了');
  });
});

describe('法国页本台六项事实：手机一行一项', () => {
  const facts: EnvResponse['facts'] = {
    engine: { ok: true, value: { state: 'on', detail: '探到了在拉活的工人' } },
    version: {
      ok: true,
      value: { current: 'abcdef1234567890', behind: 3, detail: '落后主线 3 个提交', problems: [] },
    },
    sessions: { ok: true, value: { total: 2, byStage: {} } },
    pools: { ok: true, value: { count: 3, running: 1, unread: 0, stale: 1 } },
    health: { ok: false, reason: '健康接口超时' },
    schedule: {
      ok: true,
      value: { status: 'fresh', lastSuccessAt: '2026-10-05T01:55:00.000Z', outcome: 'ok', scanned: 4 },
    },
  };
  const cells = () => (
    <div>{factCells({ facts, now: Date.parse('2026-10-05T02:00:00Z'), kind: 'france', look: 'tile' })}</div>
  );

  test('手机：六项各一行（名字、状态点、一句话），默认不展开，点开才见原来那一整格', () => {
    viewport(390);
    render(cells());
    const rows = document.querySelectorAll('[data-france-fact]');
    expect(rows).toHaveLength(6);
    for (const r of rows) {
      expect(r.getAttribute('data-fact-folded')).toBe('closed');
      expect(r.querySelector('[data-fact-summary]')).toBeTruthy();
      expect(r.querySelector('button')?.getAttribute('aria-expanded')).toBe('false');
    }
    // 没查成的那项一行里也写明原因
    const health = rows[3] as HTMLElement;
    expect(health.getAttribute('data-france-fact')).toBe('unread');
    expect(health.textContent).toContain('没查成');
    expect(health.textContent).toContain('健康接口超时');

    const engine = rows[0] as HTMLElement;
    expect(engine.textContent).not.toContain('在拉活的工人 ·');
    fireEvent.click(within(engine).getByRole('button'));
    expect(engine.getAttribute('data-fact-folded')).toBe('open');
    expect(engine.querySelector('button')?.getAttribute('aria-expanded')).toBe('true');
  });

  test('电脑：还是六张整卡，没有折叠行', () => {
    viewport(1366);
    render(cells());
    expect(document.querySelectorAll('[data-france-fact]')).toHaveLength(6);
    expect(document.querySelector('[data-fact-folded]')).toBeNull();
  });
});

describe('额度窗口格点一下弹出说明', () => {
  const NOW = Date.parse('2026-09-25T10:00:00Z');
  const w: QuotaWindowView = {
    window: '5h',
    label: '5h',
    unit: 'percent',
    source: 'claude-usage',
    reading: 'measured',
    readAt: new Date(NOW - 4 * 60_000).toISOString(),
    stale: true,
    utilization: 0.18,
    resetsAt: new Date(NOW + 38 * 60_000).toISOString(),
    upstreamStatus: 'warning',
    statusRaw: 'allowed_warning',
  };

  test('点格子才弹出说明：读数过期、上游状态、上游原话、读法都在；没点时没有', async () => {
    render(<QuotaLine w={w} now={NOW} />);
    expect(document.querySelector('[data-quota-notes]')).toBeNull();
    fireEvent.click(document.querySelector('[data-quota-line]') as HTMLElement);
    const pop = await waitFor(() => {
      const el = document.querySelector('[data-quota-notes]');
      if (!el) throw new Error('还没弹出');
      return el as HTMLElement;
    });
    expect(pop.textContent).toContain('读数过期');
    expect(pop.textContent).toContain('上游原话：allowed_warning');
    expect(pop.textContent).toContain('读法：claude-usage');
  });

  test('电脑上悬停的提示（title）照旧留着', () => {
    render(<QuotaLine w={w} now={NOW} />);
    expect(document.querySelector('[data-quota-line]')?.getAttribute('title')).toContain('读数过期');
  });
});
