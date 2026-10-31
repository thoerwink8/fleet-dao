// 实时流 e2e：对照 specs/3770-harness-rewrite/旧坑验收用例.md 的 G1（窄屏不挤爆）、G3（打开即点）、G4（断后端、续传、resync）、E5（轮询退避）。
// 每个用例自己一套后端（support/fixtures.ts 的 stack）：断后端 = 停掉 harness-api，开发后端还在、对 /events 回 502；
// 恢复 = 在原端口把 harness-api 拉起来。库里的事件号是真相，页面渲染出来的事件号必须和它一模一样（不漏、不重、有序）。

import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { seed } from '../../dev/seed.ts';
import {
  dbIds,
  emitProgress,
  expandDone,
  expect,
  feedStatus,
  login,
  pageIds,
  test,
} from '../support/fixtures.ts';

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
    // 5 条进度连在一起：默认折叠成一行摘要，点开才看到每一条
    await expect(page.locator('[data-tool-run]')).toContainText('调了 5 次工具：report_progress×5');
    await page.locator('[data-tool-run]').getByRole('button').first().click();
    await expect(page.getByText('进度 5', { exact: true })).toBeVisible();
  });

  test('G3：刚打开就点会话，照样进去（不被后来的数据冲掉）', async ({ page, stack }) => {
    await seed(stack);
    await page.goto(`${stack.url}/next/`);
    await expandDone(page);
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
    await login(ctx, stack);
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
    await expandDone(page);
    await expect(page.getByRole('link', { name: /cmd-demo-login-fix/ })).toBeVisible();
    const afterOk = calls;
    for (let i = 0; i < 3; i++) {
      await page.clock.runFor(10_000);
      await page.waitForTimeout(100);
    }
    expect(calls - afterOk).toBe(3); // 每 10 秒一次，30 秒三次
  });
});

/** 把一个标签页伪装成「在后台」或「回到前台」：改 visibilityState 并发 visibilitychange（无头浏览器里各页都算可见）。 */
async function setVisibility(page: import('@playwright/test').Page, v: 'hidden' | 'visible'): Promise<void> {
  await page.evaluate((state) => {
    Object.defineProperty(document, 'visibilityState', { configurable: true, get: () => state });
    document.dispatchEvent(new Event('visibilitychange'));
  }, v);
}

test.describe('#3818：多标签页只占可见的那几条连接', () => {
  test('8 个标签页隐藏 7 个，10 秒后还开着的 SSE 不超过 1 条，可见的那个照常实时', async ({
    browser,
    stack,
  }, testInfo) => {
    test.skip(testInfo.project.name !== 'desktop-1440', '多标签页只在桌面跑一遍');
    test.setTimeout(120_000);
    await emitProgress(stack, S, 1, 3);
    const ctx = await browser.newContext({ viewport: { width: 1440, height: 900 } });
    await login(ctx, stack);
    // 浏览器对同一域名最多 6 条 HTTP/1.1 连接：8 个标签页同时开，后面的要排队——这正是后台释放要解决的
    const pages: import('@playwright/test').Page[] = [];
    for (let i = 0; i < 8; i++) {
      const p = await ctx.newPage();
      void p.goto(`${stack.url}/next/s/${S}`).catch(() => undefined);
      pages.push(p);
    }
    await expect.poll(() => stack.stats.openSse, { timeout: 30_000 }).toBeGreaterThanOrEqual(1);
    const visible = pages[7];
    if (!visible) throw new Error('没有可见页');
    for (const p of pages.slice(0, 7)) await setVisibility(p, 'hidden');
    await expect.poll(() => stack.stats.openSse, { timeout: 30_000 }).toBeLessThanOrEqual(1);
    // 释放后可见页（如果刚才在排队）连上，且开着的始终不超过 1 条
    await expect(feedStatus(visible)).toHaveAttribute('data-feed-status', 'live', { timeout: 30_000 });
    await expect.poll(() => pageIds(visible)).toEqual(await dbIds(stack, S));
    await emitProgress(stack, S, 4, 1);
    await expect.poll(() => pageIds(visible)).toEqual(await dbIds(stack, S));
    expect(stack.stats.openSse).toBeLessThanOrEqual(1);
    await ctx.close();
  });

  test('隐藏的标签页回到前台：带 Last-Event-ID 续上，隐藏期间写的事件不漏不重', async ({
    browser,
    stack,
  }, testInfo) => {
    test.skip(testInfo.project.name !== 'desktop-1440', '多标签页只在桌面跑一遍');
    test.setTimeout(120_000);
    await emitProgress(stack, S, 1, 4);
    const ctx = await browser.newContext({ viewport: { width: 1440, height: 900 } });
    await login(ctx, stack);
    const page = await ctx.newPage();
    await openSession(page, stack);
    await expect.poll(() => pageIds(page)).toEqual(await dbIds(stack, S));
    expect(stack.stats.openSse).toBe(1);

    await setVisibility(page, 'hidden');
    await expect.poll(() => stack.stats.openSse, { timeout: 30_000 }).toBe(0); // 10 秒后放掉
    await emitProgress(stack, S, 5, 7); // 后台期间写进库
    const before = await pageIds(page);
    expect(before.length).toBeLessThan((await dbIds(stack, S)).length); // 后台没在收

    await setVisibility(page, 'visible');
    await expect(feedStatus(page)).toHaveAttribute('data-feed-status', 'live', { timeout: 30_000 });
    const truth = await dbIds(stack, S);
    await expect.poll(() => pageIds(page)).toEqual(truth);
    expect(new Set(await pageIds(page)).size).toBe(truth.length);
    await expect(feedStatus(page)).toHaveAttribute('data-resyncs', '0'); // 补得全，不用整页重取
    expect(stack.stats.openSse).toBe(1);
    await ctx.close();
  });
});

