// 拉单（jobs/intake.ts，#632 S2-2；#1336 起引擎自己挑单）：每一道关各一条「不派」、读不到不当成没有、同一处缺法只留一次言、
// 排序、容量、每小时限速、熔断、记账。
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
  MAX_ISSUE_FAILURES,
  MAX_RUNNING_TASKS,
  MAX_STARTS_PER_HOUR,
  MAX_STARTS_PER_ROUND,
  MERGE_GATE_REQUIRES_COLD_VERIFY,
  prClaimedIssues,
  runIntakeJob,
  screenListed,
  screenPlan,
  workflowPathIn,
} from '../src/jobs/intake.ts';
import type { BreakerEvent, BreakerFacts } from '../src/jobs/intake-pick.ts';

const NOW = new Date('2026-10-02T14:00:00.000Z');
const SINCE = '2026-09-30T00:00:00.000Z';
const OLD = '2026-09-29T23:59:59.000Z';
const V1 = { number: 3, title: 'v1 三段一条龙' };
const V2 = { number: 4, title: 'v2 下一版' };
/** 版本说明里的先后：写成 parseOrder 认的样子。 */
const orderText = (nums: number[]) =>
  [
    '目标一句话',
    '<!-- fleet:order -->',
    ...nums.map((n, i) => `${i + 1}. #${n}`),
    '<!-- /fleet:order -->',
  ].join('\n');
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

/** 按指定的「已知的模块」和「怎么算做完」拼一份四节齐的正文。 */
const bodyWith = (modules: string[], criteria: string[] = ['1. 页面上能看到「验收中」这个状态']) =>
  [
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
    ...modules.map((m) => `- ${m}`),
    '',
    '## 怎么算做完',
    '',
    ...criteria,
    '',
  ].join('\n');

/** 窗口里 n 条失败（熔断用）。 */
const failedOf = (n: number, doneAfter = 0): BreakerFacts['recent'] => [
  ...Array.from({ length: n }, () => ({ state: 'failed' as const })),
  ...Array.from({ length: doneAfter }, () => ({ state: 'done' as const })),
];

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
  /** 熔断状态变了推过的事件。 */
  breakerEvents: BreakerEvent[];
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
    /** 每张单的历史失败次数（没写是 0）。 */
    failures?: Record<number, number>;
    /** 滚动一小时内已起的条数。 */
    hourStarted?: number;
    /** v1 里程碑说明里的先后（单号，按先后）；不给就是没写先后标记。 */
    v1Order?: number[];
    breaker?: BreakerFacts;
  } = {},
): Harness {
  const breakerEvents: BreakerEvent[] = [];
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
      return {
        issues: data.issues ?? [issue()],
        openMilestones: [data.v1Order ? { ...V1, description: orderText(data.v1Order) } : V1, V2],
      };
    },
    async failures(_repo, n) {
      return data.failures?.[n] ?? 0;
    },
    async startedSince() {
      return data.hourStarted ?? 0;
    },
    async breaker() {
      return data.breaker ?? { open: null, recent: [] };
    },
    async breakerChanged({ event }) {
      breakerEvents.push(event);
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
  return { deps, started, comments, finished, logs, planReads, localMarked, breakerEvents };
}

describe('screenListed · 列表里就能判的几道', () => {
  const base = { issue: issue(), trusted: true };

  it('一张好单：全过', () => {
    expect(screenListed(base)).toBeNull();
  });

  it.each([
    ['开关打开以前开的老单', issue({ createdAt: OLD })],
    ['没挂里程碑（未排期）', issue({ milestone: null })],
    ['挂在别的版本', issue({ milestone: V2 })],
    ['挂的里程碑认不出版本号', issue({ milestone: { number: 9, title: '杂项' } })],
  ])('#1336 去掉的两道硬闸：%s 照样进候选', (_name, one) => {
    expect(screenListed({ ...base, issue: one })).toBeNull();
  });

  it.each([
    ['作者不在白名单', { trusted: false }, 'untrusted_author'],
    ['贴着母单标签', { issue: issue({ labels: ['需求', '母单'] }) }, 'mother_ticket'],
    ['贴着本机做', { issue: issue({ labels: ['需求', '本机做'] }) }, 'reserved_local'],
    ['开单时间认不出（算没查成）', { issue: issue({ createdAt: '昨天' }) }, 'created_at_unreadable'],
  ] as const)('【故意造出的失败】%s → 不派', (_name, over, reason) => {
    const got = screenListed({ ...base, ...over });
    expect(got?.reason).toBe(reason);
    expect(got?.why.length).toBeGreaterThan(0);
  });
});

