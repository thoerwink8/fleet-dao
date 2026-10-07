// 拉单（jobs/intake.ts，#632 S2-2）：每一道关各一条「不派」、读不到不当成没有、同一处缺法只留一次言、容量、记账。
// 每条失败路径都故意造一次：都不许记成 ok，都不许起工作流。

import type { ScheduleResult } from '@fleet-dao/db';
import { githubWhitelist } from '@fleet-dao/store';
import { describe, expect, it } from 'vitest';
import {
  INTAKE_JOB,
  type IntakeDeps,
  IntakeFailedError,
  type IntakeIssue,
  type IntakePlan,
  type IntakeRepo,
  incompleteComment,
  incompleteKey,
  MAX_RUNNING_TASKS,
  MAX_STARTS_PER_ROUND,
  MERGE_GATE_REQUIRES_COLD_VERIFY,
  prClaimedIssues,
  runIntakeJob,
  screenListed,
  screenPlan,
} from '../src/jobs/intake.ts';

const NOW = new Date('2026-10-02T14:00:00.000Z');
const SINCE = '2026-09-30T00:00:00.000Z';
const V1 = { number: 3, title: 'v1 三段一条龙' };
const V2 = { number: 4, title: 'v2 下一版' };
const REPO: IntakeRepo = {
  id: 'r1',
  owner: 'acme',
  name: 'demo',
  defaultBranch: 'main',
  testCommand: 'pnpm check',
  autoDispatchSince: SINCE,
};

const BODY = [
  '## 场景',
  '',
  '创始人要在驾驶舱看到每张单走到哪一步。',
  '',
  '## 原话',
  '',
  '「我回来打开驾驶舱，这张单就该在做完的那一栏」',
  '',
  '## 已知的模块',
  '',
  '- `packages/web/src/pages/`：驾驶舱页面',
  '',
  '## 怎么算做完',
  '',
  '1. 页面上能看到「验收中」这个状态',
  '',
].join('\n');

const whitelist = githubWhitelist([
  { id: 'u1', displayName: '创始人', role: 'founder', active: true, githubId: 1, githubLogin: 'frank' },
  { id: 'u2', displayName: '协作者', role: 'collaborator', active: true, githubLogin: 'helper' },
  { id: 'b1', displayName: '引擎', role: 'bot', active: true, githubId: 9 },
  { id: 'u3', displayName: '离职的', role: 'collaborator', active: false, githubId: 5 },
]);

const issue = (over: Partial<IntakeIssue> = {}): IntakeIssue => ({
  number: 12,
  title: '给驾驶舱加状态',
  body: BODY,
  author: { login: 'frank', id: 1, type: 'User' },
  createdAt: '2026-10-01T00:00:00.000Z',
  labels: ['需求'],
  milestone: V1,
  ...over,
});

const plan = (over: Partial<IntakePlan> = {}): IntakePlan => ({
  state: 'open',
  pullRequest: false,
  milestone: V1,
  openMilestones: [V1, V2],
  labels: ['需求'],
  parent: null,
  subIssues: 0,
  ...over,
});

interface Harness {
  deps: IntakeDeps;
  started: { issueNumber: number; title: string; body: string; author: IntakeIssue['author'] }[];
  comments: { issueNumber: number; key: string; body: string }[];
  finished: { id: number; result: ScheduleResult }[];
  logs: { level: string; text: string }[];
  planReads: number[];
  /** 贴了「本机做」的单号。 */
  localMarked: number[];
}

