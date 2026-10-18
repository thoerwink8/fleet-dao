// 任务页概览的演示数据（#3140）：和真后端（packages/api/src/task-overview.ts）读出来的是同一个形状。
// - 每一笔的命令计数、步骤：把会话演示数据（transcripts.ts）转成轻量行，交给 shared 的 cutSteps 算（和真后端同一个算法）。
// - 回合、引擎在会话外做的事、PR 改了哪些文件：照 t-c9（做完的单，两个回合，返工一次）和 t-12（在跑，返工的第二回合）手摆一份；
//   别的单没摆，页面上就是「老记录没记回合」「这个 PR 没记过改了哪些文件」，演示老记录。
// 网址参数 ?mockOverview=old（老后端没有这一项）、unread（几块都读不到）演示两种「没读到」。
import { cutSteps, processRowOf } from '@fleet-dao/shared';
import type { TaskDetail, TranscriptEntry } from '../types';

type Overview = NonNullable<TaskDetail['overview']>;
type Round = Extract<Overview['rounds'], { state: 'ok' }>['items'][number];
type EngineStep = Extract<Overview['engineSteps'], { state: 'ok' }>['items'][number];
type PrFile = Extract<Overview['prs'][number]['files'], { state: 'ok' }>['items'][number];
type Tally = Extract<Overview['tally'], { state: 'ok' }>['total'];

export type MockOverviewMode = 'old' | 'unread' | undefined;

export function mockOverviewMode(search: string): MockOverviewMode {
  const v = new URLSearchParams(search).get('mockOverview');
  return v === 'old' || v === 'unread' ? v : undefined;
}

interface TaskFixture {
  rounds: Round[];
  engineSteps: EngineStep[];
  /** PR 号 → 推分支时按头记的 numstat；没写的 PR 就是「没记过」。 */
  prFiles: Record<number, { headSha: string; files: PrFile[] }>;
  /** PR 号 → 镜像里现在的头（和记的头不一样就标「不是最新的头」）。 */
  prHead?: Record<number, string>;
}

const PR12_HEAD = '4c1d2ab9e07f';

/** at(min)：距「现在」多少分钟的 ISO 时间。 */
function fixtures(at: (min: number) => string): Record<string, TaskFixture> {
  const act = (
    activity: string,
    start: number,
    runMin: number,
    over: Partial<Extract<EngineStep, { kind: 'activity' }>> = {},
  ): EngineStep => ({
    kind: 'activity',
    activity,
    attempt: 1,
    startedAt: at(start),
    endedAt: at(start + runMin),
    runMs: Math.round(runMin * 60_000),
    outcome: 'ok',
    ...over,
  });
  const wait = (waitFor: string, start: number, detail?: string): EngineStep => ({
    kind: 'wait',
    waitFor,
    ...(detail ? { detail } : {}),
    startedAt: at(start),
    endedAt: at(start + 0.5),
    waitMs: 30_000,
  });
  return {
    't-c9': {
      rounds: [
        {
          seq: 1,
          round: 1,
          outcome: 'timeout',
          tier: 'fast',
          firstModel: 'kimi-k3',
          startedAt: at(-174),
          endedAt: at(-143),
          reworkSummary: '30 分钟没交活，按超时收了；换 opus 重派，接着分支上已有的改动做',
        },
        {
          seq: 2,
          round: 2,
          outcome: 'merged',
          tier: 'fast',
          firstModel: 'opus-5.5',
          addedLines: 14,
          startedAt: at(-142),
          endedAt: at(-98),
        },
      ],
      engineSteps: [
        act('createWorktree', -175, 0.4),
        wait('memory', -142.9, '等内存放行'),
        wait('memory', -142.6),
        wait('memory', -142.3),
        act('selfCheck', -118, 3.2),
        act('pushBranch', -114.5, 0.3),
        act('openPr', -114, 0.2),
        act('waitCi', -113.6, 2.8),
        act('coldVerify', -110, 7),
        act('armAutoMerge', -102, 0.1),
        act('waitMerged', -101.5, 3.4),
      ],
      prFiles: {
        12: {
          headSha: PR12_HEAD,
          files: [
            { path: 'scripts/stamp.ts', added: 6, removed: 2, binary: false },
            { path: 'scripts/stamp.fixtures.ts', added: 24, removed: 0, binary: false },
            { path: 'scripts/stamp.test.ts', added: 1, removed: 1, binary: false },
            { path: 'README.md', added: 1, removed: 1, binary: false },
            { path: 'assets/stamp-preview.png', added: null, removed: null, binary: true },
          ],
        },
      },
      prHead: { 12: PR12_HEAD },
    },
    't-12': {
      rounds: [
        {
          seq: 1,
          round: 1,
          outcome: 'ci_red',
          tier: 'heavyweight',
          firstModel: 'opus-5.5',
          startedAt: at(-120),
          endedAt: at(-60),
          reworkSummary: 'CI 红了：packages/db 的 schema 测试里字段名对不上，接着上一回合的会话改',
        },
      ],
      engineSteps: [
        act('createWorktree', -121, 0.4),
        act('selfCheck', -64, 2.1),
        act('pushBranch', -61.5, 0.3),
        act('openPr', -61.2, 0.2),
        act('waitCi', -61, 0.9, { outcome: 'failed', errorCode: 'CI_RED' }),
      ],
      prFiles: {},
    },
  };
}

