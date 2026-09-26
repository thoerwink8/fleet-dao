// 登录页上「正在跑的驾驶舱」：真组件 + 演示用的假数据（和演示版同一份种子），数据只在这个页面的内存里。
// 自己一套 QueryClient 和 FleetApi，跟登录用的那一套（真后端）互不相干：登录页上看到的东西
// 一条请求都不发到后端，登录以后看到的是同一套界面、换成真数据。

import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { type ReactNode, useState } from 'react';
import { ApiProvider, type FleetApi, useLiveSync } from '../api/client';
import { createMockApi } from '../api/mock/server';
import { RepoProvider } from '../components/repo-context';
import { TaskActionsProvider } from '../components/task-actions';

let showcaseApi: FleetApi | undefined;

/** 整个页面共用一份：三版之间切换、重新渲染，假数据接着往前走，不从头来。 */
export function getShowcaseApi(): FleetApi {
  if (!showcaseApi) {
    const inner = createMockApi({ live: true, latencyMs: 0, tickMs: 2200 });
    showcaseApi = {
      ...inner,
      async me() {
        const me = await inner.me();
        return { ...me, user: { ...me.user, displayName: '访客' } };
      },
    };
  }
  return showcaseApi;
}

/** 测试用：换一份（比如不开模拟器的）。 */
export function setShowcaseApiForTest(api: FleetApi | undefined) {
  showcaseApi = api;
}

function LiveSync() {
  useLiveSync();
  return null;
}

export function Showcase({ children }: { children: ReactNode }) {
  const [qc] = useState(
    () =>
      new QueryClient({
        defaultOptions: { queries: { staleTime: 5_000, refetchOnWindowFocus: false, retry: false } },
      }),
  );
  return (
    <QueryClientProvider client={qc}>
      <ApiProvider api={getShowcaseApi()}>
        <LiveSync />
        <RepoProvider>
          <TaskActionsProvider>{children}</TaskActionsProvider>
        </RepoProvider>
      </ApiProvider>
    </QueryClientProvider>
  );
}