test.describe('#3818：登录和翻页', () => {
  test.describe('没带登录 Cookie', () => {
    test.use({ loggedIn: false });
    test('401：会话列表和会话页都给登录入口（指向旧驾驶舱的登录），不反复重试', async ({ page, stack }) => {
      await seed(stack);
      let listCalls = 0;
      await page.route('**/next/api/sessions', async (route) => {
        listCalls++;
        await route.continue();
      });
      await page.goto(`${stack.url}/next/`);
      const feishu = page.getByRole('link', { name: '用飞书登录' });
      await expect(feishu).toBeVisible();
      await expect(feishu).toHaveAttribute('href', '/auth/feishu/login?next=%2Fnext%2F');
      await expect(page.getByRole('link', { name: '账密登录' })).toHaveAttribute('href', '/login');
      await page.waitForTimeout(1500);
      expect(listCalls).toBe(1);
      await page.goto(`${stack.url}/next/s/cmd-demo-login-fix`);
      await expect(page.getByRole('link', { name: '用飞书登录' }).first()).toBeVisible();
      expect(stack.stats.sseAttempts.length).toBeLessThanOrEqual(1);
    });
  });

  test('退出（session_version 加 1）后，开着的流在一个周期内断开，页面给登录入口', async ({
    page,
    stack,
  }) => {
    await emitProgress(stack, S, 1, 2);
    await openSession(page, stack);
    await stack.logoutAll();
    await expect(feedStatus(page)).toHaveAttribute('data-feed-status', 'failed', { timeout: 30_000 });
    await expect(page.getByRole('link', { name: '用飞书登录' }).first()).toBeVisible();
  });

  test('会话列表「加载更多」：翻出更老的，不重不漏', async ({ page, stack }) => {
    for (let i = 0; i < 35; i++) {
      await stack.emit(`page-${String(i).padStart(2, '0')}`, 'worker.progress.reported', {
        summary: `s${i}`,
      });
    }
    await page.goto(`${stack.url}/next/`);
    await expect(page.getByRole('link', { name: /page-34/ })).toBeVisible();
    const items = page.locator('section[aria-label="会话列表"] li');
    await expect(items).toHaveCount(30);
    await page.getByRole('button', { name: '加载更多' }).click();
    await expect(items).toHaveCount(35);
    await expect(page.getByRole('button', { name: '加载更多' })).toBeHidden();
    const ids = await items.evaluateAll((els) => els.map((e) => e.querySelector('a')?.getAttribute('href')));
    expect(new Set(ids).size).toBe(35);
    // 轮询刷新最新一页后，翻出来的还在
    await stack.emit('page-00', 'worker.progress.reported', { summary: 'bump' });
    await expect(items.first()).toContainText('page-00');
    await expect(items).toHaveCount(35);
  });
});

