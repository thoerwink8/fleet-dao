// 看板多机：顶栏环境切换器、切到远程环境看它推来的快照、失联、其余页的说明、法国页并排。
// 后端起的时候带了两把通行证（support/node-keys.ts）：wsl 推过快照；idle 配了钥匙从不推（看板上是「从没收到过」）。
// 快照是用例自己经公开的写口（POST /api/nodes/report，头 X-Fleet-Node-Token）推的：内容取这台后端自己的 /api/home、/api/env，
// 只把环境名换成「演练 WSL」，和真的 WSL 推来的是同一个形状（后端按 shared 的 NodeReportSchema 校验，形状不对会回 400、这里当场红）。
// 失联靠把浏览器的钟拨到收到快照之后 10 分钟：新不新鲜按「收到快照的时刻」和页面的钟现算（lib/node.ts），不等下一次重拉。
import type { APIRequestContext, Page } from '@playwright/test';
import { expect, test } from '../support/fixtures.ts';
import { NODE_TOKEN_WSL } from '../support/node-keys.ts';

const WSL = '演练 WSL';

type HeaderGeometry = {
  vw: number;
  titleLines: number;
  titleNeed: number;
  titleHave: number;
  titleFont: number;
  overflowDoc: number;
  overflowMain: number;
  overlap: boolean;
  sameRow: boolean;
  actionsPastMain: boolean;
  hitHealth: boolean;
  hitRefresh: boolean;
  hitFlow: boolean;
  titleText: string;
};

type DetailGeometry = {
  items: { text: string; font: number; overlaps: boolean; inside: boolean }[];
};

// 字符串送进浏览器：函数里的类型注解会被原样带过去，浏览器解析不了。
const HEADER_JS = `(() => {
  const h1 = document.querySelector('[data-page-titlebar] h1');
  const titlebar = document.querySelector('[data-page-titlebar]');
  const actions = document.querySelector('[data-page-actions]');
  const main = document.querySelector('main');
  if (!(h1 instanceof HTMLElement) || !(titlebar instanceof HTMLElement) || !(actions instanceof HTMLElement) || !(main instanceof HTMLElement)) {
    return null;
  }
  const cs = getComputedStyle(h1);
  const lh = parseFloat(cs.lineHeight);
  const titleBox = h1.getBoundingClientRect();
  const probe = h1.cloneNode(true);
  if (!(probe instanceof HTMLElement)) return null;
  probe.style.position = 'absolute';
  probe.style.left = '0';
  probe.style.top = '0';
  probe.style.visibility = 'hidden';
  probe.style.whiteSpace = 'nowrap';
  probe.style.width = 'max-content';
  probe.style.maxWidth = 'none';
  document.body.appendChild(probe);
  const titleNeed = probe.getBoundingClientRect().width;
  probe.remove();
  const tb = titlebar.getBoundingClientRect();
  const ab = actions.getBoundingClientRect();
  const mb = main.getBoundingClientRect();
  const hit = (el) => {
    if (!(el instanceof Element)) return false;
    const r = el.getBoundingClientRect();
    if (r.width < 1 || r.height < 1) return false;
    const top = document.elementFromPoint(Math.min(r.left + r.width / 2, window.innerWidth - 1), r.top + r.height / 2);
    return top !== null && (el === top || el.contains(top));
  };
  const flowButtons = [...document.querySelectorAll('[data-flow-mode-switch] button')];
  return {
    vw: window.innerWidth,
    titleLines: lh > 0 ? Math.round(titleBox.height / lh) : -1,
    titleNeed,
    titleHave: tb.width,
    titleFont: parseFloat(cs.fontSize),
    overflowDoc: document.documentElement.scrollWidth - window.innerWidth,
    overflowMain: main.scrollWidth - main.clientWidth,
    overlap:
      Math.min(tb.right, ab.right) - Math.max(tb.left, ab.left) > 1 &&
      Math.min(tb.bottom, ab.bottom) - Math.max(tb.top, ab.top) > 1,
    sameRow: tb.top < ab.bottom - 1 && ab.top < tb.bottom - 1 && tb.left < ab.left,
    actionsPastMain: ab.right > mb.right + 1 || ab.left < mb.left - 1,
    hitHealth: hit(document.querySelector('[data-health-strip]')),
    hitRefresh: hit(document.querySelector('[data-refresh-bar] button')),
    hitFlow: flowButtons.length > 0 && flowButtons.every((el) => hit(el)),
    titleText: h1.textContent ?? '',
  };
})()`;

