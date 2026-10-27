// 版面预算（#3708 批次 4，母单 #3697 第六节）：把 R18 的两个盲区做成机器兜底——跨文件容器嵌套层数、一屏区块数。
// 规范第五节自己写着「R18 看不到跨文件的嵌套」（`docs/design/驾驶舱界面.md`），lint 按设计抓不到，只能渲染出来量。
// 量法在 `e2e/support/layout-budget.ts`（哪些算容器、层数怎么数、一屏区块怎么数，都写在那里）。
// 两个方向都钉住：真页面在预算内（红了就是漂了），故意造的 3 层嵌套必须被判出来（量法失灵也会红）。
import { expect, test } from '../support/fixtures.ts';
import { type LayoutReading, MEASURE_LAYOUT } from '../support/layout-budget.ts';

/** 每页的预算：最深几层容器、首屏几块。 */
const BUDGET: Record<string, { depth: number; blocks: number }> = {
  // 首页三块常驻（决定 0121 第四条），别的都收起；层数照规范第五节的「最多两层」
  '/': { depth: 2, blocks: 3 },
  // 设置页七节收成三节常驻（#3707）
  '/settings': { depth: 2, blocks: 4 },
};

/** 量到的页不在 BUDGET 里时按这个判：层数照规范（最多两层），首屏块数按「一屏看三件事」（goals.md E 节）放宽到 6。 */
const DEFAULT_BUDGET = { depth: 2, blocks: 6 } as const;

const PAGES = [
  '/',
  '/tasks',
  '/france',
  '/resources',
  '/routing',
  '/routing/status',
  '/quota',
  '/intake',
  '/notifications',
  '/schedules',
  '/audit',
  '/settings',
  '/changelog',
] as const;

const measure = async (page: import('@playwright/test').Page): Promise<LayoutReading> =>
  (await page.evaluate(MEASURE_LAYOUT)) as LayoutReading;

test.describe('版面预算：容器嵌套层数、一屏区块数', () => {
  test.beforeEach(async ({ login }) => login());

  // 故意造出来的反例（#3708「怎么算做完」）：三层容器嵌套的页面必须被量成 3 层，且按规范判红。
  // 用 setContent 现搭一个，不往仓里加页面——真加一个页面反倒要维护，量法本身才是这里要钉的东西。
  test('反例：现搭一个 3 层嵌套的页面，量法必须数到 3 层、按规范判红', async ({ page }) => {
    await page.setViewportSize({ width: 1366, height: 768 });
    await page.setContent(`
      <main style="background:#f2f3f5;padding:20px">
        <section data-variant="card" style="background:#fff;padding:20px">
          <div style="background:#fff;padding:20px">
            <div style="background:#fff;padding:20px">最深那层</div>
          </div>
        </section>
      </main>
    `);
    const r = await measure(page);
    expect(r.maxDepth).toBe(3);
    expect(r.deep.length).toBeGreaterThan(0);
    expect(r.maxDepth).toBeGreaterThan(DEFAULT_BUDGET.depth);
  });

  test('反例：只有开关条、圆点这种小组件，不算容器', async ({ page }) => {
    await page.setViewportSize({ width: 1366, height: 768 });
    await page.setContent(`
      <main style="background:#f2f3f5">
        <section data-variant="card" style="background:#fff">
          <button type="button"><span style="display:inline-block;width:8px;height:8px;border-radius:9999px;background:#22c55e"></span>开</button>
          <span style="display:inline-block;background:#fff;border:1px solid #ddd">状态标签</span>
        </section>
      </main>
    `);
    const r = await measure(page);
    // Section 自己是第 1 层；开关、圆点、标签都没整块底色，不进层数
    expect(r.maxDepth).toBe(1);
    expect(r.deep).toEqual([]);
  });

  test('各页在预算内：容器最多两层、首屏摆的块不超过预算', async ({ page, shot }, info) => {
    // 两种屏宽各跑一次（1366 是 e2e 项目自己的宽，390 在用例里改视口）；两个项目都跑，结果不依赖项目宽度
    for (const width of [1366, 390]) {
      await page.setViewportSize({ width, height: width === 390 ? 844 : 768 });
      for (const path of PAGES) {
        await page.goto(path);
        await expect(page.locator('main')).toBeVisible();
        // 等这一页的数据读回来再量：还在画骨架时数进去的是占位块（首页读成前「在跑的任务」「系统状态」是普通 Section），
        // 量出来的块数和真摆的块数不是一回事。
        // 先等骨架行消失——networkidle 不够：首页每 30 秒轮询一次，请求之间的空档也能静下来，量到的是「在读」占位。
        await expect(page.locator('main [data-skeleton-row]')).toHaveCount(0);
        // 再等两帧排版落定（networkidle 在这儿永远等不到：轮询一直在发请求，把用例拖到超时）。
        await page.evaluate(
          () =>
            new Promise<void>((done) => {
              requestAnimationFrame(() => requestAnimationFrame(() => done()));
            }),
        );
        const r = await measure(page);
        const budget = BUDGET[path] ?? DEFAULT_BUDGET;
        const detail = r.containers
          .map((c) => `${c.where} 深${c.depth}${c.aboveFold ? ' 首屏' : ''}${c.block ? ' 算一块' : ''}`)
          .join('；');
        expect(r.maxDepth, `${path} @${width} 容器嵌套 ${r.maxDepth} 层：${detail}`).toBeLessThanOrEqual(
          budget.depth,
        );
        expect(
          r.firstScreenBlocks,
          `${path} @${width} 首屏摆了 ${r.firstScreenBlocks} 块：${detail}`,
        ).toBeLessThanOrEqual(budget.blocks);
      }
      // 只留首页那一张当证据（13 页 × 2 屏宽都贴太占地方）
      await page.goto('/');
      await expect(page.locator('main')).toBeVisible();
      await shot(page, `15-版面预算-首页-${width}-${info.project.name}`);
    }
  });
});
