// 全流程巡检（#223）：判走到哪一步、断在哪（canaryNext）；开单、看一回、记结论、推报警（openCanaryRound、checkCanaryRound）；
// 真库上的装配（real/canary.ts）；真 Temporal 测试服务端上的工作流。需求里的两条故意造出的失败都在这里：
// 巡检仓的路由全关，这一轮必须报「断在派活」；巡检自己起不来，这一轮记没跑成、登记表上是 failing（看门狗 #203 照它报）。
import { randomUUID } from 'node:crypto';
import type { CanaryDbFacts, CanaryStage, ScheduleResult } from '@fleet-dao/db';
import {
  canaryRunById,
  latestCanaryRuns,
  notifications,
  repos,
  scheduleHealth,
  scheduleRuns,
  tasks,
  upsertAlert,
} from '@fleet-dao/db';
import { createTestDb, resetTestDb, TEST_DB_TIMEOUT_MS, type TestDb } from '@fleet-dao/db/testing';
import type { Client } from '@temporalio/client';
import { WorkflowFailedError } from '@temporalio/client';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import type { EngineJobs } from '../src/activities.ts';
import { CANARY_CHECK_FAILURE_LIMIT, WORKFLOW_TYPES } from '../src/contract.ts';
import { createFakeWorld } from '../src/fakes.ts';
import {
  CANARY_ABANDONED_WHY,
  CANARY_ALERT_KEY,
  CANARY_JOB,
  CANARY_MAX_MINUTES,
  CANARY_RUN_TIMEOUT_MINUTES,
  CANARY_STAGE_LIMIT_MINUTES,
  type CanaryDeps,
  type CanaryObservation,
  type CanaryRun,
  type CanaryState,
  type CanaryView,
  canaryIssue,
  canaryNext,
  canarySpec,
  canarySpecPath,
  checkCanaryRound,
  openCanaryRound,
} from '../src/jobs/canary.ts';
import { CANARY_SPEC_DOC_PENDING, canaryJob, canaryRepoFrom, canaryViewOf } from '../src/real/canary.ts';
import { registerEngineJobs } from '../src/real/jobs.ts';
import { useEnv, withWorker } from './helpers.ts';

const T0 = new Date('2026-09-27T12:26:00.000Z');
const at = (min: number) => new Date(T0.getTime() + min * 60_000).toISOString();
const REPO = { owner: 'acme', name: 'canary' };
const WF = 'req:acme/canary#12';

function state(over: Partial<CanaryState> = {}): CanaryState {
  return {
    schemaVersion: 1,
    runId: 1,
    canaryRunId: 7,
    repo: REPO,
    issueNumber: 12,
    issueUrl: 'https://github.test/acme/canary/issues/12',
    openedAt: at(0),
    taskId: null,
    stage: 'intake',
    stageSince: at(0),
    busyMs: 0,
    lastCheckAt: at(0),
    steps: [{ stage: 'open', at: at(0) }],
    checkFailures: 0,
    notes: [],
    ...over,
  };
}

function facts(over: Partial<CanaryDbFacts> = {}): CanaryDbFacts {
  return {
    repo: { id: 'repo-1', autoDispatchSince: new Date(T0.getTime() - 24 * 60 * 60_000) },
    task: null,
    sessions: { total: 0, started: 0, ended: 0, withUsage: 0 },
    timings: 0,
    block: null,
    openAlerts: [],
    lastDelivery: null,
    ...over,
  };
}

const TASK = {
  id: 'task-12',
  state: 'running' as const,
  phase: 'fusion:plan',
  lastProblem: null,
  updatedAt: null,
};

function obs(min: number, over: Partial<CanaryObservation> = {}): CanaryObservation {
  return {
    at: at(min),
    db: facts(),
    workflow: { state: 'missing' },
    view: null,
    issue: null,
    board: null,
    ...over,
  };
}

function view(over: Partial<CanaryView> = {}): CanaryView {
  return { step: 'plan', parked: false, waiting: null, prNumber: null, lastProblem: null, ...over };
}

/** 一整张做完的单：任务做完、GitHub 上做完关了、会话都有结局有用量、每步耗时进了库、驾驶舱读到做完带 PR。 */
function finished(min: number): CanaryObservation {
  return obs(min, {
    db: facts({
      task: { ...TASK, state: 'done', phase: 'fusion:done' },
      sessions: { total: 4, started: 4, ended: 4, withUsage: 3 },
      timings: 40,
      block: { prNumber: 13, state: 'merged' },
    }),
    workflow: { state: 'closed', status: 'COMPLETED' },
    issue: { state: 'closed', stateReason: 'completed' },
    board: { taskState: 'done', prNumber: 13, blockState: 'merged' },
  });
}

