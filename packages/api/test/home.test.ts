// 新主页 /api/home（#589）：一屏三块 + 持续状态条，一个往返聚齐。
// 内存版和 PG 版都回港一次（PGlite 真迁移）；语义（怎么分三块、verified_pending 不写成失败、读不到不容空）都在这里按内存版测。
import { createTestDb, TEST_DB_TIMEOUT_MS, type TestDb } from '@fleet-dao/db/testing';
import { HomeResponseSchema, WEB_API_PREFIX, WebRoutes } from '@fleet-dao/shared';
import type { MemoryData } from '@fleet-dao/store';
import { devFixtures, IDS } from '@fleet-dao/store';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { type Harness, type HarnessOptions, harness, pgHarness, T0 } from './harness.ts';

const HOME_PATH = WEB_API_PREFIX + WebRoutes.home.path;

async function getHome(h: Pick<Harness, 'cockpit' | 'login'>) {
  const { cookie } = await h.login();
  return h.cockpit.request(HOME_PATH, { headers: { cookie } });
}

/** 一条旧会话留下的未答追问：共享 fixture 不带（agent / 契约 / 飞书 outbox 都按全表条数断言），主页的测试自己种——为了证明主页不再放追问（#928）。 */
function pendingAsk(): MemoryData['asks'][number] {
  return {
    id: 'a0000000-0000-4000-8000-0000000000a1',
    taskId: IDS.task12,
    runId: 'd0000000-0000-4000-8000-000000000001',
    question: '验证码短信的模板用通用模板还是单独报备？单独报备要等一两天审核。',
    options: ['先用通用模板', '单独报备'],
    askedAt: T0.toISOString(),
    scope: 'task',
    recommended: '先用通用模板',
  };
}

