// 第十步：设置页「账密登录」一节（缺陷 D1，#926）。创始人在设置页看自己的账密现状、改密码：当前密码输错有明确提示（不被踢到登录页），
// 改成功后这个浏览器不掉线、旧密码作废、新密码能登、操作记录里有 credentials.change。放在退出（09）之后：09 让所有会话作废，这里重新登。
// 改密码的用例动的是同一份库，只在 1920 那一遍跑，而且用例末尾把密码改回备库给的那个（别的用例、重跑都靠它）。
import { expect, onlyDesktop, test } from '../support/fixtures.ts';

const NEW_PASSWORD = 'e2e-brand-new-passphrase-1';

test.describe('设置页：账密登录', () => {
  test.beforeEach(async ({ login }) => login());

  test('版面：现状写用户名，改账密表单有当前密码、用户名、新密码、再输一遍，栏的 autocomplete 对', async ({
    page,
    stack,
    shot,
  }) => {
    await page.goto('/settings');
    await expect(page.getByRole('heading', { name: '账密登录' })).toBeVisible();
    await expect(page.getByText(/已设账密：用户名/)).toContainText(stack.facts.username);
    const form = page.getByRole('form', { name: '改账密' });
    await expect(form.getByLabel('当前密码', { exact: true })).toHaveAttribute(
      'autocomplete',
      'current-password',
    );
    await expect(form.getByLabel(/^用户名/)).toHaveValue(stack.facts.username);
    await expect(form.getByLabel(/^新密码/)).toHaveAttribute('autocomplete', 'new-password');
    await expect(form.getByLabel('再输一遍新密码', { exact: true })).toBeVisible();
    await expect(form.getByText(/至少 10 位/)).toBeVisible();
    await page.getByRole('heading', { name: '账密登录' }).scrollIntoViewIfNeeded();
    await shot(page, '10-设置-账密');
  });

  test('当前密码输错：话落在「当前密码」那一栏、还留在设置页、登录没掉', async ({
    page,
    api,
    stack,
    problems,
  }, info) => {
    test.skip(!onlyDesktop(info), '输错会记一次错，只在 1920 那一遍跑');
    // 后端回 401（bad_current_password）是预期里的
    for (const s of ['HTTP 401', 'status of 401']) problems.allow(s);
    await page.goto('/settings');
    const form = page.getByRole('form', { name: '改账密' });
    await form.getByLabel('当前密码', { exact: true }).fill('definitely-not-it-1');
    await form.getByLabel(/^新密码/).fill(NEW_PASSWORD);
    await form.getByLabel('再输一遍新密码', { exact: true }).fill(NEW_PASSWORD);
    await form.getByRole('button', { name: '保存修改' }).click();
    await expect(form.getByText('当前密码不对')).toBeVisible();
    await expect(page).toHaveURL(/\/settings$/);
    // 还登着：直接问后端
    const me = (await api.get('/api/me')) as { user: { displayName: string } };
    expect(me.user.displayName).toBe('创始人甲');
    // 没改成：现状里密码还是原来的（用原密码能登）
    const res = await page.context().request.post(`${stack.webOrigin}/auth/password/login`, {
      headers: { origin: stack.webOrigin },
      data: { username: stack.facts.username, password: stack.facts.password },
    });
    expect(res.status()).toBe(204);
  });

  test('改密码：这个浏览器不掉线、说明别处登录作废、旧密码不能登新密码能登、操作记录里有 credentials.change；最后改回去', async ({
    page,
    api,
    stack,
    request,
    shot,
  }, info) => {
    test.skip(!onlyDesktop(info), '改密码动的是同一份库，只在 1920 那一遍跑');
    const loginWith = (password: string) =>
      request.post(`${stack.webOrigin}/auth/password/login`, {
        headers: { origin: stack.webOrigin },
        data: { username: stack.facts.username, password },
      });
    try {
      await page.goto('/settings');
      const form = page.getByRole('form', { name: '改账密' });
      await form.getByLabel('当前密码', { exact: true }).fill(stack.facts.password);
      await form.getByLabel(/^新密码/).fill(NEW_PASSWORD);
      await form.getByLabel('再输一遍新密码', { exact: true }).fill(NEW_PASSWORD);
      await form.getByRole('button', { name: '保存修改' }).click();
      const note = page.getByRole('status').filter({ hasText: '密码已改好' });
      await expect(note).toContainText('别处');
      await expect(note).toContainText('作废');
      await shot(page, '10-设置-改完密码');

      // 这个浏览器还登着（会话在这一处换了新 Cookie）
      await page.reload();
      await expect(page.getByRole('heading', { name: '设置', exact: true })).toBeVisible();
      expect(((await api.get('/api/me')) as { user: { displayName: string } }).user.displayName).toBe(
        '创始人甲',
      );
      // 页面上不留密码
      expect(await page.locator('body').innerText()).not.toContain(NEW_PASSWORD);

      // 旧密码不能登了、新密码能登
      expect((await loginWith(stack.facts.password)).status()).toBe(401);
      expect((await loginWith(NEW_PASSWORD)).status()).toBe(204);

      // 操作记录里有「改了账密登录」，只记改了什么、不记密码
      const audit = (await api.get('/api/audit?limit=50')) as { items: { action: string }[] };
      expect(audit.items.some((a) => a.action === 'credentials.change')).toBe(true);
      expect(JSON.stringify(audit)).not.toContain(NEW_PASSWORD);
      await page.goto('/audit');
      await expect(page.getByText('改了账密登录').first()).toBeVisible();
    } finally {
      // 改回备库给的密码（走接口；没改成时这一步会被拒，忽略）
      await api.send('PUT', '/api/me/credentials', {
        newPassword: stack.facts.password,
        currentPassword: NEW_PASSWORD,
      });
    }
    expect((await loginWith(stack.facts.password)).status(), '密码已改回去').toBe(204);
  });
});
