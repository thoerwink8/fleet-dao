// 出截图：`node e2e/shots.ts [标签]`，起一套开发后端（样例数据），1440 和 390 两种屏宽各截几个画面，存到仓根 _tmp/shots/<标签>/。
// 画面：会话列表、一个正常会话、一个有异常的会话、断后端时的「已断开」条、空选择态。图不进代码分支（挂进 PR 的做法见 docs/design/驾驶舱界面.md 第七部分）。
import { mkdirSync } from 'node:fs';
import { resolve } from 'node:path';
import { chromium, type Page } from '@playwright/test';
import { seed } from '../dev/seed.ts';
import { startStack } from '../dev/stack.ts';

const label = process.argv[2] ?? 'after';
const out = resolve(import.meta.dirname, '../../../_tmp/shots', label);
mkdirSync(out, { recursive: true });

const stack = await startStack({
  distDir: resolve(import.meta.dirname, '../dist'),
  pollMs: 100,
  heartbeatMs: 2000,
});
// 先灌 32 个批量会话，再灌样例：样例的事件号更新，排在列表最前，批量的排在后面、要「加载更多」才出来
for (let i = 0; i < 32; i++) {
  await stack.emit(`bulk-${String(i).padStart(2, '0')}`, 'worker.progress.reported', {
    summary: `批量样例 ${i}`,
  });
}
await seed(stack);
const browser = await chromium.launch({ channel: process.env.E2E_BROWSER_CHANNEL?.trim() || 'chrome' });

const sizes = [
  { tag: '1440', width: 1440, height: 900, mobile: false },
  { tag: '390', width: 390, height: 844, mobile: true },
];

async function settle(page: Page): Promise<void> {
  await page.waitForTimeout(700);
}

for (const s of sizes) {
  const ctx = await browser.newContext({
    viewport: { width: s.width, height: s.height },
    deviceScaleFactor: s.mobile ? 2 : 1,
    isMobile: s.mobile,
    hasTouch: s.mobile,
    locale: 'zh-CN',
    timezoneId: 'Asia/Shanghai',
  });
  await ctx.addCookies([{ ...stack.cookie(), url: stack.url }]);
  const page = await ctx.newPage();
  const shot = (name: string) => page.screenshot({ path: `${out}/${name}-${s.tag}.png` });

  await page.goto(`${stack.url}/next/`);
  await page.getByRole('link', { name: /cmd-demo-login-fix/ }).waitFor();
  await settle(page);
  await shot('list');
  // 「加载更多」：样例之外灌了够多的会话，列表第一页之后还有
  await page.getByRole('button', { name: '加载更多' }).scrollIntoViewIfNeeded();
  await settle(page);
  await shot('list-load-more');
  await page.getByRole('button', { name: '加载更多' }).click();
  await page.getByRole('link', { name: /bulk-00/ }).waitFor();
  await settle(page);
  await shot('list-loaded');

  await page.goto(`${stack.url}/next/s/cmd-demo-login-fix`);
  await page.locator('[data-event-id]').first().waitFor();
  await settle(page);
  // 桌面截顶部，手机截顶部（手机默认贴底，滚回顶）
  await page.getByTestId('stream').evaluate((el) => el.scrollTo({ top: 0 }));
  await settle(page);
  await shot('session-top');
  await page.getByTestId('stream').evaluate((el) => el.scrollTo({ top: el.scrollHeight }));
  await settle(page);
  await shot('session-end');

  await page.goto(`${stack.url}/next/s/cmd-demo-flaky-ci`);
  await page.locator('[data-event-id]').first().waitFor();
  await page.getByTestId('stream').evaluate((el) => el.scrollTo({ top: el.scrollHeight }));
  await settle(page);
  await shot('session-abnormal');

  // 断后端：停接口层，页面应显示「已断开」条
  await stack.stopApi();
  await page.getByRole('status').waitFor();
  await settle(page);
  await shot('disconnected');
  await stack.startApi();
  await page.waitForFunction(
    () => document.querySelector('[data-testid=session-stream]')?.getAttribute('data-feed-status') === 'live',
    undefined,
    { timeout: 30_000 },
  );

  await page.goto(`${stack.url}/next/work`);
  await settle(page);
  await shot('placeholder-work');

  // 没登录：清掉 Cookie，列表给登录入口
  await ctx.clearCookies();
  await page.goto(`${stack.url}/next/`);
  await page.getByRole('link', { name: '用飞书登录' }).waitFor();
  await settle(page);
  await shot('login-required');
  await ctx.close();
}

await browser.close();
await stack.close();
console.log(`截图在 ${out}`);
