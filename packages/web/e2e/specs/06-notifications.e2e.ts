// 第六步：提醒页（通知中心）。要你拍的、卡住报警、日报；「处理了」要落库、进操作记录；没有追问入口（#939）。
// 看门狗修复（#3034）：真后端算 repair 要 Temporal 和看门狗现场，e2e 这一套没有，所以修复那几条在浏览器网络层改写：
// 列表照真后端读、只把「任务 12 卡住了」改成看门狗的键并挂上场景给的 repair（前端照契约校验形状），点修复的 POST 由场景回话，不碰真库。
import type { BrowserContext, Page, Request } from '@playwright/test';
import { expect, onlyDesktop, type PageProblems, test } from '../support/fixtures.ts';

type Audit = { items: { action: string; target: string; after?: unknown }[] };
type NotificationsRes = { items: { id: string; title: string; resolvedAt?: string }[] };

test.describe('通知中心', () => {
  test.beforeEach(async ({ login }) => login());

  test('库里的提醒按级别分开数：要你拍 2、卡住报警 2、日报 1；未处理的在前', async ({ page, shot }) => {
    await page.goto('/notifications');
    await expect(page.getByRole('heading', { name: '通知中心' })).toBeVisible();
    await expect(page.getByRole('tab', { name: /^全部 5$/ })).toBeVisible();
    await expect(page.getByRole('tab', { name: /^要你拍 2$/ })).toBeVisible();
    await expect(page.getByRole('tab', { name: /^卡住报警 2$/ })).toBeVisible();
    await expect(page.getByRole('tab', { name: /^日报 1$/ })).toBeVisible();
    await expect(page.getByText('任务 12 卡住了')).toBeVisible();
    await expect(page.getByText('额度读数 35 分钟没更新')).toBeVisible();
    // 「谁在处理」：库里没有认领的，明说没人在修，不留空（列表行尾一个状态，点开后详情里再写一遍）
    await expect(page.getByText('没人在修').first()).toBeVisible();
    await shot(page, '06-通知中心');
  });

  test('按级别筛选：点「卡住报警」只剩那两条', async ({ page }) => {
    await page.goto('/notifications');
    await page.getByRole('tab', { name: /^卡住报警 2$/ }).click();
    await expect(page.getByText('任务 12 卡住了')).toBeVisible();
    await expect(page.getByText('等你回答：新模板的落款用谁的名字？')).toHaveCount(0);
  });

  test('整页没有追问入口：没有「回答」按钮、没有旧追问区块', async ({ page, shot }) => {
    await page.goto('/notifications');
    await expect(page.getByRole('heading', { name: '通知中心' })).toBeVisible();
    await expect(page.getByRole('button', { name: /^回答/ })).toHaveCount(0);
    await expect(page.locator('[data-legacy-asks]')).toHaveCount(0);
    await shot(page, '06-没有追问入口');
  });

  test('点「处理了」：这条从待处理里消失、「全部」里留着并写明谁处理的；落库、进操作记录', async ({
    page,
    api,
    stack,
  }, info) => {
    test.skip(!onlyDesktop(info), '改库的用例只在 1920 那一遍跑');
    await page.goto('/notifications');
    // 左列表右详情（#3533）：先点开那一条，「处理了」在右边详情里
    await page
      .locator('li[data-notice-row]')
      .filter({ hasText: '额度读数 35 分钟没更新' })
      .getByRole('button')
      .click();
    await page.getByRole('region', { name: '通知详情' }).getByRole('button', { name: '处理了' }).click();
    await expect(page.getByText('处理了', { exact: true }).first()).toBeVisible();
    await expect(page.getByText('额度读数 35 分钟没更新')).toHaveCount(0);

    const open = (await api.get('/api/notifications?status=open')) as NotificationsRes;
    expect(open.items.some((n) => n.title === '额度读数 35 分钟没更新')).toBe(false);
    const all = (await api.get('/api/notifications?status=all')) as NotificationsRes;
    expect(all.items.find((n) => n.title === '额度读数 35 分钟没更新')?.resolvedAt).toBeTruthy();
    const audit = (await api.get('/api/audit?limit=50')) as Audit;
    expect(audit.items.some((a) => a.action === 'notification.resolve')).toBe(true);

    await page.getByRole('button', { name: '连已处理的一起看' }).click();
    await expect(page.getByText(/我处理于/).first()).toBeVisible();
    // 处理一个不存在的：后端回 404 明确的话
    const gone = await api.send(
      'POST',
      `/api/notifications/00000000-0000-4000-8000-00000000dead/resolve`,
      {},
    );
    expect(gone.status).toBe(404);
    void stack;
  });
});

