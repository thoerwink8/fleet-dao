// 首页窄屏页头（#2969）：320 / 360 / 390 上流程开关、状态、刷新不重叠、不裁切、不横滚；宽屏仍和标题同一行。
// 组件测试没有版面，框在这里量。
import type { Page } from '@playwright/test';
import { expect, test } from '../support/fixtures.ts';

type Box = { left: number; right: number; top: number; bottom: number; width: number; height: number };

type HeaderLayout = {
  vw: number;
  overflowDoc: number;
  overflowMain: number;
  switchScroll: number;
  tabsScroll: number;
  sw: Box | null;
  health: Box | null;
  refresh: Box | null;
  title: Box | null;
  headline: Box | null;
  choices: { name: string; h: number; w: number; hit: boolean }[];
  hitHealth: boolean;
  hitRefresh: boolean;
  insideSwitch: boolean;
  insideHealth: boolean;
  insideRefresh: boolean;
  overlapsSwitchHealth: boolean;
  overlapsSwitchRefresh: boolean;
  overlapsHealthRefresh: boolean;
  switchBelowTitle: boolean;
  statusBelowSwitch: boolean;
  refreshBelowSwitch: boolean;
  headlineBelow: boolean;
  sameRow: boolean;
  healthH: number;
  refreshH: number;
};

// 字符串送进浏览器：写在函数里的类型注解会被原样带过去，浏览器解析不了。
const LAYOUT_JS = `(() => {
    const box = (el) => {
      if (!(el instanceof HTMLElement)) return null;
      const r = el.getBoundingClientRect();
      return { left: r.left, right: r.right, top: r.top, bottom: r.bottom, width: r.width, height: r.height };
    };
    const overlaps = (a, b) => {
      if (!a || !b) return false;
      return (
        Math.min(a.right, b.right) - Math.max(a.left, b.left) > 1 &&
        Math.min(a.bottom, b.bottom) - Math.max(a.top, b.top) > 1
      );
    };
    const hit = (el) => {
      if (!(el instanceof HTMLElement)) return false;
      const r = el.getBoundingClientRect();
      if (r.width < 1 || r.height < 1) return false;
      const top = document.elementFromPoint(r.left + r.width / 2, r.top + r.height / 2);
      return top !== null && (el === top || el.contains(top));
    };
    const main = document.querySelector('main');
    const mainBox = main?.getBoundingClientRect();
    const inside = (r) => {
      if (!r || !mainBox) return false;
      return (
        r.width > 0 &&
        r.height > 0 &&
        r.left >= mainBox.left - 1 &&
        r.right <= mainBox.right + 1 &&
        r.top >= -1
      );
    };
    const sw = document.querySelector('[data-flow-mode-switch]');
    const health = document.querySelector('[data-health-strip]');
    const refreshBtn = document.querySelector('[data-refresh-bar] button');
    const refresh = document.querySelector('[data-refresh-bar]');
    const title = document.querySelector('[data-page-titlebar]');
    const headline = document.querySelector('[data-home-headline]');
    const tabs = sw?.querySelector('[role="group"]');
    const choices = [...(sw?.querySelectorAll('button') ?? [])].map((el) => ({
      name: el.textContent ?? '',
      h: el.getBoundingClientRect().height,
      w: el.getBoundingClientRect().width,
      hit: hit(el),
    }));
    const swBox = box(sw);
    const healthBox = box(health);
    const refreshBox = box(refresh);
    const titleBox = box(title);
    const headlineBox = box(headline);
    return {
      vw: window.innerWidth,
      overflowDoc: document.documentElement.scrollWidth - window.innerWidth,
      overflowMain: main ? main.scrollWidth - main.clientWidth : -1,
      switchScroll: sw instanceof HTMLElement ? sw.scrollWidth - sw.clientWidth : -1,
      tabsScroll: tabs instanceof HTMLElement ? tabs.scrollWidth - tabs.clientWidth : -1,
      sw: swBox,
      health: healthBox,
      refresh: refreshBox,
      title: titleBox,
      headline: headlineBox,
      choices,
      hitHealth: hit(health),
      hitRefresh: hit(refreshBtn),
      insideSwitch: inside(swBox),
      insideHealth: inside(healthBox),
      insideRefresh: inside(refreshBox),
      overlapsSwitchHealth: overlaps(swBox, healthBox),
      overlapsSwitchRefresh: overlaps(swBox, refreshBox),
      overlapsHealthRefresh: overlaps(healthBox, refreshBox),
      switchBelowTitle: Boolean(swBox && titleBox && swBox.top >= titleBox.bottom - 1),
      statusBelowSwitch: Boolean(healthBox && swBox && healthBox.top >= swBox.bottom - 1),
      refreshBelowSwitch: Boolean(refreshBox && swBox && refreshBox.top >= swBox.bottom - 1),
      headlineBelow: Boolean(!headlineBox || (swBox && headlineBox.top >= swBox.bottom - 1)),
      sameRow: Boolean(
        swBox &&
          titleBox &&
          Math.abs(swBox.top + swBox.height / 2 - (titleBox.top + titleBox.height / 2)) < 24,
      ),
      healthH: health instanceof HTMLElement ? health.getBoundingClientRect().height : 0,
      refreshH: refreshBtn instanceof HTMLElement ? refreshBtn.getBoundingClientRect().height : 0,
    };
  })()`;

