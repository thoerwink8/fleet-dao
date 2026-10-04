// 全流程巡检（#223）：判走到哪一步、断在哪（canaryNext）；开单、看一回、记结论、推报警（openCanaryRound、checkCanaryRound）；
// 真库上的装配（real/canary.ts）；真 Temporal 测试服务端上的工作流。巡检跟着三段任务工作流走（#452）：收单 → 动手 →
// 开 PR、过 CI → 验收 → 合并 → 关单 → 记账 → 驾驶舱显示。故意造出的失败都在这里：工作流读不到 → 这一回记没查成、连着到上限
// 这一轮没跑成；停在某一步 → 断在那一步，写出名字和这一步走了多久；巡检自己起不来 → 没跑成、登记表上是 failing（看门狗 #203 照它报）。
import { randomUUID } from 'node:crypto';
import { cleanBody, criteriaOf } from '@fleet-dao/core';
import type { CanaryDbFacts, ScheduleResult } from '@fleet-dao/db';
import {
  canaryRunById,
  latestCanaryRuns,
  notifications,
  pullRequests,
  repos,
  scheduleHealth,
  scheduleRuns,
  startRun,
  stepTimings,
  tasks,
  upsertAlert,
} from '@fleet-dao/db';
import { createTestDb, resetTestDb, TEST_DB_TIMEOUT_MS, type TestDb } from '@fleet-dao/db/testing';
import type { Client } from '@temporalio/client';
import { WorkflowFailedError, WorkflowNotFoundError } from '@temporalio/client';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import type { EngineJobs } from '../src/activities.ts';
import { CANARY_CHECK_FAILURE_LIMIT, WORKFLOW_TYPES } from '../src/contract.ts';
import { createFakeWorld } from '../src/fakes.ts';
import {
  CANARY_ABANDONED_WHY,
  CANARY_ALERT_KEY,
  CANARY_JOB,
  CANARY_LEFTOVER_PR_ALERT_KEY,
  CANARY_MAX_MINUTES,
  CANARY_RUN_TIMEOUT_MINUTES,
  CANARY_STAGE_LIMIT_MINUTES,
  type CanaryBoard,
  type CanaryDeps,
  type CanaryObservation,
  type CanaryRun,
  type CanaryState,
  type CanaryView,
  canaryIssue,
  canaryLogLine,
  canaryNext,
  checkCanaryRound,
  openCanaryRound,
  spanWords,
  stepSpans,
} from '../src/jobs/canary.ts';
import {
  type CanaryPullsGitHub,
  canaryJob,
  canaryRepoFrom,
  canaryViewOf,
  closeLeftoverPulls,
} from '../src/real/canary.ts';
import { registerEngineJobs } from '../src/real/jobs.ts';
import { buildTaskBrief } from '../src/runner/task-brief.ts';
import { useEnv, withWorker } from './helpers.ts';

const T0 = new Date('2026-09-27T12:26:00.000Z');
const at = (min: number) => new Date(T0.getTime() + min * 60_000).toISOString();
const REPO = { owner: 'acme', name: 'canary' };
const WF = 'task:acme/canary#12';
const ALL_STAGES = ['open', 'intake', 'implement', 'pr', 'verify', 'merge', 'close', 'ledger', 'board'];
const NO_RUNS = { total: 0, ended: 0, manual: 0, verify: 0, withUsage: 0 };
/** 一张做完的小单记的账：动手两笔、验收一笔，都结束了、记上了用量。 */
const LEDGER = { total: 3, ended: 3, manual: 2, verify: 1, withUsage: 3 };

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
    runs: NO_RUNS,
    timings: 0,
    openAlerts: [],
    lastIntake: null,
    ...over,
  };
}

const TASK = {
  id: 'task-12',
  state: 'running' as const,
  phase: 'brief',
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
  return {
    phase: 'implement',
    doing: '第 1 轮：grok-5 动手',
    parked: false,
    waiting: null,
    prNumber: null,
    lastProblem: null,
    round: 1,
    verifyRound: 0,
    ...over,
  };
}

/** 在跑：任务行在、任务工作流在跑、它的状态是 v。 */
function running(
  min: number,
  v: Partial<CanaryView> = {},
  db: Partial<CanaryDbFacts> = {},
): CanaryObservation {
  return obs(min, { db: facts({ task: TASK, ...db }), workflow: { state: 'running' }, view: view(v) });
}

const BOARD_DONE: CanaryBoard = {
  taskState: 'done',
  pr: { number: 13, state: 'merged', mergedAt: at(40), linkedIssue: 12 },
};

/** 一整张做完的单：任务做完、GitHub 上做完关了、runs 每笔都有结局有用量、每步耗时进了库、驾驶舱读到做完、PR 合了挂着这张单。 */
function finished(min: number): CanaryObservation {
  return obs(min, {
    db: facts({ task: { ...TASK, state: 'done', phase: 'done' }, runs: LEDGER, timings: 40 }),
    workflow: { state: 'closed', status: 'COMPLETED' },
    issue: { state: 'closed', stateReason: 'completed' },
    board: BOARD_DONE,
  });
}

const stagesOf = (s: CanaryState) => s.steps.map((x) => x.stage);
const whyOf = (d: ReturnType<typeof canaryNext>) => (d.kind === 'broken' ? d.why : '');

