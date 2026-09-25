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
  opts: { api?: A; route?: string } = {},
): RenderResult & { api: A; qc: QueryClient } {
  const api = opts.api ?? (createMockApi({ live: false }) as FleetApi as A);
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false, staleTime: 0 } } });
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
