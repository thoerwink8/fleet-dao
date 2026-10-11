// 渠道状态条带（#1139）：本渠道所有路由的探测按时间收成近 60 格。超过的丢掉最旧的。
// 均耗时、可用率只算留下的格子：没探的不进可用率，没量到的耗时不当 0。
import { describe, expect, it } from 'vitest';
import { PROBE_HISTORY_SLOTS, type ProbeHistoryCell, probeHistoryStrips } from '../src/probe-history.ts';

const T0 = Date.parse('2026-10-07T00:00:00.000Z');
const at = (n: number) => new Date(T0 + n * 60_000).toISOString();

function cell(over: Partial<ProbeHistoryCell> & Pick<ProbeHistoryCell, 'id' | 'routeId'>): ProbeHistoryCell {
  return {
    channelId: 'ch',
    probedAt: at(over.id),
    result: 'passed',
    durationMs: 1000,
    failureReason: null,
    requestText: '只回 pong',
    responseText: 'pong',
    checkQuestion: null,
    checkExpected: null,
    checkAnswer: null,
    checkPassed: null,
    selfIdentity: null,
    kind: null,
    ...over,
  };
}

describe('探针历史条带', () => {
  it('一个渠道的几条路由按时间排成一条，旧的在前；通过、不通、没探各留各的', () => {
    const shaped = probeHistoryStrips([
      cell({
        id: 3,
        routeId: 'b',
        probedAt: at(3),
        result: 'not_probed',
        durationMs: null,
        failureReason: '按量计费，不自动探',
        requestText: null,
        responseText: null,
      }),
      cell({ id: 1, routeId: 'a', probedAt: at(1), result: 'passed', durationMs: 1000 }),
      cell({
        id: 2,
        routeId: 'b',
        probedAt: at(2),
        result: 'failed',
        durationMs: 3000,
        failureReason: '连不上',
        responseText: '超时',
      }),
    ]);
    expect(shaped.channels).toHaveLength(1);
    const strip = shaped.channels[0];
    // 色条只放真探的；没探的另放 skipped（#1748）
    expect(strip?.cells.map((c) => c.id)).toEqual([1, 2]);
    expect(strip?.cells.map((c) => c.result)).toEqual(['passed', 'failed']);
    expect(strip?.cells.map((c) => c.routeId)).toEqual(['a', 'b']);
    expect(strip?.skipped.map((c) => c.id)).toEqual([3]);
    // 没探的不进分母：2 次真探，通过 1 次。耗时只平均量到的（1000 和 3000），第三条的空不当 0。
    expect(strip).toMatchObject({ passed: 1, attempted: 2, avgDurationMs: 2000 });
    expect(shaped.latestByRoute.map((c) => [c.routeId, c.id])).toEqual([
      ['a', 1],
      ['b', 3],
    ]);
  });

  it('超过 60 次只留最近的；被挤出去的那条路由，点它仍能看到它自己的最近一次', () => {
    const rows: ProbeHistoryCell[] = [];
    for (let i = 1; i <= PROBE_HISTORY_SLOTS + 1; i++) {
      rows.push(cell({ id: i, routeId: 'busy', probedAt: at(i), durationMs: i * 1000 }));
    }
    // 另一条路由只有更早的一次：不在这 60 格里，但点那一行要看得到。
    rows.push(
      cell({
        id: 1000,
        routeId: 'quiet',
        probedAt: at(0),
        result: 'failed',
        durationMs: null,
        failureReason: '早先断过',
        responseText: null,
      }),
    );
    const shaped = probeHistoryStrips(rows);
    const strip = shaped.channels[0];
    expect(strip?.cells).toHaveLength(PROBE_HISTORY_SLOTS);
    expect(strip?.cells[0]?.durationMs).toBe(2_000);
    expect(strip?.cells.at(-1)?.durationMs).toBe((PROBE_HISTORY_SLOTS + 1) * 1000);
    expect(strip?.cells.some((c) => c.routeId === 'quiet')).toBe(false);
    expect(strip).toMatchObject({ passed: PROBE_HISTORY_SLOTS, attempted: PROBE_HISTORY_SLOTS });
    const quiet = shaped.latestByRoute.find((c) => c.routeId === 'quiet');
    expect(quiet).toMatchObject({ id: 1000, result: 'failed', failureReason: '早先断过' });
    const busy = shaped.latestByRoute.find((c) => c.routeId === 'busy');
    expect(busy?.id).toBe(PROBE_HISTORY_SLOTS + 1);
  });

  it('同一时刻后写入的（id 大）算更新；全是没探则可用率没有分母，耗时全空则平均是空', () => {
    const same = at(5);
    const shaped = probeHistoryStrips([
      cell({
        id: 2,
        routeId: 'a',
        probedAt: same,
        result: 'not_probed',
        durationMs: null,
        failureReason: '不探',
        requestText: null,
        responseText: null,
      }),
      cell({
        id: 1,
        routeId: 'a',
        probedAt: same,
        result: 'not_probed',
        durationMs: null,
        failureReason: '更早写入的不探',
        requestText: null,
        responseText: null,
      }),
    ]);
    expect(shaped.channels[0]?.cells).toEqual([]);
    expect(shaped.channels[0]?.skipped.map((c) => c.id)).toEqual([1, 2]);
    expect(shaped.channels[0]).toMatchObject({ passed: 0, attempted: 0, avgDurationMs: null });
    expect(shaped.latestByRoute[0]?.id).toBe(2);
  });

  it('#1748：最近 60 条全是没探时，真探的那几次仍在色条里，可用率只按真探算', () => {
    const rows: ProbeHistoryCell[] = [
      cell({ id: 1, routeId: 'a', probedAt: at(1), durationMs: 2000 }),
      cell({
        id: 2,
        routeId: 'a',
        probedAt: at(2),
        result: 'failed',
        durationMs: 4000,
        failureReason: '疑似降智',
      }),
    ];
    for (let i = 0; i < PROBE_HISTORY_SLOTS + 5; i++) {
      rows.push(
        cell({
          id: 100 + i,
          routeId: 'a',
          probedAt: at(10 + i),
          result: 'not_probed',
          durationMs: null,
          failureReason: '不主动探，要派给它时先探一次。还没真探过',
          requestText: null,
          responseText: null,
        }),
      );
    }
    const strip = probeHistoryStrips(rows).channels[0];
    expect(strip?.cells.map((c) => c.id)).toEqual([1, 2]);
    expect(strip).toMatchObject({ passed: 1, attempted: 2, avgDurationMs: 3000 });
    expect(strip?.skipped).toHaveLength(PROBE_HISTORY_SLOTS);
    expect(strip?.skipped.every((c) => c.result === 'not_probed')).toBe(true);
  });

  it('没有行：两个数组都空，不造格子', () => {
    expect(probeHistoryStrips([])).toEqual({ channels: [], latestByRoute: [] });
  });

  it('两个渠道分开算，互不把对方的次数算进自己的 60', () => {
    const rows = [
      cell({ id: 1, routeId: 'a', channelId: 'left', durationMs: 4000 }),
      cell({
        id: 2,
        routeId: 'b',
        channelId: 'right',
        result: 'failed',
        durationMs: null,
        failureReason: '断了',
      }),
    ];
    const shaped = probeHistoryStrips(rows);
    expect(shaped.channels.map((c) => c.channelId)).toEqual(['left', 'right']);
    expect(shaped.channels[0]).toMatchObject({ passed: 1, attempted: 1, avgDurationMs: 4000 });
    expect(shaped.channels[1]).toMatchObject({ passed: 0, attempted: 1, avgDurationMs: null });
  });
});
