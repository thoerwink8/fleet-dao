// Store 契约测试：ports.ts 写下的语义，内存版（参照实现）和 Postgres 版都得过同一套。
// 两个实现各有一个入口文件（store.memory.test.ts / store.pg.test.ts）调 describeStoreContract。
import { beforeEach, describe, expect, it } from 'vitest';
import { DEV_USER_ID, devFixtures, IDS } from '../src/dev-fixtures.ts';
import type { MemoryData } from '../src/memory-store.ts';
import {
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
  // review 里挂一条关着的：拖动排序时开关不许丢。
  data.stagePolicies = (data.stagePolicies ?? []).map((p) =>
    p.stage === 'review'
      ? { ...p, routeIds: ['rt-mirasim-gpt', 'rt-mirasim-kimi'], disabledRouteIds: ['rt-mirasim-kimi'] }
      : p,
  );
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

      it('测试记录：只认载荷里 passed 是布尔的，按时间正序', async () => {
        tick();
        await store.appendProgress(IDS.run1, 'test', { passed: false, command: 'pnpm check' });
        tick();
        await store.appendProgress(IDS.run1, 'test', { passed: 'maybe' });
        tick();
        await store.appendProgress(IDS.run1, 'test', { passed: true });
        const runs = await store.listTestRuns(IDS.run1);
        expect(runs.map((r) => [r.passed, r.command])).toEqual([
          [false, 'pnpm check'],
          [true, undefined],
        ]);
      });
    });

    describe('时间线', () => {
      it('会话报的、人做的、状态变化、会话排队都在；倒序；翻页不重不漏；量大的 file / tool 不放', async () => {
        for (let i = 0; i < 3; i++) {
          tick();
          await store.appendProgress(IDS.run1, 'say', { text: `第 ${i} 句` });
        }
        await store.appendProgress(IDS.run1, 'file', { path: 'a.ts' });
        await store.appendAudit(audit({ action: 'task.pause', reason: '先停一下', after: { note: 'x' } }));
        const seen: { id: string; at: string; kind: string; payload?: unknown }[] = [];
        let cursor: string | undefined;
        for (let n = 0; n < 50; n++) {
          const page = await store.listTimeline(IDS.task12, { cursor, limit: 2 });
          seen.push(...page.items);
          cursor = page.nextCursor;
          if (!cursor) break;
        }
        expect(new Set(seen.map((r) => r.id)).size).toBe(seen.length);
        const sorted = [...seen].sort((a, b) => b.at.localeCompare(a.at) || (a.id < b.id ? 1 : -1));
        expect(seen.map((r) => r.id)).toEqual(sorted.map((r) => r.id));
        const says = seen.filter((r) => r.kind === 'say').map((r) => (r.payload as { text: string }).text);
        expect(says.slice(0, 3)).toEqual(['第 2 句', '第 1 句', '第 0 句']);
        expect(says).toContain('正在写验证码过期的测试');
        expect(seen.some((r) => r.kind === 'file')).toBe(false);
        const pause = seen.find((r) => r.kind === 'pause');
        expect(pause).toMatchObject({
          source: 'person',
          payload: { reason: '先停一下', ok: true, note: 'x' },
        });
        expect(seen.some((r) => r.kind === 'run_queued')).toBe(true);
        expect(seen.some((r) => r.kind === 'state')).toBe(true);
        expect(seen.some((r) => r.kind === 'notification')).toBe(true);
      });

      it('没有的需求、看不懂的编号：空', async () => {
        expect((await store.listTimeline(OTHER_UUID, { limit: 10 })).items).toEqual([]);
        expect((await store.listTimeline('task-12', { limit: 10 })).items).toEqual([]);
      });

      it('翻页游标看不懂（拼错、改过、编号不合这张列表）：抛 InvalidCursorError，不装成空页', async () => {
        const at = T0.toISOString();
        for (const cursor of ['garbage', '|x', 'not-a-time|1', `${at}|`]) {
          await expect(store.listTimeline(IDS.task12, { cursor, limit: 5 }), cursor).rejects.toBeInstanceOf(
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
    });

    describe('追问', () => {
      it('同一会话问一模一样的一句只开一条（2000 字的也行）；换个会话另开', async () => {
        const long = '验'.repeat(2000);
        const first = await store.openAsk({
          runId: IDS.run1,
          taskId: IDS.task12,
          question: long,
          options: ['是', '否'],
        });
        expect(first.created).toBe(true);
        const again = await store.openAsk({
          runId: IDS.run1,
          taskId: IDS.task12,
          question: long,
          options: [],
        });
        expect(again).toMatchObject({ created: false, ask: { id: first.ask.id } });
        const other = await store.openAsk({
          runId: IDS.run0,
          taskId: IDS.task12,
          question: long,
          options: [],
        });
        expect(other.created).toBe(true);
        expect(other.ask.id).not.toBe(first.ask.id);
        expect((await store.listAsks(IDS.task12)).map((a) => a.id).sort()).toEqual(
          [first.ask.id, other.ask.id].sort(),
        );
        expect(await store.getAsk(first.ask.id)).toMatchObject({ question: long, options: ['是', '否'] });
      });

      it('新开的追问同一事务记一条 ask 进度；复用那一条时不再记', async () => {
        const askEvents = async () =>
          (await store.listTimeline(IDS.task12, { limit: 100 })).items.filter((r) => r.kind === 'ask');
        const before = (await askEvents()).length;
        const input = { runId: IDS.run1, taskId: IDS.task12, question: '验证码几位？', options: [] };
        const { ask } = await store.openAsk(input);
        tick();
        await store.openAsk(input);
        const after = await askEvents();
        expect(after).toHaveLength(before + 1);
        expect(after[0]).toMatchObject({
          runId: IDS.run1,
          payload: { askId: ask.id, question: '验证码几位？' },
        });
      });

      it('回答：写上答案和谁答的，同一事务留操作记录；答过的不改；没有的是 not_found', async () => {
        const { ask } = await store.openAsk({
          runId: IDS.run1,
          taskId: IDS.task12,
          question: '几位？',
          options: [],
        });
        const auditsBefore = (await store.listAudit({ limit: 200 })).items.length;
        tick();
        const by = { kind: 'user' as const, id: DEV_USER_ID };
        expect(
          await store.answerAsk({ askId: ask.id, answer: '6', by }, audit({ action: 'ask.answer' })),
        ).toBe('ok');
        expect(await store.getAsk(ask.id)).toMatchObject({
          answer: '6',
          answeredBy: DEV_USER_ID,
          answeredAt: clock.now.toISOString(),
        });
        expect(await store.answerAsk({ askId: ask.id, answer: '4', by }, audit())).toBe('already_answered');
        expect(await store.answerAsk({ askId: OTHER_UUID, answer: '4', by }, audit())).toBe('not_found');
        expect(await store.answerAsk({ askId: 'nope', answer: '4', by }, audit())).toBe('not_found');
        expect((await store.listAudit({ limit: 200 })).items.length).toBe(auditsBefore + 1);
        expect((await store.getAsk(ask.id))?.answer).toBe('6');
      });

      it('操作记录写不进：回答一起不算（整笔回滚）', async () => {
        const { ask } = await store.openAsk({
          runId: IDS.run1,
          taskId: IDS.task12,
          question: '几位？',
          options: [],
        });
        await expect(
          store.answerAsk({ askId: ask.id, answer: '6', by: { kind: 'user', id: DEV_USER_ID } }, badAudit()),
        ).rejects.toThrow();
        expect((await store.getAsk(ask.id))?.answer).toBeUndefined();
      });
    });

    describe('调度台', () => {
      it('渠道、账号池、模型、路由按编号排；阶段策略带顺序；禁令只有库里另配的', async () => {
        expect((await store.listChannels()).map((c) => c.id)).toEqual([
          'ch-claude',
          'ch-cursor',
          'ch-mirasim',
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
        const policies = await store.listStagePolicies();
        expect(policies.map((p) => [p.stage, p.routeIds, p.pinned, p.disabledRouteIds])).toEqual([
          ['execute', ['rt-claude-opus', 'rt-mirasim-kimi'], false, undefined],
          ['ui', ['rt-claude-opus'], true, undefined],
          ['review', ['rt-mirasim-gpt', 'rt-mirasim-kimi'], false, ['rt-mirasim-kimi']],
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

      it('改路由顺序：比较后再改，同一事务写操作记录；别人先改了就 conflict、什么都不动', async () => {
        const auditsBefore = (await store.listAudit({ limit: 200 })).items.length;
        const ok = await store.updateStagePolicy(
          {
            stage: 'execute',
            expected: { routeIds: ['rt-claude-opus', 'rt-mirasim-kimi'], pinned: false },
            next: { routeIds: ['rt-mirasim-kimi', 'rt-claude-opus'], pinned: true },
          },
          audit({ action: 'stage_policy.update', target: 'stage:execute' }),
        );
        expect(ok).toBe('ok');
        const conflict = await store.updateStagePolicy(
          {
            stage: 'execute',
            expected: { routeIds: ['rt-claude-opus', 'rt-mirasim-kimi'], pinned: false },
            next: { routeIds: [], pinned: false },
          },
          audit(),
        );
        expect(conflict).toBe('conflict');
        const execute = (await store.listStagePolicies()).find((p) => p.stage === 'execute');
        expect(execute).toEqual({
          stage: 'execute',
          routeIds: ['rt-mirasim-kimi', 'rt-claude-opus'],
          pinned: true,
        });
        expect((await store.listAudit({ limit: 200 })).items.length).toBe(auditsBefore + 1);
      });

      it('拖动排序后关着的仍关着；新挂进来的开着，摘掉再挂回来的也按新挂算', async () => {
        const review = async () => (await store.listStagePolicies()).find((p) => p.stage === 'review');
        const move = async (expected: string[], next: string[]) =>
          store.updateStagePolicy(
            {
              stage: 'review',
              expected: { routeIds: expected, pinned: false },
              next: { routeIds: next, pinned: false },
            },
            audit({ action: 'stage_policy.update', target: 'stage:review' }),
          );
        expect(
          await move(
            ['rt-mirasim-gpt', 'rt-mirasim-kimi'],
            ['rt-mirasim-kimi', 'rt-claude-opus', 'rt-mirasim-gpt'],
          ),
        ).toBe('ok');
        expect(await review()).toEqual({
          stage: 'review',
          routeIds: ['rt-mirasim-kimi', 'rt-claude-opus', 'rt-mirasim-gpt'],
          pinned: false,
          disabledRouteIds: ['rt-mirasim-kimi'],
        });
        expect(await move(['rt-mirasim-kimi', 'rt-claude-opus', 'rt-mirasim-gpt'], ['rt-claude-opus'])).toBe(
          'ok',
        );
        expect(await review()).toEqual({ stage: 'review', routeIds: ['rt-claude-opus'], pinned: false });
        expect(await move(['rt-claude-opus'], ['rt-claude-opus', 'rt-mirasim-kimi'])).toBe('ok');
        expect((await review())?.disabledRouteIds).toBeUndefined();
      });

      it('还没有那一行的阶段：现值按空列表、没钉住算；两人同时第一次改，只有一个改得成', async () => {
        const first = (routeIds: string[]) =>
          store.updateStagePolicy(
            { stage: 'triage', expected: { routeIds: [], pinned: false }, next: { routeIds, pinned: false } },
            audit(),
          );
        const results = await Promise.all([first(['rt-claude-opus']), first(['rt-mirasim-kimi'])]);
        expect([...results].sort()).toEqual(['conflict', 'ok']);
        const winner = results[0] === 'ok' ? ['rt-claude-opus'] : ['rt-mirasim-kimi'];
        expect((await store.listStagePolicies()).find((p) => p.stage === 'triage')?.routeIds).toEqual(winner);
      });

      it('操作记录写不进：路由顺序一起不改（整笔回滚）', async () => {
        await expect(
          store.updateStagePolicy(
            {
              stage: 'ui',
              expected: { routeIds: ['rt-claude-opus'], pinned: true },
              next: { routeIds: [], pinned: false },
            },
            badAudit(),
          ),
        ).rejects.toThrow();
        expect((await store.listStagePolicies()).find((p) => p.stage === 'ui')).toEqual({
          stage: 'ui',
          routeIds: ['rt-claude-opus'],
          pinned: true,
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
        expect(open.items.map((n) => n.id)).toEqual([IDS.notification1]);
        expect(open.items[0]?.deliveries).toEqual([
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
        expect((await store.listNotifications({ status: 'open', limit: 10 })).items).toEqual([]);
        const all = await store.listNotifications({ status: 'all', limit: 10 });
        expect(all.items[0]).toMatchObject({ resolvedBy: DEV_USER_ID, resolvedAt: clock.now.toISOString() });
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
      it('会话：分支、做完标准（从需求来）、仓；不属于需求的会话、看不懂的编号都没有', async () => {
        expect(await store.getAgentSession(IDS.run1)).toEqual({
          runId: IDS.run1,
          taskId: IDS.task12,
          subtaskId: IDS.sub12a,
          stage: 'execute',
          repoId: IDS.repo,
          branch: 'fleet/12-a',
          acceptance: ['验证码 5 分钟过期', '同一手机号 60 秒内只能发一次'],
        });
        expect((await store.getAgentSession(IDS.run0))?.endedAt).toBe(
          new Date(T0.getTime() - 20 * MIN).toISOString(),
        );
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
        expect(await store.getPullRequest(IDS.repo, 31)).toEqual({
          repoId: IDS.repo,
          number: 31,
          state: 'open',
          headRef: 'fleet/12-a',
          headSha: 'abc123',
          checks: 'pending',
        });
        expect(await store.getPullRequest(IDS.repo, 32)).toBeNull();
        expect(await store.getPullRequest('repo-1', 31)).toBeNull();
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
      const delivery = (id: string, over: Partial<NewGitHubDelivery> = {}): NewGitHubDelivery => ({
        id,
        event: 'issues',
        action: 'opened',
        source: 'webhook',
        repo: 'example/canary',
        versionKey: `poll:example/canary:issue:12:${id}`,
        payload,
        ...over,
      });
      /** 现在往前 5 分钟：早于它占的「处理中」算死了。 */
      const stale = () => new Date(clock.now.getTime() - 5 * MIN).toISOString();
      const tokenOf = (c: Awaited<ReturnType<Store['claimDelivery']>>) => {
        if (c.status !== 'claimed') throw new Error(`没占到：${c.status}`);
        return c.token;
      };

      it('第一次来占到、原文照存；处理完再来是 duplicate；出错的再来重新占住、次数加一，旧凭据记不上', async () => {
        const first = await store.claimDelivery(delivery('d-1'), { staleBefore: stale() });
        expect(first).toMatchObject({ status: 'claimed', retry: false });
        expect(await store.getDelivery('d-1')).toMatchObject({
          id: 'd-1',
          event: 'issues',
          action: 'opened',
          source: 'webhook',
          repo: 'example/canary',
          versionKey: 'poll:example/canary:issue:12:d-1',
          payload,
          status: 'processing',
          attempts: 1,
          receivedAt: T0.toISOString(),
        });
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
        await store.claimDelivery(delivery('d-null', { payload: null }), { staleBefore: stale() });
        await store.claimDelivery(delivery('d-num', { payload: 42 }), { staleBefore: stale() });
        expect((await store.getDelivery('d-null'))?.payload).toBeNull();
        expect((await store.getDelivery('d-num'))?.payload).toBe(42);
      });

      it('轮询按版本认 webhook 收过的同一版：命中别的投递的 versionKey 就是 duplicate，也不落库', async () => {
        await store.claimDelivery(delivery('guid-1', { versionKey: 'poll:example/canary:issue:12:v1' }), {
          staleBefore: stale(),
        });
        const seen = 'poll:example/canary:issue:12:v1';
        expect(
          await store.claimDelivery(delivery(seen, { source: 'poll', versionKey: seen }), {
            staleBefore: stale(),
            skipIfVersionSeen: seen,
          }),
        ).toEqual({ status: 'duplicate' });
        expect(await store.getDelivery(seen)).toBeNull();
        const fresh = 'poll:example/canary:issue:12:v2';
        expect(
          await store.claimDelivery(delivery(fresh, { source: 'poll', versionKey: fresh }), {
            staleBefore: stale(),
            skipIfVersionSeen: fresh,
          }),
        ).toMatchObject({ status: 'claimed', retry: false });
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
          delivery: { id: 'd-1', payload, status: 'processing', attempts: 2 },
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
        expect(await store.listUnfinishedDeliveries({ staleBefore: stale(), limit: 1 })).toHaveLength(1);
      });

      it('不收、出错都得写原因：原因是空的整笔不记', async () => {
        const c = await store.claimDelivery(delivery('d-1'), { staleBefore: stale() });
        // 库里是检查约束 github_events_reason_when_not_taken，内存版照样拦
        await expect(
          store.finishDelivery('d-1', tokenOf(c), { status: 'failed', reason: '' }),
        ).rejects.toThrow();
        expect(await store.getDelivery('d-1')).toMatchObject({ status: 'processing' });
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
        const timeline = await store.listTimeline(NEW_TASK, { limit: 10 });
        expect(timeline.items.some((r) => r.kind === 'state')).toBe(true);
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
        const states = (await store.listTimeline(NEW_TASK, { limit: 10 })).items.filter(
          (r) => r.kind === 'state',
        );
        expect(states.map((r) => (r.payload as { to?: string }).to)).toEqual(['stopped', 'queued']);
      });
    });
  });
}
