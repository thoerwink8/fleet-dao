// 手机宽度（390）：路由、渠道状态、操作记录三页主区不横向溢出，渠道状态点一行开详情抽屉（#1806）。
// 组件测试（happy-dom）没有版面，量不出 scrollWidth；这里用真浏览器量。
import type { Page } from '@playwright/test';
import { expect, test } from '../support/fixtures.ts';

const PHONE = { width: 390, height: 844 } as const;

test.describe('手机宽度：三页不横滚', () => {
  test.beforeEach(async ({ login, page }) => {
    await login();
    await page.setViewportSize(PHONE);
  });

  const noOverflow = async (page: Page) => {
    const [scroll, client] = await page.locator('main').evaluate((el) => [el.scrollWidth, el.clientWidth]);
    expect(scroll).toBeLessThanOrEqual(client ?? 0);
  };

  test('路由：用途条在页内横滑，页头状态胶囊换行，主区不比屏幕宽', async ({ page }) => {
    await page.goto('/routing');
    await expect(page.getByRole('navigation', { name: '用途' })).toBeVisible();
    await expect(page.getByText(/个派得出去/).first()).toBeVisible();
    await noOverflow(page);
  });

  test('路由：每行的操作收进「⋯」菜单，菜单项不低于 40px', async ({ page }) => {
    await page.goto('/routing?purpose=execute');
    const more = page.getByRole('button', { name: /^更多操作：/ }).first();
    await expect(more).toBeVisible();
    await more.click();
    const items = page.getByRole('menuitem');
    await expect(items.first()).toBeVisible();
    for (const item of await items.all()) {
      // 菜单打开有 zoom-in-95 动画，boundingBox 量的是缩放中的框（CI 量到 39.15）；offsetHeight 不受 transform 影响
      const height = await item.evaluate((el) => (el as HTMLElement).offsetHeight);
      expect(height).toBeGreaterThanOrEqual(40);
    }
  });

  test('渠道状态：只画列表，点一行从底部开详情抽屉，不横滚', async ({ page }) => {
    await page.goto('/routing/status');
    const list = page.getByRole('list', { name: '渠道状态' });
    await expect(list).toBeVisible();
    await expect(page.getByRole('dialog')).toHaveCount(0);
    await noOverflow(page);
    await list.locator('[data-channel] button').first().click();
    const drawer = page.getByRole('dialog');
    await expect(drawer).toBeVisible();
    await expect(drawer.getByRole('button', { name: '探这个渠道' })).toBeVisible();
    await page.keyboard.press('Escape');
    await expect(page.getByRole('dialog')).toHaveCount(0);
  });

  test('操作记录：主区不比屏幕宽', async ({ page }) => {
    await page.goto('/audit');
    await expect(page.getByRole('heading', { level: 1, name: '操作记录' })).toBeVisible();
    await noOverflow(page);
  });
});