// —— 看门狗修复（#3034）——
const STALLED = '任务 12 卡住了';
const INCIDENT = 'e2e-incident-1';
type Body = { actionId: string; incident: string; requestId: string; optionId?: string; text?: string };
type Rec = Record<string, unknown> & { requestId: string; state: string };
const RECOVER = {
  id: 'task-recover:e2e1',
  kind: 'task-recover',
  label: '叫醒任务继续',
  detail: '给任务 #12 的当前工作流发「继续」和路由叫醒（同任务页的继续）；任务行动起来才算修好',
  target: { taskId: 'task-12', issueNumber: 12, workflowId: 'task-12', workflowRunId: 'run-e2e' },
};
const HAND = {
  id: 'hand-to-repair:e2e1',
  kind: 'hand-to-repair',
  label: '交给修复',
  detail: '在 fleet-dao 开一张四节修复单，立刻调用 dispatch-issue 准入派工；同一次事故只开一张',
  target: { repo: { owner: 'acme', name: 'fleet-dao' } },
};
const RESTORE = {
  id: 'release-restore:e2e1',
  kind: 'release-restore',
  label: '恢复引擎开关',
  detail: '把引擎总开关恢复成发版前的样子：写恢复请求，法国上的单元接活',
  target: { sha: 'abcdef1234567890', releaseStartedAt: '2026-10-18T08:00:00.000Z' },
  choice: {
    allowText: true,
    options: [
      {
        id: 'do',
        label: '执行：恢复引擎开关',
        detail: '写恢复请求',
        recommended: '提醒的条件已核实，这是现有的恢复入口',
      },
      { id: 'hold', label: '先不动', detail: '什么都不做，提醒留着', keepsOpen: true },
    ],
  },
};
const record = (body: Body, state: string, text: string, kind = 'task-recover'): Rec => ({
  incident: body.incident,
  actionId: body.actionId,
  kind,
  requestId: body.requestId,
  state,
  text,
  at: new Date().toISOString(),
  by: 'founder',
  target: RECOVER.target,
});

/** 一个场景：列表上这条现在的 repair（actions、last），点了怎么回。整个浏览器上下文共用，两页看的是同一份「后端」。 */
interface Scene {
  actions: unknown[];
  problems: string[];
  last?: Rec;
  /** 这次事故明确关联的单（#3100 的 repair.linked）。 */
  linked?: Record<string, unknown>;
  /** 换掉真后端给的「谁在处理」（造线上那种过时的「没人在修」）。 */
  handling?: Record<string, unknown>;
  /** 不填就是本文件的固定事故；重开时改它，列表重读才换代。 */
  incident?: string;
  bodies: Body[];
  exec: (body: Body) => Promise<{ status: number; json: unknown } | 'timeout'>;
}

async function stage(
  context: BrowserContext,
  problems: PageProblems,
  scene: Scene,
  viewForRequest?: (request: Request) => Scene,
): Promise<void> {
  // 有意造的 409 和断线：只放过修复那一条请求的
  for (const s of ['/repair', 'status of 409', 'ERR_TIMED_OUT']) problems.allow(s);
  await context.route(/\/api\/notifications\?/, async (route) => {
    // 特定多页场景按请求发出时的握手选视图，不能等 route.fetch 后再把后台读串成点击现读。
    const view = viewForRequest?.(route.request()) ?? scene;
    let res: Awaited<ReturnType<typeof route.fetch>>;
    let json: { items: Record<string, unknown>[] };
    try {
      res = await route.fetch();
      json = (await res.json()) as typeof json;
    } catch {
      // 页面已经取消了这次读（React Query 换新的一次、换页、用例收尾）：这条请求已经没人等，不改写
      return;
    }
    for (const n of json.items) {
      if (n.title !== STALLED) continue;
      n.dedupeKey = 'watchdog:idle-running:task-12';
      n.repair = {
        incident: view.incident ?? INCIDENT,
        actions: view.actions,
        problems: view.problems,
        ...(view.last ? { last: view.last } : {}),
        ...(view.linked ? { linked: view.linked } : {}),
      };
      if (view.handling) n.handling = view.handling;
    }
    await route.fulfill({ response: res, json }).catch(() => undefined);
  });
  await context.route(/\/api\/notifications\/[^/?]+\/repair$/, async (route) => {
    const body = route.request().postDataJSON() as Body;
    scene.bodies.push(body);
    const out = await scene.exec(body);
    if (out === 'timeout') return route.abort('timedout');
    return route.fulfill({ status: out.status, json: out.json });
  });
}

