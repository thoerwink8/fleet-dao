// 任务页「过程」的读法（#3140）：一笔的轻量行、几笔的批量小计、最后一句话、回合、引擎在会话外做的事。
// 概览和 shared 的 cutSteps 共享调用/结果规则，对同一份记录要算出同一个数。
import { randomUUID } from 'node:crypto';
import { cutSteps, tallyOf } from '@fleet-dao/shared';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { recordTaskRound } from '../src/queries/pipeline-health.ts';
import { appendRunTranscript, type TranscriptRow } from '../src/queries/run-transcript.ts';
import { startRun } from '../src/queries/runs.ts';
import {
  ENGINE_STEP_ACTIVITIES,
  ENGINE_STEPS_MAX,
  listTaskEngineSteps,
  listTaskRounds,
  readRunLastSay,
  readRunProcessRows,
  readRunTallies,
} from '../src/queries/task-process.ts';
import { stepTimings } from '../src/schema/index.ts';
import { createTestDb, resetTestDb, TEST_DB_TIMEOUT_MS, type TestDb } from '../src/testing.ts';
import { addRepo, addTask, ago, catalog, MIN, NOW } from './helpers.ts';

let t: TestDb;
beforeAll(async () => {
  t = await createTestDb();
}, TEST_DB_TIMEOUT_MS);
afterAll(() => t.close());

let taskId: string;
beforeEach(async () => {
  await resetTestDb(t);
  await catalog(t.db);
  const repo = await addRepo(t.db);
  taskId = (await addTask(t.db, repo.id)).id;
});

const at = (sec: number) => new Date(NOW.getTime() + sec * 1000);
type Row = Omit<TranscriptRow, 'at'> & { sec: number };
const toRows = (rows: Row[]): TranscriptRow[] => rows.map(({ sec, ...r }) => ({ ...r, at: at(sec) }));
async function newRun(over: { ended?: boolean } = {}) {
  const r = await startRun(t.db, {
    segment: 'manual',
    model: 'opus-5.5',
    taskId,
    startedAt: ago(10 * MIN),
    ...(over.ended === false ? {} : { endedAt: ago(MIN), outcome: 'done' as const }),
  });
  return r.id;
}

/** 一笔里什么情况都有的记录：成功、失败、没结果、没调用号、Mirasim 没退出码、改文件有行数和没行数、读文件、子代理。 */
const MIXED: Row[] = [
  { seq: 0, sec: 0, kind: 'prompt', text: '提示词' },
  { seq: 1, sec: 1, kind: 'assistant', text: '开工' },
  { seq: 2, sec: 2, kind: 'tool_call', tool: 'Bash', text: 'ok-cmd', meta: { callId: 'c1' } },
  { seq: 3, sec: 3, kind: 'tool_result', tool: 'Bash', ok: true, text: '成', meta: { callId: 'c1' } },
  { seq: 4, sec: 4, kind: 'tool_call', tool: 'Bash', text: 'fail-cmd', meta: { callId: 'c2' } },
  { seq: 5, sec: 5, kind: 'tool_result', tool: 'Bash', ok: false, text: '败', meta: { callId: 'c2' } },
  { seq: 6, sec: 6, kind: 'tool_call', tool: 'Bash', text: 'no-result-cmd', meta: { callId: 'c3' } },
  { seq: 7, sec: 7, kind: 'tool_call', tool: 'Bash', text: 'legacy-cmd' },
  { seq: 8, sec: 8, kind: 'tool_result', tool: 'Bash', ok: true, text: '老记录的结果' },
  { seq: 9, sec: 9, kind: 'tool_call', tool: 'shellToolCall', text: 'mira-cmd', meta: { callId: 'c4' } },
  {
    seq: 10,
    sec: 10,
    kind: 'tool_result',
    tool: 'shellToolCall',
    ok: true,
    text: '',
    meta: { callId: 'c4', exitKnown: false },
  },
  { seq: 11, sec: 11, kind: 'tool_call', tool: 'Read', text: 'a.ts', meta: { callId: 'r1' } },
  { seq: 12, sec: 12, kind: 'tool_result', tool: 'Read', ok: true, text: '内容', meta: { callId: 'r1' } },
  { seq: 13, sec: 13, kind: 'tool_call', tool: 'Edit', text: 'a.ts', meta: { callId: 'e1' } },
  {
    seq: 14,
    sec: 14,
    kind: 'tool_result',
    tool: 'Edit',
    ok: true,
    text: 'ok',
    meta: { callId: 'e1', added: 3, removed: 1 },
  },
  { seq: 15, sec: 15, kind: 'tool_call', tool: 'Write', text: 'b.ts', meta: { callId: 'e2' } },
  { seq: 16, sec: 16, kind: 'tool_result', tool: 'Write', ok: true, text: 'ok', meta: { callId: 'e2' } },
  { seq: 17, sec: 17, kind: 'tool_call', tool: 'Edit', text: 'c.ts', meta: { callId: 'e3' } },
  {
    seq: 18,
    sec: 18,
    kind: 'tool_result',
    tool: 'Edit',
    ok: false,
    text: 'no',
    meta: { callId: 'e3', added: 99, removed: 99 },
  },
  {
    seq: 19,
    sec: 19,
    kind: 'tool_call',
    tool: 'Grep',
    text: 'x',
    meta: { callId: 's1', subagent: 'agent-1' },
  },
  { seq: 20, sec: 20, kind: 'assistant', text: '子代理的话', meta: { subagent: 'agent-1' } },
  { seq: 21, sec: 21, kind: 'assistant', text: '最后一句主会话的话' },
  { seq: 22, sec: 22, kind: 'result', ok: true, text: '收场摘要' },
];