describe('/api/home（内存版）', () => {
  it('三块聚齐：decision（approval 通知，库里有未答的旧追问也不进来）、running（在跑的单）、done（merged PR 反查 issue），health 三格', async () => {
    const h = harness({ data: { ...devFixtures(T0), asks: [pendingAsk()] } });
    const res = await getHome(h);
    expect(res.status).toBe(200);
    const home = HomeResponseSchema.parse(await res.json());

    // 要你拍的：fixture 里一条 approval 的 decision 通知。库里种了一条未答追问，它不在这里（v3 没有 AI 追问，答了没人收；
    // 旧追问在通知中心只读展示，#928）：既没有 kind=ask 的，也没有用它的编号、问题原文冒出来的。
    const kinds: string[] = home.decisions.map((d) => d.kind);
    expect(kinds).toContain('approval');
    expect(kinds).not.toContain('ask');
    expect(home.decisions.some((d) => d.id === pendingAsk().id)).toBe(false);
    expect(JSON.stringify(home.decisions)).not.toContain('验证码短信的模板');
    const approval = home.decisions.find((d) => d.kind === 'approval');
    expect(approval?.title).toContain('等你批');
    // approval 通知只算一回（不另查 approvals 表重复列）。
    expect(home.decisions.filter((d) => d.kind === 'approval')).toHaveLength(1);

    // 在跑的：task12 在跑（running），task13 已经 done 不出现；segment 还没接上一律 null（不许猜成失败）。
    expect(home.running.map((r) => r.issueNumber)).toEqual([12]);
    expect(home.running[0]?.segment).toBeNull();
    expect(home.running[0]?.waitingReason).toBe('nothing');

    // 做完的：merged PR #39，反查到挂的单 #13 的标题；开着的 #41 不在这里。
    expect(home.done.map((d) => d.prNumber)).toEqual([39]);
    expect(home.done[0]?.title).toBe('README 加一行当前时间');
    expect(home.done[0]?.repo).toBe('example/canary');
    expect(home.done[0]?.issueNumber).toBe(13);

    // 持续状态：额度有读成也有没读成的、路由有探不通的（fixture 路由全 ok 时 ok；这里 relay 都在线）、引擎开着。
    expect(home.health.quota.state).toBe('ok');
    expect(home.health.routes.state).toBe('ok');
    // 这个测试装配没有引擎探针：写「没查成」，不冒充正常（引擎那一格的各种状态见下面「引擎那一格」）
    expect(home.health.engine.state).toBe('unknown');
  });

  it('未验不误红：需求卡在 asking 只显示「等你拍」，verify 有排队会话只显示「排队」，都不是 failed', async () => {
    const h = harness();
    const task = h.store.data.tasks.find((t) => t.id === IDS.task12);
    if (!task) throw new Error('样例数据里没有任务');
    task.state = 'asking';
    const res = await getHome(h);
    const home = HomeResponseSchema.parse(await res.json());
    const item = home.running.find((r) => r.issueNumber === 12);
    expect(item?.waitingReason).toBe('founder_decision');
    // waitingReason 枚举里没有 fail 这回事；「还没验」（verify_pending）连出现都不出现：segment 一律 null。
    expect(home.running.every((r) => r.segment === null)).toBe(true);
    expect(JSON.stringify(home)).not.toContain('fail');
  });

  describe('三段流水线图（running 的 segment / worker / lastEvent、flow 三格）', () => {
    const ago = (m: number) => new Date(T0.getTime() - m * 60_000).toISOString();
    let n = 0;
    const seg = (
      h: ReturnType<typeof harness>,
      row: Omit<MemoryData['segmentRuns'][number], 'id' | 'taskId' | 'model'> &
        Partial<Pick<MemoryData['segmentRuns'][number], 'taskId' | 'model'>>,
    ) => {
      n += 1;
      h.store.data.segmentRuns.push({
        id: `d2000000-0000-4000-8000-${String(n).padStart(12, '0')}`,
        taskId: IDS.task12,
        model: 'opus-5.5',
        ...row,
      });
    };
    const homeOf = async (h: ReturnType<typeof harness>) =>
      HomeResponseSchema.parse(await (await getHome(h)).json());

    it('动手那一笔在跑：落在 doing，谁在做是模型名，本段从这一笔开跑起算，最近事件是「动手开跑」', async () => {
      const h = harness();
      seg(h, { segment: 'scope', startedAt: ago(40), endedAt: ago(30), outcome: 'done' });
      seg(h, { segment: 'manual', tier: 'fast', startedAt: ago(12) });
      const home = await homeOf(h);
      expect(home.running[0]).toMatchObject({
        issueNumber: 12,
        segment: 'doing',
        waitingReason: 'nothing',
        worker: 'Opus 5.5',
        stageSince: ago(12),
        lastEvent: { text: '动手开跑 · Opus 5.5', at: ago(12), tone: 'ok' },
      });
      expect(home.running[0]?.taskSince).toBeDefined();
    });

    it('动手收了、验收还没起：是 verify_pending，等第二意见，没有人在做，不是失败', async () => {
      const h = harness();
      seg(h, { segment: 'scope', startedAt: ago(60), endedAt: ago(50), outcome: 'done' });
      seg(h, { segment: 'manual', startedAt: ago(48), endedAt: ago(20), outcome: 'done' });
      const home = await homeOf(h);
      const r = home.running[0];
      expect(r).toMatchObject({
        segment: 'verify_pending',
        waitingReason: 'verify_round',
        waitingSince: ago(20),
        stageSince: ago(20),
        lastEvent: { tone: 'ok' },
      });
      expect(r?.worker).toBeUndefined();
    });

    it('验收收了：落在 merge，等合并队列；单子自己是合并中也归 merge', async () => {
      const h = harness();
      seg(h, { segment: 'verify', startedAt: ago(30), endedAt: ago(10), outcome: 'done' });
      expect((await homeOf(h)).running[0]).toMatchObject({ segment: 'merge', waitingReason: 'merge_queue' });
      const h2 = harness();
      const task = h2.store.data.tasks.find((t) => t.id === IDS.task12);
      if (!task) throw new Error('样例数据里没有任务');
      task.state = 'merging';
      seg(h2, { segment: 'manual', startedAt: ago(30) });
      expect((await homeOf(h2)).running[0]?.segment).toBe('merge');
    });

    it('这一段超时了：还在动手段、没人在做、最近事件是 trouble 并带原因；切号停下是 wait 不是失败', async () => {
      const h = harness();
      seg(h, {
        segment: 'manual',
        startedAt: ago(50),
        endedAt: ago(20),
        outcome: 'timeout',
        failureReason: '30 分钟没交活，按超时收了',
      });
      const r = (await homeOf(h)).running[0];
      expect(r).toMatchObject({
        segment: 'doing',
        lastEvent: { text: '动手超时：30 分钟没交活，按超时收了', tone: 'trouble' },
      });
      expect(r?.worker).toBeUndefined();
      const h2 = harness();
      seg(h2, { segment: 'manual', startedAt: ago(50), endedAt: ago(20), outcome: 'org_switch' });
      expect((await homeOf(h2)).running[0]?.lastEvent).toMatchObject({ tone: 'wait' });
    });

    it('一笔流水都没有、状态也推不出（跑着、没排队）：segment 是 null，不猜；排队中的算还没开始对题', async () => {
      const h = harness();
      expect((await homeOf(h)).running[0]).toMatchObject({ issueNumber: 12, segment: null });
      const h2 = harness();
      const task = h2.store.data.tasks.find((t) => t.id === IDS.task12);
      if (!task) throw new Error('样例数据里没有任务');
      task.state = 'queued';
      expect((await homeOf(h2)).running[0]?.segment).toBe('scoping');
    });

    it('段名认不出的那一笔不算数：不参与「最近一笔」，也不进平均', async () => {
      const h = harness();
      seg(h, { segment: 'scope', startedAt: ago(60), endedAt: ago(50), outcome: 'done' });
      seg(h, {
        segment: 'fusion-execute' as 'manual',
        startedAt: ago(40),
        endedAt: ago(30),
        outcome: 'done',
      });
      const home = await homeOf(h);
      expect(home.running[0]?.segment).toBe('doing'); // 按 scope 收了推出来的，不是被那笔怪的带偏
      // 样例里 #13 的对题（7 分钟）和动手（25 分钟）也在窗口里；怪的那笔不进样本
      expect(home.flow.map((f) => f.samples)).toEqual([2, 1, 0]);
    });

    it('asking 的单（只有旧会话留下的会是这个状态）：照样标「等你拍」，等的那件事只认 decision 通知，库里的追问不再借它冒出来', async () => {
      const h = harness({ data: { ...devFixtures(T0), asks: [pendingAsk()] } });
      const task = h.store.data.tasks.find((t) => t.id === IDS.task12);
      if (!task) throw new Error('样例数据里没有任务');
      task.state = 'asking';
      const r = (await homeOf(h)).running.find((x) => x.issueNumber === 12);
      expect(r).toMatchObject({
        waitingReason: 'founder_decision',
        pendingDecision: expect.stringContaining('等你批'),
      });
      expect(r?.pendingDecision).not.toContain('验证码短信的模板');
      // 起点是那条通知的时刻，不是追问的提问时刻（T0）
      expect(r?.waitingSince).toBeDefined();
      expect(r?.waitingSince).not.toBe(T0.toISOString());
    });

    it('flow 三格：固定对题→动手→验收；在途按泳道数；平均只用 done 且起止读得出的；没有样本不给平均（不是 0）', async () => {
      const h = harness();
      seg(h, { segment: 'scope', startedAt: ago(100), endedAt: ago(90), outcome: 'done' });
      seg(h, {
        segment: 'scope',
        taskId: IDS.task13,
        startedAt: ago(100),
        endedAt: ago(80),
        outcome: 'done',
      });
      seg(h, { segment: 'manual', startedAt: ago(70), endedAt: ago(40), outcome: 'timeout' });
      seg(h, { segment: 'manual', startedAt: ago(35) });
      const home = await homeOf(h);
      expect(home.flow.map((f) => f.segment)).toEqual(['scope', 'manual', 'verify']);
      // 样例里 #13 自己还有一笔对题（7 分钟）、动手（25 分钟，另一笔超时）在窗口里：对题 (7+10+20)/3 分钟
      expect(home.flow[0]).toEqual({ segment: 'scope', inFlight: 0, avgMs: 740_000, samples: 3 });
      // 动手：超时的两笔和还在跑的一笔都不算样本，只有 #13 那笔 25 分钟；在途 1 张
      expect(home.flow[1]).toEqual({ segment: 'manual', inFlight: 1, avgMs: 25 * 60_000, samples: 1 });
      // 验收：#13 那笔 task_id 没记（老行），主页这条路不收 → 没有样本，不给平均
      expect(home.flow[2]).toEqual({ segment: 'verify', inFlight: 0, samples: 0 });
      expect(home.flow[2]?.avgMs).toBeUndefined();
    });
  });

  it('故意造红：三段流水读不到（listSegmentRunsForTasks 抛错）就是 500，流水线图不拿空图顶', async () => {
    const h = harness();
    h.store.listSegmentRunsForTasks = async () => {
      throw new Error('runs 表读不到');
    };
    expect((await getHome(h)).status).toBe(500);
  });

  it('持续状态条：有池快清零显示 tight（不是失败红）；有路由探不通显示 degraded；引擎关着显示 off', async () => {
    const h = harness({ config: { engineOff: true } });
    const claudeWin = h.store.data.quotaWindows.find((w) => w.poolId === 'pool-claude-a' && w.label === '5h');
    if (!claudeWin) throw new Error('样例数据里没有这个额度窗');
    claudeWin.utilization = 0.95;
    const route = h.store.data.routes.find((r) => r.id === 'rt-mirasim-kimi');
    if (!route) throw new Error('样例数据里没有这条路由');
    route.alive = false;
    route.probe = { state: 'failed', at: T0.toISOString(), detail: '连探两次都没通' };
    const res = await getHome(h);
    const home = HomeResponseSchema.parse(await res.json());
    expect(home.health.quota.state).toBe('tight');
    expect(home.health.quota.detail).toContain('Claude 订阅');
    expect(home.health.routes.state).toBe('degraded');
    expect(home.health.routes.detail).toContain('1 条路由探不通');
    expect(home.health.routes.detail).toContain('3 条在线');
    expect(home.health.engine.state).toBe('off');
    expect(home.health.engine.detail).toContain('FLEET_SERVICES');
  });

  it('故意造红：库读不到（notifications 抛错）就是 500，不拿「空主页」顶', async () => {
    const h = harness();
    h.store.listNotifications = async () => {
      throw new Error('库连不上');
    };
    const res = await getHome(h);
    expect(res.status).toBe(500);
  });

  it('故意造红：额度读不到（listPools 抛错）就是 500，健康条不伪装成 unknown', async () => {
    const h = harness();
    h.store.listPools = async () => {
      throw new Error('额度表读不到');
    };
    const res = await getHome(h);
    expect(res.status).toBe(500);
  });

  it('故意造红：PR 镜像读不到（listPullRequests 抛错）就是 500，「做完的」不拿空数组顶', async () => {
    const h = harness();
    h.store.listPullRequests = async () => {
      throw new Error('PR 镜像读不到');
    };
    const res = await getHome(h);
    expect(res.status).toBe(500);
  });

  it('merged PR 挂的单不在看板窗口里（早进终态）：照样反查出标题', async () => {
    const h = harness();
    // task13 是 done 且 created 600 分钟前——listBoardTasks 的 7 天窗口还罩得住；把点单时刻挪到 20 天前再进终态。
    const task = h.store.data.tasks.find((t) => t.id === IDS.task13);
    if (!task) throw new Error('样例数据里没有任务');
    const longAgo = new Date(T0.getTime() - 20 * 24 * 60 * 60_000).toISOString();
    task.createdAt = longAgo;
    for (const c of h.store.data.stateChanges) {
      if (c.entityId === IDS.task13) c.at = longAgo;
    }
    const res = await getHome(h);
    const home = HomeResponseSchema.parse(await res.json());
    const done = home.done.find((d) => d.prNumber === 39);
    expect(done?.title).toBe('README 加一行当前时间');
    expect(done?.issueNumber).toBe(13);
  });

  it('没登录 401', async () => {
    const h = harness();
    const res = await h.cockpit.request(HOME_PATH);
    expect(res.status).toBe(401);
  });
});