// 通知中心是左列表右详情（#3533）：修复区在右边「通知详情」里，先点开列表里那一行
const stalledCard = (page: Page) =>
  page.getByRole('region', { name: '通知详情' }).filter({ hasText: STALLED });
const phaseOf = (page: Page) => stalledCard(page).getByTestId('repair-record').first();
/** 打开通知中心并点开那条看门狗的卡。 */
async function openStalledPage(page: Page): Promise<void> {
  await page.goto('/notifications');
  await page.locator('li[data-notice-row]').filter({ hasText: STALLED }).getByRole('button').click();
  await expect(stalledCard(page)).toBeVisible();
}

test.describe('通知中心：看门狗提醒的修复', () => {
  test.beforeEach(async ({ login }) => login());

  test('多方案：写后端给的后果和推荐理由；连点只发一次；原卡写排队 → 核验中，后端核验成功才写已修复', async ({
    page,
    context,
    problems,
    shot,
  }) => {
    const scene: Scene = {
      actions: [RECOVER, HAND],
      problems: [],
      bodies: [],
      exec: async (body) => {
        await new Promise((r) => setTimeout(r, 600));
        scene.last = record(body, 'accepted', '继续信号已受理（收到了，不等于修好）');
        scene.actions = [];
        return { status: 200, json: { ok: true, repair: scene.last, replayed: false } };
      },
    };
    await stage(context, problems, scene);
    await openStalledPage(page);
    const card = stalledCard(page);
    await expect(card.getByTestId('repair-actions')).toContainText(RECOVER.detail);
    await expect(card.getByTestId('repair-actions')).toContainText(HAND.detail);
    await expect(card.getByTestId('repair-actions')).toContainText('推荐：现有的恢复入口');
    await expect(card.getByText('等你拍板')).toHaveCount(0);
    await stalledCard(page).scrollIntoViewIfNeeded();
    await shot(page, '06-修复-可点的动作');

    await card.getByRole('button', { name: '叫醒任务继续' }).dblclick();
    await expect(card.getByTestId('repair-busy')).toBeVisible();
    await expect(card.getByText(/已排队：叫醒任务继续/)).toBeVisible();
    await expect(phaseOf(page)).toHaveAttribute('data-phase', 'verifying');
    // 「已修复」作为状态出现才算（说明里那句「恢复了才写『已修复』」不算）
    await expect(card.getByText('已修复', { exact: true })).toHaveCount(0);
    expect(scene.bodies).toHaveLength(1);
    expect(scene.bodies[0]).toMatchObject({ actionId: RECOVER.id, incident: INCIDENT });
    await stalledCard(page).scrollIntoViewIfNeeded();
    await shot(page, '06-修复-核验中');

    // 状态变更：后端核验成功（verified）以后重读，原卡才写已修复
    const first = scene.bodies[0] as Body;
    scene.last = record(first, 'verified', '核实恢复：同一任务和工作流 run 的原检测条件已恢复');
    await page.reload();
    await expect(phaseOf(page)).toHaveAttribute('data-phase', 'verified');
    await expect(stalledCard(page).getByText('已修复', { exact: true })).toBeVisible();
    await stalledCard(page).scrollIntoViewIfNeeded();
    await shot(page, '06-修复-已修复');
  });

  test('两页同开：一页修了，另一页的旧按钮先重读、不再发', async ({ page, context, problems }) => {
    const scene: Scene = {
      actions: [RECOVER],
      problems: [],
      bodies: [],
      exec: async (body) => {
        scene.last = record(body, 'accepted', '继续信号已受理（收到了，不等于修好）');
        scene.actions = [];
        return { status: 200, json: { ok: true, repair: scene.last, replayed: false } };
      },
    };
    const other = await context.newPage();
    const oldView = { ...scene };
    const clickHeader = 'x-e2e-repair-click';
    let clickReads = 0;
    let clicks = 0;
    const beforeReads: Request[] = [];
    await other.exposeBinding('e2eRepairClicked', () => {
      clicks += 1;
    });
    await stage(context, problems, scene, (request) => {
      if (request.frame().page() !== other) return scene;
      if (request.headers()[clickHeader] === '1') {
        expect(clicks).toBe(1);
        clickReads += 1;
        return { ...scene };
      }
      beforeReads.push(request);
      return oldView;
    });
    await openStalledPage(page);
    await openStalledPage(other);
    await expect(stalledCard(other).getByRole('button', { name: '叫醒任务继续' })).toBeVisible();
    await stalledCard(page).getByRole('button', { name: '叫醒任务继续' }).click();
    await expect(phaseOf(page)).toHaveAttribute('data-phase', 'verifying');
    // 真实 click 之后才切阶段；query/refetch 可异步进入 fetch，先等 Node 确认握手再发请求。
    // 所有点击前的读都保持旧视图，不把“下一次 GET”猜成点击现读。
    await other.evaluate(
      ({ header, title }) => {
        const original = window.fetch;
        let clicked: Promise<void> | undefined;
        const capture = (event: MouseEvent) => {
          const button = event.target instanceof Element ? event.target.closest('button') : null;
          if (
            button?.getAttribute('aria-label') === '叫醒任务继续' &&
            button.closest('[aria-label="通知详情"]')?.textContent?.includes(title) === true
          ) {
            clicked = (window as unknown as { e2eRepairClicked: () => Promise<void> }).e2eRepairClicked();
          }
        };
        document.addEventListener('click', capture, true);
        window.fetch = async (input, init) => {
          const req = new Request(input, init);
          if (req.method !== 'GET' || new URL(req.url).pathname !== '/api/notifications') {
            return original.call(window, input, init);
          }
          const afterClick = clicked !== undefined;
          if (clicked) await clicked;
          const headers = new Headers(req.headers);
          headers.set(header, afterClick ? '1' : '0');
          return original.call(window, new Request(req, { headers }));
        };
        // 只在本测试页面使用；finally 关闭页面即撤销监听与 fetch 包装。
      },
      { header: clickHeader, title: STALLED },
    );
    try {
      await expect(stalledCard(other).getByRole('button', { name: '叫醒任务继续' })).toBeVisible();
      await Promise.all([
        other.waitForResponse(
          (response) => response.request().headers()[clickHeader] === '1' && response.status() === 200,
        ),
        stalledCard(other).getByRole('button', { name: '叫醒任务继续' }).click(),
      ]);
      expect(clicks).toBe(1);
      expect(clickReads).toBeGreaterThan(0);
      expect(beforeReads.length).toBeGreaterThan(0);
      await expect(stalledCard(other).getByTestId('repair-note')).toContainText('现场变了');
      await expect(phaseOf(other)).toHaveAttribute('data-phase', 'verifying');
      expect(scene.bodies).toHaveLength(1);
    } finally {
      await other.close();
    }
  });

  test('两页同开：另一页先刷新到受理结果，旧按钮消失且不重复修复', async ({ page, context, problems }) => {
    const scene: Scene = {
      actions: [RECOVER],
      problems: [],
      bodies: [],
      exec: async (body) => {
        scene.last = record(body, 'accepted', '继续信号已受理（收到了，不等于修好）');
        scene.actions = [];
        return { status: 200, json: { ok: true, repair: scene.last, replayed: false } };
      },
    };
    await stage(context, problems, scene);
    const other = await context.newPage();
    try {
      await openStalledPage(page);
      await openStalledPage(other);
      await expect(stalledCard(other).getByRole('button', { name: '叫醒任务继续' })).toBeVisible();
      await stalledCard(page).getByRole('button', { name: '叫醒任务继续' }).click();
      await expect(phaseOf(page)).toHaveAttribute('data-phase', 'verifying');
      const listed = other.waitForResponse(
        (response) =>
          response.url().includes('/api/notifications?') &&
          response.request().method() === 'GET' &&
          response.status() === 200,
      );
      await other.getByRole('button', { name: '刷新', exact: true }).click();
      await listed;
      await expect(stalledCard(other).getByRole('button', { name: '叫醒任务继续' })).toHaveCount(0);
      await expect(phaseOf(other)).toHaveAttribute('data-phase', 'verifying');
      expect(scene.bodies).toHaveLength(1);
    } finally {
      await other.close();
    }
  });

  test('网络超时：写没收到回执、不给新按钮；再问一次用同一个请求编号', async ({
    page,
    context,
    problems,
    shot,
  }) => {
    let calls = 0;
    const scene: Scene = {
      actions: [RECOVER],
      problems: [],
      bodies: [],
      exec: async (body) => {
        calls += 1;
        if (calls === 1) return 'timeout';
        scene.last = record(body, 'accepted', '继续信号已受理（收到了，不等于修好）');
        scene.actions = [];
        return { status: 200, json: { ok: true, repair: scene.last, replayed: true } };
      },
    };
    await stage(context, problems, scene);
    await openStalledPage(page);
    const card = stalledCard(page);
    await card.getByRole('button', { name: '叫醒任务继续' }).click();
    await expect(phaseOf(page)).toHaveAttribute('data-phase', 'no-receipt');
    await expect(card.getByTestId('repair-actions')).toHaveCount(0);
    await stalledCard(page).scrollIntoViewIfNeeded();
    await shot(page, '06-修复-没收到回执');
    await card.getByRole('button', { name: '再问一次（同一请求）' }).click();
    await expect(phaseOf(page)).toHaveAttribute('data-phase', 'verifying');
    expect(scene.bodies).toHaveLength(2);
    expect(scene.bodies[1]?.requestId).toBe(scene.bodies[0]?.requestId);
  });

  test('按钮过期：后端回 409，卡上写原话并刷新，不沿旧编号重发；没修成的原因留卡、能查具体操作', async ({
    page,
    context,
    problems,
    shot,
  }) => {
    const scene: Scene = {
      actions: [RECOVER],
      problems: [],
      bodies: [],
      exec: async () => {
        scene.actions = [{ ...RECOVER, id: 'task-recover:e2e2' }];
        return {
          status: 409,
          json: {
            error: {
              code: 'action_expired',
              message: '这个动作已经过期（现场条件变了）：刷新后看当前能点的',
            },
          },
        };
      },
    };
    await stage(context, problems, scene);
    await openStalledPage(page);
    const card = stalledCard(page);
    await card.getByRole('button', { name: '叫醒任务继续' }).click();
    await expect(card.getByTestId('repair-note')).toContainText('已刷新，按现在能点的重选');
    expect(scene.bodies).toHaveLength(1);

    // 没修成：中文原因留卡，「具体操作」写目标和操作记录链接
    scene.last = record(scene.bodies[0] as Body, 'failed', '信号没发出去：工作流已经结束');
    await page.reload();
    await expect(phaseOf(page)).toHaveAttribute('data-phase', 'failed');
    await expect(stalledCard(page).getByText('信号没发出去：工作流已经结束')).toBeVisible();
    await stalledCard(page).getByText('具体操作').click();
    await expect(stalledCard(page).getByTestId('repair-detail')).toContainText('run run-e2e');
    await expect(stalledCard(page).getByRole('link', { name: /查这条的操作记录/ })).toHaveAttribute(
      'href',
      /\/audit\?target=notification%3A/,
    );
    await stalledCard(page).scrollIntoViewIfNeeded();
    await shot(page, '06-修复-没修成');
  });

  test('要本人拍：点开才摆选项、写为什么要你拍；选「先不动」不执行', async ({
    page,
    context,
    problems,
    shot,
  }) => {
    const scene: Scene = {
      actions: [RESTORE],
      problems: [],
      bodies: [],
      exec: async (body) => {
        scene.last = record(body, 'declined', '你选了「先不动」，没有执行', 'release-restore');
        scene.actions = [RESTORE];
        return { status: 200, json: { ok: true, repair: scene.last, replayed: false } };
      },
    };
    await stage(context, problems, scene);
    await openStalledPage(page);
    const card = stalledCard(page);
    await card.getByRole('button', { name: '恢复引擎开关' }).click();
    await expect(card.getByTestId('repair-why-you')).toContainText('会动引擎总开关');
    await stalledCard(page).scrollIntoViewIfNeeded();
    await shot(page, '06-修复-要你本人拍');
    await card.getByRole('button', { name: '先不动' }).click();
    await expect(phaseOf(page)).toHaveAttribute('data-phase', 'declined');
    expect(scene.bodies[0]?.optionId).toBe('hold');
  });

  test('没有能点的修复：照实写后端给的原因，留「打开」和「提需求」出口', async ({
    page,
    context,
    problems,
    shot,
  }) => {
    const scene: Scene = {
      actions: [],
      problems: ['没接上任务现读（开发环境），「任务继续」用不了'],
      bodies: [],
      exec: async () => ({ status: 500, json: {} }),
    };
    await stage(context, problems, scene);
    await openStalledPage(page);
    const card = stalledCard(page);
    await expect(card.getByTestId('repair-none')).toContainText('没接上任务现读');
    await expect(card.getByRole('link', { name: '到「提需求」写一句' })).toHaveAttribute('href', '/intake');
    await expect(card.getByRole('link', { name: '打开' })).toBeVisible();
    await stalledCard(page).scrollIntoViewIfNeeded();
    await shot(page, '06-修复-没有能点的');
    expect(scene.bodies).toHaveLength(0);
  });

  // 评审 5565720994 的线上现场：关联 #3183 后 GET 回 linked.stage=worker-active，重读为 pr-open、PR #3184；
  // repair.last 没有，旧 handling.stage=unclaimed。这里照同一形状造（incident 换成本场景的），后端仍列着「交给修复」。
  test('明确关联了已有单：照关联写单号、任务 / PR 和阶段，不写「没人在修」、处理人写未知、不摆交给修复', async ({
    page,
    context,
    problems,
    shot,
  }) => {
    const fleet = { owner: 'thoerwink8', name: 'fleet-dao' };
    const linked = {
      incident: INCIDENT,
      issue: { repo: fleet, number: 3183, url: 'https://github.com/thoerwink8/fleet-dao/issues/3183' },
      reason: 'operator-explicit',
      stage: 'worker-active',
      taskId: 'task-3183',
      actionId: 'link:e2e',
      requestId: '22222222-2222-4222-8222-222222222222',
      by: 'session:commander',
      at: new Date(Date.now() - 2 * 60_000).toISOString(),
      text: '已明确关联 thoerwink8/fleet-dao#3183（已有进行中的任务）：只绑定，没开单、没派工',
    };
    const scene: Scene = {
      actions: [{ ...HAND, target: { repo: fleet } }],
      problems: [],
      linked,
      handling: {
        stage: 'unclaimed',
        stageText: '没人在修',
        since: new Date(Date.now() - 30 * 60_000).toISOString(),
        line: '没人在修 · 30 分钟',
        problems: [],
      },
      bodies: [],
      exec: async () => ({ status: 500, json: {} }),
    };
    await stage(context, problems, scene);
    await openStalledPage(page);
    const card = stalledCard(page);
    await expect(card.getByTestId('repair-linked')).toHaveAttribute('data-stage', 'worker-active');
    await expect(card.getByTestId('repair-linked')).toContainText('已关联 thoerwink8/fleet-dao#3183');
    await expect(card.getByRole('link', { name: '看在做的任务' })).toHaveAttribute(
      'href',
      '/tasks/task-3183',
    );
    await expect(card.getByTestId('alert-handling')).toHaveAttribute('data-from', 'linked');
    await expect(card.getByText('没人在修')).toHaveCount(0);
    await expect(card.getByTestId('repair-linked-who')).toContainText('处理人：未知');
    await expect(card.getByTestId('repair-linked-who')).toContainText('关联的人不是修的人');
    await expect(card.getByRole('button', { name: '交给修复' })).toHaveCount(0);
    await expect(card.getByText('已修复', { exact: true })).toHaveCount(0);
    await card.scrollIntoViewIfNeeded();
    await shot(page, '06-修复-已关联-任务在做');

    // 重读：后端核实到开放 PR #3184
    scene.linked = {
      ...linked,
      stage: 'pr-open',
      prNumber: 3184,
      text: '已明确关联 thoerwink8/fleet-dao#3183（已有开放 PR #3184）：只绑定，没开单、没派工',
    };
    await page.reload();
    await expect(stalledCard(page).getByTestId('repair-linked')).toHaveAttribute('data-stage', 'pr-open');
    await expect(stalledCard(page).getByText('PR 开着').first()).toBeVisible();
    await expect(stalledCard(page).getByText('没人在修')).toHaveCount(0);
    await stalledCard(page).scrollIntoViewIfNeeded();
    await shot(page, '06-修复-已关联-PR开着');

    // 绑定失效：写原因，「没人在修」照实回来，原卡没修成
    scene.linked = {
      ...linked,
      stage: 'linked',
      invalid: { at: new Date().toISOString(), text: '单子已关闭' },
    };
    await page.reload();
    await expect(stalledCard(page).getByTestId('repair-linked')).toHaveAttribute('data-stage', 'invalid');
    await expect(stalledCard(page).getByTestId('repair-linked-invalid')).toContainText('单子已关闭');
    await expect(stalledCard(page).getByText('没人在修')).toBeVisible();
    expect(scene.bodies).toHaveLength(0);
  });

  test('同一条通知重开：旧事故的已修复不显示、不挡住，新动作按新事故发出去', async ({
    page,
    context,
    problems,
  }) => {
    const recoverB = {
      ...RECOVER,
      id: 'task-recover:e2e-b',
      label: '重开后继续',
      detail: '新事故：给任务 #12 的当前工作流发继续',
    };
    const scene: Scene = {
      incident: 'incident-a',
      actions: [RECOVER],
      problems: [],
      bodies: [],
      exec: async (body) => {
        if (body.incident === 'incident-b') {
          const repair = record(body, 'accepted', '新事故已受理（收到了，不等于修好）');
          scene.last = repair;
          scene.actions = [];
          return { status: 200, json: { ok: true, repair, replayed: false } };
        }
        const repair = record(body, 'verified', '核实恢复：上一代事故');
        scene.last = repair;
        scene.actions = [];
        return { status: 200, json: { ok: true, repair, replayed: false } };
      },
    };
    await stage(context, problems, scene);
    await openStalledPage(page);
    const card = stalledCard(page);
    await card.getByRole('button', { name: '叫醒任务继续' }).click();
    await expect(phaseOf(page)).toHaveAttribute('data-phase', 'verified');
    await expect(card.getByText('已修复', { exact: true })).toBeVisible();

    const refreshBtn = page.getByRole('button', { name: '刷新' });
    await expect(refreshBtn).not.toHaveAttribute('aria-busy', 'true');
    scene.incident = 'incident-b';
    delete scene.last;
    scene.actions = [recoverB];
    await refreshBtn.click();
    await expect(card.getByTestId('repair-actions')).toContainText(recoverB.detail);
    await expect(card.getByText('已修复', { exact: true })).toHaveCount(0);
    await expect(card.getByTestId('repair-record')).toHaveCount(0);

    await card.getByRole('button', { name: '重开后继续' }).click();
    await expect(phaseOf(page)).toHaveAttribute('data-phase', 'verifying');
    expect(scene.bodies.map((b) => b.incident)).toEqual(['incident-a', 'incident-b']);
    expect(scene.bodies[1]).toMatchObject({ actionId: recoverB.id, incident: 'incident-b' });
    expect(scene.bodies[1]?.requestId).not.toBe(scene.bodies[0]?.requestId);
    expect(scene.bodies.filter((b) => b.requestId === scene.bodies[0]?.requestId)).toHaveLength(1);
  });

  test('迟到的上一代成功或失败不改这一代正在执行的状态，也不把那次请求再发一遍', async ({
    page,
    context,
    problems,
  }) => {
    const recoverB = {
      ...RECOVER,
      id: 'task-recover:e2e-b',
      label: '重开后继续',
      detail: '新事故：给任务 #12 的当前工作流发继续',
    };
    let releaseA: () => void = () => undefined;
    let releaseB: () => void = () => undefined;
    const gateA = () =>
      new Promise<void>((resolve) => {
        releaseA = () => resolve();
      });
    const gateB = () =>
      new Promise<void>((resolve) => {
        releaseB = () => resolve();
      });
    let failA = false;
    const scene: Scene = {
      incident: 'incident-a',
      actions: [RECOVER],
      problems: [],
      bodies: [],
      exec: async (body) => {
        if (body.incident === 'incident-a') {
          await gateA();
          if (failA) return 'timeout';
          return {
            status: 200,
            json: {
              ok: true,
              repair: record(body, 'verified', '核实恢复：上一代事故'),
              replayed: false,
            },
          };
        }
        await gateB();
        const repair = record(body, 'accepted', '新事故已受理（收到了，不等于修好）');
        if (scene.incident === body.incident) {
          scene.last = repair;
          scene.actions = [];
        }
        return { status: 200, json: { ok: true, repair, replayed: false } };
      },
    };
    await stage(context, problems, scene);
    try {
      await openStalledPage(page);
      const card = stalledCard(page);
      await card.getByRole('button', { name: '叫醒任务继续' }).click();
      await expect(card.getByTestId('repair-busy')).toHaveAttribute('data-step', 'sent');
      const refreshBtn = page.getByRole('button', { name: '刷新' });
      await expect(refreshBtn).not.toHaveAttribute('aria-busy', 'true');
      scene.incident = 'incident-b';
      scene.actions = [recoverB];
      delete scene.last;
      await refreshBtn.click();
      await expect(card.getByRole('button', { name: '重开后继续' })).toBeVisible();
      await card.getByRole('button', { name: '重开后继续' }).click();
      await expect(card.getByTestId('repair-busy')).toHaveAttribute('data-step', 'sent');

      const listed = page.waitForResponse(
        (res) => res.url().includes('/api/notifications?') && res.request().method() === 'GET',
      );
      releaseA();
      await listed;
      await expect(card.getByTestId('repair-busy')).toHaveAttribute('data-step', 'sent');
      await expect(card.getByText('已修复', { exact: true })).toHaveCount(0);
      await expect(card.getByText('核实恢复：上一代事故')).toHaveCount(0);
      expect(scene.bodies).toHaveLength(2);
      expect(scene.bodies[0]).toMatchObject({ actionId: RECOVER.id, incident: 'incident-a' });
      expect(scene.bodies[1]).toMatchObject({ actionId: recoverB.id, incident: 'incident-b' });

      releaseB();
      await expect(phaseOf(page)).toHaveAttribute('data-phase', 'verifying');
      await expect(card.getByText('新事故已受理（收到了，不等于修好）')).toBeVisible();
      await expect(card.getByText('已修复', { exact: true })).toHaveCount(0);
      expect(scene.bodies).toHaveLength(2);
    } finally {
      releaseA();
      releaseB();
    }

    failA = true;
    releaseA = () => undefined;
    releaseB = () => undefined;
    scene.incident = 'incident-a';
    scene.actions = [RECOVER];
    delete scene.last;
    scene.bodies.length = 0;
    try {
      await page.reload();
      const card = stalledCard(page);
      await card.getByRole('button', { name: '叫醒任务继续' }).click();
      await expect(card.getByTestId('repair-busy')).toHaveAttribute('data-step', 'sent');
      const refreshBtn = page.getByRole('button', { name: '刷新' });
      await expect(refreshBtn).not.toHaveAttribute('aria-busy', 'true');
      scene.incident = 'incident-b';
      scene.actions = [recoverB];
      delete scene.last;
      await refreshBtn.click();
      await expect(card.getByRole('button', { name: '重开后继续' })).toBeVisible();
      await card.getByRole('button', { name: '重开后继续' }).click();
      await expect(card.getByTestId('repair-busy')).toHaveAttribute('data-step', 'sent');

      const listed = page.waitForResponse(
        (res) => res.url().includes('/api/notifications?') && res.request().method() === 'GET',
      );
      releaseA();
      await listed;
      await expect(card.getByTestId('repair-busy')).toHaveAttribute('data-step', 'sent');
      await expect(card.getByText('没收到回执')).toHaveCount(0);
      expect(scene.bodies.filter((b) => b.incident === 'incident-a')).toHaveLength(1);
      expect(scene.bodies.filter((b) => b.incident === 'incident-b')).toHaveLength(1);

      releaseB();
      await expect(phaseOf(page)).toHaveAttribute('data-phase', 'verifying');
      await expect(card.getByText('没收到回执')).toHaveCount(0);
    } finally {
      releaseA();
      releaseB();
    }
  });

  test('服务端明示的上一代结果未知继续展示，并挡住新事故的动作', async ({ page, context, problems }) => {
    const scene: Scene = {
      incident: 'incident-b',
      actions: [{ ...RECOVER, id: 'task-recover:e2e-b', label: '重开后继续', detail: '新事故不该摆出来' }],
      problems: ['上一代事故的操作仍在执行、结果未知或待核验，不能覆盖后重发；请先核实原操作'],
      last: record(
        {
          actionId: RECOVER.id,
          incident: 'incident-a',
          requestId: '11111111-1111-4111-8111-111111111111',
        },
        'unknown',
        '上一代结果未知',
      ),
      bodies: [],
      exec: async () => ({ status: 500, json: {} }),
    };
    await stage(context, problems, scene);
    await openStalledPage(page);
    const card = stalledCard(page);
    await expect(phaseOf(page)).toHaveAttribute('data-phase', 'unknown');
    await expect(card.getByText('上一代结果未知')).toBeVisible();
    await expect(card.getByText(/不能覆盖后重发/)).toBeVisible();
    await expect(card.getByTestId('repair-actions')).toHaveCount(0);
    await expect(card.getByRole('button', { name: '重开后继续' })).toHaveCount(0);
    expect(scene.bodies).toHaveLength(0);
  });
});
