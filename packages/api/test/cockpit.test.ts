import {
  AuditResponse,
  BoardResponse,
  JobsResponse,
  NotificationsResponse,
  PoolHoldsResponse,
  PoolsResponse,
  RoutingResponse,
  SettingsResponse,
  TaskDetailResponse,
  taskWorkflowId,
  UpdateSettingResponse,
  WEB_API_PREFIX,
  WebRoutes,
} from '@fleet-dao/shared';
import { devFixtures } from '@fleet-dao/store';
import { describe, expect, it } from 'vitest';
import { WorkflowGoneError } from '../src/ports.ts';
import { DEV_RUN_ID, DEV_USER_ID, errorCode, harness, IDS, T0, write } from './harness.ts';

const PARAMS: Record<string, string> = {
  repoId: IDS.repo,
  taskId: IDS.task12,
  runId: DEV_RUN_ID,
  stage: 'execute',
  channelId: 'ch-cursor',
  notificationId: IDS.notification1,
  key: 'sessions.maxConcurrent',
};

function fill(path: string): string {
  return WEB_API_PREFIX + path.replace(/:(\w+)/g, (_, name: string) => PARAMS[name] ?? name);
}

describe('约定与实现对得上', () => {
  it('WebRoutes 里每个接口后端都有（不会落到「没有这个接口」）', async () => {
    const h = harness();
    const session = await h.login();
    for (const [name, route] of Object.entries(WebRoutes)) {
      if (name === 'events') continue; // SSE 另测
      const init =
        route.method === 'GET' ? { headers: { cookie: session.cookie } } : write(route.method, session, {});
      const res = await h.cockpit.request(fill(route.path), init);
      if (res.status === 404) expect(await errorCode(res), name).not.toBe('not_found');
    }
  });

  it('每个读接口的返回都符合 shared/web-api.ts 的形状', async () => {
    const h = harness();
    const { cookie } = await h.login();
    for (const [name, route] of Object.entries(WebRoutes)) {
      if (route.method !== 'GET' || !('response' in route)) continue;
      // 远程环境的快照要先有环境推来过才有 200：在 node-report.test.ts 里先推再读、按同一份 schema 认
      if (name === 'node') continue;
      const res = await h.cockpit.request(fill(route.path), { headers: { cookie } });
      expect(res.status, name).toBe(200);
      const parsed = route.response.safeParse(await res.json());
      expect(parsed.success, `${name}: ${parsed.error?.message}`).toBe(true);
    }
  });

  it('库里多出来的字段不会漏给前端（例如仓的测试命令、用户的飞书编号）', async () => {
    const h = harness();
    const { cookie } = await h.login();
    const board = await (
      await h.cockpit.request(`/api/repos/${IDS.repo}/board`, { headers: { cookie } })
    ).text();
    expect(board).not.toContain('pnpm check');
    const me = await (await h.cockpit.request('/api/me', { headers: { cookie } })).text();
    expect(me).not.toContain('ou_dev_founder_a');
  });

  it('库返回的数据缺字段：当场 500，不把坏数据交给前端', async () => {
    const h = harness();
    const { cookie } = await h.login();
    const task = h.store.data.tasks[0];
    if (!task) throw new Error('样例数据里没有任务');
    Reflect.deleteProperty(task, 'title');
    const res = await h.cockpit.request(`/api/repos/${IDS.repo}/board`, { headers: { cookie } });
    expect(res.status).toBe(500);
    expect(await errorCode(res)).toBe('bad_response_shape');
  });
});

