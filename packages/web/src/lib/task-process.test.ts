// 任务页概览和过程的说法与排法（#3140）。
import { describe, expect, test } from 'vitest';
import type { ProcessStep, TaskOverview } from '../api/types';
import type { SegmentRunView } from './segments';
import {
  barWeights,
  buildTimeline,
  callVerb,
  causeLabel,
  fileParts,
  PR_STATE,
  roundDurationMs,
  roundOutcome,
  runDurationMs,
  sessionLink,
  stepDurationMs,
  waitLabel,
} from './task-process';

const step = (over: Partial<ProcessStep>): ProcessStep => ({
  index: 0,
  title: 't',
  titleFromCall: false,
  firstSeq: 0,
  lastSeq: 1,
  startedAt: '2026-10-18T08:00:00.000Z',
  running: false,
  failed: false,
  calls: 0,
  subCalls: 0,
  commands: 0,
  commandsFailed: 0,
  commandsUnknown: 0,
  commandsRunning: 0,
  reads: 0,
  callsFailed: 0,
  files: [],
  added: 0,
  removed: 0,
  uncounted: 0,
  ...over,
});

const iso = (min: number) => new Date(Date.parse('2026-10-18T08:00:00.000Z') + min * 60_000).toISOString();

const run = (id: string, over: Partial<SegmentRunView> = {}): SegmentRunView =>
  ({
    id,
    segment: 'manual',
    model: 'opus-5.5',
    modelName: 'Opus 5.5',
    running: false,
    matchedBy: 'task',
    unread: [],
    ...over,
  }) as SegmentRunView;

describe('动词', () => {
  test('完成：已运行 / 已读取 / 已编辑 / 创建 / 已搜索；Agent 不加动词前缀靠调用文本自己说', () => {
    expect(callVerb('Bash', 'ok')).toBe('已运行');
    expect(callVerb('Read', 'ok')).toBe('已读取');
    expect(callVerb('Edit', 'ok')).toBe('已编辑');
    expect(callVerb('MultiEdit', 'ok')).toBe('已编辑');
    expect(callVerb('Write', 'ok')).toBe('创建');
    expect(callVerb('Grep', 'ok')).toBe('已搜索');
    expect(callVerb('mcp__x__y', 'ok')).toBe('已调用 mcp__x__y');
  });
  test('没成写失败、还没结果写进行时', () => {
    expect(callVerb('Bash', 'failed')).toBe('运行失败');
    expect(callVerb('Edit', 'failed')).toBe('编辑失败');
    expect(callVerb('Bash', 'pending')).toBe('正在运行');
    expect(callVerb('Read', 'pending')).toBe('正在读取');
  });
});

describe('文件路径', () => {
  test('拆目录和文件名', () => {
    expect(fileParts('packages/web/src/a.tsx')).toEqual({ dir: 'packages/web/src/', base: 'a.tsx' });
    expect(fileParts('README.md')).toEqual({ dir: '', base: 'README.md' });
  });
});

describe('PR 状态', () => {
  test('五种都有字和状态色；没读到的不冒充开着', () => {
    expect(PR_STATE.merged).toMatchObject({ label: '已合并', tone: 'done' });
    expect(PR_STATE.failed.tone).toBe('fail');
    expect(PR_STATE.unknown.label).toBe('没读到状态');
  });
});

describe('时间条', () => {
  test('宽度按用时比例；太短的给下限', () => {
    const w = barWeights([540_000, 1_000]);
    expect(w[0]).toBe(540_000);
    expect(w[1]).toBeGreaterThan(1_000); // 下限抬上去
  });
  test('全是 0：每段等宽，不除以 0', () => {
    expect(barWeights([0, 0])).toEqual([1, 1]);
  });
  test('stepDurationMs：结束了用算好的，在跑的用现在减开始', () => {
    expect(stepDurationMs(step({ durationMs: 5 }), 99)).toBe(5);
    expect(stepDurationMs(step({ running: true }), Date.parse('2026-10-18T08:00:30.000Z'))).toBe(30_000);
  });
});