/** 一个仓、一张齐全的好单、什么都没派过：改哪一项就能看那一道关。 */
function harness(
  over: Partial<IntakeDeps> = {},
  data: {
    issues?: IntakeIssue[];
    plans?: Record<number, IntakePlan>;
    dispatched?: number[];
    /** 开着的 PR 的「需求」栏挂着的单：单号 → PR 号。 */
    prClaims?: Record<number, number>;
  } = {},
): Harness {
  const localMarked: number[] = [];
  const started: Harness['started'] = [];
  const comments: Harness['comments'] = [];
  const finished: Harness['finished'] = [];
  const logs: Harness['logs'] = [];
  const planReads: number[] = [];
  const seenKeys = new Set<string>();
  const deps: IntakeDeps = {
    async repos() {
      return [REPO];
    },
    async whitelist() {
      return whitelist;
    },
    async openIssues() {
      return { issues: data.issues ?? [issue()], openMilestones: [V1, V2] };
    },
    async plan(_repo, n) {
      planReads.push(n);
      return data.plans?.[n] ?? plan();
    },
    async dispatched(_repo, n) {
      return data.dispatched?.includes(n) ?? false;
    },
    async openPrClaims() {
      return new Map(Object.entries(data.prClaims ?? {}).map(([n, pr]) => [Number(n), pr]));
    },
    async markLocal({ issueNumber }) {
      localMarked.push(issueNumber);
    },
    async readSpecDoc() {
      return null;
    },
    async runningTasks() {
      return 0;
    },
    async start({ issueNumber, title, body, author }) {
      started.push({ issueNumber, title, body, author });
      return 'started';
    },
    async comment({ issueNumber, key, body }) {
      const k = `${issueNumber}:${key}`;
      if (seenKeys.has(k)) return { created: false };
      seenKeys.add(k);
      comments.push({ issueNumber, key, body });
      return { created: true };
    },
    runs: {
      async start() {
        return 7;
      },
      async finish(id, result) {
        finished.push({ id, result });
      },
    },
    gateLive: true,
    now: () => NOW,
    log: (level, text) => {
      logs.push({ level, text });
    },
    ...over,
  };
  return { deps, started, comments, finished, logs, planReads, localMarked };
}

describe('screenListed · 列表里就能判的几道', () => {
  const base = { autoDispatchSince: SINCE, issue: issue(), trusted: true, openMilestones: [V1, V2] };

  it('一张好单：全过', () => {
    expect(screenListed(base)).toBeNull();
  });

  it.each([
    ['开关打开以前开的', { issue: issue({ createdAt: '2026-09-29T23:59:59.000Z' }) }, 'opened_before_switch'],
    ['作者不在白名单', { trusted: false }, 'untrusted_author'],
    ['没挂里程碑（未排期）', { issue: issue({ milestone: null }) }, 'unscheduled'],
    ['挂在别的版本', { issue: issue({ milestone: V2 }) }, 'not_current_version'],
    [
      '里程碑认不出版本号（算没查成）',
      {
        issue: issue({ milestone: { number: 9, title: '杂项' } }),
        openMilestones: [V1, { number: 9, title: '杂项' }],
      },
      'version_unreadable',
    ],
    ['贴着母单标签', { issue: issue({ labels: ['需求', '母单'] }) }, 'mother_ticket'],
    ['贴着本机做', { issue: issue({ labels: ['需求', '本机做'] }) }, 'reserved_local'],
    ['开单时间认不出（算没查成）', { issue: issue({ createdAt: '昨天' }) }, 'created_at_unreadable'],
  ] as const)('【故意造出的失败】%s → 不派', (_name, over, reason) => {
    const got = screenListed({ ...base, ...over });
    expect(got?.reason).toBe(reason);
    expect(got?.why.length).toBeGreaterThan(0);
  });
});

describe('screenPlan · 现读之后再核一遍', () => {
  it('开着、独立、挂在当前版本、没贴本机做：过', () => {
    expect(screenPlan(plan())).toBeNull();
  });

  it.each([
    ['号是 PR', { pullRequest: true }, 'pull_request'],
    ['单子已经关了', { state: 'closed' as const }, 'closed'],
    ['下面挂着子单（结构上是母单，标签漏贴也算）', { subIssues: 2 }, 'mother_ticket'],
    ['挂在别的单下面（子单）', { parent: 3 }, 'sub_issue'],
    ['现读发现挪到别的版本去了', { milestone: V2 }, 'not_current_version'],
    ['现读发现贴上了本机做', { labels: ['本机做'] }, 'reserved_local'],
  ] as const)('【故意造出的失败】%s → 不派', (_name, over, reason) => {
    expect(screenPlan(plan(over))?.reason).toBe(reason);
  });
});

