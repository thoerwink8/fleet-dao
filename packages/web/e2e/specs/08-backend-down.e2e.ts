// 第八步：后端读不到、报错的时候，页面要显示明确的错误和重试，不是空白、不是 0。
// 后端前面有个开关代理（support/stack.ts）：down = 连接直接断开（像后端没了），error = 接口回 500；其余时候原样转发到真后端。
import { expect, test } from '../support/fixtures.ts';

const ANY_NETWORK_NOISE = [
  '请求失败',
  'HTTP 5',
  'status of 5',
  'ERR_',
  'Failed to load resource',
  '/api/',
  '/auth/',
];

test.describe('后端不可用', () => {
  test.beforeEach(async ({ login, problems }) => {
    for (const s of ANY_NETWORK_NOISE) problems.allow(s);
    await login();
  });
  test.afterEach(async ({ request, stack }) => {
    await request.post(`${stack.controlOrigin}/mode/up`);
  });

  test('一打开就连不上后端：整页写「没能确认登录」和原因、有重试，后端好了点重试就进去', async ({
    page,
    request,
    stack,
    shot,
  }) => {
    await request.post(`${stack.controlOrigin}/mode/down`);
    await page.goto('/quota');
    await expect(page.getByText('没能确认登录')).toBeVisible();
    await expect(page.getByRole('button', { name: '重试' })).toBeVisible();
    await shot(page, '08-后端断开-整页');
    await request.post(`${stack.controlOrigin}/mode/up`);
    await page.getByRole('button', { name: '重试' }).click();
    await expect(page.getByRole('heading', { name: '额度' })).toBeVisible();
    await expect(page.getByText('claude-carpool').first()).toBeVisible();
  });

  test('用着用着后端断了：这一页写「没读成」和原因、有重试，不是空白也不是 0；后端好了点重试数据回来', async ({
    page,
    request,
    stack,
    shot,
  }) => {
    await page.goto('/quota');
    await expect(page.getByText('claude-carpool').first()).toBeVisible();
    await request.post(`${stack.controlOrigin}/mode/down`);
    // 站内跳到「通知中心」：它的读取这时候失败
    await page.getByRole('link', { name: /通知中心/ }).click();
    const alert = page
      .getByRole('alert')
      .filter({ hasText: /没读成|没查成/ })
      .first();
    await expect(alert).toBeVisible({ timeout: 30_000 });
    await expect(alert.getByRole('button', { name: '重试' })).toBeVisible();
    await shot(page, '08-后端断开-单页');
    await request.post(`${stack.controlOrigin}/mode/up`);
    await alert.getByRole('button', { name: '重试' }).click();
    await expect(page.getByText('任务 12 卡住了')).toBeVisible();
    await expect(page.getByRole('alert').filter({ hasText: /没读成|没查成/ })).toHaveCount(0);
  });

  test('后端回 500：同样写明没读成、给重试', async ({ page, request, stack, shot }) => {
    await page.goto('/quota');
    await expect(page.getByText('claude-carpool').first()).toBeVisible();
    await request.post(`${stack.controlOrigin}/mode/error`);
    await page.getByRole('link', { name: '定时任务' }).click();
    const alert = page
      .getByRole('alert')
      .filter({ hasText: /没读成|没查成/ })
      .first();
    await expect(alert).toBeVisible({ timeout: 30_000 });
    await expect(alert).toContainText(/后端出错|出错|500/);
    await expect(alert.getByRole('button', { name: '重试' })).toBeVisible();
    await shot(page, '08-后端500');
  });

  test('改设置时后端断了：保存失败要弹明确的话，设置没有被当成改成功', async ({
    page,
    request,
    stack,
  }, info) => {
    test.skip(!info.project.name.endsWith('1920'), '改库的用例只在 1920 那一遍跑');
    await page.goto('/settings');
    const box = page.getByRole('textbox', { name: 'Jev 判断题每天调用上限' });
    await box.fill('200');
    await request.post(`${stack.controlOrigin}/mode/down`);
    await box.locator('xpath=ancestor::form').getByRole('button', { name: '保存' }).click();
    await expect(page.getByText(/没保存成|保存没成|没存上|没成/).first()).toBeVisible({ timeout: 30_000 });
    await request.post(`${stack.controlOrigin}/mode/up`);
    // 后端好了以后刷新：这项设置还是「没设过」，没被悄悄写进去
    await page.reload();
    await expect(page.getByRole('textbox', { name: 'Jev 判断题每天调用上限' })).toHaveValue('');
  });
});
