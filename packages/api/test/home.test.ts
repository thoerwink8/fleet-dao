// 新主页 /api/home（#589）：一屏三块 + 持续状态条，一个往返聚齐。
// 内存版和 PG 版都回港一次（PGlite 真迁移）；语义（怎么分三块、verified_pending 不写成失败、读不到不容空）都在这里按内存版测。
import { createTestDb, TEST_DB_TIMEOUT_MS, type TestDb } from '@fleet-dao/db/testing';
import { HomeResponseSchema, WEB_API_PREFIX, WebRoutes } from '@fleet-dao/shared';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { devFixtures, IDS } from '../src/dev-fixtures.ts';
import type { MemoryData } from '../src/memory-store.ts';
import { type Harness, type HarnessOptions, harness, pgHarness, T0 } from './harness.ts';

const HOME_PATH = WEB_API_PREFIX + WebRoutes.home.path;

async function getHome(h: Pick<Harness, 'cockpit' | 'login'>) {
  const { cookie } = await h.login();
  return h.cockpit.request(HOME_PATH, { headers: { cookie } });
}

/** 主页「要你拍的」要一条未答追问：共享 fixture 不带（agent / 契约 / 飞书 outbox 都按全表条数断言），主页的测试自己种。 */
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
  it('三块聚齐：decision（approval 通知 + 未答追问）、running（在跑的单）、done（merged PR 反查 issue），health 三格', async () => {
    const h = harness({ data: { ...devFixtures(T0), asks: [pendingAsk()] } });
    const res = await getHome(h);
    expect(res.status).toBe(200);
    const home = HomeResponseSchema.parse(await res.json());

    // 要你拍的：fixture 里一条 approval 的 decision 通知 + 一条普通 decision 通知（测试里加的）+ 一条未答追问。
    const kinds = home.decisions.map((d) => d.kind);
    expect(kinds).toContain('approval');
    expect(kinds).toContain('ask');
    const approval = home.decisions.find((d) => d.kind === 'approval');
    expect(approval?.title).toContain('等你批');
    // approval 通知只算一回（不另查 approvals 表重复列）。
    expect(home.decisions.filter((d) => d.kind === 'approval')).toHaveLength(1);
    const ask = home.decisions.find((d) => d.kind === 'ask');
    expect(ask?.link).toBe(`/tasks/${IDS.task12}`);
    expect(ask?.context).toContain('#12');

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
    expect(home.health.engine.state).toBe('on');
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
    expect(home.decisions.map((d) => d.kind)).toContain('ask');
    expect(home.running.map((r) => r.issueNumber)).toEqual([12]);
    expect(home.done.map((d) => d.prNumber)).toEqual([39]);
    expect(home.done[0]?.issueNumber).toBe(13);
    expect(home.health.engine.state).toBe('on');
  });

  it('故意造红（PG）：listPendingAsks 读不到就是 500', async () => {
    const h = await start();
    h.store.listPendingAsks = async () => {
      throw new Error('asks 表读不到');
    };
    const { cookie } = await h.login();
    const res = await h.cockpit.request(HOME_PATH, { headers: { cookie } });
    expect(res.status).toBe(500);
  });
});
