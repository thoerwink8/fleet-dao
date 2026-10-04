// 驾驶舱用户视角 e2e（母单 #902）：真 Postgres + 真后端 + 真前端 + 真浏览器，站在创始人角度逐页走。
// 跑法：见 README.md（要先有一台真 Postgres，设 E2E_PG_ADMIN_URL）；`pnpm --filter @fleet-dao/web e2e`。
// 文件命名 *.e2e.ts：不在仓库 vitest 的收录范围里（TEST_INCLUDE 只收 *.test.ts(x)），`pnpm test` 不会误跑它。
// 两个视口各走一遍（1920×1080 是创始人的大屏、1366×768 是常见笔记本）；改库的用例只在 1920 那一遍里跑，
// 因为它们动的是同一份库（先走 1366 的只读那一遍，再走 1920 的完整那一遍）。
import { defineConfig } from '@playwright/test';

const channel = process.env.E2E_BROWSER_CHANNEL?.trim() || 'chrome';

export default defineConfig({
  testDir: './specs',
  testMatch: '**/*.e2e.ts',
  globalSetup: './support/global-setup.ts',
  // 同一份库、有顺序依赖（登录 → 各页 → 退出）：一个工作进程，按文件名顺序走。
  workers: 1,
  fullyParallel: false,
  retries: 0,
  timeout: 60_000,
  expect: { timeout: 15_000 },
  outputDir: '../../../_tmp/e2e/results',
  reporter: [['list'], ['html', { outputFolder: '../../../_tmp/e2e/report', open: 'never' }]],
  use: {
    // 后端按 FLEET_PUBLIC_URL（http://localhost:端口）核对写请求来源，所以不能用 127.0.0.1。
    baseURL: process.env.E2E_BASE_URL ?? `http://localhost:${process.env.E2E_WEB_PORT ?? 15173}`,
    channel,
    headless: true,
    locale: 'zh-CN',
    timezoneId: 'Asia/Shanghai',
    trace: 'retain-on-failure',
    screenshot: 'only-on-failure',
  },
  projects: [
    { name: 'laptop-1366', use: { viewport: { width: 1366, height: 768 } } },
    { name: 'desktop-1920', use: { viewport: { width: 1920, height: 1080 } } },
  ],
});
