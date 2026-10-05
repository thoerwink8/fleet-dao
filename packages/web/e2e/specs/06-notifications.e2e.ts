// 第六步：提醒页（通知中心）。要你拍的、卡住报警、日报；旧追问只读展示、「关闭」、「处理了」都要落库、进操作记录；追问不再能回答（#928）。
import { expect, onlyDesktop, test } from '../support/fixtures.ts';

type Audit = { items: { action: string; target: string; after?: unknown }[] };
type NotificationsRes = { items: { id: string; title: string; resolvedAt?: string }[] };
type Legacy = { items: { id: string; taskId: string; question: string }[] };

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

  test('旧会话留下的提问（#928）：只读列出、写明没人收回答，只有「关闭」、整页没有「回答」', async ({
    page,
    shot,
  }) => {
    await page.goto('/notifications');
    const section = page.locator('[data-legacy-asks]');
    await expect(section).toBeVisible();
    await expect(section).toContainText('旧会话留下的提问');
    await expect(section).toContainText('不会有人收到你的回答');
    await expect(section.getByText('验证码短信走哪家通道？')).toBeVisible();
    await expect(section.getByText('新模板的落款用谁的名字？')).toBeVisible();
    await expect(section.getByRole('button', { name: '关闭' })).toHaveCount(2);
    await expect(page.getByRole('button', { name: /^回答/ })).toHaveCount(0);
    await shot(page, '06-旧追问');
  });

  test('回答追问的接口一律 409 asks_not_received：不落库、不进操作记录，界面不会以为答了有用', async ({
    api,
    stack,
  }) => {
    const res = await api.send('POST', `/api/asks/${stack.facts.askingAskId}/answer`, { answer: '团队名' });
    expect(res.status).toBe(409);
    expect((res.json as { error: { code: string } }).error.code).toBe('asks_not_received');
    const legacy = (await api.get('/api/asks/legacy')) as Legacy;
    expect(legacy.items.some((a) => a.id === stack.facts.askingAskId)).toBe(true);
    const audit = (await api.get('/api/audit?limit=50')) as Audit;
    expect(audit.items.some((a) => a.action === 'ask.answer')).toBe(false);
  });

  test('点「关闭」（#17 那条旧追问）：落库、进操作记录 ask.close、列表里没了；再关回 409，不存在的回 404', async ({
    page,
    api,
    stack,
  }, info) => {
    test.skip(!onlyDesktop(info), '改库的用例只在 1920 那一遍跑');
    await page.goto('/notifications');
    const row = page.locator('[data-legacy-asks] li').filter({ hasText: '新模板的落款用谁的名字？' });
    await row.getByRole('button', { name: '关闭' }).click();
    await expect(page.getByText('关闭了', { exact: true }).first()).toBeVisible();
    await expect(page.locator('[data-legacy-asks]').getByText('新模板的落款用谁的名字？')).toHaveCount(0);
    // 另一条没动
    await expect(page.locator('[data-legacy-asks]').getByText('验证码短信走哪家通道？')).toBeVisible();

    const legacy = (await api.get('/api/asks/legacy')) as Legacy;
    expect(legacy.items.map((a) => a.id)).toEqual([stack.facts.askId]);
    const audit = (await api.get('/api/audit?limit=50')) as Audit;
    const entry = audit.items.find(
      (a) => a.action === 'ask.close' && a.target === `task:${stack.facts.tasks.asking}`,
    );
    expect(entry, '操作记录里要有这次关闭').toBeTruthy();
    expect(JSON.stringify(entry?.after)).toContain(stack.facts.askingAskId);

    const again = await api.send('POST', `/api/asks/${stack.facts.askingAskId}/close`, {});
    expect(again.status).toBe(409);
    expect((again.json as { error: { code: string } }).error.code).toBe('already_answered');
    const gone = await api.send('POST', '/api/asks/00000000-0000-4000-8000-00000000dead/close', {});
    expect(gone.status).toBe(404);
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
