// 左菜单宽固定 220（驾驶舱改版验收）：正文再宽、根字号再小，菜单都不许被挤窄。
// 组件测试（happy-dom）没有版面，量不出宽度；这里用真浏览器量。
import { expect, test } from '../support/fixtures.ts';

const MENU_WIDTH = 220;
// 内容最宽、最容易把菜单挤窄的几页
const WIDE_ROUTES = ['/', '/audit', '/notifications', '/resources', '/tasks', '/routing/status', '/france'];

test.describe('左菜单宽度', () => {
  // 1366 和 1920 两遍都量（都 ≥1280，菜单默认展开；只读，不改库）
  test.beforeEach(async ({ login }) => login());

  for (const path of WIDE_ROUTES) {
    test(`${path}：菜单等于 220`, async ({ page }) => {
      await page.goto(path);
      const menu = page.locator('aside[data-menu="open"]');
      await expect(menu).toBeVisible();
      // 过渡（200ms）走完再量
      await page.waitForTimeout(400);
      const width = await menu.evaluate((el) => el.getBoundingClientRect().width);
      expect(width).toBe(MENU_WIDTH);
    });
  }

  test('根字号被改小（浏览器默认 12px）菜单也还是 220', async ({ page }) => {
    await page.goto('/audit');
    await page.addStyleTag({ content: 'html{font-size:12px}' });
    const menu = page.locator('aside[data-menu="open"]');
    await expect(menu).toBeVisible();
    await page.waitForTimeout(400);
    const width = await menu.evaluate((el) => el.getBoundingClientRect().width);
    expect(width).toBe(MENU_WIDTH);
  });
});
