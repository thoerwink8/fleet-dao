// 目录样例（deploy/examples/catalog.example.json）的判断阶段照 packages/jev 排：它按判断阶段排第一的路由起后端，
// 开着的每一条都得是这里起得了的；关着的两条 Claude 是因为 Claude 判断后端还没接上。
import { readFileSync } from 'node:fs';
import { parseCatalog } from '@fleet-dao/db';
import { describe, expect, it } from 'vitest';
import { backendForRoute, CLAUDE_ROUTE_CLOSED, type JudgeRoute, parseJevConfig } from '../src/config.ts';

const repoFile = (path: string) => readFileSync(new URL(`../../../${path}`, import.meta.url), 'utf8');
const EXAMPLE = 'deploy/examples/catalog.example.json';
const catalog = parseCatalog(repoFile(EXAMPLE), EXAMPLE);
// 机器配置照 packages/jev 自己的样例；钥匙换成假的，不读真文件。TypeSafe 后端在测试里不出网（没注入 fetch 就拒）。
const config = parseJevConfig(JSON.parse(repoFile('packages/jev/config.example.json')));
const fakeKey = async () => 'k-test\n';

const judge = catalog.stages.judge ?? catalog.stages.default ?? [];

/** 引擎交给 packages/jev 的样子：执行方式 + 插头实际发给上游的型号。 */
function judgeRoute(routeId: string): JudgeRoute {
  const r = catalog.routes.find((x) => x.id === routeId);
  if (!r) throw new Error(`样例的判断阶段挂了 ${routeId}，routes 里却没有`);
  return { hostId: r.hostId, model: r.upstreamModel ?? r.modelId };
}

describe('目录样例的判断阶段照 packages/jev 排', () => {
  it('开着的路由 packages/jev 都起得了后端；排第一的是 TypeSafe（接口外壳 + 钉死的 jev-x.y.z）', async () => {
    const on = judge.filter((e) => e.enabled).map((e) => judgeRoute(e.routeId));
    expect(on[0]).toEqual({ hostId: 'api-shell', model: expect.stringMatching(/^jev-\d+\.\d+\.\d+$/) });
    for (const route of on) {
      // 走到「测试里不许真调 TypeSafe」这一步，说明型号钉死了、配置有 typesafe 一节、钥匙读到了：起的确实是 TypeSafe。
      await expect(backendForRoute(route, config, fakeKey)).rejects.toThrow(/测试里不许真调 TypeSafe/);
    }
  });

  it('关着的两条 Claude 现在确实接不了（哪天接上 fleet-agent-scope，这条会红：样例里把它们打开，法国在驾驶舱里开）', async () => {
    const off = judge.filter((e) => !e.enabled).map((e) => judgeRoute(e.routeId));
    expect(off.map((r) => r.hostId)).toEqual(['claude-code', 'claude-code']);
    for (const route of off) {
      await expect(backendForRoute(route, config, fakeKey)).rejects.toThrow(CLAUDE_ROUTE_CLOSED);
    }
  });
});
