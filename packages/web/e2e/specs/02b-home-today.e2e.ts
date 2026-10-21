// 主页三块（决定 0093）：要你拍的、在跑的、上线了的，从上到下；条数和后端对得上，都来自真库。
// 画布（原来的主页）在 /board，见 02-home。
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
    const asks = notes.items.filter(
      (n) =>
        (n.level === 'decision' && !n.answer) ||
        (n.level === 'alert' && n.dedupeKey?.startsWith('watchdog:')),
    );
    await page.goto('/');
    await expect(page.getByRole('heading', { level: 1, name: '主页' })).toBeVisible();
    const blocks = page.locator('[data-home-block]');
    await expect(blocks).toHaveCount(3);
    expect(await blocks.evaluateAll((els) => els.map((e) => e.getAttribute('data-home-block')))).toEqual([
      'ask',
      'run',
      'shipped',
    ]);

    const ask = page.locator('[data-home-block="ask"]');
    if (asks.length === 0) await expect(ask).toContainText('没有要你拍的');
    else await expect(ask.locator('[data-ask-row]')).toHaveCount(asks.length);
    // 别的卡住报警（不是看门狗报的）不进主页
    for (const n of notes.items.filter((x) => x.level === 'alert' && !x.dedupeKey?.startsWith('watchdog:'))) {
      await expect(ask).not.toContainText(n.title);
    }

    const run = page.locator('[data-home-block="run"]');
    await expect(run.locator('[data-run-row="engine"]')).toHaveCount(home.running.length);
    for (const r of home.running) await expect(run).toContainText(`#${r.issueNumber}`);

    // 上线了的：有记录就一行一版；读不到写没查成；没发过写还没有——三种都不留空白
    const shipped = page.locator('[data-home-block="shipped"]');
    await expect(shipped).toContainText(/上线记录没查成|还没有发布记录|·/);
    await shot(page, '02b-主页三块');
  });

  test('左菜单：八项常驻（工作台、通知、任务、提需求、法国、路由、额度、设置），没有「更多」和「画布」；画布在法国名下', async ({
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
    await expect(nav.getByRole('button', { name: /更多/ })).toHaveCount(0);
    // 画布不进菜单，地址还在：打开时菜单亮它挂靠的「法国」
    await page.goto('/board');
    await expect(page).toHaveURL(/\/board$/);
    await expect(nav.getByRole('link', { name: '法国' })).toHaveAttribute('aria-current', 'page');
  });
});
