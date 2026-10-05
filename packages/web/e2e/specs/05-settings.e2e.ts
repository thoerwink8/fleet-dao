// 第五步：设置页。「引擎暂不用独享」开关、各渠道额度留量线、同时跑的会话上限：改了要落库、带版本号、进操作记录，刷新后还在。
// 改库的用例只在 1920 那一遍里跑（同一份库，1366 那一遍只看版面）。
import { expect, onlyDesktop, test } from '../support/fixtures.ts';

type Setting = { key: string; value: unknown; version: number; updatedBy?: string };
type Audit = {
  items: {
    action: string;
    target: string;
    before?: unknown;
    after?: unknown;
    actor: { kind: string; id: string };
  }[];
};

const settingOf = async (api: { get: (p: string) => Promise<unknown> }, key: string): Promise<Setting> => {
  const all = (await api.get('/api/settings')) as { settings: Setting[] };
  const s = all.settings.find((x) => x.key === key);
  if (!s) throw new Error(`后端的设置里没有 ${key}`);
  return s;
};

test.describe('设置页', () => {
  test.beforeEach(async ({ login }) => login());

  test('版面：留量线按池列出（拼车池、独享池分开写），种子装的线是 80% / 70%', async ({ page, shot }) => {
    await page.goto('/settings');
    await expect(page.getByRole('heading', { name: '运行设置' })).toBeVisible();
    await expect(page.getByRole('switch', { name: '引擎暂不用独享' })).toBeVisible();
    // 缺陷 D4（本 PR 已修）：同一渠道的两个池以前都写成「Claude 订阅」，分不出哪行是独享
    const reserve = page.locator('form', { hasText: '各渠道的额度留量线' });
    await expect(reserve).toContainText('Claude 订阅 · claude-solo');
    await expect(reserve).toContainText('Claude 订阅 · claude-carpool');
    await expect(reserve.getByTestId('reserve-source')).toContainText('来自种子');
    await expect(page.locator('#reserve-claude-solo-5h')).toHaveValue('80');
    await expect(page.locator('#reserve-claude-solo-7d')).toHaveValue('70');
    await expect(page.locator('#reserve-claude-carpool-5h')).toHaveValue('');
    await shot(page, '05-设置');
  });

  test('「引擎暂不用独享」：拨开 → 落库第 1 版、进操作记录、刷新还在、额度页也跟着说', async ({
    page,
    api,
  }, info) => {
    test.skip(!onlyDesktop(info), '改库的用例只在 1920 那一遍跑');
    expect((await settingOf(api, 'engine.soloPaused')).version).toBe(0);

    await page.goto('/settings');
    const sw = page.getByRole('switch', { name: '引擎暂不用独享' });
    await expect(sw).not.toBeChecked();
    await sw.click();
    await expect(sw).toBeChecked();
    await expect(page.getByText('第 1 版').first()).toBeVisible();

    // 落库了：后端读回来是 true、版本 1、是创始人甲改的
    await expect
      .poll(async () => settingOf(api, 'engine.soloPaused'))
      .toMatchObject({ value: true, version: 1 });
    // 进了操作记录：谁、什么、改前改后
    const audit = (await api.get('/api/audit?limit=50')) as Audit;
    const entry = audit.items.find(
      (a) => a.action === 'setting.update' && a.target === 'setting:engine.soloPaused',
    );
    expect(entry, '操作记录里要有这次改动').toBeTruthy();
    expect(entry?.after).toBe(true);
    expect(entry?.actor.kind).toBe('user');

    // 刷新后还在
    await page.reload();
    await expect(page.getByRole('switch', { name: '引擎暂不用独享' })).toBeChecked();
    // 额度页的切号现状也读到了它
    await page.goto('/quota');
    await expect(page.getByText(/暂不用独享|不自动切到独享|引擎暂不用独享/).first()).toBeVisible();
  });

  test('带过期的版本号保存：后端回 409，不悄悄盖掉', async ({ api }, info) => {
    test.skip(!onlyDesktop(info), '改库的用例只在 1920 那一遍跑');
    const cur = await settingOf(api, 'sessions.maxConcurrent');
    const stale = await api.send('PUT', '/api/settings/sessions.maxConcurrent', {
      value: 9,
      version: cur.version - 1,
    });
    expect(stale.status).toBe(409);
    expect((stale.json as { error: { code: string } }).error.code).toBe('conflict');
    // 值没被动
    expect((await settingOf(api, 'sessions.maxConcurrent')).value).toBe(cur.value);
  });

  test('同时跑的会话上限 6 → 8：保存后版本 +1，刷新还是 8；填 99 当场拦住', async ({
    page,
    api,
    shot,
  }, info) => {
    test.skip(!onlyDesktop(info), '改库的用例只在 1920 那一遍跑');
    const before = await settingOf(api, 'sessions.maxConcurrent');
    expect(before.value).toBe(6);
    await page.goto('/settings');
    const box = page.getByRole('textbox', { name: '同时跑的会话上限' });
    await box.fill('99');
    await box.locator('xpath=ancestor::form').getByRole('button', { name: '保存' }).click();
    await expect(page.getByText('这个值不行')).toBeVisible();
    expect((await settingOf(api, 'sessions.maxConcurrent')).version).toBe(before.version);

    await box.fill('8');
    await box.locator('xpath=ancestor::form').getByRole('button', { name: '保存' }).click();
    await expect
      .poll(async () => settingOf(api, 'sessions.maxConcurrent'))
      .toMatchObject({ value: 8, version: before.version + 1 });
    await page.reload();
    await expect(page.getByRole('textbox', { name: '同时跑的会话上限' })).toHaveValue('8');
    await shot(page, '05-设置-改完');
  });

  test('独享 5 小时留量线 80% → 50%（独享已用 55%，到线了）：落库（整份换、版本 +1）、改成「人改过」、刷新还在、额度页的线跟着变', async ({
    page,
    api,
  }, info) => {
    test.skip(!onlyDesktop(info), '改库的用例只在 1920 那一遍跑');
    const before = await settingOf(api, 'engine.quotaReserve');
    expect(before.value).toMatchObject({ 'claude-solo': { '5h': 0.8, '7d': 0.7 } });
    await page.goto('/settings');
    const reserve = page.locator('form', { hasText: '各渠道的额度留量线' });
    await page.locator('#reserve-claude-solo-5h').fill('50');
    await reserve.getByRole('button', { name: '保存' }).click();
    await expect
      .poll(async () => settingOf(api, 'engine.quotaReserve'))
      .toMatchObject({
        value: { 'claude-solo': { '5h': 0.5, '7d': 0.7 } },
        version: before.version + 1,
      });
    await page.reload();
    await expect(page.locator('#reserve-claude-solo-5h')).toHaveValue('50');
    await expect(page.getByTestId('reserve-source')).toContainText('人在驾驶舱改过');
    const audit = (await api.get('/api/audit?limit=50')) as Audit;
    expect(
      audit.items.some((a) => a.action === 'setting.update' && a.target === 'setting:engine.quotaReserve'),
    ).toBe(true);

    // 改低到 50% 以后独享 5 小时窗已用 55% 就到线了：额度页立刻明说「到了留量线」，后端 /api/pools 也是 reached
    const pools = (await api.get('/api/pools')) as { orgSwitch: { soloReserve?: { state: string } } };
    expect(pools.orgSwitch.soloReserve?.state).toBe('reached');
    await page.goto('/quota');
    await expect(page.getByText(/到了留量线/).first()).toBeVisible();
  });
});
