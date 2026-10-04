// 契约对账（母单 #902）：shared/web-api.ts 的 WebRoutes、AuthRoutes ↔ 后端真注册了的路由，两个方向都对。
// - 契约里写了、后端没注册：前端调了会 404；
// - 后端注册了、契约里没有：没人认得的接口（飞书网关、fleet 命令、GitHub 事件另有各自的前缀和约定，不在这里）。
// 前端那一头（http.ts 用了契约里的哪些）在 packages/web/src/api/http.test.ts 旁边的 contract.test.ts 对。
import { AUTH_PREFIX, AuthRoutes, WEB_API_PREFIX, WebRoutes } from '@fleet-dao/shared';
import { describe, expect, it } from 'vitest';
import { harness } from './harness.ts';

type Entry = { method: string; path: string };
const key = (e: Entry) => `${e.method} ${e.path}`;

/** 契约里的每一条（WebRoutes 在 /api 下、AuthRoutes 在 /auth 下），路径参数名原样。 */
function contract(): Entry[] {
  return [
    ...Object.values(WebRoutes).map((r) => ({ method: r.method, path: `${WEB_API_PREFIX}${r.path}` })),
    ...Object.values(AuthRoutes).map((r) => ({ method: r.method, path: `${AUTH_PREFIX}${r.path}` })),
  ];
}

describe('契约 ↔ 后端注册的路由', () => {
  const registered = harness()
    .cockpit.routes.filter((r) => r.method !== 'ALL')
    .map((r) => ({ method: r.method, path: r.path }));

  it('契约里的每一条后端都注册了（方法和路径一致）', () => {
    const have = new Set(registered.map(key));
    // dev-login 只在 FLEET_ENV=development 且 FLEET_DEV_LOGIN=1 时才注册（auth.ts），测试配置里没开
    const onlyInDev = new Set(['POST /auth/dev-login']);
    const missing = contract().filter((e) => !have.has(key(e)) && !onlyInDev.has(key(e)));
    expect(missing.map(key), '契约里有、后端没注册').toEqual([]);
  });

  it('后端 /api、/auth 下注册的每一条，契约里都有（飞书、意图这类另有约定的前缀除外）', () => {
    const inContract = new Set(contract().map(key));
    // 飞书网关、意图卡走各自的模块和约定（feishu-routes.ts、intent-routes.ts），不属于驾驶舱前端的契约
    const own = (p: string) => !/^\/api\/(feishu|intents?|drafts?)(\/|$)/.test(p);
    const extra = registered
      .filter(
        (r) =>
          (r.path.startsWith(`${WEB_API_PREFIX}/`) || r.path.startsWith(`${AUTH_PREFIX}/`)) && own(r.path),
      )
      .filter((r) => !inContract.has(key(r)));
    expect(extra.map(key), '后端有、契约里没有').toEqual([]);
  });

  it('故意造出失败：契约里多一条后端没有的，对账要报出来', () => {
    const have = new Set(registered.map(key));
    const fake: Entry = { method: 'GET', path: '/api/definitely-not-there' };
    expect([fake].filter((e) => !have.has(key(e))).map(key)).toEqual(['GET /api/definitely-not-there']);
  });
});
