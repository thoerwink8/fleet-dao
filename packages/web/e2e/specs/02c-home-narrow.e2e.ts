// 工作台页头窄屏（#2969，#3509 改版后）：320 / 360 / 390 上流程开关和刷新不重叠、不裁切、不横滚，手机上在标题下面；宽屏仍和标题同一行。
// 健康条不再挤在页头：额度在「数据概览」，流水线、中转、引擎进程在「系统状态」；手机上「要你拍的」「在跑的任务」行尾不被截断。
// 组件测试没有版面，框在这里量。
import type { Page } from '@playwright/test';
import { expect, test } from '../support/fixtures.ts';

type Box = { left: number; right: number; top: number; bottom: number; width: number; height: number };

type HeaderLayout = {
  vw: number;
  overflowDoc: number;
  overflowMain: number;
  switchScroll: number;
  sw: Box | null;
  refresh: Box | null;
  title: Box | null;
  choices: { name: string; h: number; w: number; hit: boolean }[];
  hitRefresh: boolean;
  insideSwitch: boolean;
  insideRefresh: boolean;
  overlapsSwitchRefresh: boolean;
  switchBelowTitle: boolean;
  sameRow: boolean;
  refreshH: number;
  /** 超出屏幕的行尾元素（状态、按钮、链接）。 */
  clippedTrailing: string[];
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
    const refreshBtn = document.querySelector('[data-refresh-bar] button');
    const refresh = document.querySelector('[data-refresh-bar]');
    const title = document.querySelector('[data-page-titlebar]');
    const tabs = sw?.querySelector('[role="group"]');
    const choices = [...(sw?.querySelectorAll('button') ?? [])].map((el) => ({
      name: el.textContent ?? '',
      h: el.getBoundingClientRect().height,
      w: el.getBoundingClientRect().width,
      hit: hit(el),
    }));
    const swBox = box(sw);
    const refreshBox = box(refresh);
    const titleBox = box(title);
    // 行尾的状态、按钮、时间：整个落在屏幕里、没被省略号截断
    const clipped = [...document.querySelectorAll('[data-home] [data-status], [data-home] [data-home-block] a, [data-home] [data-home-block] button')]
      .filter((el) => {
        const r = el.getBoundingClientRect();
        return r.width > 0 && (r.right > window.innerWidth + 1 || r.left < -1);
      })
      .map((el) => (el.textContent ?? '').slice(0, 30));
    return {
      vw: window.innerWidth,
      overflowDoc: document.documentElement.scrollWidth - window.innerWidth,
      overflowMain: main ? main.scrollWidth - main.clientWidth : -1,
      switchScroll: tabs instanceof HTMLElement ? tabs.scrollWidth - tabs.clientWidth : -1,
      sw: swBox,
      refresh: refreshBox,
      title: titleBox,
      choices,
      hitRefresh: hit(refreshBtn),
      insideSwitch: inside(swBox),
      insideRefresh: inside(refreshBox),
      overlapsSwitchRefresh: overlaps(swBox, refreshBox),
      switchBelowTitle: Boolean(swBox && titleBox && swBox.top >= titleBox.bottom - 1),
      sameRow: Boolean(
        swBox &&
          titleBox &&
          Math.abs(swBox.top + swBox.height / 2 - (titleBox.top + titleBox.height / 2)) < 24,
      ),
      refreshH: refreshBtn instanceof HTMLElement ? refreshBtn.getBoundingClientRect().height : 0,
      clippedTrailing: clipped,
    };
  })()`;

/** 稳定性只看整像素。亚像素在进场尾巴上会抖，不拿来判断版面还在变；断言仍用没取整的量。 */
function settledKey(raw: string): string {
  const m = JSON.parse(raw) as HeaderLayout;
  const r = (n: number) => Math.round(n);
  const b = (box: Box | null) =>
    box
      ? {
          left: r(box.left),
          right: r(box.right),
          top: r(box.top),
          bottom: r(box.bottom),
          width: r(box.width),
          height: r(box.height),
        }
      : null;
  return JSON.stringify({
    ...m,
    sw: b(m.sw),
    refresh: b(m.refresh),
    title: b(m.title),
    choices: m.choices.map((c) => ({ ...c, h: r(c.h), w: r(c.w) })),
    refreshH: r(m.refreshH),
  });
}

/**
 * 等版面落定再量（#3433）。字体晚到会改字宽；页头进场 fd-rise 只有 0.28s。
 * 在跑的状态点是无限循环，等「所有动画停」会一直等到超时。
 * 这里只等字体、fd-rise，再等页头盒子连续三次（间隔 100ms）不变。断言没放宽。
 */
async function layout(page: Page): Promise<HeaderLayout> {
  await page.evaluate(() => document.fonts.ready.then(() => undefined));
  await expect
    .poll(
      () =>
        page.evaluate(
          () =>
            document.getAnimations().filter((animation) => {
              const effect = animation.effect;
              const target = effect && 'target' in effect ? effect.target : null;
              return (
                animation.playState === 'running' &&
                target instanceof Element &&
                target.classList.contains('fd-rise')
              );
            }).length,
        ),
      { message: '页头进场动画没跑完' },
    )
    .toBe(0);
  let lastRaw = '';
  let lastKey = '';
  let stable = 0;
  await expect
    .poll(
      async () => {
        lastRaw = JSON.stringify(await page.evaluate(LAYOUT_JS));
        const key = settledKey(lastRaw);
        stable = key === lastKey ? stable + 1 : 0;
        lastKey = key;
        return stable;
      },
      { message: '页头版面一直在变', intervals: [100] },
    )
    .toBeGreaterThanOrEqual(3);
  return JSON.parse(lastRaw) as HeaderLayout;
}

test.describe('工作台页头窄屏', () => {
  test.beforeEach(async ({ login }) => login());

  test('320、360、390：开关和刷新不重叠、不裁切、不横滚，都能点；开关在标题下面', async ({ page }) => {
    for (const width of [320, 360, 390]) {
      await page.setViewportSize({ width, height: 844 });
      await page.goto('/');
      await expect(page.getByRole('heading', { level: 1, name: '工作台' })).toBeVisible();
      await expect(page.locator('[data-flow-mode-current]')).not.toHaveText('正在读流程模式');
      await expect(page.locator('[data-spend-line]')).toBeVisible();
      const m = await layout(page);
      expect(m.overflowDoc, `${width} 整页横滚`).toBeLessThanOrEqual(1);
      expect(m.overflowMain, `${width} 正文横滚`).toBeLessThanOrEqual(1);
      expect(m.switchScroll, `${width} 开关被裁`).toBeLessThanOrEqual(1);
      expect(m.insideSwitch, `${width} 开关在正文里`).toBe(true);
      expect(m.insideRefresh, `${width} 刷新在正文里`).toBe(true);
      expect(m.overlapsSwitchRefresh, `${width} 开关和刷新重叠`).toBe(false);
      expect(m.switchBelowTitle, `${width} 开关应在标题下面`).toBe(true);
      expect(m.hitRefresh, `${width} 刷新被挡住`).toBe(true);
      expect(m.choices.length, `${width} 两个选择`).toBe(2);
      for (const c of m.choices) {
        expect(c.hit, `${width} ${c.name} 被挡住`).toBe(true);
        expect(c.h, `${width} ${c.name} 高`).toBeGreaterThanOrEqual(40);
        expect(c.w, `${width} ${c.name} 宽`).toBeGreaterThanOrEqual(40);
      }
      expect(m.refreshH, `${width} 刷新高`).toBeGreaterThanOrEqual(40);
      // 手机上列表行尾（状态、按钮）整个落在屏幕里，不被挤出去、不被截断
      expect(m.clippedTrailing, `${width} 行尾超出屏幕`).toEqual([]);
    }
  });

  test('宽屏：开关和标题同一行，也不和刷新重叠', async ({ page }) => {
    await page.goto('/');
    await expect(page.locator('[data-flow-mode-current]')).not.toHaveText('正在读流程模式');
    await expect(page.locator('[data-spend-line]')).toBeVisible();
    const m = await layout(page);
    expect(m.overflowMain, '正文横滚').toBeLessThanOrEqual(1);
    expect(m.sameRow, '开关应和标题同一行').toBe(true);
    expect(m.switchBelowTitle, '宽屏不应把开关整块挤到标题下面').toBe(false);
    expect(m.overlapsSwitchRefresh, '开关和刷新重叠').toBe(false);
    expect(m.hitRefresh).toBe(true);
  });
});
