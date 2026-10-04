// 第二步：主页（一屏三块 + 持续状态）。每块的内容都来自真库，不是假数据。
// 主页的三段流程图由另一路在做（母单 #902 说明），这里只测它现在有的：要你拍的、在跑的、做完的、持续状态。
import { expect, test } from '../support/fixtures.ts';

type Home = {
  decisions: { kind: string; title: string; link: string }[];
  running: { issueNumber: number; title: string; link: string }[];
  done: { prNumber: number; title: string }[];
};

test.describe('主页', () => {
  test.beforeEach(async ({ login }) => login());

  test('三块都显示真库里的东西，条数和后端 /api/home 一致', async ({ page, api, shot }) => {
    const home = (await api.get('/api/home')) as Home;
    await page.goto('/');
    await expect(page.getByRole('heading', { name: '要你拍的' })).toBeVisible();

    // 要你拍的：一条待批、一条追问（库里 approval 通知 + 未答的 ask）
    for (const d of home.decisions) await expect(page.getByText(d.title).first()).toBeVisible();
    expect(home.decisions.map((d) => d.kind).sort()).toEqual(expect.arrayContaining(['approval', 'ask']));
    await expect(page.getByText('等你批：合并 PR #41（碰了删数据的人闸）')).toBeVisible();
    await expect(page.getByText('验证码短信走哪家通道？')).toBeVisible();

    // 在跑的：#12 登录页加验证码（库里 running 的那张）
    await expect(page.getByRole('link', { name: /#12 登录页加验证码/ })).toBeVisible();
    expect(home.running.map((r) => r.issueNumber)).toContain(12);

    // 做完的：合进去的 PR #39，标题是它挂的那张单的标题
    await expect(page.getByRole('link', { name: /PR #39 README 加一行当前时间/ })).toBeVisible();
    expect(home.done.map((d) => d.prNumber)).toContain(39);

    // 持续状态：额度、路由、引擎三格都有话说（不是空白）
    const strip = page.getByRole('status', { name: '持续状态' });
    await expect(strip).toContainText('额度');
    await expect(strip).toContainText('中转');
    await expect(strip).toContainText('引擎');
    await shot(page, '02-主页');
  });

  test('点在跑的卡片，进到那张单的详情', async ({ page, stack }) => {
    await page.goto('/');
    await page.getByRole('link', { name: /#12 登录页加验证码/ }).click();
    await expect(page).toHaveURL(new RegExp(`/tasks/${stack.facts.tasks.running}`));
    await expect(page.getByRole('heading', { name: /登录页加验证码/ })).toBeVisible();
  });

  // 缺陷 D2（#902）：主页「在跑的」把所有没结束的单都列出来、一律写「在跑」：停滞（stalled）的 #14、还在排队的 #15 也是蓝色「在跑」。
  // 创始人一眼看过去会以为 #14 在好好干，其实它已经停滞要人看。
  test('停滞的单在「在跑的」里不能写成「在跑」', async ({ page }) => {
    test.fail(true, '缺陷 D2：主页「在跑的」不区分停滞/排队，一律写在跑');
    await page.goto('/');
    const card = page.getByRole('link', { name: /#14 导出报表加 CSV/ });
    await expect(card).toBeVisible();
    await expect(card).not.toContainText('在跑');
  });

  // 缺陷 D3（#902）：主页「要你拍的」里追问的按钮写着「去答」，点过去是任务详情页，那页没有任何回答的地方
  // （回答的对话框只在通知中心里、且只对「等回答」状态的单出现；#259 以后追问不挡路，单子一直是在跑）。
  test('追问点「去答」之后，能在那一页回答它', async ({ page, stack }) => {
    test.fail(true, '缺陷 D3：「去答」是死胡同，任务页没有回答入口');
    await page.goto('/');
    await page.getByRole('link', { name: '去答' }).nth(1).click();
    await expect(page).toHaveURL(new RegExp(`/tasks/${stack.facts.tasks.running}`));
    await expect(page.getByRole('button', { name: /回答/ })).toBeVisible();
  });
});