describe('readRunProcessRows', () => {
  it('取切步要的列：调用号、子代理编号、没有退出码、增删行都从 meta 里取；文本按种类截短；不是 uuid 返回空', async () => {
    const id = await newRun();
    await appendRunTranscript(
      t.db,
      id,
      toRows([...MIXED, { seq: 23, sec: 23, kind: 'assistant', text: 'x'.repeat(900) }]),
    );
    const rows = await readRunProcessRows(t.db, id);
    expect(rows).toHaveLength(MIXED.length + 1);
    const by = (seq: number) => rows.find((r) => r.seq === seq);
    expect(by(2)).toMatchObject({
      kind: 'tool_call',
      tool: 'Bash',
      text: 'ok-cmd',
      callId: 'c1',
      sub: false,
    });
    expect(by(3)).toMatchObject({ kind: 'tool_result', ok: true, callId: 'c1', text: '' });
    expect(by(7)).not.toHaveProperty('callId');
    expect(by(10)).toMatchObject({ callId: 'c4', exitKnown: false });
    expect(by(14)).toMatchObject({ added: 3, removed: 1 });
    expect(by(16)).not.toHaveProperty('added');
    expect(by(19)).toMatchObject({ sub: true, subOf: 'agent-1' });
    expect(by(20)).toMatchObject({ sub: true });
    expect(by(23)?.text).toHaveLength(400);
    expect(rows.every((r) => r.at.endsWith('Z'))).toBe(true);
    expect(await readRunProcessRows(t.db, 'run-1')).toEqual([]);
    expect(await readRunProcessRows(t.db, randomUUID())).toEqual([]);
  });
});

