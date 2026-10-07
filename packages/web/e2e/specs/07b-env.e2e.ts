// 法国页（环境页并进来，#1217）。六项事实只读，数据来自本后端 /api/env（和主页、额度页、/healthz 同一份读法）。
// 这套 e2e 起后端时配了两把远程通行证，所以这一页是本台加远程并排；只有一台不画对照列由页面测试钉住。
// 做完的标准里「法国引擎关着显示关着（临时调整）不是红」在 e2e 里造不出来（这台后端开着引擎）：那条由
// packages/api/test/env-view.test.ts 和 packages/web/src/routes/env.test.tsx 钉住；这里走真环境、看真数。
import { expect, onlyDesktop, test } from '../support/fixtures.ts';

type Env = {
  name: { name: string; problem?: string };
  facts: {
    engine: { ok: true; value: { state: string; detail?: string } } | { ok: false; reason: string };
    version:
      | { ok: true; value: { current: string | null; behind: number | null } }
      | { ok: false; reason: string };
    sessions: { ok: true; value: { total: number } } | { ok: false; reason: string };
    pools: { ok: true; value: { count: number } } | { ok: false; reason: string };
    health: { ok: true; value: { failing: string[]; notWired: string[] } } | { ok: false; reason: string };
    schedule: { ok: true; value: { status: string } } | { ok: false; reason: string };
  };
};