describe('看板与任务', () => {
  it('卡片上一句白话状态、步骤进度、「此刻」面板', async () => {
    const h = harness();
    const { cookie } = await h.login();
    const board = BoardResponse.parse(
      await (await h.cockpit.request(`/api/repos/${IDS.repo}/board`, { headers: { cookie } })).json(),
    );
    const task = board.tasks.find((t) => t.id === IDS.task12);
    const sub = task?.subtasks.find((s) => s.id === IDS.sub12a);
    expect(sub?.activity?.text).toBe('Opus 5.5 正在写验证码过期的测试');
    expect(sub?.progress).toEqual({ done: 1, total: 3 });
    expect(task?.progress).toEqual({ done: 0, total: 2 });
    expect(board.now.map((n) => [n.taskId, n.runId])).toEqual([[IDS.task12, DEV_RUN_ID]]);
    expect((await h.cockpit.request('/api/repos/nope/board', { headers: { cookie } })).status).toBe(404);
  });

  it('任务详情带全部会话（含已结束的）', async () => {
    const h = harness();
    const { cookie } = await h.login();
    const detail = TaskDetailResponse.parse(
      await (await h.cockpit.request(`/api/tasks/${IDS.task12}`, { headers: { cookie } })).json(),
    );
    expect(detail.runs.map((r) => r.id).sort()).toEqual([IDS.run0, DEV_RUN_ID]);
    expect(detail.runs.find((r) => r.id === IDS.run0)?.modelName).toBe('Opus 5.5');
    expect(detail.runs.find((r) => r.id === IDS.run0)).toMatchObject({
      cacheReadTokens: 1_450_000,
      cacheWriteTokens: 64_000,
      billing: 'subscription',
    });
  });

  it('任务详情带用量汇总：按模型、按阶段、整张合计；没读到的花费记次数，不当成 0；还在跑的只记在跑', async () => {
    const h = harness();
    const { cookie } = await h.login();
    const { usage } = TaskDetailResponse.parse(
      await (await h.cockpit.request(`/api/tasks/${IDS.task12}`, { headers: { cookie } })).json(),
    );
    // 结束的那次：120000 + 64000×1.25 + 1450000×0.1 + 8000×5 = 120000 + 80000 + 145000 + 40000
    expect(usage.total).toMatchObject({
      runs: 1,
      running: 1,
      inputTokens: 120_000,
      outputTokens: 8_000,
      missingTokens: 0,
      cacheReadTokens: 1_450_000,
      cacheWriteTokens: 64_000,
      missingCache: 0,
      inputEquivalent: 385_000,
      missingEquivalent: 0,
      costUsd: 0,
      missingCost: 1,
      // 走的是 Claude 订阅（套餐内），花费没记：记在套餐内那一栏的没读到，不当成按量花了 $0
      cost: {
        metered: { runs: 0, usd: 0, missing: 0 },
        subscription: { runs: 1, usd: 0, missing: 1 },
        unknown: { runs: 0, usd: 0, missing: 0 },
      },
      missingTime: 0,
    });
    expect(usage.byModel.map((m) => [m.model, m.modelName, m.runs, m.running])).toEqual([
      ['opus-5.5', 'Opus 5.5', 1, 1],
    ]);
    expect(usage.byStage.map((s) => [s.stage, s.runs, s.running, s.inputEquivalent])).toEqual([
      ['plan', 1, 0, 385_000],
      ['execute', 0, 1, 0],
    ]);
  });

  describe('三段的单（runs 表）：任务详情按段、按模型，读不到的逐笔写明原因', () => {
    async function detailOf(h: ReturnType<typeof harness>, taskId: string) {
      const { cookie } = await h.login();
      const res = await h.cockpit.request(`/api/tasks/${taskId}`, { headers: { cookie } });
      expect(res.status).toBe(200);
      return TaskDetailResponse.parse(await res.json());
    }
    const reasons = (run: { unread: { item: string; reason: string }[] } | undefined) =>
      Object.fromEntries((run?.unread ?? []).map((n) => [n.item, n.reason]));

    it('每一笔：段、模型名（查模型目录）、计费方式（查渠道）、派工档、耗时；兜底对上的标明；读不到的带原因', async () => {
      const d = await detailOf(harness(), IDS.task13);
      expect(d.runs).toEqual([]);
      expect(
        d.segmentRuns.map((r) => [r.id, r.segment, r.modelName, r.tier ?? null, r.matchedBy, r.durationMs]),
      ).toEqual([
        [IDS.seg13scope, 'scope', 'Opus 5.5', null, 'task', 7 * 60_000],
        [IDS.seg13manual1, 'manual', 'Kimi k3', 'fast', 'task', 30 * 60_000],
        [IDS.seg13manual2, 'manual', 'Opus 5.5', 'fast', 'task', 25 * 60_000],
        [IDS.seg13verify, 'verify', 'GPT 5.6', null, 'issueNumber', 8 * 60_000],
      ]);
      const [scope, manual1, manual2, verify] = d.segmentRuns;
      expect(scope?.billing).toBe('subscription');
      expect(reasons(scope)).toEqual({});
      expect(reasons(manual1)).toEqual({ tokens: '没记到：缓存读、缓存写', cost: '花费没记到' });
      expect(manual1).toMatchObject({
        outcome: 'timeout',
        inputTokens: 64_000,
        failureReason: '30 分钟没交活，按超时收了',
      });
      expect(manual1?.cacheReadTokens).toBeUndefined();
      expect(reasons(manual2)).toEqual({});
      expect(manual2).toMatchObject({ prNumber: 39, costUsd: 1.86 });
      expect(reasons(verify)).toEqual({ cost: '花费没记到' });
    });

    it('用量按段（对题、动手、验收），每段再按模型；整张合计把三段算进去，排队记作没读到（noQueue），不当 0', async () => {
      const { usage } = await detailOf(harness(), IDS.task13);
      expect(
        usage.bySegment.map((s) => [
          s.segment,
          s.runs,
          s.tiers,
          s.missingTier,
          s.byModel.map((m) => m.model),
        ]),
      ).toEqual([
        ['scope', 1, [], 0, ['opus-5.5']],
        ['manual', 2, ['fast'], 0, ['kimi-k3', 'opus-5.5']],
        ['verify', 1, [], 0, ['gpt-5.6']],
      ]);
      expect(usage.bySegment[1]).toMatchObject({
        runMs: 55 * 60_000,
        missingCache: 1,
        missingCost: 1,
        costUsd: 1.86,
        cost: { subscription: { runs: 2, usd: 1.86, missing: 1 } },
      });
      expect(usage.total).toMatchObject({ runs: 4, running: 0, noQueue: 4, queueMs: 0, missingCost: 2 });
      expect(usage.byStage).toEqual([]);
      expect(usage.byModel.map((m) => [m.model, m.runs])).toEqual([
        ['opus-5.5', 2],
        ['kimi-k3', 1],
        ['gpt-5.6', 1],
      ]);
    });

    it('【失败】段名认不出：不猜成哪一段，段给 null、原样写进原因；按段那一组单列在最后', async () => {
      const h = harness();
      h.store.data.segmentRuns.push({
        id: 'd1000000-0000-4000-8000-0000000130aa',
        segment: 'fusion-execute' as 'manual',
        taskId: IDS.task13,
        model: 'opus-5.5',
        startedAt: new Date(T0.getTime() - 500 * 60_000).toISOString(),
        endedAt: new Date(T0.getTime() - 490 * 60_000).toISOString(),
        outcome: 'done',
      });
      const d = await detailOf(h, IDS.task13);
      const odd = d.segmentRuns.find((r) => r.id === 'd1000000-0000-4000-8000-0000000130aa');
      expect(odd?.segment).toBeNull();
      expect(reasons(odd).segment).toContain('fusion-execute');
      expect(d.usage.bySegment.map((s) => s.segment)).toEqual(['scope', 'manual', 'verify', null]);
    });

    it('【失败】起止缺一头：单子已经结束、这一段没记结束——不当在跑，耗时没读到并写明原因', async () => {
      const h = harness();
      h.store.data.segmentRuns.push({
        id: 'd1000000-0000-4000-8000-0000000130ab',
        segment: 'verify',
        taskId: IDS.task13,
        model: 'gpt-5.6',
        startedAt: new Date(T0.getTime() - 505 * 60_000).toISOString(),
      });
      const d = await detailOf(h, IDS.task13);
      const stale = d.segmentRuns.find((r) => r.id === 'd1000000-0000-4000-8000-0000000130ab');
      expect(stale).toMatchObject({ running: false });
      expect(stale?.durationMs).toBeUndefined();
      expect(reasons(stale).time).toContain('没记结束时刻');
      expect(d.usage.bySegment.find((s) => s.segment === 'verify')).toMatchObject({
        runs: 2,
        running: 0,
        missingTime: 1,
      });
    });

    it('单子还在跑、这一段没结束：算在跑（用量等它结束），不算没读到', async () => {
      const h = harness();
      h.store.data.segmentRuns.push({
        id: 'd1000000-0000-4000-8000-0000000120ac',
        segment: 'manual',
        taskId: IDS.task12,
        model: 'opus-5.5',
        tier: 'heavyweight',
        startedAt: new Date(T0.getTime() - 5 * 60_000).toISOString(),
      });
      const d = await detailOf(h, IDS.task12);
      expect(d.segmentRuns).toEqual([expect.objectContaining({ running: true, unread: [] })]);
      expect(d.usage.bySegment).toEqual([
        expect.objectContaining({ segment: 'manual', runs: 0, running: 1 }),
      ]);
      // 老流程的会话照旧按阶段算，和三段一起进整张合计
      expect(d.usage.total).toMatchObject({ runs: 1, running: 2 });
    });

    it('【失败】token 一样都没记到：写明「四样 token 都没记到」，当量、token 记没读到，不当 0', async () => {
      const h = harness();
      const verify = h.store.data.segmentRuns.find((r) => r.id === IDS.seg13verify);
      if (!verify) throw new Error('样例数据里要有 #13 的验收那一笔');
      delete verify.inputTokens;
      delete verify.outputTokens;
      delete verify.cacheReadTokens;
      delete verify.cacheWriteTokens;
      const d = await detailOf(h, IDS.task13);
      expect(reasons(d.segmentRuns.find((r) => r.id === IDS.seg13verify)).tokens).toBe('四样 token 都没记到');
      expect(d.usage.bySegment.find((s) => s.segment === 'verify')).toMatchObject({
        inputTokens: 0,
        missingTokens: 1,
        missingCache: 1,
        inputEquivalent: 0,
        missingEquivalent: 1,
      });
    });
  });

  it('翻页游标看不懂：400 invalid_cursor，不回空页（空页会被当成「后面没有了」）', async () => {
    const h = harness();
    const { cookie } = await h.login();
    for (const path of [
      '/api/audit?cursor=garbage',
      `/api/notifications?status=all&cursor=${encodeURIComponent(`${h.clock.now.toISOString()}|42`)}`,
    ]) {
      const res = await h.cockpit.request(path, { headers: { cookie } });
      expect(res.status, path).toBe(400);
      expect(await errorCode(res)).toBe('invalid_cursor');
    }
  });
});

