// 任务页 /next/work 的截图：`node e2e/shots-work.ts [标签]`，存到仓根 _tmp/shots/<标签>/（图不进代码分支，挂进 PR 的做法见 AGENTS.md）。
// 画面：批次图、点开详情、窄屏列表、窄屏图、空态；1440 和 390 各一份。
import { mkdirSync } from 'node:fs';
import { resolve } from 'node:path';
import { chromium, type Page } from '@playwright/test';
import { seed, seedWork, seedWorkBatch } from '../dev/seed.ts';
import { startStack } from '../dev/stack.ts';

const label = process.argv[2] ?? '3784';
const out = resolve(import.meta.dirname, '../../../_tmp/shots', label);
mkdirSync(out, { recursive: true });
const browser = await chromium.launch({ channel: process.env.E2E_BROWSER_CHANNEL?.trim() || 'chrome' });
const sizes = [
  { tag: '1440', width: 1440, height: 900, mobile: false },
  { tag: '390', width: 390, height: 844, mobile: true },
];

async function session(
  s: (typeof sizes)[number],
  setup: (stack: Awaited<ReturnType<typeof startStack>>) => Promise<void>,
  run: (page: Page) => Promise<void>,
) {
  const stack = await startStack({
    distDir: resolve(import.meta.dirname, '../dist'),
    pollMs: 100,
    heartbeatMs: 2000,
  });
  await setup(stack);
  const ctx = await browser.newContext({
    viewport: { width: s.width, height: s.height },
    deviceScaleFactor: s.mobile ? 2 : 1,
    isMobile: s.mobile,
    hasTouch: s.mobile,
    locale: 'zh-CN',
    timezoneId: 'Asia/Shanghai',
  });
  await ctx.addCookies([{ ...stack.cookie(), url: stack.url }]);
  const page = await ctx.newPage();
  await run(Object.assign(page, { base: stack.url }));
  await ctx.close();
  await stack.close();
}

for (const s of sizes) {
  const shot = (page: Page, name: string) => page.screenshot({ path: `${out}/${name}-${s.tag}.png` });
  const full = async (stack: Awaited<ReturnType<typeof startStack>>) => {
    await seed(stack);
    await seedWork(stack);
  };
  await session(s, full, async (page) => {
    const base = (page as unknown as { base: string }).base;
    await page.goto(`${base}/next/work`);
    if (s.mobile) {
      await page.getByTestId('work-list').waitFor();
      await page.waitForTimeout(600);
      await shot(page, 'list');
      await page.getByTestId('view-graph').click();
      await page.getByTestId('work-canvas').waitFor();
      await page.waitForTimeout(800);
      await shot(page, 'graph');
    } else {
      await page.getByTestId('view-graph').click();
      await page.waitForSelector('[data-testid="work-canvas"][data-ready="1"]');
      await page.waitForTimeout(800);
      await shot(page, 'graph');
      await page.locator('button[data-node-id="demo/web#3"]').click();
      await page.getByTestId('session-stream').waitFor();
      await page.waitForTimeout(1200);
      await shot(page, 'detail');
      await page.locator('button[data-node-id="demo/web#5"]').click();
      await page.waitForTimeout(800);
      await shot(page, 'detail-retry');
    }
  });
  // 一波很多：折叠 +N 更多
  await session(
    s,
    async (stack) => {
      await seed(stack);
      await seedWorkBatch(
        stack,
        'wide-batch',
        Array.from({ length: 18 }, (_, i) => ({
          issue: 400 + i,
          kind: (['running', 'done', 'pending', 'failed'] as const)[i % 4] as
            | 'running'
            | 'done'
            | 'pending'
            | 'failed',
        })),
        { repo: 'demo/wide', ageMin: 5 },
      );
    },
    async (page) => {
      const base = (page as unknown as { base: string }).base;
      await page.goto(`${base}/next/work`);
      await page.getByTestId('view-graph').click();
      await page.waitForSelector('[data-testid="work-canvas"][data-ready="1"]');
      await page.waitForTimeout(800);
      await shot(page, 'wide');
    },
  );
  // 多波依赖图：接口形状喂假数据（编排还没做，这是以后同一个形状的样子）；波 0–2 做完、波 3 在跑、之后排队
  await session(
    s,
    async () => undefined,
    async (page) => {
      const base = (page as unknown as { base: string }).base;
      const mk = (id: string, state: string, over: Record<string, unknown> = {}) => ({
        id,
        label: id,
        state,
        attempt: 1,
        startedAt: new Date(Date.now() - 240_000).toISOString(),
        completedAt: state === 'completed' ? new Date(Date.now() - 60_000).toISOString() : null,
        model: 'claude-sonnet-5-5',
        category: 'shadow',
        headline: state === 'running' ? '正在改接口层的分页' : '改动已提交，核验通过',
        runIds: ['d1-a1'],
        score: null,
        ...over,
      });
      const cols: [string, string][][] = [
        [['拆需求', 'completed']],
        [
          ['接口层', 'completed'],
          ['存储层', 'completed'],
          ['前端壳', 'completed'],
        ],
        [
          ['分页', 'running'],
          ['迁移', 'completed'],
          ['卡片', 'running'],
          ['画布', 'failed'],
        ],
        [
          ['联调', 'pending'],
          ['截图', 'pending'],
        ],
        [['验收', 'pending']],
      ];
      const nodes = cols
        .flat()
        .map(([id, st]) =>
          mk(
            id,
            st,
            id === '画布'
              ? { attempt: 2, runIds: ['d1-a1', 'd1-a2'], headline: '核验没过：窄屏横向溢出' }
              : {},
          ),
        );
      const waves = cols.map((c, i) => ({ index: i, nodeIds: c.map(([id]) => id) }));
      const edges = cols
        .slice(1)
        .flatMap((c, i) => c.flatMap(([to]) => (cols[i] ?? []).slice(0, 2).map(([from]) => ({ from, to }))));
      const graph = {
        batchId: '编排-示意',
        at: new Date().toISOString(),
        nodes,
        waves,
        edges,
        truncatedFrom: null,
      };
      await page.route('**/next/api/work/batches?*', (r) =>
        r.fulfill({
          json: {
            batches: [
              { batchId: '编排-示意', items: nodes.length, counts: { completed: 5 }, snapshotAt: graph.at },
            ],
            nextBefore: null,
          },
        }),
      );
      await page.route('**/next/api/work/batches/*', (r) => r.fulfill({ json: graph }));
      await page.goto(`${base}/next/work`);
      await page.getByTestId('view-graph').click();
      await page.waitForSelector('[data-testid="work-canvas"][data-ready="1"]');
      await page.waitForTimeout(800);
      await shot(page, 'multi');
      if (!s.mobile) {
        await page.locator('[data-node-id="分页"]').hover();
        await page.waitForTimeout(400);
        await shot(page, 'multi-hover');
        // 只截画布（和 OmO 首页的波次图并排对照用）
        await page.getByTestId('work-canvas').screenshot({ path: `${out}/multi-canvas-${s.tag}.png` });
      }
    },
  );
  // 空态
  await session(
    s,
    async () => undefined,
    async (page) => {
      const base = (page as unknown as { base: string }).base;
      await page.goto(`${base}/next/work`);
      await page.getByTestId('work-empty').waitFor();
      await shot(page, 'empty');
    },
  );
}
await browser.close();
console.log(`截图存到 ${out}`);
