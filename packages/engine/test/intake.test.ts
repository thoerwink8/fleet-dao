// 拉单（jobs/intake.ts，#632 S2-2；#1336 起引擎自己挑单）：每一道关各一条「不派」、读不到不当成没有、同一处缺法只留一次言、
// 排序、容量、每小时限速、熔断、记账。
// 每条失败路径都故意造一次：都不许记成 ok，都不许起工作流。

import type { ScheduleResult } from '@fleet-dao/db';
import { githubWhitelist } from '@fleet-dao/store';
import { describe, expect, it } from 'vitest';
import type { IssueTaskRow, TaskGenerationFacts } from '../src/jobs/dispatch-standing.ts';
import {
  INTAKE_JOB,
  type IntakeDeps,
  IntakeFailedError,
  type IntakeIssue,
  type IntakePlan,
  type IntakeRepo,
  incompleteComment,
  incompleteKey,
  judgePrerequisites,
  MAX_ISSUE_FAILURES,
  MAX_RUNNING_TASKS,
  MAX_STARTS_PER_HOUR,
  MAX_STARTS_PER_ROUND,
  MERGE_GATE_REQUIRES_COLD_VERIFY,
  offDiffKey,
  prClaimedIssues,
  runIntakeJob,
  screenListed,
  screenPlan,
  standardPathIn,
  workflowPathIn,
} from '../src/jobs/intake.ts';
import type { BreakerEvent, BreakerFacts } from '../src/jobs/intake-pick.ts';
import type { LocalLeaseDeps } from '../src/jobs/local-leases.ts';

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

const ISSUE_2032_BODY = bodyWith(
  ['`packages/api` healthz 的 `deploy_lag` 检查；`deploy/france.sh`'],
  [
    '1. 确认落后的是哪些「相关提交」（人工档路径），是否确需整套 `bash /srv/fleet-dao/deploy/france.sh`（或以 root 等价应用）。',
    '2. 重跑/应用后 healthz `deploy_lag` 回到 `ok:true`（整体是否仍因 #2023 的 github_app 503 另论）。',
    '3. 若属可接受的短暂窗口或已有意暂缓：在本单注明原因与可接受状态后关单，避免监督反复当新断链开单。',
    '4. 顺带：恢复指挥官到法国机的 SSH（见 #1775），以便断链时能做最小恢复。',
  ],
);

const ISSUE_2082_BODY = bodyWith(
  ['`packages/api` healthz canary 检查；引擎 canary/全流程巡检'],
  [
    '1. 查清 10-14 08:40 那轮 canary 在「记账」失败的具体原因（日志、失败单号、台账写入结果）。',
    '2. 修好后让 canary 再跑通一轮（或明确「无待验」且 healthz canary 不再因本断点报红）。',
    '3. healthz 至少不再因 canary_broken「记账」报红（整体是否仍因 #2023/#2032 503 另论）。',
    '4. 顺带：恢复指挥官到法国机的 SSH（见 #1775），以便断链时能做最小恢复。',
  ],
);

/** 没有「已知的模块」一节的老单：场景、原话、怎么算做完。路径检查不因为缺这一节就放行。 */
const bodyWithoutModules = (
  scene = '创始人要在驾驶舱看到每张单走到哪一步。',
  criteria: string[] = ['1. 页面上能看到「验收中」这个状态'],
) =>
  [
    '## 场景',
    '',
    scene,
    '',
    '## 原话',
    '',
    '「我回来打开驾驶舱，这张单就该在做完的那一栏」',
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
  /** 问过前置单状态的几次，每次问的单号。 */
  prereqReads: number[][];
}