const stagesOf = (s: CanaryState) => s.steps.map((x) => x.stage);

describe('走到哪一步、断没断（canaryNext）', () => {
  it('收单：库里还没有任务行就等；20 分钟还没有，断在「收单」并写明投递怎么处理的', () => {
    expect(canaryNext(state(), obs(5)).kind).toBe('continue');
    const d = canaryNext(
      state(),
      obs(21, {
        db: facts({
          lastDelivery: {
            event: 'issues',
            action: 'opened',
            status: 'failed',
            reason: '库连不上',
            note: null,
          },
        }),
      }),
    );
    expect(d).toMatchObject({ kind: 'broken', stage: 'intake' });
    expect(d.kind === 'broken' && d.why).toContain('20 分钟没走完');
    expect(d.kind === 'broken' && d.why).toContain('库连不上');
  });

  it('一回里能走几步走几步：任务行有了、第一个会话起来了、Fusion 在执行，就停在「执行」', () => {
    const d = canaryNext(
      state(),
      obs(8, {
        db: facts({
          task: { ...TASK, phase: 'fusion:execute' },
          sessions: { total: 2, started: 2, ended: 1, withUsage: 1 },
        }),
        workflow: { state: 'running' },
        view: view({ step: 'execute' }),
      }),
    );
    expect(d.kind).toBe('continue');
    expect(d.state.stage).toBe('execute');
    expect(stagesOf(d.state)).toEqual(['open', 'intake', 'dispatch', 'plan']);
    expect(d.state.taskId).toBe('task-12');
  });

  it('【故意造出的失败】巡检仓的路由全关：工作流起来了、一个会话都起不来、挂起等人，这一轮断在「派活」', () => {
    const d = canaryNext(
      state({
        stage: 'dispatch',
        steps: [
          { stage: 'open', at: at(0) },
          { stage: 'intake', at: at(1) },
        ],
      }),
      obs(3, {
        db: facts({
          task: TASK,
          openAlerts: [{ dedupeKey: `${WF}:park:1`, title: '「plan」没有能用的路由' }],
        }),
        workflow: { state: 'running' },
        view: view({
          parked: true,
          waiting: { kind: 'human', detail: '挂起：「plan」没有能用的路由（等「继续」或「换路由」）' },
        }),
      }),
    );
    expect(d).toMatchObject({ kind: 'broken', stage: 'dispatch' });
    expect(d.kind === 'broken' && d.why).toContain('没有能用的路由');
  });

  it('【故意造出的失败】巡检仓的「让 AI 接活」关着：不用等期限，当场断在「派活」', () => {
    const d = canaryNext(
      state({ stage: 'dispatch' }),
      obs(2, {
        db: facts({
          repo: { id: 'repo-1', autoDispatchSince: null },
          task: { ...TASK, state: 'queued', phase: null },
        }),
      }),
    );
    expect(d).toMatchObject({ kind: 'broken', stage: 'dispatch' });
    expect(d.kind === 'broken' && d.why).toContain('「让 AI 接活」开关关着');
  });

  it('等并发空位、额度的时间不算进这一步的期限（忙不是断）；等人一样算断', () => {
    let s = state({ stage: 'dispatch', stageSince: at(0), lastCheckAt: at(0) });
    const busy = (min: number) =>
      obs(min, {
        db: facts({ task: TASK }),
        workflow: { state: 'running' },
        view: view({ waiting: { kind: 'slot', detail: '等 Claude 订阅 · 拼车的并发空位' } }),
      });
    for (let min = 2; min <= 40; min += 2) {
      const d = canaryNext(s, busy(min));
      expect(d.kind, `第 ${min} 分钟`).toBe('continue');
      s = d.state;
    }
    expect(s.busyMs).toBe(40 * 60_000);
    // 不等空位了却还没起会话：这之后的时间照算，30 分钟到了就断
    const idle = (min: number) =>
      obs(min, { db: facts({ task: TASK }), workflow: { state: 'running' }, view: view() });
    expect(canaryNext(s, idle(60)).kind).toBe('continue');
    const d = canaryNext(s, idle(71));
    expect(d).toMatchObject({ kind: 'broken', stage: 'dispatch' });
    expect(d.kind === 'broken' && d.why).toContain('工作流起来了，第一个会话还没起来');
  });

  it('一轮总上限：一直在等空位、额度也不能拖过 5 小时', () => {
    const s = state({
      stage: 'plan',
      stageSince: at(10),
      lastCheckAt: at(CANARY_MAX_MINUTES - 1),
      busyMs: (CANARY_MAX_MINUTES - 12) * 60_000,
    });
    const d = canaryNext(
      s,
      obs(CANARY_MAX_MINUTES + 1, {
        db: facts({ task: TASK, sessions: { total: 1, started: 1, ended: 0, withUsage: 0 } }),
        workflow: { state: 'running' },
        view: view({ waiting: { kind: 'quota', detail: '等额度清零' } }),
      }),
    );
    expect(d).toMatchObject({ kind: 'broken', stage: 'plan' });
    expect(d.kind === 'broken' && d.why).toContain('5 小时还没走完');
  });

  it('【故意造出的失败】工作流失败了、任务失败了、单子被关成不做了：断在当时那一步', () => {
    const exec = state({ stage: 'execute' });
    const running = facts({
      task: { ...TASK, phase: 'fusion:execute' },
      sessions: { total: 2, started: 2, ended: 1, withUsage: 1 },
    });
    const failed = canaryNext(
      exec,
      obs(30, { db: running, workflow: { state: 'closed', status: 'FAILED' } }),
    );
    expect(failed).toMatchObject({ kind: 'broken', stage: 'execute' });
    expect(failed.kind === 'broken' && failed.why).toContain('失败了');
    const taskFailed = canaryNext(
      exec,
      obs(30, { db: facts({ ...running, task: { ...TASK, state: 'failed', lastProblem: '测试没过' } }) }),
    );
    expect(taskFailed.kind === 'broken' && taskFailed.why).toContain('测试没过');
    const close = state({ stage: 'close' });
    const notPlanned = canaryNext(
      close,
      obs(90, { ...finished(90), issue: { state: 'closed', stateReason: 'not_planned' } }),
    );
    expect(notPlanned).toMatchObject({ kind: 'broken', stage: 'close' });
  });

  it('整张单做完：一回里走完剩下的每一步，通过；十一步都记了走完的时刻', () => {
    const d = canaryNext(state({ stage: 'merge', steps: [] }), finished(50));
    expect(d.kind).toBe('pass');
    expect(stagesOf(d.state)).toEqual(['merge', 'close', 'ledger', 'board']);
    const all = canaryNext(state(), finished(50));
    expect(all.kind).toBe('pass');
    expect(stagesOf(all.state)).toEqual([
      'open',
      'intake',
      'dispatch',
      'plan',
      'execute',
      'verify',
      'pr',
      'merge',
      'close',
      'ledger',
      'board',
    ]);
  });

  it('【故意造出的失败】做完了却没记账（会话都没记上用量）、驾驶舱读到的不是做完：各自到期限断在「记账」「驾驶舱显示」', () => {
    const noUsage = {
      ...finished(60),
      db: facts({ ...finished(60).db, sessions: { total: 2, started: 2, ended: 2, withUsage: 0 } }),
    };
    const s = state({ stage: 'ledger', stageSince: at(60) });
    expect(canaryNext(s, { ...noUsage, at: at(65) }).kind).toBe('continue');
    const ledger = canaryNext(s, { ...noUsage, at: at(60 + CANARY_STAGE_LIMIT_MINUTES.ledger + 1) });
    expect(ledger).toMatchObject({ kind: 'broken', stage: 'ledger' });
    expect(ledger.kind === 'broken' && ledger.why).toContain('记上用量的 0 个');
    const board = canaryNext(state({ stage: 'board', stageSince: at(60) }), {
      ...finished(60 + CANARY_STAGE_LIMIT_MINUTES.board + 1),
      board: { taskState: 'running', prNumber: null, blockState: 'verifying' },
    });
    expect(board).toMatchObject({ kind: 'broken', stage: 'board' });
  });
});