describe('readRunTallies：单次批量轻量读取，和 cutSteps 同一个口径', () => {
  it('库读取失败原样抛错，不把不可用变成没有记录或零', async () => {
    const select = vi.spyOn(t.db, 'select').mockImplementationOnce(() => {
      throw Error('read unavailable');
    });
    try {
      await expect(readRunTallies(t.db, [randomUUID()])).rejects.toThrow('read unavailable');
    } finally {
      select.mockRestore();
    }
  });
  it('历史笔失败/编辑事实保留，旧命令不与失败双计；空ID、重复、孤立、并行倒序和缺结果逐项与步骤守恒', async () => {
    const cases: Row[][] = [
      [
        { seq: 0, sec: 0, kind: 'tool_call', tool: 'Bash', text: 'legacy' },
        { seq: 1, sec: 1, kind: 'tool_result', tool: 'Bash', ok: false, text: 'failed' },
        { seq: 2, sec: 2, kind: 'tool_call', tool: 'Edit', text: 'unknown-path.ts' },
        { seq: 3, sec: 3, kind: 'tool_result', tool: 'Edit', ok: true, text: 'done' },
      ],
      [
        { seq: 0, sec: 0, kind: 'tool_call', tool: 'Bash', text: 'empty', meta: { callId: '' } },
        {
          seq: 1,
          sec: 1,
          kind: 'tool_result',
          tool: 'Bash',
          ok: false,
          text: 'failed',
          meta: { callId: '' },
        },
        {
          seq: 2,
          sec: 2,
          kind: 'tool_result',
          tool: 'Edit',
          ok: true,
          text: 'orphan',
          meta: { callId: 'orphan', added: 2 },
        },
        {
          seq: 3,
          sec: 3,
          kind: 'tool_result',
          tool: 'Edit',
          ok: true,
          text: 'duplicate',
          meta: { callId: 'orphan', added: 2 },
        },
      ],
      [
        { seq: 0, sec: 0, kind: 'tool_call', tool: 'Bash', text: 'first', meta: { callId: 'a' } },
        { seq: 1, sec: 1, kind: 'tool_call', tool: 'Bash', text: 'duplicate', meta: { callId: 'a' } },
        { seq: 2, sec: 2, kind: 'tool_call', tool: 'Bash', text: 'second', meta: { callId: 'b' } },
        { seq: 3, sec: 3, kind: 'tool_result', tool: 'Bash', ok: true, text: 'b', meta: { callId: 'b' } },
        { seq: 4, sec: 4, kind: 'tool_result', tool: 'Bash', ok: false, text: 'a', meta: { callId: 'a' } },
        {
          seq: 5,
          sec: 5,
          kind: 'tool_result',
          tool: 'Bash',
          ok: true,
          text: 'duplicate a',
          meta: { callId: 'a' },
        },
      ],
      [
        { seq: 0, sec: 0, kind: 'tool_call', tool: 'Bash', text: 'unknown exit', meta: { callId: 'm' } },
        {
          seq: 1,
          sec: 1,
          kind: 'tool_result',
          tool: 'Bash',
          ok: true,
          text: 'done',
          meta: { callId: 'm', exitKnown: false },
        },
        { seq: 2, sec: 2, kind: 'tool_call', tool: 'Bash', text: 'pending', meta: { callId: 'pending' } },
        { seq: 3, sec: 3, kind: 'tool_call', tool: 'Edit', text: '', meta: { callId: 'blank-path' } },
        {
          seq: 4,
          sec: 4,
          kind: 'tool_result',
          tool: 'Edit',
          ok: true,
          text: '',
          meta: { callId: 'blank-path' },
        },
      ],
    ];
    const ids: string[] = [];
    for (const rows of cases) {
      const id = await newRun();
      ids.push(id);
      await appendRunTranscript(t.db, id, toRows(rows));
    }
    const tallies = await readRunTallies(t.db, ids);
    for (const id of ids) {
      const raw = tallies.get(id);
      expect(raw).toBeDefined();
      if (!raw) throw Error('missing tally');
      for (const running of [false, true]) {
        const tally = tallyOf(raw, running);
        const cut = cutSteps(await readRunProcessRows(t.db, id), { running });
        const { files: _files, ...counts } = cut.counts;
        expect(tally).toMatchObject(counts);
        expect(tally.commands).toBe(
          tally.commandsDone + tally.commandsFailed + tally.commandsUnknown + tally.commandsRunning,
        );
      }
    }
    expect(tallies.get(ids[0] as string)).toMatchObject({
      commands: 1,
      commandsFailed: 0,
      commandsLegacy: 1,
      callsFailed: 1,
      editsUncounted: 1,
    });
    expect(tallies.get(ids[1] as string)).toMatchObject({
      commandsFailed: 0,
      commandsLegacy: 1,
      callsFailed: 1,
      added: 2,
    });
    expect(tallies.get(ids[2] as string)).toMatchObject({ commands: 2, commandsFailed: 1, callsFailed: 1 });
    expect(tallies.get(ids[3] as string)).toMatchObject({
      commandsExitUnknown: 1,
      commandsNoResult: 1,
      editsUncounted: 1,
    });
  });

  it('每一类互不重叠：成败、没结果、没调用号、没退出码、读文件、改文件的行数；和 cutSteps 对同一份记录算出同一个数', async () => {
    const id = await newRun();
    await appendRunTranscript(t.db, id, toRows(MIXED));
    const tallies = await readRunTallies(t.db, [id]);
    const row = tallies.get(id);
    expect(row).toMatchObject({
      entries: MIXED.length,
      calls: 10,
      commands: 5,
      commandsFailed: 1,
      commandsExitUnknown: 1,
      commandsNoResult: 1,
      commandsLegacy: 1,
      reads: 1,
      callsFailed: 2,
      editsOk: 2,
      editsUncounted: 1,
      added: 3,
      removed: 1,
    });
    expect(row?.firstAt).toBe(at(0).toISOString());
    expect(row?.lastAt).toBe(at(22).toISOString());
    if (!row) return;
    // 收场了：没结果的算结果未知；两套算法对同一份记录的数一致
    const ended = tallyOf(row, false);
    const cut = cutSteps(await readRunProcessRows(t.db, id), { running: false });
    expect(ended).toMatchObject({
      commands: cut.counts.commands,
      commandsDone: cut.counts.commandsDone,
      commandsFailed: cut.counts.commandsFailed,
      commandsUnknown: cut.counts.commandsUnknown,
      commandsRunning: cut.counts.commandsRunning,
      reads: cut.counts.reads,
      callsFailed: cut.counts.callsFailed,
      added: cut.counts.added,
      removed: cut.counts.removed,
      uncounted: cut.counts.uncounted,
    });
    expect(ended).toMatchObject({ commandsDone: 1, commandsUnknown: 3 });
    // 还在跑：没结果的那条是「在跑」
    const live = tallyOf(row, true);
    const liveCut = cutSteps(await readRunProcessRows(t.db, id), { running: true });
    expect(live.commandsRunning).toBe(liveCut.counts.commandsRunning);
    expect(live).toMatchObject({ commandsRunning: 1, commandsUnknown: 2 });
  });

  it('几笔一起读；没有记录的笔不出现（页面写没记录，不写 0）；不是 uuid 的忽略；一个都不给返回空', async () => {
    const a = await newRun();
    const b = await newRun();
    const empty = await newRun();
    await appendRunTranscript(t.db, a, toRows(MIXED.slice(0, 4)));
    await appendRunTranscript(t.db, b, toRows([{ seq: 0, sec: 0, kind: 'assistant', text: '只说话没调用' }]));
    const got = await readRunTallies(t.db, [a, b, empty, 'run-1']);
    expect([...got.keys()].sort()).toEqual([a, b].sort());
    expect(got.get(a)).toMatchObject({ calls: 1, commands: 1, commandsFailed: 0 });
    expect(got.get(b)).toMatchObject({ entries: 1, calls: 0, commands: 0, added: 0 });
    expect((await readRunTallies(t.db, [])).size).toBe(0);
  });
});

