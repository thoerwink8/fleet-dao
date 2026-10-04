// 主页三段流水线图的推法（home-flow.ts）：单子在哪一段、谁在做、最近事件、每段平均耗时。
// 推不出的路径都故意造一次：没有流水、段名认不出、结局没记、没有样本——看它给 null / 不给，而不是猜成失败或 0。
import { describe, expect, it } from 'vitest';
import { flowStages, laneOf, taskFlow } from '../src/home-flow.ts';
import { readSegmentRun, type SegmentRunFacts, type SegmentRunView } from '../src/segment-runs.ts';

const T0 = Date.parse('2026-10-05T01:00:00.000Z');
const at = (minutes: number) => new Date(T0 + minutes * 60_000).toISOString();

function view(over: Partial<SegmentRunFacts>, taskFinished = false): SegmentRunView {
  return readSegmentRun(
    {
      id: `r-${Math.random()}`,
      segment: 'manual',
      model: 'opus-5.5',
      modelName: 'Opus 5.5',
      matchedBy: 'task',
      startedAt: at(0),
      ...over,
    },
    { taskFinished },
  );
}

describe('taskFlow：现在在哪一段', () => {
  it('在跑的一笔：就在那一段，有人在做，本段从开跑起算', () => {
    const f = taskFlow({ state: 'running' }, [view({ segment: 'verify', startedAt: at(3) })]);
    expect(f).toMatchObject({
      segment: 'verifying',
      stageSince: at(3),
      worker: 'Opus 5.5',
      lastEvent: { text: '验收开跑 · Opus 5.5', tone: 'ok' },
    });
  });

  it('done 之后往后一段：对题收了 → 动手；动手收了 → 还没验；验收收了 → 合并；都没有人在做', () => {
    const done = (segment: SegmentRunFacts['segment']) =>
      taskFlow({ state: 'running' }, [view({ segment, startedAt: at(0), endedAt: at(5), outcome: 'done' })]);
    expect(done('scope')).toMatchObject({ segment: 'doing', stageSince: at(5) });
    expect(done('manual')).toMatchObject({ segment: 'verify_pending', stageSince: at(5) });
    expect(done('verify')).toMatchObject({ segment: 'merge', stageSince: at(5) });
    expect(done('manual').worker).toBeUndefined();
  });

  it('没收好（超时、失败、没起来）：还在那一段，事件是 trouble 并带原因；切号、内存满、被停掉是 wait', () => {
    const f = (outcome: SegmentRunFacts['outcome'], failureReason?: string) =>
      taskFlow({ state: 'running' }, [
        view({ segment: 'manual', endedAt: at(9), outcome, ...(failureReason ? { failureReason } : {}) }),
      ]);
    expect(f('timeout', '30 分钟没交活')).toMatchObject({
      segment: 'doing',
      lastEvent: { text: '动手超时：30 分钟没交活', tone: 'trouble' },
    });
    expect(f('spawn_failed').lastEvent?.tone).toBe('trouble');
    expect(f('failed').lastEvent?.tone).toBe('trouble');
    for (const o of ['org_switch', 'admission_blocked', 'killed'] as const) {
      expect(f(o).lastEvent?.tone).toBe('wait');
      expect(f(o).segment).toBe('doing');
    }
  });

  it('取最近一笔（按起跑先后），中间夹着段名认不出的不算数', () => {
    const f = taskFlow({ state: 'running' }, [
      view({ segment: 'scope', startedAt: at(0), endedAt: at(5), outcome: 'done' }),
      view({ segment: 'fusion-execute', startedAt: at(6), endedAt: at(8), outcome: 'done' }),
    ]);
    expect(f.segment).toBe('doing');
  });

  it('单子自己在合并中：不管最近一笔是什么都归合并', () => {
    expect(taskFlow({ state: 'merging' }, [view({ segment: 'manual' })]).segment).toBe('merge');
    expect(taskFlow({ state: 'merging' }, []).segment).toBe('merge');
  });

  it('一笔流水都没有：排队 / 分诊中是还没开始对题；其余推不出，是 null，不猜', () => {
    expect(taskFlow({ state: 'queued' }, []).segment).toBe('scoping');
    expect(taskFlow({ state: 'triaging' }, []).segment).toBe('scoping');
    expect(taskFlow({ state: 'running' }, [])).toEqual({ segment: null });
    // 只有认不出的笔，也等于没有
    expect(taskFlow({ state: 'planning' }, [view({ segment: 'fusion-execute' })])).toEqual({ segment: null });
  });

  it('结局没记：事件照实写「收场时没记结局」，不当成完成也不当成失败', () => {
    const f = taskFlow({ state: 'running' }, [view({ segment: 'manual', endedAt: at(4) })]);
    expect(f.lastEvent).toMatchObject({ text: '动手收场时没记结局', tone: 'wait' });
  });
});

describe('flowStages：图头三格', () => {
  it('固定三项、按在途数泳道；平均只算 done 且起止读得出来的；没有样本不给平均', () => {
    const runs = [
      view({ segment: 'scope', startedAt: at(0), endedAt: at(10), outcome: 'done' }),
      view({ segment: 'scope', startedAt: at(0), endedAt: at(20), outcome: 'done' }),
      view({ segment: 'manual', startedAt: at(0), endedAt: at(30), outcome: 'timeout' }),
      // 起止同一刻是写入时刻占位，不是真耗时：不进样本
      view({ segment: 'verify', startedAt: at(0), endedAt: at(0), outcome: 'done' }),
    ];
    const stages = flowStages(runs, [
      { segment: 'doing' },
      { segment: 'verify_pending' },
      { segment: 'merge' },
      { segment: null },
    ]);
    expect(stages).toEqual([
      { segment: 'scope', inFlight: 0, avgMs: 15 * 60_000, samples: 2 },
      { segment: 'manual', inFlight: 1, samples: 0 },
      { segment: 'verify', inFlight: 2, samples: 0 },
    ]);
  });

  it('laneOf：验收泳道收 verifying / verify_pending / merge；null 不属于任何一段', () => {
    expect((['scoping', 'doing', 'verifying', 'verify_pending', 'merge', null] as const).map(laneOf)).toEqual(
      ['scope', 'manual', 'verify', 'verify', 'verify', null],
    );
  });
});
