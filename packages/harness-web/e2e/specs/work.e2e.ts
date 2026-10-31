// 任务页 /next/work 的 e2e（#3784）：影子批次画成波次图，1440 和 390 两种屏宽各跑一遍。
// 样例是 dev/seed.ts 的 demo-batch-2（10 单：排队、在跑×2、做完×2、失败、重试中、暂停、放弃、卡住）和 demo-batch-1（3 单做完）。
// 状态不是写死的：接口从活、交回、影子产物推出来，这里改库里的行再看页面跟着变。
import { events, jobs } from '@fleet-dao/harness-store';
import type { Page } from '@playwright/test';
import { eq } from 'drizzle-orm';
import { DEMO_RUN_ID, seed, seedWork, seedWorkBatch } from '../../dev/seed.ts';
import type { Stack } from '../../dev/stack.ts';
import { expect, test } from '../support/fixtures.ts';

const isMobile = () => test.info().project.name.startsWith('mobile');

async function openWork(page: Page, stack: Stack, view?: 'graph' | 'list') {
  await seed(stack);
  await seedWork(stack);
  await page.goto(`${stack.url}/next/work`);
  if (view) {
    await page.getByTestId(`view-${view}`).click();
  }
}
const nodes = (page: Page) => page.locator('[data-testid="work-node"]');

