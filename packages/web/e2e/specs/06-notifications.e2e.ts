// 第六步：提醒页（通知中心）。要你拍的、卡住报警、日报；「回答」追问、「处理了」都要落库、进操作记录。
import { expect, onlyDesktop, test } from '../support/fixtures.ts';

type Audit = { items: { action: string; target: string; after?: unknown }[] };
type NotificationsRes = { items: { id: string; title: string; resolvedAt?: string }[] };
type Home = { decisions: { kind: string; id: string; title: string }[] };

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

  test('回答追问（#17 等回答）：点「回答」选一个选项 → 落库、进操作记录、主页的追问少了一条；再答一次回 409', async ({
    page,
    api,
    stack,
    shot,
  }, info) => {
    test.skip(!onlyDesktop(info), '改库的用例只在 1920 那一遍跑');
    const before = (await api.get('/api/home')) as Home;
    expect(before.decisions.some((d) => d.id === stack.facts.askingAskId)).toBe(true);

    await page.goto('/notifications');
    const item = page.getByRole('listitem').filter({ hasText: '等你回答：新模板的落款用谁的名字？' });
    await item.getByRole('button', { name: '回答' }).click();
    const dialog = page.getByRole('dialog');
    await expect(dialog.getByText('新模板的落款用谁的名字？')).toBeVisible();
    await shot(page, '06-回答追问对话框');
    await dialog.getByRole('button', { name: '团队名' }).click();
    await expect(page.getByText(/回答了 .* 的追问/)).toBeVisible();

    // 落库：主页「要你拍的」里这条追问没了；操作记录里有 ask.answer，带着回答原文
    await expect
      .poll(async () =>
        ((await api.get('/api/home')) as Home).decisions.some((d) => d.id === stack.facts.askingAskId),
      )
      .toBe(false);
    const audit = (await api.get('/api/audit?limit=50')) as Audit;
    const entry = audit.items.find(
      (a) => a.action === 'ask.answer' && a.target === `task:${stack.facts.tasks.asking}`,
    );
    expect(entry, '操作记录里要有这次回答').toBeTruthy();
    expect(JSON.stringify(entry?.after)).toContain('团队名');

    const again = await api.send('POST', `/api/asks/${stack.facts.askingAskId}/answer`, {
      answer: '创始人署名',
    });
    expect(again.status).toBe(409);
    expect((again.json as { error: { code: string } }).error.code).toBe('already_answered');
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

    await page.getByRole('tab', { name: '全部（含已处理）' }).click();
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
