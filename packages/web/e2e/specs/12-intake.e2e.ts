// 提需求（母单 #2047 第 D 片 #2062）：真后端、真库走一遍母单「怎么算做完」的三个场景里 e2e 能走到的部分。
// 备库（packages/api/test/e2e/seed-requests.ts）灌了三条：乙提的待甲拍板、甲已结案（开了 #12）、甲提的乙也说过话。
// e2e 没接 GitHub、没起引擎：「同意做」照实回「没接上 GitHub」且不结案；指挥官照实写暂停原因。真开单、指挥官回话在法国点验。
import type { Page } from '@playwright/test';
import { expect, onlyDesktop, test } from '../support/fixtures.ts';

type Detail = {
  request: { seq: number; status: string; deletedAt?: string; continuesSeq?: number };
  messages: { kind: string; body: string }[];
};
type List = { items: { seq: number; title: string; continuesSeq?: number }[] };

const stream = (page: Page) => page.locator('section[aria-label="需求对话"]');
const listRow = (page: Page, title: string) =>
  page.locator('[aria-label="需求列表"]').getByText(title, { exact: true }).first();

test.describe('提需求', () => {
  test.beforeEach(async ({ login }) => login());

  test('列表三处都读真库：待拍板的在「等我的」里；甲乙头像各写名字最后一个字', async ({
    page,
    shot,
    stack,
  }) => {
    await page.goto('/intake');
    // 窄于 1024 的屏上列表默认收成一条窄栏（只有头像），先展开再看标题
    const list = page.locator('[aria-label="需求列表"]');
    await expect(list).toBeVisible();
    if ((await list.getAttribute('data-collapsed')) !== null) {
      await page.getByRole('button', { name: '展开需求列表' }).click();
      await expect(list).not.toHaveAttribute('data-collapsed');
    }
    await expect(listRow(page, '任务列表按仓筛')).toBeVisible();
    await expect(listRow(page, '设置页密钥一次填好')).toBeVisible();
    await expect(listRow(page, '额度页按账号池折叠')).toBeVisible();
    await expect(page.locator('[aria-label="需求列表"] [data-avatar="me"]').first()).toHaveText('甲');
    await expect(page.locator('[aria-label="需求列表"] [data-avatar="other"]').first()).toHaveText('乙');
    await page.goto(`/intake?r=${stack.facts.requests.pending}`);
    // 拍板卡上就有要拍的那一版：标题、场景、怎么算做完，不用另开单子
    const card = page.locator('[data-decide-card]');
    await expect(card.getByRole('button', { name: '同意做' })).toBeVisible();
    await expect(card.locator('[data-decide-gist]')).toContainText('任务列表几个仓混在一起');
    await expect(card.locator('[data-decide-gist]')).toContainText('任务列表顶上能选仓');
    await shot(page, '12-提需求-拍板卡');
  });

  test('已结案的锁住：没有输入框，写「已结案，内容不再改」，能「接着这条提」', async ({
    page,
    shot,
    stack,
  }) => {
    await page.goto(`/intake?r=${stack.facts.requests.closed}`);
    await expect(stream(page).getByText('已结案，内容不再改')).toBeVisible();
    await expect(page.getByRole('textbox', { name: '消息' })).toHaveCount(0);
    await expect(
      stream(page)
        .getByText(/开成 #12/)
        .first(),
    ).toBeVisible();
    await expect(page.getByRole('button', { name: '接着这条提' }).first()).toBeVisible();
    await shot(page, '12-提需求-已结案');
  });

  test('别人也说过话的不能删：菜单里没有「删除」', async ({ page, stack }) => {
    await page.goto(`/intake?r=${stack.facts.requests.shared}`);
    await page
      .getByRole('button', { name: `更多操作：需求 ${stack.facts.requests.shared}` })
      .first()
      .click();
    const menu = page.getByRole('menu');
    await expect(menu.getByRole('menuitem', { name: '改名' })).toBeVisible();
    await expect(menu.getByRole('menuitem', { name: /删除/ })).toHaveCount(0);
  });

  test('拍板「同意做」：e2e 没接 GitHub，照实写开不了单，需求还在待拍板', async ({
    page,
    api,
    stack,
    problems,
  }, info) => {
    test.skip(!onlyDesktop(info), '改库的用例只在 1920 那一遍跑');
    problems.allow(`/api/requests/${stack.facts.requests.pending}/actions`);
    problems.allow('status of 503');
    await page.goto(`/intake?r=${stack.facts.requests.pending}`);
    await page.locator('[data-decide-card]').getByRole('button', { name: '同意做' }).click();
    await expect(page.getByText(/没接上 GitHub/).first()).toBeVisible();
    const d = (await api.get(`/api/requests/${stack.facts.requests.pending}`)) as Detail;
    expect(d.request.status).toBe('pending_decision');
  });

  test('新提一条 → 删除（确认框写 30 天）→ 最近删除里点开 → 恢复回进行中', async ({
    page,
    api,
    shot,
  }, info) => {
    test.skip(!onlyDesktop(info), '改库的用例只在 1920 那一遍跑');
    const title = '通知中心能不能一键全部标已读？';
    await page.goto('/intake?r=new');
    await page.getByRole('textbox', { name: '消息' }).fill(title);
    await page.getByRole('button', { name: '发送' }).click();
    await expect(page).toHaveURL(/\/intake\?r=\d+/);
    const seq = Number(new URL(page.url()).searchParams.get('r'));
    // 没起引擎：指挥官照实写暂停原因，一句话说清，不套两层「暂停了」
    const paused = stream(page).locator('[data-message="paused"]');
    await expect(paused).toBeVisible();
    await expect(paused).not.toContainText('指挥官暂停了：指挥官暂停了');
    // 自己刚提的一条，系统的一行小字不画「以下是新消息」
    await expect(stream(page).getByText('以下是新消息')).toHaveCount(0);

    await page
      .getByRole('button', { name: `更多操作：需求 ${seq}` })
      .first()
      .click();
    await page.getByRole('menuitem', { name: /删除/ }).click();
    const dialog = page.getByRole('alertdialog');
    await expect(dialog).toContainText('30 天后彻底删除');
    await dialog.getByRole('button', { name: '删除' }).click();
    await expect(page.getByText(`需求 ${seq} 已删除`).first()).toBeVisible();
    expect(
      ((await api.get('/api/requests?view=active&filter=all')) as List).items.map((r) => r.seq),
    ).not.toContain(seq);

    await page.goto('/intake?view=deleted');
    await expect(listRow(page, title)).toBeVisible();
    await shot(page, '12-提需求-最近删除');
    await listRow(page, title).click();
    await expect(page).toHaveURL(new RegExp(`[?&]r=${seq}(&|$)`));
    await expect(stream(page).getByText('这条需求已经删了')).toBeVisible();
    await page.getByRole('button', { name: '恢复' }).first().click();
    await expect(page.getByText(`需求 ${seq} 已恢复`).first()).toBeVisible();
    const back = (await api.get(`/api/requests/${seq}`)) as Detail;
    expect(back.request.deletedAt).toBeUndefined();
    expect(
      ((await api.get('/api/requests?view=active&filter=all')) as List).items.map((r) => r.seq),
    ).toContain(seq);
  });

  test('接着这条提：新的一条挂在原条下面，详情里记着接的是哪条', async ({ page, api, stack, shot }, info) => {
    test.skip(!onlyDesktop(info), '改库的用例只在 1920 那一遍跑');
    const original = stack.facts.requests.closed;
    await page.goto(`/intake?r=${original}`);
    await page.getByRole('button', { name: '接着这条提' }).first().click();
    await expect(page).toHaveURL(new RegExp(`from=${original}`));
    await expect(page.getByText(`接着 需求 ${original} 提`).first()).toBeVisible();
    await page.getByRole('textbox', { name: '消息' }).fill('密钥填完能不能顺手测一下通不通？');
    await page.getByRole('button', { name: '发送' }).click();
    await expect(page).toHaveURL(/\/intake\?r=\d+$/);
    const seq = Number(new URL(page.url()).searchParams.get('r'));
    expect(seq).not.toBe(original);
    const d = (await api.get(`/api/requests/${seq}`)) as Detail;
    expect(d.request.continuesSeq).toBe(original);
    const list = (await api.get('/api/requests?view=active&filter=all')) as List;
    expect(list.items.find((r) => r.seq === seq)?.continuesSeq).toBe(original);
    await shot(page, '12-提需求-接着提');
  });
});