describe('为什么起、新会话还是接上', () => {
  test('动手的笔：记了写白话；老记录没记写「老记录没记起因」，不拿「主写」顶', () => {
    expect(causeLabel({ segment: 'manual', cause: 'rework_ci' })).toEqual({
      text: 'CI 红了返工',
      recorded: true,
    });
    expect(causeLabel({ segment: 'manual', cause: undefined })).toEqual({
      text: '老记录没记起因',
      recorded: false,
    });
  });
  test('对题、验收本来就不记起因：不写，也不写成「老记录没记」', () => {
    expect(causeLabel({ segment: 'verify', cause: undefined })).toBeUndefined();
    expect(causeLabel({ segment: 'scope', cause: undefined })).toBeUndefined();
  });
  test('接上一笔 / 新会话；都没记不替它猜', () => {
    expect(sessionLink({ resumed: true })).toBe('接上一笔的会话');
    expect(sessionLink({ resumed: false })).toBe('新会话');
    expect(sessionLink({ resumed: undefined })).toBeUndefined();
  });
});

describe('回合和结局的说法', () => {
  test('认得的写白话，认不出的原样写、状态色用 doubt', () => {
    expect(roundOutcome('verify_rejected')).toEqual({ label: '验收没过', tone: 'fail' });
    expect(roundOutcome('merged')).toEqual({ label: '做成了', tone: 'done' });
    expect(roundOutcome('brand_new')).toEqual({ label: 'brand_new', tone: 'doubt' });
  });
  test('等什么', () => {
    expect(waitLabel('memory')).toBe('内存');
    expect(waitLabel('weird')).toBe('weird');
  });
});

type Rounds = Extract<TaskOverview['rounds'], { state: 'ok' }>['items'];
type Engine = Extract<TaskOverview['engineSteps'], { state: 'ok' }>['items'];
const ov = (rounds: Rounds, engine: Engine) => ({
  rounds: { state: 'ok' as const, items: rounds },
  engineSteps: { state: 'ok' as const, items: engine },
});

