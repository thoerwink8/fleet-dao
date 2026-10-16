// 驾驶舱用户视角 e2e（母单 #902）：真 Postgres + 真后端 + 打包好的真前端 + 真浏览器，站在创始人角度逐页走。
// 跑法：见 README.md（要先有一台真 Postgres，设 E2E_PG_ADMIN_URL）；`pnpm --filter @fleet-dao/web e2e`。
// 文件命名 *.e2e.ts：不在仓库 vitest 的收录范围里（TEST_INCLUDE 只收 *.test.ts(x)），`pnpm test` 不会误跑它。
// 两个视口各走一遍（1920×1080 是创始人的大屏、1366×768 是常见笔记本）；改库的用例只在 1920 那一遍里跑（onlyDesktop）。
// 并行（决定 0093）：每个 worker 自己一整套环境（support/fixtures.ts 的 stack 夹具：自己的库、自己的端口），所以 worker 开到核数；
// 一个文件整个落在一个 worker 里、按顺序走（fullyParallel: false：文件里的用例前后有依赖）。
// 偶发（决定 0093）：首跑红的重试一次，重试过了 Playwright 标 flaky、这一轮不算红；JSON 报告留给偶发统计（packages/conventions/src/e2e-flaky.ts），
// 近 10 轮首跑红 2 次的自动开单、放进隔离集（e2e/quarantine.json，E2E_QUARANTINE=skip|only 挑，support/quarantine.ts）。
import { availableParallelism } from 'node:os';
import { defineConfig } from '@playwright/test';
import { quarantineFilter } from './support/quarantine.ts';
import { VIEWPORT_ORDER, VIEWPORTS } from './support/viewports.ts';

const channel = process.env.E2E_BROWSER_CHANNEL?.trim() || 'chrome';
/** 单跑隔离集那一遍（e2e-quarantine.yml 每天定时跑）：结果、报告另放，不盖掉正式那一遍的（Playwright 开跑先清 outputDir）。 */
const suffix = process.env.E2E_QUARANTINE?.trim() === 'only' ? '-quarantine' : '';

/**
 * worker 数：E2E_WORKERS 给了就用它；E2E_REUSE=1（共用 e2e:serve 那一套）只能 1 个；CI 上开到核数（GitHub 的 Linux 机器 4 核）；
 * 本机取一半核数、最多 4 个（本机还开着别的会话，不把机器拖满）。
 */
function workers(): number {
  if (process.env.E2E_REUSE === '1') return 1;
  const given = process.env.E2E_WORKERS?.trim();
  if (given) {
    const n = Number(given);
    if (!Number.isInteger(n) || n < 1) throw new Error(`E2E_WORKERS 要是正整数，现在是「${given}」`);
    return n;
  }
  const cores = availableParallelism();
  return process.env.CI ? cores : Math.max(1, Math.min(4, Math.floor(cores / 2)));
}

export default defineConfig({
  testDir: './specs',
  testMatch: '**/*.e2e.ts',
  globalSetup: './support/global-setup.ts',
  workers: workers(),
  fullyParallel: false,
  retries: 1,
  ...quarantineFilter(process.env.E2E_QUARANTINE),
  timeout: 60_000,
  expect: { timeout: 15_000 },
  outputDir: `../../../_tmp/e2e/results${suffix}`,
  reporter: [
    ['list'],
    ['html', { outputFolder: `../../../_tmp/e2e/report${suffix}`, open: 'never' }],
    // 偶发统计读它（packages/conventions/src/e2e-flaky.ts）；隔离集那一遍写 results-quarantine.json，两份都随 artifact 上传
    ['json', { outputFile: `../../../_tmp/e2e/results${suffix}.json` }],
  ],
  use: {
    // baseURL 由 stack 夹具给（每个 worker 的门面端口不同，support/fixtures.ts）
    channel,
    headless: true,
    locale: 'zh-CN',
    timezoneId: 'Asia/Shanghai',
    // 打包好的前端会注册 service worker（#2050，只缓存静态文件）：e2e 里拦掉，免得它在用例之间留缓存、多出请求
    serviceWorkers: 'block',
    trace: 'retain-on-failure',
    screenshot: 'only-on-failure',
  },
  projects: VIEWPORT_ORDER.map((name) => ({
    name,
    use: { viewport: VIEWPORTS[name] },
  })),
});
