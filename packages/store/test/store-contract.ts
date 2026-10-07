// Store 契约测试：ports.ts 写下的语义，内存版（参照实现）和 Postgres 版都得过同一套。
// 两个实现各有一个入口文件（store.memory.test.ts / store.pg.test.ts）调 describeStoreContract。
import { beforeEach, describe, expect, it } from 'vitest';
import { DEV_USER_ID, devFixtures, IDS } from '../src/dev-fixtures.ts';
import type { MemoryData } from '../src/memory-store.ts';
import {
  type GitHubObjectVersion,
  InvalidCursorError,
  type NewAuditEntry,
  type NewGitHubDelivery,
  type NewIssueTask,
  type Store,
} from '../src/ports.ts';

export const T0 = new Date('2026-09-25T08:00:00.000Z');
const MIN = 60_000;
const DAY = 24 * 60 * MIN;

export interface StoreUnderTest {
  store: Store;
  /** 把某个需求「进入当前状态」的时刻挪到 at（造「很早以前就结束了」的需求）。 */
  backdateState(taskId: string, at: Date): Promise<void>;
}

/** 用 data 建一个全新的 Store；clock.now 就是它的「现在」。 */
export type MakeStore = (data: Partial<MemoryData>, clock: { now: Date }) => Promise<StoreUnderTest>;

const OTHER_UUID = '99999999-0000-4000-8000-000000000000';
const TASKLESS_RUN = 'd0000000-0000-4000-8000-0000000000ff';
/** 三段流水里不该算进 #13 的三笔：别的仓同号（记了别的仓的工作流编号）、记了别的单的 task_id（单号却也是 13）、task_id 和工作流编号都没记（分不出是哪个仓的）。 */
const OTHER_REPO_SEG = 'd1000000-0000-4000-8000-0000000130ff';
const OTHER_TASK_SEG = 'd1000000-0000-4000-8000-0000000130fe';
const ORPHAN_SEG = 'd1000000-0000-4000-8000-0000000130fd';
/** #13 已经结束了还开着的一段（没记结束、没记结局）：Store 照原样给，算不算在跑由任务详情判。 */
const STALE_SEG = 'd1000000-0000-4000-8000-000000013005';
/** 接活时新建的任务。 */
const NEW_TASK = 'b0000000-0000-4000-8000-000000000040';

const audit = (over: Partial<NewAuditEntry> = {}): NewAuditEntry => ({
  actor: { kind: 'user', id: DEV_USER_ID },
  action: 'test.action',
  target: `task:${IDS.task12}`,
  via: 'cockpit',
  ok: true,
  ...over,
});
/** 违反「ok=false 必须带原因」的操作记录：拿它测「操作记录写不进，改动一起回滚」。 */
const badAudit = (): NewAuditEntry => audit({ ok: false });

/** 样例数据再加几样契约要用的：不属于需求的会话、模型组额度窗（超额）、PR 镜像、另一位创始人的 union_id。 */
function contractData(): Partial<MemoryData> {
  const data = devFixtures(T0);
  const ago = (m: number) => new Date(T0.getTime() - m * MIN).toISOString();
  data.users = (data.users ?? []).map((u) =>
    u.id === IDS.founderB ? { ...u, feishuUnionId: 'on_founder_b' } : u,
  );
  data.runs = [
    ...(data.runs ?? []),
    {
      id: TASKLESS_RUN,
      stage: 'judge',
      routeId: 'rt-claude-opus',
      whyRoute: '帅位会话',
      queuedAt: ago(5),
      startedAt: ago(4),
    },
  ];
  data.segmentRuns = [
    ...(data.segmentRuns ?? []),
    {
      id: OTHER_REPO_SEG,
      segment: 'manual',
      issueNumber: 13,
      model: 'opus-5.5',
      startedAt: ago(530),
      endedAt: ago(520),
      outcome: 'done',
      workflowId: 'task:example/other#13',
    },
    {
      id: ORPHAN_SEG,
      segment: 'manual',
      issueNumber: 13,
      model: 'opus-5.5',
      startedAt: ago(528),
      endedAt: ago(524),
      outcome: 'done',
    },
    {
      id: OTHER_TASK_SEG,
      segment: 'manual',
      taskId: IDS.task12,
      issueNumber: 13,
      model: 'opus-5.5',
      startedAt: ago(30),
      endedAt: ago(25),
      outcome: 'done',
    },
    {
      id: STALE_SEG,
      segment: 'verify',
      taskId: IDS.task13,
      issueNumber: 13,
      model: 'gpt-5.6',
      startedAt: ago(505),
    },
  ];
  data.channelStates = [
    {
      channelId: 'ch-mirasim',
      status: 'disabled',
      reason: '上游断连（已重试 2 次）',
      failedRouteId: 'rt-mirasim-kimi',
      fallbackChannelId: 'ch-claude',
      fallbackModelId: 'opus-5.5',
      flaggedAt: ago(30),
      updatedAt: ago(30),
    },
  ];
  data.quotaWindows = [
    ...(data.quotaWindows ?? []),
    {
      poolId: 'pool-mirasim',
      label: '7d_fable',
      window: '7d_model',
      scope: 'fable',
      utilization: 1.25,
      unit: 'percent',
      upstreamStatus: 'limit_reached',
      statusRaw: 'rate_limited',
      reading: 'measured',
      source: 'mirasim-relay',
      readAt: ago(1),
    },
    {
      // 上游新出的、归不了类的窗口：照样收下，原名留着。
      poolId: 'pool-mirasim',
      label: 'burst_tokens',
      window: 'other',
      used: 900,
      limit: 1000,
      unit: 'tokens',
      statusRaw: 'throttle_soon',
      reading: 'measured',
      source: 'mirasim-relay',
      readAt: ago(1),
    },
    {
      // 上游这次没再报的窗口：标着过期留在库里。
      poolId: 'pool-mirasim',
      label: '7d_old',
      window: '7d_model',
      scope: 'old',
      utilization: 0.3,
      unit: 'percent',
      reading: 'measured',
      source: 'mirasim-relay',
      readAt: ago(90),
      staleSince: ago(1),
    },
  ];
  data.pools = (data.pools ?? []).map((p) => (p.id === 'pool-mirasim' ? { ...p, lastReadOkAt: ago(1) } : p));
  data.pullRequests = [
    {
      repoId: IDS.repo,
      number: 31,
      state: 'open',
      headRef: 'fleet/12-a',
      headSha: 'abc123',
      checks: 'pending',
    },
  ];
  return data;
}