describe('走到哪一步、断没断（canaryNext）', () => {
  it('收单：库里还没有任务行就等；20 分钟还没有，断在「收单」，写明这一步走了多久、最近一轮拉单怎么了', () => {
    expect(canaryNext(state(), obs(5)).kind).toBe('continue');
    const d = canaryNext(
      state(),
      obs(21, {
        db: facts({
          lastIntake: {
            startedAt: new Date(at(18)),
            endedAt: new Date(at(18)),
            outcome: 'failed',
            why: '白名单读不到',
          },
        }),
      }),
    );
    expect(d).toMatchObject({ kind: 'broken', stage: 'intake', spentMs: 21 * 60_000 });
    expect(whyOf(d)).toContain('超过期限 20 分钟还没走完');
    expect(whyOf(d)).toContain('白名单读不到');
    // 拉单一轮都没跑过：照实说，不说成「拉了、没拉到」
    expect(whyOf(canaryNext(state(), obs(21)))).toContain('一轮都没跑过');
  });

  it('【故意造出的失败】巡检仓的「让 AI 接活」关着、或开单之后才打开：不用等期限，当场断在「收单」', () => {
    const off = canaryNext(
      state(),
      obs(2, { db: facts({ repo: { id: 'repo-1', autoDispatchSince: null } }) }),
    );
    expect(off).toMatchObject({ kind: 'broken', stage: 'intake' });
    expect(whyOf(off)).toContain('「让 AI 接活」开关关着');
    const late = canaryNext(
      state(),
      obs(2, { db: facts({ repo: { id: 'repo-1', autoDispatchSince: new Date(at(1)) } }) }),
    );
    expect(late).toMatchObject({ kind: 'broken', stage: 'intake' });
    expect(whyOf(late)).toContain('开单之后才打开');
  });

  it('任务行建了、任务工作流还没起来：还在收单（起不成的下一轮拉单再起），到期限写明卡在这儿', () => {
    const queued = { ...TASK, state: 'queued' as const, phase: null };
    expect(canaryNext(state(), obs(8, { db: facts({ task: queued }) })).state.stage).toBe('intake');
    const d = canaryNext(state(), obs(21, { db: facts({ task: queued }) }));
    expect(d).toMatchObject({ kind: 'broken', stage: 'intake' });
    expect(whyOf(d)).toContain('任务行建了（queued），任务工作流还没起来');
  });

  it('一回里能走几步走几步：任务工作流在等 CI（PR 开了）就停在「开 PR、过 CI」，记下 PR 号', () => {
    const d = canaryNext(
      state(),
      running(8, {
        phase: 'ci',
        doing: '等 PR #13 的 CI',
        prNumber: 13,
        waiting: { kind: 'ci', detail: '等 PR #13 的 CI' },
      }),
    );
    expect(d.kind).toBe('continue');
    expect(d.state.stage).toBe('pr');
    expect(stagesOf(d.state)).toEqual(['open', 'intake', 'implement']);
    expect(d.state).toMatchObject({ taskId: 'task-12', prNumber: 13 });
  });

  it('【故意造出的失败】停在「验收」：45 分钟没走完，断在这一步，报出这一步的名字、走了多久、在做什么', () => {
    const s = state({ stage: 'verify', stageSince: at(30), taskId: 'task-12', prNumber: 13 });
    const verifying = (min: number) =>
      running(min, { phase: 'verify', doing: '验收第 1 轮', prNumber: 13, verifyRound: 1 });
    expect(canaryNext(s, verifying(70)).kind).toBe('continue');
    const d = canaryNext(s, verifying(77));
    expect(d).toMatchObject({ kind: 'broken', stage: 'verify', spentMs: 47 * 60_000 });
    expect(whyOf(d)).toContain('超过期限 45 分钟还没走完');
    expect(whyOf(d)).toContain('在做：验收第 1 轮');
  });

  it('【故意造出的失败】巡检仓的路由全关：任务工作流停下等人（没有可用的路由），不用等期限，当场断在「动手」', () => {
    const parked = { phase: 'parked', parked: true, doing: '停下等人：没有可用的路由' };
    const waiting = { kind: 'human', detail: '没有可用的路由（等「继续」或「放弃」）' };
    const s = state({
      stage: 'implement',
      steps: [
        { stage: 'open', at: at(0) },
        { stage: 'intake', at: at(1) },
      ],
    });
    const withAlert = canaryNext(
      s,
      running(
        3,
        { ...parked, waiting },
        { openAlerts: [{ dedupeKey: `${WF}:park:1`, title: '没有可用的路由' }] },
      ),
    );
    expect(withAlert).toMatchObject({ kind: 'broken', stage: 'implement' });
    expect(whyOf(withAlert)).toContain('停下等人：没有可用的路由');
    // 报警没发出去（库那一下没写成）：状态里停下等人照样认得出
    const noAlert = canaryNext(s, running(3, { ...parked, waiting }));
    expect(noAlert).toMatchObject({ kind: 'broken', stage: 'implement' });
    expect(whyOf(noAlert)).toContain('停下等人：没有可用的路由（等「继续」或「放弃」）');
  });

  it('等并发空位、额度的时间不算进这一步的期限（忙不是断）；不等了还没走完，照算', () => {
    let s = state({ stage: 'implement', stageSince: at(0), lastCheckAt: at(0) });
    const busy = (min: number) =>
      running(min, { phase: 'implement', waiting: { kind: 'slot', detail: '等 Grok 的并发空位' } });
    for (let min = 2; min <= 80; min += 2) {
      const d = canaryNext(s, busy(min));
      expect(d.kind, `第 ${min} 分钟`).toBe('continue');
      s = d.state;
    }
    expect(s.busyMs).toBe(80 * 60_000);
    const idle = (min: number) => running(min, { phase: 'implement' });
    expect(canaryNext(s, idle(130)).kind).toBe('continue');
    const d = canaryNext(s, idle(141));
    expect(d).toMatchObject({ kind: 'broken', stage: 'implement', spentMs: 61 * 60_000 });
    expect(whyOf(d)).toContain('在做：第 1 轮：grok-5 动手');
  });

  it('返工（验收没过回去动手）：巡检停在「验收」不往回退；到期限写明返工了几轮、最近的问题', () => {
    const s = state({ stage: 'verify', stageSince: at(30), taskId: 'task-12', prNumber: 13 });
    const rework = (min: number) =>
      running(min, {
        phase: 'implement',
        doing: '第 2 轮：grok-5 动手',
        prNumber: 13,
        round: 2,
        verifyRound: 1,
        lastProblem: '验收没过',
      });
    const d1 = canaryNext(s, rework(40));
    expect(d1).toMatchObject({ kind: 'continue', state: { stage: 'verify' } });
    expect(stagesOf(d1.state)).toEqual(stagesOf(s));
    const d = canaryNext(s, rework(76));
    expect(d).toMatchObject({ kind: 'broken', stage: 'verify' });
    expect(whyOf(d)).toContain('返工过：动手第 2 轮、验收第 1 轮');
    expect(whyOf(d)).toContain('最近的问题：验收没过');
  });

  it('一轮总上限：一直在等空位、额度也不能拖过 5 小时', () => {
    const s = state({
      stage: 'merge',
      stageSince: at(10),
      lastCheckAt: at(CANARY_MAX_MINUTES - 1),
      busyMs: (CANARY_MAX_MINUTES - 12) * 60_000,
    });
    const d = canaryNext(
      s,
      running(CANARY_MAX_MINUTES + 1, { phase: 'merge', waiting: { kind: 'quota', detail: '等额度清零' } }),
    );
    expect(d).toMatchObject({ kind: 'broken', stage: 'merge' });
    expect(whyOf(d)).toContain('5 小时还没走完');
  });

  it('【故意造出的失败】任务工作流失败了、任务失败了、被放弃了、单子被关成不做了：断在当时那一步', () => {
    const pr = state({ stage: 'pr' });
    const failed = canaryNext(
      pr,
      obs(30, { db: facts({ task: TASK }), workflow: { state: 'closed', status: 'FAILED' } }),
    );
    expect(failed).toMatchObject({ kind: 'broken', stage: 'pr' });
    expect(whyOf(failed)).toContain('任务工作流失败了');
    const taskFailed = canaryNext(
      pr,
      obs(30, { db: facts({ task: { ...TASK, state: 'failed', lastProblem: 'CI 红了' } }) }),
    );
    expect(whyOf(taskFailed)).toContain('CI 红了');
    const abandoned = canaryNext(
      pr,
      obs(30, {
        db: facts({ task: { ...TASK, state: 'stopped', phase: 'abandoned' } }),
        workflow: { state: 'closed', status: 'COMPLETED' },
      }),
    );
    expect(whyOf(abandoned)).toContain('被叫停了（放弃）');
    const notPlanned = canaryNext(state({ stage: 'close' }), {
      ...finished(90),
      issue: { state: 'closed', stateReason: 'not_planned' },
    });
    expect(notPlanned).toMatchObject({ kind: 'broken', stage: 'close' });
  });

  it('【故意造出的失败】收单以后任务工作流不见了（没在跑、Temporal 里也查不到）：断在「动手」', () => {
    const d = canaryNext(state({ stage: 'implement' }), obs(10, { db: facts({ task: TASK }) }));
    expect(d).toMatchObject({ kind: 'broken', stage: 'implement' });
    expect(whyOf(d)).toContain('任务工作流不见了');
  });

  it('整张单做完：一回里走完剩下的每一步，通过；九步都记了走完的时刻', () => {
    const d = canaryNext(state({ stage: 'merge', steps: [] }), finished(50));
    expect(d.kind).toBe('pass');
    expect(stagesOf(d.state)).toEqual(['merge', 'close', 'ledger', 'board']);
    const all = canaryNext(state(), finished(50));
    expect(all.kind).toBe('pass');
    expect(stagesOf(all.state)).toEqual(ALL_STAGES);
  });

  it('【故意造出的失败】做完了却没记全账（验收那段没进 runs、用量全空）：到期限断在「记账」，写清记了几笔', () => {
    const s = state({ stage: 'ledger', stageSince: at(60) });
    const noVerify = {
      ...finished(60),
      db: facts({
        ...finished(60).db,
        runs: { total: 2, ended: 2, manual: 2, verify: 0, withUsage: 2 },
      }),
    };
    expect(canaryNext(s, { ...noVerify, at: at(65) }).kind).toBe('continue');
    const ledger = canaryNext(s, { ...noVerify, at: at(60 + CANARY_STAGE_LIMIT_MINUTES.ledger + 1) });
    expect(ledger).toMatchObject({ kind: 'broken', stage: 'ledger' });
    expect(whyOf(ledger)).toContain('runs 记了 2 笔（动手 2、验收 0）');
    const noUsage = { ...finished(60), db: facts({ ...finished(60).db, runs: { ...LEDGER, withUsage: 0 } }) };
    expect(canaryNext(s, { ...noUsage, at: at(80) })).toMatchObject({ kind: 'broken', stage: 'ledger' });
    const open = { ...finished(60), db: facts({ ...finished(60).db, runs: { ...LEDGER, ended: 2 } }) };
    expect(canaryNext(s, { ...open, at: at(80) })).toMatchObject({ kind: 'broken', stage: 'ledger' });
  });

  it('【故意造出的失败】驾驶舱读到的 PR 还没合、挂的不是这张单、镜像里没有：到期限断在「驾驶舱显示」，写清读到了什么', () => {
    const s = state({ stage: 'board', stageSince: at(60) });
    const late = at(60 + CANARY_STAGE_LIMIT_MINUTES.board + 1);
    const stale = canaryNext(s, {
      ...finished(0),
      at: late,
      board: { taskState: 'done', pr: { number: 13, state: 'open', mergedAt: null, linkedIssue: 12 } },
    });
    expect(stale).toMatchObject({ kind: 'broken', stage: 'board' });
    expect(whyOf(stale)).toContain('PR #13 open');
    const wrong = canaryNext(s, {
      ...finished(0),
      at: late,
      board: { taskState: 'done', pr: { number: 13, state: 'merged', mergedAt: at(40), linkedIssue: 99 } },
    });
    expect(wrong).toMatchObject({ kind: 'broken', stage: 'board' });
    expect(whyOf(wrong)).toContain('挂的单 #99');
    const missing = canaryNext(s, { ...finished(0), at: late, board: { taskState: 'done', pr: null } });
    expect(whyOf(missing)).toContain('PR 镜像里没有这张单的 PR');
  });

  it('换版本前起的一轮（停在老步骤「派活」上）：从收单接着看，这一回能走完的照走', () => {
    const legacy = { ...state(), stage: 'dispatch' } as unknown as CanaryState;
    const d = canaryNext(legacy, running(8, { phase: 'ci', prNumber: 13 }));
    expect(d.kind).toBe('continue');
    expect(d.state.stage).toBe('pr');
    expect(stagesOf(d.state)).toEqual(['open', 'intake', 'implement']);
  });

  it('每步用时说成人话；时刻认不出的那一步不拿 0 顶', () => {
    expect(spanWords(40_000)).toBe('40 秒');
    expect(spanWords(47 * 60_000 + 3_000)).toBe('47 分 3 秒');
    expect(spanWords(2 * 3_600_000 + 5 * 60_000)).toBe('2 小时 5 分');
    expect(
      stepSpans(at(0), [
        { stage: 'open', at: at(0.5) },
        { stage: 'intake', at: at(6) },
        { stage: 'implement', at: '认不出' },
      ]),
    ).toEqual([
      { stage: 'open', at: at(0.5), ms: 30_000 },
      { stage: 'intake', at: at(6), ms: 330_000 },
      { stage: 'implement', at: '认不出', ms: null },
    ]);
  });
});