describe('巡检单本身', () => {
  it('正文里「文档：」那一行用 <本单号> 占位（开单时还不知道号）；需求文档的「怎么算做完」逐条可核', () => {
    const issue = canaryIssue(T0);
    expect(issue.title).toContain('巡检');
    expect(issue.body).toContain('文档：`specs/<本单号>-巡检/需求.md`');
    expect(canarySpecPath(12)).toBe('specs/12-巡检/需求.md');
    const spec = canarySpec(12, T0);
    expect(spec).toContain('对应计划：无');
    expect(spec).toContain('## 怎么算做完');
    expect(spec).toContain('`- #12 2026-09-27T12:26:00Z`');
  });
});

// —— 一轮怎么跑：假的库、GitHub、Temporal ——

interface Harness {
  deps: CanaryDeps;
  calls: string[];
  runsFinished: { id: number; result: ScheduleResult }[];
  finished: { id: number; verdict: string; stage: CanaryStage; why: string | null }[];
  alerts: { raised: { title: string; body: string }[]; resolved: string[] };
  setFacts(f: CanaryDbFacts): void;
  setWorkflow(w: CanaryObservation['workflow'], v?: CanaryView): void;
}

function harness(over: Partial<CanaryDeps> = {}, gh: Partial<CanaryDeps['github']> = {}): Harness {
  const calls: string[] = [];
  const runsFinished: Harness['runsFinished'] = [];
  const finishedRows: Harness['finished'] = [];
  const alerts: Harness['alerts'] = { raised: [], resolved: [] };
  let current = facts();
  let wf: CanaryObservation['workflow'] = { state: 'missing' };
  let wfView: CanaryView = view();
  let clock = T0.getTime();
  const deps: CanaryDeps = {
    repo: REPO,
    runs: {
      start: async () => 1,
      finish: async (id, result) => {
        runsFinished.push({ id, result });
      },
    },
    record: {
      start: async () => 7,
      progress: async () => true,
      finish: async (id, input) => {
        finishedRows.push({ id, verdict: input.verdict, stage: input.stage, why: input.why });
        return 'ok';
      },
      leftovers: async () => [],
      cleaned: async (id) => {
        calls.push(`cleaned:${id}`);
      },
      abandon: async () => [],
    },
    github: {
      openMilestones: async () => [
        { number: 2, title: 'v2 以后' },
        { number: 1, title: 'v1 巡检' },
      ],
      openIssue: async (input) => {
        calls.push(`open:${input.dedupe}`);
        return { number: 12, url: 'https://github.test/acme/canary/issues/12' };
      },
      setMilestone: async (n, m) => {
        calls.push(`milestone:${n}:${m}`);
      },
      issueState: async () => ({ state: 'closed', stateReason: 'completed' }),
      closeIssue: async (n) => {
        calls.push(`close:${n}`);
      },
      ...gh,
    },
    // 需求文档经 PR 进主线（#295 那条路）：假的，记下调过
    specDoc: {
      land: async (input) => {
        calls.push(`spec:${input.path}`);
      },
    },
    facts: async () => current,
    workflows: {
      state: async () => wf,
      view: async () => wfView,
      stop: async (id) => {
        calls.push(`stop:${id}`);
        return 'sent';
      },
    },
    board: async () => ({ taskState: 'done', prNumber: 13, blockState: 'merged' }),
    alerts: {
      raise: async (a) => {
        alerts.raised.push(a);
      },
      resolve: async (why) => {
        alerts.resolved.push(why);
      },
    },
    now: () => {
      clock += 60_000;
      return new Date(clock);
    },
    log: () => {},
    ...over,
  };
  return {
    deps,
    calls,
    runsFinished,
    finished: finishedRows,
    alerts,
    setFacts: (f) => {
      current = f;
    },
    setWorkflow: (w, v) => {
      wf = w;
      if (v) wfView = v;
    },
  };
}