export function describeStoreContract(name: string, make: MakeStore): void {
  describe(`Store 契约：${name}`, () => {
    let clock: { now: Date };
    let s: StoreUnderTest;
    let store: Store;

    beforeEach(async () => {
      clock = { now: new Date(T0) };
      s = await make(contractData(), clock);
      store = s.store;
    });

    const tick = (ms = 1000) => {
      clock.now = new Date(clock.now.getTime() + ms);
    };

    describe('人', () => {
      it('按编号找人；编号不存在或不是 uuid 都是「没有」，不报错', async () => {
        expect(await store.getUser(IDS.founderA)).toMatchObject({
          id: IDS.founderA,
          displayName: '创始人甲',
          role: 'founder',
          active: true,
          feishuOpenId: 'ou_dev_founder_a',
          githubId: 1001,
        });
        expect(await store.getUser(OTHER_UUID)).toBeNull();
        expect(await store.getUser('not-a-uuid')).toBeNull();
        expect((await store.listUsers()).map((u) => u.id).sort()).toEqual(
          [IDS.founderA, IDS.founderB, IDS.botWorker, IDS.botEngine].sort(),
        );
      });

      it('按飞书 open_id 或 union_id 找人', async () => {
        expect((await store.findUserByFeishu({ openId: 'ou_dev_founder_a' }))?.id).toBe(IDS.founderA);
        expect((await store.findUserByFeishu({ openId: 'ou_x', unionId: 'on_founder_b' }))?.id).toBe(
          IDS.founderB,
        );
        expect(await store.findUserByFeishu({ openId: 'ou_nobody' })).toBeNull();
      });
    });

    // 列表的顺序和「交出去的是副本」：两份实现必须一样（#878 #883 #884）。数据都故意把「写入先后」
    // 摆得和排序规则相反、时刻并列，免得内存版靠写入先后碰巧对上。
    describe('列表的顺序与副本', () => {
      const ago = (m: number) => new Date(T0.getTime() - m * MIN).toISOString();
      const uuid = (n: number) => `e0000000-0000-4000-8000-${String(n).padStart(12, '0')}`;

      it('listUsers：按创建时刻、并列再按编号；和写入先后无关', async () => {
        const u = (n: number, createdAt: string) => ({
          id: uuid(n),
          displayName: `人${n}`,
          role: 'collaborator' as const,
          active: true,
          createdAt,
        });
        // 写入先后 1、3、2；创建时刻 2 和 3 并列且早于 1：应读回 2、3、1。
        const fresh = await make({ users: [u(1, ago(1)), u(3, ago(9)), u(2, ago(9))] }, clock);
        expect((await fresh.store.listUsers()).map((x) => x.id)).toEqual([uuid(2), uuid(3), uuid(1)]);
      });

      it('listUsers、listBans：交出去的是副本，调用方怎么改都不影响库里', async () => {
        const users = await store.listUsers();
        const usersBefore = structuredClone(users);
        users.reverse();
        users.push({ id: OTHER_UUID, displayName: '被加的', role: 'bot', active: true });
        for (const user of users) user.displayName = '被改了';
        expect(await store.listUsers()).toEqual(usersBefore);

        const bans = await store.listBans();
        const bansBefore = structuredClone(bans);
        expect(bansBefore.length).toBeGreaterThan(0);
        bans.reverse();
        bans.push({ family: 'x', reason: '被加的' });
        for (const ban of bans) ban.reason = '被改了';
        expect(await store.listBans()).toEqual(bansBefore);
      });

      it('listBans：按写入先后（库里是自增编号）', async () => {
        const fresh = await make(
          {
            ...contractData(),
            bans: [
              { family: 'kimi', stage: 'ui', reason: '先写的' },
              { family: 'kimi', stage: 'judge', reason: '后写的' },
            ],
          },
          clock,
        );
        expect((await fresh.store.listBans()).map((b) => b.reason)).toEqual(['先写的', '后写的']);
      });

      it('listRuns：排队时刻并列时按编号', async () => {
        const run = (id: string) => ({
          id,
          stage: 'judge' as const,
          routeId: 'rt-claude-opus',
          whyRoute: '并列',
          queuedAt: ago(3),
        });
        const data = contractData();
        // 写入先后 b、a，排队时刻相同：应读回 a、b。
        data.runs = [...(data.runs ?? []), run(uuid(902)), run(uuid(901))];
        const fresh = await make(data, clock);
        const tail = (await fresh.store.listRuns({}))
          .map((r) => r.id)
          .filter((id) => id.startsWith('e0000000'));
        expect(tail).toEqual([uuid(901), uuid(902)]);
      });

      it('listPullRequests：merged 按合并时刻倒序，没读到合并时刻的排最后（不拿更新时刻顶），并列按编号倒序', async () => {
        const pr = (number: number, over: { mergedAt?: string; updatedAt: string }) => ({
          repoId: IDS.repo,
          number,
          state: 'merged' as const,
          headRef: `fleet/pr-${number}`,
          headSha: `sha${number}`,
          checks: 'success' as const,
          ...over,
        });
        const data = contractData();
        data.pullRequests = [
          pr(42, { updatedAt: ago(0) }), // 合并时刻没读到、更新时刻最新：不能排前面
          pr(41, { mergedAt: ago(20), updatedAt: ago(20) }),
          pr(43, { updatedAt: ago(30) }), // 同样没读到，编号大的在前
          pr(40, { mergedAt: ago(10), updatedAt: ago(10) }),
          pr(44, { mergedAt: ago(10), updatedAt: ago(10) }), // 合并时刻并列，编号大的在前
        ];
        const fresh = await make(data, clock);
        expect((await fresh.store.listPullRequests({ state: 'merged' })).map((p) => p.number)).toEqual([
          44, 40, 41, 43, 42,
        ]);
      });
    });

    describe('仓、需求、子任务、会话', () => {
      it('仓', async () => {
        expect(await store.listRepos()).toEqual([
          {
            id: IDS.repo,
            owner: 'example',
            name: 'canary',
            defaultBranch: 'main',
            testCommand: 'pnpm check',
          },
        ]);
        expect(await store.getRepo('repo-1')).toBeNull();
      });

      it('看板上的需求：没结束的和刚结束的，按优先级排；别的仓、看不懂的编号是空', async () => {
        expect((await store.listBoardTasks(IDS.repo)).map((t) => t.id)).toEqual([IDS.task12, IDS.task13]);
        expect(await store.listBoardTasks(OTHER_UUID)).toEqual([]);
        expect(await store.listBoardTasks('nope')).toEqual([]);
      });

      it('进入终态超过 7 天的需求不上看板', async () => {
        await s.backdateState(IDS.task13, new Date(T0.getTime() - 8 * DAY));
        expect((await store.listBoardTasks(IDS.repo)).map((t) => t.id)).toEqual([IDS.task12]);
      });

      it('需求与子任务（带依赖、按序号排）', async () => {
        const task = await store.getTask(IDS.task12);
        expect(task).toMatchObject({
          issueNumber: 12,
          state: 'running',
          acceptance: ['验证码 5 分钟过期', '同一手机号 60 秒内只能发一次'],
        });
        expect(await store.getTask('task-12')).toBeNull();
        const subtasks = await store.listSubtasks([IDS.task12, 'bad-id']);
        expect(subtasks.map((st) => [st.id, st.index, st.dependsOn])).toEqual([
          [IDS.sub12a, 0, []],
          [IDS.sub12b, 1, [IDS.sub12a]],
        ]);
      });

      it('会话：按需求过滤时不含不属于需求的会话；只要没结束的；按排队先后排', async () => {
        const all = await store.listRuns({});
        expect(all.map((r) => r.id)).toEqual([IDS.run0, IDS.run1, TASKLESS_RUN]);
        expect(all.find((r) => r.id === TASKLESS_RUN)?.taskId).toBeUndefined();
        expect((await store.listRuns({ taskIds: [IDS.task12] })).map((r) => r.id)).toEqual([
          IDS.run0,
          IDS.run1,
        ]);
        expect((await store.listRuns({ taskIds: [IDS.task12], active: true })).map((r) => r.id)).toEqual([
          IDS.run1,
        ]);
        expect(await store.listRuns({ taskIds: ['nope'] })).toEqual([]);
        expect(await store.getRun(IDS.run1)).toMatchObject({ branch: 'fleet/12-a', subtaskId: IDS.sub12a });
        expect(await store.getRun('run-1')).toBeNull();
      });

      it('会话的 token 读得回来，缓存读写单列；没读到的（花费、还在跑的那次的用量）不给，不是 0', async () => {
        const done = await store.getRun(IDS.run0);
        expect(done).toMatchObject({
          inputTokens: 120_000,
          outputTokens: 8_000,
          cacheReadTokens: 1_450_000,
          cacheWriteTokens: 64_000,
        });
        expect(done?.costUsd).toBeUndefined();
        const running = await store.getRun(IDS.run1);
        expect([running?.inputTokens, running?.cacheReadTokens, running?.cacheWriteTokens]).toEqual([
          undefined,
          undefined,
          undefined,
        ]);
      });

      it('三段流水：task_id 对上的、task_id 没记但单号和工作流编号都对上的（标明兜底）都给，按起跑先后排', async () => {
        const rows = await store.listSegmentRuns(IDS.task13);
        expect(rows.map((r) => [r.id, r.segment, r.matchedBy])).toEqual([
          [IDS.seg13scope, 'scope', 'task'],
          [IDS.seg13manual1, 'manual', 'task'],
          [IDS.seg13manual2, 'manual', 'task'],
          [IDS.seg13verify, 'verify', 'issueNumber'],
          [STALE_SEG, 'verify', 'task'],
        ]);
      });

      it('三段流水不算进来的：别的仓同号（工作流编号不是这张单的）、task_id 和工作流编号都没记的（分不出是哪个仓）、记了别的单的 task_id；没这张单、编号看不懂是空', async () => {
        const ids = (await store.listSegmentRuns(IDS.task13)).map((r) => r.id);
        expect(ids).not.toContain(OTHER_REPO_SEG);
        expect(ids).not.toContain(OTHER_TASK_SEG);
        expect(ids).not.toContain(ORPHAN_SEG);
        expect((await store.listSegmentRuns(IDS.task12)).map((r) => r.id)).toEqual([OTHER_TASK_SEG]);
        expect(await store.listSegmentRuns(OTHER_UUID)).toEqual([]);
        expect(await store.listSegmentRuns('task-13')).toEqual([]);
      });

      it('三段流水按一批单一次读：只认 task_id 对上的（不按单号兜底），按起跑先后排；编号看不懂的忽略，一张单都没给是空', async () => {
        const rows = await store.listSegmentRunsForTasks([IDS.task13, IDS.task12, 'task-13']);
        expect(rows.map((r) => [r.id, r.matchedBy])).toEqual([
          [IDS.seg13scope, 'task'],
          [IDS.seg13manual1, 'task'],
          [IDS.seg13manual2, 'task'],
          [STALE_SEG, 'task'],
          [OTHER_TASK_SEG, 'task'],
        ]);
        // task_id 没记的两行（单号兜底的那笔验收、孤行）这条路不收；别的单的不混进来
        const only12 = await store.listSegmentRunsForTasks([IDS.task12]);
        expect(only12.map((r) => r.id)).toEqual([OTHER_TASK_SEG]);
        expect(await store.listSegmentRunsForTasks([])).toEqual([]);
        expect(await store.listSegmentRunsForTasks(['task-13', OTHER_UUID])).toEqual([]);
      });

      it('三段流水的读数原样读回：派工档、起止、四样 token、花费、PR；没记的不给（不是 0、不是空字符串）', async () => {
        const rows = await store.listSegmentRuns(IDS.task13);
        const manual1 = rows.find((r) => r.id === IDS.seg13manual1);
        expect(manual1).toMatchObject({
          tier: 'fast',
          channel: 'ch-mirasim',
          outcome: 'timeout',
          failureReason: '30 分钟没交活，按超时收了',
          inputTokens: 64_000,
          outputTokens: 5_200,
          branch: 'fleet/13-readme-time',
        });
        expect([manual1?.cacheReadTokens, manual1?.cacheWriteTokens, manual1?.costUsd]).toEqual([
          undefined,
          undefined,
          undefined,
        ]);
        expect(rows.find((r) => r.id === IDS.seg13manual2)).toMatchObject({
          costUsd: 1.86,
          prNumber: 39,
          cacheReadTokens: 1_120_000,
        });
        const stale = rows.find((r) => r.id === STALE_SEG);
        expect([stale?.endedAt, stale?.outcome, stale?.tier]).toEqual([undefined, undefined, undefined]);
        expect(Date.parse(stale?.startedAt ?? '')).toBe(T0.getTime() - 505 * MIN);
      });
    });

    describe('进度', () => {
      it('步骤清单以最近一次 fleet plan 为准，带序号；没报过的会话不在结果里', async () => {
        const before = await store.getPlans([IDS.run1, IDS.run0]);
        expect([...before.keys()]).toEqual([IDS.run1]);
        expect(before.get(IDS.run1)?.steps.map((st) => [st.index, st.state])).toEqual([
          [0, 'done'],
          [1, 'in_progress'],
          [2, 'pending'],
        ]);
        tick();
        await store.savePlan(IDS.run1, [
          { index: 0, title: '读需求和方案', state: 'done' },
          { index: 1, title: '写实现', state: 'in_progress' },
        ]);
        const after = (await store.getPlans([IDS.run1])).get(IDS.run1);
        expect(after?.steps.map((st) => st.title)).toEqual(['读需求和方案', '写实现']);
        expect(after?.updatedAt).toBe(clock.now.toISOString());
      });

      it('最近一句进度', async () => {
        expect((await store.lastSay(IDS.run1))?.text).toBe('正在写验证码过期的测试');
        tick();
        await store.appendProgress(IDS.run1, 'say', { text: '测试写好了' });
        expect(await store.lastSay(IDS.run1)).toEqual({ text: '测试写好了', at: clock.now.toISOString() });
        expect(await store.lastSay(IDS.run0)).toBeNull();
      });

      it('测试记录：按时间正序；结果认不出的（插头写了原因、或载荷坏了）也列出来、passed 为 null，不悄悄丢掉', async () => {
        tick();
        await store.appendProgress(IDS.run1, 'test', { passed: false, command: 'pnpm check' });
        tick();
        await store.appendProgress(IDS.run1, 'test', { passed: 'maybe' });
        tick();
        await store.appendProgress(IDS.run1, 'test', { passed: true });
        tick();
        await store.appendProgress(IDS.run1, 'test', {
          command: 'pnpm check | tail',
          unknownBecause: '带管道又没开 pipefail，退出码是管道最后一段的',
        });
        const runs = await store.listTestRuns(IDS.run1);
        expect(runs.map((r) => [r.passed, r.command, r.unknownBecause])).toEqual([
          [false, 'pnpm check', undefined],
          [null, undefined, '记录里没有结果'],
          [true, undefined, undefined],
          [null, 'pnpm check | tail', '带管道又没开 pipefail，退出码是管道最后一段的'],
        ]);
      });
    });

    describe('翻页游标', () => {
      it('翻页游标看不懂（拼错、改过、编号不合这张列表）：抛 InvalidCursorError，不装成空页', async () => {
        const at = T0.toISOString();
        for (const cursor of ['garbage', '|x', 'not-a-time|1', `${at}|`]) {
          await expect(store.listAudit({ cursor, limit: 5 }), cursor).rejects.toBeInstanceOf(
            InvalidCursorError,
          );
        }
        // 操作记录的编号是自增数，通知的是 uuid：别的列表的游标拿过来也不认。
        await expect(
          store.listAudit({ cursor: `${at}|${IDS.notification1}`, limit: 5 }),
        ).rejects.toBeInstanceOf(InvalidCursorError);
        await expect(
          store.listNotifications({ status: 'all', cursor: `${at}|42`, limit: 5 }),
        ).rejects.toBeInstanceOf(InvalidCursorError);
        // 自己给出的游标照常能翻。
        await store.appendAudit(audit());
        tick();
        await store.appendAudit(audit());
        const first = await store.listAudit({ limit: 1 });
        expect(first.nextCursor).toBeDefined();
        await store.listAudit({ cursor: first.nextCursor, limit: 1 });
      });

      it('刚好翻完一页整数条：最后一页没有下一页游标；少取一条就有（操作记录、通知同一个判法）', async () => {
        for (let i = 0; i < 3; i++) {
          tick();
          await store.appendAudit(audit());
        }
        const total = (await store.listAudit({ limit: 500 })).items.length;
        expect((await store.listAudit({ limit: total })).nextCursor).toBeUndefined();
        expect((await store.listAudit({ limit: total - 1 })).nextCursor).toBeDefined();
        const notes = (await store.listNotifications({ status: 'all', limit: 500 })).items.length;
        expect((await store.listNotifications({ status: 'all', limit: notes })).nextCursor).toBeUndefined();
        if (notes > 1) {
          expect(
            (await store.listNotifications({ status: 'all', limit: notes - 1 })).nextCursor,
          ).toBeDefined();
        }
      });
    });

    describe('调度台', () => {
      it('渠道、账号池、模型、路由按编号排；阶段策略带顺序；禁令只有库里另配的', async () => {
        expect((await store.listChannels()).map((c) => c.id)).toEqual([
          'ch-claude',
          'ch-cursor',
          'ch-mirasim',
        ]);
        // 渠道近态（#1118）：只有运行中失败出过事的渠道有行，库里的和内存里的读回来一个样；时刻没填的不带
        expect(await store.listChannelStates()).toEqual([
          {
            channelId: 'ch-mirasim',
            status: 'disabled',
            reason: '上游断连（已重试 2 次）',
            failedRouteId: 'rt-mirasim-kimi',
            fallbackChannelId: 'ch-claude',
            fallbackModelId: 'opus-5.5',
            flaggedAt: new Date(T0.getTime() - 30 * MIN).toISOString(),
            updatedAt: new Date(T0.getTime() - 30 * MIN).toISOString(),
          },
        ]);
        expect((await store.listPools()).map((p) => [p.id, p.lastReadOkAt])).toEqual([
          ['pool-claude-a', new Date(T0.getTime() - 5 * MIN).toISOString()],
          ['pool-cursor', new Date(T0.getTime() - 120 * MIN).toISOString()],
          ['pool-mirasim', new Date(T0.getTime() - MIN).toISOString()],
        ]);
        expect((await store.listModels()).map((m) => m.id)).toEqual([
          'fable-5.1',
          'gpt-5.6',
          'kimi-k3',
          'opus-5.5',
        ]);
        expect((await store.listRoutes()).map((r) => r.id)).toEqual([
          'rt-claude-opus',
          'rt-mirasim-fable',
          'rt-mirasim-gpt',
          'rt-mirasim-kimi',
        ]);
        expect(await store.listBans()).toEqual([
          { family: 'kimi', stage: 'ui', reason: '（样例）库里另配的禁令：Kimi 暂不进 UI' },
        ]);
      });

      it('额度窗：按（池, 原名）排；原名、组名、单位、读法、上游原状态字原样保存；超额（利用率大于 1）原样保存', async () => {
        const windows = await store.listQuotaWindows();
        expect(windows.map((w) => `${w.poolId}/${w.label}`)).toEqual([
          'pool-claude-a/5h',
          'pool-claude-a/7d',
          'pool-cursor/month_usd',
          'pool-mirasim/7d_fable',
          'pool-mirasim/7d_old',
          'pool-mirasim/burst_tokens',
        ]);
        expect(windows.find((w) => w.label === '7d_old')).toMatchObject({
          readAt: new Date(T0.getTime() - 90 * MIN).toISOString(),
          staleSince: new Date(T0.getTime() - MIN).toISOString(),
        });
        expect(windows.find((w) => w.label === '7d_fable')?.staleSince).toBeUndefined();
        expect(windows.find((w) => w.label === '7d_fable')).toEqual({
          poolId: 'pool-mirasim',
          label: '7d_fable',
          window: '7d_model',
          scope: 'fable',
          utilization: 1.25,
          unit: 'percent',
          upstreamStatus: 'limit_reached',
          statusRaw: 'rate_limited',
          reading: 'measured',
          source: 'mirasim-relay',
          readAt: new Date(T0.getTime() - MIN).toISOString(),
        });
        expect(windows.find((w) => w.label === 'burst_tokens')).toMatchObject({
          window: 'other',
          used: 900,
          limit: 1000,
          unit: 'tokens',
          statusRaw: 'throttle_soon',
        });
      });

      it('上下架渠道：写操作记录；没有的渠道 not_found、不留记录', async () => {
        const auditsBefore = (await store.listAudit({ limit: 200 })).items.length;
        expect(await store.setChannelEnabled({ channelId: 'ch-cursor', enabled: false }, audit())).toBe('ok');
        expect((await store.listChannels()).find((c) => c.id === 'ch-cursor')?.enabled).toBe(false);
        expect(await store.setChannelEnabled({ channelId: 'nope', enabled: false }, audit())).toBe(
          'not_found',
        );
        expect((await store.listAudit({ limit: 200 })).items.length).toBe(auditsBefore + 1);
      });
    });

    describe('定时任务、通知、操作记录、设置', () => {
      it('定时任务：最近一次（含四种结局）和最近一次跑成分开给', async () => {
        const jobs = await store.listJobs();
        expect(jobs.map((j) => j.id)).toEqual(['job-quota', 'job-reconcile']);
        const quota = jobs.find((j) => j.id === 'job-quota');
        expect(quota?.lastRun).toMatchObject({ outcome: 'ok', scanned: 3, found: 0 });
        expect(quota?.lastSuccessAt).toBe(new Date(T0.getTime() - 10 * MIN).toISOString());
        const reconcile = jobs.find((j) => j.id === 'job-reconcile');
        expect(reconcile?.lastRun).toMatchObject({
          outcome: 'unscanned',
          why: 'GitHub 接口限流，一个仓都没扫到',
        });
        expect(reconcile?.lastSuccessAt).toBe(new Date(T0.getTime() - 199 * MIN).toISOString());
      });

      it('通知：只看未处理的；处理掉之后不在里面；送达记录跟着；翻页不重不漏', async () => {
        const open = await store.listNotifications({ status: 'open', limit: 10 });
        expect(open.items.map((n) => n.id)).toEqual([IDS.notification2, IDS.notification1]);
        expect(open.items[1]?.deliveries).toEqual([
          {
            channel: 'feishu',
            messageId: 'om_dev_1',
            attempts: 1,
            lastAttemptAt: new Date(T0.getTime() - 8 * MIN).toISOString(),
          },
        ]);
        const by = { kind: 'user' as const, id: DEV_USER_ID };
        expect(await store.resolveNotification({ id: IDS.notification1, by }, audit())).toBe('ok');
        expect(await store.resolveNotification({ id: IDS.notification1, by }, audit())).toBe(
          'already_resolved',
        );
        expect(await store.resolveNotification({ id: OTHER_UUID, by }, audit())).toBe('not_found');
        expect(await store.resolveNotification({ id: 'nope', by }, audit())).toBe('not_found');
        // 处理掉 notification1，open 里还剩 notification2（approval 那条）。
        expect((await store.listNotifications({ status: 'open', limit: 10 })).items.map((n) => n.id)).toEqual(
          [IDS.notification2],
        );
        const all = await store.listNotifications({ status: 'all', limit: 10 });
        // 刚处理掉的 notification1 带上了处理人和处理时刻；notification2（approval 那条）还开着、没这两条。
        expect(all.items.find((n) => n.id === IDS.notification1)).toMatchObject({
          resolvedBy: DEV_USER_ID,
          resolvedAt: clock.now.toISOString(),
        });
        // notification2（approval 那条）还开着：没被这条 resolve 波及。
        const stillOpen = all.items.find((n) => n.id === IDS.notification2);
        expect(stillOpen?.resolvedAt).toBeUndefined();
        expect(stillOpen?.resolvedBy).toBeUndefined();
      });

      it('操作记录：倒序、按对象过滤、同一毫秒的几条翻页不重不漏；编号是字符串', async () => {
        const ids: string[] = [];
        for (let i = 0; i < 5; i++)
          ids.push(await store.appendAudit(audit({ target: 'channel:x', action: `a${i}` })));
        await store.appendAudit(audit({ target: 'channel:y' }));
        expect(ids.every((id) => typeof id === 'string')).toBe(true);
        const seen: string[] = [];
        let cursor: string | undefined;
        for (let n = 0; n < 10; n++) {
          const page = await store.listAudit({ target: 'channel:x', cursor, limit: 2 });
          seen.push(...page.items.map((a) => a.action));
          cursor = page.nextCursor;
          if (!cursor) break;
        }
        expect(seen).toEqual(['a4', 'a3', 'a2', 'a1', 'a0']);
        const [latest] = (await store.listAudit({ target: 'channel:x', limit: 1 })).items;
        expect(latest).toMatchObject({ actor: { kind: 'user', id: DEV_USER_ID }, via: 'cockpit', ok: true });
      });

      it('操作记录：ok=false 不带原因写不进', async () => {
        await expect(store.appendAudit(badAudit())).rejects.toThrow();
        expect(await store.appendAudit(audit({ ok: false, error: 'workflow_gone' }))).toMatch(/^\d+$/);
      });

      it('设置：版本对上才改；第一次写版本是 1；值可以是 null', async () => {
        const by = { kind: 'user' as const, id: DEV_USER_ID };
        expect((await store.listSettings()).map((x) => [x.key, x.value, x.version])).toEqual([
          ['sessions.maxConcurrent', 6, 1],
        ]);
        expect(
          await store.putSetting(
            { key: 'sessions.maxConcurrent', value: 8, expectedVersion: 0, by },
            audit(),
          ),
        ).toBe('conflict');
        expect(
          await store.putSetting(
            { key: 'sessions.maxConcurrent', value: 8, expectedVersion: 1, by },
            audit(),
          ),
        ).toBe('ok');
        expect(
          await store.putSetting({ key: 'notify.quietHours', value: null, expectedVersion: 0, by }, audit()),
        ).toBe('ok');
        expect(
          await store.putSetting({ key: 'notify.quietHours', value: null, expectedVersion: 0, by }, audit()),
        ).toBe('conflict');
        const settings = new Map((await store.listSettings()).map((x) => [x.key, x]));
        expect(settings.get('sessions.maxConcurrent')).toMatchObject({
          value: 8,
          version: 2,
          updatedBy: DEV_USER_ID,
        });
        expect(settings.get('notify.quietHours')).toMatchObject({ value: null, version: 1 });
      });
    });

    describe('fleet 命令', () => {
      it('会话：分支、做完标准（从需求来）、起会话时交代的测试命令；不属于需求的会话、看不懂的编号都没有', async () => {
        // 测试命令是这次会话开工时记下的（session_runs.test_command），不是仓那一行给人看的旧值 pnpm check
        expect(await store.getAgentSession(IDS.run1)).toEqual({
          runId: IDS.run1,
          taskId: IDS.task12,
          subtaskId: IDS.sub12a,
          stage: 'execute',
          repoId: IDS.repo,
          testCommand: 'pnpm test:changed',
          branch: 'fleet/12-a',
          acceptance: ['验证码 5 分钟过期', '同一手机号 60 秒内只能发一次'],
        });
        const planRun = await store.getAgentSession(IDS.run0);
        expect(planRun?.endedAt).toBe(new Date(T0.getTime() - 20 * MIN).toISOString());
        // 开工时没记（加这一列之前开的会话）：没有就是没有，不拿仓的命令顶
        expect(planRun?.testCommand).toBeUndefined();
        expect(await store.getAgentSession(TASKLESS_RUN)).toBeNull();
        expect(await store.getAgentSession('run-1')).toBeNull();
      });

      it('翻历史：每个词都要命中；只找本仓有需求文档索引的', async () => {
        expect(
          (await store.searchHistory({ repoId: IDS.repo, query: 'readme', limit: 5 })).map((h) => h.taskId),
        ).toEqual([IDS.task13]);
        expect(
          (await store.searchHistory({ repoId: IDS.repo, query: 'README 时间', limit: 5 }))[0],
        ).toMatchObject({ taskId: IDS.task13, resultSummary: '在 README 顶部加了一行，由 CI 每次生成' });
        expect(await store.searchHistory({ repoId: IDS.repo, query: 'README 验证码', limit: 5 })).toEqual([]);
        expect(await store.searchHistory({ repoId: OTHER_UUID, query: 'readme', limit: 5 })).toEqual([]);
      });

      it('PR 镜像', async () => {
        expect(await store.getPullRequest(IDS.repo, 31)).toMatchObject({
          repoId: IDS.repo,
          number: 31,
          state: 'open',
          headRef: 'fleet/12-a',
          headSha: 'abc123',
          checks: 'pending',
        });
        expect(await store.getPullRequest(IDS.repo, 32)).toBeNull();
        expect(await store.getPullRequest('repo-1', 31)).toBeNull();
        // 主页「做完的」读它：merged 按合并时刻倒序、开着的按镜像更新时刻倒序。
        const merged = await store.listPullRequests({ state: 'merged' });
        expect(merged.map((p) => p.number)).toEqual([]);
        const open = await store.listPullRequests({ state: 'open' });
        expect(open.map((p) => p.number)).toEqual([31]);
        expect((await store.listPullRequests()).map((p) => p.number)).toEqual([31]);
      });

      /** 默认不接管任何占用（接管界线在很久以前）。 */
      const LONG_AGO = new Date(0).toISOString();

      /** 占到就拿出凭据；没占到就让测试当场失败。 */
      const tokenOf = (claim: Awaited<ReturnType<Store['claimCommand']>>): string => {
        if (claim.status !== 'claimed') throw new Error(`没占到：${JSON.stringify(claim)}`);
        return claim.token;
      };
      const ok200 = { status: 200, body: { ok: true } };

      it('命令的幂等键：占到（带凭据）→ 做完记结果 → 再来直接拿结果；没做完放掉可以重占；做完的键放不掉', async () => {
        const ids = { runId: IDS.run1, key: 'k-1' };
        const claim = (over: { runId?: string; key?: string; action?: string } = {}) =>
          store.claimCommand({ ...ids, action: 'agent.say', takeOverBefore: LONG_AGO, ...over });
        const first = await claim();
        expect(first).toEqual({ status: 'claimed', token: T0.toISOString() });
        expect(await claim()).toEqual({ status: 'in-flight', claimedAt: T0.toISOString() });
        expect(await store.completeCommand({ ...ids, token: tokenOf(first) }, ok200)).toBe(true);
        expect(await claim()).toEqual({ status: 'done', result: ok200 });
        await store.releaseCommand({ ...ids, token: tokenOf(first) });
        expect((await claim()).status).toBe('done');
        expect(await store.completeCommand({ ...ids, token: tokenOf(first) }, ok200)).toBe(false);

        const other = { runId: IDS.run1, key: 'k-2' };
        const held = await claim({ ...other, action: 'agent.done' });
        await store.releaseCommand({ ...other, token: tokenOf(held) });
        tick();
        expect(await claim({ ...other, action: 'agent.done' })).toEqual({
          status: 'claimed',
          token: clock.now.toISOString(),
        });
        // 键按会话分开：别的会话用同一个键不受影响。
        expect((await claim({ runId: IDS.run0 })).status).toBe('claimed');
      });

      it('命令的幂等键：同一个键用在别的命令上——不管做完没做完，都是 other-action，不回旧结果', async () => {
        const ids = { runId: IDS.run1, key: 'k-reused' };
        const say = await store.claimCommand({ ...ids, action: 'agent.say', takeOverBefore: LONG_AGO });
        expect(await store.claimCommand({ ...ids, action: 'agent.done', takeOverBefore: LONG_AGO })).toEqual({
          status: 'other-action',
          action: 'agent.say',
        });
        await store.completeCommand({ ...ids, token: tokenOf(say) }, ok200);
        tick(61_000);
        expect(
          await store.claimCommand({ ...ids, action: 'agent.plan', takeOverBefore: clock.now.toISOString() }),
        ).toEqual({ status: 'other-action', action: 'agent.say' });
      });

      it('命令的幂等键：界线之前占的、没做完的键可以接过来；同时来接只有一个接得到；做完的不接', async () => {
        const ids = { runId: IDS.run1, key: 'k-stale' };
        expect(
          (await store.claimCommand({ ...ids, action: 'agent.say', takeOverBefore: LONG_AGO })).status,
        ).toBe('claimed');
        tick(61_000);
        // 界线正好等于占的时刻：不算「之前」，不接。
        expect(
          await store.claimCommand({ ...ids, action: 'agent.say', takeOverBefore: T0.toISOString() }),
        ).toEqual({ status: 'in-flight', claimedAt: T0.toISOString() });
        const cutoff = new Date(T0.getTime() + 1).toISOString();
        const both = await Promise.all([
          store.claimCommand({ ...ids, action: 'agent.say', takeOverBefore: cutoff }),
          store.claimCommand({ ...ids, action: 'agent.say', takeOverBefore: cutoff }),
        ]);
        expect(both.map((c) => c.status).sort()).toEqual(['claimed', 'in-flight']);
        expect(both).toContainEqual({ status: 'claimed', token: clock.now.toISOString(), tookOver: true });
        // 接过来的占用从现在算起：同一条界线再来，是 in-flight（占的时刻是现在）。
        expect(await store.claimCommand({ ...ids, action: 'agent.say', takeOverBefore: cutoff })).toEqual({
          status: 'in-flight',
          claimedAt: clock.now.toISOString(),
        });
        await store.completeCommand({ ...ids, token: clock.now.toISOString() }, ok200);
        tick(61_000);
        expect(
          await store.claimCommand({ ...ids, action: 'agent.say', takeOverBefore: clock.now.toISOString() }),
        ).toEqual({ status: 'done', result: ok200 });
      });

      it('命令的幂等键：被接管以后，旧请求拿着旧凭据放不掉、也记不上接管那次的占用', async () => {
        const ids = { runId: IDS.run1, key: 'k-taken' };
        const old = tokenOf(
          await store.claimCommand({ ...ids, action: 'agent.say', takeOverBefore: LONG_AGO }),
        );
        tick(61_000);
        const taken = await store.claimCommand({
          ...ids,
          action: 'agent.say',
          takeOverBefore: new Date(clock.now.getTime() - 60_000).toISOString(),
        });
        expect(taken).toMatchObject({ status: 'claimed', tookOver: true });
        // 旧请求这时才失败、要放键：不能把接管那次的占用删掉（不然第三个请求又占到了）。
        await store.releaseCommand({ ...ids, token: old });
        expect(await store.claimCommand({ ...ids, action: 'agent.say', takeOverBefore: LONG_AGO })).toEqual({
          status: 'in-flight',
          claimedAt: clock.now.toISOString(),
        });
        // 旧请求这时才做完：记不上；接管那次记得上。
        expect(
          await store.completeCommand({ ...ids, token: old }, { status: 200, body: { from: 'old' } }),
        ).toBe(false);
        expect(await store.completeCommand({ ...ids, token: tokenOf(taken) }, ok200)).toBe(true);
        expect(await store.claimCommand({ ...ids, action: 'agent.say', takeOverBefore: LONG_AGO })).toEqual({
          status: 'done',
          result: ok200,
        });
      });
    });

    describe('GitHub 事件', () => {
      const payload = {
        action: 'opened',
        issue: { number: 12, title: '原文' },
        repository: { full_name: 'x/y' },
      };
      const ISSUE = 'example/canary:issue:12';
      const V1 = '2026-09-25T07:00:00.000Z';
      const ver = (version: string, over: Partial<GitHubObjectVersion> = {}): GitHubObjectVersion => ({
        object: ISSUE,
        version,
        state: 'open',
        ...over,
      });
      const delivery = (id: string, over: Partial<NewGitHubDelivery> = {}): NewGitHubDelivery => ({
        id,
        event: 'issues',
        action: 'opened',
        source: 'webhook',
        repo: 'example/canary',
        versions: [ver(V1)],
        payload,
        ...over,
      });
      /** 现在往前 5 分钟：早于它占的「处理中」算死了。 */
      const stale = () => new Date(clock.now.getTime() - 5 * MIN).toISOString();
      const tokenOf = (c: Awaited<ReturnType<Store['claimDelivery']>>) => {
        if (c.status !== 'claimed') throw new Error(`没占到：${c.status}`);
        return c.token;
      };
      /** 收下一条、立刻记上结局。 */
      const settled = async (d: NewGitHubDelivery, outcome: Parameters<Store['finishDelivery']>[2]) => {
        const c = await store.claimDelivery(d, { staleBefore: stale() });
        expect(await store.finishDelivery(d.id, tokenOf(c), outcome)).toBe(true);
      };

      it('第一次来占到、原文和对象版本照存；处理完再来是 duplicate；出错的再来重新占住、次数加一，旧凭据记不上', async () => {
        const comment = ver('2026-09-25T06:59:00.000Z', {
          object: 'example/canary:comment:900',
          state: undefined,
        });
        const first = await store.claimDelivery(delivery('d-1', { versions: [ver(V1), comment] }), {
          staleBefore: stale(),
        });
        expect(first).toMatchObject({ status: 'claimed', retry: false });
        expect(await store.getDelivery('d-1')).toMatchObject({
          id: 'd-1',
          event: 'issues',
          action: 'opened',
          source: 'webhook',
          repo: 'example/canary',
          payload,
          status: 'processing',
          attempts: 1,
          receivedAt: T0.toISOString(),
        });
        // 读回来按对象排
        expect((await store.getDelivery('d-1'))?.versions).toEqual([
          { object: 'example/canary:comment:900', version: '2026-09-25T06:59:00.000Z' },
          { object: ISSUE, version: V1, state: 'open' },
        ]);
        expect(await store.claimDelivery(delivery('d-1'), { staleBefore: stale() })).toEqual({
          status: 'duplicate',
        });
        tick();
        expect(
          await store.finishDelivery('d-1', tokenOf(first), { status: 'accepted', note: 'task=created' }),
        ).toBe(true);
        expect(await store.getDelivery('d-1')).toMatchObject({
          status: 'accepted',
          note: 'task=created',
          finishedAt: clock.now.toISOString(),
        });
        expect(await store.claimDelivery(delivery('d-1'), { staleBefore: stale() })).toEqual({
          status: 'duplicate',
        });

        const second = await store.claimDelivery(delivery('d-2'), { staleBefore: stale() });
        expect(
          await store.finishDelivery('d-2', tokenOf(second), { status: 'failed', reason: '库连不上' }),
        ).toBe(true);
        expect(await store.getDelivery('d-2')).toMatchObject({ status: 'failed', reason: '库连不上' });
        tick();
        const again = await store.claimDelivery(delivery('d-2'), { staleBefore: stale() });
        expect(again).toMatchObject({ status: 'claimed', retry: true });
        expect(await store.getDelivery('d-2')).toMatchObject({ status: 'processing', attempts: 2 });
        expect(
          await store.finishDelivery('d-2', tokenOf(second), { status: 'accepted', note: '旧的那次' }),
        ).toBe(false);
        expect(await store.finishDelivery('d-2', tokenOf(again), { status: 'ignored', reason: 'ping' })).toBe(
          true,
        );
        expect(await store.getDelivery('d-2')).toMatchObject({
          status: 'ignored',
          reason: 'ping',
          note: undefined,
        });
      });

      it('处理中太久没收尾（那一次多半死了）才接得过去；没过期的是 duplicate', async () => {
        const first = await store.claimDelivery(delivery('d-1'), { staleBefore: stale() });
        tick(4 * MIN);
        expect(await store.claimDelivery(delivery('d-1'), { staleBefore: stale() })).toEqual({
          status: 'duplicate',
        });
        tick(2 * MIN);
        const taken = await store.claimDelivery(delivery('d-1'), { staleBefore: stale() });
        expect(taken).toMatchObject({ status: 'claimed', retry: true });
        expect(await store.finishDelivery('d-1', tokenOf(first), { status: 'accepted' })).toBe(false);
        expect(await store.finishDelivery('d-1', tokenOf(taken), { status: 'accepted' })).toBe(true);
      });

      it('原文不是对象也照存（JSON 的 null、数字），认不认得出是门口的事', async () => {
        await store.claimDelivery(delivery('d-null', { payload: null, versions: [] }), {
          staleBefore: stale(),
        });
        await store.claimDelivery(delivery('d-num', { payload: 42, versions: [] }), { staleBefore: stale() });
        expect((await store.getDelivery('d-null'))?.payload).toBeNull();
        expect((await store.getDelivery('d-num'))?.payload).toBe(42);
        expect((await store.getDelivery('d-num'))?.versions).toEqual([]);
      });

      it('同一条投递里同一个对象只能有一版：整条不收', async () => {
        await expect(
          store.claimDelivery(delivery('d-dup', { versions: [ver(V1), ver('2026-09-25T07:01:00.000Z')] }), {
            staleBefore: stale(),
          }),
        ).rejects.toThrow();
        expect(await store.getDelivery('d-dup')).toBeNull();
      });

      it('补收按对象版本认 webhook 带过的同一版（评论顶新的 issue 那一版也算）：duplicate、不落库；时刻写法不同照样认得', async () => {
        const commentVersion = ver('2026-09-25T06:58:00.000Z', {
          object: 'example/canary:comment:900',
          state: undefined,
        });
        await store.claimDelivery(
          delivery('guid-comment', { event: 'issue_comment', versions: [commentVersion, ver(V1)] }),
          { staleBefore: stale() },
        );
        const polled = (id: string, version: string) =>
          store.claimDelivery(delivery(id, { source: 'poll', versions: [ver(version)] }), {
            staleBefore: stale(),
            skipIfSeen: { object: ISSUE, version },
          });
        expect(await polled('poll-v1', '2026-09-25T07:00:00Z')).toEqual({ status: 'duplicate' });
        expect(await store.getDelivery('poll-v1')).toBeNull();
        expect(await polled('poll-v2', '2026-09-25T07:05:00.000Z')).toMatchObject({ status: 'claimed' });
        // 同一版再补收一次：认得出是 poll-v2 带过的
        expect(await polled('poll-v2-again', '2026-09-25T07:05:00.000Z')).toEqual({ status: 'duplicate' });
      });

      it('同一版的几条补收同时来（编号各不相同）：只有一条占到，别的是 duplicate、不落库——查有没有带过和插入在同一把锁下', async () => {
        const polled = (id: string) =>
          store.claimDelivery(delivery(id, { source: 'poll', versions: [ver(V1)] }), {
            staleBefore: stale(),
            skipIfSeen: { object: ISSUE, version: V1 },
          });
        const ids = Array.from({ length: 8 }, (_, i) => `poll-race-${i}`);
        const claims = await Promise.all(ids.map(polled));
        expect(claims.filter((c) => c.status === 'claimed')).toHaveLength(1);
        expect(claims.filter((c) => c.status === 'duplicate')).toHaveLength(ids.length - 1);
        const stored = await Promise.all(ids.map((id) => store.getDelivery(id)));
        expect(stored.filter((d) => d !== null)).toHaveLength(1);
      });

      it('同一版的补收和 webhook 同时来：补收要么先占到、要么认出 webhook 带过；落库的补收不会有两条', async () => {
        const [hook, ...polls] = await Promise.all([
          store.claimDelivery(delivery('guid-race'), { staleBefore: stale() }),
          ...['poll-a', 'poll-b'].map((id) =>
            store.claimDelivery(delivery(id, { source: 'poll', versions: [ver(V1)] }), {
              staleBefore: stale(),
              skipIfSeen: { object: ISSUE, version: V1 },
            }),
          ),
        ]);
        // webhook 只按投递编号去重，一定占到
        expect(hook).toMatchObject({ status: 'claimed', retry: false });
        expect(polls.filter((c) => c.status === 'claimed').length).toBeLessThanOrEqual(1);
        const [a, b] = await Promise.all([store.getDelivery('poll-a'), store.getDelivery('poll-b')]);
        expect([a, b].filter((d) => d !== null).length).toBeLessThanOrEqual(1);
      });

      it('门挡掉的那一版不跳过（改了名单、新加了仓之后补收还能再过一次门）；除了「仓不受管」挡掉的，都回 seenBefore（不算补回）', async () => {
        const V10 = '2026-09-25T07:10:00.000Z';
        const V20 = '2026-09-25T07:20:00.000Z';
        // 陌生人在白名单作者的 issue 下评论：门挡掉这条评论，它顺带的 issue 那一版照样记下
        await settled(
          delivery('guid-stranger-comment', {
            event: 'issue_comment',
            versions: [ver(V10, { object: 'example/canary:comment:901', state: undefined }), ver(V10)],
          }),
          { status: 'ignored', reason: 'author_not_whitelisted' },
        );
        // 仓还没纳管时收到的一条：带过的那一版不算见过
        await settled(delivery('guid-unmanaged', { versions: [ver(V20)] }), {
          status: 'ignored',
          reason: 'repo_not_managed',
        });
        const polled = (id: string, version: string) =>
          store.claimDelivery(delivery(id, { source: 'poll', versions: [ver(version)] }), {
            staleBefore: stale(),
            skipIfSeen: { object: ISSUE, version },
          });
        const carried = await polled('poll-v10', '2026-09-25T07:10:00Z');
        expect(carried).toMatchObject({ status: 'claimed', retry: false, seenBefore: true });
        const unmanaged = await polled('poll-v20', V20);
        expect(unmanaged).toMatchObject({ status: 'claimed', retry: false });
        expect(unmanaged).not.toHaveProperty('seenBefore');
        // 这一轮补收自己出了错、下一轮再来：接过来重做时照样回 seenBefore
        expect(
          await store.finishDelivery('poll-v10', tokenOf(carried), { status: 'failed', reason: '库连不上' }),
        ).toBe(true);
        tick();
        expect(await polled('poll-v10', V10)).toMatchObject({
          status: 'claimed',
          retry: true,
          seenBefore: true,
        });
      });

      it('重放：没有是 not_found；正在处理是 in_flight；处理完的不带 force 是 finished，带 force 重新占住', async () => {
        expect(await store.reclaimDelivery('nope', { staleBefore: stale(), force: true })).toEqual({
          status: 'not_found',
        });
        const first = await store.claimDelivery(delivery('d-1'), { staleBefore: stale() });
        expect(await store.reclaimDelivery('d-1', { staleBefore: stale(), force: true })).toEqual({
          status: 'in_flight',
        });
        await store.finishDelivery('d-1', tokenOf(first), {
          status: 'ignored',
          reason: 'author_not_whitelisted',
        });
        expect(await store.reclaimDelivery('d-1', { staleBefore: stale(), force: false })).toEqual({
          status: 'finished',
        });
        tick();
        const replay = await store.reclaimDelivery('d-1', { staleBefore: stale(), force: true });
        expect(replay).toMatchObject({
          status: 'claimed',
          delivery: { id: 'd-1', payload, status: 'processing', attempts: 2, versions: [ver(V1)] },
        });
        if (replay.status !== 'claimed') throw new Error('没占到');
        expect(await store.finishDelivery('d-1', replay.token, { status: 'accepted' })).toBe(true);
      });

      it('没处理成的清单：出错的、卡住的；次数少的在前，再按收到先后', async () => {
        const failed = async (id: string, times: number) => {
          for (let i = 0; i < times; i++) {
            const c = await store.claimDelivery(delivery(id), { staleBefore: stale() });
            await store.finishDelivery(id, tokenOf(c), { status: 'failed', reason: `第 ${i + 1} 次出错` });
            tick();
          }
        };
        await failed('twice', 2);
        await failed('once', 1);
        const done = await store.claimDelivery(delivery('done'), { staleBefore: stale() });
        await store.finishDelivery('done', tokenOf(done), { status: 'accepted' });
        await store.claimDelivery(delivery('dead'), { staleBefore: stale() });
        // dead 占了 6 分钟没收尾；busy 是刚占的，还算在处理
        tick(6 * MIN);
        await store.claimDelivery(delivery('busy'), { staleBefore: stale() });
        const list = await store.listUnfinishedDeliveries({ staleBefore: stale(), limit: 10 });
        expect(list.map((d) => [d.id, d.status, d.attempts])).toEqual([
          ['once', 'failed', 1],
          ['dead', 'processing', 1],
          ['twice', 'failed', 2],
        ]);
        expect(list[0]?.versions).toEqual([ver(V1)]);
        expect(await store.listUnfinishedDeliveries({ staleBefore: stale(), limit: 1 })).toHaveLength(1);
      });

      it('等着的（重开时上一轮还没结束）：得写原因；接过来重做不加次数，出错才加；列在没处理成的清单里', async () => {
        const first = await store.claimDelivery(delivery('reopen'), { staleBefore: stale() });
        await expect(
          store.finishDelivery('reopen', tokenOf(first), { status: 'waiting', reason: '' }),
        ).rejects.toThrow();
        expect(
          await store.finishDelivery('reopen', tokenOf(first), {
            status: 'waiting',
            reason: '上一轮还没结束',
          }),
        ).toBe(true);
        expect(await store.getDelivery('reopen')).toMatchObject({
          status: 'waiting',
          reason: '上一轮还没结束',
          attempts: 1,
          finishedAt: clock.now.toISOString(),
        });
        expect(
          (await store.listUnfinishedDeliveries({ staleBefore: stale(), limit: 10 })).map((d) => d.id),
        ).toEqual(['reopen']);
        // 重放接过来（等了好几轮）：次数不加
        for (let round = 0; round < 3; round++) {
          tick();
          const replay = await store.reclaimDelivery('reopen', { staleBefore: stale(), force: false });
          if (replay.status !== 'claimed') throw new Error(`没占到：${replay.status}`);
          expect(replay.delivery).toMatchObject({ status: 'processing', attempts: 1 });
          await store.finishDelivery('reopen', replay.token, { status: 'waiting', reason: '还没结束' });
        }
        // webhook 同一编号再来也一样
        tick();
        const again = await store.claimDelivery(delivery('reopen'), { staleBefore: stale() });
        expect(again).toMatchObject({ status: 'claimed', retry: true });
        expect(await store.getDelivery('reopen')).toMatchObject({ status: 'processing', attempts: 1 });
        // 这次真出错了：再接过来才加一
        await store.finishDelivery('reopen', tokenOf(again), { status: 'failed', reason: 'Temporal 连不上' });
        tick();
        await store.claimDelivery(delivery('reopen'), { staleBefore: stale() });
        expect(await store.getDelivery('reopen')).toMatchObject({ status: 'processing', attempts: 2 });
      });

      it('不收、出错都得写原因：原因是空的整笔不记', async () => {
        const c = await store.claimDelivery(delivery('d-1'), { staleBefore: stale() });
        // 库里是检查约束 github_events_reason_when_not_taken，内存版照样拦
        await expect(
          store.finishDelivery('d-1', tokenOf(c), { status: 'failed', reason: '' }),
        ).rejects.toThrow();
        expect(await store.getDelivery('d-1')).toMatchObject({ status: 'processing' });
      });

      it('哪些投递编号库里已经有原文（不管处理成没成）', async () => {
        await settled(delivery('kept'), { status: 'accepted' });
        await store.claimDelivery(delivery('in-flight'), { staleBefore: stale() });
        expect([...(await store.existingDeliveryIds(['kept', 'in-flight', 'never']))].sort()).toEqual([
          'in-flight',
          'kept',
        ]);
        expect(await store.existingDeliveryIds([])).toEqual(new Set());
      });

      it('更新的一版已经处理过、开关状态又不一样才算盖过：同状态、更旧的、没处理成的、它自己都不算', async () => {
        const at = (m: number) => `2026-09-25T07:${String(m).padStart(2, '0')}:00.000Z`;
        await settled(delivery('open-1', { versions: [ver(at(1))] }), { status: 'accepted' });
        await settled(delivery('closed-3', { versions: [ver(at(3), { state: 'closed' })] }), {
          status: 'accepted',
        });
        await settled(delivery('open-4', { versions: [ver(at(4))] }), { status: 'accepted' });
        await settled(delivery('closed-5-failed', { versions: [ver(at(5), { state: 'closed' })] }), {
          status: 'failed',
          reason: 'Temporal 连不上',
        });
        const find = (version: string, state: 'open' | 'closed', excludeDeliveryId = 'me') =>
          store.findSupersedingVersion({ object: ISSUE, version, state, excludeDeliveryId });
        // 两分时开着的那一版：三分时关了（处理过）→ 盖过，回最新的那一版
        expect(await find(at(2), 'open')).toEqual({
          deliveryId: 'closed-3',
          version: at(3),
          state: 'closed',
        });
        // 两分时关了的那一版：四分时开着（处理过）→ 盖过
        expect(await find(at(2), 'closed')).toEqual({ deliveryId: 'open-4', version: at(4), state: 'open' });
        // 四分时开着的那一版：五分时关了但没处理成 → 不算
        expect(await find(at(4), 'open')).toBeNull();
        expect(await find(at(3), 'closed', 'open-4')).toBeNull();
        expect(
          await store.findSupersedingVersion({
            object: 'example/canary:issue:99',
            version: at(0),
            state: 'open',
            excludeDeliveryId: 'me',
          }),
        ).toBeNull();
      });

      it('卡住的条数：出错到了上限的、处理中超过时限的；还能重放的、等着的、刚占的、处理完的不算', async () => {
        const failTimes = async (id: string, times: number) => {
          for (let i = 0; i < times; i++) {
            const c = await store.claimDelivery(delivery(id), { staleBefore: stale() });
            await store.finishDelivery(id, tokenOf(c), { status: 'failed', reason: '还是不成' });
          }
        };
        await failTimes('exhausted', 5);
        await failTimes('retryable', 2);
        // 出错到了上限、这一次又在等着（上一轮还没结束）：等着的不算卡住
        await failTimes('waiting', 5);
        const w = await store.claimDelivery(delivery('waiting'), { staleBefore: stale() });
        await store.finishDelivery('waiting', tokenOf(w), { status: 'waiting', reason: '上一轮还没结束' });
        await settled(delivery('done'), { status: 'accepted' });
        // 两条占了 6 分钟没收尾（那一次多半死了），一条刚占上
        await store.claimDelivery(delivery('dead-1'), { staleBefore: stale() });
        await store.claimDelivery(delivery('dead-2'), { staleBefore: stale() });
        tick(6 * MIN);
        await store.claimDelivery(delivery('busy'), { staleBefore: stale() });
        expect(await store.countStuckDeliveries({ staleBefore: stale(), maxAttempts: 5 })).toEqual({
          exhausted: 1,
          stale: 2,
        });
        expect(await store.countStuckDeliveries({ staleBefore: stale(), maxAttempts: 2 })).toEqual({
          exhausted: 2,
          stale: 2,
        });
      });

      // —— 下面几条钉住两套 Store 共用的判断（delivery-logic.ts）的边界：改错任何一边，两边都得红 ——

      it('占用刚好等于 staleBefore 不算过期（严格早于才算）；晚一毫秒就接得过去', async () => {
        await store.claimDelivery(delivery('edge'), { staleBefore: stale() });
        const claimedAt = clock.now.toISOString();
        expect(await store.claimDelivery(delivery('edge'), { staleBefore: claimedAt })).toEqual({
          status: 'duplicate',
        });
        expect(await store.reclaimDelivery('edge', { staleBefore: claimedAt, force: false })).toEqual({
          status: 'in_flight',
        });
        expect(await store.listUnfinishedDeliveries({ staleBefore: claimedAt, limit: 10 })).toEqual([]);
        tick(1);
        expect(
          await store.claimDelivery(delivery('edge'), { staleBefore: clock.now.toISOString() }),
        ).toMatchObject({ status: 'claimed', retry: true });
      });

      it('force 重放：处理中而且占用已过期的也抢得到（和不 force 一样）；没过期的 force 也不抢', async () => {
        const first = await store.claimDelivery(delivery('stuck'), { staleBefore: stale() });
        expect(await store.reclaimDelivery('stuck', { staleBefore: stale(), force: true })).toEqual({
          status: 'in_flight',
        });
        tick(6 * MIN);
        const forced = await store.reclaimDelivery('stuck', { staleBefore: stale(), force: true });
        expect(forced).toMatchObject({ status: 'claimed' });
        if (forced.status !== 'claimed') throw new Error('没抢到');
        expect(forced.delivery).toMatchObject({ id: 'stuck', status: 'processing', attempts: 2 });
        // 抢走之后旧凭据记不上
        expect(await store.finishDelivery('stuck', tokenOf(first), { status: 'accepted' })).toBe(false);
        tick(6 * MIN);
        const plain = await store.reclaimDelivery('stuck', { staleBefore: stale(), force: false });
        expect(plain).toMatchObject({ status: 'claimed' });
      });

      it('别的投递带过这一版、但出错或等着（不是被门挡掉）：补收是 duplicate，不落库', async () => {
        const carry = async (
          id: string,
          version: string,
          outcome: Parameters<Store['finishDelivery']>[2],
        ) => {
          await settled(delivery(id, { versions: [ver(version)] }), outcome);
          expect(
            await store.claimDelivery(
              delivery(`poll-after-${id}`, { source: 'poll', versions: [ver(version)] }),
              { staleBefore: stale(), skipIfSeen: { object: ISSUE, version } },
            ),
          ).toEqual({ status: 'duplicate' });
          expect(await store.getDelivery(`poll-after-${id}`)).toBeNull();
        };
        await carry('carrier-failed', V1, { status: 'failed', reason: '库连不上' });
        await carry('carrier-waiting', '2026-09-25T07:30:00.000Z', {
          status: 'waiting',
          reason: '上一轮还没结束',
        });
      });

      it('同一时刻的两版（更新的一版时刻相同）不算盖过', async () => {
        const at = '2026-09-25T07:03:00.000Z';
        await settled(delivery('same-closed', { versions: [ver(at, { state: 'closed' })] }), {
          status: 'accepted',
        });
        expect(
          await store.findSupersedingVersion({
            object: ISSUE,
            version: '2026-09-25T07:03:00Z',
            state: 'open',
            excludeDeliveryId: 'me',
          }),
        ).toBeNull();
      });
    });

    describe('接活', () => {
      const issueTask = (over: Partial<NewIssueTask> = {}): NewIssueTask => ({
        id: NEW_TASK,
        repoId: IDS.repo,
        issueNumber: 40,
        title: '新需求',
        rawRequest: '原话',
        requestedBy: IDS.founderA,
        ...over,
      });
      const created = (over: Partial<NewAuditEntry> = {}) =>
        audit({ action: 'task.create', target: `task:${NEW_TASK}`, via: 'github', ...over });

      it('按名字找仓：不分大小写，带自动派活开关（没开是 null）；没有就是 null', async () => {
        expect(await store.findRepoByName('Example', 'CANARY')).toEqual({
          id: IDS.repo,
          owner: 'example',
          name: 'canary',
          defaultBranch: 'main',
          testCommand: 'pnpm check',
          autoDispatchSince: null,
        });
        expect(await store.findRepoByName('example', 'other')).toBeNull();
      });

      it('按 issue 找任务；别的仓、看不懂的编号是 null', async () => {
        expect((await store.findTaskByIssue(IDS.repo, 12))?.id).toBe(IDS.task12);
        expect(await store.findTaskByIssue(IDS.repo, 999)).toBeNull();
        expect(await store.findTaskByIssue(OTHER_UUID, 12)).toBeNull();
        expect(await store.findTaskByIssue('nope', 12)).toBeNull();
      });

      it('按一批 issue 一次查回任务：只回对得上的，别的仓、没有的号、看不懂的编号都不回；空批回空', async () => {
        const found = await store.findTasksByIssues([
          { repoId: IDS.repo, issueNumber: 12 },
          { repoId: IDS.repo, issueNumber: 999 },
          { repoId: OTHER_UUID, issueNumber: 12 },
          { repoId: 'nope', issueNumber: 12 },
        ]);
        expect(found.map((t) => t.id)).toEqual([IDS.task12]);
        expect(await store.findTasksByIssues([{ repoId: 'nope', issueNumber: 12 }])).toEqual([]);
        expect(await store.findTasksByIssues([])).toEqual([]);
      });

      it('从 issue 建任务：排队中、排在这个仓最后、记一条状态和操作记录；同一张 issue 再建不建、不记', async () => {
        const first = await store.createTaskFromIssue(issueTask(), created());
        expect(first).toEqual({
          created: true,
          task: {
            id: NEW_TASK,
            repoId: IDS.repo,
            issueNumber: 40,
            title: '新需求',
            rawRequest: '原话',
            requestedBy: IDS.founderA,
            state: 'queued',
            priority: 3,
            acceptance: [],
            createdAt: T0.toISOString(),
          },
        });
        expect(await store.getTask(NEW_TASK)).toEqual(first.task);
        const again = await store.createTaskFromIssue(
          issueTask({ id: OTHER_UUID, title: '别的标题' }),
          created({ target: `task:${OTHER_UUID}` }),
        );
        expect(again).toEqual({ created: false, task: first.task });
        expect(await store.getTask(OTHER_UUID)).toBeNull();
        const audits = await store.listAudit({ target: `task:${NEW_TASK}`, limit: 10 });
        expect(audits.items.map((a) => [a.action, a.via])).toEqual([['task.create', 'github']]);
        expect((await store.listAudit({ target: `task:${OTHER_UUID}`, limit: 10 })).items).toEqual([]);
      });

      it('建任务时操作记录写不进：任务也不建', async () => {
        await expect(store.createTaskFromIssue(issueTask(), badAudit())).rejects.toThrow();
        expect(await store.getTask(NEW_TASK)).toBeNull();
      });

      it('改原话：变了才改、写操作记录；没变是 unchanged；没有这条是 not_found', async () => {
        const edit = audit({ action: 'task.edit', via: 'github' });
        expect(
          await store.updateTaskRequest(
            { taskId: IDS.task12, title: '登录页加验证码', rawRequest: '给登录页加手机验证码' },
            edit,
          ),
        ).toBe('unchanged');
        expect(
          await store.updateTaskRequest(
            { taskId: IDS.task12, title: '登录加验证码', rawRequest: '改过的原话' },
            edit,
          ),
        ).toBe('ok');
        expect(await store.getTask(IDS.task12)).toMatchObject({
          title: '登录加验证码',
          rawRequest: '改过的原话',
        });
        expect(await store.updateTaskRequest({ taskId: OTHER_UUID, title: 'x', rawRequest: 'y' }, edit)).toBe(
          'not_found',
        );
        expect(await store.updateTaskRequest({ taskId: 'nope', title: 'x', rawRequest: 'y' }, edit)).toBe(
          'not_found',
        );
        const audits = await store.listAudit({ target: `task:${IDS.task12}`, limit: 10 });
        expect(audits.items.filter((a) => a.action === 'task.edit')).toHaveLength(1);
        await expect(
          store.updateTaskRequest({ taskId: IDS.task12, title: '再改', rawRequest: '再改' }, badAudit()),
        ).rejects.toThrow();
        expect((await store.getTask(IDS.task12))?.title).toBe('登录加验证码');
      });

      it('还在排队的任务直接记成叫停（状态变化照记）；不在排队的不动', async () => {
        await store.createTaskFromIssue(issueTask(), created());
        const stop = audit({ action: 'task.stop', target: `task:${NEW_TASK}`, via: 'github' });
        tick();
        expect(await store.stopQueuedTask(NEW_TASK, stop)).toBe('ok');
        expect((await store.getTask(NEW_TASK))?.state).toBe('stopped');
        expect(await store.stopQueuedTask(NEW_TASK, stop)).toBe('not_queued');
        expect(await store.stopQueuedTask(IDS.task12, stop)).toBe('not_queued');
        expect((await store.getTask(IDS.task12))?.state).toBe('running');
        expect(await store.stopQueuedTask('nope', stop)).toBe('not_queued');
      });

      describe('「让 AI 接活」开关', () => {
        const target = `repo:${IDS.repo}`;
        const enable = audit({
          actor: { kind: 'engine', id: 'ops:dispatch' },
          action: 'repo.auto_dispatch.enable',
          target,
          via: 'engine',
        });
        const disable = { ...enable, action: 'repo.auto_dispatch.disable' };
        const since = async () => (await store.findRepoByName('example', 'canary'))?.autoDispatchSince;
        const switchAudits = async () => (await store.listAudit({ target, limit: 10 })).items;

        it('关着的打开：记下此刻、同一事务写一条带前后值的操作记录；开着再开不重设时刻、不记', async () => {
          tick();
          const openedAt = clock.now.toISOString();
          expect(await store.setAutoDispatch({ repoId: IDS.repo, on: true }, enable)).toEqual({
            changed: true,
            autoDispatchSince: openedAt,
            auditId: expect.any(String),
          });
          expect(await since()).toBe(openedAt);
          const [entry, ...rest] = await switchAudits();
          expect(rest).toEqual([]);
          expect(entry).toMatchObject({
            at: openedAt,
            actor: { kind: 'engine', id: 'ops:dispatch' },
            action: 'repo.auto_dispatch.enable',
            via: 'engine',
            ok: true,
            before: { autoDispatchSince: null },
            after: { autoDispatchSince: openedAt },
          });
          tick();
          expect(await store.setAutoDispatch({ repoId: IDS.repo, on: true }, enable)).toEqual({
            changed: false,
            autoDispatchSince: openedAt,
          });
          expect(await since()).toBe(openedAt);
          expect(await switchAudits()).toHaveLength(1);
        });

        it('开着的关上：设为空，操作记录记下原来的时刻；关着再关不记；没这个仓 not_found、不留记录', async () => {
          tick();
          const openedAt = clock.now.toISOString();
          await store.setAutoDispatch({ repoId: IDS.repo, on: true }, enable);
          tick();
          expect(await store.setAutoDispatch({ repoId: IDS.repo, on: false }, disable)).toEqual({
            changed: true,
            autoDispatchSince: null,
            auditId: expect.any(String),
          });
          expect(await since()).toBeNull();
          expect((await switchAudits()).map((a) => [a.action, a.before, a.after])).toEqual([
            ['repo.auto_dispatch.disable', { autoDispatchSince: openedAt }, { autoDispatchSince: null }],
            ['repo.auto_dispatch.enable', { autoDispatchSince: null }, { autoDispatchSince: openedAt }],
          ]);
          expect(await store.setAutoDispatch({ repoId: IDS.repo, on: false }, disable)).toEqual({
            changed: false,
            autoDispatchSince: null,
          });
          for (const repoId of [OTHER_UUID, 'nope'])
            expect(await store.setAutoDispatch({ repoId, on: true }, enable), repoId).toBe('not_found');
          const all = (await store.listAudit({ limit: 200 })).items;
          expect(all.filter((a) => a.action.startsWith('repo.auto_dispatch.'))).toHaveLength(2);
        });

        it('操作记录写不进：开关也不改', async () => {
          await expect(store.setAutoDispatch({ repoId: IDS.repo, on: true }, badAudit())).rejects.toThrow();
          expect(await since()).toBeNull();
          expect(await switchAudits()).toEqual([]);
        });
      });
    });
  });
}
