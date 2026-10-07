// 路由两层的默认骨架（packages/db/routing.default.json）里判断用途照 packages/jev 排：引擎每次提问都取判断用途排第一、
// 不是死的那条路由起后端（wiring.ts 的 resolveJevBackend → backendForRoute），所以判断用途下开着的每一条都得是这里起得了的。
// 两层里开关跟着路由走、不分用途：Opus 一排进判断用途，它开着的 Claude 路由就跟着排进来，而 Claude 判断后端还没接上。
// 路由的执行方式、上游型号照目录配置（deploy/catalog.json，发布时先装它、再装骨架）。
import { readFileSync } from 'node:fs';
import { loadRoutingConfig, parseCatalog } from '@fleet-dao/db';
import { describe, expect, it } from 'vitest';
import { backendForRoute, CLAUDE_ROUTE_CLOSED, type JudgeRoute, parseJevConfig } from '../src/config.ts';

const repoFile = (path: string) => readFileSync(new URL(`../../../${path}`, import.meta.url), 'utf8');
const EXAMPLE = 'deploy/catalog.json';
const catalog = parseCatalog(repoFile(EXAMPLE), EXAMPLE);
// 机器配置照 packages/jev 自己的样例；钥匙换成假的，不读真文件。TypeSafe 后端在测试里不出网（没注入 fetch 就拒）。
const config = parseJevConfig(JSON.parse(repoFile('packages/jev/config.example.json')));
const fakeKey = async () => 'k-test\n';

/** 引擎交给 packages/jev 的样子：执行方式 + 插头实际发给上游的型号。 */
function judgeRoute(routeId: string): JudgeRoute {
  const r = catalog.routes.find((x) => x.id === routeId);
  if (!r) throw new Error(`骨架里挂了 ${routeId}，目录样例的 routes 里却没有`);
  return { hostId: r.hostId, model: r.upstreamModel ?? r.modelId };
}

describe('默认骨架的判断用途照 packages/jev 排', () => {
  it('判断用途下开着的路由 packages/jev 都起得了后端；排第一的是 TypeSafe（接口外壳 + 钉死的 jev-x.y.z）', async () => {
    const routing = await loadRoutingConfig();
    const models = routing.purposes.judge ?? routing.purposes.default ?? [];
    const on = models
      .flatMap((m) => routing.models[m] ?? [])
      .filter((r) => r.enabled)
      .map((r) => judgeRoute(r.routeId));
    expect(on.length).toBeGreaterThan(0);
    expect(on[0]).toEqual({ hostId: 'api-shell', model: expect.stringMatching(/^jev-\d+\.\d+\.\d+$/) });
    for (const route of on) {
      // 走到「测试里不许真调 TypeSafe」这一步，说明型号钉死了、配置有 typesafe 一节、钥匙读到了：起的确实是 TypeSafe。
      await expect(backendForRoute(route, config, fakeKey)).rejects.toThrow(/测试里不许真调 TypeSafe/);
    }
  });

  it('Opus 的 Claude 路由现在确实接不了，所以判断用途不排 Opus（哪天接上 fleet-agent-scope，这条会红：把 Opus 排进骨架的判断用途，法国库里的照 docs/ops.md 第九节改）', async () => {
    const routing = await loadRoutingConfig();
    expect(routing.purposes.judge ?? routing.purposes.default).not.toContain('opus-5.5');
    const claude = (routing.models['opus-5.5'] ?? [])
      .map((r) => judgeRoute(r.routeId))
      .filter((r) => r.hostId === 'claude-code');
    expect(claude.length).toBeGreaterThan(0);
    for (const route of claude) {
      await expect(backendForRoute(route, config, fakeKey)).rejects.toThrow(CLAUDE_ROUTE_CLOSED);
    }
  });
});
