// 第二步：主页（一屏三块 + 持续状态）。每块的内容都来自真库，不是假数据。
// 「在跑的」是初版那样的思维导图看板（React Flow + ELK：中心 → 三段 → 每张单；创始人 2026-10-07「react-flow 我还是喜欢初版那样」）：
// 每张在跑的单是一个节点 [data-id^="ticket:"]，卡片上 data-running-card 写它在哪一段，三段节点上 data-flow-lane 写段名；
// 排完版先「全部收进视野」，单子多时是远景（只剩单号），要看卡上的字先切到中景（midZoom）；
// 这些段是用引擎自己的写法（db 的 startRun / finishRun）写进 runs 表的，不是直接塞行（packages/api/test/e2e/prepare.ts）。
import { expect, test } from '../support/fixtures.ts';

type Home = {
  health: { engine: { state: 'on' | 'off' | 'down' | 'unknown'; detail?: string } };
  decisions: { kind: string; id: string; title: string; link: string }[];
  running: {
    issueNumber: number;
    title: string;
    segment: string | null;
    worker?: string;
    link: string;
    waitingReason: string;
    pendingDecision?: string;
    lastEvent?: { tone: 'ok' | 'wait' | 'trouble' };
  }[];
  done: { prNumber: number; title: string }[];
  flow: { segment: string; inFlight: number; avgMs?: number; samples: number }[];
};

const card = (page: import('@playwright/test').Page, issue: number) =>
  page.locator('[data-running-card]', { hasText: new RegExp(`#${issue}\\b`) });

/** 切到中景：卡上出现标题、谁在做、最近一次事件（远景只剩单号）。 */
async function midZoom(page: import('@playwright/test').Page) {
  await expect(page.locator('.react-flow__node[data-id^="ticket:"]').first()).toBeVisible();
  await page.getByRole('button', { name: /^中景/ }).click();
}

/**
 * 要你拍的、做完的收在画布右上角的抽屉里（#1801）：各档屏宽默认都收起（#1819），点按钮开（≥1920 停靠成右侧一列，更窄浮在画布上）；
 * 手机是列表顶上一条横条，点开是底部抽屉。统一在这里开：已经开着的不再点（再点就收起了）。
 */
async function openDrawer(page: import('@playwright/test').Page, tab: '要你拍的' | '做完的' = '要你拍的') {
  const phone = (page.viewportSize()?.width ?? 1920) < 768;
  const opened = phone ? page.getByRole('dialog') : page.locator('[data-home-drawer]');
  if (!(await opened.count())) {
    if (phone) await page.locator('[data-home-strip]').click();
    else await page.getByRole('button', { name: new RegExp(`^${tab}.*打开抽屉`) }).click();
  }
  await page.getByRole('tab', { name: new RegExp(`^${tab}`) }).click();
}

