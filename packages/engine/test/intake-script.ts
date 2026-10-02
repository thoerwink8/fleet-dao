// 拉单的脚本化依赖（测试和重放夹具录制器共用）。

import type { IntakeDeps } from '../src/jobs/intake.ts';

/** 一个什么都不用读的拉单：库里有一个受管的仓、开关关着（正常的空闲）。 */
export function idleDeps(over: Partial<IntakeDeps> = {}): IntakeDeps {
  let runs = 0;
  const unexpected = (what: string) => async () => {
    throw new Error(`开关关着不该走到 ${what}`);
  };
  return {
    repos: async () => [
      {
        id: 'r1',
        owner: 'acme',
        name: 'demo',
        defaultBranch: 'main',
        testCommand: 'pnpm check',
        autoDispatchSince: null,
      },
    ],
    whitelist: unexpected('白名单') as never,
    openIssues: unexpected('开着的单') as never,
    plan: unexpected('现读') as never,
    dispatched: unexpected('派过没有') as never,
    readSpecDoc: unexpected('需求文档') as never,
    runningTasks: unexpected('在跑的数') as never,
    start: unexpected('起工作流') as never,
    comment: unexpected('留言') as never,
    runs: {
      async start() {
        runs += 1;
        return runs;
      },
      async finish() {},
    },
    now: () => new Date('2026-10-02T14:00:00Z'),
    log: () => undefined,
    ...over,
  };
}
