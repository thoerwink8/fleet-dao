// 驾驶舱用哪个 FleetApi 实现，只在这里决定：
// - 默认连真后端（同源的 /api、/auth；开发时由 Vite 代理到本机 127.0.0.1:8787）。
// - `pnpm --filter @fleet-dao/web dev:mock`（Vite 的 mock 模式）用假数据，不需要后端。
// - 演示版（demo 模式构建）只用假数据、按可见范围收起：判断写成 import.meta.env.MODE，构建时就定死，
//   连后端的那一份（http.ts）整个打不进演示版的包。

import { createDemoApi } from '../demo/api';
import type { FleetApi } from './client';
import { createHttpApi } from './http';
import { createMockApi } from './mock/server';

let instance: FleetApi | undefined;

export function loginPath(next: string = `${location.pathname}${location.search}`): string {
  return `/login?next=${encodeURIComponent(next)}`;
}

export function getApi(): FleetApi {
  if (instance) return instance;
  if (import.meta.env.MODE === 'demo') {
    instance = createDemoApi(createMockApi({ live: true, latencyMs: 90 }));
  } else if (import.meta.env.MODE === 'mock') {
    instance = createMockApi({ live: true, latencyMs: 90 });
  } else {
    instance = createHttpApi({
      onUnauthorized: () => {
        if (location.pathname !== '/login') location.assign(loginPath());
      },
    });
  }
  return instance;
}