const DETAIL_JS = `(() => {
  const h1 = document.querySelector('[data-page-titlebar] h1');
  const hr = h1 instanceof HTMLElement ? h1.getBoundingClientRect() : null;
  const vw = window.innerWidth;
  const vh = window.innerHeight;
  const items = [...document.querySelectorAll('[data-health-detail]')].flatMap((el) => {
    if (!(el instanceof HTMLElement)) return [];
    const r = el.getBoundingClientRect();
    if (r.width < 1 || r.height < 1) return [];
    return [{
      text: el.textContent ?? '',
      font: parseFloat(getComputedStyle(el).fontSize),
      overlaps: hr !== null &&
        Math.min(hr.right, r.right) - Math.max(hr.left, r.left) > 1 &&
        Math.min(hr.bottom, r.bottom) - Math.max(hr.top, r.top) > 1,
      inside: r.left >= -1 && r.right <= vw + 1 && r.top >= -1 && r.bottom <= vh + 1,
    }];
  });
  return { items };
})()`;

/** 远程首页页头：短标题一行放完，长状态说明还在版面上、不盖住标题、不把页面撑出横向滚动。 */
async function remoteHeaderLayout(page: Page): Promise<HeaderGeometry> {
  const g = await page.evaluate(HEADER_JS);
  if (!g) throw new Error('页头量不到');
  return g as HeaderGeometry;
}
/** 上次推成的时刻（客户端）：同一个环境 20 秒内只收一次，快照 3 分钟内算新鲜，所以 2 分半以内不重推。 */
let pushedAt = 0;
/**
 * 服务端收下那份快照的时刻（响应里的 receivedAt，和页面上用来算新鲜度的是同一个）。
 * 失联用例把浏览器的 Date 钉在这上面，再拨正好 10 分钟，横幅才稳定是「失联 10 分钟」。
 */
let receivedAtMs = Number.NaN;