describe('开单、看一回、记结论（假的库、GitHub、Temporal）', () => {
  it('开单：先开单（不挂里程碑）、再让需求文档经 PR 进主线、最后挂当前版本（v1，不是 v2）；去重键带着这一轮的编号', async () => {
    const h = harness();
    const r = await openCanaryRound(h.deps);
    expect(r.done).toBe(false);
    expect(h.calls).toEqual(['open:canary:7', 'spec:specs/12-巡检/需求.md', 'milestone:12:1']);
    expect(!r.done && r.state).toMatchObject({ stage: 'intake', issueNumber: 12, runId: 1, canaryRunId: 7 });
  });

  it('【故意造出的失败】巡检自己起不来（没配巡检仓）：这一轮记没跑成（schedule_runs 记 failed），不开单', async () => {
    const h = harness({ repo: canaryRepoFrom(undefined) });
    const r = await openCanaryRound(h.deps);
    expect(r).toMatchObject({ done: true, run: { verdict: 'not_run', stage: 'open' } });
    expect(h.runsFinished[0]?.result).toMatchObject({ outcome: 'failed' });
    expect(h.runsFinished[0]?.result).toMatchObject({ why: expect.stringContaining('FLEET_CANARY_REPO') });
    expect(h.calls).toEqual([]);
  });

  it('【故意造出的失败】巡检仓没有当前版本：没跑成、写明要建「v1 巡检」，一张单都不开', async () => {
    const h = harness({}, { openMilestones: async () => [{ number: 5, title: '以后再说' }] });
    const r = await openCanaryRound(h.deps);
    expect(r).toMatchObject({ done: true, run: { verdict: 'not_run' } });
    expect(r.done && r.run.why).toContain('v<N> 里程碑');
    expect(h.calls).toEqual([]);
  });

  it('【故意造出的失败】需求文档经 PR 进主线的路还没接上（#295）：没跑成、写明等什么，一张单都不开（不开注定停住的单）', async () => {
    const h = harness({ specDoc: { unavailable: CANARY_SPEC_DOC_PENDING } });
    const r = await openCanaryRound(h.deps);
    expect(r).toMatchObject({ done: true, run: { verdict: 'not_run', stage: 'open', issueNumber: null } });
    expect(r.done && r.run.why).toContain('#295');
    expect(r.done && r.run.why).toContain('不直写主线');
    expect(h.calls).toEqual([]);
    expect(h.runsFinished[0]?.result.outcome).toBe('failed');
  });

  it('【故意造出的失败】需求文档的 PR 没合进去：没跑成，开出来的那张单关掉作废（不留半截单）', async () => {
    const h = harness({
      specDoc: {
        land: async () => {
          throw new Error('需求文档的 PR CI 红了');
        },
      },
    });
    const r = await openCanaryRound(h.deps);
    expect(r).toMatchObject({ done: true, run: { verdict: 'not_run', issueNumber: 12 } });
    expect(r.done && r.run.why).toContain('CI 红了');
    expect(h.calls).toEqual(['open:canary:7', 'close:12']);
    expect(h.runsFinished[0]?.result.outcome).toBe('failed');
  });

  it('开单前收掉前几轮留下的单：叫停工作流、关单、记下收过了；收不掉的写进备注，不挡这一轮', async () => {
    const h = harness({
      record: {
        ...harness().deps.record,
        leftovers: async () => [
          { id: 3, issueNumber: 5 },
          { id: 4, issueNumber: 9 },
        ],
        cleaned: async () => {},
      },
      workflows: {
        state: async () => ({ state: 'missing' }),
        view: async () => view(),
        stop: async (id) => {
          if (id.endsWith('#9')) throw new Error('Temporal 连不上');
          return 'gone';
        },
      },
    });
    h.deps.github.issueState = async () => ({ state: 'open', stateReason: null });
    const r = await openCanaryRound(h.deps);
    expect(r.done).toBe(false);
    expect(h.calls).toContain('close:5');
    expect(!r.done && r.state.notes).toEqual([
      '收掉了上一轮留下的 #5',
      '上一轮留下的 #9 没收掉：Temporal 连不上',
    ]);
  });

  it('【故意造出的失败】上一轮没收尾（工作流没了、一直没结论）：开单前补记成没跑成（schedule_runs 那一行也记 failed），它开成了的单照留下的单收掉', async () => {
    const asked: { before: Date; why: string; at: Date }[] = [];
    const left: { id: number; issueNumber: number | null }[] = [];
    const h = harness({
      record: {
        ...harness().deps.record,
        abandon: async (input) => {
          asked.push(input);
          left.push({ id: 3, issueNumber: 5 });
          return [{ id: 3, scheduleRunId: 2, issueNumber: 5 }];
        },
        leftovers: async () => left,
      },
    });
    h.deps.github.issueState = async () => ({ state: 'open', stateReason: null });
    const r = await openCanaryRound(h.deps);
    expect(r.done).toBe(false);
    expect(asked).toHaveLength(1);
    expect(asked[0]?.why).toBe(CANARY_ABANDONED_WHY);
    expect(CANARY_ABANDONED_WHY).toContain('没收尾');
    expect((asked[0]?.at.getTime() ?? 0) - (asked[0]?.before.getTime() ?? 0)).toBe(
      CANARY_RUN_TIMEOUT_MINUTES * 60_000,
    );
    expect(h.runsFinished).toEqual([{ id: 2, result: { outcome: 'failed', why: CANARY_ABANDONED_WHY } }]);
    expect(h.calls).toContain('close:5');
    expect(!r.done && r.state.notes).toEqual(['补记了没收尾的一轮（#5）：没跑成', '收掉了上一轮留下的 #5']);
  });

  it('看一回、还在走：写进度、接着看；做完了：记通过、schedule_runs 记 ok（发现 0 个）、撤断了的报警', async () => {
    const h = harness();
    const opened = await openCanaryRound(h.deps);
    if (opened.done) throw new Error('应当开成');
    h.setFacts(facts({ task: TASK }));
    h.setWorkflow({ state: 'running' }, view());
    const next = await checkCanaryRound(h.deps, opened.state);
    expect(next.done).toBe(false);
    h.setFacts(finished(0).db);
    h.setWorkflow({ state: 'closed', status: 'COMPLETED' });
    const done = await checkCanaryRound(h.deps, next.done ? opened.state : next.state);
    expect(done).toMatchObject({ done: true, run: { verdict: 'pass', stage: 'board' } });
    expect(h.runsFinished.at(-1)?.result).toEqual({ outcome: 'ok', scanned: 11, found: 0 });
    expect(h.alerts.resolved).toHaveLength(1);
    expect(h.alerts.raised).toEqual([]);
  });

  it('断了：推一条卡住报警（写清断在哪一步、走到哪了、单子在哪），记 broken；这一轮巡检本身跑成了（schedule_runs 记 ok、发现 1 个）', async () => {
    const h = harness();
    const opened = await openCanaryRound(h.deps);
    if (opened.done) throw new Error('应当开成');
    h.setFacts(
      facts({ task: TASK, openAlerts: [{ dedupeKey: `${WF}:park:1`, title: '「plan」没有能用的路由' }] }),
    );
    h.setWorkflow({ state: 'running' }, view({ parked: true }));
    const r = await checkCanaryRound(h.deps, opened.state);
    expect(r).toMatchObject({ done: true, run: { verdict: 'broken', stage: 'dispatch' } });
    expect(h.alerts.raised).toHaveLength(1);
    expect(h.alerts.raised[0]?.title).toBe('全流程巡检断在「派活」');
    expect(h.alerts.raised[0]?.body).toContain('没有能用的路由');
    expect(h.alerts.raised[0]?.body).toContain('https://github.test/acme/canary/issues/12');
    expect(h.runsFinished.at(-1)?.result).toEqual({ outcome: 'ok', scanned: 2, found: 1 });
    expect(h.finished.at(-1)).toMatchObject({ verdict: 'broken', stage: 'dispatch' });
  });

  it('【故意造出的失败】连着查不成到上限：这一轮算巡检自己没跑成（schedule_runs 记 failed），不当成没问题', async () => {
    const h = harness({
      facts: async () => {
        throw new Error('库连不上');
      },
    });
    let s = state();
    for (let i = 1; i < CANARY_CHECK_FAILURE_LIMIT; i++) {
      const r = await checkCanaryRound(h.deps, s);
      if (r.done) throw new Error(`第 ${i} 回就收了`);
      s = r.state;
      expect(s.checkFailures).toBe(i);
    }
    const r = await checkCanaryRound(h.deps, s);
    expect(r).toMatchObject({ done: true, run: { verdict: 'not_run' } });
    expect(r.done && r.run.why).toContain('库连不上');
    expect(h.runsFinished.at(-1)?.result.outcome).toBe('failed');
  });
});