describe('runIntakeJob · 合并闸还没认冷验收', () => {
  it('【故意造出的失败】开着「让 AI 接活」的仓、合并闸却还没认冷验收：这一轮记没跑成、一张单都不拉、不读 GitHub——开关开早了要看得见', async () => {
    const h = harness({ gateLive: false });
    await expect(runIntakeJob(h.deps)).rejects.toThrow(/合并闸还没认冷验收/);
    expect(h.started).toEqual([]);
    expect(h.planReads).toEqual([]);
    expect(h.finished[0]?.result).toMatchObject({ outcome: 'failed' });
  });

  it('开关全关：合并闸认没认都是正常的空闲，记 ok', async () => {
    const h = harness({
      gateLive: false,
      async repos() {
        return [{ ...REPO, autoDispatchSince: null }];
      },
    });
    expect(await runIntakeJob(h.deps)).toMatchObject({ outcome: 'ok', scanned: 1, found: 0 });
  });

  it('默认值：没有显式给 gateLive 时用代码里的常量；常量已经是 true（合并闸认冷验收、冷验收真活动接上了，S2-5/S2-5b）——改回 false 要改这一条', async () => {
    expect(MERGE_GATE_REQUIRES_COLD_VERIFY).toBe(true);
    const h = harness();
    const { gateLive: _unused, ...rest } = h.deps;
    const deps: IntakeDeps = { ...rest };
    expect(await runIntakeJob(deps)).toMatchObject({ outcome: 'ok', found: 1 });
    expect(h.started).toHaveLength(1);
  });
});

