// 第三步：单子详情和每段耗时（对题 → 动手 → 验收，每段每个模型花了多久、多少 token 和钱）。数都要能和库里的流水对上。
import { expect, test } from '../support/fixtures.ts';

test.describe('单子详情', () => {
  test.beforeEach(async ({ login }) => login());

  test('做完的单 #13：总耗时、干活合计、每段耗时、每一笔都对得上库里的流水', async ({
    page,
    stack,
    shot,
  }) => {
    await page.goto(`/tasks/${stack.facts.tasks.done}`);
    await expect(page.getByRole('heading', { name: /#13 README 加一行当前时间/ })).toBeVisible();
    await expect(page.getByText('已完成').first()).toBeVisible();

    // 顶上四个数：流水是 7+30+25+8 = 70 分钟，开单到最后一段收场 86 分钟
    await expect(page.getByText('1 小时 26 分').first()).toBeVisible();
    await expect(page.getByText('1 小时 10 分').first()).toBeVisible();
    await expect(page.getByText('折合 $2.28').first()).toBeVisible();

    // 三段表：每段耗时
    const table = page.locator('main');
    await expect(table).toContainText('对题');
    await expect(table).toContainText('7 分钟');
    await expect(table).toContainText('动手');
    await expect(table).toContainText('55 分钟');
    await expect(table).toContainText('验收');
    await expect(table).toContainText('8 分钟');
    // 超时那一笔：写明原因，没记到的 token 写「没读到」、不是 0
    await expect(page.getByText('为什么没成：30 分钟没交活，按超时收了')).toBeVisible();
    await expect(page.getByText('没读到').first()).toBeVisible();
    // 验收那一笔是按单号兜底对上的，页面标明
    await expect(page.locator('span[title*="按单号对上"]')).toBeVisible();
    await shot(page, '03-单子详情-做完的');
  });

  test('在跑的单 #12：会话时间线和用量也来自库', async ({ page, stack, api, shot }) => {
    const detail = (await api.get(`/api/tasks/${stack.facts.tasks.running}`)) as { runs: unknown[] };
    expect(detail.runs.length).toBeGreaterThan(0);
    await page.goto(`/tasks/${stack.facts.tasks.running}`);
    await expect(page.getByRole('heading', { name: /#12 登录页加验证码/ })).toBeVisible();
    // #12 既有三段流水（对题收了、动手在跑），又有老流程的会话：两块都要在
    await expect(page.getByText('老流程的会话')).toBeVisible();
    await expect(page.getByText('动手').first()).toBeVisible();
    await shot(page, '03-单子详情-在跑的');
  });

  test('从没跑过的单 #16：明说「还没跑过」，不是空白', async ({ page, stack }) => {
    await page.goto(`/tasks/${stack.facts.tasks.failed}`);
    await expect(page.getByRole('heading', { name: /#16 升级依赖到最新/ })).toBeVisible();
    await expect(page.getByText('这张单还没跑过')).toBeVisible();
  });

  test('不存在的单：明确写「没有这个任务」，给回主页的路', async ({ page, problems }) => {
    problems.allow('HTTP 404');
    problems.allow('status of 404');
    await page.goto('/tasks/00000000-0000-4000-8000-00000000dead');
    await expect(page.getByText(/没有这个任务|读不到|没读到/).first()).toBeVisible();
    await expect(page.getByRole('link', { name: '回主页' })).toBeVisible();
  });
});