describe('status 查询、巡检仓配置的读法', () => {
  it('认得出 Fusion 的 status；认不出的抛错（这一回没查成），不当成「没挂着」', () => {
    expect(
      canaryViewOf(
        {
          step: 'plan',
          parked: true,
          waiting: { kind: 'human', detail: '挂起', since: at(0) },
          prNumber: null,
        },
        WF,
      ),
    ).toEqual({
      step: 'plan',
      parked: true,
      waiting: { kind: 'human', detail: '挂起' },
      prNumber: null,
      lastProblem: null,
    });
    expect(() => canaryViewOf({ parked: false }, WF)).toThrow('认不出');
    expect(() => canaryViewOf({ step: 'plan', parked: false, waiting: 'x' }, WF)).toThrow('waiting');
  });

  it('FLEET_CANARY_REPO：owner/name 才认；没配、写错都明说', () => {
    expect(canaryRepoFrom(' acme/fleet-canary ')).toEqual({ owner: 'acme', name: 'fleet-canary' });
    expect(canaryRepoFrom(undefined)).toMatchObject({ error: expect.stringContaining('没配巡检仓') });
    expect(canaryRepoFrom('fleet-canary')).toMatchObject({ error: expect.stringContaining('认不出') });
  });
});

// —— 真库上的装配 ——