describe('巡检单本身', () => {
  it('正文过得了拉单那一道交代检查（真的 buildTaskBrief）：三栏齐、三条验收条、已知的模块只有巡检记录 → 快档；没有「文档：」那一行', () => {
    const issue = canaryIssue(7, T0);
    expect(issue.title).toBe('巡检第 7 轮：往巡检记录追加一行');
    expect(issue.body).not.toContain('文档：');
    expect(canaryLogLine(7, T0)).toBe('- 第 7 轮 2026-09-27T12:26:00Z');
    // 开单留的隐藏标记（openIssue 追加在正文末尾）不影响交代
    const body = `${issue.body}\n\n<!-- fleet:issue:0123456789abcdef -->`;
    const got = buildTaskBrief({ issue: { number: 12, title: issue.title, body, state: 'open' } });
    if (!got.ok) throw new Error(`巡检单的交代不全：${JSON.stringify(got.problems)}`);
    expect(got.brief.acceptance).toHaveLength(3);
    expect(got.brief.acceptance[0]).toBe(
      '`巡检记录.md` 的最后一行是 `- 第 7 轮 2026-09-27T12:26:00Z`，一字不差。',
    );
    expect(got.brief.touches).toEqual(['`巡检记录.md`']);
    expect(got.brief.tier.tier).toBe('fast');
    expect(got.brief.specDir).toBeUndefined();
  });

  it('【故意造出的失败】正文要是丢了拉单要的一栏（已知的模块）或「怎么算做完」：交代不全、拉单不派，不当成写全了', () => {
    const body = canaryIssue(7, T0).body;
    const noModules = body.replace('## 已知的模块\n\n- `巡检记录.md`\n\n', '');
    expect(noModules).not.toContain('已知的模块');
    const a = buildTaskBrief({ issue: { number: 12, title: 't', body: noModules, state: 'open' } });
    expect(a.ok).toBe(false);
    expect(!a.ok && a.problems.map((p) => p.field)).toContain('已知的模块');
    const cut = body.split('## 怎么算做完')[0] ?? '';
    expect(criteriaOf(cleanBody(cut))).toMatchObject({ error: expect.any(String) });
    const b = buildTaskBrief({ issue: { number: 12, title: 't', body: cut, state: 'open' } });
    expect(!b.ok && b.problems.map((p) => p.field)).toContain('怎么算做完');
  });
});

