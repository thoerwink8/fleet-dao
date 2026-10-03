// 三段的一笔怎么读（#216）：认得出的照给，读不到的逐样点名、带原因。每条「没读到」的路径都故意造一次——段名认不出、
// 起止缺一头、token 没记到、花费没记到、派工档没记——看它写明为什么，而不是给 0、给空、或当在跑。
import { describe, expect, it } from 'vitest';
import { readSegmentRun, type SegmentRunFacts } from '../src/segment-runs.ts';
import { SegmentRunSchema } from '../src/web-api.ts';

const T0 = Date.parse('2026-10-03T01:00:00.000Z');
const at = (minutes: number) => new Date(T0 + minutes * 60_000).toISOString();
const live = { taskFinished: false };
const finished = { taskFinished: true };

/** 一笔全读到的动手：主力档、跑了 12 分钟、四样 token 和花费都有。 */
function run(over: Partial<SegmentRunFacts> = {}): SegmentRunFacts {
  return {
    id: 'r-1',
    segment: 'manual',
    model: 'opus-5.5',
    modelName: 'Opus 5.5',
    channel: 'ch-claude',
    billing: 'subscription',
    tier: 'heavyweight',
    startedAt: at(0),
    endedAt: at(12),
    outcome: 'done',
    inputTokens: 1000,
    outputTokens: 500,
    cacheReadTokens: 30_000,
    cacheWriteTokens: 2000,
    costUsd: 0.25,
    prNumber: 39,
    branch: 'fleet/13-readme',
    matchedBy: 'task',
    ...over,
  };
}

/** 可以不给的那几样（读不到就不给）。 */
type OptionalKey = {
  [K in keyof SegmentRunFacts]-?: undefined extends SegmentRunFacts[K] ? K : never;
}[keyof SegmentRunFacts];

function without(r: SegmentRunFacts, ...keys: OptionalKey[]): SegmentRunFacts {
  const copy = { ...r };
  for (const k of keys) delete copy[k];
  return copy;
}

/** 读出来的结果必须过得了接口契约：后端按它 parse 返回，过不了就是 500。 */
function read(facts: SegmentRunFacts, ctx = live) {
  const view = readSegmentRun(facts, ctx);
  expect(SegmentRunSchema.parse(view)).toEqual(view);
  return view;
}

const reasonOf = (view: ReturnType<typeof read>, item: string) =>
  view.unread.find((n) => n.item === item)?.reason;

describe('全读到的一笔', () => {
  it('照数给：段、派工档、起止、耗时、四样 token、花费、PR；没有一条没读到', () => {
    const v = read(run());
    expect(v).toMatchObject({
      segment: 'manual',
      tier: 'heavyweight',
      running: false,
      outcome: 'done',
      startedAt: at(0),
      endedAt: at(12),
      durationMs: 12 * 60_000,
      inputTokens: 1000,
      cacheWriteTokens: 2000,
      costUsd: 0.25,
      prNumber: 39,
      matchedBy: 'task',
    });
    expect(v.unread).toEqual([]);
  });

  it('对题、验收没有派工档是对的（只有动手段分档）：不记没读到', () => {
    for (const segment of ['scope', 'verify']) {
      expect(read(without(run({ segment }), 'tier')).unread).toEqual([]);
    }
  });

  it('单子还在跑、这一段没结束：算在跑，用量等它结束才有，不算没读到', () => {
    const v = read(without(run(), 'endedAt', 'outcome', 'inputTokens', 'outputTokens', 'costUsd'));
    expect(v.running).toBe(true);
    expect(v.durationMs).toBeUndefined();
    expect(v.unread).toEqual([]);
  });
});

describe('【失败】段名认不出', () => {
  it('不在 scope / manual / verify 里：段给 null，原样写进原因，不猜成哪一段', () => {
    const v = read(run({ segment: 'fusion-execute' }));
    expect(v.segment).toBeNull();
    expect(reasonOf(v, 'segment')).toContain('fusion-execute');
  });
});