test.describe('主页', () => {
  test.beforeEach(async ({ login }) => login());

  test('三块都显示真库里的东西，条数和后端 /api/home 一致', async ({ page, api, shot }) => {
    const home = (await api.get('/api/home')) as Home;
    await page.goto('/');
    // 画布右上角的抽屉按钮写着要你拍的条数
    await expect(page.getByRole('button', { name: /^要你拍的 \d+ 条/ })).toBeVisible();
    await openDrawer(page);

    // 要你拍的：一条待批（库里 approval 通知）和 decision 级通知。页面上最多 3 条，剩下的写「还有 N 条」
    expect(home.decisions.map((d) => d.kind)).toContain('approval');
    expect(home.decisions.map((d) => d.kind)).not.toContain('ask');
    for (const d of home.decisions.slice(0, 3)) await expect(page.getByText(d.title).first()).toBeVisible();
    await expect(page.getByText('等你批：合并 PR #41（碰了删数据的人闸）').first()).toBeVisible();

    // 在跑的：流水线图上每张开着的单一个节点，和后端的条数一致
    await expect(page.locator('[data-flow-board]')).toBeVisible();
    await expect(page.locator('.react-flow__node[data-id^="ticket:"]')).toHaveCount(home.running.length);

    // 做完的（抽屉的另一页）：合进去的 PR #39，标题是它挂的那张单的标题
    await openDrawer(page, '做完的');
    await expect(page.getByRole('link', { name: /PR #39 README 加一行当前时间/ })).toBeVisible();
    expect(home.done.map((d) => d.prNumber)).toContain(39);

    // 持续状态（标题右边）：额度、路由、引擎三格都有话说
    const strip = page.getByRole('status', { name: '持续状态' });
    await expect(strip).toContainText('额度');
    await expect(strip).toContainText('中转');
    await expect(strip).toContainText('引擎');
    await shot(page, '02-主页');
  });

  test('流水线图：每张单落在它真所在的那一段（段来自 runs 表里引擎写的流水）', async ({ page, api }) => {
    const home = (await api.get('/api/home')) as Home;
    const seg = (n: number) => home.running.find((r) => r.issueNumber === n)?.segment;
    // #12 对题收了、动手在跑 → 动手；#17 对题动手都收了、验收没起 → 还没验；#15 排队没开始 → 对题
    expect(seg(12)).toBe('doing');
    expect(seg(17)).toBe('verify_pending');
    expect(seg(15)).toBe('scoping');
    await page.goto('/');
    await midZoom(page);
    await expect(card(page, 12)).toHaveAttribute('data-running-card', 'doing');
    await expect(card(page, 17)).toHaveAttribute('data-running-card', 'verify_pending');
    await expect(card(page, 15)).toHaveAttribute('data-running-card', 'scoping');
    // #12 的卡上写着谁在做（动手那一笔跑在 Opus 5.5 上）
    await expect(card(page, 12)).toContainText('Opus 5.5');
    // 三段节点：各自写在途几张和平均耗时（对题、动手有跑完的样本，验收没有 = 不给平均、不写 0）
    const lanes = page.locator('[data-flow-lane]');
    await expect(lanes).toHaveCount(3);
    await expect(page.locator('[data-flow-lane="manual"]')).toContainText('在途');
    await expect(page.locator('[data-flow-lane="verify"]')).not.toContainText(/平均 0/);
  });

  test('单击看板上的单：右边滑出详情；点「打开单子详情」进到那张单的详情页', async ({ page, stack }) => {
    await page.goto('/');
    await card(page, 12).click();
    const detail = page.locator('[data-board-detail]');
    await expect(detail).toContainText('登录页加验证码');
    await detail.getByRole('link', { name: /打开单子详情/ }).click();
    await expect(page).toHaveURL(new RegExp(`/tasks/${stack.facts.tasks.running}`));
    await expect(page.getByRole('heading', { name: /登录页加验证码/ })).toBeVisible();
  });

  // 画布为主体（#1801，创始人 2026-10-11「空间以画布为主体」）：正文区整块是画布，没有左列，
  // 「要你拍的」「做完的」收在右上角的抽屉里；1920、1366 两个视口都一样
  test('画布占满正文区、一进来就在首屏里；要你拍的、做完的在右上角抽屉里', async ({ page }) => {
    await page.goto('/');
    const main = await page.getByRole('main').boundingBox();
    const canvas = await page.locator('[data-home-canvas]').boundingBox();
    expect(main && canvas, '画布和正文区都量得到').toBeTruthy();
    if (!main || !canvas) return;
    expect(canvas.x, '画布左边贴着正文区，没有左列').toBeLessThanOrEqual(main.x + 1);
    expect(canvas.y, '画布顶边贴着正文区，没有标题行').toBeLessThanOrEqual(main.y + 1);
    expect(canvas.height, '画布占满正文区高度').toBeGreaterThanOrEqual(main.height - 2);
    // 看板的画布和第一张单不用滚就看得见
    await expect(page.locator('.react-flow__node[data-id^="ticket:"]').first()).toBeInViewport();
    // 抽屉按钮在画布右上角
    const button = await page.getByRole('button', { name: /^要你拍的 \d+ 条/ }).boundingBox();
    expect(button && button.x > canvas.x + canvas.width / 2 && button.y < canvas.y + 80).toBe(true);
  });

  // 缺陷 D2（#902）在 #914 之后已经不成立：停滞（超时没交活）的 #14 现在落在「动手」、画成红色「出问题了」并写明「动手超时」，
  // 不再是蓝色「在跑」。留着这条用例钉住它。
  test('停滞的单在图上画成出问题、写明原因，不装作在好好跑', async ({ page }) => {
    await page.goto('/');
    await midZoom(page);
    await expect(card(page, 14)).toContainText('动手超时');
    await expect(card(page, 14)).toHaveAttribute('data-needs-founder', 'false');
  });

  // 原来 D9（#902）钉的是「泳道右边缘被面板截掉一截」；换成思维导图后同一件事是：排完版整张图收进画布里，一张卡都不被截。
  test('看板：排完版整张图收进画布里（中心、三段、每张单都在画布框里，不被截掉）', async ({ page }) => {
    await page.goto('/');
    await expect(page.locator('[data-flow-board]')).toBeVisible();
    await expect(page.locator('.react-flow__node-segment')).toHaveCount(3);
    // 收进视野是一段 450 毫秒的动画：等它停下再量
    await expect
      .poll(
        async () =>
          page.evaluate(() => {
            const frame = document.querySelector('[data-flow-board] .react-flow')?.getBoundingClientRect();
            if (!frame) return ['没有画布'];
            return [...document.querySelectorAll('.react-flow__node')]
              .map((n) => ({ id: n.getAttribute('data-id'), r: n.getBoundingClientRect() }))
              .filter(
                ({ r }) =>
                  r.left < frame.left ||
                  r.right > frame.right ||
                  r.top < frame.top ||
                  r.bottom > frame.bottom,
              )
              .map(({ id }) => id);
          }),
        { message: '每张卡都在画布框里' },
      )
      .toEqual([]);
  });

  test('看板的交互照初版：「只看卡住的」只剩出问题的，不含等你拍；键盘 ? 打开快捷键说明', async ({
    page,
    api,
  }) => {
    const home = (await api.get('/api/home')) as Home;
    await page.goto('/');
    await expect(page.locator('.react-flow__node[data-id^="ticket:"]')).toHaveCount(home.running.length);
    await page.getByRole('button', { name: /^只看卡住的/ }).click();
    await expect(page).toHaveURL(/stuck=1/);
    // 卡住的 = 失败色（最近一次是 trouble，且不是被人暂停）。等你拍不算。按后端给的数据算，不按单号猜。
    const stuck = home.running.filter((r) => r.waitingReason !== 'paused' && r.lastEvent?.tone === 'trouble');
    expect(
      stuck.map((r) => r.issueNumber),
      '#14 动手超时，算卡住',
    ).toContain(14);
    expect(stuck.length, '至少藏掉一张正常往前走的').toBeLessThan(home.running.length);
    await expect(page.locator('.react-flow__node[data-id^="ticket:"]')).toHaveCount(stuck.length);
    for (const r of stuck) await expect(card(page, r.issueNumber)).toHaveCount(1);
    // 三段节点还在（过滤只藏单子）
    await expect(page.locator('.react-flow__node-segment')).toHaveCount(3);
    // React Flow 自己的外框也是 role=application：按名字认看板那一层
    await page.getByRole('application', { name: /在跑的单的看板/ }).focus();
    await page.keyboard.press('?');
    await expect(page.getByRole('dialog', { name: /看板快捷键/ })).toBeVisible();
  });

  // 缺陷 D7（#902，#914 之后修）：「引擎 正常」只看配置里开没开引擎。现在开着的要真探到在线的工人；
  // 这套 e2e 环境没有 Temporal、没有引擎，所以必须写「引擎进程没连上」并标红，不能写正常。
  // 名字带「进程」：和顶栏「总开关」分开，一个是进程活没活，一个是人给的许可。
  test('引擎那一格读真实健康：没有引擎在跑就写「引擎进程没连上」并标红，不写正常', async ({ page, api }) => {
    const home = (await api.get('/api/home')) as Home;
    expect(['down', 'off']).toContain(home.health.engine.state);
    await page.goto('/');
    const chip = page.locator('[data-health-chip]', { hasText: '引擎进程' });
    await expect(chip).toBeVisible();
    if (home.health.engine.state === 'down') {
      await expect(chip).toContainText('引擎进程没连上');
      await expect(chip).toHaveAttribute('data-health-chip', 'bad');
    } else {
      await expect(chip).toContainText('引擎进程已停用');
      await expect(chip).toHaveAttribute('data-health-chip', 'warn');
    }
    await expect(chip).not.toContainText('正常');
  });

  test('react-flow 右下角的水印保留着（MIT 不强制，隐藏它要订阅 Pro，不擅自花钱）', async ({ page }) => {
    await page.goto('/');
    await expect(page.locator('.react-flow__attribution')).toContainText('React Flow');
  });
});

test.describe('主页：深色主题和手机宽度', () => {
  test.beforeEach(async ({ login }) => login());

  test('深色主题：跟随系统是深色时页面真换成深色，流水线图、卡片都看得清', async ({ page, shot }) => {
    await page.emulateMedia({ colorScheme: 'dark' });
    await page.goto('/');
    await expect(page.locator('[data-flow-board]')).toBeVisible();
    // 背景是深色：取页面背景的亮度
    const luminance = await page.evaluate(() => {
      const m = /rgba?\((\d+),\s*(\d+),\s*(\d+)/.exec(getComputedStyle(document.body).backgroundColor);
      return m ? (Number(m[1]) + Number(m[2]) + Number(m[3])) / 3 : 255;
    });
    expect(luminance).toBeLessThan(80);
    await expect(page.locator('.react-flow__node[data-id^="ticket:"]').first()).toBeVisible();
    await shot(page, '02-主页-深色');
  });

  test('手机宽度（390×844）：底部导航、不出现横向滚动条、要你拍的在顶上横条里、看板一屏里就有', async ({
    page,
    shot,
  }) => {
    await page.setViewportSize({ width: 390, height: 844 });
    await page.goto('/');
    await expect(page.locator('[data-home-strip]')).toBeVisible();
    await expect(page.locator('[data-board-tree]')).toBeVisible();
    // 常驻侧栏在手机上不渲染，换成底部导航；顶栏没有汉堡按钮
    await expect(page.locator('aside')).toHaveCount(0);
    await expect(page.getByRole('navigation', { name: '底部导航' })).toBeVisible();
    await expect(page.getByRole('button', { name: '打开导航' })).toHaveCount(0);
    // 顶栏总开关状态点看得见
    await expect(page.locator('header [data-engine-master]')).toBeVisible();
    const overflow = await page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth);
    expect(overflow, '页面不该比屏幕宽').toBeLessThanOrEqual(1);
    const main = await page.evaluate(() => {
      const el = document.querySelector('main');
      return el ? el.scrollWidth - el.clientWidth : -1;
    });
    expect(main, '正文区不横向溢出').toBeLessThanOrEqual(0);
    await shot(page, '02-主页-手机');
    // 点开横条：底部抽屉里有要你拍的和做完的
    await openDrawer(page);
    await expect(page.getByRole('tab', { name: /^做完的/ })).toBeVisible();
    await shot(page, '02-主页-手机-抽屉');
  });

  // 原来 D11（#902）钉的是「手机上要横拖、和页面竖向滚动抢手势」。初版看板在手机上本来就不放画布：
  // 退化成可折叠的树形列表（一段一组、每张单一张卡），一路往下滑就看全，没有画布也就不抢手势。
  test('手机宽度：看板是树形列表，三段一段一组、卡都在屏幕里；没有画布、没有缩放按钮', async ({
    page,
    api,
    shot,
  }) => {
    const home = (await api.get('/api/home')) as Home;
    await page.setViewportSize({ width: 390, height: 844 });
    await page.goto('/');
    const tree = page.locator('[data-board-tree]');
    await expect(tree).toBeVisible();
    await expect(page.locator('.react-flow')).toHaveCount(0);
    await expect(page.getByRole('button', { name: '放大' })).toHaveCount(0);
    await expect(tree.locator('[data-flow-lane]')).toHaveCount(3);
    // 一张单一行摘要，默认不展开；点开才有整张卡
    await expect(tree.locator('[data-ticket-row]')).toHaveCount(home.running.length);
    await expect(tree.locator('[data-running-card]')).toHaveCount(0);
    await tree.locator('[data-ticket-toggle]').first().click();
    await expect(tree.locator('[data-running-card]')).toHaveCount(1);
    const cards = await page.evaluate(() =>
      [...document.querySelectorAll('[data-board-tree] [data-ticket-row]')].map((n) => {
        const r = n.getBoundingClientRect();
        return { left: r.left, right: r.right };
      }),
    );
    for (const c of cards) {
      expect(c.left).toBeGreaterThanOrEqual(0);
      expect(c.right, '卡片不超出屏幕').toBeLessThanOrEqual(390);
    }
    const overflow = await page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth);
    expect(overflow, '页面不该比屏幕宽').toBeLessThanOrEqual(1);
    await tree.scrollIntoViewIfNeeded();
    await shot(page, '02-主页-手机-看板-树形');
  });
});
