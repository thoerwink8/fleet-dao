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

    // 拼车额度：美元窗口 $38.00 / $100，用了 38%
    const carpool = page.getByRole('row', { name: /claude-carpool/ });
    await expect(carpool).toContainText('$38.00');
    await expect(carpool).toContainText('$100');
    await expect(carpool).toContainText('38%');

    // 独享额度：5 小时窗 55%、周窗 31%
    const solo = page.getByRole('row', { name: /claude-solo/ });
    await expect(solo).toContainText('55%');
    await expect(solo).toContainText('31%');

    // 读数过期的池要明说（Cursor 两小时前读的），一次没读成的池写「没查成」
    await expect(page.getByText(/读数过期或没查成/)).toBeVisible();
    await expect(page.getByRole('row', { name: /cursor/ }).first()).toContainText('估算');

    // 拼车对账：本机没记到花费、接口说用了 $38，写明「多半是别的设备在用」（不是假装对得上）
    await expect(page.getByText(/接口说用了 \$38\.00/)).toBeVisible();
    await shot(page, '04-额度');
  });

  test('额度快用完的池进「快用完」，不在「先用它」里', async ({ page }) => {
    await page.goto('/quota');
    // Mirasim 5 小时窗用了 93%
    // 顶上三块是收起的胶囊（#1805）：点开「快用完」才出明细，明细是带说明句的那块面板
    await page
      .locator('[data-quota-summary]')
      .getByRole('button', { name: /快用完/ })
      .click();
    const near = page.locator('div.rounded-xl', { hasText: '用了九成以上，调度会先绕开' }).first();
    await expect(near).toContainText('93%');
  });
});
