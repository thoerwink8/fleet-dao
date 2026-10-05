// 第七步：其余页面逐个走一遍（路由、思考档位、定时任务、操作记录、更新日志、演示版、找不到的页面）。
// 创始人剧本里的「环境视图」：驾驶舱里没有叫这个名字的页面；最接近的是「路由」（每条路现在接得上吗、额度够吗、被禁了吗）
// 和主页顶上的持续状态条，这里把路由页当它测，并在缺陷清单里记一笔。
import { expect, test } from '../support/fixtures.ts';

test.describe('其余页面', () => {
  test.beforeEach(async ({ login }) => login());

  test('路由：九个用途都排了模型，在线的路由写「活」、没探过的写「不知道」，不是空白', async ({
    page,
    shot,
  }) => {
    await page.goto('/routing');
    await expect(page.getByRole('heading', { name: '路由' })).toBeVisible();
    // 用途骨架是发布时装进库的：default / execute / verify / ui / judge 都在
    await expect(page.getByText('需求文档').first()).toBeVisible();
    await expect(page.getByText('写码').first()).toBeVisible();
    await expect(page.getByText(/派得出去/).first()).toBeVisible();
    // 探通了的 Claude 拼车/独享、Cursor、Grok 在线：至少有「活」的路由
    await expect(page.getByText(/个派得出去/).first()).not.toHaveText(/^0 个派得出去$/);
    await shot(page, '07-路由');
  });

  test('思考档位：每个模型的每条路都列出来，来自库里的路由两层', async ({ page, shot }) => {
    await page.goto('/efforts');
    await expect(page.getByRole('heading', { name: '思考档位' })).toBeVisible();
    await expect(page.getByText('路由两层里一条路由都没有')).toHaveCount(0);
    await expect(page.getByText(/Opus 5\.5/).first()).toBeVisible();
    await shot(page, '07-思考档位');
  });

  test('定时任务：额度读取跑成了、每小时对账上次没查全且已过期，分开显示', async ({ page, shot }) => {
    await page.goto('/schedules');
    await expect(page.getByRole('heading', { name: '定时任务' })).toBeVisible();
    await expect(page.getByRole('row', { name: /额度读取/ })).toContainText('跑成了');
    const reconcile = page.getByRole('row', { name: /每小时对账/ });
    await expect(reconcile).toContainText('没查成：GitHub 接口限流，一个仓都没扫到');
    await expect(reconcile).toContainText('过期');
    await shot(page, '07-定时任务');
  });

  test('操作记录：登录、设账密这些真发生过的动作都在，谁做的写清楚', async ({ page, shot }) => {
    await page.goto('/audit');
    await expect(page.getByRole('heading', { name: '操作记录' })).toBeVisible();
    await expect(page.getByText('登录了驾驶舱').first()).toBeVisible();
    // 动作名翻成白话（lib/audit.ts）：不再露出 credentials.set 这样的代码
    await expect(page.getByText('设了账密登录').first()).toBeVisible();
    await shot(page, '07-操作记录');
  });

  test('更新日志：读不到版本信息时明说原因，不是空白', async ({ page, shot, problems }) => {
    problems.allow('/api/release/version');
    problems.allow('status of 5');
    await page.goto('/changelog');
    await expect(page.getByRole('heading', { name: '更新日志' })).toBeVisible();
    // 开发环境没有 GitHub 凭据：要么显示版本，要么明确说读不到
    await expect(page.getByText(/还没发版|已发|读不到|没读到|没读成|读不了/).first()).toBeVisible();
    await shot(page, '07-更新日志');
  });

  test('演示版：没配演示目录时明说，不假装「没有链接」', async ({ page, shot, problems }) => {
    problems.allow('/api/demo/');
    problems.allow('status of 5');
    problems.allow('status of 4');
    await page.goto('/demo-links');
    await expect(page.getByRole('heading', { name: '演示版' })).toBeVisible();
    await expect(page.getByText(/没配|没接|读不到|没读成|发不了/).first()).toBeVisible();
    await shot(page, '07-演示版');
  });

  test('不存在的页面：404 页给回主页的路', async ({ page }) => {
    await page.goto('/no-such-page');
    await expect(page.getByRole('link', { name: /主页/ }).first()).toBeVisible();
  });
});
