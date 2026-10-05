// 第七步之后：环境页（#820 片 1）。这一页只读，不跨环境：数据全来自本后端 /api/env（和主页、额度页、/healthz 同一份读法）。
// 页面要能回答「回来看一眼」：引擎在不在、在用哪版、落后主线没有、手上几个会话在跑、池占几个、健康红几项、最近拉单。
// 做完的标准里「法国引擎关着显示关着（临时调整）不是红」在 e2e 里造不出来（这台后端开着引擎）：那条由
// packages/api/test/env-view.test.ts 和 packages/web/src/routes/env.test.tsx 钉住；这里走真环境、看真数。
import { expect, test } from '../support/fixtures.ts';

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

test.describe('环境页', () => {
  test.beforeEach(async ({ login }) => login());

  test('这一台环境一页看全：标题是环境名，六格都在，和后端 /api/env 对得上', async ({ page, api, shot }) => {
    const env = (await api.get('/api/env')) as Env;
    await page.goto('/env');
    // 标题就是这一台的名字（FLEET_MACHINE_NAME，e2e 这套起后端时写的「本机」）
    expect(env.name.name).toBe('本机');
    await expect(page.getByRole('heading', { name: /本机/ })).toBeVisible();
    // 六格都在
    for (const label of ['引擎', '在用版本', '在跑的会话', '池占用', '健康', '最近拉单']) {
      await expect(page.getByText(label).first()).toBeVisible();
    }
    // 引擎开着（这套没关它）：不写「关着（临时调整）」
    await expect(page.getByText('在跑').first()).toBeVisible();
    await expect(page.getByText('关着（临时调整）')).toHaveCount(0);
    // 池占用的数和后端一致
    if (env.facts.pools.ok) await expect(page.getByText(`${env.facts.pools.value.count} 块`)).toBeVisible();
    await shot(page, '07b-环境');
  });

  test('读不到的格子明说「没查成 + 原因」，不拿空或 0 顶（版本那一项在开发环境读不到发布目录）', async ({
    page,
    api,
  }) => {
    const env = (await api.get('/api/env')) as Env;
    await page.goto('/env');
    // 这台后端不是法国的正式机器（FLEET_ENV=development）：版本那一项一定是「没查成」，页面照实写，不写 0
    expect(env.facts.version.ok).toBe(false);
    if (!env.facts.version.ok) await expect(page.getByText(env.facts.version.reason).first()).toBeVisible();
    await expect(page.getByText('没查成').first()).toBeVisible();
  });

  test('顶栏常驻环境名徽标，点开进环境页', async ({ page }) => {
    await page.goto('/');
    const badge = page.locator('[data-env-badge]');
    await expect(badge).toBeVisible();
    await expect(badge).toContainText('本机');
    await badge.click();
    await expect(page).toHaveURL(/\/env$/);
    await expect(page.getByRole('heading', { name: /本机/ })).toBeVisible();
  });
});
