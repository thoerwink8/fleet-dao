// 第七步：其余页面逐个走一遍（路由、思考档位、定时任务、操作记录、更新日志、演示版、找不到的页面）。
// 创始人剧本里的「环境视图」：驾驶舱里没有叫这个名字的页面；最接近的是「路由」（每条路现在接得上吗、额度够吗、被禁了吗）
// 和主页顶上的持续状态条，这里把路由页当它测，并在缺陷清单里记一笔。
import { expect, onlyDesktop, test } from '../support/fixtures.ts';

test.describe('其余页面', () => {
  test.beforeEach(async ({ login }) => login());

  test('路由：九个用途都排了模型，在线的路由写「活」、没探过的写「不知道」，不是空白', async ({
    page,
    shot,
  }) => {
    await page.goto('/routing');
    await expect(page.getByRole('heading', { name: '路由' })).toBeVisible();
    // 用途骨架是发布时装进库的：default / execute / verify / ui / judge 都在
    await expect(page.getByText('需求文档').first()).toBeVisible();
    await expect(page.getByText('写码').first()).toBeVisible();
    await expect(page.getByText(/派得出去/).first()).toBeVisible();
    // 探通了的 Claude 拼车/独享、Cursor、Grok 在线：至少有「活」的路由
    await expect(page.getByText(/个派得出去/).first()).not.toHaveText(/^0 个派得出去$/);
    await shot(page, '07-路由');
  });

  test('路由：写码里把 Sonnet 5.5 上移 → 确认 → 落库、进操作记录、刷新后还是新顺序；再下移放回去', async ({
    page,
    api,
    shot,
  }, info) => {
    test.skip(!onlyDesktop(info), '改库的用例只在 1920 那一遍跑');
    type Layers = { purposes: { purpose: string; models: { modelId: string }[] }[] };
    const executeOrder = async () =>
      ((await api.get('/api/routing/layers')) as Layers).purposes
        .find((p) => p.purpose === 'execute')
        ?.models.map((m) => m.modelId);
    // 骨架（routing.default.json）里写码的顺序：Grok → Sonnet → Opus …
    const before = await executeOrder();
    expect(before?.slice(0, 2)).toEqual(['grok-4.7', 'sonnet-5.5']);

    await page.goto('/routing?purpose=execute');
    const sonnet = page.locator('li[data-model="sonnet-5.5"]');
    await expect(sonnet).toBeVisible();
    await sonnet.getByRole('button', { name: /写码里的先后） 上移$/ }).click();
    // 二次确认：写清从什么顺序变成什么顺序，确认前库里没动
    const dialog = page.getByRole('alertdialog');
    await expect(dialog).toContainText('把「Sonnet 5.5」在「写码」里上移一位？');
    expect(await executeOrder()).toEqual(before);
    await shot(page, '07-路由-调先后确认');
    await dialog.getByRole('button', { name: '上移' }).click();
    await expect(dialog).toHaveCount(0);

    // 页面按新顺序重排：Sonnet 在最前
    await expect(page.locator('li[data-model]').first()).toHaveAttribute('data-model', 'sonnet-5.5');
    // 读回来：落库了，进了操作记录（对象是写码用途）
    await expect.poll(executeOrder).toEqual(['sonnet-5.5', 'grok-4.7', ...(before ?? []).slice(2)]);
    const audit = (await api.get('/api/audit?limit=50')) as {
      items: { action: string; target: string; actor: { kind: string } }[];
    };
    expect(audit.items.some((a) => a.action === 'routing.order.move' && a.target === 'stage:execute')).toBe(
      true,
    );
    // 刷新后还是新顺序
    await page.reload();
    await expect(page.locator('li[data-model]').first()).toHaveAttribute('data-model', 'sonnet-5.5');
    await shot(page, '07-路由-调先后后');

    // 放回去（别的用例读的是骨架的顺序）
    await page
      .locator('li[data-model="sonnet-5.5"]')
      .getByRole('button', { name: /写码里的先后） 下移$/ })
      .click();
    await page.getByRole('alertdialog').getByRole('button', { name: '下移' }).click();
    await expect.poll(executeOrder).toEqual(before);
  });

  test('渠道状态：目录里的渠道都显示出来，探得久的渠道变「检测中断」，刚探过的不受影响', async ({
    page,
    shot,
  }) => {
    await page.goto('/routing');
    await expect(page.getByRole('heading', { name: '渠道状态' })).toBeVisible();
    const list = page.getByRole('list', { name: '渠道状态' });
    // 目录样例里的 5 个渠道一个不少，写的是目录里公开的名字
    for (const name of [
      'Claude 订阅',
      'Mirasim 中转',
      'Cursor 订阅',
      'Grok 订阅（Grok Build）',
      'Jev 判断题',
    ]) {
      await expect(list.getByText(name, { exact: true })).toBeVisible();
    }
    await expect(list.getByRole('listitem')).toHaveCount(5);
    // 备库里 Claude 订阅两条在用的路是半小时前探的：超过 15 分钟 + 3 分钟，不拿旧绿灯装没事
    const claude = list.locator('[data-channel="claude-sub"]');
    await expect(claude).toHaveAttribute('data-state', 'interrupted');
    await expect(claude).toContainText('检测中断');
    // Grok 是 4 分钟前探通的：照常亮「通」
    const grok = list.locator('[data-channel="xai"]');
    await expect(grok).toHaveAttribute('data-state', 'ok');
    await expect(grok).toContainText('通');
    await expect(page.getByText('绿灯只表示本节点最近一轮抽测通过')).toBeVisible();
    await shot(page, '07-渠道状态');
  });

  test('思考档位：每个模型的每条路都列出来，来自库里的路由两层', async ({ page, shot }) => {
    await page.goto('/efforts');
    await expect(page.getByRole('heading', { name: '思考档位' })).toBeVisible();
    await expect(page.getByText('路由两层里一条路由都没有')).toHaveCount(0);
    await expect(page.getByText(/Opus 5\.5/).first()).toBeVisible();
    await shot(page, '07-思考档位');
  });

  test('定时任务：额度读取跑成了、每小时对账上次没查全且已过期，分开显示', async ({ page, shot }) => {
    await page.goto('/schedules');
    await expect(page.getByRole('heading', { name: '定时任务' })).toBeVisible();
    await expect(page.getByRole('row', { name: /额度读取/ })).toContainText('跑成了');
    const reconcile = page.getByRole('row', { name: /每小时对账/ });
    await expect(reconcile).toContainText('没查成：GitHub 接口限流，一个仓都没扫到');
    await expect(reconcile).toContainText('过期');
    await shot(page, '07-定时任务');
  });

  test('操作记录：登录、设账密这些真发生过的动作都在，谁做的写清楚', async ({ page, shot }) => {
    await page.goto('/audit');
    await expect(page.getByRole('heading', { name: '操作记录' })).toBeVisible();
    await expect(page.getByText('登录了驾驶舱').first()).toBeVisible();
    // 动作名翻成白话（lib/audit.ts）：不再露出 credentials.set 这样的代码。
    // 「设了账密登录」是装库那一刻记的，是最老的几条：前面每个用例都登录一次，主线上两个视口走下来早超过一页（100 条），
    // 它在「看更早的记录」后面，所以往前翻到它为止（翻完还没有就是真没记，按钮没了再断言会报错）。
    const setCredentials = page.getByText('设了账密登录').first();
    const older = page.getByRole('button', { name: '看更早的记录' });
    while (!(await setCredentials.isVisible()) && (await older.isVisible())) {
      await older.click();
      await expect(page.getByRole('button', { name: '正在读更早的…' })).toHaveCount(0);
    }
    await expect(setCredentials).toBeVisible();
    await shot(page, '07-操作记录');
  });

  test('更新日志：读不到版本信息时明说原因，不是空白', async ({ page, shot, problems }) => {
    problems.allow('/api/release/version');
    problems.allow('status of 5');
    await page.goto('/changelog');
    await expect(page.getByRole('heading', { name: '更新日志' })).toBeVisible();
    // 开发环境没有 GitHub 凭据：要么显示版本，要么明确说读不到
    await expect(page.getByText(/还没发版|已发|读不到|没读到|没读成|读不了/).first()).toBeVisible();
    await shot(page, '07-更新日志');
  });

  test('演示版：没配演示目录时明说，不假装「没有链接」', async ({ page, shot, problems }) => {
    problems.allow('/api/demo/');
    problems.allow('status of 5');
    problems.allow('status of 4');
    await page.goto('/demo-links');
    await expect(page.getByRole('heading', { name: '演示版' })).toBeVisible();
    await expect(page.getByText(/没配|没接|读不到|没读成|发不了/).first()).toBeVisible();
    await shot(page, '07-演示版');
  });

  test('不存在的页面：404 页给回主页的路', async ({ page }) => {
    await page.goto('/no-such-page');
    await expect(page.getByRole('link', { name: /主页/ }).first()).toBeVisible();
  });
});
