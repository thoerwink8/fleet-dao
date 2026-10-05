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

  // 缺陷 D1（#926 已修）：登录页以前只有飞书按钮和开发免登，没有用户名、密码两栏；创始人按剧本登不进去。
  test('登录页有用户名和密码两栏：输对了回车就进主页，账号菜单写着名字，会话 Cookie 是 HttpOnly', async ({
    page,
    context,
    stack,
    problems,
    shot,
  }) => {
    for (const s of ['HTTP 401', 'status of 401', 'ERR_ABORTED']) problems.allow(s);
    // 密码任何时候都不该出现在地址里（任何一次请求的网址、页面网址）
    const urls: string[] = [];
    page.on('request', (r) => urls.push(r.url()));
    await page.goto('/login?next=%2Fquota');
    const username = page.getByLabel('用户名');
    const password = page.getByLabel('密码', { exact: true });
    await expect(username, '登录页要有用户名一栏').toBeVisible();
    await expect(username, '光标一进页面就在用户名栏').toBeFocused();
    await expect(username).toHaveAttribute('autocomplete', 'username');
    await expect(password).toHaveAttribute('autocomplete', 'current-password');
    await expect(password).toHaveAttribute('type', 'password');
    await shot(page, '01-登录页-账密');
    await username.fill(stack.facts.username);
    await password.fill(stack.facts.password);
    await password.press('Enter');
    // next 带回去：登录后落在原来要去的页
    await expect(page).toHaveURL(/\/quota$/);
    await page.getByRole('button', { name: '我的账号' }).click();
    await expect(page.getByRole('menu')).toContainText('创始人甲');
    const session = (await context.cookies()).find((c) => c.name.includes('session'));
    expect(session, '登录后要有会话 Cookie').toBeTruthy();
    expect(session?.httpOnly, '会话 Cookie 不给页面脚本读').toBe(true);
    expect(
      urls.some(
        (u) => u.includes(encodeURIComponent(stack.facts.password)) || u.includes(stack.facts.password),
      ),
    ).toBe(false);
  });

  test('密码输错：页面写「用户名或密码不对」、留在登录页、不发会话、用户名留着密码清空', async ({
    page,
    context,
    stack,
    problems,
    shot,
  }) => {
    for (const s of ['HTTP 401', 'status of 401', 'ERR_ABORTED']) problems.allow(s);
    await page.goto('/login');
    await page.getByLabel('用户名').fill(stack.facts.username);
    await page.getByLabel('密码', { exact: true }).fill('definitely-not-the-password');
    await page.getByRole('button', { name: '登录', exact: true }).click();
    await expect(page.getByRole('alert')).toContainText('用户名或密码不对');
    await expect(page).toHaveURL(/\/login$/);
    expect((await context.cookies()).some((c) => c.name.includes('session'))).toBe(false);
    await expect(page.getByLabel('用户名')).toHaveValue(stack.facts.username);
    await expect(page.getByLabel('密码', { exact: true })).toHaveValue('');
    await expect(page.getByLabel('密码', { exact: true })).toBeFocused();
    // 不透露账号在不在：换一个不存在的用户名，话一模一样
    const first = await page.getByRole('alert').innerText();
    await page.getByLabel('用户名').fill('nobody-here');
    await page.getByLabel('密码', { exact: true }).fill('definitely-not-the-password');
    await page.getByRole('button', { name: '登录', exact: true }).click();
    await expect(page.getByRole('alert')).toHaveText(first);
    await shot(page, '01-登录页-密码错');
  });

  test('后端没起来：写读不到后端、说明不是密码的问题（不说密码不对）', async ({ page, stack, problems }) => {
    // 这一条只在浏览器里拦掉登录请求来模拟，不动真后端
    for (const s of [
      'HTTP 401',
      'status of 401',
      'ERR_ABORTED',
      'ERR_CONNECTION_REFUSED',
      'Failed to load resource',
    ]) {
      problems.allow(s);
    }
    await page.goto('/login');
    await page.route('**/auth/password/login', (route) => route.abort('connectionrefused'));
    await page.getByLabel('用户名').fill(stack.facts.username);
    await page.getByLabel('密码', { exact: true }).fill('whatever-it-is-1');
    await page.getByRole('button', { name: '登录', exact: true }).click();
    await expect(page.getByRole('alert')).toContainText('读不到后端');
    await expect(page.getByRole('alert')).toContainText('不是密码的问题');
    await expect(page.getByRole('alert')).not.toContainText('用户名或密码不对');
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