describe('真库上的一轮（PGlite 跑真迁移；GitHub、Temporal 是假的）', () => {
  let t: TestDb;
  beforeAll(async () => {
    t = await createTestDb();
  }, TEST_DB_TIMEOUT_MS);
  afterAll(() => t.close());
  beforeEach(async () => {
    await resetTestDb(t);
  });

  /** 假的「引擎」机器人：开单发 #12，别的都照做；需求文档经 PR 进主线那条路（#295）也是假的，记下调过。 */
  function fakeGh(over: Partial<Parameters<typeof canaryJob>[0]['gh']> = {}) {
    const calls: string[] = [];
    const specDoc: CanaryDeps['specDoc'] = {
      land: async (input) => {
        calls.push(`spec:${input.path}`);
      },
    };
    const gh: Parameters<typeof canaryJob>[0]['gh'] = {
      readOpenMilestones: async () => [{ number: 1, title: 'v1 巡检' }],
      openIssue: async (input) => {
        calls.push(`open:${input.key}:${input.labels.length}:${input.milestone}`);
        return { number: 12, url: 'https://github.test/acme/canary/issues/12', created: true };
      },
      setIssueMilestone: async () => {
        calls.push('milestone');
        return { changed: true };
      },
      readIssueState: async () => ({ state: 'open', stateReason: null }),
      closeIssue: async () => {
        calls.push('close');
        return { alreadyClosed: false, commentId: 1, commentUrl: 'u', commentCreated: true };
      },
      ...over,
    };
    return { gh, calls, specDoc };
  }

  /** 假的 Temporal 客户端：这张单的工作流在跑、挂着等人。 */
  function parkedClient(): Client {
    const handle = {
      describe: async () => ({ status: { name: 'RUNNING' } }),
      query: async () => ({
        step: 'plan',
        parked: true,
        waiting: {
          kind: 'human',
          detail: '挂起：「plan」没有能用的路由（等「继续」或「换路由」）',
          since: T0.toISOString(),
        },
        prNumber: null,
        lastProblem: '「plan」没有能用的路由',
      }),
      signal: async () => {},
    };
    return {
      workflow: { getHandle: () => handle },
      connection: { withDeadline: <R>(_: number, fn: () => Promise<R>) => fn() },
    } as unknown as Client;
  }

  it(
    '【故意造出的失败】巡检仓的路由全关：这一轮报「断在派活」、推一条卡住报警、记进库；巡检本身跑成了（登记表上是 ok）',
    async () => {
      await registerEngineJobs(t.db);
      await t.db
        .insert(repos)
        .values({ ...REPO, testCommand: 'node --test', autoDispatchSince: new Date(T0.getTime() - 60_000) });
      const { gh, calls, specDoc } = fakeGh();
      let clock = T0.getTime();
      const make = canaryJob({
        db: t.db,
        gh,
        specDoc,
        repo: 'acme/canary',
        now: () => {
          clock += 60_000;
          return new Date(clock);
        },
        log: () => {},
      });
      const deps = make(parkedClient());
      const opened = await openCanaryRound(deps);
      if (opened.done) throw new Error(`应当开成：${opened.run.why}`);
      // 开单不贴标签、不挂里程碑（去重键带这一轮的编号），需求文档进了主线才挂
      expect(calls).toEqual(['open:canary:1:0:null', 'spec:specs/12-巡检/需求.md', 'milestone']);
      // 接活收进来了这张单、派出去了；Fusion 起来了，Lead 选路一条都没有：挂起、报警（kit.ts 的 park）
      const [repo] = await t.db.select().from(repos);
      const [task] = await t.db
        .insert(tasks)
        .values({
          repoId: repo?.id ?? '',
          issueNumber: 12,
          title: '巡检',
          rawRequest: '巡检单',
          requestedBy: 'engine',
          priority: 10,
          state: 'planning',
          phase: 'fusion:plan',
        })
        .returning();
      await upsertAlert(t.db, {
        dedupeKey: `${WF}:park:1`,
        level: 'alert',
        taskId: task?.id ?? null,
        title: '「plan」没有能用的路由',
        body: '一条都派不出去',
      });
      const r = await checkCanaryRound(deps, opened.state);
      expect(r).toMatchObject({ done: true, run: { verdict: 'broken', stage: 'dispatch', issueNumber: 12 } });
      const row = await canaryRunById(t.db, opened.state.canaryRunId);
      expect(row).toMatchObject({ verdict: 'broken', stage: 'dispatch', issueNumber: 12, taskId: task?.id });
      expect(row?.why).toContain('断在「派活」');
      expect(row?.steps.map((s) => s.stage)).toEqual(['open', 'intake']);
      const alert = (await t.db.select().from(notifications)).find((n) => n.dedupeKey === CANARY_ALERT_KEY);
      expect(alert).toMatchObject({ level: 'alert', title: '全流程巡检断在「派活」', resolvedAt: null });
      const [run] = await t.db.select().from(scheduleRuns);
      expect(run).toMatchObject({ job: 'canary', outcome: 'ok', found: 1 });
      const health = (await scheduleHealth(t.db, new Date(clock))).find((h) => h.job.id === 'canary');
      expect(health?.status).toBe('ok');
      expect((await latestCanaryRuns(t.db)).finished?.verdict).toBe('broken');
    },
    TEST_DB_TIMEOUT_MS,
  );

  it(
    '【故意造出的失败】巡检自己起不来：一次都没跑过是 never；没配巡检仓、巡检仓读不到都记没跑成，登记表上是 failing（看门狗 #203 照它报）',
    async () => {
      await registerEngineJobs(t.db);
      const before = (await scheduleHealth(t.db, T0)).find((h) => h.job.id === CANARY_JOB.id);
      expect(before?.status).toBe('never');
      const { gh } = fakeGh({
        readOpenMilestones: async () => {
          throw new Error('GitHub 回了 502');
        },
      });
      const unconfigured = canaryJob({ db: t.db, gh, repo: undefined, now: () => T0, log: () => {} });
      const a = await openCanaryRound(unconfigured(parkedClient()));
      expect(a).toMatchObject({ done: true, run: { verdict: 'not_run' } });
      let health = (await scheduleHealth(t.db, T0)).find((h) => h.job.id === CANARY_JOB.id);
      expect(health?.status).toBe('failing');
      expect(health?.lastRun?.why).toContain('FLEET_CANARY_REPO');
      const unreadable = canaryJob({ db: t.db, gh, repo: 'acme/canary', now: () => T0, log: () => {} });
      const b = await openCanaryRound(unreadable(parkedClient()));
      expect(b).toMatchObject({ done: true, run: { verdict: 'not_run' } });
      health = (await scheduleHealth(t.db, T0)).find((h) => h.job.id === CANARY_JOB.id);
      expect(health?.status).toBe('failing');
      expect(health?.lastRun?.why).toContain('GitHub 回了 502');
      // 需求文档经 PR 进主线的路还没接上（真装配不给 specDoc 就是这样，等 #295）：没跑成、写明等什么，一张单都不开
      const fine = fakeGh();
      const pending = canaryJob({ db: t.db, gh: fine.gh, repo: 'acme/canary', now: () => T0, log: () => {} });
      const c = await openCanaryRound(pending(parkedClient()));
      expect(c).toMatchObject({ done: true, run: { verdict: 'not_run', issueNumber: null } });
      expect(fine.calls).toEqual([]);
      health = (await scheduleHealth(t.db, T0)).find((h) => h.job.id === CANARY_JOB.id);
      expect(health?.status).toBe('failing');
      expect(health?.lastRun?.why).toContain('#295');
      // 没跑成的和「跑了没问题」分开：健康页读到的最近一轮是没跑成
      expect((await latestCanaryRuns(t.db)).finished).toMatchObject({ verdict: 'not_run' });
    },
    TEST_DB_TIMEOUT_MS,
  );
});

