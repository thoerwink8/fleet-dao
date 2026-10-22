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
        // 换用途时标题块整块换掉：等这一项选中、新标题块画好再量（量到正被换下的旧节点，什么都量不出）
        await expect(tab).toHaveAttribute('aria-pressed', 'true');
        const hero = page.locator('[data-purpose-hero]');
        await expect(hero).toBeVisible();
        const lines = await hero.evaluate((el) => {
          // 一行＝里面每段看得见的字都落在同一条基线附近：按字量（Range 的每个行盒），不按行高猜
          const oneLine = (node: Element | null) => {
            if (!(node instanceof HTMLElement)) return true;
            if (!node.isConnected) return false;
            const mids: number[] = [];
            const walker = document.createTreeWalker(node, NodeFilter.SHOW_TEXT);
            for (let t = walker.nextNode(); t; t = walker.nextNode()) {
              if (!t.textContent?.trim() || t.parentElement?.closest('.sr-only')) continue;
              const range = document.createRange();
              range.selectNodeContents(t);
              for (const r of range.getClientRects()) if (r.width > 0) mids.push(r.top + r.height / 2);
            }
            // 一段字都量不到（没画出来）也不算过
            return mids.length > 0 && Math.max(...mids) - Math.min(...mids) < 8;
          };
          const line = el.querySelector('[data-hero-line]');
          const text = line?.querySelector('[data-hero-text]')?.getBoundingClientRect();
          const badge = line?.querySelector('[data-status]')?.getBoundingClientRect();
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

  test('路由：模型目录、渠道、思考档位三个页签每行名字一行、小字一行，主区不横滚（320、390，#1916）', async ({
    page,
  }) => {
    // 创始人 2026-10-11：手机上模型目录行的小字折到第二行。按样板每行＝名字一行（带状态）＋小字一行，放不下截断
    const tabs = [
      { tab: 'models', lines: ['[data-row-name-line]', '[data-row-meta]'] },
      { tab: 'channels', lines: ['[data-row-name-line]', '[data-row-meta]'] },
      { tab: 'efforts', lines: ['[data-route-where]'] },
    ] as const;
    for (const width of [320, 390]) {
      await page.setViewportSize({ width, height: PHONE.height });
      for (const { tab, lines } of tabs) {
        await page.goto(`/routing?tab=${tab}`);
        await expect(page.locator(lines[0]).first()).toBeVisible();
        await noOverflow(page);
        const bad = await page.locator('main').evaluate(
          (main, sels) => {
            const oneLine = (node: Element) => {
              const mids: number[] = [];
              const walker = document.createTreeWalker(node, NodeFilter.SHOW_TEXT);
              for (let t = walker.nextNode(); t; t = walker.nextNode()) {
                if (!t.textContent?.trim() || t.parentElement?.closest('.sr-only')) continue;
                const range = document.createRange();
                range.selectNodeContents(t);
                for (const r of range.getClientRects()) if (r.width > 0) mids.push(r.top + r.height / 2);
              }
              return mids.length > 0 && Math.max(...mids) - Math.min(...mids) < 8;
            };
            const out: string[] = [];
            let seen = 0;
            for (const sel of sels) {
              for (const el of main.querySelectorAll(sel)) {
                if (!(el as HTMLElement).offsetParent) continue;
                seen += 1;
                if (!oneLine(el)) out.push(`${sel}：${el.textContent}`);
              }
            }
            return { seen, out };
          },
          lines as unknown as string[],
        );
        expect(bad.seen, `${width} 宽 ${tab} 一行都没量到`).toBeGreaterThan(0);
        expect(bad.out, `${width} 宽 ${tab}`).toEqual([]);
      }
    }
  });

  test('路由：用途下路由行的「顺位第一条活的」标签在小字行开头，不被截掉（390）', async ({ page }) => {
    await page.goto('/routing?purpose=execute');
    await expect(page.locator('[data-route-meta]').first()).toBeVisible();
    const clipped = await page.locator('main').evaluate((main) => {
      const out: string[] = [];
      for (const meta of main.querySelectorAll('[data-route-meta]')) {
        const tag = [...meta.children].find((c) => c.textContent === '顺位第一条活的');
        if (!tag) continue;
        if (meta.firstElementChild !== tag) out.push('不在开头');
        if (tag.getBoundingClientRect().right > meta.getBoundingClientRect().right + 0.5) out.push('被截掉');
      }
      return out;
    });
    expect(clipped).toEqual([]);
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
