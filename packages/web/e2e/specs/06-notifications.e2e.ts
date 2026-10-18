// 第六步：提醒页（通知中心）。要你拍的、卡住报警、日报；「处理了」要落库、进操作记录；没有追问入口（#939）。
// 看门狗修复（#3034）：真后端算 repair 要 Temporal 和看门狗现场，e2e 这一套没有，所以修复那几条在浏览器网络层改写：
// 列表照真后端读、只把「任务 12 卡住了」改成看门狗的键并挂上场景给的 repair（前端照契约校验形状），点修复的 POST 由场景回话，不碰真库。
import type { BrowserContext, Page } from '@playwright/test';
import { expect, onlyDesktop, type PageProblems, test } from '../support/fixtures.ts';

type Audit = { items: { action: string; target: string; after?: unknown }[] };
type NotificationsRes = { items: { id: string; title: string; resolvedAt?: string }[] };

test.describe('通知中心', () => {
  test.beforeEach(async ({ login }) => login());

  test('库里的提醒按级别分开数：要你拍 2、卡住报警 2、日报 1；未处理的在前', async ({ page, shot }) => {
    await page.goto('/notifications');
    await expect(page.getByRole('heading', { name: '通知中心' })).toBeVisible();
    await expect(page.getByRole('button', { name: /^全部 5$/ })).toBeVisible();
    await expect(page.getByRole('button', { name: /^要你拍 2$/ })).toBeVisible();
    await expect(page.getByRole('button', { name: /^卡住报警 2$/ })).toBeVisible();
    await expect(page.getByRole('button', { name: /^日报 1$/ })).toBeVisible();
    await expect(page.getByText('任务 12 卡住了')).toBeVisible();
    await expect(page.getByText('额度读数 35 分钟没更新')).toBeVisible();
    // 「谁在处理」：库里没有认领的，明说没人在修，不留空
    await expect(page.getByText('没人在修').first()).toBeVisible();
    await shot(page, '06-通知中心');
  });

  test('按级别筛选：点「卡住报警」只剩那两条', async ({ page }) => {
    await page.goto('/notifications');
    await page.getByRole('button', { name: /^卡住报警 2$/ }).click();
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
    const item = page.getByRole('listitem').filter({ hasText: '额度读数 35 分钟没更新' });
    await item.getByRole('button', { name: '处理了' }).click();
    await expect(page.getByText('处理了', { exact: true }).first()).toBeVisible();
    await expect(page.getByText('额度读数 35 分钟没更新')).toHaveCount(0);

    const open = (await api.get('/api/notifications?status=open')) as NotificationsRes;
    expect(open.items.some((n) => n.title === '额度读数 35 分钟没更新')).toBe(false);
    const all = (await api.get('/api/notifications?status=all')) as NotificationsRes;
    expect(all.items.find((n) => n.title === '额度读数 35 分钟没更新')?.resolvedAt).toBeTruthy();
    const audit = (await api.get('/api/audit?limit=50')) as Audit;
    expect(audit.items.some((a) => a.action === 'notification.resolve')).toBe(true);

    await page.getByRole('tab', { name: '连已处理的一起看' }).click();
    await expect(page.getByText(/我处理于/)).toBeVisible();
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
  incident: INCIDENT,
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
  bodies: Body[];
  exec: (body: Body) => Promise<{ status: number; json: unknown } | 'timeout'>;
}

async function stage(context: BrowserContext, problems: PageProblems, scene: Scene): Promise<void> {
  // 有意造的 409 和断线：只放过修复那一条请求的
  for (const s of ['/repair', 'status of 409', 'ERR_TIMED_OUT']) problems.allow(s);
  await context.route(/\/api\/notifications\?/, async (route) => {
    const res = await route.fetch();
    const json = (await res.json()) as { items: Record<string, unknown>[] };
    for (const n of json.items) {
      if (n.title !== STALLED) continue;
      n.dedupeKey = 'watchdog:idle-running:task-12';
      n.repair = {
        incident: INCIDENT,
        actions: scene.actions,
        problems: scene.problems,
        ...(scene.last ? { last: scene.last } : {}),
      };
    }
    await route.fulfill({ response: res, json });
  });
  await context.route(/\/api\/notifications\/[^/?]+\/repair$/, async (route) => {
    const body = route.request().postDataJSON() as Body;
    scene.bodies.push(body);
    const out = await scene.exec(body);
    if (out === 'timeout') return route.abort('timedout');
    return route.fulfill({ status: out.status, json: out.json });
  });
}

const stalledCard = (page: Page) => page.locator('li[data-notice-row]').filter({ hasText: STALLED });
const phaseOf = (page: Page) => stalledCard(page).getByTestId('repair-record').first();

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
    await page.goto('/notifications');
    const card = stalledCard(page);
    await expect(card.getByTestId('repair-actions')).toContainText(RECOVER.detail);
    await expect(card.getByTestId('repair-actions')).toContainText(HAND.detail);
    await expect(card.getByRole('button', { name: '叫醒任务继续' })).toContainText('推荐：现有的恢复入口');
    await expect(card.getByText('等你拍板')).toHaveCount(0);
    await shot(page, '06-修复-可点的动作');

    await card.getByRole('button', { name: '叫醒任务继续' }).dblclick();
    await expect(card.getByTestId('repair-busy')).toBeVisible();
    await expect(card.getByText(/已排队：叫醒任务继续/)).toBeVisible();
    await expect(phaseOf(page)).toHaveAttribute('data-phase', 'verifying');
    await expect(card.getByText('已修复')).toHaveCount(0);
    expect(scene.bodies).toHaveLength(1);
    expect(scene.bodies[0]).toMatchObject({ actionId: RECOVER.id, incident: INCIDENT });
    await shot(page, '06-修复-核验中');

    // 状态变更：后端核验成功（verified）以后重读，原卡才写已修复
    const first = scene.bodies[0] as Body;
    scene.last = record(first, 'verified', '核实恢复：同一任务和工作流 run 的原检测条件已恢复');
    await page.reload();
    await expect(phaseOf(page)).toHaveAttribute('data-phase', 'verified');
    await expect(stalledCard(page).getByText('已修复')).toBeVisible();
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
    await stage(context, problems, scene);
    const other = await context.newPage();
    await page.goto('/notifications');
    await other.goto('/notifications');
    await expect(stalledCard(other).getByRole('button', { name: '叫醒任务继续' })).toBeVisible();
    await stalledCard(page).getByRole('button', { name: '叫醒任务继续' }).click();
    await expect(phaseOf(page)).toHaveAttribute('data-phase', 'verifying');
    // 另一页还摆着旧按钮：点了先重读，发现已经有人在修，不发
    await stalledCard(other).getByRole('button', { name: '叫醒任务继续' }).click();
    await expect(stalledCard(other).getByTestId('repair-note')).toContainText('现场变了');
    await expect(phaseOf(other)).toHaveAttribute('data-phase', 'verifying');
    expect(scene.bodies).toHaveLength(1);
    await other.close();
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
    await page.goto('/notifications');
    const card = stalledCard(page);
    await card.getByRole('button', { name: '叫醒任务继续' }).click();
    await expect(phaseOf(page)).toHaveAttribute('data-phase', 'no-receipt');
    await expect(card.getByTestId('repair-actions')).toHaveCount(0);
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
    await page.goto('/notifications');
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
    await page.goto('/notifications');
    const card = stalledCard(page);
    await card.getByRole('button', { name: '恢复引擎开关' }).click();
    await expect(card.getByTestId('repair-why-you')).toContainText('会动引擎总开关');
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
    await page.goto('/notifications');
    const card = stalledCard(page);
    await expect(card.getByTestId('repair-none')).toContainText('没接上任务现读');
    await expect(card.getByRole('link', { name: '到「提需求」写一句' })).toHaveAttribute('href', '/intake');
    await expect(card.getByRole('button', { name: '打开' })).toBeVisible();
    await shot(page, '06-修复-没有能点的');
    expect(scene.bodies).toHaveLength(0);
  });
});