describe('readRunLastSay', () => {
  it('最后一条主会话助手的话：不取子代理的、不取 result；一条都没有返回 null', async () => {
    const id = await newRun();
    expect(await readRunLastSay(t.db, id)).toBeNull();
    await appendRunTranscript(t.db, id, toRows(MIXED));
    expect(await readRunLastSay(t.db, id)).toMatchObject({ text: '最后一句主会话的话' });
    const only = await newRun();
    await appendRunTranscript(
      t.db,
      only,
      toRows([
        { seq: 0, sec: 0, kind: 'assistant', text: '子代理说', meta: { subagent: true } },
        { seq: 1, sec: 1, kind: 'result', text: '收场', ok: true },
        { seq: 2, sec: 2, kind: 'assistant', text: '   ' },
      ]),
    );
    expect(await readRunLastSay(t.db, only)).toBeNull();
    expect(await readRunLastSay(t.db, 'run-1')).toBeNull();
  });
});

describe('listTaskRounds', () => {
  it('按 seq 排；开始时刻、返工摘要老行没有就不给键', async () => {
    const base = { taskId, workflowId: 'wf', round: 1 };
    await recordTaskRound(t.db, { ...base, seq: 2, outcome: 'merged', tier: 'fast', addedLines: 12 });
    await recordTaskRound(t.db, {
      ...base,
      seq: 1,
      outcome: 'ci_red',
      startedAt: ago(20 * MIN),
      reworkSummary: '检查红了',
      endedAt: ago(10 * MIN),
    });
    const rounds = await listTaskRounds(t.db, taskId);
    expect(rounds.map((r) => [r.seq, r.outcome])).toEqual([
      [1, 'ci_red'],
      [2, 'merged'],
    ]);
    expect(rounds[0]).toMatchObject({ reworkSummary: '检查红了' });
    expect(rounds[0]?.startedAt?.getTime()).toBe(ago(20 * MIN).getTime());
    expect(rounds[1]).toMatchObject({ tier: 'fast', addedLines: 12 });
    expect(rounds[1]).not.toHaveProperty('startedAt');
    expect(rounds[1]).not.toHaveProperty('reworkSummary');
    expect(await listTaskRounds(t.db, randomUUID())).toEqual([]);
    expect(await listTaskRounds(t.db, 'task-1')).toEqual([]);
  });
});

