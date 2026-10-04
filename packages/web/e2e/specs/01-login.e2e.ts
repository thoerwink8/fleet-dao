// 第一步：登录（账密，#120）。创始人从没登录的浏览器打开驾驶舱，应该被带到登录页、能用账号密码进去、输错有明确提示。
import { expect, test } from '../support/fixtures.ts';

test.describe('登录', () => {
  test('没登录打开任何页面都先到登录页，登录后回到原来要去的页', async ({ page, problems, shot }) => {
    // 没登录时外壳先发出的几个读取都是 401、被带走的那次导航会被取消：都是预期里的
    for (const s of ['HTTP 401', 'status of 401', 'ERR_ABORTED']) problems.allow(s);
    await page.goto('/quota');
    await expect(page).toHaveURL(/\/login\?next=%2Fquota/);
    await expect(page.getByRole('heading', { name: /登录/ })).toBeVisible();
    await shot(page, '01-登录页');
  });

  // 缺陷 D1（#902）：后端的账密登录（POST /auth/password/login，#123）早就有了，/auth/config 也回 passwordLogin:true，
  // 但登录页只有飞书按钮和开发免登，没有用户名、密码两栏（前端那一半 #120 写明「另一个工人做」，没做）。
  // 在这个用例变绿之前，创始人在登录页根本登不进去（飞书没配时更是只剩死胡同）。
  test('登录页有用户名和密码两栏，输对了能进主页', async ({ page, stack, problems }) => {
    test.fail(true, '缺陷 D1：登录页没有账密入口（specs/902-驾驶舱用户视角e2e/缺陷清单.md）');
    for (const s of ['HTTP 401', 'status of 401', 'ERR_ABORTED']) problems.allow(s);
    await page.goto('/login');
    await expect(page.getByLabel('用户名'), '登录页要有用户名一栏').toBeVisible({ timeout: 5_000 });
    await page.getByLabel('用户名').fill(stack.facts.username);
    await page.getByLabel('密码').fill(stack.facts.password);
    await page.getByRole('button', { name: '登录', exact: true }).click();
    await expect(page).toHaveURL('/');
    await expect(page.getByRole('heading', { name: '主页' })).toBeVisible();
  });

  test('后端说账密登录是开着的（/auth/config）', async ({ stack, request }) => {
    const res = await request.get(`${stack.webOrigin}/auth/config`);
    expect(res.status()).toBe(200);
    expect(await res.json()).toMatchObject({ passwordLogin: true });
  });

  test('密码输错：后端回明确的错误，不给会话', async ({ stack, request }) => {
    const res = await request.post(`${stack.webOrigin}/auth/password/login`, {
      headers: { origin: stack.webOrigin },
      data: { username: stack.facts.username, password: 'definitely-not-the-password' },
    });
    expect(res.status()).toBe(401);
    expect(res.headers()['set-cookie']).toBeUndefined();
    const body = (await res.json()) as { error: { code: string; message: string } };
    expect(body.error.code).toBe('bad_credentials');
    expect(body.error.message.length).toBeGreaterThan(0);
  });

  test('账密登录成功：拿到会话，主页认得出是谁', async ({ page, login, shot }) => {
    await login();
    await page.goto('/');
    await expect(page.getByRole('heading', { name: '主页' })).toBeVisible();
    // 右上角账号菜单里写着登录的是谁
    await page.getByRole('button', { name: '我的账号' }).click();
    await expect(page.getByRole('menu')).toContainText('创始人甲');
    await shot(page, '01-登录后主页');
  });
});