describe('发给工作流的信号', () => {
  // task12 在 example/canary 仓，issue 号 12（dev-fixtures.ts）：命令按任务发，编号查库拼成引擎起的那条任务工作流（task:<仓>#<号>）。
  // 信号名只有引擎真有人听的两个（继续、放弃）；整条链的钉子在 signal-chain.test.ts。
  const TASK12_WORKFLOW_ID = taskWorkflowId({ owner: 'example', name: 'canary' }, 12);

  it('继续、叫停：发给这个任务的任务工作流，并写操作记录', async () => {
    const h = harness();
    const s = await h.login();
    for (const action of ['resume', 'stop'] as const) {
      const res = await h.cockpit.request(`/api/tasks/${IDS.task12}/actions`, write('POST', s, { action }));
      expect(res.status, action).toBe(200);
    }
    expect(h.signals.map((x) => [x.workflowId, x.signal.name])).toEqual([
      [TASK12_WORKFLOW_ID, 'taskContinue'],
      [TASK12_WORKFLOW_ID, 'taskAbandon'],
    ]);
    expect(h.signals[0]?.signal).toMatchObject({ by: DEV_USER_ID });
    expect(h.store.data.audit.slice(-2).map((a) => a.action)).toEqual(['task.resume', 'task.stop']);
  });

  it('暂停、换路由：引擎没有这两个动作，409 action_not_supported，不写操作记录、不发信号', async () => {
    const h = harness();
    const s = await h.login();
    const before = h.store.data.audit.length;
    for (const body of [{ action: 'pause' }, { action: 'reroute', routeId: 'rt-mirasim-kimi' }]) {
      const res = await h.cockpit.request(`/api/tasks/${IDS.task12}/actions`, write('POST', s, body));
      expect(res.status, body.action).toBe(409);
      expect(await errorCode(res)).toBe('action_not_supported');
    }
    expect(h.signals).toHaveLength(0);
    expect(h.store.data.audit.length).toBe(before);
  });

  it('任务已结束、工作流不在了：409；先记后做——发起那条在前，没做成再追加一条 ok=false', async () => {
    const h = harness({
      workflows: {
        async signal(workflowId) {
          throw new WorkflowGoneError(workflowId);
        },
      },
    });
    const s = await h.login();
    const done = await h.cockpit.request(
      `/api/tasks/${IDS.task13}/actions`,
      write('POST', s, { action: 'stop' }),
    );
    expect(await errorCode(done)).toBe('task_finished');
    const gone = await h.cockpit.request(
      `/api/tasks/${IDS.task12}/actions`,
      write('POST', s, { action: 'resume' }),
    );
    expect(await errorCode(gone)).toBe('workflow_gone');
    expect(h.store.data.audit.slice(-2)).toMatchObject([
      { action: 'task.resume', target: `task:${IDS.task12}`, ok: true },
      { action: 'task.resume', target: `task:${IDS.task12}`, ok: false, error: 'workflow_gone' },
    ]);
  });

  it('操作记录写不进：信号不发（故障注入）', async () => {
    const h = harness();
    const s = await h.login();
    h.store.appendAudit = async () => {
      throw new Error('库写不进');
    };
    for (const action of ['resume', 'stop']) {
      const res = await h.cockpit.request(`/api/tasks/${IDS.task12}/actions`, write('POST', s, { action }));
      expect(res.status, action).toBe(500);
    }
    expect(h.signals).toHaveLength(0);
  });
});