describe('listTaskEngineSteps', () => {
  const act = (activity: string, startSec: number, over: Record<string, unknown> = {}) => ({
    kind: 'activity' as const,
    workflowId: 'wf',
    temporalRunId: 'r',
    workflowType: 'taskWorkflow',
    taskId,
    activity,
    attempt: 1,
    scheduledAt: at(startSec - 1),
    startedAt: at(startSec),
    endedAt: at(startSec + 2),
    queueMs: 0,
    runMs: 2000,
    outcome: 'ok' as const,
    ...over,
  });

  it('只列要写出来的活动和等待（内部记账的不列）；别的单的不混进来；按开始时间从早到晚', async () => {
    const other = (await addTask(t.db, (await addRepo(t.db, 'other-repo')).id)).id;
    await t.db.insert(stepTimings).values([
      act('waitCi', 30, { outcome: 'failed', errorCode: 'CI_RED' }),
      act('selfCheck', 10),
      act('saveTaskState', 12),
      act('recordRound', 13),
      act('pushBranch', 20, { taskId: other }),
      {
        kind: 'wait',
        workflowId: 'wf',
        temporalRunId: 'r',
        workflowType: 'taskWorkflow',
        taskId,
        waitFor: 'quota',
        detail: '等额度',
        startedAt: at(15),
        endedAt: at(25),
        waitMs: 10_000,
      },
    ]);
    const rows = await listTaskEngineSteps(t.db, taskId);
    expect(rows.map((r) => (r.kind === 'activity' ? r.activity : `等${r.waitFor}`))).toEqual([
      'selfCheck',
      '等quota',
      'waitCi',
    ]);
    expect(rows[2]).toMatchObject({ outcome: 'failed', errorCode: 'CI_RED', runMs: 2000 });
    expect(rows[1]).toMatchObject({ waitMs: 10_000, detail: '等额度' });
    expect(ENGINE_STEP_ACTIVITIES).toContain('coldVerify');
  });

  it('太多只留最近的 ENGINE_STEPS_MAX 条，仍按从早到晚', async () => {
    await t.db
      .insert(stepTimings)
      .values(Array.from({ length: ENGINE_STEPS_MAX + 5 }, (_, i) => act('selfCheck', i * 10)));
    const rows = await listTaskEngineSteps(t.db, taskId);
    expect(rows).toHaveLength(ENGINE_STEPS_MAX);
    expect(rows[0]?.startedAt.getTime()).toBe(at(5 * 10).getTime());
    expect(rows.at(-1)?.startedAt.getTime()).toBe(at((ENGINE_STEPS_MAX + 4) * 10).getTime());
  });
});