test.describe('法国页', () => {
  test.beforeEach(async ({ login }) => login());

  test('这一台一页看全：旧地址转到法国页，侧栏只有法国，本台六格和后端 /api/env 对得上', async ({
    page,
    api,
    shot,
  }) => {
    const env = (await api.get('/api/env')) as Env;
    await page.goto('/env');
    await expect(page).toHaveURL(/\/france$/);
    await expect(page.locator('aside').getByRole('link', { name: '法国', exact: true })).toBeVisible();
    await expect(page.locator('aside').getByRole('link', { name: '环境', exact: true })).toHaveCount(0);
    // 这套配了远程通行证，所以是并排：这里只看本台那一列（别的环境的列在 07c）
    const local = page.locator('[data-env-column="local"]');
    // 标题就是这一台的名字（FLEET_MACHINE_NAME，e2e 这套起后端时写的「本机」）
    expect(env.name.name).toBe('本机');
    await expect(local.getByRole('heading', { name: /本机/ })).toBeVisible();
    // 六格都在
    for (const label of ['引擎', '在用版本', '在跑的会话', '池占用', '健康', '最近拉单']) {
      await expect(local.getByText(label).first()).toBeVisible();
    }
    // 引擎开着（这套没关它）：不写「关着（临时调整）」
    await expect(local.getByText('在跑').first()).toBeVisible();
    await expect(page.getByText('关着（临时调整）')).toHaveCount(0);
    // 池占用的数和后端一致
    if (env.facts.pools.ok) await expect(local.getByText(`${env.facts.pools.value.count} 块`)).toBeVisible();
    await shot(page, '07b-环境');
  });

  test('读不到的格子明说「没查成 + 原因」，不拿空或 0 顶（版本那一项在开发环境读不到发布目录）', async ({
    page,
    api,
  }) => {
    const env = (await api.get('/api/env')) as Env;
    await page.goto('/france');
    const local = page.locator('[data-env-column="local"]');
    // 这台后端不是法国的正式机器（FLEET_ENV=development）：版本那一项一定是「没查成」，页面照实写，不写 0
    expect(env.facts.version.ok).toBe(false);
    if (!env.facts.version.ok) await expect(local.getByText(env.facts.version.reason).first()).toBeVisible();
    await expect(local.getByText('没查成').first()).toBeVisible();
  });

  test('顶栏常驻环境切换器（本台的名字跟着 /api/me 来，不在别的页拉整份 /api/env），下拉里能进法国页', async ({
    page,
  }) => {
    const envReads: string[] = [];
    page.on('request', (req) => {
      if (new URL(req.url()).pathname === '/api/env') envReads.push(req.url());
    });
    await page.goto('/');
    const switcher = page.locator('[data-env-switcher]');
    await expect(switcher).toBeVisible();
    await expect(switcher).toContainText('本机');
    expect(envReads, '主页上顶栏切换器不该去拉 /api/env（每次都跑全套健康检查）').toEqual([]);
    await switcher.click();
    await page.getByRole('menuitem', { name: /打开法国页/ }).click();
    await expect(page).toHaveURL(/\/france$/);
    await expect(page.getByRole('heading', { name: /本机/ }).first()).toBeVisible();
  });

  test('引擎总开关（#1086）：顶栏常驻状态，法国页点开（二次确认）→ 落库、进操作记录、刷新还开着 → 再点关；默认是关', async ({
    page,
    api,
    shot,
  }, info) => {
    test.skip(!onlyDesktop(info), '改库的用例只在 1920 那一遍跑');
    type Setting = { key: string; value: unknown; version: number; updatedBy?: string };
    type Audit = { items: { action: string; target: string; actor: { kind: string; id: string } }[] };
    const read = async () =>
      ((await api.get('/api/settings')) as { settings: Setting[] }).settings.find(
        (s) => s.key === 'engine.master',
      );
    // 种子里没设过：默认关
    expect((await read())?.value, '种子里总开关没设过，默认关').toBeNull();

    await page.goto('/france');
    const card = page.getByTestId('engine-master');
    await expect(card.getByTestId('engine-master-state')).toHaveText('关着');
    await expect(page.getByRole('link', { name: /引擎 关着/ })).toBeVisible();
    await shot(page, '07b-环境-引擎总开关-关着');

    // 点开启先弹确认；点「先不」什么都不改
    await card.getByRole('button', { name: '开启引擎总开关' }).click();
    const dialog = page.getByRole('alertdialog');
    await expect(dialog).toContainText('开启引擎总开关？');
    await dialog.getByRole('button', { name: '先不' }).click();
    expect((await read())?.value).toBeNull();

    await card.getByRole('button', { name: '开启引擎总开关' }).click();
    await page.getByRole('alertdialog').getByRole('button', { name: '开启', exact: true }).click();
    await expect(card.getByTestId('engine-master-state')).toHaveText('开着');
    await expect(page.getByRole('link', { name: /引擎 开着/ })).toBeVisible();
    await expect(card.getByTestId('engine-master-who')).toContainText('打开');
    await shot(page, '07b-环境-引擎总开关-开着');

    // 落库了：读回是 true；进了操作记录（谁、改的是 engine.master）
    await expect.poll(async () => (await read())?.value).toBe(true);
    const audit = (await api.get('/api/audit?target=setting:engine.master')) as Audit;
    expect(audit.items.map((a) => [a.action, a.actor.kind])).toContainEqual(['setting.update', 'user']);

    // 换一页（设置页）顶栏的胶囊还在、还是开着；刷新后还开着；再点关闭回到关着
    await page.goto('/settings');
    await expect(page.getByRole('link', { name: /引擎 开着/ })).toBeVisible();
    await expect(page.getByTestId('engine-master-relation')).toContainText('总开关关＝全停');
    await page.goto('/france');
    await expect(card.getByTestId('engine-master-state')).toHaveText('开着');
    await card.getByRole('button', { name: '关闭引擎总开关' }).click();
    await page.getByRole('alertdialog').getByRole('button', { name: '关闭', exact: true }).click();
    await expect(card.getByTestId('engine-master-state')).toHaveText('关着');
    await expect.poll(async () => (await read())?.value).toBe(false);
  });

  test('【故意造出的失败】未登录写总开关：PUT /api/settings/engine.master 回 401（登录门挡住，不是任何人都能点）', async ({
    stack,
    request,
  }, info) => {
    test.skip(!onlyDesktop(info), '只验后端接口，跑一遍就够');
    // request 夹具是独立的、没带登录 Cookie 的请求上下文（登录用的是 context.request）
    const res = await request.put(`${stack.webOrigin}/api/settings/engine.master`, {
      headers: { origin: stack.webOrigin },
      data: { value: true, version: 0 },
    });
    expect(res.status()).toBe(401);
  });
});