/** 一个仓、一张齐全的好单、什么都没派过：改哪一项就能看那一道关。 */
function harness(
  over: Partial<IntakeDeps> = {},
  data: {
    issues?: IntakeIssue[];
    plans?: Record<number, IntakePlan>;
    /**
     * 这些单号当成已经有一代在跑。
     * 没有任务行的单不在这里：默认没派过。
     */
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
    /** 前置单（不在开着的单列表里的）的真状态；没写的算已关。 */
    prereqStates?: Record<number, 'open' | 'closed'>;
  } = {},
): Harness {
  const prereqReads: number[][] = [];
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
    async issueTask(_repo, n): Promise<IssueTaskRow | null> {
      if (data.dispatched?.includes(n)) return { id: `t-${n}`, state: 'running' };
      return null;
    },
    async taskGenerations(_repo, n): Promise<TaskGenerationFacts> {
      if (data.dispatched?.includes(n)) return { ok: true, lives: ['running'] };
      return { ok: true, lives: [] };
    },
    async openPrClaims() {
      return new Map(Object.entries(data.prClaims ?? {}).map(([n, pr]) => [Number(n), pr]));
    },
    async prerequisiteStates(_repo, numbers) {
      prereqReads.push([...numbers]);
      return new Map(numbers.map((n) => [n, data.prereqStates?.[n] ?? 'closed'] as const));
    },
    async markLocal({ issueNumber }) {
      localMarked.push(issueNumber);
    },
    async readSpecDoc() {
      return null;
    },
    async runningTasks() {
      return { working: 0, stalled: 0 };
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
  return { deps, started, comments, finished, logs, planReads, localMarked, breakerEvents, prereqReads };
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
  it('仓档案工具链缺失：判没就绪、不读单也不拉单，原因写明缺哪个', async () => {
    const h = harness({
      async repos() {
        return [
          {
            ...REPO,
            profile: {
              language: 'go',
              toolchain: ['go'],
              testCommand: 'go test ./...',
              moduleRoots: [],
              mergeSignals: [],
              standardPathsFile: 'packages/conventions/standard-paths.json',
              weight: 1,
            },
          },
        ];
      },
      async toolchainReady() {
        return ['go'];
      },
    });
    const run = await runIntakeJob(h.deps);
    expect(run).toMatchObject({ outcome: 'ok', found: 0 });
    expect(h.started).toEqual([]);
    expect(h.planReads).toEqual([]);
    expect(h.logs.some((l) => l.text.includes('缺工具链：go'))).toBe(true);
    expect(run.why).toContain('toolchain_unready×1');
    expect(run.why).toContain('缺工具链：go');
  });

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

  it('【故意造出的失败】一张都没派的那一轮：库里的结局写明每种没派的原因各几张（不写，schedule_runs 只剩 found=0，看不出是没单还是全被拦，法国 10-12 每 5 分钟 found=0 查不出为什么）', async () => {
    const h = harness(
      {},
      {
        issues: [
          issue({ number: 1, createdAt: OLD, milestone: null, labels: ['需求', '母单', '整理过'] }),
          issue({ number: 3, createdAt: OLD, milestone: null, labels: ['需求', '本机做', '整理过'] }),
        ],
      },
    );
    const run = await runIntakeJob(h.deps);
    expect(run).toMatchObject({ outcome: 'ok', found: 0 });
    const recorded = h.finished[0]?.result;
    expect(recorded).toMatchObject({ outcome: 'ok', found: 0 });
    const why = recorded && 'why' in recorded ? recorded.why : undefined;
    expect(why).toContain('没派的：');
    expect(why).toMatch(/mother_ticket×1/);
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
    expect(h.finished).toEqual([
      { id: 7, result: { outcome: 'ok', scanned: 2, found: 1, why: expect.stringContaining('起了 1 条') } },
    ]);
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

  it('标题是诊断型（「定位……在完整 CI 的原 N 秒超时」）→ 不起，留一句话、贴一次「本机做」，不读 PR 列表（#3597）', async () => {
    let prRead = 0;
    const h = harness(
      {
        async openPrClaims() {
          prRead += 1;
          return new Map();
        },
      },
      { issues: [issue({ title: '定位SQLite COMMIT峰值测试在完整CI的原十五秒超时' })] },
    );
    const run = await runIntakeJob(h.deps);
    expect(h.started).toEqual([]);
    expect(h.localMarked).toEqual([12]);
    expect(h.comments).toHaveLength(1);
    expect(h.comments[0]?.key).toBe('intake-diagnostic-title');
    expect(h.comments[0]?.body).toContain('诊断型');
    expect(run).toMatchObject({ outcome: 'ok', found: 1 });
    expect(prRead).toBe(0);
    await runIntakeJob(h.deps);
    expect(h.comments).toHaveLength(1); // 再来一轮不重复留言
  });

  it('标题不是诊断型（改代码的单，哪怕写了超时）→ 照常起', async () => {
    const h = harness(
      {},
      { issues: [issue({ title: '『第257条明确capacity』用例改成在限定时间内跑完并留下实测分段耗时' })] },
    );
    await runIntakeJob(h.deps);
    expect(h.localMarked).toEqual([]);
    expect(h.started).toHaveLength(1);
  });

  it('有「已知的模块」时，场景、怎么算做完、原话里的工作流路径都不算（只认这一节列出的）', async () => {
    const inScene = harness(
      {},
      {
        issues: [
          issue({
            body: BODY.replace('创始人要在驾驶舱', '不改 `.github/workflows/ci.yml`。创始人要在驾驶舱'),
          }),
        ],
      },
    );
    await runIntakeJob(inScene.deps);
    expect(inScene.localMarked).toEqual([]);
    expect(inScene.started).toHaveLength(1);

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
    expect(inCriteria.localMarked).toEqual([]);
    expect(inCriteria.started).toHaveLength(1);

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

  it('场景里提到 CI 工作流、已知的模块只列 packages/web/src/x.ts → 不贴「本机做」；已知的模块列了 CI 工作流 → 照旧贴', async () => {
    const mention = harness(
      {},
      {
        issues: [
          issue({
            body: bodyWith(['`packages/web/src/x.ts`']).replace(
              '创始人要在驾驶舱看到每张单走到哪一步。',
              '场景里写了不碰 `.github/workflows/ci.yml`。创始人要在驾驶舱看到每张单走到哪一步。',
            ),
          }),
        ],
      },
    );
    await runIntakeJob(mention.deps);
    expect(mention.localMarked).toEqual([]);
    expect(mention.started.map((s) => s.issueNumber)).toEqual([12]);
    expect(workflowPathIn(mention.started[0]?.body)).toBeNull();

    const listed = harness({}, { issues: [issue({ body: bodyWith(['`.github/workflows/ci.yml`']) })] });
    await runIntakeJob(listed.deps);
    expect(listed.started).toEqual([]);
    expect(listed.localMarked).toEqual([12]);
    expect(listed.comments[0]?.body).toContain('.github/workflows/ci.yml');
  });

  it('没有「已知的模块」一节的老单：场景或怎么算做完里的工作流路径仍贴「本机做」（不放松）', async () => {
    const inScene = harness(
      {},
      {
        issues: [
          issue({
            body: bodyWithoutModules(
              '要改 `.github/workflows/ci.yml`。创始人要在驾驶舱看到每张单走到哪一步。',
            ),
          }),
        ],
      },
    );
    await runIntakeJob(inScene.deps);
    expect(inScene.started).toEqual([]);
    expect(inScene.localMarked).toEqual([12]);
    expect(inScene.comments[0]?.key).toBe('intake-touches-workflows');

    const inCriteria = harness(
      {},
      {
        issues: [
          issue({
            body: bodyWithoutModules('创始人要在驾驶舱看到每张单走到哪一步。', [
              '1. `.github/workflows/ci.yml` 里有一步',
            ]),
          }),
        ],
      },
    );
    await runIntakeJob(inCriteria.deps);
    expect(inCriteria.started).toEqual([]);
    expect(inCriteria.localMarked).toEqual([12]);

    const inQuoteOnly = harness(
      {},
      {
        issues: [
          issue({
            body: bodyWithoutModules().replace(
              '「我回来打开驾驶舱',
              '「顺口说一句 .github/workflows/ci.yml 慢。我回来打开驾驶舱',
            ),
          }),
        ],
      },
    );
    await runIntakeJob(inQuoteOnly.deps);
    expect(inQuoteOnly.localMarked).toEqual([]);
  });

  it('workflowPathIn：没写返回 null；正文不是文字（读不到）抛错，不当成没写（故意造出失败）', () => {
    expect(workflowPathIn(BODY)).toBeNull();
    expect(workflowPathIn('')).toBeNull();
    expect(() => workflowPathIn(undefined)).toThrow(/读不到/);
    expect(() => workflowPathIn(null)).toThrow(/读不到/);
  });

  it('workflowPathIn：已知的模块只写了目录、不带末尾斜杠（`.github/workflows`）也认出来', () => {
    const body = BODY.replace('- `packages/web/src/pages/`：驾驶舱页面', '- `.github/workflows`：加一步');
    expect(body).not.toBe(BODY);
    expect(workflowPathIn(body)).toBe('.github/workflows');
    expect(workflowPathIn(BODY.replace('驾驶舱页面', '驾驶舱页面，和 .github/workflowsx 无关'))).toBeNull();
  });

  it('「已知的模块」写了改标准的路径 → 不起，留一句话（带清单里那条）、贴一次「本机做」，再来一轮不重复留言（决定 0093）', async () => {
    const body = BODY.replace(
      '- `packages/web/src/pages/`：驾驶舱页面',
      '- `agents/shared-rules.md`：通用段',
    );
    const h = harness({}, { issues: [issue({ body })] });
    const run = await runIntakeJob(h.deps);
    expect(h.started).toEqual([]);
    expect(h.localMarked).toEqual([12]);
    expect(h.comments).toHaveLength(1);
    expect(h.comments[0]?.key).toBe('intake-touches-standard');
    expect(h.comments[0]?.body).toContain('agents/shared-rules.md');
    expect(h.comments[0]?.body).toContain('创始人');
    expect(run).toMatchObject({ outcome: 'ok', found: 1 });
    await runIntakeJob(h.deps);
    expect(h.comments).toHaveLength(1);
  });

  it('改标准：目录和通配也认；有「已知的模块」时怎么算做完里的路径不算，没有这一节的老单仍认；只在场景、原话里提到的照拉', async () => {
    const rules = [
      { path: 'agents/subagents/', why: '子代理' },
      { path: 'agents/**/*.md', why: '技能说明' },
      { path: 'packages/conventions/standard-paths.json', why: '清单本身' },
    ];
    const withModule = (m: string) => BODY.replace('- `packages/web/src/pages/`：驾驶舱页面', m);
    expect(standardPathIn(withModule('- `agents/subagents/`：角色'), rules)?.rule.path).toBe(
      'agents/subagents/',
    );
    expect(standardPathIn(withModule('- `agents/skills/commander`：技能'), rules)?.rule.path).toBe(
      'agents/**/*.md',
    );
    expect(standardPathIn(withModule('- `agents/skills/commander/SKILL.md`'), rules)?.path).toBe(
      'agents/skills/commander/SKILL.md',
    );
    // 有「已知的模块」时，怎么算做完里顺口写的标准路径不算
    expect(
      standardPathIn(
        BODY.replace('1. 页面上能看到', '1. packages/conventions/standard-paths.json 多一条；'),
        rules,
      ),
    ).toBeNull();
    // 没有「已知的模块」的老单：怎么算做完里裸写的路径仍算（不放松）
    expect(
      standardPathIn(
        bodyWithoutModules('创始人要在驾驶舱看到每张单走到哪一步。', [
          '1. packages/conventions/standard-paths.json 多一条；',
        ]),
        rules,
      )?.path,
    ).toBe('packages/conventions/standard-paths.json');
    // 单列的一个文件只认点名到它：列了整个包的目录不算碰了
    expect(standardPathIn(withModule('- `packages/conventions/src/`：开单校验'), rules)).toBeNull();
    expect(standardPathIn(withModule('- `agents/test/x.test.ts`'), rules)).toBeNull();
    expect(standardPathIn(BODY, rules)).toBeNull();
    expect(
      standardPathIn(
        BODY.replace('创始人要在驾驶舱', '顺带看了 agents/shared-rules.md，创始人要在驾驶舱'),
        rules,
      ),
    ).toBeNull();
    expect(() => standardPathIn(undefined, rules)).toThrow(/读不到/);
  });

  it('拉单用这个仓自己的标准清单，不用 fleet-dao 本地那份', async () => {
    const seen: string[] = [];
    const own = [{ path: 'docs/own-standard.md', why: '这个仓自己的' }];
    const localOnly = BODY.replace(
      '- `packages/web/src/pages/`：驾驶舱页面',
      '- `agents/shared-rules.md`：通用段',
    );
    const h = harness(
      {
        async standardPaths(repo) {
          seen.push(`${repo.owner}/${repo.name}`);
          return own;
        },
      },
      { issues: [issue({ body: localOnly })] },
    );
    await runIntakeJob(h.deps);
    expect(seen).toEqual(['acme/demo']);
    // agents/shared-rules.md 在 fleet-dao 本地清单里；这个仓的清单没有它，照拉
    expect(h.started).toHaveLength(1);
    expect(h.localMarked).toEqual([]);

    const blocked = harness(
      {
        async standardPaths(repo) {
          seen.push(`${repo.owner}/${repo.name}`);
          return own;
        },
      },
      {
        issues: [
          issue({
            body: BODY.replace('- `packages/web/src/pages/`：驾驶舱页面', '- `docs/own-standard.md`：标准'),
          }),
        ],
      },
    );
    await runIntakeJob(blocked.deps);
    expect(blocked.started).toEqual([]);
    expect(blocked.localMarked).toEqual([12]);
  });

  it('仓档案缺项：没就绪，不拉单，原因写明缺哪几项', async () => {
    let listed = 0;
    const h = harness({
      async repos() {
        return [{ ...REPO, profile: { language: 'go' } }];
      },
      async openIssues() {
        listed += 1;
        return { issues: [issue()], openMilestones: [V1, V2] };
      },
    });
    const run = await runIntakeJob(h.deps);
    expect(listed).toBe(0);
    expect(h.started).toEqual([]);
    expect(run.outcome).toBe('ok');
    expect(run.why).toContain('没就绪');
    expect(run.why).toContain('moduleRoots');
    expect(run.why).toContain('mergeSignals');
    expect(run.why).toContain('standardPathsFile');
    expect(run.why).not.toContain('language');
  });

  it('改标准的清单读不到 → 这张单这一轮不拉、不贴标签不留言，记没查成（故意造出失败）', async () => {
    const h = harness({
      async standardPaths() {
        throw new Error('清单认不出');
      },
    });
    const run = await runIntakeJob(h.deps);
    expect(h.started).toEqual([]);
    expect(h.localMarked).toEqual([]);
    expect(h.comments).toEqual([]);
    expect(run.outcome).toBe('partial');
    expect(run.why).toContain('清单认不出');
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

  it('作者是 github-actions[bot]（本仓工作流用 GITHUB_TOKEN 开的单）→ 过作者门、起任务；random-user 不过、不留言', async () => {
    const bot = harness(
      {},
      { issues: [issue({ author: { login: 'github-actions[bot]', id: 41898282, type: 'Bot' } })] },
    );
    await runIntakeJob(bot.deps);
    expect(bot.started).toHaveLength(1);
    expect(bot.started[0]?.author?.login).toBe('github-actions[bot]');

    const stranger = harness(
      {},
      { issues: [issue({ author: { login: 'random-user', id: 4242, type: 'User' } })] },
    );
    await runIntakeJob(stranger.deps);
    expect(stranger.started).toEqual([]);
    expect(stranger.comments).toEqual([]);
    expect(stranger.planReads).toEqual([]);
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

  it('排队或已叫停、Temporal 里没有任何一代：不算派过，照起', async () => {
    for (const state of ['queued', 'stopped'] as const) {
      const h = harness({
        async issueTask() {
          return { id: 'old-row', state };
        },
      });
      await runIntakeJob(h.deps);
      expect(h.started).toHaveLength(1);
    }
  });

  it('有一代在跑，或已做完的一代：不再起', async () => {
    const running = harness({
      async issueTask() {
        return { id: 'old-row', state: 'queued' };
      },
      async taskGenerations() {
        return { ok: true, lives: ['running'] };
      },
    });
    await runIntakeJob(running.deps);
    expect(running.started).toEqual([]);
    const done = harness({
      async issueTask() {
        return { id: 'old-row', state: 'done' };
      },
      async taskGenerations() {
        return { ok: true, lives: ['terminated'] };
      },
    });
    await runIntakeJob(done.deps);
    expect(done.started).toEqual([]);
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

  it('拉两轮同一张好单：第二轮有一代在跑，只起一条', async () => {
    const seen: number[] = [];
    const h = harness({
      async issueTask(_r, n) {
        return seen.includes(n) ? { id: `t-${n}`, state: 'running' } : null;
      },
      async taskGenerations(_r, n) {
        return seen.includes(n) ? { ok: true, lives: ['running'] } : { ok: true, lives: [] };
      },
      async start({ issueNumber, title, body, author }) {
        seen.push(issueNumber);
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

  it('【故意造出的失败】「怎么算做完」要截图（不是 issue:new 开的单也挡）→ 不起，留言写清哪一条、认出的词、怎么改；同样的条目第二轮不再留（决定 0093）', async () => {
    const body = bodyWith(
      ['`packages/web/src/pages/`'],
      ['1. 页面上能看到「验收中」', '2. 带 1366、390 两张截图'],
    );
    const h = harness({}, { issues: [issue({ body })] });
    const first = await runIntakeJob(h.deps);
    expect(h.started).toEqual([]);
    expect(h.comments).toHaveLength(1);
    expect(h.comments[0]?.key).toMatch(/^intake-off-diff:/);
    expect(h.comments[0]?.body).toMatch(
      /diff 外的证据[\s\S]*带 1366、390 两张截图（认出：截图）[\s\S]*测试输出里看得见/,
    );
    expect(first.found).toBe(1);
    await runIntakeJob(h.deps);
    expect(h.comments).toHaveLength(1);
    expect(h.started).toEqual([]);
  });

  it('「怎么算做完」改成测试里看得见的写法 → 照常起；键随命中的条目变', async () => {
    const body = bodyWith(
      ['`packages/web/src/pages/`'],
      ['1. `packages/web/test/a.test.ts` 断言出现「验收中」'],
    );
    const h = harness({}, { issues: [issue({ body })] });
    await runIntakeJob(h.deps);
    expect(h.started).toHaveLength(1);
    expect(offDiffKey([{ item: 'a', words: ['截图'] }])).not.toBe(
      offDiffKey([{ item: 'b', words: ['截图'] }]),
    );
  });

  it.each([
    ['#2032 真单原文', 2032, ISSUE_2032_BODY, ['healthz', '本单注明', 'SSH']],
    ['#2082 真单原文', 2082, ISSUE_2082_BODY, ['日志', 'healthz', 'SSH']],
  ] as const)('%s：换了说法也命中，交给整理会话改写，不起任务', async (_name, number, body, words) => {
    const h = harness({}, { issues: [issue({ number, body })] });
    const first = await runIntakeJob(h.deps);

    expect(h.started).toEqual([]);
    expect(h.comments).toHaveLength(1);
    expect(h.comments[0]?.body).toContain('是哪一条');
    for (const word of words) expect(h.comments[0]?.body).toContain(word);
    expect(first.found).toBe(1);
    expect(first.outcome).toBe('ok');
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

  it('两个仓各 10 张候选、在跑上限 6：按仓轮转，各起 3 条；名单换序结果不变', async () => {
    const a = { ...REPO, id: 'r1', owner: 'zeta', name: 'later' };
    const b = { ...REPO, id: 'r2', owner: 'alpha', name: 'earlier' };
    const runWith = async (repos: (typeof REPO)[]) => {
      const h = harness({
        limits: { maxStartsPerRound: 6, maxRunningTasks: 6, maxStartsPerHour: 99 },
        async repos() {
          return repos;
        },
        async openIssues(repo) {
          const base = repo.id === 'r1' ? 100 : 200;
          return {
            issues: Array.from({ length: 10 }, (_, i) => issue({ number: base + i })),
            openMilestones: [V1, V2],
          };
        },
      });
      await runIntakeJob(h.deps);
      return h.started.map((s) => s.issueNumber);
    };
    const first = await runWith([a, b]);
    const second = await runWith([b, a]);
    expect(first).toEqual([100, 200, 101, 201, 102, 202]);
    expect(second).toEqual(first);
  });

  it('一个仓没单时，另一个仓能吃满 6 个名额', async () => {
    const empty = { ...REPO, id: 'r1', name: 'empty' };
    const busy = { ...REPO, id: 'r2', name: 'busy' };
    const h = harness({
      limits: { maxStartsPerRound: 6, maxRunningTasks: 6, maxStartsPerHour: 99 },
      async repos() {
        return [empty, busy];
      },
      async openIssues(repo) {
        return {
          issues: repo.id === busy.id ? Array.from({ length: 10 }, (_, i) => issue({ number: 300 + i })) : [],
          openMilestones: [V1, V2],
        };
      },
    });
    await runIntakeJob(h.deps);
    expect(h.started).toHaveLength(6);
    expect(h.started.every((s) => s.issueNumber >= 300)).toBe(true);
  });

  it('A 仓熔断时只停 A，B 仓照样起单', async () => {
    const a = { ...REPO, id: 'r1', name: 'a' };
    const b = { ...REPO, id: 'r2', name: 'b' };
    const h = harness({
      limits: { maxStartsPerRound: 6, maxRunningTasks: 6, maxStartsPerHour: 99 },
      async repos() {
        return [a, b];
      },
      async openIssues(repo) {
        return {
          issues: [issue({ number: repo.id === a.id ? 401 : 501 })],
          openMilestones: [V1, V2],
        };
      },
      async breaker(repo) {
        return repo.id === a.id
          ? { open: { since: new Date(NOW.getTime() - 30 * 60_000), trial: null }, recent: [] }
          : { open: null, recent: [] };
      },
    });
    await runIntakeJob(h.deps);
    expect(h.started.map((s) => s.issueNumber)).toEqual([501]);
    expect(h.logs.some((l) => l.text.includes('breaker_open×1'))).toBe(true);
  });

  it('在跑的任务已经到上限 → 一条都不起（不是丢，下一轮再来）', async () => {
    const h = harness({
      async runningTasks() {
        return { working: MAX_RUNNING_TASKS, stalled: 0 };
      },
    });
    const run = await runIntakeJob(h.deps);
    expect(h.started).toEqual([]);
    expect(run.outcome).toBe('ok');
  });

  it('6 条在跑工作流全停下等人 → 不占名额，这一轮照起 1 条，不报 at_capacity（#1776）', async () => {
    const h = harness({
      async runningTasks() {
        return { working: 0, stalled: MAX_RUNNING_TASKS };
      },
    });
    await runIntakeJob(h.deps);
    expect(h.started).toHaveLength(1);
    const text = h.logs.map((l) => l.text).join(' | ');
    expect(text).not.toContain('at_capacity');
    expect(text).toContain('停下等人 6 条（不占名额）');
  });

  it('6 条里 5 条在干活、1 条停下：上限 6 时还能起 1 条（#1776）', async () => {
    const h = harness(
      {
        async runningTasks() {
          return { working: MAX_RUNNING_TASKS - 1, stalled: 1 };
        },
      },
      { issues: [issue({ number: 1 }), issue({ number: 2 })] },
    );
    await runIntakeJob(h.deps);
    expect(h.started.map((s) => s.issueNumber)).toEqual([1]);
  });

  it('6 条都在干活 → at_capacity，说明里写出在干活和停下等人各几条（#1776）', async () => {
    const h = harness({
      async runningTasks() {
        return { working: MAX_RUNNING_TASKS, stalled: 2 };
      },
    });
    await runIntakeJob(h.deps);
    expect(h.started).toEqual([]);
    const text = h.logs.map((l) => l.text).join(' | ');
    expect(text).toContain('at_capacity');
    expect(text).toContain('开头在干活 6 条、停下等人 2 条（不占名额）');
  });

  it('起了几条就把在跑数加几：上限是 2、已经在跑 1 条，这一轮只起 1 条', async () => {
    const h = harness(
      {
        async runningTasks() {
          return { working: 1, stalled: 0 };
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
      async issueTask() {
        throw new Error('库读不到');
      },
    });
    const run = await runIntakeJob(h.deps);
    expect(run.outcome).toBe('partial');
    expect(run.why).toContain('库读不到');
    expect(h.started).toEqual([]);
  });

  it('问工作流抛错：这张记没查成，不当成没有工作流再起', async () => {
    const h = harness({
      async issueTask() {
        return { id: 'old-row', state: 'queued' };
      },
      async taskGenerations() {
        throw new Error('UNAVAILABLE');
      },
    });
    const run = await runIntakeJob(h.deps);
    expect(run.outcome).toBe('partial');
    expect(run.why).toContain('不确定');
    expect(run.why).toContain('没有当成没有工作流');
    expect(run.why).toContain('UNAVAILABLE');
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

describe('准入 · 正文里的「前置：」（#2783）', () => {
  /** BODY 的场景段开头加一行 */
  const withPre = (line: string) => BODY.replace('## 场景\n\n', `## 场景\n\n${line}\n\n`);
  const why = (h: Harness) => {
    const r = h.finished[0]?.result;
    return r && 'why' in r ? (r.why ?? '') : '';
  };

  it('前置单还开着（在开着的单列表里）→ 不拉，原因写「等前置 #N」；不留言、不贴「本机做」；一次也没为它读 GitHub', async () => {
    const h = harness(
      {},
      {
        issues: [issue({ number: 12, body: withPre('前置：#5（先做它）合并后再做') }), issue({ number: 5 })],
      },
    );
    const run = await runIntakeJob(h.deps);
    // 5 号自己没有前置，照拉；12 号等它
    expect(h.started.map((s) => s.issueNumber)).toEqual([5]);
    expect(h.comments).toEqual([]);
    expect(h.localMarked).toEqual([]);
    expect(h.prereqReads).toEqual([]);
    expect(run.outcome).toBe('ok');
    expect(why(h)).toContain('waiting_prerequisite×1');
    expect(why(h)).toContain('#12 等前置 #5');
    // 日志里也看得到是哪张等哪张
    expect(h.logs.some((l) => l.text.includes('#12 等前置 #5'))).toBe(true);
  });

  it('前置单关了 → 照常拉；不在开着的单列表里的前置单一批问一次（几张单、几个前置单也只问一次，去重）', async () => {
    const h = harness(
      {},
      {
        issues: [
          issue({ number: 12, body: withPre('前置：#5、#6') }),
          issue({ number: 13, body: withPre('前置：#6 #7') }),
        ],
        prereqStates: { 5: 'closed', 6: 'closed', 7: 'closed' },
      },
    );
    await runIntakeJob(h.deps);
    expect(h.started.map((s) => s.issueNumber).sort()).toEqual([12, 13]);
    expect(h.prereqReads).toEqual([[5, 6, 7]]);
  });

  it('前置单是开着的 PR（不在开着的单列表里，批量读回 open）→ 不拉', async () => {
    const h = harness(
      {},
      { issues: [issue({ number: 12, body: withPre('前置：#40') })], prereqStates: { 40: 'open' } },
    );
    await runIntakeJob(h.deps);
    expect(h.started).toEqual([]);
    expect(h.prereqReads).toEqual([[40]]);
    expect(why(h)).toContain('#12 等前置 #40');
  });

  it('几个前置单只有一部分还开着：只写开着的；前置都关了的下一轮照常拉', async () => {
    const states: Record<number, 'open' | 'closed'> = { 5: 'closed', 6: 'open' };
    const h = harness(
      {},
      { issues: [issue({ number: 12, body: withPre('前置：#5、#6') })], prereqStates: states },
    );
    await runIntakeJob(h.deps);
    expect(h.started).toEqual([]);
    expect(why(h)).toContain('#12 等前置 #6');
    expect(why(h)).not.toContain('等前置 #5');
    states[6] = 'closed'; // 前置合了
    await runIntakeJob(h.deps);
    expect(h.started.map((s) => s.issueNumber)).toEqual([12]);
  });

  it('【故意造出的失败】前置单开没开读不到 → 按「等前置」算、不拉，记进这一轮的没查成（partial），不当成都关了；没写前置的单照拉', async () => {
    const h = harness(
      {
        async prerequisiteStates() {
          throw new Error('GraphQL 502');
        },
      },
      { issues: [issue({ number: 12, body: withPre('前置：#5') }), issue({ number: 13 })] },
    );
    const run = await runIntakeJob(h.deps);
    expect(h.started.map((s) => s.issueNumber)).toEqual([13]);
    expect(run.outcome).toBe('partial');
    expect(run.why).toContain('#12');
    expect(run.why).toContain('前置');
    expect(run.why).toContain('GraphQL 502');
    expect(h.comments).toEqual([]);
    expect(h.localMarked).toEqual([]);
  });

  it('【故意造出的失败】问回来的结果里缺了某个前置单 → 同样算没查成、不拉', async () => {
    const h = harness(
      {
        async prerequisiteStates() {
          return new Map();
        },
      },
      { issues: [issue({ number: 12, body: withPre('前置：#5') })] },
    );
    const run = await runIntakeJob(h.deps);
    expect(h.started).toEqual([]);
    expect(run.outcome).toBe('partial');
    expect(run.why).toContain('#5');
  });

  it('作者不在白名单的单，正文里的前置号不进批量读', async () => {
    const h = harness(
      {},
      {
        issues: [
          issue({ number: 12, body: withPre('前置：#40') }),
          issue({
            number: 13,
            author: { login: 'stranger', id: 99, type: 'User' },
            body: withPre('前置：#41、#42'),
          }),
        ],
        prereqStates: { 40: 'closed', 41: 'open', 42: 'open' },
      },
    );
    await runIntakeJob(h.deps);
    expect(h.prereqReads).toEqual([[40]]);
    expect(h.started.map((s) => s.issueNumber)).toEqual([12]);
  });

  it('日期前置：北京时间到那天之前不拉，原因写「等到 2026-10-03」，不读 GitHub；到了那天照常拉', async () => {
    const h = harness({}, { issues: [issue({ number: 12, body: withPre('前置：2026-10-03 复查日') })] });
    await runIntakeJob(h.deps); // NOW = 2026-10-02 22:00（北京时间）
    expect(h.started).toEqual([]);
    expect(h.prereqReads).toEqual([]);
    expect(why(h)).toContain('#12 等到 2026-10-03');
    const later = harness(
      { now: () => new Date('2026-10-02T16:00:00Z') }, // 北京时间 10-03 0 点
      { issues: [issue({ number: 12, body: withPre('前置：2026-10-03 复查日') })] },
    );
    await runIntakeJob(later.deps);
    expect(later.started.map((s) => s.issueNumber)).toEqual([12]);
  });

  it('单号和日期同写：前置单关了、日期没到仍不拉；原因两样都写', async () => {
    const h = harness({}, { issues: [issue({ number: 12, body: withPre('前置：#5 且 2026-10-03') })] });
    await runIntakeJob(h.deps);
    expect(h.started).toEqual([]);
    expect(why(h)).toContain('#12 等到 2026-10-03');
  });

  it('不是「前置：」开头的行里写的 #N、代码块里的例子都不算：照拉，不读前置单', async () => {
    const body = BODY.replace(
      '## 场景\n\n',
      '## 场景\n\n顺带看 #5，和 #6 有关。\n\n```\n前置：#7\n```\n\n- 前置：#8\n\n',
    );
    const h = harness(
      {},
      { issues: [issue({ number: 12, body })], prereqStates: { 5: 'open', 7: 'open', 8: 'open' } },
    );
    await runIntakeJob(h.deps);
    expect(h.started.map((s) => s.issueNumber)).toEqual([12]);
    expect(h.prereqReads).toEqual([]);
  });

  it('已经派出过的单不看前置（原因仍是已经派出过）', async () => {
    const h = harness(
      {},
      { issues: [issue({ number: 12, body: withPre('前置：#5') }), issue({ number: 5 })], dispatched: [12] },
    );
    await runIntakeJob(h.deps);
    expect(why(h)).toContain('already_dispatched×1');
    expect(why(h)).not.toContain('waiting_prerequisite');
  });

  it('前置排在改工作流、改标准、PR 挂单这些「贴本机做」的关前面：前置没合的单不被提前贴上「本机做」', async () => {
    const body = withPre('前置：#5').replace('packages/web/src/pages/', '.github/workflows/ci.yml');
    const h = harness({}, { issues: [issue({ number: 12, body })], prereqStates: { 5: 'open' } });
    await runIntakeJob(h.deps);
    expect(h.started).toEqual([]);
    expect(h.localMarked).toEqual([]);
    expect(h.comments).toEqual([]);
  });
});

describe('judgePrerequisites：拉单和点名派单共用的前置判法（#3298）', () => {
  const at = new Date('2026-10-02T14:00:00Z'); // 北京时间 10-02 22:00
  const states =
    (got: Record<number, 'open' | 'closed'>, asked: number[][] = []) =>
    async (numbers: readonly number[]) => {
      asked.push([...numbers]);
      return new Map(numbers.flatMap((n) => (got[n] ? [[n, got[n]] as const] : [])));
    };

  it('没写前置、前置都关了：clear；开着的：waiting 只写开着的', async () => {
    expect(await judgePrerequisites(BODY, at, states({}))).toEqual({ kind: 'clear' });
    expect(await judgePrerequisites('前置：#5、#6', at, states({ 5: 'closed', 6: 'closed' }))).toEqual({
      kind: 'clear',
    });
    expect(await judgePrerequisites('前置：#5、#6', at, states({ 5: 'closed', 6: 'open' }))).toEqual({
      kind: 'waiting',
      why: '等前置 #6',
    });
  });

  it('日期没到：waiting「等到 <日期>」，不读前置单；北京时间那天 0 点起不再等', async () => {
    const asked: number[][] = [];
    expect(await judgePrerequisites('前置：#5 2026-10-03', at, states({}, asked))).toEqual({
      kind: 'waiting',
      why: '等到 2026-10-03',
    });
    expect(asked).toEqual([]);
    expect(
      await judgePrerequisites('前置：2026-10-03', new Date('2026-10-02T16:00:00Z'), states({})),
    ).toEqual({ kind: 'clear' });
  });

  it('【故意造出的失败】读失败、缺号：unchecked，写明没查成，不当成都关了', async () => {
    const thrown = await judgePrerequisites('前置：#5', at, async () => {
      throw new Error('GraphQL 502');
    });
    expect(thrown).toMatchObject({ kind: 'unchecked', numbers: [5] });
    expect(thrown.kind === 'unchecked' && thrown.why).toContain('GraphQL 502');
    const missing = await judgePrerequisites('前置：#5、#6', at, states({ 5: 'closed' }));
    expect(missing).toMatchObject({ kind: 'unchecked', numbers: [5, 6] });
    expect(missing.kind === 'unchecked' && missing.why).toContain('#6 没读到状态');
  });

  it('代码块、引用里的「前置：」是举例：clear，不读前置单；正文不是文字就抛', async () => {
    const asked: number[][] = [];
    const body = '```\n前置：#7\n```\n\n> 前置：#8';
    expect(await judgePrerequisites(body, at, states({ 7: 'open', 8: 'open' }, asked))).toEqual({
      kind: 'clear',
    });
    expect(asked).toEqual([]);
    await expect(judgePrerequisites(null, at, states({}))).rejects.toThrow('单正文读不到');
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

  it(`一小时里最多起 ${MAX_STARTS_PER_HOUR} 条：已经起了 19 条，这一轮只再起 1 条`, async () => {
    const h = harness({}, { issues: many(3), hourStarted: MAX_STARTS_PER_HOUR - 1 });
    await runIntakeJob(h.deps);
    expect(h.started.map((s) => s.issueNumber)).toEqual([200]);
    expect(h.logs.some((l) => l.text.includes('hourly_cap×2'))).toBe(true);
  });

  it(`【故意造出的失败】滚动一小时里已经起了 ${MAX_STARTS_PER_HOUR} 条：第 21 条不起，记 ok（不是没跑成）`, async () => {
    const h = harness({}, { issues: many(2), hourStarted: MAX_STARTS_PER_HOUR });
    const run = await runIntakeJob(h.deps);
    expect(h.started).toEqual([]);
    expect(run.outcome).toBe('ok');
  });

  it(`同一轮里也数：已经起了 ${MAX_STARTS_PER_HOUR - 3} 条时，8 张合格的单这一轮只起 3 条`, async () => {
    const h = harness({}, { issues: many(8), hourStarted: MAX_STARTS_PER_HOUR - 3 });
    await runIntakeJob(h.deps);
    expect(h.started).toHaveLength(3);
  });

  it('【故意造出的失败】旧上限 12 不再生效：已经起了 12 条时，8 张合格的单这一轮仍能起（每轮上限 5 先到）', async () => {
    const h = harness({}, { issues: many(8), hourStarted: 12 });
    await runIntakeJob(h.deps);
    expect(h.started).toHaveLength(5);
    expect(h.logs.some((l) => l.text.includes('hourly_cap'))).toBe(false);
  });

  it('已经起了 15 条时，8 张合格的单这一轮还能起 5 条；已经起了 19 条，只剩 1 条', async () => {
    const fifteen = harness({}, { issues: many(8), hourStarted: 15 });
    await runIntakeJob(fifteen.deps);
    expect(fifteen.started).toHaveLength(5);
    const nineteen = harness({}, { issues: many(8), hourStarted: 19 });
    await runIntakeJob(nineteen.deps);
    expect(nineteen.started).toHaveLength(1);
  });

  it('只因没空位没起的单按仓记下张数（看门狗判「主线 N 小时没合 PR」时用，决定 0093）；起完了的仓记 0', async () => {
    const records: { at: Date; byRepo: Record<string, number> }[] = [];
    const full = harness(
      { recordWaiting: async (x) => void records.push(x) },
      { issues: many(3), hourStarted: MAX_STARTS_PER_HOUR - 1 },
    );
    await runIntakeJob(full.deps);
    expect(records).toEqual([{ at: NOW, byRepo: { [REPO.id]: 2 } }]);
    records.length = 0;
    const roomy = harness({ recordWaiting: async (x) => void records.push(x) }, { issues: many(1) });
    await runIntakeJob(roomy.deps);
    expect(records).toEqual([{ at: NOW, byRepo: { [REPO.id]: 0 } }]);
  });

  it('【故意造出的失败】等空位的单数没记下：这一轮记只查了一部分、写明原因，不冒充记过', async () => {
    const h = harness(
      {
        recordWaiting: async () => {
          throw new Error('库写不进');
        },
      },
      { issues: many(1) },
    );
    await runIntakeJob(h.deps);
    expect(h.started).toHaveLength(1);
    const result = h.finished[0]?.result;
    expect(result?.outcome).toBe('partial');
    expect(result?.outcome === 'partial' ? result.why : '').toContain('每个仓等空位的单数没记下');
  });

  it('限速时不为排在后面的单多读 GitHub：满了就不现读', async () => {
    const h = harness({}, { issues: many(2), hourStarted: MAX_STARTS_PER_HOUR });
    await runIntakeJob(h.deps);
    expect(h.planReads).toEqual([]);
  });
});

describe('名额档位（错误预算，jobs/self-share.ts）', () => {
  const SELF = { ...REPO, id: 'r1', owner: 'acme', name: 'fleet-dao' };
  const REAL = { ...REPO, id: 'r2', owner: 'acme', name: 'fluxwatch' };
  const LIMITS = { maxStartsPerRound: 10, maxRunningTasks: 10, maxStartsPerHour: 99 };
  const fresh = (tier: 'healthy' | 'spending' | 'frozen') => async () => ({
    tier,
    at: new Date(NOW.getTime() - 3_600_000),
    day: '2026-10-02',
  });
  /** 自身仓单号 100 起 8 张，真实项目单号 200 起 8 张。selfRunning：自身仓开头已在跑几条。 */
  function twoRepos(over: Partial<IntakeDeps>, selfRunning = 0) {
    return harness({
      limits: LIMITS,
      async repos() {
        return [SELF, REAL];
      },
      async openIssues(repo) {
        const base = repo.id === SELF.id ? 100 : 200;
        return {
          issues: Array.from({ length: 8 }, (_, i) => issue({ number: base + i })),
          openMilestones: [V1, V2],
        };
      },
      async runningTasks() {
        return { working: selfRunning, stalled: 0, byRepo: { [SELF.id]: selfRunning } };
      },
      ...over,
    });
  }
  const selfStarted = (h: Harness) => h.started.filter((s) => s.issueNumber < 200).length;
  const realStarted = (h: Harness) => h.started.filter((s) => s.issueNumber >= 200).length;

  it('健康：fleet-dao 自身单最多占在跑名额（10）的 30%＝3 条，真实项目照拉', async () => {
    const h = twoRepos({ selfShare: fresh('healthy') });
    const run = await runIntakeJob(h.deps);
    expect(selfStarted(h)).toBe(3);
    expect(realStarted(h)).toBe(7); // 在跑上限 10 里剩下的 7 条都给了真实项目
    expect(run.outcome).toBe('ok');
    expect(h.logs.some((l) => l.text.includes('self_share_hold×5'))).toBe(true);
  });

  it('耗预算：自身单最多占 50%＝5 条', async () => {
    const h = twoRepos({ selfShare: fresh('spending') });
    await runIntakeJob(h.deps);
    expect(selfStarted(h)).toBe(5);
    expect(realStarted(h)).toBe(5);
  });

  it('已经在跑的自身单也算份额：健康档开头自身单已在跑 2 条，这一轮只再起 1 条', async () => {
    const h = twoRepos({ selfShare: fresh('healthy') }, 2);
    await runIntakeJob(h.deps);
    expect(selfStarted(h)).toBe(1);
  });

  it('在跑上限很小（2）：健康档 30% 取整是 0 条，不凑出 1 条超份额；耗预算 50% 是 1 条', async () => {
    const small = { maxStartsPerRound: 10, maxRunningTasks: 2, maxStartsPerHour: 99 };
    const healthy = twoRepos({ selfShare: fresh('healthy'), limits: small });
    await runIntakeJob(healthy.deps);
    expect(selfStarted(healthy)).toBe(0);
    expect(realStarted(healthy)).toBe(2);
    const spending = twoRepos({ selfShare: fresh('spending'), limits: small });
    await runIntakeJob(spending.deps);
    expect(selfStarted(spending)).toBe(1);
  });

  it('冻结：只拉 fleet-dao 自身单，别的仓不拉新单；自身单不按成数限', async () => {
    const h = twoRepos({ selfShare: fresh('frozen') });
    const run = await runIntakeJob(h.deps);
    expect(realStarted(h)).toBe(0);
    expect(selfStarted(h)).toBe(8);
    expect(run.outcome).toBe('ok');
    expect(h.logs.some((l) => l.text.includes('self_share_hold×8'))).toBe(true);
  });

  it('冻结时在跑的照跑：不去动已经在跑的，也不对被挡下的单现读 GitHub', async () => {
    const h = twoRepos({
      selfShare: fresh('frozen'),
      async runningTasks() {
        return { working: 4, stalled: 0, byRepo: { [REAL.id]: 4 } };
      },
    });
    await runIntakeJob(h.deps);
    expect(h.planReads.every((n) => n < 200)).toBe(true);
  });

  it('被档位挡下的单不记进「等空位」（看门狗不把它当引擎有活可接却没接）', async () => {
    const records: { at: Date; byRepo: Record<string, number> }[] = [];
    const h = twoRepos({ selfShare: fresh('frozen'), recordWaiting: async (x) => void records.push(x) });
    await runIntakeJob(h.deps);
    expect(records[0]?.byRepo[REAL.id]).toBe(0);
  });

  it('档位里的 stalled 不影响：自身单份额只数在干活的', async () => {
    const h = twoRepos({
      selfShare: fresh('healthy'),
      async runningTasks() {
        return { working: 0, stalled: 5, byRepo: {} };
      },
    });
    await runIntakeJob(h.deps);
    expect(selfStarted(h)).toBe(3);
  });

  it('读不到档位（没有这一行）：照现行行为拉单，记一条日志', async () => {
    const h = twoRepos({ selfShare: async () => null });
    const run = await runIntakeJob(h.deps);
    // 没有档位限：两个仓按权重交错，把在跑上限 10 吃满
    expect(h.started).toHaveLength(10);
    expect(selfStarted(h)).toBeGreaterThan(3);
    expect(realStarted(h)).toBeGreaterThan(0);
    expect(run.outcome).toBe('ok');
    const warns = h.logs.filter((l) => l.level === 'warn' && l.text.includes('名额档位读不到'));
    expect(warns).toHaveLength(1);
    expect(h.logs.some((l) => l.text.includes('self_share_hold'))).toBe(false);
  });

  it('读不到档位（读失败）：照现行行为拉单，日志写明原因；不当成冻结也不当成健康', async () => {
    const h = twoRepos({
      selfShare: async () => {
        throw new Error('设置值认不出');
      },
    });
    const run = await runIntakeJob(h.deps);
    expect(h.started).toHaveLength(10);
    expect(run.outcome).toBe('ok');
    expect(h.logs.some((l) => l.level === 'warn' && l.text.includes('设置值认不出'))).toBe(true);
  });

  it('读不到档位（超过 72 小时没更新，简报停了）：当读不到，别让冻结的结论永远挂着', async () => {
    const h = twoRepos({
      selfShare: async () => ({
        tier: 'frozen',
        at: new Date(NOW.getTime() - 73 * 3_600_000),
        day: '2026-09-29',
      }),
    });
    await runIntakeJob(h.deps);
    expect(realStarted(h)).toBeGreaterThan(0);
    expect(h.logs.some((l) => l.level === 'warn' && l.text.includes('名额档位读不到'))).toBe(true);
  });

  it('没接档位（deps.selfShare 不给）：和以前一样，不记日志', async () => {
    const h = twoRepos({});
    await runIntakeJob(h.deps);
    expect(h.started).toHaveLength(10);
    expect(h.logs.some((l) => l.text.includes('名额档位'))).toBe(false);
  });

  it('只有一个仓且不是 fleet-dao：健康档不限它，冻结档停拉', async () => {
    const healthy = harness({ selfShare: fresh('healthy'), limits: LIMITS });
    await runIntakeJob(healthy.deps);
    expect(healthy.started).toHaveLength(1);
    const frozen = harness({ selfShare: fresh('frozen'), limits: LIMITS });
    const run = await runIntakeJob(frozen.deps);
    expect(frozen.started).toEqual([]);
    expect(run.outcome).toBe('ok');
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

describe('仓档案没就绪的提醒（#2839）', () => {
  const FULL_PROFILE = {
    language: 'typescript',
    toolchain: ['pnpm'],
    testCommand: 'pnpm check',
    moduleRoots: ['packages/*'],
    mergeSignals: ['check'],
    standardPathsFile: 'packages/conventions/standard-paths.json',
    weight: 1,
  };

  it('开着接活、档案缺项 → 不拉，推提醒，why 写明缺哪几项（含 language）', async () => {
    const alerts: { why: string | null }[] = [];
    const h = harness({
      async repos() {
        return [{ ...REPO, profile: { toolchain: ['pnpm'] } }];
      },
      async profileAlert(input) {
        alerts.push({ why: input.why });
      },
    });
    await runIntakeJob(h.deps);
    expect(h.started).toEqual([]);
    expect(alerts.length).toBe(1);
    expect(alerts[0]?.why).toContain('缺 language');
  });

  it('档案形状不对（weight 写成 0）→ 不拉，推提醒，why 是 parse 的那句错', async () => {
    const alerts: { why: string | null }[] = [];
    const h = harness({
      async repos() {
        return [{ ...REPO, profile: { ...FULL_PROFILE, weight: 0 } }];
      },
      async profileAlert(input) {
        alerts.push({ why: input.why });
      },
    });
    await runIntakeJob(h.deps);
    expect(h.started).toEqual([]);
    expect(alerts.length).toBe(1);
    expect(alerts[0]?.why).toContain('weight');
  });

  it('开着接活、档案齐 → 照拉，推的是 why 为 null（撤掉）', async () => {
    const alerts: { why: string | null }[] = [];
    const h = harness({
      async repos() {
        return [{ ...REPO, profile: FULL_PROFILE }];
      },
      async profileAlert(input) {
        alerts.push({ why: input.why });
      },
    });
    await runIntakeJob(h.deps);
    expect(h.started.map((s) => s.issueNumber)).toEqual([12]);
    expect(alerts).toEqual([{ why: null }]);
  });

  it('「让 AI 接活」关着的仓：档案缺项也不拉、不推提醒', async () => {
    const alerts: { why: string | null }[] = [];
    const h = harness({
      async repos() {
        return [{ ...REPO, autoDispatchSince: null, profile: { toolchain: ['pnpm'] } }];
      },
      async profileAlert(input) {
        alerts.push({ why: input.why });
      },
    });
    await runIntakeJob(h.deps);
    expect(alerts).toEqual([]);
  });

  it('提醒写不进去：只记 warn 日志，这一轮照常跑完（照起、结局 ok）', async () => {
    const h = harness({
      async repos() {
        return [{ ...REPO, profile: FULL_PROFILE }];
      },
      async profileAlert() {
        throw new Error('库断了');
      },
    });
    const run = await runIntakeJob(h.deps);
    expect(h.started.map((s) => s.issueNumber)).toEqual([12]);
    expect(run.outcome).toBe('ok');
    expect(h.logs.some((l) => l.level === 'warn' && l.text.includes('仓档案的提醒没写成'))).toBe(true);
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

describe('本机退回法国队列的单（#3461）：重新派、法国接不了的留给本机', () => {
  const T_END = new Date('2026-10-02T06:00:00.000Z');
  const T_RETURN = new Date('2026-10-02T10:00:00.000Z');
  const offDiffBody = bodyWith(
    ['`packages/web/src/pages/`'],
    ['1. 页面上能看到「验收中」', '2. 带 1366、390 两张截图'],
  );
  const whyOf = (h: Harness) => {
    const r = h.finished[0]?.result;
    return r && 'why' in r ? (r.why ?? '') : '';
  };

  /** 这张单以前在法国跑过 n 代、都结束了；退回在 returnedAt。 */
  function returned(opts: { returnedAt?: Date; lives?: number; endedAt?: Date } = {}) {
    const lives = Array.from({ length: opts.lives ?? 1 }, () => 'terminated' as const);
    const calls: { generation: number | undefined; issueNumber: number }[] = [];
    const notices: { issueNumber: number; key: string; title: string; body: string }[] = [];
    const over: Partial<IntakeDeps> = {
      async issueTask(): Promise<IssueTaskRow | null> {
        return {
          id: 'old-row',
          state: 'stopped',
          executor: 'engine',
          returnedAt: opts.returnedAt ?? T_RETURN,
        };
      },
      async taskGenerations(): Promise<TaskGenerationFacts> {
        return { ok: true, lives, lastEndedAt: opts.endedAt ?? T_END };
      },
      async start({ issueNumber, generation }) {
        calls.push({ issueNumber, generation });
        return 'started';
      },
      async notifyLocal(n) {
        notices.push({ issueNumber: n.issueNumber, key: n.key, title: n.title, body: n.body });
      },
    };
    return { over, calls, notices };
  }

  it('stopped + engine + 已结束的一代 + 在那之后退回 → 拉单起 :r2（第 2 代），不是 already_dispatched', async () => {
    const r = returned();
    const h = harness(r.over);
    const run = await runIntakeJob(h.deps);
    expect(r.calls).toEqual([{ issueNumber: 12, generation: 2 }]);
    expect(run).toMatchObject({ outcome: 'ok', found: 1 });
    expect(h.logs.some((l) => l.text.includes('起了'))).toBe(true);
  });

  it('已经有两代都结束 → 起第 3 代', async () => {
    const r = returned({ lives: 2 });
    await runIntakeJob(harness(r.over).deps);
    expect(r.calls).toEqual([{ issueNumber: 12, generation: 3 }]);
  });

  it('退回早于最后一代结束（退回之后已经又起过一代）→ 仍是 already_dispatched，不起', async () => {
    const r = returned({ returnedAt: new Date('2026-10-02T05:00:00.000Z') });
    const h = harness(r.over);
    await runIntakeJob(h.deps);
    expect(r.calls).toEqual([]);
    expect(whyOf(h)).toContain('already_dispatched×1');
  });

  it('重新派照样走完空位限制：这一轮起满了就不起，也不绕过去直接重做', async () => {
    const r = returned();
    const h = harness({ ...r.over, limits: { maxStartsPerRound: 0 } });
    await runIntakeJob(h.deps);
    expect(r.calls).toEqual([]);
    expect(whyOf(h)).toContain('round_cap×1');
  });

  it('重新派照样走完准入关卡：前置没等完的不起、也不贴「本机做」', async () => {
    const r = returned();
    const body = [BODY, '前置：#99', ''].join('\n');
    const h = harness(r.over, { issues: [issue({ body })], prereqStates: { 99: 'open' } });
    await runIntakeJob(h.deps);
    expect(r.calls).toEqual([]);
    expect(h.localMarked).toEqual([]);
    expect(r.notices).toEqual([]);
  });

  it('本机退回来的单，验收要 diff 外证据（法国接不了）：不起，贴回「本机做」、留言、报给本机', async () => {
    const r = returned();
    const h = harness(r.over, { issues: [issue({ body: offDiffBody })] });
    await runIntakeJob(h.deps);
    expect(r.calls).toEqual([]);
    expect(h.localMarked).toEqual([12]);
    expect(r.notices).toHaveLength(1);
    expect(r.notices[0]?.key).toMatch(/^intake-returned-blocked:/);
    expect(r.notices[0]?.body).toContain('acceptance_off_diff');
    expect(r.notices[0]?.body).toContain('截图');
    expect(h.comments.map((c) => c.key)).toContain(r.notices[0]?.key);
  });

  it('撤「留给本机」的提醒：这一轮贴上「本机做」的和本来就贴着的单号留着，其余的交给撤', async () => {
    const r = returned();
    const settled: number[][] = [];
    const h = harness(
      {
        ...r.over,
        async settleLocalKept({ keep }) {
          settled.push([...keep].sort((a, b) => a - b));
        },
      },
      { issues: [issue({ body: offDiffBody }), issue({ number: 30, labels: ['需求', '本机做'] })] },
    );
    await runIntakeJob(h.deps);
    expect(settled).toEqual([[12, 30]]);
  });

  it('报给本机成了、留言没成：这张单号也算留着，刚建的提醒不被撤', async () => {
    const r = returned();
    const settled: number[][] = [];
    const h = harness(
      {
        ...r.over,
        async comment({ key }) {
          // 拉单先留一句「要 diff 外证据」的改写，那条照常；报给本机之后的这条退回留言写不进
          if (key.startsWith('intake-returned-blocked:')) throw new Error('GitHub 写不进');
          return { created: true };
        },
        async settleLocalKept({ keep }) {
          settled.push([...keep]);
        },
      },
      { issues: [issue({ body: offDiffBody })] },
    );
    const run = await runIntakeJob(h.deps);
    expect(r.notices).toHaveLength(1);
    expect(h.localMarked).toEqual([]);
    expect(settled).toEqual([[12]]);
    expect(run.outcome).toBe('partial');
  });

  /** 场景段开头加一行前置。 */
  const pre = (line: string) => BODY.replace('## 场景\n\n', `## 场景\n\n${line}\n\n`);

  /**
   * 单子贴着「本机做」、是本机退回来没人接的行，库里还挂着「引擎接不了」的提醒；挡着的地方改好没有看 body。
   * 交还与否只看有没有摘标签、号还在不在 keep、结局是不是 ok：不拿错误原文判定。
   */
  function keptReturned(
    body: string,
    over: Partial<IntakeDeps> = {},
    extra: { issue?: Partial<IntakeIssue>; prereqStates?: Record<number, 'open' | 'closed'> } = {},
  ) {
    const r = returned();
    const unmarked: number[] = [];
    const settled: number[][] = [];
    const h = harness(
      {
        ...r.over,
        async keptReturned() {
          return [12];
        },
        async unmarkLocal({ issueNumber }) {
          unmarked.push(issueNumber);
        },
        async settleLocalKept({ keep }) {
          settled.push([...keep]);
        },
        ...over,
      },
      {
        issues: [issue({ body, labels: ['需求', '本机做'], ...extra.issue })],
        ...(extra.prereqStates ? { prereqStates: extra.prereqStates } : {}),
      },
    );
    return { h, r, unmarked, settled };
  }

  it('挡着的地方改好了（引擎现在接得了）：摘「本机做」、提醒跟着撤，这一轮不重新贴、不重复通知', async () => {
    const k = keptReturned(BODY);
    await runIntakeJob(k.h.deps);
    expect(k.unmarked).toEqual([12]);
    expect(k.settled).toEqual([[]]);
    expect(k.h.localMarked).toEqual([]);
    expect(k.r.notices).toEqual([]);
  });

  it('还挡着（验收仍要 diff 外证据）：不摘「本机做」、提醒留着', async () => {
    const k = keptReturned(offDiffBody);
    await runIntakeJob(k.h.deps);
    expect(k.unmarked).toEqual([]);
    expect(k.settled).toEqual([[12]]);
  });

  it('改好了但这张单已经有人接着（本机重新领了）：不摘', async () => {
    const k = keptReturned(BODY, {
      async issueTask(): Promise<IssueTaskRow | null> {
        return { id: 'claimed', state: 'running', executor: 'local' };
      },
      async taskGenerations(): Promise<TaskGenerationFacts> {
        return { ok: true, lives: [] };
      },
    });
    const run = await runIntakeJob(k.h.deps);
    expect(k.unmarked).toEqual([]);
    expect(k.settled).toEqual([[12]]);
    expect(run.outcome).toBe('ok');
  });

  it('贴着「要人拍」：按合同不摘，这一轮是查成了的 ok', async () => {
    const k = keptReturned(BODY, {}, { issue: { labels: ['需求', '本机做', '要人拍'] } });
    const run = await runIntakeJob(k.h.deps);
    expect(k.unmarked).toEqual([]);
    expect(k.settled).toEqual([[12]]);
    expect(run.outcome).toBe('ok');
    expect(k.h.started).toEqual([]);
  });

  it('前置确知还开着：查询成功后按交还合同摘「本机做」，不起任务，结局 ok', async () => {
    const k = keptReturned(pre('前置：#40'), {}, { prereqStates: { 40: 'open' } });
    const run = await runIntakeJob(k.h.deps);
    expect(k.h.prereqReads).toEqual([[40]]);
    expect(k.unmarked).toEqual([12]);
    expect(k.settled).toEqual([[]]);
    expect(k.h.started).toEqual([]);
    expect(run.outcome).toBe('ok');
  });

  it('日期没到：不读前置单，按交还合同摘「本机做」，结局 ok', async () => {
    const k = keptReturned(pre('前置：2026-10-03'));
    const run = await runIntakeJob(k.h.deps);
    expect(k.h.prereqReads).toEqual([]);
    expect(k.unmarked).toEqual([12]);
    expect(k.settled).toEqual([[]]);
    expect(k.h.started).toEqual([]);
    expect(run.outcome).toBe('ok');
  });

  it('前置全部 closed：查询成功后按交还合同摘「本机做」，结局 ok', async () => {
    const k = keptReturned(pre('前置：#40'), {}, { prereqStates: { 40: 'closed' } });
    const run = await runIntakeJob(k.h.deps);
    expect(k.h.prereqReads).toEqual([[40]]);
    expect(k.unmarked).toEqual([12]);
    expect(k.settled).toEqual([[]]);
    expect(k.h.started).toEqual([]);
    expect(run.outcome).toBe('ok');
  });

  it('【故意造出的失败】退回单前置查询抛错：不摘「本机做」，号留在 keep，试判错误进外层且结局不是 ok', async () => {
    // 错误原文写成 closed：不能靠这句话像不像失败来决定交不交还。
    const k = keptReturned(pre('前置：#40'), {
      async prerequisiteStates() {
        throw new Error('closed');
      },
    });
    const run = await runIntakeJob(k.h.deps);
    expect(k.unmarked).toEqual([]);
    expect(k.settled).toEqual([[12]]);
    expect(k.h.started).toEqual([]);
    expect(run.outcome).toBe('partial');
    expect(run.why).toContain('#12');
  });

  it('【故意造出的失败】退回单前置结果缺号：不摘「本机做」，号留在 keep，结局不是 ok', async () => {
    const k = keptReturned(pre('前置：#40、#41'), {
      async prerequisiteStates(_repo, numbers) {
        return new Map(numbers.filter((n) => n === 40).map((n) => [n, 'closed' as const]));
      },
    });
    const run = await runIntakeJob(k.h.deps);
    expect(k.unmarked).toEqual([]);
    expect(k.settled).toEqual([[12]]);
    expect(k.h.started).toEqual([]);
    expect(run.outcome).toBe('partial');
    expect(run.why).toContain('#12');
  });

  it('【故意造出的失败】接手的退回行（没有任何一代）前置查询抛错：同样不摘、号留在 keep', async () => {
    const k = keptReturned(pre('前置：#40'), {
      async taskGenerations(): Promise<TaskGenerationFacts> {
        return { ok: true, lives: [], lastEndedAt: null };
      },
      async prerequisiteStates() {
        throw new Error('closed');
      },
    });
    const run = await runIntakeJob(k.h.deps);
    expect(k.unmarked).toEqual([]);
    expect(k.settled).toEqual([[12]]);
    expect(run.outcome).toBe('partial');
    expect(run.why).toContain('#12');
  });

  it('【故意造出的失败】派出状态 uncertain：不摘、号留在 keep，原因进外层 unchecked', async () => {
    const k = keptReturned(BODY, {
      async taskGenerations(): Promise<TaskGenerationFacts> {
        return { ok: false, why: 'temporal-down' };
      },
    });
    const run = await runIntakeJob(k.h.deps);
    expect(k.unmarked).toEqual([]);
    expect(k.settled).toEqual([[12]]);
    expect(k.h.started).toEqual([]);
    expect(run.outcome).toBe('partial');
    expect(run.why).toContain('#12');
    expect(run.why).toContain('temporal-down');
  });

  it('【故意造出的失败】开单时间认不出：试判没查成，不摘、不把这一轮记成 ok', async () => {
    const k = keptReturned(BODY, {}, { issue: { createdAt: '昨天' } });
    const run = await runIntakeJob(k.h.deps);
    expect(k.unmarked).toEqual([]);
    expect(k.settled).toEqual([[12]]);
    expect(k.h.started).toEqual([]);
    expect(run.outcome).toBe('partial');
    expect(run.why).toContain('#12');
  });

  it('摘标签写不成：这一轮记没查成，标签和提醒都留着', async () => {
    const k = keptReturned(BODY, {
      async unmarkLocal() {
        throw new Error('GitHub 写不进');
      },
    });
    const run = await runIntakeJob(k.h.deps);
    expect(run.outcome).toBe('partial');
    expect(k.settled).toEqual([[12]]);
  });

  it('撤「留给本机」的提醒没成：这一轮记没查成，别的照做', async () => {
    const h = harness(
      {
        async settleLocalKept() {
          throw new Error('库连不上');
        },
      },
      { issues: [issue()] },
    );
    const run = await runIntakeJob(h.deps);
    expect(run.outcome).toBe('partial');
    expect(whyOf(h)).toContain('留给本机的提醒没撤成');
  });

  it('没退回过的单验收要 diff 外证据：照旧只留一条改写的话，不贴「本机做」、不通知', async () => {
    const r = returned({ returnedAt: new Date('2026-10-02T05:00:00.000Z'), endedAt: T_END });
    const plain = harness(
      {
        async notifyLocal(n) {
          r.notices.push({ issueNumber: n.issueNumber, key: n.key, title: n.title, body: n.body });
        },
      },
      { issues: [issue({ body: offDiffBody })] },
    );
    await runIntakeJob(plain.deps);
    expect(plain.localMarked).toEqual([]);
    expect(r.notices).toEqual([]);
    expect(plain.comments.map((c) => c.key)).toEqual([expect.stringMatching(/^intake-off-diff:/)]);
  });

  it('没有任何一代、本机领过又放手的行（接手）：法国接不了同样留给本机', async () => {
    const r = returned();
    const h = harness(
      {
        ...r.over,
        async taskGenerations(): Promise<TaskGenerationFacts> {
          return { ok: true, lives: [], lastEndedAt: null };
        },
      },
      { issues: [issue({ body: offDiffBody })] },
    );
    await runIntakeJob(h.deps);
    expect(h.localMarked).toEqual([12]);
    expect(r.notices).toHaveLength(1);
  });
});

describe('本机租约到期、退回之前先判法国接不接得了（#3461）', () => {
  const LEASE_END = new Date('2026-10-02T13:00:00.000Z');
  const offDiffBody = bodyWith(
    ['`packages/web/src/pages/`'],
    ['1. 页面上能看到「验收中」', '2. 带 1366、390 两张截图'],
  );

  const pre = (line: string) => BODY.replace('## 场景\n\n', `## 场景\n\n${line}\n\n`);

  function withLease(
    body: string,
    over: Partial<IntakeDeps> = {},
    data: {
      prereqStates?: Record<number, 'open' | 'closed'>;
      labels?: string[];
      createdAt?: string;
    } = {},
  ) {
    const steps: string[] = [];
    const notices: { key: string; body: string }[] = [];
    const localLeases: LocalLeaseDeps = {
      async expired() {
        return [{ taskId: 't12', issueNumber: 12, leaseUntil: LEASE_END }];
      },
      async liveIssues() {
        return new Set();
      },
      async mergedPr() {
        return null;
      },
      async extend() {
        steps.push('extend');
      },
      async settle({ how }) {
        steps.push(`settle ${how}`);
        return 1;
      },
      async unmarkLocal() {
        steps.push('unmark');
      },
    };
    const h = harness(
      {
        localLeases,
        async notifyLocal(n) {
          notices.push({ key: n.key, body: n.body });
        },
        ...over,
      },
      {
        issues: [
          issue({
            body,
            labels: data.labels ?? ['需求', '本机做'],
            ...(data.createdAt === undefined ? {} : { createdAt: data.createdAt }),
          }),
        ],
        ...(data.prereqStates ? { prereqStates: data.prereqStates } : {}),
      },
    );
    return { h, steps, notices };
  }

  it('验收要 diff 外证据的单：不摘「本机做」、不退回，通知本机、留一条话写明为什么', async () => {
    const w = withLease(offDiffBody);
    await runIntakeJob(w.h.deps);
    expect(w.steps).toEqual([]);
    expect(w.notices).toHaveLength(1);
    expect(w.notices[0]?.key).toMatch(/^local-lease-kept:/);
    expect(w.notices[0]?.body).toContain('acceptance_off_diff');
    expect(w.h.comments.map((c) => c.key)).toEqual([w.notices[0]?.key]);
    expect(w.h.started).toEqual([]);
  });

  it('法国接得了的单：照旧摘「本机做」、退回（行改成 stopped + engine）', async () => {
    const w = withLease(BODY);
    await runIntakeJob(w.h.deps);
    expect(w.steps).toEqual(['unmark', 'settle returned']);
    expect(w.notices).toEqual([]);
  });

  it('试判不留痕：不替这张单贴标签、不为它读前置之外的东西起任务', async () => {
    const w = withLease(offDiffBody);
    await runIntakeJob(w.h.deps);
    expect(w.h.localMarked).toEqual([]);
    expect(w.h.started).toEqual([]);
  });

  it('贴着「要人拍」：不摘、不退回，通知留给本机，结局 ok', async () => {
    const w = withLease(BODY, {}, { labels: ['需求', '本机做', '要人拍'] });
    const run = await runIntakeJob(w.h.deps);
    expect(w.steps).toEqual([]);
    expect(w.notices).toHaveLength(1);
    expect(w.h.started).toEqual([]);
    expect(run.outcome).toBe('ok');
  });

  it('前置确知还开着：租约照旧摘「本机做」并退回，结局 ok', async () => {
    const w = withLease(pre('前置：#40'), {}, { prereqStates: { 40: 'open' } });
    const run = await runIntakeJob(w.h.deps);
    expect(w.h.prereqReads).toEqual([[40]]);
    expect(w.steps).toEqual(['unmark', 'settle returned']);
    expect(w.notices).toEqual([]);
    expect(w.h.started).toEqual([]);
    expect(run.outcome).toBe('ok');
  });

  it('日期没到：不读前置单，租约照旧摘「本机做」并退回，结局 ok', async () => {
    const w = withLease(pre('前置：2026-10-03'));
    const run = await runIntakeJob(w.h.deps);
    expect(w.h.prereqReads).toEqual([]);
    expect(w.steps).toEqual(['unmark', 'settle returned']);
    expect(w.notices).toEqual([]);
    expect(run.outcome).toBe('ok');
  });

  it('前置全部 closed：租约照旧摘「本机做」并退回，结局 ok', async () => {
    const w = withLease(pre('前置：#40'), {}, { prereqStates: { 40: 'closed' } });
    const run = await runIntakeJob(w.h.deps);
    expect(w.h.prereqReads).toEqual([[40]]);
    expect(w.steps).toEqual(['unmark', 'settle returned']);
    expect(w.notices).toEqual([]);
    expect(run.outcome).toBe('ok');
  });

  it('【故意造出的失败】租约试判时前置查询抛错：不摘、不退回、不报接不了，结局不是 ok', async () => {
    const w = withLease(pre('前置：#40'), {
      async prerequisiteStates() {
        throw new Error('closed');
      },
    });
    const run = await runIntakeJob(w.h.deps);
    expect(w.steps).toEqual([]);
    expect(w.notices).toEqual([]);
    expect(w.h.started).toEqual([]);
    expect(run.outcome).toBe('partial');
    expect(run.why).toContain('#12');
  });

  it('【故意造出的失败】租约试判时前置结果缺号：不摘、不退回、不报接不了，结局不是 ok', async () => {
    const w = withLease(pre('前置：#40、#41'), {
      async prerequisiteStates(_repo, numbers) {
        return new Map(numbers.filter((n) => n === 40).map((n) => [n, 'open' as const]));
      },
    });
    const run = await runIntakeJob(w.h.deps);
    expect(w.steps).toEqual([]);
    expect(w.notices).toEqual([]);
    expect(w.h.started).toEqual([]);
    expect(run.outcome).toBe('partial');
    expect(run.why).toContain('#12');
  });

  it('【故意造出的失败】开单时间认不出：不摘、不退回、不报接不了，结局不是 ok', async () => {
    const w = withLease(BODY, {}, { createdAt: '昨天' });
    const run = await runIntakeJob(w.h.deps);
    expect(w.steps).toEqual([]);
    expect(w.notices).toEqual([]);
    expect(w.h.started).toEqual([]);
    expect(run.outcome).toBe('partial');
    expect(run.why).toContain('#12');
  });
});
