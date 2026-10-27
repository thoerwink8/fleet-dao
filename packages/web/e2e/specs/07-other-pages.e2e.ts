// 第七步：其余页面逐个走一遍（路由、思考档位（路由页的页签）、定时任务、操作记录、发布记录、找不到的页面）。
// 创始人剧本里的「环境视图」：驾驶舱里没有叫这个名字的页面；最接近的是「路由」（每条路现在接得上吗、额度够吗、被禁了吗）
// 和主页顶上的持续状态条，这里把路由页当它测，并在缺陷清单里记一笔。
import { expect, onlyDesktop, test } from '../support/fixtures.ts';

test.describe('其余页面', () => {
  test.beforeEach(async ({ login }) => login());

  test('路由：在用的用途都排了模型，在线的路由写「活」、没探过的写「不知道」，不是空白', async ({
    page,
    shot,
  }) => {
    await page.goto('/routing');
    // 页标题就是这一级的「路由」。差集那一节的标题里也有这两个字，子串会配到两个标题。
    await expect(page.getByRole('heading', { level: 1, name: '路由', exact: true })).toBeVisible();
    // 用途骨架是发布时装进库的：execute / ui / verify / judge。对题不选路，老的环节不列。
    // 对题是用途那一排里只读的一项「对题」，「在对话里做，不选路」在它的悬停说明里（#1914）
    await expect(page.locator('[data-tab-note]', { hasText: '对题' })).toBeVisible();
    await expect(page.locator('[data-tab-note]')).toHaveAttribute('title', '对题：在对话里做，不选路');
    // 用途按钮的名字前面带读屏用的结论（「派得出去：动手」），整段不再是「动手」两个字，按按钮找
    await expect(
      page.getByRole('navigation', { name: '用途' }).getByRole('button', { name: /动手/ }).first(),
    ).toBeVisible();
    await expect(page.getByText('验收').first()).toBeVisible();
    await expect(page.getByText('需求文档')).toHaveCount(0);
    await expect(page.getByText(/派得出去/).first()).toBeVisible();
    // 探通了的 Claude 拼车/独享、Cursor、Grok 在线：至少有「活」的路由
    await expect(page.getByText(/个派得出去/).first()).not.toHaveText(/^0 个派得出去$/);
    await shot(page, '07-路由');
  });

  test('路由：动手里把 Sonnet 5.5 聚焦后按 Alt+上键 → 直接落库；再挪回去', async ({
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
    const handle = sonnet.getByRole('button', { name: '拖动 Sonnet 5.5（动手里的先后）' });
    await handle.focus();
    // 不按 Alt 的方向键不动库；Alt+上键直接保存，不弹窗
    await page.keyboard.press('ArrowUp');
    expect(await executeOrder()).toEqual(before);
    await page.keyboard.press('Alt+ArrowUp');
    await expect(page.getByRole('alertdialog')).toHaveCount(0);
    await shot(page, '07-路由-调先后确认');

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
      .getByRole('button', { name: '拖动 Sonnet 5.5（动手里的先后）' })
      .focus();
    await page.keyboard.press('Alt+ArrowDown');
    await expect.poll(executeOrder).toEqual(before);
  });

  test('渠道状态：目录里的渠道都显示出来，探得久的渠道变「检测中断」，刚探过的不受影响', async ({
    page,
    shot,
  }) => {
    await page.goto('/routing/status');
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
    // 备库里 Claude 订阅两条在用的路本该 30 分钟前再探，晚了 20 分钟还没探（probe_next_at 加 20 分钟）：不拿旧绿灯装没事
    const claude = list.locator('[data-channel="claude-sub"]');
    await expect(claude).toHaveAttribute('data-state', 'interrupted');
    await expect(claude).toContainText('检测中断');
    // Grok 是 4 分钟前探通的：照常亮「在线」（#1366 起不再写「通」）
    const grok = list.locator('[data-channel="xai"]');
    await expect(grok).toHaveAttribute('data-state', 'ok');
    await expect(grok).toHaveAttribute('data-kind', 'live');
    await expect(grok).toContainText('在线');
    // 底部脚注收进 ⓘ（#1903）：点开才看，里面仍要说清绿灯只表示什么
    await page.getByRole('button', { name: '怎么看这些状态' }).click();
    await expect(page.getByText('绿灯只表示本节点最近一轮抽测通过')).toBeVisible();
    await shot(page, '07-渠道状态');
  });

  test('思考档位：每个模型的每条路都列出来，来自库里的路由两层（并进路由页的页签）', async ({
    page,
    shot,
  }) => {
    // 思考档位在路由页的「思考档位」页签（#1914 第 5 轮）
    await page.goto('/routing?tab=efforts');
    await expect(page).toHaveURL(/\/routing\?tab=efforts$/);
    await expect(page.getByRole('heading', { level: 1, name: '路由', exact: true })).toBeVisible();
    await expect(page.getByRole('tab', { name: '思考档位' })).toHaveAttribute('aria-selected', 'true');
    await expect(page.getByText('路由两层里一条路由都没有')).toHaveCount(0);
    await expect(page.getByText(/Opus 5\.5/).first()).toBeVisible();
    await expect(page.getByRole('combobox', { name: /的思考档位$/ }).first()).toBeVisible();
    await shot(page, '07-思考档位');
  });

  test('定时任务：额度读取跑成了、每小时对账上次没查全且已过期，分开显示', async ({ page, shot }) => {
    await page.goto('/schedules');
    await expect(page.getByRole('heading', { level: 1, name: '定时任务' })).toBeVisible();
    // 任务是表里默认收起的行（#1805，#3509 起是表），摘要行里就有名字、上次结果和「过期」
    await expect(page.getByRole('row').filter({ hasText: '额度读取' })).toContainText('跑成了');
    const reconcile = page.getByRole('row').filter({ hasText: '每小时对账' });
    await expect(reconcile).toContainText('没查成：GitHub 接口限流，一个仓都没扫到');
    await expect(reconcile).toContainText('过期');
    await shot(page, '07-定时任务');
  });

  test('操作记录：登录、设账密这些真发生过的动作都在，谁做的写清楚', async ({ page, shot }) => {
    await page.goto('/audit');
    await expect(page.getByRole('heading', { name: '操作记录' })).toBeVisible();
    await expect(page.getByText('登录了驾驶舱').first()).toBeVisible();
    // 动作名翻成白话（lib/audit.ts）：不再露出 credentials.set 这样的代码。
    // 「设了账密登录」是装库那一刻记的，是最老的几条：前面每个用例都登录一次，主线上两个视口走下来早超过一页（50 条），
    // 它在「再看 50 条」后面，所以往前翻到它为止（翻完还没有就是真没记，按钮没了再断言会报错）。
    const setCredentials = page.getByText('设了账密登录').first();
    const older = page.getByRole('button', { name: '再看 50 条' });
    while (!(await setCredentials.isVisible()) && (await older.isVisible())) {
      await older.click();
      await expect(page.getByRole('button', { name: '正在读更早的…' })).toHaveCount(0);
    }
    await expect(setCredentials).toBeVisible();
    await shot(page, '07-操作记录');
  });

  test('发布记录：已发布的提交读不到时明说原因，不是空白，也没有「发布 v」', async ({
    page,
    shot,
    problems,
  }) => {
    problems.allow('/api/france/released-commits');
    problems.allow('status of 5');
    await page.goto('/changelog');
    await expect(page.getByRole('heading', { level: 1, name: '发布记录' })).toBeVisible();
    // 页头说明写着这页是法国已发布的提交
    await expect(page.getByText(/法国已发布的提交/).first()).toBeVisible();
    // 开发环境没有法国的发布历史：要么列出提交，要么明确说没查成
    await expect(page.getByText(/没查成|没读成|发于/).first()).toBeVisible();
    await expect(page.getByRole('button', { name: /发布 v/ })).toHaveCount(0);
    await shot(page, '07-发布记录');
  });

  test('不存在的页面：404 页给回工作台的路', async ({ page }) => {
    await page.goto('/no-such-page');
    await expect(page.getByRole('link', { name: '回工作台' })).toBeVisible();
  });

  test('不占侧栏的页：账单已删（#3533），菜单里没有；模型目录在路由页', async ({ page }) => {
    await page.goto('/');
    const nav = page.getByRole('navigation', { name: '主导航' });
    await expect(nav.getByRole('link', { name: '工作台' })).toBeVisible();
    // 思考档位并进路由页（#1914 第 5 轮），侧栏不再单列
    for (const label of ['模型目录', '账单', '战绩', 'Jev 判断', '思考档位']) {
      await expect(nav.getByRole('link', { name: label })).toHaveCount(0);
    }
    await page.goto('/routing?tab=models');
    await expect(page).toHaveURL(/\/routing\?tab=models$/);
    await expect(page.getByRole('heading', { level: 1, name: '路由', exact: true })).toBeVisible();
    await expect(page.getByRole('tab', { name: '模型目录' })).toHaveAttribute('aria-selected', 'true');
    await expect(page.getByText('这一页还没做')).toHaveCount(0);
    // 账单页没了：地址落到「找不到」页，不再有「还没做」的占位
    await page.goto('/billing');
    await expect(page.getByRole('link', { name: '回工作台' })).toBeVisible();
    await expect(page.getByText('这一页还没做')).toHaveCount(0);
  });

  test('外壳尺寸生效：顶栏 60、侧栏 220（收起 48）；根字号调成 12px 后像素值不变（尺寸写 px，#3697）', async ({
    page,
  }) => {
    await page.goto('/schedules');
    await expect(page.getByRole('heading', { level: 1, name: '定时任务' })).toBeVisible();
    const measure = () =>
      page.locator('main').evaluate((_m) => {
        const top = document.querySelector('header')?.getBoundingClientRect().height; // 顶栏是文档里的第一个 header（页头在正文区里，在它后面）
        const side = document.querySelector('aside')?.getBoundingClientRect().width;
        const scale = Number.parseFloat(getComputedStyle(document.documentElement).fontSize) / 16;
        return { top, side, scale, wide: window.innerWidth >= 1280 };
      });
    // 尺寸写 px（#3697）：顶栏 60，左菜单 ≥1280 默认展开 220、窄一点收成 48 宽的图标条
    const at16 = await measure();
    expect(at16.scale).toBe(1);
    expect(at16.top).toBe(60);
    expect(at16.side).toBe(at16.wide ? 220 : 48);
    // 把根字号调成 12px（创始人浏览器的默认字号）：壳的像素值一个都不许变
    await page.evaluate(() => {
      document.documentElement.style.fontSize = '12px';
    });
    const at12 = await measure();
    expect(at12.scale).toBe(0.75);
    expect(at12.top).toBe(60);
    expect(at12.side).toBe(at16.side);
  });
});
