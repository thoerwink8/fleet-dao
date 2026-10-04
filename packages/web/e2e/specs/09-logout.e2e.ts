// 第九步：退出。点头像菜单里的退出：回到登录页，旧会话作废（拿旧 Cookie 请求回 401），操作记录里有退出这一条。
import { expect, onlyDesktop, test } from '../support/fixtures.ts';

test.describe('退出', () => {
  test('退出：回登录页、旧会话作废、再打开任何页面又被带去登录', async ({
    page,
    context,
    stack,
    login,
    api,
    shot,
  }, info) => {
    test.skip(!onlyDesktop(info), '退出会让这个人所有设备上的会话作废：只在 1920 那一遍、放在最后跑');
    await login();
    await page.goto('/');
    const cookies = await context.cookies();
    const session = cookies.find((c) => c.name.includes('session'));
    expect(session, '登录后要有会话 Cookie').toBeTruthy();

    await page.getByRole('button', { name: '我的账号' }).click();
    await shot(page, '09-头像菜单');
    await page.getByRole('menuitem', { name: '退出登录' }).click();
    await expect(page).toHaveURL(/\/login/);

    // 旧 Cookie 已作废
    const stale = await context.request.get(`${stack.webOrigin}/api/me`, {
      headers: { cookie: `${session?.name}=${session?.value}` },
    });
    expect(stale.status()).toBe(401);
    await page.goto('/settings');
    await expect(page).toHaveURL(/\/login\?next=%2Fsettings/);
    await shot(page, '09-退出后');

    // 退出这件事进了操作记录（重新登录后看）
    await login();
    const audit = (await api.get('/api/audit?limit=50')) as { items: { action: string }[] };
    expect(audit.items.some((a) => a.action === 'logout')).toBe(true);
  });
});