describe('buildTimeline：回合 → 笔 → 引擎做的事', () => {
  const rounds: Rounds = [
    {
      seq: 1,
      round: 1,
      outcome: 'ci_red',
      startedAt: iso(0),
      endedAt: iso(30),
      reworkSummary: 'CI 红了：字段名对不上',
    },
    { seq: 2, round: 2, outcome: 'merged', startedAt: iso(31), endedAt: iso(60) },
  ];
  const engine: Engine = [
    {
      kind: 'activity',
      activity: 'selfCheck',
      attempt: 1,
      startedAt: iso(20),
      endedAt: iso(22),
      runMs: 120_000,
      outcome: 'ok',
    },
    { kind: 'wait', waitFor: 'memory', startedAt: iso(31), endedAt: iso(31.5), waitMs: 30_000 },
    { kind: 'wait', waitFor: 'memory', startedAt: iso(31.5), endedAt: iso(32), waitMs: 30_000 },
    { kind: 'wait', waitFor: 'quota', startedAt: iso(32), endedAt: iso(33), waitMs: 60_000 },
    {
      kind: 'activity',
      activity: 'waitCi',
      attempt: 1,
      startedAt: iso(50),
      endedAt: iso(55),
      runMs: 300_000,
      outcome: 'ok',
    },
  ];
  const runs = [
    run('a', { roundSeq: 1, startedAt: iso(1), cause: 'main' }),
    run('b', { roundSeq: 2, startedAt: iso(34), cause: 'rework_ci', resumed: true }),
  ];

  test('笔按回合号归组；返工回合顶上带上一回合的返工意见；做成的回合没有', () => {
    const t = buildTimeline(runs, ov(rounds, engine));
    expect(t.map((g) => g.seq)).toEqual([1, 2]);
    expect(t[0]?.reworkOf).toBeUndefined();
    expect(t[1]?.reworkOf).toEqual({ outcome: 'ci_red', summary: 'CI 红了：字段名对不上', seq: 1 });
  });

  test('引擎做的事按开始时刻落进它所在的回合，和笔按时间排在一起', () => {
    const t = buildTimeline(runs, ov(rounds, engine));
    expect(t[0]?.items.map((i) => i.kind)).toEqual(['run', 'engine']);
    expect(t[1]?.items.map((i) => i.kind)).toEqual(['waits', 'waits', 'run', 'engine']);
  });

  test('连着的同一种等待折成一行（次数、总时长）；换了一种就另起一行', () => {
    const t = buildTimeline(runs, ov(rounds, engine));
    const waits = t[1]?.items.filter((i) => i.kind === 'waits') ?? [];
    expect(waits).toHaveLength(2);
    expect(waits[0]).toMatchObject({ kind: 'waits', waitFor: 'memory', count: 2, totalMs: 60_000 });
    expect(waits[1]).toMatchObject({ waitFor: 'quota', count: 1, totalMs: 60_000 });
  });

  test('落在两个回合之间空档的：等待归后面那个回合（在等着开它的笔），别的活动归前面那个', () => {
    const gap = buildTimeline(runs, {
      rounds: { state: 'ok', items: rounds },
      engineSteps: {
        state: 'ok',
        items: [
          { kind: 'wait', waitFor: 'memory', startedAt: iso(30.5), endedAt: iso(30.9), waitMs: 24_000 },
          {
            kind: 'activity',
            activity: 'removeWorktree',
            attempt: 1,
            startedAt: iso(30.6),
            endedAt: iso(30.7),
            runMs: 6000,
            outcome: 'ok',
          },
        ],
      },
    });
    expect(gap[0]?.items.map((i) => i.kind)).toEqual(['run', 'engine']);
    expect(gap[1]?.items.map((i) => i.kind)).toEqual(['waits', 'run']);
  });

  test('没记回合的笔（老记录）单列一组放最前，不猜它是哪一回合', () => {
    const t = buildTimeline([run('old', { startedAt: iso(-100) }), ...runs], ov(rounds, engine));
    expect(t.map((g) => g.seq)).toEqual([undefined, 1, 2]);
    expect(t[0]?.items.map((i) => (i.kind === 'run' ? i.run.id : i.kind))).toEqual(['old']);
  });

  test('回合还没收场（库里没有它的记录）：group.round 是 undefined，用时没有', () => {
    const t = buildTimeline(
      [run('c', { roundSeq: 3, startedAt: iso(70), running: true })],
      ov(rounds, engine),
    );
    const g = t.find((x) => x.seq === 3);
    expect(g?.round).toBeUndefined();
    expect(g && roundDurationMs(g)).toBeUndefined();
  });

  test('回合读不到（unavailable）：不分回合，全放「没记回合」那一组，引擎的事也不放', () => {
    const t = buildTimeline(runs, {
      rounds: { state: 'unavailable', reason: 'x' },
      engineSteps: { state: 'unavailable', reason: 'y' },
    });
    expect(t).toHaveLength(2);
    expect(t.map((g) => g.seq)).toEqual([1, 2]); // 笔上自己记着回合号，照它归
    expect(t.flatMap((g) => g.items).every((i) => i.kind === 'run')).toBe(true);
  });

  test('回合的用时：收场时刻 − 开始时刻；老行没有开始时刻退回第一笔的起跑', () => {
    const t = buildTimeline(runs, ov(rounds, engine));
    expect(t[0] && roundDurationMs(t[0])).toBe(30 * 60_000);
    const old = buildTimeline(
      [run('a', { roundSeq: 1, startedAt: iso(5) })],
      ov([{ seq: 1, round: 1, outcome: 'merged', endedAt: iso(15) }], []),
    );
    expect(old[0] && roundDurationMs(old[0])).toBe(10 * 60_000);
  });
});

describe('一笔的用时', () => {
  test('收场的用算好的；在跑的用现在减开始；起止都没读到的没有', () => {
    expect(runDurationMs(run('a', { durationMs: 5000 }), 0)).toBe(5000);
    expect(runDurationMs(run('b', { running: true, startedAt: iso(0) }), Date.parse(iso(2)))).toBe(120_000);
    expect(runDurationMs(run('c'), 0)).toBeUndefined();
  });
});
