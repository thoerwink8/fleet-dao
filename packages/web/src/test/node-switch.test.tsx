// @vitest-environment happy-dom
// 看板多机的环境切换器（顶栏）：本台和每个远程环境（本机 WSL）切着看，选中的记在网址参数 ?node=。
// 要钉住的：切到远程后主页渲染快照（顶上写「<名字> <时间> 报的，只读」）、失联的明说失联多久、别的页整页说明「只看得到本台」
// 并给切回按钮（不顶着远程的名字显示本台的数据）、环境页每个环境一列并排、提醒铃铛（本台的数据）不露出来。
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { MemoryRouter, Route, Routes, useLocation } from 'react-router';
import { afterEach, beforeEach, describe, expect, test } from 'vitest';
import { ApiError, ApiProvider, type FleetApi } from '../api/client';
import { createMockApi } from '../api/mock/server';
import type { NodeDetail, Nodes } from '../api/types';
import { ThemeProvider } from '../components/theme-provider';
import { TooltipProvider } from '../components/ui/tooltip';
import Env from '../routes/env';
import HomePage from '../routes/home';
import Shell from '../routes/shell';

beforeEach(() => localStorage.clear());
afterEach(cleanup);

type Mode = 'fresh' | 'stale' | 'never' | 'off';
const AGO: Record<Mode, number> = { fresh: 40_000, stale: 12 * 60_000 + 10_000, never: 0, off: 0 };

/** 假后端：换掉 nodes、node 两个读口（远程环境 wsl 这一次是新鲜、失联、从没收到过还是没有）。 */
function apiFor(mode: Mode, over: Partial<FleetApi> = {}): FleetApi {
  const inner = createMockApi({ live: false });
  const api = { ...inner } as FleetApi;
  return Object.assign(api, {
    nodes: async (): Promise<Nodes> => {
      const base = await inner.nodes();
      const t = Date.now();
      const item =
        mode === 'off'
          ? []
          : mode === 'never'
            ? [{ id: 'wsl', name: 'wsl', freshness: 'never' as const }]
            : [
                {
                  id: 'wsl',
                  name: '本机 WSL',
                  freshness: mode === 'fresh' ? ('fresh' as const) : ('stale' as const),
                  receivedAt: new Date(t - AGO[mode]).toISOString(),
                  reportedAt: new Date(t - AGO[mode] - 1000).toISOString(),
                },
              ];
      return { ...base, nodes: item };
    },
    node: async (id: string): Promise<NodeDetail> => {
      if (id !== 'wsl' || mode === 'off' || mode === 'never')
        throw new ApiError(404, 'node_never_reported', `环境 ${id} 配了通行证，但一次快照都没推来过`);
      const detail = await inner.node('wsl');
      const t = Date.now();
      return {
        ...detail,
        freshness: mode === 'fresh' ? 'fresh' : 'stale',
        receivedAt: new Date(t - AGO[mode]).toISOString(),
        reportedAt: new Date(t - AGO[mode] - 1000).toISOString(),
      };
    },
    ...over,
  });
}

function Where() {
  const loc = useLocation();
  return <p data-testid="where">{`${loc.pathname}${loc.search}`}</p>;
}

async function mount(api: FleetApi, route: string) {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false, staleTime: 0 } } });
  render(
    <MemoryRouter initialEntries={[route]}>
      <QueryClientProvider client={qc}>
        <ApiProvider api={api}>
          <ThemeProvider>
            <TooltipProvider>
              <Where />
              <Routes>
                <Route element={<Shell />}>
                  <Route index element={<HomePage />} />
                  <Route path="env" element={<Env />} />
                  <Route path="quota" element={<p>额度页本体</p>} />
                  <Route path="settings" element={<p>设置页本体</p>} />
                </Route>
              </Routes>
            </TooltipProvider>
          </ThemeProvider>
        </ApiProvider>
      </QueryClientProvider>
    </MemoryRouter>,
  );
  await act(async () => {
    for (let i = 0; i < 8; i++) await new Promise((r) => setTimeout(r, 0));
  });
}

const where = () => screen.getByTestId('where').textContent;
const switcher = () => screen.getByRole('button', { name: /点开切换环境/ });
async function openSwitcher() {
  fireEvent.keyDown(switcher(), { key: 'Enter' });
  return screen.findByRole('menu');
}