describe('runIntakeJob · 一轮', () => {
  it('一张好单 → 起一条任务工作流，记 ok（扫了 仓+单，处理了 1）', async () => {
    const h = harness();
    const run = await runIntakeJob(h.deps);
    // 起的时候把开单人和正文原样交过去（真依赖据此建任务行：原话、谁要的）
    expect(h.started).toEqual([
      {
        issueNumber: 12,
        title: '给驾驶舱加状态',
        body: BODY,
        author: { login: 'frank', id: 1, type: 'User' },
      },
    ]);
    expect(run).toMatchObject({ runId: 7, outcome: 'ok', scanned: 2, found: 1 });
    expect(h.finished).toEqual([{ id: 7, result: { outcome: 'ok', scanned: 2, found: 1 } }]);
  });

  it('被开着的 PR 的「需求」栏挂着的单 → 不起，留一句话、贴一次「本机做」；同一个 PR 再来一轮不重复留言', async () => {
    const h = harness({}, { prClaims: { 12: 40 } });
    const first = await runIntakeJob(h.deps);
    expect(h.started).toEqual([]);
    expect(h.localMarked).toEqual([12]);
    expect(h.comments).toHaveLength(1);
    expect(h.comments[0]).toMatchObject({ issueNumber: 12, key: 'intake-pr-claimed:40' });
    expect(h.comments[0]?.body).toContain('#40');
    expect(first).toMatchObject({ outcome: 'ok', found: 1 }); // 留的那条言算处理了的
    await runIntakeJob(h.deps);
    expect(h.comments).toHaveLength(1); // 幂等键挡住了第二条
    expect(h.started).toEqual([]);
  });

  it('没有 PR 挂着它（别的单被挂着不相干）→ 照拉，不贴标签', async () => {
    const h = harness({}, { prClaims: { 99: 41 } });
    await runIntakeJob(h.deps);
    expect(h.started).toHaveLength(1);
    expect(h.localMarked).toEqual([]);
    expect(h.comments).toEqual([]);
  });

  it('先留言再贴标签：留言失败 → 标签没贴、这张记没查成；标签失败 → 记没查成，下一轮留言幂等、只重贴', async () => {
    const noComment = harness(
      {
        async comment() {
          throw new Error('评论接口 502');
        },
      },
      { prClaims: { 12: 40 } },
    );
    const a = await runIntakeJob(noComment.deps);
    expect(noComment.localMarked).toEqual([]);
    expect(a.outcome).toBe('partial');
    expect(a.why).toContain('评论接口 502');

    const noLabel = harness(
      {
        async markLocal() {
          throw new Error('标签接口 502');
        },
      },
      { prClaims: { 12: 40 } },
    );
    const b = await runIntakeJob(noLabel.deps);
    expect(noLabel.started).toEqual([]);
    expect(b.outcome).toBe('partial');
    expect(b.why).toContain('标签接口 502');
  });

  it('登记的是 5 分钟一轮、连着三轮没跑成才过期', () => {
    expect(INTAKE_JOB).toMatchObject({ id: 'intake', schedule: '每 5 分钟', expectEveryMinutes: 15 });
  });

  it('作者是陌生人 → 不起、不留言（陌生人的单不打扰）', async () => {
    const h = harness({}, { issues: [issue({ author: { login: 'stranger', id: 99, type: 'User' } })] });
    await runIntakeJob(h.deps);
    expect(h.started).toEqual([]);
    expect(h.comments).toEqual([]);
    expect(h.planReads).toEqual([]); // 便宜的关就挡掉了，没再多读一次 GitHub
  });

  it('作者账号删了（作者是 null）→ 不起', async () => {
    const h = harness({}, { issues: [issue({ author: null })] });
    await runIntakeJob(h.deps);
    expect(h.started).toEqual([]);
  });

  it('自家机器人开的单（按数字编号认、类型必须是 Bot）→ 可以起；同编号但类型是 User 的不行', async () => {
    const bot = harness({}, { issues: [issue({ author: { login: 'fleet[bot]', id: 9, type: 'Bot' } })] });
    await runIntakeJob(bot.deps);
    expect(bot.started).toHaveLength(1);
    const fake = harness({}, { issues: [issue({ author: { login: 'impostor', id: 9, type: 'User' } })] });
    await runIntakeJob(fake.deps);
    expect(fake.started).toEqual([]);
  });

  it('只有登录名的协作者（没登记数字编号）按登录名认；已停用的人不认', async () => {
    const helper = harness({}, { issues: [issue({ author: { login: 'Helper', id: 77, type: 'User' } })] });
    await runIntakeJob(helper.deps);
    expect(helper.started).toHaveLength(1);
    const gone = harness({}, { issues: [issue({ author: { login: 'gone', id: 5, type: 'User' } })] });
    await runIntakeJob(gone.deps);
    expect(gone.started).toEqual([]);
  });

  it('已经派出过的单 → 不再起、不再多读一次 GitHub', async () => {
    const h = harness({}, { dispatched: [12] });
    await runIntakeJob(h.deps);
    expect(h.started).toEqual([]);
    expect(h.planReads).toEqual([]);
  });

  it('起工作流时编号已经用过（上一轮其实起成了）→ 不算起了，也不算出错', async () => {
    const h = harness({
      async start() {
        return 'already_exists';
      },
    });
    const run = await runIntakeJob(h.deps);
    expect(run.outcome).toBe('ok');
    expect(run.found).toBe(0);
  });

  it('拉两轮同一张好单：第二轮 dispatched 说派过了，只起一条', async () => {
    const dispatched: number[] = [];
    const h = harness({
      async dispatched(_r, n) {
        return dispatched.includes(n);
      },
      async start({ issueNumber, title, body, author }) {
        dispatched.push(issueNumber);
        h.started.push({ issueNumber, title, body, author });
        return 'started';
      },
    });
    await runIntakeJob(h.deps);
    await runIntakeJob(h.deps);
    expect(h.started).toHaveLength(1);
  });

  it('交代不全 → 在单子上留言写清缺什么，不起；同一处缺法第二轮不再留', async () => {
    const h = harness({}, { issues: [issue({ body: '## 场景\n\n只写了场景。' })] });
    const first = await runIntakeJob(h.deps);
    expect(h.started).toEqual([]);
    expect(h.comments).toHaveLength(1);
    const c = h.comments[0];
    expect(c?.body).toContain('【原话】');
    expect(c?.body).toContain('【已知的模块】');
    expect(c?.body).toContain('【怎么算做完】');
    expect(first.found).toBe(1); // 留言算处理了一件
    const second = await runIntakeJob(h.deps);
    expect(h.comments).toHaveLength(1); // 键一样，没再留
    expect(second.found).toBe(0);
  });

  it('缺的内容变了 → 键变了，是另一条留言', async () => {
    const a = [{ field: '原话', why: '缺' }];
    const b = [
      { field: '原话', why: '缺' },
      { field: '场景', why: '缺' },
    ];
    expect(incompleteKey(a)).toBe(incompleteKey([...a]));
    expect(incompleteKey(a)).not.toBe(incompleteKey(b));
    expect(incompleteComment(b)).toContain('【场景】');
  });

  it('指着的需求文档主线上没有 → 留言写清路径，不起', async () => {
    const h = harness(
      {},
      { issues: [issue({ body: '概述。\n\n文档：`specs/<本单号>-驾驶舱状态/需求.md`（完整需求）' })] },
    );
    await runIntakeJob(h.deps);
    expect(h.started).toEqual([]);
    expect(h.comments[0]?.body).toContain('specs/12-驾驶舱状态/需求.md');
  });

  it('指着的需求文档读到了 → 用文档里的栏判，齐了就起', async () => {
    const h = harness(
      {
        async readSpecDoc({ path }) {
          return path === 'specs/12-驾驶舱状态/需求.md' ? { content: BODY } : null;
        },
      },
      { issues: [issue({ body: '概述。\n\n文档：`specs/<本单号>-驾驶舱状态/需求.md`（完整需求）' })] },
    );
    await runIntakeJob(h.deps);
    expect(h.started).toHaveLength(1);
  });

  it('每轮最多起 MAX_STARTS_PER_ROUND 条，其余下一轮', async () => {
    const many = Array.from({ length: MAX_STARTS_PER_ROUND + 3 }, (_, i) => issue({ number: 100 + i }));
    const h = harness({}, { issues: many });
    const run = await runIntakeJob(h.deps);
    expect(h.started).toHaveLength(MAX_STARTS_PER_ROUND);
    expect(run.outcome).toBe('ok');
  });

  it('在跑的任务已经到上限 → 一条都不起（不是丢，下一轮再来）', async () => {
    const h = harness({
      async runningTasks() {
        return MAX_RUNNING_TASKS;
      },
    });
    const run = await runIntakeJob(h.deps);
    expect(h.started).toEqual([]);
    expect(run.outcome).toBe('ok');
  });

  it('起了几条就把在跑数加几：上限是 2、已经在跑 1 条，这一轮只起 1 条', async () => {
    const h = harness(
      {
        async runningTasks() {
          return 1;
        },
        limits: { maxRunningTasks: 2 },
      },
      { issues: [issue({ number: 1 }), issue({ number: 2 }), issue({ number: 3 })] },
    );
    await runIntakeJob(h.deps);
    expect(h.started.map((s) => s.issueNumber)).toEqual([1]);
  });

  it('没有开着开关的仓 → 不读单子，记 ok（开关全关是正常的空闲，不是没扫到）', async () => {
    let listed = false;
    const h = harness({
      async repos() {
        return [{ ...REPO, autoDispatchSince: null }];
      },
      async openIssues() {
        listed = true;
        return { issues: [], openMilestones: [] };
      },
    });
    const run = await runIntakeJob(h.deps);
    expect(listed).toBe(false);
    expect(run).toMatchObject({ outcome: 'ok', scanned: 1, found: 0 });
  });
});

