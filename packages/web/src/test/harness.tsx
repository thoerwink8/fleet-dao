// 组件测试的外壳：假后端（不开模拟器）+ React Query + 路由 + 主题 + 当前仓 + 快捷操作。
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { type RenderResult, render } from '@testing-library/react';
import type { ReactElement } from 'react';
import { MemoryRouter } from 'react-router';
import { ApiProvider, type FleetApi } from '../api/client';
import { createMockApi, type MockApi } from '../api/mock/server';
import { RepoProvider } from '../components/repo-context';
import { TaskActionsProvider } from '../components/task-actions';
import { ThemeProvider } from '../components/theme-provider';
import { TooltipProvider } from '../components/ui/tooltip';

export function renderApp<A extends FleetApi = MockApi>(
  ui: ReactElement,
  opts: { api?: A; route?: string; retry?: false | 1 } = {},
): RenderResult & { api: A; qc: QueryClient } {
  const api = opts.api ?? (createMockApi({ live: false }) as FleetApi as A);
  // retry: 1 对齐 root.tsx 的全局默认（再加 retryDelay: 0，测试不用等那一秒）。不传保持不重试。
  const qc = new QueryClient({
    defaultOptions: {
      queries: { retry: opts.retry ?? false, ...(opts.retry ? { retryDelay: 0 } : {}), staleTime: 0 },
    },
  });
  const view = render(
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
    </MemoryRouter>,
  );
  return { api, qc, ...view };
}