describe('顶栏环境切换器', () => {
  test('默认看本台：写本台的名字；下拉里本台打勾，远程环境写「刚刚报的」', async () => {
    await mount(apiFor('fresh'), '/');
    expect(switcher().getAttribute('aria-label')).toContain('现在看的是假数据');
    const menu = await openSwitcher();
    const local = within(menu).getByText('这台').closest('[role="menuitem"]') as HTMLElement;
    expect(local.querySelector('svg')).toBeTruthy();
    const wsl = menu.querySelector('[data-node-item="wsl"]') as HTMLElement;
    expect(wsl.textContent).toContain('本机 WSL');
    expect(wsl.textContent).toContain('刚刚报的');
    expect(wsl.getAttribute('data-node-state')).toBe('fresh');
  });

  test('选「本机 WSL」：网址带上 ?node=wsl、留在当前页；再选本台就去掉', async () => {
    await mount(apiFor('fresh'), '/env');
    const menu = await openSwitcher();
    fireEvent.click(menu.querySelector('[data-node-item="wsl"]') as HTMLElement);
    await act(async () => {
      await new Promise((r) => setTimeout(r, 0));
    });
    expect(where()).toBe('/env?node=wsl');
    expect(switcher().getAttribute('aria-label')).toContain('现在看的是本机 WSL');
    fireEvent.keyDown(switcher(), { key: 'Enter' });
    fireEvent.click(
      (await screen.findByRole('menu')).querySelector('[data-node-item="local"]') as HTMLElement,
    );
    await act(async () => {
      await new Promise((r) => setTimeout(r, 0));
    });
    expect(where()).toBe('/env');
  });

  test('读不到远程环境列表：下拉里写原因，不当成「没有远程环境」；本台照常能看', async () => {
    await mount(
      apiFor('fresh', {
        nodes: () => Promise.reject(new ApiError(500, 'internal', '后端出错了（测试故意造的）')),
      }),
      '/',
    );
    const menu = await openSwitcher();
    expect(within(menu).getByText(/远程环境没读成：后端出错了（测试故意造的）/)).toBeTruthy();
    expect(menu.querySelector('[data-node-item="local"]')).toBeTruthy();
  });

  test('没有远程环境（没配钥匙）：下拉里只有本台', async () => {
    await mount(apiFor('off'), '/');
    const menu = await openSwitcher();
    expect(menu.querySelectorAll('[data-node-item]').length).toBe(1);
  });
});

describe('选了远程环境：主页', () => {
  test('渲染它的快照：标题带环境名，顶上一条「本机 WSL … 报的，只读」，快照里的单子链接不指向本台', async () => {
    await mount(apiFor('fresh'), '/?node=wsl');
    expect((await screen.findAllByText(/主页 · 本机 WSL/)).length).toBeGreaterThan(0);
    await waitFor(() => expect(document.querySelector('[data-snapshot-banner]')).not.toBeNull());
    const banner = document.querySelector('[data-snapshot-banner]') as HTMLElement;
    expect(banner.getAttribute('data-snapshot-banner')).toBe('fresh');
    expect(banner.textContent).toContain('本机 WSL');
    expect(banner.textContent).toContain('报的，只读');
    // 站内详情读的是本台的库：快照里不许有指向 /tasks/、/notifications 的站内链接
    const main = document.querySelector('main') as HTMLElement;
    for (const a of main.querySelectorAll('a')) {
      const href = a.getAttribute('href') ?? '';
      expect(href.startsWith('/tasks/') || href.startsWith('/notifications'), href).toBe(false);
    }
    // 要你拍的：去答按钮置灰、说明去那台上
    for (const b of main.querySelectorAll('[data-remote-disabled]')) {
      expect((b as HTMLButtonElement).disabled).toBe(true);
    }
  });

  test('【故意造出的失败】失联的（12 分钟前最后一次报）：横幅写失联多久、说不是现在的，顶栏标「失联」', async () => {
    await mount(apiFor('stale'), '/?node=wsl');
    await screen.findAllByText(/主页 · 本机 WSL/);
    await waitFor(() => expect(document.querySelector('[data-snapshot-banner]')).not.toBeNull());
    const banner = document.querySelector('[data-snapshot-banner]') as HTMLElement;
    expect(banner.getAttribute('data-snapshot-banner')).toBe('stale');
    expect(banner.textContent).toContain('失联 12 分钟');
    expect(banner.textContent).toContain('不是现在的');
    expect(switcher().textContent).toContain('失联');
  });

  test('【故意造出的失败】配了通行证却从没收到过快照（404）：写「没有这个环境」和回主页，不重试、不拿空数据冒充', async () => {
    await mount(apiFor('never'), '/?node=wsl');
    const alert = await screen.findByRole('alert');
    expect(alert.textContent).toContain('没有这个环境');
    expect(alert.textContent).toContain('wsl');
    expect(within(alert).getByRole('link', { name: '回主页' }).getAttribute('href')).toBe('/');
    expect(within(alert).queryByRole('button', { name: '重试' })).toBeNull();
    expect(document.querySelector('[data-snapshot-banner]')).toBeNull();
  });

  test('提醒铃铛是本台的数据：看远程环境时不露出来，切回本台才有', async () => {
    await mount(apiFor('fresh'), '/?node=wsl');
    await screen.findAllByText(/主页 · 本机 WSL/);
    expect(screen.queryByRole('button', { name: /^提醒/ })).toBeNull();
    cleanup();
    await mount(apiFor('fresh'), '/');
    expect(await screen.findByRole('button', { name: /^提醒/ })).toBeTruthy();
  });
});

