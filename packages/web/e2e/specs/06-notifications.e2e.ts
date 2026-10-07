// 第六步：提醒页（通知中心）。要你拍的、卡住报警、日报；「处理了」要落库、进操作记录；没有追问入口（#939）。
import { expect, onlyDesktop, test } from '../support/fixtures.ts';

type Audit = { items: { action: string; target: string; after?: unknown }[] };
type NotificationsRes = { items: { id: string; title: string; resolvedAt?: string }[] };

test.describe('通知中心', () => {
  test.beforeEach(async ({ login }) => login());

  test('库里的提醒按级别分开数：要你拍 2、卡住报警 2、日报 1；未处理的在前', async ({ page, shot }) => {
    await page.goto('/notifications');
    await expect(page.getByRole('heading', { name: '通知中心' })).toBeVisible();
    await expect(page.getByRole('button', { name: /^全部 5$/ })).toBeVisible();
    await expect(page.getByRole('button', { name: /^要你拍 2$/ })).toBeVisible();
    await expect(page.getByRole('button', { name: /^卡住报警 2$/ })).toBeVisible();
    await expect(page.getByRole('button', { name: /^日报 1$/ })).toBeVisible();
    await expect(page.getByText('任务 12 卡住了')).toBeVisible();
    await expect(page.getByText('额度读数 35 分钟没更新')).toBeVisible();
    // 「谁在处理」：库里没有认领的，明说没人在修，不留空
    await expect(page.getByText('没人在修').first()).toBeVisible();
    await shot(page, '06-通知中心');
  });

  test('按级别筛选：点「卡住报警」只剩那两条', async ({ page }) => {
    await page.goto('/notifications');
    await page.getByRole('button', { name: /^卡住报警 2$/ }).click();
    await expect(page.getByText('任务 12 卡住了')).toBeVisible();
    await expect(page.getByText('等你回答：新模板的落款用谁的名字？')).toHaveCount(0);
  });

  test('整页没有追问入口：没有「回答」按钮、没有旧追问区块', async ({ page, shot }) => {
    await page.goto('/notifications');
    await expect(page.getByRole('heading', { name: '通知中心' })).toBeVisible();
    await expect(page.getByRole('button', { name: /^回答/ })).toHaveCount(0);
    await expect(page.locator('[data-legacy-asks]')).toHaveCount(0);
    await shot(page, '06-没有追问入口');
  });

  test('点「处理了」：这条从待处理里消失、「全部」里留着并写明谁处理的；落库、进操作记录', async ({
    page,
    api,
    stack,
  }, info) => {
    test.skip(!onlyDesktop(info), '改库的用例只在 1920 那一遍跑');
    await page.goto('/notifications');
    const item = page.getByRole('listitem').filter({ hasText: '额度读数 35 分钟没更新' });
    await item.getByRole('button', { name: '处理了' }).click();
    await expect(page.getByText('处理了', { exact: true }).first()).toBeVisible();
    await expect(page.getByText('额度读数 35 分钟没更新')).toHaveCount(0);

    const open = (await api.get('/api/notifications?status=open')) as NotificationsRes;
    expect(open.items.some((n) => n.title === '额度读数 35 分钟没更新')).toBe(false);
    const all = (await api.get('/api/notifications?status=all')) as NotificationsRes;
    expect(all.items.find((n) => n.title === '额度读数 35 分钟没更新')?.resolvedAt).toBeTruthy();
    const audit = (await api.get('/api/audit?limit=50')) as Audit;
    expect(audit.items.some((a) => a.action === 'notification.resolve')).toBe(true);

    await page.getByRole('tab', { name: '连已处理的一起看' }).click();
    await expect(page.getByText(/我处理于/)).toBeVisible();
    // 处理一个不存在的：后端回 404 明确的话
    const gone = await api.send(
      'POST',
      `/api/notifications/00000000-0000-4000-8000-00000000dead/resolve`,
      {},
    );
    expect(gone.status).toBe(404);
    void stack;
  });
});