describe('runIntakeJob · 【故意造出的失败】读不到的不当成没有', () => {
  it('受管的仓读不到 → 记 failed 并抛 IntakeFailedError（结局已经记进 schedule_runs）', async () => {
    const h = harness({
      async repos() {
        throw new Error('库连不上');
      },
    });
    await expect(runIntakeJob(h.deps)).rejects.toThrow(IntakeFailedError);
    expect(h.finished[0]?.result).toMatchObject({
      outcome: 'failed',
      why: expect.stringContaining('库连不上'),
    });
    expect(h.started).toEqual([]);
  });

  it('库里没有受管的仓 → unscanned（有原因），不记 ok', async () => {
    const h = harness({
      async repos() {
        return [];
      },
    });
    const run = await runIntakeJob(h.deps);
    expect(run.outcome).toBe('unscanned');
    expect(run.why).toContain('没有受管的仓');
  });

  it('白名单读不到 → failed，一张单都不起（不把「没读到」当成「没人可信」或「人人可信」）', async () => {
    const h = harness({
      async whitelist() {
        throw new Error('users 表读不了');
      },
    });
    await expect(runIntakeJob(h.deps)).rejects.toThrow(/白名单/);
    expect(h.started).toEqual([]);
  });

  it('在跑的任务数读不到 → failed，不当成「一条没有」往外起', async () => {
    const h = harness({
      async runningTasks() {
        throw new Error('Temporal 连不上');
      },
    });
    await expect(runIntakeJob(h.deps)).rejects.toThrow(IntakeFailedError);
    expect(h.started).toEqual([]);
  });

  it('唯一一个开着开关的仓读单子失败 → failed', async () => {
    const h = harness({
      async openIssues() {
        throw new Error('GitHub 502');
      },
    });
    await expect(runIntakeJob(h.deps)).rejects.toThrow(/GitHub 502/);
    expect(h.finished[0]?.result.outcome).toBe('failed');
  });

  it('两个仓，一个读失败、一个读成 → partial，成的那个照拉', async () => {
    const h = harness({
      async repos() {
        return [REPO, { ...REPO, id: 'r2', name: 'other' }];
      },
      async openIssues(repo) {
        if (repo.name === 'other') throw new Error('GitHub 502');
        return { issues: [issue()], openMilestones: [V1] };
      },
    });
    const run = await runIntakeJob(h.deps);
    expect(run.outcome).toBe('partial');
    expect(run.why).toContain('acme/other');
    expect(h.started).toHaveLength(1);
  });

  it('读不到开着的 PR 列表 → 这张单这一轮不拉、不贴标签、不留言，记没查成（不当成「没有 PR」）', async () => {
    const h = harness({
      async openPrClaims() {
        throw new Error('PR 列表翻不完');
      },
    });
    const run = await runIntakeJob(h.deps);
    expect(h.started).toEqual([]);
    expect(h.localMarked).toEqual([]);
    expect(h.comments).toEqual([]);
    expect(run.outcome).toBe('partial');
    expect(run.why).toContain('PR 列表翻不完');
  });

  it('prClaimedIssues：Closes 和 Refs 都算，只看「需求」栏，同一张单取号最小的 PR', () => {
    const claimed = prClaimedIssues([
      { number: 50, body: '**做了什么**：x\n\n**需求**：Refs #7' },
      { number: 40, body: '**做了什么**：顺带提到 #8\n\n**需求**：Closes #7' },
      { number: 60, body: '没有栏' },
    ]);
    expect(claimed.get(7)).toBe(40);
    expect(claimed.has(8)).toBe(false);
    expect(claimed.size).toBe(1);
  });

  it('一张单现读失败 → 这张记没查成（partial），别的单照拉', async () => {
    const h = harness(
      {
        async plan(_r, n) {
          if (n === 1) throw new Error('GraphQL 超时');
          return plan();
        },
      },
      { issues: [issue({ number: 1 }), issue({ number: 2 })] },
    );
    const run = await runIntakeJob(h.deps);
    expect(run.outcome).toBe('partial');
    expect(run.why).toContain('#1');
    expect(run.why).toContain('GraphQL 超时');
    expect(h.started.map((s) => s.issueNumber)).toEqual([2]);
  });

  it('起工作流失败 → 记没查成（partial），不算起了；留言失败同理', async () => {
    const h = harness({
      async start() {
        throw new Error('Temporal 拒了');
      },
    });
    const run = await runIntakeJob(h.deps);
    expect(run.outcome).toBe('partial');
    expect(run.found).toBe(0);
    const c = harness(
      {
        async comment() {
          throw new Error('GitHub 403');
        },
      },
      { issues: [issue({ body: '没有任何一栏' })] },
    );
    const crun = await runIntakeJob(c.deps);
    expect(crun.outcome).toBe('partial');
    expect(crun.why).toContain('GitHub 403');
    expect(c.started).toEqual([]);
  });

  it('「已经派过」读不到 → 这张记没查成，不当成没派过再起一条', async () => {
    const h = harness({
      async dispatched() {
        throw new Error('库读不到');
      },
    });
    const run = await runIntakeJob(h.deps);
    expect(run.outcome).toBe('partial');
    expect(h.started).toEqual([]);
  });

  it('开单时间认不出 / 里程碑认不出版本号 → 算没查成（partial），不派', async () => {
    const h = harness({}, { issues: [issue({ createdAt: '昨天' })] });
    const run = await runIntakeJob(h.deps);
    expect(run.outcome).toBe('partial');
    expect(run.why).toContain('开单时间认不出');
    expect(h.started).toEqual([]);
  });

  it('「让 AI 接活」打开的时刻认不出 → 这个仓这一轮没拉，记没查成', async () => {
    const h = harness({
      async repos() {
        return [{ ...REPO, autoDispatchSince: '不知道哪天' }];
      },
    });
    await expect(runIntakeJob(h.deps)).rejects.toThrow(/认不出/);
    expect(h.started).toEqual([]);
  });

  it('记开始就失败（库连不上）→ 原样抛出，不起任何东西', async () => {
    const h = harness({
      runs: {
        async start() {
          throw new Error('schedule_runs 写不进去');
        },
        async finish() {},
      },
    });
    await expect(runIntakeJob(h.deps)).rejects.toThrow('schedule_runs 写不进去');
    expect(h.started).toEqual([]);
  });
});