test.describe('任务页', () => {
  test('加载：批次图里一单一张卡，状态由库推出来，重试徽章和打分都在', async ({ page, stack }) => {
    await openWork(page, stack, 'graph');
    await expect(page.getByTestId('work-canvas')).toHaveAttribute('data-ready', '1');
    await expect(nodes(page)).toHaveCount(10);
    const states = await nodes(page).evaluateAll((els) =>
      els.map((e) => [(e as HTMLElement).dataset.nodeId, (e as HTMLElement).dataset.state]),
    );
    expect(Object.fromEntries(states)).toEqual({
      'demo/web#1': 'pending',
      'demo/web#2': 'running',
      'demo/web#3': 'completed',
      'demo/web#4': 'failed',
      'demo/web#5': 'running',
      'demo/web#6': 'completed',
      'demo/web#7': 'paused',
      'demo/web#8': 'running',
      'demo/web#9': 'failed',
      'demo/web#10': 'blocked',
    });
    // 4 行卡片：名字、状态·用时、类别·模型、一句话
    const running = page.locator('[data-node-id="demo/web#2"]');
    await expect(running).toContainText('web#2');
    await expect(running.getByTestId('card-state')).toContainText('在跑 ·');
    await expect(running).toContainText('影子 · claude-sonnet-5-5');
    await expect(running).toContainText('已复现，正在改分页游标的比较条件');
    // 重试过的右上角 ×2；没重试的没有
    await expect(page.locator('[data-node-id="demo/web#5"]').getByTestId('retry-badge')).toHaveText('×2');
    // 放弃的那张（领了 3 次）也是 ×3；其余没有
    await expect(page.locator('[data-node-id="demo/web#9"]').getByTestId('retry-badge')).toHaveText('×3');
    await expect(page.getByTestId('retry-badge')).toHaveCount(2);
    // 影子打分
    await expect(page.locator('[data-node-id="demo/web#3"]')).toContainText('重合');
    // 顶上的汇总
    await expect(page.getByTestId('work-summary')).toContainText('共 10 单');
    await expect(page.getByTestId('work-summary')).toContainText('在跑 3');
    // 单波：列头
    await expect(page.getByTestId('wave-head')).toHaveCount(1);
    // 同一波排成一列：x 相同
    const xs = await nodes(page).evaluateAll((els) => [
      ...new Set(els.map((e) => Math.round(e.getBoundingClientRect().left))),
    ]);
    expect(xs).toHaveLength(1);
  });

  test('在跑的用时每秒走', async ({ page, stack }) => {
    await openWork(page, stack, 'graph');
    const t = page.locator('[data-node-id="demo/web#2"]').getByTestId('card-state');
    const first = await t.textContent();
    await expect.poll(async () => t.textContent(), { timeout: 5000 }).not.toBe(first);
  });

  test('批次选择：默认最新一批，切到较早的一批只有 3 张卡', async ({ page, stack }) => {
    await openWork(page, stack, 'graph');
    const sel = page.getByTestId('batch-select');
    await expect(sel).toHaveValue('demo-batch-2');
    await expect(sel.locator('option')).toHaveCount(2);
    await sel.selectOption('demo-batch-1');
    await expect(nodes(page)).toHaveCount(3);
    await expect(page.getByTestId('work-summary')).toContainText('共 3 单');
    await sel.selectOption('demo-batch-2');
    await expect(nodes(page)).toHaveCount(10);
  });

  test('点卡片：电脑在右侧开面板看会话详情，手机整页跳过去', async ({ page, stack }) => {
    await openWork(page, stack, 'graph');
    await expect(nodes(page)).toHaveCount(10);
    // 排队的没有运行，点不开
    await expect(page.locator('[data-node-id="demo/web#1"]')).toHaveAttribute('aria-disabled', 'true');
    await expect(page.locator('[data-node-id="demo/web#3"]')).toHaveAttribute('aria-disabled', 'false');
    await page.locator('[data-node-id="demo/web#1"]').click({ force: true });
    await expect(page.getByTestId('work-panel')).toHaveCount(0);
    const done = page.locator(`button[data-node-id="demo/web#3"]`);
    if (isMobile()) {
      await done.click();
      await expect(page).toHaveURL(new RegExp(`/next/s/worker-${DEMO_RUN_ID}$`));
      await expect(page.getByTestId('session-stream')).toHaveAttribute('data-feed-status', 'live');
      return;
    }
    await done.click();
    await expect(page.getByTestId('work-panel')).toBeVisible();
    await expect(page.getByTestId('panel-tab')).toHaveCount(1);
    await expect(page.getByTestId('session-stream')).toHaveAttribute('data-feed-status', 'live');
    await expect(page.getByTestId('work-panel')).toContainText('登录页窄屏修好');
    // 再开一张：两个标签；可切、可关
    await page.locator('button[data-node-id="demo/web#2"]').click();
    await expect(page.getByTestId('panel-tab')).toHaveCount(2);
    await page.locator(`[data-testid="panel-tab"][data-run-id="${DEMO_RUN_ID}"]`).click();
    await expect(page.getByTestId('work-panel')).toContainText('登录页窄屏修好');
    await page.getByTestId('panel-tab-close').first().click();
    await expect(page.getByTestId('panel-tab')).toHaveCount(1);
    await page.getByTestId('panel-tab-close').first().click();
    await expect(page.getByTestId('work-panel')).toHaveCount(0);
  });

  test('重试过的单：面板里按第几次切换', async ({ page, stack }) => {
    test.skip(isMobile(), '面板是电脑的画面');
    await openWork(page, stack, 'graph');
    await page.locator('button[data-node-id="demo/web#5"]').click();
    const sw = page.getByTestId('attempt-switch');
    await expect(sw).toHaveCount(2);
    await expect(sw.nth(1)).toHaveAttribute('aria-pressed', 'true');
    await sw.nth(0).click();
    await expect(page.getByTestId('panel-tab')).toHaveCount(2);
    await expect(sw.nth(0)).toHaveAttribute('aria-pressed', 'true');
  });

  test('一波超过 13 个：只画前 12 个，后面接「+N 更多」，点开全画，可收回', async ({ page, stack }) => {
    await seed(stack);
    await seedWorkBatch(
      stack,
      'big-batch',
      Array.from({ length: 14 }, (_, i) => ({ issue: 200 + i, kind: 'pending' as const })),
      { repo: 'demo/big', ageMin: 1 },
    );
    await page.goto(`${stack.url}/next/work`);
    await page.getByTestId('view-graph').click();
    await expect(page.getByTestId('batch-select')).toHaveValue('big-batch');
    await expect(nodes(page)).toHaveCount(12);
    const more = page.getByTestId('work-more');
    await expect(more).toHaveText('+2 更多');
    // 一列 12 张卡放不进一屏（缩放最小 0.6），「+N 更多」格在屏外：直接发点击，不靠鼠标移过去
    await more.dispatchEvent('click');
    await expect(nodes(page)).toHaveCount(14);
    await expect(more).toHaveText('收起');
    await more.dispatchEvent('click');
    await expect(nodes(page)).toHaveCount(12);
  });

  test('一波 16 个以上：用紧凑卡（一行）', async ({ page, stack }) => {
    await seed(stack);
    await seedWorkBatch(
      stack,
      'huge-batch',
      Array.from({ length: 16 }, (_, i) => ({
        issue: 300 + i,
        kind: i % 2 ? ('running' as const) : ('pending' as const),
      })),
      { repo: 'demo/huge', ageMin: 1 },
    );
    await page.goto(`${stack.url}/next/work`);
    await page.getByTestId('view-graph').click();
    await expect(nodes(page)).toHaveCount(12);
    await expect(nodes(page).first()).toHaveAttribute('data-compact', '1');
    const h = await nodes(page)
      .first()
      .evaluate((e) => e.getBoundingClientRect().height);
    expect(h).toBeLessThan(40);
  });

  test('窄屏默认列表且不横滚；可切到图，选择记在本机', async ({ page, stack }) => {
    test.skip(!isMobile(), '窄屏的画面');
    await openWork(page, stack);
    await expect(page.getByTestId('work-list')).toBeVisible();
    await expect(page.getByTestId('work-canvas')).toHaveCount(0);
    await expect(page.getByTestId('work-row')).toHaveCount(10);
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
    // 失败、卡住的排在前面
    const first = await page.getByTestId('work-row').first().getAttribute('data-state');
    expect(['failed', 'blocked']).toContain(first);
    // 整行可点；排队的点不开
    await expect(page.locator('div[data-testid="work-row"][data-node-id="demo/web#1"]')).toHaveCount(1);
    await page.getByTestId('view-graph').click();
    await expect(page.getByTestId('work-canvas')).toBeVisible();
    await page.reload();
    await expect(page.getByTestId('work-canvas')).toBeVisible();
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
  });

  test('电脑默认图；切到列表后点行开面板', async ({ page, stack }) => {
    test.skip(isMobile(), '电脑的画面');
    await openWork(page, stack);
    await expect(page.getByTestId('work-canvas')).toBeVisible();
    await page.getByTestId('view-list').click();
    await expect(page.getByTestId('work-row')).toHaveCount(10);
    await page.locator('button[data-testid="work-row"][data-node-id="demo/web#3"]').click();
    await expect(page.getByTestId('work-panel')).toContainText('登录页窄屏修好');
  });

  test('悬停一张卡：别的卡压到 20% 透明（没边时只亮自己）', async ({ page, stack }) => {
    test.skip(isMobile(), '悬停是电脑的交互');
    await openWork(page, stack, 'graph');
    await expect(nodes(page)).toHaveCount(10);
    await page.locator('[data-node-id="demo/web#2"]').hover();
    await expect(page.locator('[data-node-id="demo/web#4"]')).toHaveCSS('opacity', '0.2');
    await expect(page.locator('[data-node-id="demo/web#2"]')).toHaveCSS('opacity', '1');
    await page.mouse.move(5, 5);
    await expect(page.locator('[data-node-id="demo/web#4"]')).toHaveCSS('opacity', '1');
  });

  test('工具条：适应、上一波/下一波（单波时灰）；缩放范围 0.6–1.6', async ({ page, stack }) => {
    test.skip(isMobile(), '工具条是电脑的画面');
    await openWork(page, stack, 'graph');
    await expect(page.getByTestId('work-canvas')).toHaveAttribute('data-ready', '1');
    await expect(page.getByTestId('fit')).toBeEnabled();
    await expect(page.getByTestId('prev-wave')).toBeDisabled();
    await expect(page.getByTestId('next-wave')).toBeDisabled();
    const zoom = () =>
      page.evaluate(() => {
        const m = /scale\(([\d.]+)\)/.exec(
          (document.querySelector('.react-flow__viewport') as HTMLElement).style.transform,
        );
        return Number(m?.[1]);
      });
    const z0 = await zoom();
    expect(z0).toBeGreaterThanOrEqual(0.6);
    expect(z0).toBeLessThanOrEqual(1.6);
    // 用户缩放过 → 不再自动重适应；点「适应」恢复
    await page.mouse.move(700, 450);
    await page.keyboard.down('Control');
    await page.mouse.wheel(0, -400);
    await page.keyboard.up('Control');
    await expect.poll(zoom).not.toBe(z0);
    expect(await zoom()).toBeLessThanOrEqual(1.6);
    await page.getByTestId('fit').click();
    await expect.poll(zoom).toBeCloseTo(z0, 2);
  });

  test('多波依赖图（接口形状喂的假数据）：打开对准活跃波、上一波/下一波、拖过后不再自动适应、悬停亮上下游', async ({
    page,
    stack,
  }) => {
    test.skip(isMobile(), '电脑的画面');
    const mk = (id: string, state: string) => ({
      id,
      label: id,
      state,
      attempt: 1,
      startedAt: null,
      completedAt: null,
      model: null,
      category: null,
      headline: null,
      runIds: [],
      score: null,
    });
    const chain = Array.from({ length: 10 }, (_, i) =>
      mk(`n${i}`, i < 6 ? 'completed' : i === 6 ? 'running' : 'pending'),
    );
    const graph = {
      batchId: 'multi',
      at: new Date().toISOString(),
      nodes: [...chain, mk('lone', 'completed')],
      waves: chain.map((n, i) => ({ index: i, nodeIds: i === 0 ? [n.id, 'lone'] : [n.id] })),
      edges: chain.slice(1).map((n, i) => ({ from: `n${i}`, to: n.id })),
      truncatedFrom: null,
    };
    await page.route('**/next/api/work/batches?*', (r) =>
      r.fulfill({
        json: {
          batches: [{ batchId: 'multi', items: 11, counts: { completed: 7 }, snapshotAt: graph.at }],
          nextBefore: null,
        },
      }),
    );
    await page.route('**/next/api/work/batches/multi', (r) => r.fulfill({ json: graph }));
    await page.goto(`${stack.url}/next/work`);
    await page.getByTestId('view-graph').click();
    await expect(page.getByTestId('work-canvas')).toHaveAttribute('data-ready', '1');
    await expect(page.getByTestId('wave-head')).toHaveCount(10);
    const cx = async (id: string) => {
      const b = await page.locator(`[data-node-id="${id}"]`).boundingBox();
      return (b?.x ?? 0) + (b?.width ?? 0) / 2;
    };
    const mid = async () => {
      const b = await page.getByTestId('work-canvas').boundingBox();
      return (b?.x ?? 0) + (b?.width ?? 0) / 2;
    };
    // 打开时对准活跃波（n6 在跑）：它在画布中线附近
    await expect
      .poll(async () => Math.abs((await cx('n6')) - (await mid())), { timeout: 5000 })
      .toBeLessThan(40);
    // 下一波 / 上一波
    await page.getByTestId('next-wave').click();
    await expect
      .poll(async () => Math.abs((await cx('n7')) - (await mid())), { timeout: 5000 })
      .toBeLessThan(40);
    await page.getByTestId('prev-wave').click();
    await page.getByTestId('prev-wave').click();
    await expect
      .poll(async () => Math.abs((await cx('n5')) - (await mid())), { timeout: 5000 })
      .toBeLessThan(40);
    // 适应：回到活跃波
    await page.getByTestId('fit').click();
    await expect
      .poll(async () => Math.abs((await cx('n6')) - (await mid())), { timeout: 5000 })
      .toBeLessThan(40);
    // 悬停 n3：上下游（n0..n9）亮着，和它没关系的 lone 压到 20%
    await page.locator('[data-node-id="n6"]').hover();
    await expect(page.locator('[data-node-id="lone"]')).toHaveCSS('opacity', '0.2');
    await expect(page.locator('[data-node-id="n2"]')).toHaveCSS('opacity', '1');
    // 下游的排队卡本来就是 75%，亮着的意思是没被压到 20%
    await expect(page.locator('[data-node-id="n9"]')).toHaveCSS('opacity', '0.75');
    // 手动拖过之后，轮询来了新快照也不再自动重适应
    await page.mouse.move(600, 600);
    await page.mouse.down();
    await page.mouse.move(900, 620, { steps: 6 });
    await page.mouse.up();
    const moved = await cx('n6');
    expect(Math.abs(moved - (await mid()))).toBeGreaterThan(100);
    await page.waitForTimeout(11_000);
    expect(Math.abs((await cx('n6')) - moved)).toBeLessThan(2);
  });

  test('轮询：库里的状态变了，页面在下一轮（10 秒）跟着变', async ({ page, stack }) => {
    await openWork(page, stack, 'graph');
    const card = page.locator('[data-node-id="demo/web#8"]');
    await expect(card).toHaveAttribute('data-state', 'running');
    // 找到 #8 的活：它的派工请求事件号就是键里的数字
    const reqs = await stack.db
      .select({ id: events.id, payload: events.payload })
      .from(events)
      .where(eq(events.type, 'worker.spawn.requested'));
    const req8 = reqs.find(
      (r) => (r.payload as { shadow?: { issue?: number; batchId?: string } }).shadow?.issue === 8,
    );
    expect(req8).toBeTruthy();
    await stack.db
      .update(jobs)
      .set({ state: 'cancelled', leaseUntil: null, claimToken: null })
      .where(eq(jobs.key, `spawn:${req8?.id}`));
    await expect(card).toHaveAttribute('data-state', 'cancelled', { timeout: 20_000 });
    await expect(page.getByTestId('work-summary')).toContainText('已取消 1');
  });

  test('读失败：已显示的不丢，写明会重试；接口恢复后自己好', async ({ page, stack }) => {
    await openWork(page, stack, 'graph');
    await expect(nodes(page)).toHaveCount(10);
    await stack.stopApi();
    await expect(page.getByRole('status').filter({ hasText: '读不到最新状态' })).toBeVisible({
      timeout: 20_000,
    });
    await expect(nodes(page)).toHaveCount(10);
    await stack.startApi();
    await expect(page.getByRole('status').filter({ hasText: '读不到最新状态' })).toHaveCount(0, {
      timeout: 40_000,
    });
  });

  test('没有数据：空态；没登录：登录入口', async ({ page, stack }) => {
    await page.goto(`${stack.url}/next/work`);
    await expect(page.getByTestId('work-empty')).toContainText('还没有可看的批次');
  });
});

test.describe('没登录', () => {
  test.use({ loggedIn: false });
  test('给登录入口', async ({ page, stack }) => {
    await page.goto(`${stack.url}/next/work`);
    await expect(page.getByRole('alert')).toContainText('需要登录');
    await expect(page.getByRole('link', { name: '用飞书登录' })).toBeVisible();
  });
});