describe('【失败】起止缺一头', () => {
  it('单子已经结束、这一段没记结束时刻：不当在跑，耗时没读到并写明原因', () => {
    const v = read(without(run(), 'endedAt', 'outcome'), finished);
    expect(v.running).toBe(false);
    expect(v.durationMs).toBeUndefined();
    expect(reasonOf(v, 'time')).toContain('没记结束时刻');
    expect(reasonOf(v, 'outcome')).toBe('结束了却没记结局');
  });

  it('有结局却没记结束时刻：耗时没读到', () => {
    const v = read(without(run({ outcome: 'timeout' }), 'endedAt'));
    expect(v.running).toBe(false);
    expect(v.outcome).toBe('timeout');
    expect(reasonOf(v, 'time')).toBe('有结局（timeout）却没记结束时刻');
  });

  it('没记开始时刻：耗时没读到（在跑的也一样，算不出跑了多久）', () => {
    expect(reasonOf(read(without(run(), 'startedAt')), 'time')).toBe('没记开始时刻');
    const running = read(without(run(), 'startedAt', 'endedAt', 'outcome'));
    expect(running.running).toBe(true);
    expect(reasonOf(running, 'time')).toBe('没记开始时刻');
  });

  it('时刻认不出：不往页面上塞那串字，原样写进原因', () => {
    const v = read(run({ startedAt: '昨天下午', endedAt: 'not-a-time' }));
    expect(v.startedAt).toBeUndefined();
    expect(v.endedAt).toBeUndefined();
    expect(v.durationMs).toBeUndefined();
    expect(reasonOf(v, 'time')).toBe('开始时刻「昨天下午」认不出；结束时刻「not-a-time」认不出');
  });

  it('结束早于开始：起止是倒着的，耗时没读到（不给负数、不给 0）', () => {
    const v = read(run({ startedAt: at(12), endedAt: at(0) }));
    expect(v.durationMs).toBeUndefined();
    expect(reasonOf(v, 'time')).toContain('倒着');
  });

  it('完成的一段起止同一刻：是写入时刻占位，不显示成 0 秒', () => {
    const v = read(run({ startedAt: at(5), endedAt: at(5) }));
    expect(v.durationMs).toBeUndefined();
    expect(reasonOf(v, 'time')).toContain('占位');
  });

  it('进程没起来的一段起止同一刻是真的（它没干过活）：耗时照给 0', () => {
    const v = read(run({ outcome: 'admission_blocked', startedAt: at(5), endedAt: at(5) }));
    expect(v.durationMs).toBe(0);
    expect(reasonOf(v, 'time')).toBeUndefined();
  });
});

describe('【失败】token、花费没记到', () => {
  it('缺几样就点名几样，读到的照给', () => {
    const v = read(without(run(), 'cacheReadTokens', 'cacheWriteTokens'));
    expect(v.inputTokens).toBe(1000);
    expect(v.cacheReadTokens).toBeUndefined();
    expect(reasonOf(v, 'tokens')).toBe('没记到：缓存读、缓存写');
  });

  it('四样全没记到：一句话说完', () => {
    const v = read(without(run(), 'inputTokens', 'outputTokens', 'cacheReadTokens', 'cacheWriteTokens'));
    expect(reasonOf(v, 'tokens')).toBe('四样 token 都没记到');
  });

  it('认不出的数（负数、小数）不当成读到：原样写进原因', () => {
    const v = read(run({ inputTokens: -5, outputTokens: 1.5 }));
    expect(v.inputTokens).toBeUndefined();
    expect(v.outputTokens).toBeUndefined();
    expect(reasonOf(v, 'tokens')).toBe('认不出：输入（-5）、输出（1.5）');
  });

  it('花费没记到、认不出：各写各的原因，不给 $0', () => {
    expect(reasonOf(read(without(run(), 'costUsd')), 'cost')).toBe('花费没记到');
    const bad = read(run({ costUsd: Number.NaN }));
    expect(bad.costUsd).toBeUndefined();
    expect(reasonOf(bad, 'cost')).toBe('花费「NaN」认不出');
  });

  it('进程没起来的一段：说清是没起来，不是漏记', () => {
    const v = read(
      without(
        run({ outcome: 'spawn_failed' }),
        'inputTokens',
        'outputTokens',
        'cacheReadTokens',
        'cacheWriteTokens',
        'costUsd',
      ),
    );
    expect(reasonOf(v, 'tokens')).toBe('进程没起来，没有用量读数');
    expect(reasonOf(v, 'cost')).toBe('进程没起来，没有花费读数');
  });
});

describe('【失败】派工档、结局认不出或没记', () => {
  it('动手段没记派工档：写明没记，不猜成哪一档', () => {
    expect(reasonOf(read(without(run(), 'tier')), 'tier')).toBe('动手段没记派工档');
  });

  it('派工档写了 tier.ts 之外的字：认不出，不给', () => {
    const v = read(run({ tier: '主力' }));
    expect(v.tier).toBeUndefined();
    expect(reasonOf(v, 'tier')).toBe('派工档「主力」认不出');
  });

  it('结局认不出：不给，写明原样', () => {
    const v = read(run({ outcome: 'ok' }));
    expect(v.outcome).toBeUndefined();
    expect(reasonOf(v, 'outcome')).toBe('结局「ok」认不出');
  });
});
