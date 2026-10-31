// 实时流 e2e：对照 specs/3770-harness-rewrite/旧坑验收用例.md 的 G1（窄屏不挤爆）、G3（打开即点）、G4（断后端、续传、resync）、E5（轮询退避）。
// 每个用例自己一套后端（support/fixtures.ts 的 stack）：断后端 = 停掉 harness-api，开发后端还在、对 /events 回 502；
// 恢复 = 在原端口把 harness-api 拉起来。库里的事件号是真相，页面渲染出来的事件号必须和它一模一样（不漏、不重、有序）。

import { seed } from '../../dev/seed.ts';
import { dbIds, emitProgress, expect, feedStatus, pageIds, test } from '../support/fixtures.ts';

const S = 'e2e-live';

async function openSession(
  page: import('@playwright/test').Page,
  stack: import('../../dev/stack.ts').Stack,
  id = S,
) {
  await page.goto(`${stack.url}/next/s/${id}`);
  await expect(feedStatus(page)).toHaveAttribute('data-feed-status', 'live');
}

test.describe('会话工作台', () => {
  test('打开会话看到历史，新事件不用刷新自己出现', async ({ page, stack }) => {
    await emitProgress(stack, S, 1, 3);
    await openSession(page, stack);
    await expect.poll(() => pageIds(page)).toEqual(await dbIds(stack, S));
    await emitProgress(stack, S, 4, 2);
    await expect.poll(() => pageIds(page)).toEqual(await dbIds(stack, S));
    await expect(page.getByText('进度 5', { exact: true })).toBeVisible();
  });

  test('G3：刚打开就点会话，照样进去（不被后来的数据冲掉）', async ({ page, stack }) => {
    await seed(stack);
    await page.goto(`${stack.url}/next/`);
    const item = page.getByRole('link', { name: /cmd-demo-login-fix/ });
    await item.click();
    await expect(page).toHaveURL(/\/next\/s\/cmd-demo-login-fix$/);
    await expect(page.locator('[data-event-type="worker.spawn.requested"]')).toBeVisible();
    await expect(page.locator('[data-event-type="handback.recorded"]')).toBeVisible();
  });

  test('每种事件都有像样的展示（不是 JSON 堆）', async ({ page, stack }) => {
    await seed(stack);
    await openSession(page, stack, 'cmd-demo-flaky-ci');
    await expect(page.getByText('请求叫停这个任务')).toBeVisible();
    await expect(page.getByText('异常结束')).toBeVisible();
    await expect(page.getByText('退出码 143')).toBeVisible();
    await expect(page.getByText('中间交回').or(page.getByText('终局交回')).first()).toBeVisible();
    // 页面上不应该出现整段 JSON 花括号堆（原始内容只在折叠的 details 里）
    const visibleText = await page.locator('main').innerText();
    expect(visibleText).not.toMatch(/"taskId"\s*:/);
  });

  test('G1：390 和 1440 下没有横向滚动，关键控件都在屏内、不互相压住', async ({ page, stack }) => {
    await seed(stack);
    await openSession(page, stack, 'cmd-demo-login-fix');
    const m = await page.evaluate(() => ({
      sw: document.documentElement.scrollWidth,
      iw: window.innerWidth,
      bodyOverflow: document.body.scrollWidth > window.innerWidth,
    }));
    expect(m.sw).toBeLessThanOrEqual(m.iw);
    expect(m.bodyOverflow).toBe(false);
    const rect = async (loc: import('@playwright/test').Locator) => {
      const b = await loc.boundingBox();
      if (!b) throw new Error('元素不在页面上');
      return b;
    };
    const box = (sel: string) => rect(page.locator(sel).first());
    const view = page.viewportSize() ?? { width: m.iw, height: 0 };
    const bar = await box('header');
    expect(bar.height).toBeCloseTo(56, 0);
    const status = await rect(page.getByText('实时', { exact: true }));
    expect(status.x + status.width).toBeLessThanOrEqual(m.iw);
    if (view.width < 768) {
      // 手机：底部标签栏、返回键在，侧栏不在
      await expect(page.getByRole('navigation', { name: '底部导航' })).toBeVisible();
      await expect(page.getByRole('navigation', { name: '主导航' })).toBeHidden();
      await expect(page.getByRole('link', { name: '返回会话列表' })).toBeVisible();
      const tabs = await box('nav[aria-label="底部导航"]');
      expect(tabs.y + tabs.height).toBeCloseTo(view.height, 0);
    } else {
      await expect(page.getByRole('navigation', { name: '主导航' })).toBeVisible();
      await expect(page.getByRole('navigation', { name: '底部导航' })).toBeHidden();
      const aside = await box('aside');
      expect(aside.width).toBeCloseTo(208, 0);
      await page.getByRole('button', { name: '收起导航' }).click();
      await expect.poll(async () => (await box('aside')).width).toBeCloseTo(64, 0);
    }
  });
});