// —— 真 Temporal 测试服务端上的工作流 ——

describe('全流程巡检的工作流（真 Temporal 测试服务端）', { timeout: 60_000 }, () => {
  const env = useEnv();

  async function runOnce(jobs: EngineJobs): Promise<CanaryRun> {
    return withWorker(
      env(),
      createFakeWorld(),
      (taskQueue) =>
        env().client.workflow.execute(WORKFLOW_TYPES.canary, {
          taskQueue,
          workflowId: `canary-${randomUUID()}`,
          args: [{ schemaVersion: 1 }],
        }),
      { jobs },
    );
  }

  it('开单、隔一会儿看一回、一直看到有结论：交回这一轮的结局', async () => {
    const h = harness();
    let checks = 0;
    const inner = h.deps.facts;
    h.deps.facts = async (n) => {
      checks += 1;
      if (checks >= 3) {
        h.setWorkflow({ state: 'closed', status: 'COMPLETED' });
        return finished(0).db;
      }
      return inner(n);
    };
    const run = await runOnce({ canary: () => h.deps });
    expect(run).toMatchObject({ verdict: 'pass', stage: 'board', issueNumber: 12 });
    expect(checks).toBe(3);
  });

  it('【故意造出的失败】看一回的活动本身连着失败到上限：工作流失败（库里停在「在跑」，登记表上过期、看门狗看得见）', async () => {
    const h = harness();
    h.deps.runs.finish = async () => {
      throw new Error('库连不上');
    };
    h.deps.facts = async () => finished(0).db;
    h.setWorkflow({ state: 'closed', status: 'COMPLETED' });
    const err = await runOnce({ canary: () => h.deps }).then(
      () => null,
      (e: unknown) => e,
    );
    expect(err).toBeInstanceOf(WorkflowFailedError);
  });

  it('登记的名字、频率写的是「全流程巡检」、每 6 小时，连着两轮没跑成才算过期', () => {
    expect(CANARY_JOB).toMatchObject({ id: 'canary', name: '全流程巡检', expectEveryMinutes: 780 });
  });
});