describe('选了远程环境：其余页', () => {
  test('额度页整页说明「只看得到本台的数据」，页面本体不渲染；点「切回」回到本台的这一页', async () => {
    await mount(apiFor('fresh'), '/quota?node=wsl');
    await waitFor(() => expect(document.querySelector('[data-only-local]')).not.toBeNull());
    const notice = document.querySelector('[data-only-local]') as HTMLElement;
    expect(notice.textContent).toContain('这一页只看得到假数据的数据');
    expect(notice.textContent).toContain('本机 WSL');
    expect(screen.queryByText('额度页本体')).toBeNull();
    fireEvent.click(within(notice).getByRole('button', { name: /切回假数据/ }));
    await act(async () => {
      await new Promise((r) => setTimeout(r, 0));
    });
    expect(where()).toBe('/quota');
    expect(screen.getByText('额度页本体')).toBeTruthy();
  });

  test('设置页（含「让 AI 接活」开关）同样整页说明，开关不渲染——去那台上操作', async () => {
    await mount(apiFor('fresh'), '/settings?node=wsl');
    await waitFor(() => expect(document.querySelector('[data-only-local]')).not.toBeNull());
    const notice = document.querySelector('[data-only-local]') as HTMLElement;
    expect(notice.textContent).toContain('请去那台上看');
    expect(screen.queryByText('设置页本体')).toBeNull();
  });

  test('侧栏换页不丢选择：在主页点「环境」，网址还带 ?node=wsl', async () => {
    await mount(apiFor('fresh'), '/?node=wsl');
    const link = (await screen.findAllByRole('link', { name: /环境/ })).find((a) =>
      a.getAttribute('href')?.startsWith('/env'),
    ) as HTMLElement;
    expect(link.getAttribute('href')).toBe('/env?node=wsl');
  });
});

describe('环境页：每个环境一列并排', () => {
  test('本台一列、本机 WSL 一列；远程那列写「上报于」、新鲜；选中的那列描边', async () => {
    await mount(apiFor('fresh'), '/env?node=wsl');
    await screen.findByRole('heading', { name: /本机 WSL/ });
    const cols = document.querySelectorAll('[data-env-column]');
    expect(Array.from(cols).map((c) => c.getAttribute('data-env-column'))).toEqual(['local', 'wsl']);
    const wsl = document.querySelector('[data-env-column="wsl"]') as HTMLElement;
    expect(wsl.querySelector('[data-env-age]')?.textContent).toContain('上报于');
    expect(wsl.getAttribute('data-env-column-state')).toBe('ok');
    expect(wsl.getAttribute('data-env-selected')).toBe('true');
    expect(document.querySelector('[data-env-column="local"]')?.getAttribute('data-env-selected')).toBe(
      'false',
    );
    // 两列都有六格
    for (const col of cols) {
      for (const label of ['引擎', '在用版本', '在跑的会话', '池占用', '健康', '最近拉单']) {
        expect(within(col as HTMLElement).getByText(label)).toBeTruthy();
      }
    }
  });

  test('失联的那一列写「失联 12 分钟」、标成失联色并说明是最后一次报的样子', async () => {
    await mount(apiFor('stale'), '/env');
    await screen.findByRole('heading', { name: /本机 WSL/ });
    const wsl = document.querySelector('[data-env-column="wsl"]') as HTMLElement;
    expect(wsl.getAttribute('data-env-column-state')).toBe('stale');
    expect(wsl.querySelector('[data-env-age]')?.textContent).toContain('失联 12 分钟');
    expect(wsl.textContent).toContain('最后一次报的样子');
  });

  test('配了通行证、从没收到过的那一列明说没收到过，不画空格子', async () => {
    await mount(apiFor('never'), '/env');
    await screen.findByRole('heading', { name: /wsl/ });
    const wsl = document.querySelector('[data-env-column="wsl"]') as HTMLElement;
    expect(wsl.querySelector('[data-env-never]')?.textContent).toContain('从没收到过');
    expect(wsl.querySelector('[data-env-fact]')).toBeNull();
  });

  test('没有远程环境时就是原来的一列宽版，没有「并排」', async () => {
    await mount(apiFor('off'), '/env');
    await screen.findByRole('heading', { name: /假数据/ });
    expect(document.querySelectorAll('[data-env-column]').length).toBe(1);
  });
});
