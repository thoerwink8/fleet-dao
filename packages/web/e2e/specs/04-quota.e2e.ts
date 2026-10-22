// 第四步：额度页。拼车额度（美元窗口）、独享额度（百分比窗口）、切号现状、烧速「约 N 分钟后用满」、拼车对账，全部来自真库。
import { expect, test } from '../support/fixtures.ts';
import { refreshLedgerNow } from '../support/stack.ts';

type Pools = {
  pools: { id: string; windows: { window: string; used?: number; limit?: number; utilization?: number }[] }[];
  orgSwitch: { state: string; live?: string; burn?: { state: string; minutesLeft?: number | null } };
};

test.describe('额度页', () => {
  test.beforeEach(async ({ login, stack }) => {
    // 切号账本里的接口读数是「相对写入时刻」的，烧速只认 15 分钟内的：开跑前重写一遍。
    refreshLedgerNow(stack.facts.dbUrl);
    await login();
  });

  test('拼车池和独享池的额度读数、切号现状、烧速估计都显示出来', async ({ page, api, shot }) => {
    const pools = (await api.get('/api/pools')) as Pools;
    expect(pools.orgSwitch.state).toBe('known');
    expect(pools.orgSwitch.burn?.state).toBe('known');

    await page.goto('/quota');
    await expect(page.getByRole('heading', { name: '额度' })).toBeVisible();

    // 切号现状：挂着拼车；烧速：约 N 分钟后用满（和后端算的同一个数）
    await expect(page.getByText('挂着拼车')).toBeVisible();
    const left = Math.ceil(pools.orgSwitch.burn?.minutesLeft ?? Number.NaN);
    expect(Number.isFinite(left)).toBe(true);
    await expect(page.getByText(new RegExp(`约 ${left} 分钟后用满`))).toBeVisible();

    // 池 × 窗口的表（下面的「作废预估」也是每池一行，按池名找行要限在这张表里）；一个池的一个窗口一行
    const matrix = page.locator('[data-quota-matrix]');
    // 拼车额度：美元窗口 $38.00 / $100，用了 38%
    const carpool = matrix
      .getByRole('row', { name: /claude-carpool/ })
      .filter({ hasText: '$38.00' })
      .first();
    await expect(carpool).toContainText('$100');
    await expect(carpool).toContainText('38%');

    // 独享额度：5 小时窗 55%、周窗 31%（各占一行）
    const solo = matrix.getByRole('row', { name: /claude-solo/ });
    await expect(solo.filter({ hasText: '55%' }).first()).toBeVisible();
    await expect(solo.filter({ hasText: '31%' }).first()).toBeVisible();

    // 读数过期的池要明说（Cursor 两小时前读的），一次没读成的池写「没查成」
    await expect(page.getByText(/读数过期或没查成/)).toBeVisible();
    // 一行一个状态：过期的读数写「读数过期」，读数旁写「2 小时前算」（估算的，不是实读）
    const cursor = matrix.getByRole('row', { name: /cursor/ }).first();
    await expect(cursor).toContainText('读数过期');
    await expect(cursor).toContainText('前算');
    // 作废预估（#2737）：每个池一行，独享池也在里面
    await expect(page.locator('[data-quota-pressure] [data-pressure-pool="claude-solo"]')).toBeVisible();

    // 拼车对账：本机没记到花费、接口说用了 $38，写明「多半是别的设备在用」（不是假装对得上）
    await expect(page.getByText(/接口说用了 \$38\.00/)).toBeVisible();
    await shot(page, '04-额度');
  });

  test('额度快用完的池进「快用完」，不在「先用它」里', async ({ page }) => {
    await page.goto('/quota');
    // Mirasim 5 小时窗用了 93%
    // 表上面的页签（全部 / 该先用 / 快用完 / 读数过期或没查成）把表筛一遍：点「快用完」，表里只剩快用完的行
    await page
      .locator('[data-quota-summary]')
      .getByRole('tab', { name: /快用完/ })
      .click();
    const near = page.locator('[data-quota-matrix]');
    await expect(near).toContainText('93%');
    await expect(near).toContainText('快用完');
  });
});
