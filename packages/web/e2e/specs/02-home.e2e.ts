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

test.describe('主页', () => {
  test.beforeEach(async ({ login }) => login());

  test('三块都显示真库里的东西，条数和后端 /api/home 一致', async ({ page, api, shot }) => {
    const home = (await api.get('/api/home')) as Home;
    await page.goto('/');
    await expect(page.getByRole('heading', { name: '要你拍的' })).toBeVisible();

    // 要你拍的：一条待批（库里 approval 通知）和 decision 级通知。页面上最多 3 条，剩下的写「还有 N 条」
    expect(home.decisions.map((d) => d.kind)).toContain('approval');
    expect(home.decisions.map((d) => d.kind)).not.toContain('ask');
    for (const d of home.decisions.slice(0, 3)) await expect(page.getByText(d.title).first()).toBeVisible();
    await expect(page.getByText('等你批：合并 PR #41（碰了删数据的人闸）').first()).toBeVisible();

    // 在跑的：流水线图上每张开着的单一个节点，和后端的条数一致
    await expect(page.locator('[data-flow-board]')).toBeVisible();
    await expect(page.locator('.react-flow__node[data-id^="ticket:"]')).toHaveCount(home.running.length);

    // 做完的：合进去的 PR #39，标题是它挂的那张单的标题
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

  // xl（1280）起就左右分栏（指挥官 2026-10-07 定：1366×768 一进来就要看到看板），1920、1366 两个视口都是
  test('宽屏和笔记本上「要你拍的」「做完的」在左列、看板在右，看板一进来就在首屏里', async ({ page }) => {
    await page.goto('/');
    const decisions = await page.getByRole('heading', { name: '要你拍的' }).boundingBox();
    const done = await page.getByRole('heading', { name: '做完的' }).boundingBox();
    const flow = await page.getByRole('heading', { name: '在跑的' }).boundingBox();
    expect(decisions && done && flow && decisions.x < flow.x && done.x < flow.x).toBe(true);
    // 看板的画布和第一张单不用滚就看得见
    await expect(page.locator('.react-flow__node[data-id^="ticket:"]').first()).toBeInViewport();
    const viewport = page.viewportSize();
    const canvas = await page.locator('[data-flow-board]').first().boundingBox();
    expect(canvas && viewport && canvas.y < viewport.height / 2).toBe(true);
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

  test('看板的交互照初版：「只看卡住的」只剩等你拍、出问题的；键盘 ? 打开快捷键说明', async ({
    page,
    api,
  }) => {
    const home = (await api.get('/api/home')) as Home;
    await page.goto('/');
    await expect(page.locator('.react-flow__node[data-id^="ticket:"]')).toHaveCount(home.running.length);
    await page.getByRole('button', { name: /^只看卡住的/ }).click();
    await expect(page).toHaveURL(/stuck=1/);
    // 卡住的 = 等你拍（founder_decision 或挂着要你拍的事）、出问题（最近一次事件是 trouble）；按后端给的数据算，不按单号猜
    const stuck = home.running.filter(
      (r) =>
        r.waitingReason === 'founder_decision' ||
        r.pendingDecision !== undefined ||
        r.lastEvent?.tone === 'trouble',
    );
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
  // 这套 e2e 环境没有 Temporal、没有引擎，所以必须写「引擎没连上」并标红，不能写正常。
  test('引擎那一格读真实健康：没有引擎在跑就写「引擎没连上」并标红，不写正常', async ({ page, api }) => {
    const home = (await api.get('/api/home')) as Home;
    expect(['down', 'off']).toContain(home.health.engine.state);
    await page.goto('/');
    const chip = page.locator('[data-health-chip]', { hasText: '引擎' });
    await expect(chip).toBeVisible();
    if (home.health.engine.state === 'down') {
      await expect(chip).toContainText('引擎没连上');
      await expect(chip).toHaveAttribute('data-health-chip', 'bad');
    } else {
      await expect(chip).toContainText('引擎已停用');
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

  test('手机宽度（390×844）：导航收起、不出现横向滚动条、三块都读得到', async ({ page, shot }) => {
    await page.setViewportSize({ width: 390, height: 844 });
    await page.goto('/');
    await expect(page.getByRole('heading', { name: '要你拍的' })).toBeVisible();
    await expect(page.getByRole('heading', { name: '在跑的' })).toBeVisible();
    await expect(page.getByRole('heading', { name: '做完的' })).toBeVisible();
    // 侧边导航在手机上收成抽屉：常驻的那一列看不见
    await expect(page.locator('aside')).toBeHidden();
    const overflow = await page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth);
    expect(overflow, '页面不该比屏幕宽').toBeLessThanOrEqual(1);
    await shot(page, '02-主页-手机');
    // 看板在折叠线下面：滚到它再截一张（手机上是树形列表，不是画布）
    await page.getByRole('heading', { name: '在跑的' }).scrollIntoViewIfNeeded();
    await page.locator('[data-board-tree]').scrollIntoViewIfNeeded();
    await expect(page.locator('[data-running-card]').first()).toBeVisible();
    await shot(page, '02-主页-手机-看板');
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
    await expect(tree.locator('[data-running-card]')).toHaveCount(home.running.length);
    const cards = await page.evaluate(() =>
      [...document.querySelectorAll('[data-board-tree] [data-running-card]')].map((n) => {
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