async function layout(page: Page): Promise<HeaderLayout> {
  return page.evaluate(LAYOUT_JS);
}

test.describe('首页页头窄屏', () => {
  test.beforeEach(async ({ login }) => login());

  test('320、360、390：开关、状态、刷新不重叠、不裁切、不横滚，都能点', async ({ page }) => {
    for (const width of [320, 360, 390]) {
      await page.setViewportSize({ width, height: 844 });
      await page.goto('/');
      await expect(page.getByRole('heading', { level: 1, name: '主页' })).toBeVisible();
      await expect(page.locator('[data-flow-mode-current]')).not.toHaveText('正在读流程模式');
      await expect(page.locator('[data-health-strip]')).toBeVisible();
      await expect(page.locator('[data-home-headline]')).toBeVisible();
      const m = await layout(page);
      expect(m.overflowDoc, `${width} 整页横滚`).toBeLessThanOrEqual(1);
      expect(m.overflowMain, `${width} 正文横滚`).toBeLessThanOrEqual(1);
      expect(m.switchScroll, `${width} 开关被裁`).toBeLessThanOrEqual(1);
      expect(m.tabsScroll, `${width} 选择条横滑`).toBeLessThanOrEqual(1);
      expect(m.insideSwitch, `${width} 开关在正文里`).toBe(true);
      expect(m.insideHealth, `${width} 状态在正文里`).toBe(true);
      expect(m.insideRefresh, `${width} 刷新在正文里`).toBe(true);
      expect(m.overlapsSwitchHealth, `${width} 开关和状态重叠`).toBe(false);
      expect(m.overlapsSwitchRefresh, `${width} 开关和刷新重叠`).toBe(false);
      expect(m.overlapsHealthRefresh, `${width} 状态和刷新重叠`).toBe(false);
      expect(m.switchBelowTitle, `${width} 开关应在标题下面`).toBe(true);
      expect(m.statusBelowSwitch, `${width} 状态应在开关下面`).toBe(true);
      expect(m.refreshBelowSwitch, `${width} 刷新应在开关下面`).toBe(true);
      expect(m.headlineBelow, `${width} 一句话应在开关下面`).toBe(true);
      expect(m.hitHealth, `${width} 状态被挡住`).toBe(true);
      expect(m.hitRefresh, `${width} 刷新被挡住`).toBe(true);
      expect(m.choices.length, `${width} 两个选择`).toBe(2);
      for (const c of m.choices) {
        expect(c.hit, `${width} ${c.name} 被挡住`).toBe(true);
        expect(c.h, `${width} ${c.name} 高`).toBeGreaterThanOrEqual(40);
        expect(c.w, `${width} ${c.name} 宽`).toBeGreaterThanOrEqual(40);
      }
      expect(m.healthH, `${width} 状态高`).toBeGreaterThanOrEqual(40);
      expect(m.refreshH, `${width} 刷新高`).toBeGreaterThanOrEqual(40);
    }
  });

  test('宽屏：开关和标题同一行，也不和状态、刷新重叠', async ({ page }) => {
    await page.goto('/');
    await expect(page.locator('[data-flow-mode-current]')).not.toHaveText('正在读流程模式');
    await expect(page.locator('[data-health-strip]')).toBeVisible();
    const m = await layout(page);
    expect(m.overflowMain, '正文横滚').toBeLessThanOrEqual(1);
    expect(m.sameRow, '开关应和标题同一行').toBe(true);
    expect(m.switchBelowTitle, '宽屏不应把开关整块挤到标题下面').toBe(false);
    expect(m.overlapsSwitchHealth, '开关和状态重叠').toBe(false);
    expect(m.overlapsSwitchRefresh, '开关和刷新重叠').toBe(false);
    expect(m.overlapsHealthRefresh, '状态和刷新重叠').toBe(false);
    expect(m.hitHealth).toBe(true);
    expect(m.hitRefresh).toBe(true);
  });
});
