// 第二步：主页（一屏三块 + 持续状态）。每块的内容都来自真库，不是假数据。
// 「在跑的」是三段流水线图（#914，react-flow）：每张在跑的单是一个节点 [data-id^="ticket:"]，卡片上 data-running-card 写它在哪一段；
// 这些段是用引擎自己的写法（db 的 startRun / finishRun）写进 runs 表的，不是直接塞行（packages/api/test/e2e/prepare.ts）。
import { expect, test } from '../support/fixtures.ts';

type Home = {
  health: { engine: { state: 'on' | 'off' | 'down' | 'unknown'; detail?: string } };
  decisions: { kind: string; id: string; title: string; link: string }[];
  running: { issueNumber: number; title: string; segment: string | null; worker?: string; link: string }[];
  done: { prNumber: number; title: string }[];
  flow: { segment: string; inFlight: number; avgMs?: number; samples: number }[];
};

const card = (page: import('@playwright/test').Page, issue: number) =>
  page.locator('[data-running-card]', { hasText: new RegExp(`#${issue}\\b`) });

test.describe('主页', () => {
  test.beforeEach(async ({ login }) => login());

  test('三块都显示真库里的东西，条数和后端 /api/home 一致', async ({ page, api, shot }) => {
    const home = (await api.get('/api/home')) as Home;
    await page.goto('/');
    await expect(page.getByRole('heading', { name: '要你拍的' })).toBeVisible();

    // 要你拍的：一条待批、两条追问（库里 approval 通知 + 两条未答的 ask）；页面上最多 3 条，剩下的写「还有 N 条」
    expect(home.decisions.map((d) => d.kind)).toEqual(expect.arrayContaining(['approval', 'ask']));
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
    await expect(card(page, 12)).toHaveAttribute('data-running-card', 'doing');
    await expect(card(page, 17)).toHaveAttribute('data-running-card', 'verify_pending');
    await expect(card(page, 15)).toHaveAttribute('data-running-card', 'scoping');
    // #12 的卡上写着谁在做（动手那一笔跑在 Opus 5.5 上）
    await expect(card(page, 12)).toContainText('Opus 5.5');
    // 泳道头：三段各自写在途几张和平均耗时（对题、动手有跑完的样本，验收没有 = 不给平均、不写 0）
    const lanes = page.locator('[data-flow-lane]');
    await expect(lanes).toHaveCount(3);
    await expect(page.locator('[data-flow-lane="manual"]')).toContainText('在途');
    await expect(page.locator('[data-flow-lane="verify"]')).not.toContainText(/平均 0/);
  });

  test('点流水线上的单，进到那张单的详情', async ({ page, stack }) => {
    await page.goto('/');
    await card(page, 12).click();
    await expect(page).toHaveURL(new RegExp(`/tasks/${stack.facts.tasks.running}`));
    await expect(page.getByRole('heading', { name: /登录页加验证码/ })).toBeVisible();
  });

  test('宽屏上「做完的」在左列、流水线在右', async ({ page }, info) => {
    test.skip(!info.project.name.endsWith('1920'), '2xl 以上才是双列');
    await page.goto('/');
    const done = await page.getByRole('heading', { name: '做完的' }).boundingBox();
    const flow = await page.getByRole('heading', { name: '在跑的' }).boundingBox();
    expect(done && flow && done.x < flow.x).toBe(true);
  });

  // 缺陷 D2（#902）在 #914 之后已经不成立：停滞（超时没交活）的 #14 现在落在「动手」、画成红色「出问题了」并写明「动手超时」，
  // 不再是蓝色「在跑」。留着这条用例钉住它。
  test('停滞的单在图上画成出问题、写明原因，不装作在好好跑', async ({ page }) => {
    await page.goto('/');
    await expect(card(page, 14)).toContainText('动手超时');
    await expect(card(page, 14)).toHaveAttribute('data-needs-founder', 'false');
  });

  // 缺陷 D3（#902）：「要你拍的」里追问的「去答」点过去是任务详情页，那页没有任何回答的地方。
  test('追问点「去答」之后，能在那一页回答它', async ({ page, stack }) => {
    test.fail(true, '缺陷 D3：「去答」是死胡同，任务页没有回答入口');
    await page.goto('/');
    await page.getByRole('link', { name: '去答' }).nth(1).click();
    await expect(page).toHaveURL(new RegExp(`/tasks/${stack.facts.tasks.running}`));
    await expect(page.getByRole('button', { name: /回答/ })).toBeVisible();
  });

  // 缺陷 D9（#902，#914 之后修）：1920×1080 上「验收」泳道的右边缘贴着面板边、被截掉一截。
  // 根子是 react-flow 先按退路宽度排一遍、视口被居中到错位置；现在量到容器宽度才挂画布，泳道两头各留一条边距。
  test('流水线图：每条泳道的左右边框都看得见，右边缘不贴面板边', async ({ page }) => {
    await page.goto('/');
    await expect(page.locator('[data-flow-board]')).toBeVisible();
    const m = await page.evaluate(() => {
      const frame = document.querySelector('[data-flow-board] .react-flow')?.getBoundingClientRect();
      const lanes = [...document.querySelectorAll('.react-flow__node-lane')].map((n) =>
        n.getBoundingClientRect(),
      );
      const vp = document.querySelector('.react-flow__viewport')?.getAttribute('style') ?? '';
      return {
        frame: frame && { left: frame.left, right: frame.right },
        lanes: lanes.map((r) => ({ left: r.left, right: r.right })),
        vp,
      };
    });
    expect(m.frame).toBeTruthy();
    const frame = m.frame as { left: number; right: number };
    expect(m.lanes.length).toBe(3);
    for (const l of m.lanes) {
      expect(l.left, '泳道左边框要在面板里面').toBeGreaterThanOrEqual(frame.left + 4);
      expect(l.right, '泳道右边框要在面板里面').toBeLessThanOrEqual(frame.right - 4);
    }
    expect(m.vp, '视口回原点，不带偏移').toContain('translate(0px, 0px)');
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
    // 流水线图在折叠线下面：滚到它再截一张
    await page.getByRole('heading', { name: '在跑的' }).scrollIntoViewIfNeeded();
    await page.locator('[data-flow-board]').scrollIntoViewIfNeeded();
    await expect(page.locator('.react-flow__node[data-id^="ticket:"]').first()).toBeVisible();
    await shot(page, '02-主页-手机-流水线');
  });

  // 缺陷 D11（#902，#914 之后修）：手机宽度上三条泳道横排、要横拖、还和页面竖向滚动抢手势。
  // 现在窄屏改成三条泳道竖着叠：一路往下滑就能看全三段，不再横拖。
  test('手机宽度：三条泳道竖着叠、一样宽、都在屏幕里，图上不拦手势（touch-action 留给竖向滑动）', async ({
    page,
    shot,
  }) => {
    await page.setViewportSize({ width: 390, height: 844 });
    await page.goto('/');
    const board = page.locator('[data-flow-stacked]');
    await expect(board).toHaveAttribute('data-flow-stacked', 'true');
    await expect(page.locator('.react-flow__node-lane')).toHaveCount(3);
    const lanes = await page.evaluate(() =>
      [...document.querySelectorAll('.react-flow__node-lane')].map((n) => {
        const r = n.getBoundingClientRect();
        return { left: r.left, right: r.right, top: r.top + window.scrollY };
      }),
    );
    for (const l of lanes) {
      expect(l.left).toBeGreaterThanOrEqual(0);
      expect(l.right, '泳道不超出屏幕').toBeLessThanOrEqual(390);
    }
    expect(lanes[1]?.top).toBeGreaterThan(lanes[0]?.top ?? 0);
    expect(lanes[2]?.top).toBeGreaterThan(lanes[1]?.top ?? 0);
    expect(new Set(lanes.map((l) => Math.round(l.right - l.left))).size, '三条一样宽').toBe(1);
    // 不拦手势：d3-zoom 默认给图写 touch-action:none，这里要被盖回 pan-y；也没有缩放按钮
    const touch = await page.evaluate(
      () => getComputedStyle(document.querySelector('.react-flow__renderer') as Element).touchAction,
    );
    expect(touch).toBe('pan-y');
    await expect(page.getByRole('button', { name: '放大' })).toHaveCount(0);
    const overflow = await page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth);
    expect(overflow, '页面不该比屏幕宽').toBeLessThanOrEqual(1);
    await board.scrollIntoViewIfNeeded();
    await shot(page, '02-主页-手机-流水线-竖叠');
  });
});