// —— 一轮怎么跑：假的库、GitHub、Temporal ——

interface Harness {
  deps: CanaryDeps;
  calls: string[];
  boardAsked: { taskId: string; prNumber: number | null }[];
  runsFinished: { id: number; result: ScheduleResult }[];
  finished: { id: number; verdict: string; stage: string; why: string | null }[];
  alerts: {
    raised: { title: string; body: string; key?: string }[];
    resolved: string[];
    /** 撤掉的每一条带的键（不给键撤的是断了的那条，记 undefined）。 */
    resolvedKeys: (string | undefined)[];
  };
  setFacts(f: CanaryDbFacts): void;
  setWorkflow(w: CanaryObservation['workflow'], v?: CanaryView): void;
}

function harness(over: Partial<CanaryDeps> = {}, gh: Partial<CanaryDeps['github']> = {}): Harness {
  const calls: string[] = [];
  const boardAsked: Harness['boardAsked'] = [];
  const runsFinished: Harness['runsFinished'] = [];
  const finishedRows: Harness['finished'] = [];
  const alerts: Harness['alerts'] = { raised: [], resolved: [], resolvedKeys: [] };
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
        calls.push(`open:${input.dedupe}:${input.milestone}`);
        return { number: 12, url: 'https://github.test/acme/canary/issues/12' };
      },
      issueState: async () => ({ state: 'closed', stateReason: 'completed' }),
      closeIssue: async (n) => {
        calls.push(`close:${n}`);
      },
      closePulls: async () => [],
      ...gh,
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
    board: async (taskId, prNumber) => {
      boardAsked.push({ taskId, prNumber });
      return BOARD_DONE;
    },
    alerts: {
      raise: async (a) => {
        alerts.raised.push(a);
      },
      resolve: async (why, key) => {
        alerts.resolved.push(why);
        alerts.resolvedKeys.push(key);
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
    boardAsked,
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
  it('开单：开单时就挂上当前版本（v1，不是 v2）；去重键带着这一轮的编号', async () => {
    const h = harness();
    const r = await openCanaryRound(h.deps);
    expect(r.done).toBe(false);
    expect(h.calls).toEqual(['open:canary:7:1']);
    expect(!r.done && r.state).toMatchObject({ stage: 'intake', issueNumber: 12, runId: 1, canaryRunId: 7 });
  });

  it('【故意造出的失败】巡检自己起不来（没配巡检仓）：这一轮记没跑成（schedule_runs 记 failed），不开单', async () => {
    const h = harness({ repo: canaryRepoFrom(undefined) });
    const r = await openCanaryRound(h.deps);
    expect(r).toMatchObject({ done: true, run: { verdict: 'not_run', stage: 'open', steps: [] } });
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

  it('【故意造出的失败】开不了单（卫生检查拦了、GitHub 拒了）：没跑成、写明原因，不当成开成了', async () => {
    const h = harness(
      {},
      {
        openIssue: async () => {
          throw new Error('HYGIENE_BLOCKED：单子正文里有真密钥');
        },
      },
    );
    const r = await openCanaryRound(h.deps);
    expect(r).toMatchObject({ done: true, run: { verdict: 'not_run', stage: 'open', issueNumber: null } });
    expect(r.done && r.run.why).toContain('开不了单');
    expect(r.done && r.run.why).toContain('HYGIENE_BLOCKED');
    expect(h.runsFinished[0]?.result.outcome).toBe('failed');
  });

  it('开单前收掉前几轮留下的单：放弃它的任务工作流（task: 编号）、关单、记下收过了；收不掉的写进备注，不挡这一轮', async () => {
    const stopped: string[] = [];
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
          stopped.push(id);
          if (id.endsWith('#9')) throw new Error('Temporal 连不上');
          return 'gone';
        },
      },
    });
    h.deps.github.issueState = async () => ({ state: 'open', stateReason: null });
    const r = await openCanaryRound(h.deps);
    expect(r.done).toBe(false);
    expect(stopped).toEqual(['task:acme/canary#5', 'task:acme/canary#9']);
    expect(h.calls).toContain('close:5');
    expect(!r.done && r.state.notes).toEqual([
      '收掉了上一轮留下的 #5',
      '上一轮留下的 #9 没收掉：Temporal 连不上',
    ]);
  });

  /** 留下一张 #5 的 harness：closePulls 由调用方给；cleaned 记在 calls 里。 */
  function leftoverHarness(
    closePulls: (n: number, comment: string) => Promise<number[]>,
    over: Partial<CanaryDeps> = {},
  ) {
    const h = harness(
      {
        record: {
          ...harness().deps.record,
          leftovers: async () => [{ id: 3, issueNumber: 5 }],
          cleaned: async (id) => {
            h.calls.push(`cleaned:${id}`);
          },
        },
        ...over,
      },
      { issueState: async () => ({ state: 'open', stateReason: null }), closePulls },
    );
    return h;
  }

  it('收前几轮留下的单（#336）：连它开的、还开着的 PR 一起关，备注写明关了哪几个，记下收过了；PR 没关掉的报警（上回推过的）撤掉', async () => {
    const asked: { n: number; comment: string }[] = [];
    const h = leftoverHarness(async (n, comment) => {
      asked.push({ n, comment });
      return [13, 14];
    });
    const r = await openCanaryRound(h.deps);
    expect(r.done).toBe(false);
    expect(asked).toHaveLength(1);
    expect(asked[0]?.n).toBe(5);
    expect(asked[0]?.comment).toContain('#5');
    // 先关单、再关 PR、最后才记收过了
    expect(h.calls.slice(0, 3)).toEqual(['stop:task:acme/canary#5', 'close:5', 'cleaned:3']);
    expect(!r.done && r.state.notes).toEqual(['收掉了上一轮留下的 #5（连它开的 PR #13、#14 一起关了）']);
    expect(h.alerts.resolvedKeys).toEqual([CANARY_LEFTOVER_PR_ALERT_KEY]);
    expect(h.alerts.raised).toEqual([]);
  });

  it('留下的单没有 PR（工作流没走到开 PR）：只关单，备注和以前一字不差', async () => {
    const h = leftoverHarness(async () => []);
    const r = await openCanaryRound(h.deps);
    expect(!r.done && r.state.notes).toEqual(['收掉了上一轮留下的 #5']);
    expect(h.calls).toContain('close:5');
    expect(h.calls).toContain('cleaned:3');
  });

  it('【故意造出的失败】关单成了、关 PR 失败：推一条单独的报警（不是断了那条的键）写明哪张单、什么原因，备注写明，不记收过了（下一轮接着关），不挡这一轮开单', async () => {
    const h = leftoverHarness(async () => {
      throw new Error('GitHub 回了 403：关 PR 没权限');
    });
    const r = await openCanaryRound(h.deps);
    expect(r.done).toBe(false);
    expect(h.calls).toContain('close:5');
    expect(h.calls.some((c) => c.startsWith('cleaned:'))).toBe(false);
    expect(h.calls.some((c) => c.startsWith('open:'))).toBe(true);
    expect(!r.done && r.state.notes).toEqual([
      '上一轮留下的 #5 已关，但它开的 PR 没关掉：GitHub 回了 403：关 PR 没权限',
    ]);
    expect(h.alerts.raised).toHaveLength(1);
    expect(h.alerts.raised[0]).toMatchObject({ key: CANARY_LEFTOVER_PR_ALERT_KEY, taskId: null });
    expect(h.alerts.raised[0]?.key).not.toBe(CANARY_ALERT_KEY);
    expect(h.alerts.raised[0]?.body).toContain('#5：GitHub 回了 403：关 PR 没权限');
    expect(h.alerts.resolved).toEqual([]);
  });

  it('【故意造出的失败】PR 没关掉、报警也推不出：两件事都写进备注，不当成没事、也不挡这一轮', async () => {
    const h = leftoverHarness(
      async () => {
        throw new Error('关不掉');
      },
      {
        alerts: {
          raise: async () => {
            throw new Error('库连不上');
          },
          resolve: async () => {},
        },
      },
    );
    const r = await openCanaryRound(h.deps);
    expect(r.done).toBe(false);
    expect(!r.done && r.state.notes).toEqual([
      '上一轮留下的 #5 已关，但它开的 PR 没关掉：关不掉',
      'PR 没关掉的报警推不出：库连不上',
    ]);
  });

  it('同一轮里别的单没收成（放弃工作流连不上）：PR 那条报警不撤——不能把还没关的当关掉了', async () => {
    const h = leftoverHarness(async () => [], {
      workflows: {
        state: async () => ({ state: 'missing' }),
        view: async () => view(),
        stop: async () => {
          throw new Error('Temporal 连不上');
        },
      },
    });
    const r = await openCanaryRound(h.deps);
    expect(r.done).toBe(false);
    expect(!r.done && r.state.notes).toEqual(['上一轮留下的 #5 没收掉：Temporal 连不上']);
    expect(h.alerts.resolved).toEqual([]);
    expect(h.alerts.raised).toEqual([]);
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

  it('看一回、还在走：写进度、记下 PR 号；做完了：记通过、驾驶舱按这个 PR 号读、schedule_runs 记 ok（走了九步、发现 0 个）、撤断了的报警', async () => {
    const h = harness();
    const opened = await openCanaryRound(h.deps);
    if (opened.done) throw new Error('应当开成');
    h.setFacts(facts({ task: TASK }));
    h.setWorkflow({ state: 'running' }, view({ phase: 'ci', doing: '等 PR #13 的 CI', prNumber: 13 }));
    const next = await checkCanaryRound(h.deps, opened.state);
    if (next.done) throw new Error('应当还在走');
    expect(next.state).toMatchObject({ stage: 'pr', prNumber: 13 });
    h.setFacts(finished(0).db);
    h.setWorkflow({ state: 'closed', status: 'COMPLETED' });
    const done = await checkCanaryRound(h.deps, next.state);
    expect(done).toMatchObject({
      done: true,
      run: { verdict: 'pass', stage: 'board', startedAt: opened.state.openedAt },
    });
    expect(done.done && done.run.steps.map((s) => s.stage)).toEqual(ALL_STAGES);
    expect(h.boardAsked).toEqual([{ taskId: 'task-12', prNumber: 13 }]);
    expect(h.runsFinished.at(-1)?.result).toEqual({ outcome: 'ok', scanned: 9, found: 0 });
    expect(h.alerts.resolved).toHaveLength(1);
    expect(h.alerts.raised).toEqual([]);
  });

  it('【故意造出的失败】停在「验收」：推一条卡住报警（断在哪一步、这一步走了多久、走到哪了每步几点用了多久、单子在哪），记 broken；这一轮巡检本身跑成了（schedule_runs 记 ok、发现 1 个）', async () => {
    const h = harness();
    h.setFacts(facts({ task: TASK }));
    h.setWorkflow(
      { state: 'running' },
      view({ phase: 'verify', doing: '验收第 1 轮', prNumber: 13, verifyRound: 1 }),
    );
    const s = state({
      stage: 'verify',
      stageSince: at(-60),
      openedAt: at(-90),
      taskId: 'task-12',
      prNumber: 13,
      steps: [
        { stage: 'open', at: at(-90) },
        { stage: 'intake', at: at(-85) },
        { stage: 'implement', at: at(-70) },
        { stage: 'pr', at: at(-60) },
      ],
    });
    const r = await checkCanaryRound(h.deps, s);
    expect(r).toMatchObject({ done: true, run: { verdict: 'broken', stage: 'verify', issueNumber: 12 } });
    expect(h.alerts.raised).toHaveLength(1);
    expect(h.alerts.raised[0]?.title).toBe('全流程巡检断在「验收」');
    const body = h.alerts.raised[0]?.body ?? '';
    expect(body).toContain('断在「验收」（这一步走了 1 小时 1 分）：超过期限 45 分钟还没走完');
    expect(body).toContain('在做：验收第 1 轮');
    expect(body).toContain('收单 09-27 19:01（5 分 0 秒）');
    expect(body).toContain('动手 09-27 19:16（15 分 0 秒）');
    expect(body).toContain('验收（没走完，走了 1 小时 1 分）');
    expect(body).toContain('https://github.test/acme/canary/issues/12');
    expect(h.finished.at(-1)).toMatchObject({
      verdict: 'broken',
      stage: 'verify',
      why: expect.stringContaining('断在「验收」（这一步走了 1 小时 1 分）'),
    });
    expect(h.runsFinished.at(-1)?.result).toEqual({ outcome: 'ok', scanned: 4, found: 1 });
  });

  it('【故意造出的失败】工作流读不到（Temporal 连不上）：这一回记没查成、接着看，不当成断了；连着到上限，这一轮算巡检自己没跑成（schedule_runs 记 failed）', async () => {
    const h = harness({
      workflows: {
        state: async () => {
          throw new Error('Temporal 连不上：14 UNAVAILABLE');
        },
        view: async () => view(),
        stop: async () => 'sent',
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
    expect(r).toMatchObject({ done: true, run: { verdict: 'not_run', stage: 'intake' } });
    expect(r.done && r.run.why).toContain(`连着 ${CANARY_CHECK_FAILURE_LIMIT} 回没查成（停在「收单」）`);
    expect(r.done && r.run.why).toContain('Temporal 连不上');
    expect(h.runsFinished.at(-1)?.result.outcome).toBe('failed');
    expect(h.alerts.raised).toEqual([]);
  });

  it('【故意造出的失败】任务工作流的状态认不出（taskStatus 查询回的不是它的形状）、库读不到：都算这一回没查成，不当成「没停下」往前走', async () => {
    const odd = harness({
      workflows: {
        state: async () => ({ state: 'running' }),
        view: async (id) => canaryViewOf({ step: 'plan', parked: false }, id),
        stop: async () => 'sent',
      },
    });
    odd.setFacts(facts({ task: TASK }));
    const a = await checkCanaryRound(odd.deps, state());
    expect(a).toMatchObject({ done: false, state: { checkFailures: 1, stage: 'intake' } });
    const noDb = harness({
      facts: async () => {
        throw new Error('库连不上');
      },
    });
    const b = await checkCanaryRound(noDb.deps, state({ checkFailures: CANARY_CHECK_FAILURE_LIMIT - 1 }));
    expect(b).toMatchObject({ done: true, run: { verdict: 'not_run' } });
    expect(b.done && b.run.why).toContain('库连不上');
  });
});

describe('status 查询、巡检仓配置的读法', () => {
  it('认得出任务工作流的 taskStatus（停下等人：阶段是 parked 或在等人）；认不出的抛错（这一回没查成），不当成「没停下」', () => {
    const raw = {
      phase: 'parked',
      doing: '停下等人：没有可用的路由',
      round: 1,
      verifyRound: 0,
      prNumber: null,
      waiting: { kind: 'human', detail: '没有可用的路由（等「继续」或「放弃」）', since: at(0) },
      lastProblem: '没有可用的路由',
      tier: null,
    };
    expect(canaryViewOf(raw, WF)).toEqual({
      phase: 'parked',
      doing: '停下等人：没有可用的路由',
      parked: true,
      waiting: { kind: 'human', detail: '没有可用的路由（等「继续」或「放弃」）' },
      prNumber: null,
      lastProblem: '没有可用的路由',
      round: 1,
      verifyRound: 0,
    });
    expect(
      canaryViewOf(
        { ...raw, phase: 'ci', waiting: { kind: 'ci', detail: '等 CI', since: at(0) }, prNumber: 13 },
        WF,
      ),
    ).toMatchObject({ parked: false, prNumber: 13 });
    // Fusion 的 status（step、parked）不是任务工作流的：认不出
    expect(() => canaryViewOf({ step: 'plan', parked: false }, WF)).toThrow('认不出');
    expect(() => canaryViewOf({ ...raw, waiting: 'x' }, WF)).toThrow('waiting');
    expect(() => canaryViewOf({ ...raw, prNumber: '13' }, WF)).toThrow('prNumber');
  });

  it('FLEET_CANARY_REPO：owner/name 才认；没配、写错都明说', () => {
    expect(canaryRepoFrom(' acme/fleet-canary ')).toEqual({ owner: 'acme', name: 'fleet-canary' });
    expect(canaryRepoFrom(undefined)).toMatchObject({ error: expect.stringContaining('没配巡检仓') });
    expect(canaryRepoFrom('fleet-canary')).toMatchObject({ error: expect.stringContaining('认不出') });
  });
});

// —— 关巡检单开过的 PR（#336）：假的 claims ——

describe('closeLeftoverPulls：关巡检单开过的 PR', () => {
  type Facts = Awaited<ReturnType<CanaryPullsGitHub['readPull']>>;
  const facts = (number: number, over: Partial<Facts> = {}): Facts => ({
    number,
    nodeId: `N${number}`,
    state: 'open',
    merged: false,
    draft: false,
    title: `PR ${number}`,
    body: '',
    headSha: 'a'.repeat(40),
    headRef: `fleet/5-t0123abcd`,
    fromFork: false,
    author: null,
    autoMerge: false,
    ...over,
  });

  /** 假的 claims：listed 是开着的列表，now 是逐个现读的结果（没给就读成列表里那份）。 */
  function claimsOf(listed: Facts[], now: Record<number, Facts> = {}, over: Partial<CanaryPullsGitHub> = {}) {
    const calls: string[] = [];
    const claims: CanaryPullsGitHub = {
      openPulls: async () => listed,
      readPull: async (_repo, n) => {
        const f = now[n] ?? listed.find((p) => p.number === n);
        if (!f) throw new Error(`没有 #${n}`);
        return f;
      },
      commentPull: async (_repo, n, key) => {
        calls.push(`comment:${n}:${key}`);
        return { created: true } as never;
      },
      closePull: async (_repo, n) => {
        calls.push(`close:${n}`);
      },
      ...over,
    };
    return { claims, calls };
  }

  const repo = { owner: 'acme', name: 'canary' };

  it('这张单的引擎分支开着的 PR：留一句说明、关掉，回关了哪几个；别张单的分支、从 fork 来的不碰', async () => {
    const { claims, calls } = claimsOf([
      facts(13),
      facts(14, { headRef: 'fleet/5-t99999999' }),
      facts(20, { headRef: 'fleet/50-t0123abcd' }), // #50 不是 #5：前缀要带上 -t
      facts(21, { headRef: 'fleet/6-t0123abcd' }),
      facts(22, { fromFork: true }),
      facts(23, { headRef: 'feature/5-t1' }),
    ]);
    expect(await closeLeftoverPulls(claims, repo, 5, '收掉')).toEqual([13, 14]);
    expect(calls).toEqual([
      'comment:13:canary-leftover:13',
      'close:13',
      'comment:14:canary-leftover:14',
      'close:14',
    ]);
  });

  it('没有 PR：什么都不关，回空', async () => {
    const { claims, calls } = claimsOf([facts(21, { headRef: 'fleet/6-t0123abcd' })]);
    expect(await closeLeftoverPulls(claims, repo, 5, '收掉')).toEqual([]);
    expect(calls).toEqual([]);
  });

  it('PR 已经合并：不动——列表里没有它（只列开着的），或列出来之后、关之前被合了（现读一遍）', async () => {
    const { claims, calls } = claimsOf([facts(13), facts(14)], {
      13: facts(13, { state: 'closed', merged: true }),
      14: facts(14, { state: 'closed', merged: false }),
    });
    expect(await closeLeftoverPulls(claims, repo, 5, '收掉')).toEqual([]);
    expect(calls).toEqual([]);
    const none = claimsOf([]);
    expect(await closeLeftoverPulls(none.claims, repo, 5, '收掉')).toEqual([]);
    expect(none.calls).toEqual([]);
  });

  it('【故意造出的失败】关不掉：抛出来（调用方报警），不回「关了」；列不出、现读不到同样抛', async () => {
    const stuck = claimsOf(
      [facts(13)],
      {},
      {
        closePull: async () => {
          throw new Error('GitHub 回了 403');
        },
      },
    );
    await expect(closeLeftoverPulls(stuck.claims, repo, 5, '收掉')).rejects.toThrow('GitHub 回了 403');
    const noList = claimsOf(
      [],
      {},
      {
        openPulls: async () => {
          throw new Error('翻不完页');
        },
      },
    );
    await expect(closeLeftoverPulls(noList.claims, repo, 5, '收掉')).rejects.toThrow('翻不完页');
    const noRead = claimsOf(
      [facts(13)],
      {},
      {
        readPull: async () => {
          throw new Error('读不到');
        },
      },
    );
    await expect(closeLeftoverPulls(noRead.claims, repo, 5, '收掉')).rejects.toThrow('读不到');
    expect(noRead.calls).toEqual([]);
  });

  it('留说明没留成：不挡关 PR，记一条 warn', async () => {
    const logs: string[] = [];
    const { claims, calls } = claimsOf(
      [facts(13)],
      {},
      {
        commentPull: async () => {
          throw new Error('评论被限流');
        },
      },
    );
    expect(
      await closeLeftoverPulls(claims, repo, 5, '收掉', (level, text) => logs.push(`${level}:${text}`)),
    ).toEqual([13]);
    expect(calls).toEqual(['close:13']);
    expect(logs).toEqual(['warn:巡检收单：给 PR 留说明没留成，照样关']);
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

  /** 假的「引擎」机器人：开单发 #12，别的都照做。 */
  function fakeGh(over: Partial<Parameters<typeof canaryJob>[0]['gh']> = {}) {
    const calls: string[] = [];
    const gh: Parameters<typeof canaryJob>[0]['gh'] = {
      claims: {
        openPulls: async () => [],
        readPull: async () => {
          throw new Error('这里不该读 PR');
        },
        commentPull: async () => ({ created: true }) as never,
        closePull: async () => {},
      },
      readOpenMilestones: async () => [{ number: 1, title: 'v1 巡检' }],
      openIssue: async (input) => {
        calls.push(`open:${input.key}:${input.labels.length}:${input.milestone}`);
        return { number: 12, url: 'https://github.test/acme/canary/issues/12', created: true };
      },
      readIssueState: async () => ({ state: 'open', stateReason: null }),
      closeIssue: async () => {
        calls.push('close');
        return { alreadyClosed: false, commentId: 1, commentUrl: 'u', commentCreated: true };
      },
      ...over,
    };
    return { gh, calls };
  }

  /** 假的 Temporal 客户端：这张单的任务工作流 describe 回 status，taskStatus 查询回 taskStatus。 */
  function fakeClient(status: string, taskStatus?: unknown): Client {
    const handle = {
      describe: async () => ({ status: { name: status } }),
      query: async () => taskStatus,
      signal: async () => {},
    };
    return {
      workflow: { getHandle: () => handle },
      connection: { withDeadline: <R>(_: number, fn: () => Promise<R>) => fn() },
    } as unknown as Client;
  }

  async function canaryRepo(): Promise<string> {
    const [repo] = await t.db
      .insert(repos)
      .values({ ...REPO, testCommand: 'node --test', autoDispatchSince: new Date(T0.getTime() - 60_000) })
      .returning();
    if (!repo) throw new Error('仓没写进去');
    return repo.id;
  }

  async function canaryTask(repoId: string, state: 'stalled' | 'done', phase: string): Promise<string> {
    const [task] = await t.db
      .insert(tasks)
      .values({
        repoId,
        issueNumber: 12,
        title: '巡检第 1 轮：往巡检记录追加一行',
        rawRequest: '巡检单',
        requestedBy: 'engine',
        priority: 10,
        state,
        phase,
      })
      .returning();
    if (!task) throw new Error('任务行没写进去');
    return task.id;
  }

  it(
    '【故意造出的失败】巡检仓的路由全关：任务工作流停下等人，这一轮报「断在动手」、推一条卡住报警、记进库；巡检本身跑成了（登记表上是 ok）',
    async () => {
      await registerEngineJobs(t.db);
      const repoId = await canaryRepo();
      const { gh, calls } = fakeGh();
      let clock = T0.getTime();
      const make = canaryJob({
        db: t.db,
        gh,
        repo: 'acme/canary',
        now: () => {
          clock += 60_000;
          return new Date(clock);
        },
        log: () => {},
      });
      const deps = make(
        fakeClient('RUNNING', {
          phase: 'parked',
          doing: '停下等人：没有可用的路由',
          round: 1,
          verifyRound: 0,
          prNumber: null,
          waiting: {
            kind: 'human',
            detail: '没有可用的路由（等「继续」或「放弃」）',
            since: T0.toISOString(),
          },
          lastProblem: '没有可用的路由',
          tier: null,
        }),
      );
      const opened = await openCanaryRound(deps);
      if (opened.done) throw new Error(`应当开成：${opened.run.why}`);
      // 开单不贴标签、开单时就挂上当前版本（去重键带这一轮的编号）
      expect(calls).toEqual(['open:canary:1:0:1']);
      // 拉单建了任务行、起了任务工作流；工作流选路一条都没有：停下等人、报警（workflows/task.ts 的 park）
      const taskId = await canaryTask(repoId, 'stalled', 'parked');
      await upsertAlert(t.db, {
        dedupeKey: `${WF}:park:1`,
        level: 'alert',
        taskId,
        title: '没有可用的路由',
        body: '一条都派不出去',
      });
      const r = await checkCanaryRound(deps, opened.state);
      expect(r).toMatchObject({
        done: true,
        run: { verdict: 'broken', stage: 'implement', issueNumber: 12 },
      });
      const row = await canaryRunById(t.db, opened.state.canaryRunId);
      expect(row).toMatchObject({ verdict: 'broken', stage: 'implement', issueNumber: 12, taskId });
      expect(row?.why).toContain('断在「动手」');
      expect(row?.why).toContain('停下等人：没有可用的路由');
      expect(row?.steps.map((s) => s.stage)).toEqual(['open', 'intake']);
      const alert = (await t.db.select().from(notifications)).find((n) => n.dedupeKey === CANARY_ALERT_KEY);
      expect(alert).toMatchObject({ level: 'alert', title: '全流程巡检断在「动手」', resolvedAt: null });
      const [run] = await t.db.select().from(scheduleRuns);
      expect(run).toMatchObject({ job: 'canary', outcome: 'ok', found: 1 });
      const health = (await scheduleHealth(t.db, new Date(clock))).find((h) => h.job.id === 'canary');
      expect(health?.status).toBe('ok');
      expect((await latestCanaryRuns(t.db)).finished?.verdict).toBe('broken');
    },
    TEST_DB_TIMEOUT_MS,
  );

  it(
    '一整张做完的单：库里的账（runs、每步耗时）、PR 镜像（驾驶舱 Store 读）、GitHub 上做完关了 → 这一轮通过，九步都记进库',
    async () => {
      await registerEngineJobs(t.db);
      const repoId = await canaryRepo();
      const { gh } = fakeGh({ readIssueState: async () => ({ state: 'closed', stateReason: 'completed' }) });
      let clock = T0.getTime();
      const deps = canaryJob({
        db: t.db,
        gh,
        repo: 'acme/canary',
        now: () => {
          clock += 60_000;
          return new Date(clock);
        },
        log: () => {},
      })(fakeClient('COMPLETED'));
      const opened = await openCanaryRound(deps);
      if (opened.done) throw new Error(`应当开成：${opened.run.why}`);
      const taskId = await canaryTask(repoId, 'done', 'done');
      const after = (min: number) => new Date(T0.getTime() + min * 60_000);
      await startRun(t.db, {
        segment: 'manual',
        issueNumber: 12,
        model: 'grok-5',
        startedAt: after(10),
        endedAt: after(20),
        outcome: 'done',
        inputTokens: 5000,
      });
      await startRun(t.db, {
        segment: 'verify',
        issueNumber: 12,
        model: 'opus-5.5',
        startedAt: after(25),
        endedAt: after(30),
        outcome: 'done',
        inputTokens: 3000,
      });
      await t.db.insert(stepTimings).values({
        kind: 'activity',
        workflowId: WF,
        temporalRunId: 'run-1',
        workflowType: 'taskWorkflow',
        taskId,
        activity: 'createWorktree',
        attempt: 1,
        scheduledAt: after(5),
        startedAt: after(5),
        endedAt: after(6),
        queueMs: 0,
        runMs: 60_000,
        outcome: 'ok',
      });
      await t.db.insert(pullRequests).values({
        repoId,
        number: 13,
        state: 'merged',
        headRef: 'fleet/12-t0123abcd',
        headSha: 'a'.repeat(40),
        updatedAt: after(35),
        openedAt: after(20),
        mergedAt: after(35),
        mergeSha: 'b'.repeat(40),
        issueRefs: [12],
      });
      // 任务工作流在跑时巡检读到过 PR 号（开 PR 以后的 taskStatus）
      const r = await checkCanaryRound(deps, { ...opened.state, prNumber: 13 });
      expect(r).toMatchObject({ done: true, run: { verdict: 'pass', stage: 'board', issueNumber: 12 } });
      const row = await canaryRunById(t.db, opened.state.canaryRunId);
      expect(row).toMatchObject({ verdict: 'pass', stage: 'board', taskId });
      expect(row?.steps.map((s) => s.stage)).toEqual(ALL_STAGES);
    },
    TEST_DB_TIMEOUT_MS,
  );

  it(
    '收前几轮留下的单：真装配给任务工作流发「放弃」信号（taskAbandon，谁发的写 engine:canary）；工作流早没了回 gone，不当成出错',
    async () => {
      const sent: { id: string; name: string; arg: unknown }[] = [];
      const client = {
        workflow: {
          getHandle: (id: string) => ({
            signal: async (def: { name: string }, arg: unknown) => {
              if (id.endsWith('#9')) throw new WorkflowNotFoundError('工作流不在了', id, undefined);
              sent.push({ id, name: def.name, arg });
            },
          }),
        },
        connection: { withDeadline: <R>(_: number, fn: () => Promise<R>) => fn() },
      } as unknown as Client;
      const deps = canaryJob({
        db: t.db,
        gh: fakeGh().gh,
        repo: 'acme/canary',
        now: () => T0,
        log: () => {},
      })(client);
      expect(await deps.workflows.stop('task:acme/canary#5', '收掉')).toBe('sent');
      expect(sent).toEqual([
        { id: 'task:acme/canary#5', name: 'taskAbandon', arg: { by: 'engine:canary', reason: '收掉' } },
      ]);
      expect(await deps.workflows.stop('task:acme/canary#9', '收掉')).toBe('gone');
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
      const a = await openCanaryRound(unconfigured(fakeClient('RUNNING')));
      expect(a).toMatchObject({ done: true, run: { verdict: 'not_run' } });
      let health = (await scheduleHealth(t.db, T0)).find((h) => h.job.id === CANARY_JOB.id);
      expect(health?.status).toBe('failing');
      expect(health?.lastRun?.why).toContain('FLEET_CANARY_REPO');
      const unreadable = canaryJob({ db: t.db, gh, repo: 'acme/canary', now: () => T0, log: () => {} });
      const b = await openCanaryRound(unreadable(fakeClient('RUNNING')));
      expect(b).toMatchObject({ done: true, run: { verdict: 'not_run' } });
      health = (await scheduleHealth(t.db, T0)).find((h) => h.job.id === CANARY_JOB.id);
      expect(health?.status).toBe('failing');
      expect(health?.lastRun?.why).toContain('GitHub 回了 502');
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

  it('开单、隔一会儿看一回、一直看到有结论：交回这一轮的结局（带每一步走完的时刻）', async () => {
    const h = harness();
    let checks = 0;
    const inner = h.deps.facts;
    h.deps.facts = async (input) => {
      checks += 1;
      if (checks >= 3) {
        h.setWorkflow({ state: 'closed', status: 'COMPLETED' });
        return finished(0).db;
      }
      return inner(input);
    };
    const run = await runOnce({ canary: () => h.deps });
    expect(run).toMatchObject({ verdict: 'pass', stage: 'board', issueNumber: 12 });
    expect(run.steps.map((s) => s.stage)).toEqual(ALL_STAGES);
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