// —— PG 版：换真库回港一次，形状和数据一个不少 ——
let t: TestDb;
beforeAll(async () => {
  t = await createTestDb();
}, TEST_DB_TIMEOUT_MS);
afterAll(() => t.close());

let current: Awaited<ReturnType<typeof pgHarness>> | undefined;
afterEach(async () => {
  await current?.stop();
  current = undefined;
});

async function start(options: HarnessOptions = {}) {
  current = await pgHarness(t, options);
  return current;
}

describe('/api/home（PG 版）', () => {
  it('换真库照样聚齐三块：approval 通知认出 dedupeKey、merged PR 按合并时刻、形状过契约', async () => {
    const h = await start({ data: { ...devFixtures(T0), asks: [pendingAsk()] } });
    const { cookie } = await h.login();
    const res = await h.cockpit.request(HOME_PATH, { headers: { cookie } });
    expect(res.status).toBe(200);
    const home = HomeResponseSchema.parse(await res.json());
    expect(home.decisions.map((d) => d.kind)).toContain('approval');
    expect(home.decisions.map((d) => String(d.kind))).not.toContain('ask');
    expect(home.running.map((r) => r.issueNumber)).toEqual([12]);
    expect(home.done.map((d) => d.prNumber)).toEqual([39]);
    expect(home.done[0]?.issueNumber).toBe(13);
    expect(home.health.engine.state).toBe('unknown');
  });

  it('故意造红（PG）：主页不再读追问表——旧追问的表读不到，主页照常 200（读追问的是通知中心那条 /api/asks/legacy）', async () => {
    const h = await start();
    h.store.listPendingAsks = async () => {
      throw new Error('asks 表读不到');
    };
    const { cookie } = await h.login();
    const res = await h.cockpit.request(HOME_PATH, { headers: { cookie } });
    expect(res.status).toBe(200);
  });
});
