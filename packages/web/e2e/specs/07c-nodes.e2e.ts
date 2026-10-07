// 看板多机：顶栏环境切换器、切到远程环境看它推来的快照、失联、其余页的说明、法国页并排。
// 后端起的时候带了两把通行证（support/node-keys.ts）：wsl 推过快照；idle 配了钥匙从不推（看板上是「从没收到过」）。
// 快照是用例自己经公开的写口（POST /api/nodes/report，头 X-Fleet-Node-Token）推的：内容取这台后端自己的 /api/home、/api/env，
// 只把环境名换成「演练 WSL」，和真的 WSL 推来的是同一个形状（后端按 shared 的 NodeReportSchema 校验，形状不对会回 400、这里当场红）。
// 失联靠浏览器的钟快进 10 分钟：新不新鲜按「收到快照的时刻」和页面的钟现算（lib/node.ts），不等下一次重拉。
import type { APIRequestContext } from '@playwright/test';
import { expect, test } from '../support/fixtures.ts';
import { NODE_TOKEN_WSL } from '../support/node-keys.ts';

const WSL = '演练 WSL';
/** 上次推成的时刻：同一个环境 20 秒内只收一次，快照 3 分钟内算新鲜，所以 2 分半以内不重推。 */
let pushedAt = 0;

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
        pushedAt = Date.now();
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

  test('切到远程：主页渲染它的快照，顶上写「报的，只读」；单子链接是 GitHub 链接，去答置灰；铃铛不露出来', async ({
    page,
    shot,
  }) => {
    await page.goto('/?node=wsl');
    await expect(page.getByRole('heading', { name: new RegExp(`主页 · ${WSL}`) })).toBeVisible();
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
    // 要你拍的：去答不是链接、置灰
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
    await page.clock.install({ time: new Date() });
    await page.goto('/?node=wsl');
    const banner = page.locator('[data-snapshot-banner]');
    await expect(banner).toHaveAttribute('data-snapshot-banner', 'fresh');
    await page.clock.fastForward('10:00');
    await expect(banner).toHaveAttribute('data-snapshot-banner', 'stale');
    await expect(banner).toContainText(/失联 1[01] 分钟/);
    await expect(banner).toContainText('不是现在的');
    const trigger = page.locator('[data-env-switcher]');
    await expect(trigger).toContainText('失联');
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
    await page.goto('/env');
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
): Promise<{ status: number; retryAfter: number; text: string }> {
  const res = await req.post(url, { headers: { 'X-Fleet-Node-Token': NODE_TOKEN_WSL }, data: body });
  return {
    status: res.status(),
    retryAfter: Number(res.headers()['retry-after'] ?? 20),
    text: (await res.text()).slice(0, 300),
  };
}