describe('调度台', () => {
  it('读路由目录：渠道、池、模型、路由照给；不带旧的阶段平铺顺序（每个用途的先后在路由两层，#574）', async () => {
    const h = harness();
    const { cookie } = await h.login();
    const raw = (await (await h.cockpit.request('/api/routing', { headers: { cookie } })).json()) as Record<
      string,
      unknown
    >;
    expect(raw).not.toHaveProperty('stages');
    const body = RoutingResponse.parse(raw);
    expect(body.routes.map((r) => r.id)).toContain('rt-claude-opus');
  });
});

describe('账号池、定时任务、通知、操作记录、设置', () => {
  it('额度：过期的读数标出来，一条读数都没有的标「没查成」，在跑的会话按池数', async () => {
    const h = harness();
    const { cookie } = await h.login();
    const body = PoolsResponse.parse(
      await (await h.cockpit.request('/api/pools', { headers: { cookie } })).json(),
    );
    const byId = new Map(body.pools.map((p) => [p.id, p]));
    expect(byId.get('pool-claude-a')).toMatchObject({
      quotaStatus: 'fresh',
      running: 1,
      channelName: 'Claude 订阅',
    });
    expect(byId.get('pool-cursor')?.quotaStatus).toBe('stale');
    expect(byId.get('pool-mirasim')).toMatchObject({ quotaStatus: 'unread', windows: [] });
    expect(byId.get('pool-mirasim')?.lastReadOkAt).toBeUndefined();
    expect(body.staleAfterMinutes).toBe(30);
  });

  it('额度读取已接上（#76）：额度表不带「待实现」，一次没读成的池照实是 unread', async () => {
    const h = harness();
    const { cookie } = await h.login();
    const raw = await (await h.cockpit.request('/api/pools', { headers: { cookie } })).json();
    expect(raw).not.toHaveProperty('quotaNotWired');
    const pools = PoolsResponse.parse(raw);
    expect(pools.pools.some((p) => p.quotaStatus === 'unread')).toBe(true);
  });

  it('切号现状（#194）：没接上写 unavailable；接上了读账本；账本认不出写 unreadable；读不到写明没读成，都不拿空冒充没事', async () => {
    const poolsBody = async (h: ReturnType<typeof harness>, cookie: string) =>
      PoolsResponse.parse(await (await h.cockpit.request('/api/pools', { headers: { cookie } })).json());
    const none = harness();
    const a = await none.login();
    expect((await poolsBody(none, a.cookie)).orgSwitch).toMatchObject({
      state: 'unavailable',
      soloPaused: false,
    });

    const doc = {
      live: 'solo',
      liveAt: '2026-10-04T12:00:00.000Z',
      onSoloSince: '2026-10-04T10:00:00.000Z',
      outage: {
        kind: 'E1',
        since: '2026-10-04T10:00:00.000Z',
        resetsAt: '2026-10-04T14:00:00.000Z',
        resetsFrom: 'api',
        evidence: '被拒原文是拼车本人额度那句',
      },
      channel: { state: 'ok', since: '2026-10-04T09:00:00.000Z', why: '账号状态正常' },
      backPending: null,
      whites: { count: 1 },
      reads: [
        { ok: true, requestedAt: '2026-10-04T11:58:00.000Z' },
        { ok: false, requestedAt: '2026-10-04T11:59:00.000Z', why: '503' },
      ],
    };
    const known = harness({ orgSwitch: { read: async () => ({ doc, updatedAt: T0 }) } });
    const b = await known.login();
    expect((await poolsBody(known, b.cookie)).orgSwitch).toMatchObject({
      state: 'known',
      live: 'solo',
      outage: { kind: 'E1', resetsAt: '2026-10-04T14:00:00.000Z', resetsFrom: 'api' },
      channel: { state: 'ok' },
      whites: 1,
      lastRead: { ok: false, why: '503' },
      soloPaused: false,
    });

    const garbled = harness({ orgSwitch: { read: async () => ({ doc: { v: 99 }, updatedAt: T0 }) } });
    const c = await garbled.login();
    const g = (await poolsBody(garbled, c.cookie)).orgSwitch;
    expect(g).toMatchObject({ state: 'unreadable' });
    expect(g && 'why' in g && g.why).toContain('认不出');

    const broken = harness({
      orgSwitch: {
        read: async () => {
          throw new Error('连接断了');
        },
      },
    });
    const d = await broken.login();
    const bk = (await poolsBody(broken, d.cookie)).orgSwitch;
    expect(bk).toMatchObject({ state: 'unavailable' });
    expect(bk && 'why' in bk && bk.why).toContain('读切号账本没成：连接断了');
  });

  it('切号现状带烧速（#194 4.1）：挂着拼车、读数够 → 每分钟花多少、还能撑几分钟；读数不够 → 还算不出（不带 0）；挂着独享不算', async () => {
    const poolsBody = async (h: ReturnType<typeof harness>, cookie: string) =>
      PoolsResponse.parse(await (await h.cockpit.request('/api/pools', { headers: { cookie } })).json());
    const base = {
      liveAt: '2026-10-04T11:59:00.000Z',
      onSoloSince: null,
      outage: null,
      channel: null,
      backPending: null,
      whites: { count: 0 },
    };
    const read = (m: number, used: number) => ({
      ok: true,
      requestedAt: new Date(T0.getTime() + m * 60_000).toISOString(),
      quota: { usedUsd: used, limitUsd: 80 },
    });
    const view = async (doc: Record<string, unknown>) => {
      const h = harness({ orgSwitch: { read: async () => ({ doc: { ...base, ...doc }, updatedAt: T0 }) } });
      const { cookie } = await h.login();
      return (await poolsBody(h, cookie)).orgSwitch;
    };
    const enough = await view({ live: 'carpool', reads: [read(-10, 20), read(-5, 30), read(-1, 38)] });
    expect(enough).toMatchObject({ state: 'known', burn: { state: 'known', remainingUsd: 42 } });
    const burn = enough && 'burn' in enough ? enough.burn : undefined;
    expect(burn?.state === 'known' && Math.round(burn.minutesLeft ?? 0)).toBe(21);
    // 【故意造出失败】只有 1 个读数：还算不出，不是 0
    const few = await view({ live: 'carpool', reads: [read(-1, 38)] });
    expect(few).toMatchObject({ burn: { state: 'unknown' } });
    expect(JSON.stringify(few)).not.toContain('usdPerMinute');
    // 【故意造出失败】账本里的读数没带额度（老账本）：算不出
    const old = await view({ live: 'carpool', reads: [{ ok: true, requestedAt: read(-1, 1).requestedAt }] });
    expect(old).toMatchObject({ burn: { state: 'unknown' } });
    // 挂着独享：不带烧速
    const solo = await view({ live: 'solo', reads: [read(-10, 20), read(-1, 38)] });
    expect(solo).toMatchObject({ state: 'known', live: 'solo' });
    expect(solo).not.toHaveProperty('burn');
  });

  it('拼车额度对账（#194 方案 4.7）：没接上写 unavailable；接上了写两个数；读不到写明没读成，不拿对得上冒充', async () => {
    const poolsBody = async (h: ReturnType<typeof harness>, cookie: string) =>
      PoolsResponse.parse(await (await h.cockpit.request('/api/pools', { headers: { cookie } })).json());
    const none = harness();
    const a = await none.login();
    expect((await poolsBody(none, a.cookie)).carpoolReconcile).toMatchObject({ state: 'unavailable' });

    const known = harness({
      carpoolReconcile: {
        read: async () => ({
          api: {
            poolId: 'claude-carpool',
            used: 50,
            limit: 80,
            resetsAt: new Date(T0.getTime() + 2 * 3_600_000),
            readAt: new Date(T0.getTime() - 60_000),
            staleSince: null,
            poolsWithWindow: 1,
          },
          spend: { sessions: 3, recordedUsd: 10, recorded: 3, unrecorded: 0, unrecordedSwitchStopped: 0 },
        }),
      },
    });
    const b = await known.login();
    const view = (await poolsBody(known, b.cookie)).carpoolReconcile;
    expect(view).toMatchObject({ state: 'known', verdict: 'others', localUsd: 10, apiUsedUsd: 50 });
    expect(view && 'note' in view && view.note).toContain('多半是别的设备在用');

    const broken = harness({
      carpoolReconcile: {
        read: async () => {
          throw new Error('连接断了');
        },
      },
    });
    const c = await broken.login();
    const bk = (await poolsBody(broken, c.cookie)).carpoolReconcile;
    expect(bk).toMatchObject({ state: 'unavailable' });
    expect(bk && 'why' in bk && bk.why).toContain('没成：连接断了');
  });

  it('路由表带上探针的结论（#129）：在线的带 ok 和时刻，离线的带原因，探针还没看过的不带（不说成离线）', async () => {
    const data = devFixtures(T0);
    const at = new Date(T0.getTime() - 5 * 60_000).toISOString();
    data.routes = (data.routes ?? []).map((r) => {
      if (r.id === 'rt-mirasim-kimi') {
        return {
          ...r,
          alive: false,
          probe: { state: 'failed' as const, at, detail: '登录失效：进程退出（退出码 1）' },
        };
      }
      if (r.id === 'rt-mirasim-gpt') {
        const { probe: _probe, ...rest } = r;
        return { ...rest, alive: false };
      }
      return r;
    });
    const h = harness({ data });
    const { cookie } = await h.login();
    const routing = RoutingResponse.parse(
      await (await h.cockpit.request('/api/routing', { headers: { cookie } })).json(),
    );
    const byId = new Map(routing.routes.map((r) => [r.id, r]));
    expect(byId.get('rt-claude-opus')).toMatchObject({ alive: true, probe: { state: 'ok' } });
    expect(byId.get('rt-mirasim-kimi')).toMatchObject({
      alive: false,
      probe: { state: 'failed', at, detail: '登录失效：进程退出（退出码 1）' },
    });
    expect(byId.get('rt-mirasim-gpt')?.alive).toBe(false);
    expect(byId.get('rt-mirasim-gpt')?.probe).toBeUndefined();
    // 探针接上了：不再带「待实现」
    expect(JSON.stringify(routing)).not.toContain('NotWired');
  });

  it('路由表带上渠道近态（#1118）：运行中失败被标 disabled 的渠道带原因和顺到谁，没出过事的渠道没有行', async () => {
    const h = harness();
    const { cookie } = await h.login();
    const at = new Date(T0.getTime() - 10 * 60_000).toISOString();
    h.store.data.channelStates.push({
      channelId: 'ch-mirasim',
      status: 'disabled',
      reason: '上游断连（已重试 2 次）',
      failedRouteId: 'rt-mirasim-kimi',
      fallbackChannelId: 'ch-claude',
      fallbackModelId: 'opus-5.5',
      flaggedAt: at,
      updatedAt: at,
    });
    const routing = RoutingResponse.parse(
      await (await h.cockpit.request('/api/routing', { headers: { cookie } })).json(),
    );
    expect(routing.channelStates).toEqual([
      {
        channelId: 'ch-mirasim',
        status: 'disabled',
        reason: '上游断连（已重试 2 次）',
        failedRouteId: 'rt-mirasim-kimi',
        fallbackChannelId: 'ch-claude',
        fallbackModelId: 'opus-5.5',
        flaggedAt: at,
        updatedAt: at,
      },
    ]);
  });

  it('【故意造出的失败】渠道近态读不到：路由表整个 500，不给空的顶、不让页面把 disabled 的渠道当成没事', async () => {
    const h = harness();
    const { cookie } = await h.login();
    h.store.listChannelStates = async () => {
      throw new Error('channel_states 读不到');
    };
    const res = await h.cockpit.request('/api/routing', { headers: { cookie } });
    expect(res.status).toBe(500);
  });

  it('额度按池判新旧：读成了、但上游的数冻住没前进，也算过期（看 dataAt）', async () => {
    const h = harness();
    const { cookie } = await h.login();
    const ago = (m: number) => new Date(h.clock.now.getTime() - m * 60_000).toISOString();
    const cursor = h.store.data.pools.find((p) => p.id === 'pool-cursor');
    if (!cursor) throw new Error('样例数据里没有 pool-cursor');
    cursor.lastReadOkAt = ago(1);
    // 上游不再报的窗口读数再新，也不算「上游数据的时刻」。
    h.store.data.quotaWindows.push({
      poolId: 'pool-cursor',
      label: 'old_bucket',
      window: 'other',
      used: 1,
      limit: 10,
      unit: 'usd',
      reading: 'measured',
      source: 'cursor-dashboard',
      readAt: ago(5),
      staleSince: ago(1),
    });
    const body = PoolsResponse.parse(
      await (await h.cockpit.request('/api/pools', { headers: { cookie } })).json(),
    );
    expect(body.pools.find((p) => p.id === 'pool-cursor')).toMatchObject({
      quotaStatus: 'stale',
      lastReadOkAt: ago(1),
      dataAt: ago(120),
    });
  });

  it('额度窗带原名、组名、单位、读法、上游原状态字、「上游这次没报」的时刻；池上带最近读成与数据时刻；快清零的排前；超额原样给', async () => {
    const h = harness();
    const { cookie } = await h.login();
    const ago = (m: number) => new Date(h.clock.now.getTime() - m * 60_000).toISOString();
    const mirasimPool = h.store.data.pools.find((p) => p.id === 'pool-mirasim');
    if (!mirasimPool) throw new Error('样例数据里没有 pool-mirasim');
    mirasimPool.lastReadOkAt = ago(2);
    h.store.data.quotaWindows.push(
      {
        poolId: 'pool-mirasim',
        label: '7d_fable',
        window: '7d_model',
        scope: 'fable',
        utilization: 1.3,
        unit: 'percent',
        upstreamStatus: 'limit_reached',
        statusRaw: 'rate_limited',
        reading: 'measured',
        source: 'mirasim-relay',
        readAt: ago(2),
        resetsAt: ago(-600),
      },
      {
        // 上次读成时上游没再报它：标着过期留着，照样列出。
        poolId: 'pool-mirasim',
        label: 'burst_tokens',
        window: 'other',
        used: 10,
        limit: 1000,
        unit: 'tokens',
        reading: 'measured',
        source: 'mirasim-relay',
        readAt: ago(40),
        resetsAt: ago(-30),
        staleSince: ago(2),
      },
    );
    const body = PoolsResponse.parse(
      await (await h.cockpit.request('/api/pools', { headers: { cookie } })).json(),
    );
    const byId = new Map(body.pools.map((p) => [p.id, p]));
    const claude = byId.get('pool-claude-a');
    expect(claude).toMatchObject({ lastReadOkAt: ago(5), dataAt: ago(5) });
    // 5h 两小时后清零，排在不知道清零时刻的 7d 前面。
    expect(claude?.windows.map((w) => [w.label, w.unit, w.source])).toEqual([
      ['5h', 'percent', 'claude-usage'],
      ['7d', 'percent', 'claude-usage'],
    ]);
    const mirasim = byId.get('pool-mirasim');
    // 上游不再报的窗口不算进数据时刻：池照样是新的。
    expect(mirasim).toMatchObject({ quotaStatus: 'fresh', lastReadOkAt: ago(2), dataAt: ago(2) });
    expect(mirasim?.windows).toEqual([
      {
        label: 'burst_tokens',
        window: 'other',
        used: 10,
        limit: 1000,
        unit: 'tokens',
        reading: 'measured',
        source: 'mirasim-relay',
        readAt: ago(40),
        resetsAt: ago(-30),
        staleSince: ago(2),
        stale: true,
      },
      {
        label: '7d_fable',
        window: '7d_model',
        scope: 'fable',
        utilization: 1.3,
        unit: 'percent',
        upstreamStatus: 'limit_reached',
        statusRaw: 'rate_limited',
        reading: 'measured',
        source: 'mirasim-relay',
        readAt: ago(2),
        resetsAt: ago(-600),
        stale: false,
      },
    ]);
  });

  it('定时任务：按期成功 / 超期 / 从没成功，分得开', async () => {
    const h = harness();
    const { cookie } = await h.login();
    h.store.data.jobs.push({ id: 'job-new', name: '新模型考试', schedule: '每天', expectEveryMinutes: 1440 });
    const body = JobsResponse.parse(
      await (await h.cockpit.request('/api/jobs', { headers: { cookie } })).json(),
    );
    const status = Object.fromEntries(body.jobs.map((j) => [j.id, j.status]));
    expect(status).toEqual({ 'job-quota': 'fresh', 'job-reconcile': 'overdue', 'job-new': 'never' });
    expect(body.jobs.find((j) => j.id === 'job-reconcile')?.lastRun?.outcome).toBe('unscanned');
  });

  it('通知：没拿到消息编号就算没送到；处理掉之后不在「未处理」里', async () => {
    const h = harness();
    const s = await h.login();
    h.store.data.notifications.push({
      id: 'n-2',
      level: 'decision',
      title: '要不要买域名',
      body: '花钱，等你们拍',
      createdAt: h.clock.now.toISOString(),
      deliveries: [{ channel: 'feishu', attempts: 3, error: '230013' }],
    });
    const list = NotificationsResponse.parse(
      await (await h.cockpit.request('/api/notifications', { headers: { cookie: s.cookie } })).json(),
    );
    expect(list.items.map((n) => [n.id, n.deliveries[0]?.delivered])).toEqual([
      ['n-2', false],
      [IDS.notification2, true],
      [IDS.notification1, true],
    ]);
    expect((await h.cockpit.request('/api/notifications/n-2/resolve', write('POST', s))).status).toBe(200);
    const open = NotificationsResponse.parse(
      await (
        await h.cockpit.request('/api/notifications?status=open', { headers: { cookie: s.cookie } })
      ).json(),
    );
    expect(open.items.map((n) => n.id)).toEqual([IDS.notification2, IDS.notification1]);
    const audit = AuditResponse.parse(
      await (
        await h.cockpit.request('/api/audit?target=notification:n-2', { headers: { cookie: s.cookie } })
      ).json(),
    );
    expect(audit.items.map((a) => a.action)).toEqual(['notification.resolve']);
  });

  it('设置：只收表里有的键、值要合规、版本对不上 409；改了留记录', async () => {
    const h = harness();
    const s = await h.login();
    const list = SettingsResponse.parse(
      await (await h.cockpit.request('/api/settings', { headers: { cookie: s.cookie } })).json(),
    );
    expect(list.settings.find((x) => x.key === 'notify.quietHours')).toMatchObject({
      value: null,
      version: 0,
    });

    const put = (key: string, body: unknown) =>
      h.cockpit.request(`/api/settings/${key}`, write('PUT', s, body));
    expect(await errorCode(await put('nope', { value: 1, version: 0 }))).toBe('setting_not_found');
    expect(await errorCode(await put('sessions.maxConcurrent', { value: 99, version: 1 }))).toBe(
      'invalid_request',
    );
    expect(await errorCode(await put('sessions.maxConcurrent', { value: 8, version: 0 }))).toBe('conflict');
    const ok = await put('sessions.maxConcurrent', { value: 8, version: 1, reason: '实测压力不大' });
    expect(UpdateSettingResponse.parse(await ok.json()).setting).toMatchObject({
      value: 8,
      version: 2,
      updatedBy: DEV_USER_ID,
    });
    expect(h.store.data.audit.at(-1)).toMatchObject({ action: 'setting.update', before: 6, after: 8 });
    const quiet = await put('notify.quietHours', { value: { start: '23:00', end: '08:00' }, version: 0 });
    expect(quiet.status).toBe(200);
  });

  it('「引擎暂不用独享」（#194）：只收 true/false，别的值拒收；改了留记录、额度页的切号现状跟着带上 soloPaused', async () => {
    const h = harness();
    const s = await h.login();
    const put = (body: unknown) =>
      h.cockpit.request('/api/settings/engine.soloPaused', write('PUT', s, body));
    expect(await errorCode(await put({ value: 'yes', version: 0 }))).toBe('invalid_request');
    expect(await errorCode(await put({ value: 1, version: 0 }))).toBe('invalid_request');
    const ok = await put({ value: true, version: 0, reason: '我自己要大用独享' });
    expect(UpdateSettingResponse.parse(await ok.json()).setting).toMatchObject({ value: true, version: 1 });
    expect(h.store.data.audit.at(-1)).toMatchObject({
      action: 'setting.update',
      target: 'setting:engine.soloPaused',
      after: true,
    });
    const pools = PoolsResponse.parse(
      await (await h.cockpit.request('/api/pools', { headers: { cookie: s.cookie } })).json(),
    );
    expect(pools.orgSwitch).toMatchObject({ soloPaused: true });
  });

  it('各渠道额度留量线（#194 4.8）：负数、大于 1、非数字、未知窗口都拒收；合法的存下、带版本号、进操作记录、可清成 null（不限）', async () => {
    const h = harness();
    const s = await h.login();
    const put = (body: unknown) =>
      h.cockpit.request('/api/settings/engine.quotaReserve', write('PUT', s, body));
    for (const bad of [
      { p: { '7d': -0.1 } },
      { p: { '7d': 1.1 } },
      { p: { '7d': 'x' } },
      { p: { weekly: 0.5 } },
      'on',
      [],
    ]) {
      expect(await errorCode(await put({ value: bad, version: 0 })), JSON.stringify(bad)).toBe(
        'invalid_request',
      );
    }
    const ok = await put({ value: { p: { '5h': 0.8, '7d': null } }, version: 0, reason: '改线' });
    expect(UpdateSettingResponse.parse(await ok.json()).setting).toMatchObject({
      value: { p: { '5h': 0.8, '7d': null } },
      version: 1,
    });
    expect(h.store.data.audit.at(-1)).toMatchObject({
      action: 'setting.update',
      target: 'setting:engine.quotaReserve',
    });
    // 版本号对不上（别人先改了）：409，不悄悄覆盖
    expect((await put({ value: {}, version: 0 })).status).toBe(409);
  });

  describe('整池暂停开关（#746，engine.poolHolds）', () => {
    const hold = (over: Record<string, unknown> = {}) => ({
      reason: '创始人要大用独享',
      decidedBy: '「法国暂时不用独享号」2026-09-27',
      revokeWhen: '创始人说可以用了',
      reviewBy: '2026-12-31',
      ...over,
    });
    const view = async (h: ReturnType<typeof harness>, cookie: string) =>
      PoolHoldsResponse.parse(
        await (await h.cockpit.request('/api/pool-holds', { headers: { cookie } })).json(),
      );

    it('【故意造出的失败】缺字段、日期假的、多字段都拒收；齐全的存下，带版本号、进操作记录', async () => {
      const h = harness();
      const s = await h.login();
      const put = (body: unknown) =>
        h.cockpit.request('/api/settings/engine.poolHolds', write('PUT', s, body));
      for (const bad of [
        { 'claude-solo': hold({ reviewBy: undefined }) },
        { 'claude-solo': hold({ reason: ' ' }) },
        { 'claude-solo': hold({ reviewBy: '2026-02-30' }) },
        { 'claude-solo': hold({ owner: '帅位' }) },
        'on',
        null,
      ]) {
        expect(await errorCode(await put({ value: bad, version: 0 })), JSON.stringify(bad)).toBe(
          'invalid_request',
        );
      }
      const ok = await put({ value: { 'claude-solo': hold() }, version: 0 });
      expect(UpdateSettingResponse.parse(await ok.json()).setting).toMatchObject({ version: 1 });
      expect(h.store.data.audit.at(-1)).toMatchObject({
        action: 'setting.update',
        target: 'setting:engine.poolHolds',
        after: { 'claude-solo': hold() },
      });
      expect((await view(h, s.cookie)).holds.map((x) => x.poolId)).toEqual(['claude-solo']);
    });

    it('【故意造出的失败】撤回、续期没写原因：400，设置不变；写了原因才撤，原因进操作记录；撤完 /api/pool-holds 没有了', async () => {
      const h = harness();
      const s = await h.login();
      const put = (body: unknown) =>
        h.cockpit.request('/api/settings/engine.poolHolds', write('PUT', s, body));
      await put({ value: { 'claude-solo': hold(), 'claude-carpool': hold() }, version: 0 });
      // 撤一个、没写原因
      expect(await errorCode(await put({ value: { 'claude-carpool': hold() }, version: 1 }))).toBe(
        'reason_required',
      );
      // 续期（改复查日期）没写原因
      expect(
        await errorCode(
          await put({
            value: { 'claude-solo': hold({ reviewBy: '2027-01-31' }), 'claude-carpool': hold() },
            version: 1,
            reason: '  ',
          }),
        ),
      ).toBe('reason_required');
      expect((await view(h, s.cookie)).holds).toHaveLength(2);
      const revoked = await put({
        value: { 'claude-carpool': hold() },
        version: 1,
        reason: '创始人 10-05 说独享正常跑',
      });
      expect(revoked.status).toBe(200);
      expect(h.store.data.audit.at(-1)).toMatchObject({
        target: 'setting:engine.poolHolds',
        reason: '创始人 10-05 说独享正常跑',
      });
      expect((await view(h, s.cookie)).holds.map((x) => x.poolId)).toEqual(['claude-carpool']);
      // 新建一条不用写原因
      expect(
        (await put({ value: { 'claude-carpool': hold(), 'claude-solo': hold() }, version: 2 })).status,
      ).toBe(200);
    });

    it('/api/pool-holds：到期标红但还在名单里（不自动撤）；旧的 pool-hold 提醒列出来提示迁成开关；已处理的不算', async () => {
      const h = harness();
      const s = await h.login();
      // 假钟是 2026-09-25 16:00（北京）：9-24 是昨天
      const yesterday = '2026-09-24';
      await h.cockpit.request(
        '/api/settings/engine.poolHolds',
        write('PUT', s, { value: { 'claude-solo': hold({ reviewBy: yesterday }) }, version: 0 }),
      );
      for (const [id, key, resolvedAt] of [
        ['n-hold-1', 'pool-hold:claude-solo', undefined],
        ['n-hold-2', 'pool-hold:claude-carpool', undefined],
        ['n-hold-3', 'pool-hold:old', h.clock.now.toISOString()],
      ] as const) {
        h.store.data.notifications.push({
          id,
          level: 'decision',
          title: `账号池 ${key.slice(10)} 整池暂停：登录失效`,
          body: '占位',
          createdAt: h.clock.now.toISOString(),
          dedupeKey: key,
          deliveries: [],
          ...(resolvedAt ? { resolvedAt } : {}),
        });
      }
      const v = await view(h, s.cookie);
      expect(v.holds[0]).toMatchObject({ poolId: 'claude-solo', overdue: true });
      expect(v.holds[0]?.overdueDays).toBeGreaterThanOrEqual(1);
      expect(v.legacy.map((l) => [l.poolId, l.alsoSwitched]).sort()).toEqual([
        ['claude-carpool', false],
        ['claude-solo', true],
      ]);
      expect(v.problems).toEqual([]);
      expect(v.legacyProblem).toBeUndefined();
    });

    it('【故意造出的失败】库里存的值认不出（被人直接改库）：/api/pool-holds 明说认不出、所有池按暂停办，不是「没有暂停」；修它也要写原因', async () => {
      const h = harness();
      const s = await h.login();
      h.store.data.settings.push({
        key: 'engine.poolHolds',
        value: '停',
        version: 4,
        updatedAt: h.clock.now.toISOString(),
        updatedBy: 'x',
      });
      const v = await view(h, s.cookie);
      expect(v.holdAll).toBe(true);
      expect(v.problems[0]?.why).toContain('所有账号池按暂停办');
      const put = (body: unknown) =>
        h.cockpit.request('/api/settings/engine.poolHolds', write('PUT', s, body));
      expect(await errorCode(await put({ value: {}, version: 4 }))).toBe('reason_required');
      expect((await put({ value: {}, version: 4, reason: '清掉被改坏的值' })).status).toBe(200);
      expect((await view(h, s.cookie)).holdAll).toBe(false);
    });
  });
});
