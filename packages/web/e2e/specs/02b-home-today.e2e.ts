// 主页三块（决定 0093）：要你拍的、在跑的、上线了的，从上到下；条数和后端对得上，都来自真库。
// 画布（/board，原来的主页）和账单已删（创始人拍，#3533）。
// 一屏减法（#3707 批次 3）：八块里三块常驻，其余四块默认收起、行尾一行摘要；开合记在 ?open=。
import { expect, test } from '../support/fixtures.ts';

type Notifications = {
  items: { id: string; level: string; title: string; dedupeKey?: string; answer?: unknown }[];
};
type Home = { running: { issueNumber: number; title: string }[] };

test.describe('主页三块', () => {
  test.beforeEach(async ({ login }) => login());

  test('三块从上到下；要你拍的只放人闸和看门狗的卡，在跑的条数和 /api/home 一致', async ({
    page,
    api,
    shot,
  }) => {
    const notes = (await api.get('/api/notifications?status=open&limit=200')) as Notifications;
    const home = (await api.get('/api/home')) as Home;
    const asks = notes.items.filter((n) => n.level === 'decision' && !n.answer);
    const alarms = notes.items.filter((n) => n.level === 'alert' && n.dedupeKey?.startsWith('watchdog:'));
    await page.goto('/');
    await expect(page.getByRole('heading', { level: 1, name: '工作台' })).toBeVisible();
    const blocks = page.locator('[data-home-block]');
    await expect(blocks).toHaveCount(4);
    // 左列要你拍的、在跑的任务，右列卡住报警、最近上线
    expect(await blocks.evaluateAll((els) => els.map((e) => e.getAttribute('data-home-block')))).toEqual([
      'ask',
      'run',
      'alarm',
      'shipped',
    ]);

    const ask = page.locator('[data-home-block="ask"]');
    if (asks.length === 0) await expect(ask).toContainText('没有要你拍的');
    else await expect(ask.locator('[data-ask-row]')).toHaveCount(asks.length);
    // 卡住报警默认收起（#3707 批次 3）：这一条要数行，先点开；收起时那行摘要另有用例量
    const alarm = page.locator('[data-home-block="alarm"]');
    await alarm.locator('[data-section-toggle]').click();
    await expect(alarm).toHaveAttribute('data-open', 'true');
    if (alarms.length === 0) await expect(alarm).toContainText('没有卡住报警');
    else await expect(alarm.locator('[data-ask-row]')).toHaveCount(alarms.length);
    // 别的卡住报警（不是看门狗报的）不进工作台
    for (const n of notes.items.filter((x) => x.level === 'alert' && !x.dedupeKey?.startsWith('watchdog:'))) {
      await expect(ask).not.toContainText(n.title);
      await expect(alarm).not.toContainText(n.title);
    }

    const run = page.locator('[data-home-block="run"]');
    await expect(run.locator('[data-run-row="engine"]')).toHaveCount(home.running.length);
    for (const r of home.running) await expect(run).toContainText(`#${r.issueNumber}`);

    // 上线了的：有记录就一行一版；读不到写没查成；没发过写还没有——三种都不留空白
    const shipped = page.locator('[data-home-block="shipped"]');
    await expect(shipped).toContainText(/上线记录没查成|还没有发布记录|·/);
    await shot(page, '02b-主页三块');
  });

  // 一屏减法（#3707 批次 3，决定 0121 第四条）：首页三块常驻，其余四块默认收起、行尾一行摘要。
  // 两种屏宽各量一次（1366 是 e2e 项目自己的宽，390 在用例里改视口），收起状态记在 ?open=、刷新不丢。
  test('首屏只露三块：要你拍的、在跑的任务、最近上线；其余四块收起、行尾有摘要', async ({ page, shot }) => {
    for (const width of [1366, 390]) {
      await page.setViewportSize({ width, height: width === 390 ? 844 : 768 });
      await page.goto('/');
      await expect(page.getByRole('heading', { level: 1, name: '工作台' })).toBeVisible();
      // 等主页那份聚合读成（收起的四块里有两块要它），不然数到的是骨架
      await expect(page.locator('[data-home-block="shipped"]')).toContainText(
        /上线记录没查成|还没有发布记录|·/,
      );
      await expect(page.locator('[data-fold-block="projects"]')).toBeVisible();

      const open = page.locator('[data-fold-block][data-open="true"]');
      const closed = page.locator('[data-fold-block][data-open="false"]');
      await expect(open).toHaveCount(3);
      expect(await open.evaluateAll((els) => els.map((e) => e.getAttribute('data-fold-block')))).toEqual([
        'ask',
        'run',
        'shipped',
      ]);
      expect(await closed.evaluateAll((els) => els.map((e) => e.getAttribute('data-fold-block')))).toEqual([
        'overview',
        'alarm',
        'system',
        'projects',
      ]);
      // 收起后不能什么都看不见：行尾（手机上在标题下面）写清几项、有没有异常。
      // 每个收起块两份摘要（宽屏行尾一份、窄屏标题下一份，各藏一份），当前屏宽下露着的那份必须看得见。
      const visible = closed.locator('[data-section-summary]:visible');
      await expect(visible).toHaveCount(4);
      for (const text of await visible.allTextContents()) expect(text.trim()).not.toBe('');
      await shot(page, `02b-一屏三块-${width}`);
    }
  });

  test('收起状态记在 ?open=：点开「项目」写进网址，刷新还是开着；再点收起回到常态网址', async ({ page }) => {
    await page.goto('/');
    const projects = page.locator('[data-fold-block="projects"]');
    await expect(projects).toHaveAttribute('data-open', 'false');
    await projects.getByRole('button', { name: /项目/ }).click();
    await expect(projects).toHaveAttribute('data-open', 'true');
    expect(new URL(page.url()).searchParams.get('open')).toContain('projects');
    await page.reload();
    await expect(page.locator('[data-fold-block="projects"]')).toHaveAttribute('data-open', 'true');
    await page.locator('[data-fold-block="projects"]').getByRole('button', { name: /项目/ }).click();
    await expect(page.locator('[data-fold-block="projects"]')).toHaveAttribute('data-open', 'false');
    expect(new URL(page.url()).searchParams.get('open')).toBeNull();
  });

  // 设置页（#3707 批次 3）：七节里三节常驻（仓库、运行设置、额度留量线），提醒/账密登录/关于收起。
  test('设置页首屏 ≤4 节：三节常驻，其余收起、行尾有摘要', async ({ page, shot }) => {
    for (const width of [1366, 390]) {
      await page.setViewportSize({ width, height: width === 390 ? 844 : 768 });
      await page.goto('/settings');
      await expect(page.getByRole('heading', { name: '运行设置' })).toBeVisible();
      const closed = page.locator('[data-fold-block][data-open="false"]');
      expect(await closed.evaluateAll((els) => els.map((e) => e.getAttribute('data-fold-block')))).toEqual([
        'notify',
        'account',
        'about',
      ]);
      // 首屏露着正文的区块 ≤4：三节常驻（仓库、运行设置、额度留量线）加三个只露标题的收起块
      const shown = page.locator('main section:not([data-open="false"])');
      expect(await shown.count()).toBeLessThanOrEqual(4);
      const visible = closed.locator('[data-section-summary]:visible');
      await expect(visible).toHaveCount(3);
      for (const text of await visible.allTextContents()) expect(text.trim()).not.toBe('');
      await shot(page, `02b-设置页收起-${width}`);
    }
  });

  test('左菜单：八项常驻（工作台、通知、任务、提需求、法国、路由、额度、设置），没有「更多」「画布」「账单」；零散页在法国名下', async ({
    page,
  }) => {
    test.skip((page.viewportSize()?.width ?? 1920) < 768, '手机走底部导航的「更多」菜单');
    await page.goto('/');
    const nav = page.getByRole('navigation', { name: '主导航' });
    for (const label of ['工作台', '通知', '任务', '提需求', '法国', '路由', '额度', '设置']) {
      await expect(nav.getByRole('link', { name: label })).toBeVisible();
    }
    await expect(nav.getByRole('link', { name: '工作台' })).toHaveAttribute('aria-current', 'page');
    await expect(nav.getByRole('link', { name: '画布' })).toHaveCount(0);
    await expect(nav.getByRole('link', { name: '账单' })).toHaveCount(0);
    await expect(nav.getByRole('button', { name: /更多/ })).toHaveCount(0);
    // 定时任务不进菜单：打开时菜单亮它挂靠的「法国」
    await page.goto('/schedules');
    await expect(nav.getByRole('link', { name: '法国' })).toHaveAttribute('aria-current', 'page');
  });
});
