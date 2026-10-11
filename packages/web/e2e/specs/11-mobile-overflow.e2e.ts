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

  test('路由：用途标题块三行各不折行，结论和状态标签在同一行（320、390，每个用途）', async ({ page }) => {
    // 创始人 2026-10-11 看 390 宽「变成 2 行了」（#1914 第 5 轮）：结论句折两行、状态标签掉到第三行
    for (const width of [320, 390]) {
      await page.setViewportSize({ width, height: PHONE.height });
      await page.goto('/routing');
      const nav = page.getByRole('navigation', { name: '用途' });
      await expect(nav).toBeVisible();
      const tabs = await nav.getByRole('button').all();
      expect(tabs.length).toBeGreaterThan(0);
      for (const tab of tabs) {
        await tab.click();
        const hero = page.locator('[data-purpose-hero]');
        await expect(hero).toBeVisible();
        const lines = await hero.evaluate((el) => {
          const oneLine = (node: Element | null) => {
            if (!(node instanceof HTMLElement)) return true;
            const lh = Number.parseFloat(getComputedStyle(node).lineHeight);
            // 带标签的那行比字高一点，不到两行高就算一行
            return node.getBoundingClientRect().height < lh * 1.9;
          };
          const line = el.querySelector('[data-hero-line]');
          const text = line?.querySelector('[data-hero-text]')?.getBoundingClientRect();
          const badge = line?.querySelector('[data-variant]')?.getBoundingClientRect();
          const sameRow =
            !text || !badge
              ? true
              : Math.abs(text.top + text.height / 2 - (badge.top + badge.height / 2)) < 4;
          return {
            title: oneLine(el.querySelector('h2')),
            line: oneLine(line),
            notes: oneLine(el.querySelector('[data-hero-notes]')),
            sameRow,
          };
        });
        expect(lines, `${width} 宽，用途「${await tab.textContent()}」`).toEqual({
          title: true,
          line: true,
          notes: true,
          sameRow: true,
        });
      }
    }
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