/** 会话条目 → 一笔的小计（和库里 GROUP BY run_id 算的同一个口径：命令按调用号配、没退出码的算结果未知）。 */
function tallyOfEntries(entries: readonly TranscriptEntry[], running: boolean): Tally {
  const proc = cutSteps(entries.map(processRowOf), { running });
  const c = proc.counts;
  return {
    entries: entries.length,
    calls: proc.steps.reduce((n, s) => n + s.calls, 0),
    commands: c.commands,
    commandsDone: c.commandsDone,
    commandsFailed: c.commandsFailed,
    commandsUnknown: c.commandsUnknown,
    commandsRunning: c.commandsRunning,
    reads: c.reads,
    callsFailed: c.callsFailed,
    editsOk: c.files.reduce((n, f) => n + f.edits, 0),
    uncounted: c.uncounted,
    added: c.added,
    removed: c.removed,
    ...(entries[0] ? { firstAt: entries[0].at } : {}),
    ...(entries.at(-1) ? { lastAt: entries.at(-1)?.at as string } : {}),
  };
}

const sum = (rows: readonly Tally[]): Tally => ({
  entries: rows.reduce((n, r) => n + r.entries, 0),
  calls: rows.reduce((n, r) => n + r.calls, 0),
  commands: rows.reduce((n, r) => n + r.commands, 0),
  commandsDone: rows.reduce((n, r) => n + r.commandsDone, 0),
  commandsFailed: rows.reduce((n, r) => n + r.commandsFailed, 0),
  commandsUnknown: rows.reduce((n, r) => n + r.commandsUnknown, 0),
  commandsRunning: rows.reduce((n, r) => n + r.commandsRunning, 0),
  reads: rows.reduce((n, r) => n + r.reads, 0),
  callsFailed: rows.reduce((n, r) => n + r.callsFailed, 0),
  editsOk: rows.reduce((n, r) => n + r.editsOk, 0),
  uncounted: rows.reduce((n, r) => n + r.uncounted, 0),
  added: rows.reduce((n, r) => n + r.added, 0),
  removed: rows.reduce((n, r) => n + r.removed, 0),
});

export function mockOverview(input: {
  mode: MockOverviewMode;
  taskId: string;
  runs: TaskDetail['segmentRuns'];
  taskState: TaskDetail['task']['state'];
  /** 这一段现在放出来的条目（在跑的段只放一部分）；没有记录是 undefined。 */
  entriesOf: (runId: string) => readonly TranscriptEntry[] | undefined;
  subtaskPrs: readonly number[];
  at: (min: number) => string;
}): Overview | undefined {
  if (input.mode === 'old') return undefined;
  const fx = fixtures(input.at)[input.taskId] ?? { rounds: [], engineSteps: [], prFiles: {} };
  const prNumbers = [
    ...new Set([
      ...input.runs.flatMap((r) => (r.prNumber === undefined ? [] : [r.prNumber])),
      ...input.subtaskPrs,
    ]),
  ].sort((a, b) => a - b);
  const prState = input.taskState === 'done' ? 'merged' : input.taskState === 'failed' ? 'failed' : 'open';
  const prs: Overview['prs'] = prNumbers.map((number) => {
    const branch = input.runs.findLast((r) => r.prNumber === number && r.branch !== undefined)?.branch;
    const rec = fx.prFiles[number];
    const head = fx.prHead?.[number];
    return {
      number,
      ...(branch === undefined ? {} : { branch }),
      state: prState,
      ...(head === undefined ? {} : { headSha: head }),
      files:
        input.mode === 'unread'
          ? { state: 'unavailable', reason: '没读成：connection terminated' }
          : rec
            ? {
                state: 'ok',
                headSha: rec.headSha,
                ...(head === undefined ? {} : { current: rec.headSha === head }),
                items: rec.files,
              }
            : {
                state: 'none',
                reason: '这个 PR 没有记过改了哪些文件（在记这个账之前推的，或推分支时没数成）',
              },
    };
  });
  if (input.mode === 'unread') {
    const reason = '会话内容没读成：connection terminated';
    return {
      prs,
      tally: { state: 'unavailable', reason },
      report: { state: 'unavailable', reason },
      rounds: { state: 'unavailable', reason: '回合没读成：connection terminated' },
      engineSteps: { state: 'unavailable', reason: '引擎在会话外做的事没读成：connection terminated' },
    };
  }
  const byRun: Record<string, Tally> = {};
  for (const r of input.runs) {
    const entries = input.entriesOf(r.id);
    if (entries && entries.length > 0) byRun[r.id] = tallyOfEntries(entries, r.running);
  }
  const manual = input.runs.findLast((r) => r.segment === 'manual');
  const said = manual
    ? input
        .entriesOf(manual.id)
        ?.filter((e) => e.kind === 'assistant' && e.meta?.subagent === undefined)
        .at(-1)
    : undefined;
  return {
    prs,
    tally: { state: 'ok', total: sum(Object.values(byRun)), byRun },
    report:
      manual && said
        ? { state: 'ok', text: said.text, at: said.at, runId: manual.id }
        : {
            state: 'none',
            reason: manual
              ? '最近一笔动手会话还没说过话（刚起，或跑在记录会话内容之前）'
              : input.runs.length === 0
                ? '这张单还没跑过'
                : '这张单还没有动手的会话',
          },
    rounds: { state: 'ok', items: fx.rounds },
    engineSteps: { state: 'ok', items: fx.engineSteps },
  };
}
