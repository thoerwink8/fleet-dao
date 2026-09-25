// 驾驶舱用哪个 FleetApi 实现，只在这里决定：
// - 默认连真后端（同源的 /api、/auth；开发时由 Vite 代理到本机 127.0.0.1:8787）。
// - `pnpm --filter @fleet-dao/web dev:mock`（Vite 的 mock 模式）用假数据，不需要后端。
import type { FleetApi } from './client';
import { createHttpApi } from './http';
import { createMockApi } from './mock/server';

let instance: FleetApi | undefined;

export function loginPath(next: string = `${location.pathname}${location.search}`): string {
  return `/login?next=${encodeURIComponent(next)}`;
}

export function getApi(): FleetApi {
  if (instance) return instance;
  instance =
    import.meta.env.MODE === 'mock'
      ? createMockApi({ live: true, latencyMs: 90 })
      : createHttpApi({
          onUnauthorized: () => {
            if (location.pathname !== '/login') location.assign(loginPath());
          },
        });
  return instance;
}