describe('screenPlan · 起之前现读再核一遍', () => {
  it('开着、独立、没贴本机做：过', () => {
    expect(screenPlan(plan())).toBeNull();
  });

  it('挂在别的版本、未排期都过：版本只影响排序，现读也不再核它', () => {
    expect(screenPlan(plan({ milestone: V2 }))).toBeNull();
    expect(screenPlan(plan({ milestone: null }))).toBeNull();
  });

  it.each([
    ['号是 PR', { pullRequest: true }, 'pull_request'],
    ['单子已经关了', { state: 'closed' as const }, 'closed'],
    ['下面挂着子单（结构上是母单，标签漏贴也算）', { subIssues: 2 }, 'mother_ticket'],
    ['挂在别的单下面（子单）', { parent: 3 }, 'sub_issue'],
    ['现读发现贴上了本机做', { labels: ['本机做'] }, 'reserved_local'],
  ] as const)('【故意造出的失败】%s → 不派', (_name, over, reason) => {
    expect(screenPlan(plan(over))?.reason).toBe(reason);
  });
});

describe('交给引擎 · 只是同一规模档里的排序加分，不绕过任何一道', () => {
  const base = { issue: issue(), trusted: true };
  const handed = (over: Partial<IntakeIssue> = {}) => issue({ labels: ['需求', '交给引擎'], ...over });

  it('贴了「本机做」又贴「交给引擎」：不拉，原因写明以「本机做」为准', () => {
    const got = screenListed({
      ...base,
      issue: issue({ createdAt: OLD, milestone: null, labels: ['需求', '本机做', '交给引擎'] }),
    });
    expect(got?.reason).toBe('reserved_local');
    expect(got?.why).toContain('交给引擎');
    expect(got?.why).toMatch(/以「本机做」为准/);
  });

  it('【故意造出的失败】母单贴了「交给引擎」仍不拉：标签不得绕过母单闸', () => {
    const got = screenListed({
      ...base,
      issue: handed({ createdAt: OLD, milestone: null, labels: ['需求', '母单', '交给引擎'] }),
    });
    expect(got?.reason).toBe('mother_ticket');
  });

  it('贴了「交给引擎」、作者不在白名单：仍不拉', () => {
    const got = screenListed({ ...base, trusted: false, issue: handed({ createdAt: OLD, milestone: null }) });
    expect(got?.reason).toBe('untrusted_author');
  });

  it('【故意造出的失败】子单贴了「交给引擎」：仍不拉，标签不得绕过子单闸', () => {
    const got = screenPlan(plan({ labels: ['需求', '交给引擎'], parent: 8, milestone: null }));
    expect(got?.reason).toBe('sub_issue');
  });

  it('【故意造出的失败】下面挂着子单、又贴了「交给引擎」：仍不拉', () => {
    const got = screenPlan(plan({ labels: ['需求', '交给引擎'], subIssues: 2, milestone: V2 }));
    expect(got?.reason).toBe('mother_ticket');
  });

  it('现读时「本机做」和「交给引擎」都在：不拉，原因写明以「本机做」为准', () => {
    const got = screenPlan(plan({ labels: ['本机做', '交给引擎'], milestone: null }));
    expect(got?.reason).toBe('reserved_local');
    expect(got?.why).toContain('交给引擎');
    expect(got?.why).toMatch(/以「本机做」为准/);
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
  it('开关打开以前开的老单（没贴「整理过」「交给引擎」）→ 不拉，原因是 not_groomed', async () => {
    const h = harness({}, { issues: [issue({ createdAt: OLD })] });
    const run = await runIntakeJob(h.deps);
    expect(h.started).toEqual([]);
    expect(h.logs.some((l) => l.text.includes('not_groomed'))).toBe(true);
    expect(run.outcome).toBe('ok');
  });

  it('开关打开以前开的老单贴了「整理过」→ 被拉', async () => {
    const h = harness({}, { issues: [issue({ createdAt: OLD, labels: ['需求', '整理过'] })] });
    await runIntakeJob(h.deps);
    expect(h.started.map((s) => s.issueNumber)).toEqual([12]);
  });

  it('开关打开以前开的老单贴了「交给引擎」→ 被拉', async () => {
    const h = harness({}, { issues: [issue({ createdAt: OLD, labels: ['需求', '交给引擎'] })] });
    await runIntakeJob(h.deps);
    expect(h.started.map((s) => s.issueNumber)).toEqual([12]);
  });

  it('开关之后新开的单不需要「整理过」→ 照旧被拉', async () => {
    const h = harness({}, { issues: [issue({ createdAt: '2026-09-30T00:00:00.000Z' })] });
    await runIntakeJob(h.deps);
    expect(h.started.map((s) => s.issueNumber)).toEqual([12]);
  });

  it.each([
    ['待补', 'groom_pending'],
    ['要人拍', 'needs_human'],
  ])(
    '贴了「%s」的单任何情况下都不拉（新单、贴了「整理过」「交给引擎」也不拉），写明原因 %s',
    async (label, reason) => {
      const h = harness(
        {},
        {
          issues: [
            issue({ number: 1, labels: ['需求', label] }),
            issue({ number: 2, createdAt: OLD, labels: ['需求', '整理过', label] }),
            issue({ number: 3, labels: ['需求', '交给引擎', label] }),
          ],
        },
      );
      await runIntakeJob(h.deps);
      expect(h.started).toEqual([]);
      expect(h.logs.some((l) => l.text.includes(reason))).toBe(true);
    },
  );

  it('起之前现读到的标签里有「要人拍」（列表读到之后才贴的）→ 不起', async () => {
    const h = harness({}, { plans: { 12: plan({ labels: ['需求', '要人拍'] }) } });
    await runIntakeJob(h.deps);
    expect(h.started).toEqual([]);
  });

  it('未排期的单（没挂里程碑、没贴「交给引擎」）→ 被拉', async () => {
    const h = harness({}, { issues: [issue({ milestone: null })], plans: { 12: plan({ milestone: null }) } });
    await runIntakeJob(h.deps);
    expect(h.started.map((s) => s.issueNumber)).toEqual([12]);
  });

  it('挂在别的版本的单 → 被拉', async () => {
    const h = harness({}, { issues: [issue({ milestone: V2 })], plans: { 12: plan({ milestone: V2 }) } });
    await runIntakeJob(h.deps);
    expect(h.started.map((s) => s.issueNumber)).toEqual([12]);
  });

  it('老单、又被开着的 PR 挂着 → 仍不拉，贴「本机做」', async () => {
    const h = harness(
      {},
      { issues: [issue({ createdAt: OLD, labels: ['需求', '整理过'] })], prClaims: { 12: 40 } },
    );
    await runIntakeJob(h.deps);
    expect(h.started).toEqual([]);
    expect(h.localMarked).toEqual([12]);
  });

  it('母单、子单、本机做、碰 workflows 的老单和未排期单仍不拉', async () => {
    const wf = BODY.replace('- `packages/web/src/pages/`：驾驶舱页面', '- `.github/workflows/ci.yml`：CI');
    const h = harness(
      {},
      {
        issues: [
          issue({ number: 1, createdAt: OLD, milestone: null, labels: ['需求', '母单', '整理过'] }),
          issue({ number: 2, createdAt: OLD, milestone: null, labels: ['需求', '整理过'] }),
          issue({ number: 3, createdAt: OLD, milestone: null, labels: ['需求', '本机做', '整理过'] }),
          issue({ number: 4, createdAt: OLD, milestone: null, body: wf, labels: ['需求', '整理过'] }),
        ],
        plans: { 2: plan({ milestone: null, parent: 9 }) },
      },
    );
    await runIntakeJob(h.deps);
    expect(h.started).toEqual([]);
    expect(h.localMarked).toEqual([4]);
  });

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

  it('正文的「已知的模块」写了 .github/workflows/ 路径 → 不起，留一句话、贴一次「本机做」，不读 PR 列表（#1194）', async () => {
    const body = BODY.replace(
      '- `packages/web/src/pages/`：驾驶舱页面',
      '- `.github/workflows/ci.yml`：CI 工作流',
    );
    let prRead = 0;
    const h = harness(
      {
        async openPrClaims() {
          prRead += 1;
          return new Map();
        },
      },
      { issues: [issue({ body })] },
    );
    const run = await runIntakeJob(h.deps);
    expect(h.started).toEqual([]);
    expect(h.localMarked).toEqual([12]);
    expect(h.comments).toHaveLength(1);
    expect(h.comments[0]?.key).toBe('intake-touches-workflows');
    expect(h.comments[0]?.body).toContain('.github/workflows/ci.yml');
    expect(run).toMatchObject({ outcome: 'ok', found: 1 });
    expect(prRead).toBe(0);
    await runIntakeJob(h.deps);
    expect(h.comments).toHaveLength(1); // 再来一轮不重复留言
  });

  it('场景、怎么算做完里写了工作流路径也算；只在「原话」里提到不算（照拉）', async () => {
    const inScene = harness(
      {},
      {
        issues: [
          issue({
            body: BODY.replace('创始人要在驾驶舱', '要改 .github/workflows/ 下的 ci.yml，创始人要在驾驶舱'),
          }),
        ],
      },
    );
    await runIntakeJob(inScene.deps);
    expect(inScene.started).toEqual([]);
    expect(inScene.localMarked).toEqual([12]);

    const inCriteria = harness(
      {},
      {
        issues: [
          issue({
            body: BODY.replace('1. 页面上能看到', '1. `.github/workflows/ci.yml` 里有一步；页面上能看到'),
          }),
        ],
      },
    );
    await runIntakeJob(inCriteria.deps);
    expect(inCriteria.started).toEqual([]);

    const inQuote = harness(
      {},
      {
        issues: [
          issue({
            body: BODY.replace(
              '「我回来打开驾驶舱',
              '「顺口说一句 .github/workflows/ci.yml 慢。我回来打开驾驶舱',
            ),
          }),
        ],
      },
    );
    await runIntakeJob(inQuote.deps);
    expect(inQuote.started).toHaveLength(1);
    expect(inQuote.localMarked).toEqual([]);
  });

  it('workflowPathIn：没写返回 null；正文不是文字（读不到）抛错，不当成没写（故意造出失败）', () => {
    expect(workflowPathIn(BODY)).toBeNull();
    expect(workflowPathIn('')).toBeNull();
    expect(() => workflowPathIn(undefined)).toThrow(/读不到/);
    expect(() => workflowPathIn(null)).toThrow(/读不到/);
  });

  it('正文读不到 → 这张单这一轮不拉、不贴标签不留言，记没查成（partial）', async () => {
    const h = harness({}, { issues: [issue({ body: null as unknown as string })] });
    const run = await runIntakeJob(h.deps);
    expect(h.started).toEqual([]);
    expect(h.localMarked).toEqual([]);
    expect(h.comments).toEqual([]);
    expect(run.outcome).toBe('partial');
    expect(run.why).toContain('单正文读不到');
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
    const h = harness({ limits: { maxStartsPerHour: 99 } }, { issues: many });
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

  it('这张单的失败次数读不到 → 这张记没查成，不当成没失败过再起', async () => {
    const h = harness({
      async failures() {
        throw new Error('任务历史读不了');
      },
    });
    const run = await runIntakeJob(h.deps);
    expect(run.outcome).toBe('partial');
    expect(run.why).toContain('任务历史读不了');
    expect(h.started).toEqual([]);
  });

  it('最近一小时已起的条数读不到 → failed，一张单都没拉，不当成「一条没起」', async () => {
    const h = harness({
      async startedSince() {
        throw new Error('任务表读不了');
      },
    });
    await expect(runIntakeJob(h.deps)).rejects.toThrow(/任务表读不了/);
    expect(h.started).toEqual([]);
  });

  it('熔断状态读不到、或状态写不进去 → failed，一张单都没拉，不当成「正常」', async () => {
    const unreadable = harness({
      async breaker() {
        throw new Error('设置 engine.intakeBreaker 的值认不出');
      },
    });
    await expect(runIntakeJob(unreadable.deps)).rejects.toThrow(/认不出/);
    expect(unreadable.started).toEqual([]);

    const unwritable = harness(
      {
        async breakerChanged() {
          throw new Error('设置表写不进去');
        },
      },
      { breaker: { open: null, recent: failedOf(4) } },
    );
    await expect(runIntakeJob(unwritable.deps)).rejects.toThrow(/写不进去/);
    expect(unwritable.started).toEqual([]);
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

describe('准入 · 验收条、规模、历史失败（#1336）', () => {
  it('没有「怎么算做完」一节 → 不拉，在单上留一次言；再来一轮不重复留', async () => {
    const body = bodyWith(['`packages/web/src/a.ts`']).split('## 怎么算做完')[0] ?? '';
    const h = harness({}, { issues: [issue({ body })] });
    await runIntakeJob(h.deps);
    expect(h.started).toEqual([]);
    expect(h.comments).toHaveLength(1);
    expect(h.comments[0]?.body).toContain('【怎么算做完】');
    await runIntakeJob(h.deps);
    expect(h.comments).toHaveLength(1);
  });

  it('「怎么算做完」一节在、一条都没写 → 不拉，留一次言', async () => {
    const h = harness({}, { issues: [issue({ body: bodyWith(['`packages/web/src/a.ts`'], []) })] });
    await runIntakeJob(h.deps);
    expect(h.started).toEqual([]);
    expect(h.comments).toHaveLength(1);
    expect(h.comments[0]?.body).toContain('【怎么算做完】');
  });

  it('验收条里一个路径、文件名、引号里的现象、数字都没有：拿不准，照拉，只记一笔', async () => {
    const h = harness(
      {},
      { issues: [issue({ body: bodyWith(['`packages/web/src/a.ts`'], ['1. 做得好看一点']) })] },
    );
    await runIntakeJob(h.deps);
    expect(h.started).toHaveLength(1);
    expect(h.comments).toEqual([]);
    expect(h.logs.some((l) => l.text.includes('只记不拦'))).toBe(true);
  });

  it('规模：已知的模块列了 51 个路径（最重档）不拉；刚好 50 个照拉', async () => {
    const paths = (n: number) => Array.from({ length: n }, (_, i) => `\`packages/x${i}/src/a.ts\``);
    const big = harness({}, { issues: [issue({ body: bodyWith(paths(51)) })] });
    await runIntakeJob(big.deps);
    expect(big.started).toEqual([]);
    expect(big.logs.some((l) => l.text.includes('too_large×1'))).toBe(true);
    expect(big.planReads).toEqual([]); // 排序前就判掉了，没多读一次 GitHub

    const edge = harness({}, { issues: [issue({ body: bodyWith(paths(50)) })] });
    await runIntakeJob(edge.deps);
    expect(edge.started).toHaveLength(1);
  });

  it('同一个路径写几次只算一个：51 行里只有 50 个不同的路径，照拉', async () => {
    const lines = [
      ...Array.from({ length: 50 }, (_, i) => `\`packages/x${i}/src/a.ts\``),
      '`packages/x0/src/a.ts`',
    ];
    const h = harness({}, { issues: [issue({ body: bodyWith(lines) })] });
    await runIntakeJob(h.deps);
    expect(h.started).toHaveLength(1);
  });

  it(`历史失败超过 ${MAX_ISSUE_FAILURES} 次不拉，刚好 ${MAX_ISSUE_FAILURES} 次照拉`, async () => {
    const h = harness({}, { issues: [issue({ number: 1 }), issue({ number: 2 })], failures: { 1: 3, 2: 2 } });
    await runIntakeJob(h.deps);
    expect(h.started.map((s) => s.issueNumber)).toEqual([2]);
    expect(h.logs.some((l) => l.text.includes('too_many_failures×1'))).toBe(true);
    expect(h.planReads).toEqual([2]);
  });
});

describe('排序 · 版本先后 → 当前版本 → 规模 → 交给引擎 → 失败 → 开单早', () => {
  const FAST = bodyWith(['`packages/web/src/a.ts`']);
  const MEDIUM = bodyWith(['`packages/web/src/`', '`packages/web/test/`']);
  const HEAVY = bodyWith(['`docs/a.md`', '`packages/web/src/b.ts`']);
  const order = async (
    issues: IntakeIssue[],
    data: Parameters<typeof harness>[1] = {},
  ): Promise<number[]> => {
    const h = harness({ limits: { maxStartsPerHour: 99 } }, { ...data, issues });
    await runIntakeJob(h.deps);
    return h.started.map((s) => s.issueNumber);
  };

  it('版本先后列表里的序号：序号小的先，不在列表里的排最后', async () => {
    const got = await order([issue({ number: 21 }), issue({ number: 22 }), issue({ number: 23 })], {
      v1Order: [22, 21],
    });
    expect(got).toEqual([22, 21, 23]);
  });

  it('序号比「是不是当前版本」重：别的版本里排第 1 的，先于当前版本里没排进去的', async () => {
    // 这里 v1 是当前版本（小的那个）；v2 没写先后。给 v1 写先后后，排第 1 的在前；
    const got = await order(
      [issue({ number: 31, milestone: V2 }), issue({ number: 32 }), issue({ number: 33 })],
      { v1Order: [33] },
    );
    expect(got).toEqual([33, 32, 31]);
  });

  it('没排进先后的里面：挂当前版本的先于别的版本和未排期的', async () => {
    const got = await order([
      issue({ number: 41, milestone: null }),
      issue({ number: 42, milestone: V2 }),
      issue({ number: 43, milestone: V1 }),
    ]);
    expect(got).toEqual([43, 41, 42]);
  });

  it('规模小的先：一个文件 → 同一模块 → 跨模块', async () => {
    const got = await order([
      issue({ number: 51, body: HEAVY }),
      issue({ number: 52, body: MEDIUM }),
      issue({ number: 53, body: FAST }),
    ]);
    expect(got).toEqual([53, 52, 51]);
  });

  it('规模比「交给引擎」重：小单没贴标签，仍先于贴了标签的大单', async () => {
    const got = await order([
      issue({ number: 61, body: MEDIUM, labels: ['需求', '交给引擎'] }),
      issue({ number: 62, body: FAST }),
    ]);
    expect(got).toEqual([62, 61]);
  });

  it('同一规模档里贴了「交给引擎」的靠前', async () => {
    const got = await order([issue({ number: 71 }), issue({ number: 72, labels: ['需求', '交给引擎'] })]);
    expect(got).toEqual([72, 71]);
  });

  it('「交给引擎」比失败少重：贴了标签但失败过 1 次的，先于没贴标签没失败过的', async () => {
    const got = await order([issue({ number: 81 }), issue({ number: 82, labels: ['需求', '交给引擎'] })], {
      failures: { 82: 1 },
    });
    expect(got).toEqual([82, 81]);
  });

  it('历史失败少的先', async () => {
    const got = await order([issue({ number: 91 }), issue({ number: 92 })], { failures: { 91: 2, 92: 1 } });
    expect(got).toEqual([92, 91]);
  });

  it('前面都一样：开单早的先', async () => {
    const got = await order([
      issue({ number: 101, createdAt: '2026-10-01T05:00:00.000Z' }),
      issue({ number: 102, createdAt: '2026-10-01T01:00:00.000Z' }),
    ]);
    expect(got).toEqual([102, 101]);
  });

  it('候选多于空位时按这个顺序取：每轮只能起 2 条，取排最前的 2 张', async () => {
    const h = harness(
      { limits: { maxStartsPerRound: 2, maxStartsPerHour: 99 } },
      {
        issues: [issue({ number: 111 }), issue({ number: 112 }), issue({ number: 113 })],
        v1Order: [113, 111],
      },
    );
    await runIntakeJob(h.deps);
    expect(h.started.map((s) => s.issueNumber)).toEqual([113, 111]);
  });

  it('先后标记认不出的版本：这个版本的单算没排进去，照拉，不拦', async () => {
    const h = harness({}, { issues: [issue()] });
    const run = await runIntakeJob(h.deps); // V1 的说明里没有先后标记
    expect(run.outcome).toBe('ok');
    expect(h.started).toHaveLength(1);
    expect(h.logs.some((l) => l.text.includes('先后认不出'))).toBe(true);
  });
});

describe('每小时限速', () => {
  const many = (n: number) => Array.from({ length: n }, (_, i) => issue({ number: 200 + i }));

  it(`一小时里最多起 ${MAX_STARTS_PER_HOUR} 条：已经起了 2 条，这一轮只再起 1 条`, async () => {
    const h = harness({}, { issues: many(3), hourStarted: 2 });
    await runIntakeJob(h.deps);
    expect(h.started.map((s) => s.issueNumber)).toEqual([200]);
    expect(h.logs.some((l) => l.text.includes('hourly_cap×2'))).toBe(true);
  });

  it(`【故意造出的失败】滚动一小时里已经起了 ${MAX_STARTS_PER_HOUR} 条：第 4 条不起，记 ok（不是没跑成）`, async () => {
    const h = harness({}, { issues: many(2), hourStarted: MAX_STARTS_PER_HOUR });
    const run = await runIntakeJob(h.deps);
    expect(h.started).toEqual([]);
    expect(run.outcome).toBe('ok');
  });

  it(`同一轮里也数：没起过时，8 张合格的单这一轮只起 ${MAX_STARTS_PER_HOUR} 条`, async () => {
    const h = harness({}, { issues: many(8) });
    await runIntakeJob(h.deps);
    expect(h.started).toHaveLength(MAX_STARTS_PER_HOUR);
  });

  it('限速时不为排在后面的单多读 GitHub：满了就不现读', async () => {
    const h = harness({}, { issues: many(2), hourStarted: MAX_STARTS_PER_HOUR });
    await runIntakeJob(h.deps);
    expect(h.planReads).toEqual([]);
  });
});

describe('熔断', () => {
  const some = (n: number) => Array.from({ length: n }, (_, i) => issue({ number: 300 + i }));
  const since = (minutesAgo: number) => new Date(NOW.getTime() - minutesAgo * 60_000);

  it('最近 6 条结束的任务里失败 4 条：进入熔断，一张都不起，推「进入」一次', async () => {
    const h = harness({}, { issues: some(2), breaker: { open: null, recent: failedOf(4, 2) } });
    const run = await runIntakeJob(h.deps);
    expect(h.started).toEqual([]);
    expect(h.breakerEvents).toEqual(['trip']);
    expect(run.outcome).toBe('ok');
    expect(h.logs.some((l) => l.text.includes('breaker_open×2'))).toBe(true);
  });

  it('失败 3 条（刚好一半）还没过半：照拉，不推通知', async () => {
    const h = harness({}, { issues: some(1), breaker: { open: null, recent: failedOf(3, 3) } });
    await runIntakeJob(h.deps);
    expect(h.started).toHaveLength(1);
    expect(h.breakerEvents).toEqual([]);
  });

  it('熔断着、冷却还没到 1 小时：不起，也不再推通知', async () => {
    const h = harness(
      {},
      { issues: some(2), breaker: { open: { since: since(30), trial: null }, recent: [] } },
    );
    await runIntakeJob(h.deps);
    expect(h.started).toEqual([]);
    expect(h.breakerEvents).toEqual([]);
  });

  it('冷却完了：只放 1 条试探，其余不起', async () => {
    const h = harness(
      {},
      { issues: some(3), breaker: { open: { since: since(61), trial: null }, recent: [] } },
    );
    await runIntakeJob(h.deps);
    expect(h.started).toHaveLength(1);
    expect(h.breakerEvents).toEqual([]);
  });

  it('试探那条还在跑：不再放新的', async () => {
    const h = harness(
      {},
      { issues: some(2), breaker: { open: { since: since(90), trial: 'running' }, recent: [] } },
    );
    await runIntakeJob(h.deps);
    expect(h.started).toEqual([]);
  });

  it('试探成功：恢复，推「恢复」一次，这一轮照常拉', async () => {
    const h = harness(
      {},
      { issues: some(2), breaker: { open: { since: since(90), trial: 'done' }, recent: [] } },
    );
    await runIntakeJob(h.deps);
    expect(h.breakerEvents).toEqual(['recover']);
    expect(h.started).toHaveLength(2);
  });

  it('【故意造出的失败】试探也失败：继续停拉，重新计冷却（不再推第二条通知）', async () => {
    const h = harness(
      {},
      { issues: some(2), breaker: { open: { since: since(90), trial: 'failed' }, recent: [] } },
    );
    await runIntakeJob(h.deps);
    expect(h.breakerEvents).toEqual(['retrip']);
    expect(h.started).toEqual([]);
  });
});

describe('【故意造出的失败】旧的两道硬闸删掉之后', () => {
  it('整理过的老单不再被 opened_before_switch 拦：被拉起，拉单日志里也没有这个原因', async () => {
    const h = harness(
      {},
      {
        issues: [issue({ createdAt: OLD, milestone: null, labels: ['需求', '整理过'] })],
        plans: { 12: plan({ milestone: null }) },
      },
    );
    await runIntakeJob(h.deps);
    expect(h.started.map((s) => s.issueNumber)).toEqual([12]);
    expect(h.logs.some((l) => l.text.includes('opened_before_switch'))).toBe(false);
    expect(h.logs.some((l) => l.text.includes('unscheduled') || l.text.includes('not_current_version'))).toBe(
      false,
    );
  });
});