test.describe('G4：断后端、续传、resync', () => {
  test('断后端：页面说「已断开」，已显示的不丢；恢复后带 Last-Event-ID 续上，断开期间写的一条不漏、一条不重', async ({
    page,
    stack,
  }) => {
    await emitProgress(stack, S, 1, 4);
    await openSession(page, stack);
    await expect.poll(() => pageIds(page)).toEqual(await dbIds(stack, S));
    const before = await pageIds(page);

    await stack.stopApi();
    await expect(feedStatus(page)).toHaveAttribute('data-feed-status', 'reconnecting');
    await expect(page.getByRole('status')).toContainText('连接断了');
    expect(await pageIds(page)).toEqual(before); // 已显示的不丢

    await emitProgress(stack, S, 5, 6); // 断开期间事件照常写进库
    await stack.startApi();
    await expect(feedStatus(page)).toHaveAttribute('data-feed-status', 'live', { timeout: 30_000 });
    const truth = await dbIds(stack, S);
    await expect.poll(() => pageIds(page)).toEqual(truth);
    expect(new Set(await pageIds(page)).size).toBe(truth.length); // 一条不重

    await emitProgress(stack, S, 11, 1); // 恢复后新事件照常实时
    await expect.poll(() => pageIds(page)).toEqual(await dbIds(stack, S));
    await expect(feedStatus(page)).toHaveAttribute('data-resyncs', '0'); // 补得全，不需要整页重取
  });

  test.describe('补发上限调到 5', () => {
    test.use({ replayCap: 5 });
    test('落后超过重放上限：收到 resync 整页重取，结果和库完全一致', async ({ page, stack }) => {
      await emitProgress(stack, S, 1, 3);
      await openSession(page, stack);
      await stack.stopApi();
      await expect(feedStatus(page)).toHaveAttribute('data-feed-status', 'reconnecting');
      await emitProgress(stack, S, 4, 12); // 断开期间写 12 条，一定超过上限 5
      await stack.startApi();
      await expect(feedStatus(page)).toHaveAttribute('data-resyncs', '1', { timeout: 30_000 });
      await expect(feedStatus(page)).toHaveAttribute('data-feed-status', 'live', { timeout: 30_000 });
      const truth = await dbIds(stack, S);
      await expect.poll(() => pageIds(page)).toEqual(truth);
      expect(new Set(await pageIds(page)).size).toBe(truth.length);
    });
  });

  test('多个标签页同时断线再连：不漏、不重、不风暴（重连被抖动打散、次数有上限）', async ({
    browser,
    stack,
  }, testInfo) => {
    test.skip(testInfo.project.name !== 'desktop-1440', '多标签页只在桌面跑一遍');
    const TABS = 6;
    await emitProgress(stack, S, 1, 5);
    const ctx = await browser.newContext({ viewport: { width: 1440, height: 900 } });
    const pages = await Promise.all(Array.from({ length: TABS }, () => ctx.newPage()));
    await Promise.all(pages.map((p) => openSession(p, stack)));

    const t0 = Date.now();
    stack.stats.sseAttempts.length = 0;
    await stack.stopApi();
    await Promise.all(
      pages.map((p) => expect(feedStatus(p)).toHaveAttribute('data-feed-status', 'reconnecting')),
    );
    await emitProgress(stack, S, 6, 8);
    await new Promise((r) => setTimeout(r, 8000)); // 断 8 秒
    const duringOutage = [...stack.stats.sseAttempts];
    // 不风暴：8 秒里每个标签页最多重连 6 次（固定 1 秒间隔的会有 8 次，没退避的几十次）
    expect(duringOutage.length).toBeLessThanOrEqual(TABS * 6);
    // 不同步：任何 100ms 窗口里不会所有标签页一起撞过来
    let peak = 0;
    for (const a of duringOutage)
      peak = Math.max(peak, duringOutage.filter((b) => b >= a && b < a + 100).length);
    expect(peak).toBeLessThan(TABS);
    console.log(`断 8 秒：${TABS} 个标签页共重连 ${duringOutage.length} 次，任意 100ms 窗口最多 ${peak} 个`);

    stack.stats.sseAttempts.length = 0;
    await stack.startApi();
    await Promise.all(
      pages.map((p) =>
        expect(feedStatus(p)).toHaveAttribute('data-feed-status', 'live', { timeout: 40_000 }),
      ),
    );
    const truth = await dbIds(stack, S);
    for (const p of pages) {
      await expect.poll(() => pageIds(p)).toEqual(truth);
      expect(new Set(await pageIds(p)).size).toBe(truth.length);
    }
    // 恢复后每个标签页只该重连成功一次左右（不是恢复瞬间又一轮风暴）
    expect(stack.stats.sseAttempts.length).toBeLessThanOrEqual(TABS * 2);
    expect(Date.now() - t0).toBeLessThan(80_000);
    await ctx.close();
  });
});

test.describe('E5：读页后端挂掉时列表轮询退避', () => {
  test('失败后间隔翻倍封顶 60 秒（5 分钟里最多 8 次，不是 30 次），恢复后立刻回到 10 秒', async ({
    page,
    stack,
  }) => {
    await seed(stack);
    await page.clock.install();
    let calls = 0;
    let broken = true;
    await page.route('**/next/api/sessions', async (route) => {
      calls++;
      if (broken) return route.fulfill({ status: 502, body: 'bad gateway' });
      return route.continue();
    });
    await page.goto(`${stack.url}/next/`);
    await expect.poll(() => calls).toBe(1);
    for (let i = 0; i < 30; i++) {
      await page.clock.runFor(10_000);
      await page.waitForTimeout(30);
    }
    expect(calls).toBeLessThanOrEqual(8);
    await expect(page.getByRole('alert')).toContainText('读不到会话列表');
    // 恢复：下一次成功后列表出来，间隔回到 10 秒
    broken = false;
    await page.clock.runFor(60_000);
    await expect(page.getByRole('link', { name: /cmd-demo-login-fix/ })).toBeVisible();
    const afterOk = calls;
    for (let i = 0; i < 3; i++) {
      await page.clock.runFor(10_000);
      await page.waitForTimeout(100);
    }
    expect(calls - afterOk).toBe(3); // 每 10 秒一次，30 秒三次
  });
});