test.describe('#3781 第二轮：工具调用折叠、长输出预览、列表按状态分组', () => {
  test('列表按工人状态分组：卡住 > 在跑 > 等待 > 做完，卡住的置顶带数量，状态变了自己挪组', async ({
    page,
    stack,
  }) => {
    await seed(stack);
    await page.goto(`${stack.url}/next/`);
    const groups = page.locator('section[aria-label="会话列表"] [data-group]');
    await expect(groups).toHaveCount(4);
    expect(await groups.evaluateAll((els) => els.map((e) => e.getAttribute('data-group')))).toEqual([
      'stuck',
      'running',
      'waiting',
      'done',
    ]);
    await expect(page.getByTestId('group-count-stuck')).toHaveText('1');
    await expect(page.locator('[data-group="stuck"] [data-session-id]')).toHaveText(/cmd-demo-flaky-ci/);
    await expect(page.locator('[data-group="running"] [data-session-id]')).toHaveText(/cmd-demo-migration/);
    // 「做完」组默认折叠：有条数、没有会话行；点开才出来（折叠状态的专项用例在下面）
    await expect(page.getByTestId('group-count-done')).toHaveText('1');
    await expect(page.locator('[data-group="done"] [data-session-id]')).toHaveCount(0);
    await expandDone(page);
    await expect(page.locator('[data-group="done"] [data-session-id]')).toHaveText(/cmd-demo-login-fix/);
    // 组内按最后事件倒序：等待组里 test-run（更新）在 docs-sweep 前面；工人会话 worker-d12-a1（#3781 样例，
    // 交了结果等核验）最早灌的，排在最后
    expect(
      await page
        .locator('[data-group="waiting"] [data-session-id]')
        .evaluateAll((els) => els.map((e) => e.getAttribute('data-session-id'))),
    ).toEqual(['cmd-demo-test-run', 'cmd-demo-docs-sweep', 'worker-d12-a1']);
    // 新的终局交回（没交付）进来：下一次轮询后 test-run 挪进卡住组，卡住数变 2
    await stack.emit('cmd-demo-test-run', 'handback.recorded', { final: true, outcome: 'dead' });
    await expect(page.getByTestId('group-count-stuck')).toHaveText('2', { timeout: 25_000 });
    await expect(page.locator('[data-group="stuck"] [data-session-id]').first()).toHaveText(
      /cmd-demo-test-run/,
    );
  });

  test('#3781 收尾：做完组默认折叠带条数，点开展开，刷新后记住；枚举值显示中文、原值在 title', async ({
    page,
    stack,
  }) => {
    await seed(stack);
    await page.goto(`${stack.url}/next/`);
    const toggle = page.getByTestId('toggle-done');
    await expect(toggle).toHaveAttribute('aria-expanded', 'false');
    await expect(page.getByTestId('group-count-done')).toHaveText('1');
    await expect(page.locator('[data-group="done"] [data-session-id]')).toHaveCount(0);
    // 列表一句话里的事件类型是中文，原值在 title 里
    const row = page.locator('[data-session-id="cmd-demo-flaky-ci"]');
    await expect(row).not.toContainText('handback.recorded');
    await expect(row).not.toContainText('worker.');
    await expect(row.locator('[title^="handback."], [title^="worker."], [title^="session."]')).toHaveCount(1);
    await toggle.click();
    await expect(toggle).toHaveAttribute('aria-expanded', 'true');
    await expect(page.locator('[data-group="done"] [data-session-id]')).toHaveCount(1);
    // 刷新后仍是展开（localStorage）
    await page.reload();
    await expect(page.getByTestId('toggle-done')).toHaveAttribute('aria-expanded', 'true');
    await expect(page.locator('[data-group="done"] [data-session-id]')).toHaveCount(1);
    // 再折叠，刷新后仍是折叠
    await page.getByTestId('toggle-done').click();
    await page.reload();
    await expect(page.getByTestId('toggle-done')).toHaveAttribute('aria-expanded', 'false');
    // 事件卡：交回的结局、核验结论是中文，原值在 title
    await page.getByTestId('toggle-done').click();
    await page.getByRole('link', { name: /cmd-demo-login-fix/ }).click();
    const handback = page.locator('[data-event-type="handback.recorded"]');
    await expect(handback).toBeVisible();
    await expect(handback.getByText('已交付')).toHaveAttribute('title', 'delivered');
    // 折叠的「原始内容」里本来就是原值，不在这里查
    await expect(handback.locator('span[title="handback.recorded"]')).toHaveText('交回核验');
  });

  test('#3781 收尾：卡住个数由服务端数——页面只加载了一页，数的是全部', async ({ page, stack }) => {
    for (let i = 0; i < 33; i++) {
      await stack.emit(`stuck-${String(i).padStart(2, '0')}`, 'worker.settled', { exitCode: 1 });
    }
    await page.goto(`${stack.url}/next/`);
    // 第一页只有 30 个会话（全是卡住的），徽标仍是服务端数的 33。窄屏下这条顶栏本来就收起（max-md:hidden），
    // 所以只查它在不在页面里，不查可见
    const badge = page.getByText('卡住 33', { exact: true });
    await expect(badge).toHaveCount(1);
    await expect(page.getByTestId('group-count-stuck')).toHaveText('30');
    await page.getByRole('button', { name: '加载更多' }).click();
    await expect(page.getByTestId('group-count-stuck')).toHaveText('33');
    await expect(badge).toHaveCount(1);
  });

  test('连续工具调用默认折叠成一行摘要，可展开；折叠时事件号对账不变', async ({ page, stack }) => {
    await seed(stack);
    await openSession(page, stack, 'cmd-demo-migration');
    const run = page.locator('[data-tool-run]');
    await expect(run).toHaveCount(1);
    await expect(run).toContainText('调了 5 次工具：report_progress×5');
    const cards = run.locator('[data-event-id]');
    await expect(cards).toHaveCount(5);
    await expect(cards.first()).toBeHidden();
    await expect.poll(() => pageIds(page)).toEqual(await dbIds(stack, 'cmd-demo-migration'));
    await run.getByRole('button').first().click();
    await expect(cards.first()).toBeVisible();
    await expect(cards.last()).toBeVisible();
    await run.getByRole('button').first().click();
    await expect(cards.first()).toBeHidden();
  });

  test('长输出默认只显示前 200 字或 12 行，可展开收起', async ({ page, stack }) => {
    await seed(stack);
    await openSession(page, stack, 'cmd-demo-test-run');
    const out = page.getByTestId('tool-output');
    await expect(out).toHaveAttribute('data-clamped', 'closed');
    await expect(out).toContainText('mod-01');
    await expect(out).toContainText('mod-12');
    await expect(out).not.toContainText('mod-13');
    await out.getByRole('button', { name: /展开全部（\d+ 字、40 行）/ }).click();
    await expect(out).toHaveAttribute('data-clamped', 'open');
    await expect(out).toContainText('mod-40');
    await out.getByRole('button', { name: '收起' }).click();
    await expect(out).not.toContainText('mod-40');
    // 字数先到：开场白有几百字，只显示前 200 字
    await openSession(page, stack, 'cmd-demo-migration');
    const clamped = page.locator('[data-clamped="closed"]').first();
    await expect(clamped).toContainText('把旧驾驶舱的任务页迁到新内核');
    await expect(clamped).not.toContainText('显示成零或空');
    await clamped.getByRole('button').click();
    await expect(page.locator('[data-clamped="open"]').first()).toContainText('显示成零或空');
  });
});

test.describe('#3818：打包产物里没有会话令牌头名', () => {
  test('dist/ 里搜不到会话令牌的头名和 cookie 名', () => {
    const dist = resolve(import.meta.dirname, '../../dist');
    const walk = (dir: string): string[] =>
      readdirSync(dir).flatMap((n) => {
        const p = join(dir, n);
        return statSync(p).isDirectory() ? walk(p) : [p];
      });
    const files = walk(dist).filter((f) => /\.(js|css|html|json|map)$/.test(f));
    expect(files.length).toBeGreaterThan(0);
    for (const f of files) {
      const text = readFileSync(f, 'utf8').toLowerCase();
      expect(text, f).not.toContain('x-fleet-session-token');
      expect(text, f).not.toContain('fleet_session_token');
    }
  });
});