test.describe('看板多机', () => {
  test.beforeEach(async ({ login, api, stack, context }) => {
    await login();
    if (Date.now() - pushedAt < 150_000) return;
    const home = await api.get('/api/home');
    const env = (await api.get('/api/env')) as { name: Record<string, unknown> };
    const body = {
      schemaVersion: 1,
      reportedAt: new Date().toISOString(),
      home,
      env: { ...env, name: { ...env.name, name: WSL } },
    };
    for (let attempt = 0; attempt < 3; attempt++) {
      const res = await postReport(context.request, `${stack.webOrigin}/api/nodes/report`, body);
      if (res.status === 200) {
        if (!Number.isFinite(res.receivedAt)) throw new Error(`推快照没带回 receivedAt：${res.text}`);
        pushedAt = Date.now();
        receivedAtMs = res.receivedAt;
        return;
      }
      // 别的视口那一遍刚推过：按它说的等一会儿再推
      if (res.status === 429) {
        await new Promise((r) => setTimeout(r, (res.retryAfter + 1) * 1000));
        continue;
      }
      throw new Error(`推快照没成：HTTP ${res.status} ${res.text}`);
    }
    throw new Error('推快照连着 3 次被限频');
  });

  test('顶栏切换器：默认是本台；下拉里有本台、演练 WSL（刚报的）、idle（从没收到过）；选 WSL 记进网址', async ({
    page,
    shot,
  }) => {
    await page.goto('/');
    const trigger = page.locator('[data-env-switcher]');
    await expect(trigger).toContainText('本机');
    await trigger.click();
    const wsl = page.locator('[data-node-item="wsl"]');
    await expect(wsl).toContainText(WSL);
    await expect(wsl).toHaveAttribute('data-node-state', 'fresh');
    await expect(page.locator('[data-node-item="idle"]')).toHaveAttribute('data-node-state', 'never');
    await shot(page, '07c-切换器下拉');
    await wsl.click();
    await expect(page).toHaveURL(/\/\?node=wsl$/);
    await expect(trigger).toContainText(WSL);
    // 回本台：参数去掉。再点开之前先等上一个下拉整个退场：选完一项菜单就算「关了」，但退场动画（约 150 毫秒）这段
    // 内容还挂在页面上、Radix 的外点关闭监听也还在；这时点触发钮，会被当成「点在菜单外」又立刻关上，
    // 下拉再也不出来（#1127：快的那一遍必红，慢一点就绿）。
    await expect(page.locator('[data-slot="dropdown-menu-content"]')).toHaveCount(0);
    await trigger.click();
    await page.locator('[data-node-item="local"]').click();
    await expect(page).toHaveURL(/\/$/);
    await expect(trigger).toContainText('本机');
  });

  test('切到远程：主页三块只读——要你拍的去答置灰，在跑的没有站内链接，上线记录写只在本台看', async ({
    page,
  }) => {
    await page.goto('/?node=wsl');
    await expect(page.getByRole('heading', { name: new RegExp(`主页 · ${WSL}`) })).toBeVisible();
    await expect(page.locator('[data-snapshot-banner]')).toContainText('报的，只读');
    await expect(page.locator('[data-home-block="run"]')).toBeVisible();
    await expect(page.locator('[data-home-block="shipped"]')).toContainText('上线记录只在本台看');
    expect(await page.locator('main a[href^="/tasks/"]').count()).toBe(0);
    expect(await page.locator('main a[href^="/notifications"]').count()).toBe(0);
    for (const b of await page.locator('[data-remote-disabled]').all()) await expect(b).toBeDisabled();
  });

  test('切到远程：画布渲染它的快照，顶上写「报的，只读」；单子链接是 GitHub 链接，去答置灰；铃铛不露出来', async ({
    page,
    shot,
  }) => {
    await page.goto('/board?node=wsl');
    await expect(page.getByRole('heading', { name: new RegExp(`画布 · ${WSL}`) })).toBeVisible();
    const banner = page.locator('[data-snapshot-banner]');
    await expect(banner).toHaveAttribute('data-snapshot-banner', 'fresh');
    await expect(banner).toContainText(`${WSL}`);
    await expect(banner).toContainText('报的，只读');
    // 在跑的单子：整张卡片是指向 GitHub 的链接，不是站内详情。
    // 1366 宽收进视野是远景（只剩单号、没有链接），先切到中景（同 02-home 的 midZoom）。
    await expect(page.locator('.react-flow__node[data-id^="ticket:"]').first()).toBeVisible();
    await page.getByRole('button', { name: /^中景/ }).click();
    await expect(page.locator('[data-running-card] a').first()).toHaveAttribute(
      'href',
      /^https:\/\/github\.com\//,
    );
    expect(await page.locator('main a[href^="/tasks/"]').count()).toBe(0);
    expect(await page.locator('main a[href^="/notifications"]').count()).toBe(0);
    // 要你拍的在右上角抽屉里（≥1920 本来就开着，更窄要点开；已经开着的再点就收起了）：去答不是链接、置灰
    if (!(await page.locator('[data-home-drawer]').count())) {
      await page.getByRole('button', { name: /^要你拍的 \d+ 条/ }).click();
    }
    expect(await page.locator('[data-decision-card] a').count()).toBe(0);
    for (const b of await page.locator('[data-remote-disabled]').all()) await expect(b).toBeDisabled();
    // 提醒铃铛是本台（法国）的数据：看远程环境时不露出来
    await expect(page.getByRole('button', { name: /^提醒/ })).toHaveCount(0);
    await shot(page, '07c-远程主页');
  });

  test('失联：浏览器的钟快进 10 分钟，横幅写「失联 10 分钟」、说不是现在的，顶栏标「失联」，下拉里那一项变灰', async ({
    page,
    shot,
  }) => {
    // 新鲜度按「收到快照的时刻」和页面的钟现算（useNow 每秒读一次 Date），不等下一次重拉。
    // 钟钉死在服务端的 receivedAt 上，再拨正好 10 分钟：横幅按整分钟向下取，多出来的零头仍写「10 分钟」。
    // setFixedTime 只钉 Date，定时器仍按真实时间走，不会把到期的定时器放掉。
    // 以前 fastForward('10:00') 会把这 10 分钟里到期的定时器放一次，包括每个请求上 90 秒的超时（src/api/http.ts）：
    // 横幅已经新鲜时环境列表往往还在飞，被掐掉的请求页面当成超时（ERR_ABORTED）。冷的首跑在飞的多、热的重试已经回来了，所以偶发。
    // 快进还会把「进页面已经过去的时间」再加 10 分钟，慢的首跑横幅写成 11、12 分钟。
    // 横幅读的是这一份快照，顶栏读的是环境列表。拨之前先等顶栏写成「只读」，两边都到了再拨。
    if (!Number.isFinite(receivedAtMs)) throw new Error('没有收到时刻，没法对钟');
    const at = receivedAtMs;
    const trigger = page.locator('[data-env-switcher]');
    await page.clock.setFixedTime(new Date(at));
    await page.goto('/?node=wsl');
    const banner = page.locator('[data-snapshot-banner]');
    await expect(banner).toHaveAttribute('data-snapshot-banner', 'fresh');
    await expect(trigger).toContainText('只读');
    await page.clock.setFixedTime(new Date(at + 10 * 60_000));
    await expect(banner).toHaveAttribute('data-snapshot-banner', 'stale');
    await expect(banner).toContainText('失联 10 分钟');
    await expect(banner).toContainText('不是现在的');
    await expect(trigger).toContainText('失联');
    // 长健康说明和远程标题挤在同一行时，标题列至少留得下一整行，说明收进「状态」或截在自己的格子里，不改失联文案。
    const g = await remoteHeaderLayout(page);
    expect(g.titleText, `${g.vw} 标题`).toContain(`主页 · ${WSL}`);
    expect(
      g.titleLines,
      `${g.vw} 标题行数（列宽 ${Math.round(g.titleHave)}，一行要 ${Math.round(g.titleNeed)}）`,
    ).toBe(1);
    expect(g.titleHave + 1, `${g.vw} 标题列比一行字窄`).toBeGreaterThanOrEqual(g.titleNeed);
    expect(g.titleFont, `${g.vw} 标题字号被缩小`).toBeGreaterThanOrEqual(20);
    expect(g.overflowDoc, `${g.vw} 整页横滚`).toBeLessThanOrEqual(1);
    expect(g.overflowMain, `${g.vw} 正文横滚`).toBeLessThanOrEqual(1);
    expect(g.overlap, `${g.vw} 标题和操作区重叠`).toBe(false);
    expect(g.sameRow, `${g.vw} 标题和操作区不在同一行`).toBe(true);
    expect(g.actionsPastMain, `${g.vw} 操作区超出正文`).toBe(false);
    expect(g.hitHealth, `${g.vw} 状态点不着`).toBe(true);
    expect(g.hitRefresh, `${g.vw} 刷新点不着`).toBe(true);
    expect(g.hitFlow, `${g.vw} 流程开关点不着`).toBe(true);
    let details = (await page.evaluate(DETAIL_JS)) as DetailGeometry;
    let openedMenu = false;
    if (details.items.length === 0) {
      await page.locator('[data-health-menu]').click();
      await expect(page.locator('[data-health-detail]').first()).toBeVisible();
      details = (await page.evaluate(DETAIL_JS)) as DetailGeometry;
      openedMenu = true;
    }
    const longest = details.items.reduce((m, item) => Math.max(m, item.text.length), 0);
    expect(longest, `${g.vw} 长状态消息还在`).toBeGreaterThanOrEqual(16);
    for (const item of details.items) {
      expect(item.font, `${g.vw} 状态说明字号「${item.text}」`).toBeGreaterThanOrEqual(14);
      expect(item.overlaps, `${g.vw} 状态说明盖住标题「${item.text}」`).toBe(false);
      expect(item.inside, `${g.vw} 状态说明超出屏幕「${item.text}」`).toBe(true);
    }
    if (openedMenu) {
      await page.keyboard.press('Escape');
      await expect(page.locator('[data-slot="popover-content"]')).toHaveCount(0);
    }
    await trigger.click();
    await expect(page.locator('[data-node-item="wsl"]')).toHaveAttribute('data-node-state', 'stale');
    await shot(page, '07c-失联');
  });

  test('配了钥匙却从没收到过快照的环境（404）：写「没有这个环境」和回主页，不画空数据、不给重试', async ({
    page,
    problems,
  }) => {
    problems.allow('/api/nodes/idle');
    await page.goto('/?node=idle');
    const alert = page.getByRole('alert').first();
    await expect(alert).toContainText('没有这个环境');
    await expect(alert.getByRole('link', { name: '回主页' })).toBeVisible();
    await expect(page.getByRole('button', { name: '重试' })).toHaveCount(0);
    await expect(page.locator('[data-snapshot-banner]')).toHaveCount(0);
  });

  test('其余页（额度）选了远程环境：整页说明只看得到本台，页面本体不显示；点「切回本机」回到本台的额度页', async ({
    page,
    shot,
  }) => {
    await page.goto('/quota?node=wsl');
    const notice = page.locator('[data-only-local]');
    await expect(notice).toContainText('这一页只看得到本机的数据');
    await expect(notice).toContainText(WSL);
    await expect(page.getByRole('heading', { name: '额度' })).toHaveCount(0);
    await shot(page, '07c-其余页说明');
    await notice.getByRole('button', { name: /切回本机/ }).click();
    await expect(page).toHaveURL(/\/quota$/);
    await expect(page.getByRole('heading', { name: '额度' })).toBeVisible();
    await expect(page.locator('[data-only-local]')).toHaveCount(0);
  });

  test('法国页：本台、演练 WSL、idle 三列并排；WSL 那列写上报于，idle 那列写从没收到过', async ({
    page,
    shot,
  }) => {
    await page.goto('/france');
    await expect(page).toHaveURL(/\/france$/);
    const cols = page.locator('[data-env-column]');
    await expect(cols).toHaveCount(3);
    expect(await cols.evaluateAll((els) => els.map((e) => e.getAttribute('data-env-column')))).toEqual([
      'local',
      'idle',
      'wsl',
    ]);
    const wsl = page.locator('[data-env-column="wsl"]');
    await expect(wsl.getByRole('heading', { name: new RegExp(WSL) })).toBeVisible();
    await expect(wsl.locator('[data-env-age]')).toContainText('上报于');
    await expect(wsl).toHaveAttribute('data-env-column-state', 'ok');
    for (const label of ['引擎', '在用版本', '在跑的会话', '池占用', '健康', '最近拉单']) {
      await expect(wsl.getByText(label).first()).toBeVisible();
    }
    await expect(page.locator('[data-env-column="idle"] [data-env-never]')).toContainText('从没收到过');
    await shot(page, '07c-环境页并排');
  });
});

/** 推一份快照：不带 Cookie 的意思是只认通行证头；这里的请求上下文带着登录 Cookie 也无妨（写口不认它）。 */
async function postReport(
  req: APIRequestContext,
  url: string,
  body: unknown,
): Promise<{ status: number; retryAfter: number; text: string; receivedAt: number }> {
  const res = await req.post(url, { headers: { 'X-Fleet-Node-Token': NODE_TOKEN_WSL }, data: body });
  const text = await res.text();
  let receivedAt = Number.NaN;
  if (res.status() === 200) {
    try {
      const parsed = JSON.parse(text) as { receivedAt?: unknown };
      receivedAt = typeof parsed.receivedAt === 'string' ? Date.parse(parsed.receivedAt) : Number.NaN;
    } catch {
      receivedAt = Number.NaN;
    }
  }
  return {
    status: res.status(),
    retryAfter: Number(res.headers()['retry-after'] ?? 20),
    text: text.slice(0, 300),
    receivedAt,
  };
}
