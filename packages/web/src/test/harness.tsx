// 组件测试的外壳：假后端（不开模拟器）+ React Query + 路由 + 主题 + 当前仓 + 快捷操作。
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { fireEvent, type RenderResult, render } from '@testing-library/react';
import { Profiler, type ReactElement } from 'react';
import { MemoryRouter } from 'react-router';
import { ApiProvider, type FleetApi } from '../api/client';
import { createMockApi, type MockApi } from '../api/mock/server';
import { RepoProvider } from '../components/repo-context';
import { TaskActionsProvider } from '../components/task-actions';
import { ThemeProvider } from '../components/theme-provider';
import { TooltipProvider } from '../components/ui/tooltip';
import { noteReactRender } from './stage-trace';

export function renderApp<A extends FleetApi = MockApi>(
  ui: ReactElement,
  opts: {
    api?: A;
    route?: string;
    retry?: false | 1;
    staleTime?: number;
    /** 在第一次渲染前写入查询缓存。页面不必再等这一次读取才离开骨架。 */
    hydrate?: (qc: QueryClient) => void;
  } = {},
): RenderResult & { api: A; qc: QueryClient } {
  const api = opts.api ?? (createMockApi({ live: false }) as FleetApi as A);
  // retry 不传就关，传 1 才对齐 root.tsx 的全局默认。
  // 查询自己写了 retry（retryUnlessMissing）时不继承上面的开关，仍会再试一次。
  // 再试的等待如果留着 React Query 的默认 1 秒，findBy 也只等 1 秒，CI 一忙就停在骨架上
  // （法国页远程快照没读成，#1533 的 check 因此红了两次）。测试里再试不等待。生产的等待在 root.tsx。
  // staleTime 默认 0（一拿到就算过期）。要对齐 root.tsx 的 5 秒缓存时显式传。
  const qc = new QueryClient({
    defaultOptions: {
      queries: { retry: opts.retry ?? false, retryDelay: 0, staleTime: opts.staleTime ?? 0 },
    },
  });
  opts.hydrate?.(qc);
  // 外层 Profiler 只为阶段记录（stage-trace.ts，#3372）：装了它的测试文件慢时能读出多少时间花在 React 渲染；没装时回调直接返回。
  const view = render(
    <Profiler id="app" onRender={noteReactRender}>
      <MemoryRouter initialEntries={[opts.route ?? '/']}>
        <QueryClientProvider client={qc}>
          <ApiProvider api={api}>
            <ThemeProvider>
              <TooltipProvider>
                <RepoProvider>
                  <TaskActionsProvider>{ui}</TaskActionsProvider>
                </RepoProvider>
              </TooltipProvider>
            </ThemeProvider>
          </ApiProvider>
        </QueryClientProvider>
      </MemoryRouter>
    </Profiler>,
  );
  return { api, qc, ...view };
}

/** 额度页表上面的页签（全部 / 该先用 / 快用完 / 读数过期或没查成，FilterTabs 的页签，aria-selected）：点开它，返回筛过的表（找不到就报错，不返回空）。 */
export function openSummary(title: string): HTMLElement {
  const tab = [...document.querySelectorAll<HTMLElement>('[data-quota-summary] [role="tab"]')].find((t) =>
    (t.textContent ?? '').startsWith(title),
  );
  if (!tab) throw new Error(`找不到摘要标签：${title}`);
  if (tab.getAttribute('aria-selected') !== 'true') fireEvent.click(tab);
  const table = document.querySelector<HTMLElement>('[data-quota-matrix]');
  if (!table) throw new Error(`摘要标签没有筛出表：${title}`);
  return table;
}

/** 页签上的计数（「该先用」后面那个数）。 */
export function summaryCount(title: string): number {
  const tab = [...document.querySelectorAll<HTMLElement>('[data-quota-summary] [role="tab"]')].find((t) =>
    (t.textContent ?? '').startsWith(title),
  );
  const n = tab?.querySelector('[data-tab-count]')?.textContent;
  if (n === undefined || n === null) throw new Error(`找不到摘要标签的计数：${title}`);
  return Number(n);
}
