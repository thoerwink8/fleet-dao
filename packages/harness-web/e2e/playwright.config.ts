// 新驾驶舱 e2e（#3781）：真 PGlite + 真 harness-api + 开发后端 + 打包好的真前端 + 真浏览器。
// 跑法：`pnpm --filter @fleet-dao/harness-web e2e`（先打包一次，不需要真 Postgres）。文件名 *.e2e.ts，不在仓库 vitest 的收录范围里。
// 两种屏宽各走一遍：1440×900 桌面、390×844 手机（768 以下换底部标签栏）。
import { defineConfig } from '@playwright/test';

const channel = process.env.E2E_BROWSER_CHANNEL?.trim() || 'chrome';

export default defineConfig({
  testDir: './specs',
  testMatch: '**/*.e2e.ts',
  globalSetup: './support/global-setup.ts',
  workers: 2,
  fullyParallel: false,
  retries: 0,
  timeout: 90_000,
  expect: { timeout: 15_000 },
  outputDir: '../../../_tmp/harness-web-e2e/results',
  reporter: [['list']],
  use: { channel, headless: true, locale: 'zh-CN', timezoneId: 'Asia/Shanghai', trace: 'retain-on-failure' },
  projects: [
    { name: 'desktop-1440', use: { viewport: { width: 1440, height: 900 } } },
    { name: 'mobile-390', use: { viewport: { width: 390, height: 844 }, hasTouch: true, isMobile: true } },
  ],
});
