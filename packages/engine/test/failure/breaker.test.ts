// 路由熔断：开、半开、关；按真实流量算，探针绿盖不住真实流量红；断流等不算路由的账不进分母。
import { describe, expect, it } from 'vitest';
import {
  type BreakerPolicy,
  jitterOf,
  type RouteOutcome,
  routeBreaker,
  whenAllOpen,
} from '../../src/failure/index.ts';

const T0 = Date.parse('2026-09-25T00:00:00.000Z');
const at = (minutes: number) => new Date(T0 + minutes * 60_000).toISOString();
const fail = (minutes: number, source: RouteOutcome['source'] = 'traffic'): RouteOutcome => ({
  at: at(minutes),
  result: 'fail',
  source,
});
const ok = (minutes: number, source: RouteOutcome['source'] = 'traffic'): RouteOutcome => ({
  at: at(minutes),
  result: 'ok',
  source,
});
const neutral = (minutes: number): RouteOutcome => ({ at: at(minutes), result: 'neutral' });
/** 现在是第几分钟、这条路由在途几个。 */
const judge = (
  outcomes: RouteOutcome[],
  nowMinutes: number,
  more: { inFlight?: number; routeId?: string; policy?: Partial<BreakerPolicy> } = {},
) => routeBreaker(outcomes, { now: at(nowMinutes), inFlight: 0, ...more });

describe('关着（正常派）', () => {
  it('没有结果、偶尔失败：照常派', () => {
    expect(judge([], 0)).toMatchObject({ state: 'closed', admit: 'all', trips: 0 });
    const s = judge([fail(1), fail(2), ok(3), fail(4), fail(5)], 6);
    expect({ state: s.state, streak: s.consecutiveFailures }).toEqual({ state: 'closed', streak: 2 });
    expect(s.window).toEqual({ samples: 5, failures: 4, failureRate: 0.8 });
  });

  it('断流、我们自己停的、账号池的事（neutral）不进分母，也不打断连败', () => {
    const many = Array.from({ length: 20 }, (_, i) => neutral(i));
    expect(judge([...many, fail(21), fail(22)], 23).state).toBe('closed');
    expect(judge([fail(1), neutral(2), fail(3), neutral(4), fail(5)], 6).state).toBe('open');
  });

  it('还没发生的结果（时刻在现在之后）不算', () => {
    expect(judge([fail(1), fail(2), fail(30)], 10).state).toBe('closed');
  });

  it('记录读坏了：报错，不把读不出的记录当成「没有失败」', () => {
    expect(() => routeBreaker([fail(1)], { now: 'bad', inFlight: 0 })).toThrow('现在的时刻认不出（bad）');
    expect(() => judge([fail(1), { at: '昨天', result: 'fail' }, fail(3)], 4)).toThrow(
      '第 2 条结果的时刻认不出（昨天）',
    );
    const garbled = { at: at(2), result: 'boom' } as unknown as RouteOutcome;
    expect(() => judge([fail(1), garbled], 4)).toThrow('第 2 条结果认不出（boom）');
    expect(() => judge([], 4, { inFlight: -1 })).toThrow('在途数认不出（-1）');
    expect(() => judge([], 4, { inFlight: Number.NaN })).toThrow('在途数认不出');
  });
});

describe('打开（熔断）', () => {
  it('真实流量连续失败 3 次：熔断 10 分钟，到点前一个都不派', () => {
    const s = judge([ok(0), fail(1), fail(2), fail(3)], 5);
    expect(s).toMatchObject({
      state: 'open',
      admit: 'none',
      trips: 1,
      openedAt: at(3),
      probeAt: at(13),
    });
    expect(s.reason).toBe('连续失败 3 次：熔断，2026-09-25 00:13 UTC 再放一个试探');
  });

  // 最多两连败；前 9 次失败率一直在 60% 以下，第 10 次正好到线。
  const RATE_SEQ = [ok(1), fail(2), ok(3), fail(4), fail(5), ok(6), fail(7), ok(8), fail(9), fail(10)];

  it('按失败率：6 小时内 10 次真实流量失败 6 次，没连着三次也熔断', () => {
    expect(judge(RATE_SEQ.slice(0, 9), 9.5).state).toBe('closed');
    const s = judge(RATE_SEQ, 11);
    expect(s.state).toBe('open');
    expect(s.reason).toContain('6 小时内真实流量 10 次、失败 6 次（60%）');
    // 样本不够 8 次不按比率判。
    expect(judge([fail(1), ok(2), fail(3), ok(4), fail(5)], 6).state).toBe('closed');
  });

  it('探针绿盖不住真实流量红（windsurf-dao#1342）：探针的成功不清零连败，也不稀释失败率', () => {
    expect(judge([fail(1), fail(2), ok(2.5, 'probe'), fail(3)], 4).state).toBe('open');
    const probes = Array.from({ length: 50 }, (_, i) => ok(i * 0.2, 'probe'));
    expect(judge([...probes, ...RATE_SEQ], 11).state).toBe('open');
  });

  it('只有探针在跑、探针连着失败：一样熔断（不只算真实流量，也不只算探针）', () => {
    expect(judge([fail(1, 'probe'), fail(2, 'probe'), fail(3, 'probe')], 4).state).toBe('open');
  });

  it('冷却期间才结束的（开闸前就派出去的）不算试探', () => {
    expect(judge([fail(1), fail(2), fail(3), ok(5), ok(6)], 8).state).toBe('open');
  });
});

describe('半开（放一个试探）', () => {
  it('冷却到点：半开，放一个真实流量去试探；已经有一个在途就不再放', () => {
    const s = judge([fail(1), fail(2), fail(3)], 13);
    expect(s).toMatchObject({ state: 'half_open', admit: 'trial', probeAt: at(13) });
    expect(s.reason).toContain('放一个真实流量去试探');
    const busy = judge([fail(1), fail(2), fail(3)], 13, { inFlight: 1 });
    expect({ state: busy.state, admit: busy.admit }).toEqual({ state: 'half_open', admit: 'none' });
    expect(busy.reason).toContain('已经有 1 个在途当试探');
  });

  it('真实流量试探成功：关上，熔断次数清零；恢复前的失败不再算', () => {
    const seq = [fail(1), fail(2), fail(3), ok(14)];
    const s = judge(seq, 15);
    expect(s).toMatchObject({ state: 'closed', admit: 'all', trips: 0 });
    expect(s.reason).toContain('真实流量试探成功');
    expect(s.window.samples).toBe(0);
    // 恢复后再失败一次，不会因为恢复前的两次连成三连败。
    expect(judge([...seq, fail(16)], 17).state).toBe('closed');
  });

  it('探针试探成功不算恢复：还是半开，熔断次数不清零', () => {
    const s = judge([fail(1), fail(2), fail(3), ok(14, 'probe')], 15);
    expect(s).toMatchObject({ state: 'half_open', admit: 'trial', trips: 1 });
  });

  it('真实流量一直失败、探针一直绿（windsurf-dao#1342 重现）：冷却一次次翻倍，始终不回到关闭', () => {
    const outcomes: RouteOutcome[] = [fail(1), fail(2), fail(3)];
    const probes: RouteOutcome[] = [];
    let t = 3;
    const cooldowns = [10, 20, 40, 80, 120];
    for (const cooldown of cooldowns) {
      // 冷却期间探针一直绿；到点后探针先绿一次，真实流量的试探又失败。
      for (let p = 1; p < cooldown; p += 3) probes.push(ok(t + p, 'probe'));
      probes.push(ok(t + cooldown, 'probe'));
      t += cooldown;
      outcomes.push(fail(t + 0.5));
      t += 0.5;
    }
    const all = [...outcomes, ...probes];
    const realFailures = outcomes.filter((o) => o.source !== 'probe' && o.result === 'fail').length;
    expect(realFailures).toBe(8);
    const s = judge(all, t + 1);
    expect(s).toMatchObject({ state: 'open', trips: 6 });
    // 第 6 次熔断：10 × 2^5 = 320，封顶 120 分钟。
    expect(s.probeAt).toBe(at(t + 120));
    // 每一刻都不曾关上：在各次冷却中途看，都是开着的，而且冷却在翻倍。
    const probeAts = [5, 16, 37, 80, 165].map((minute) => judge(all, minute).probeAt);
    expect(probeAts).toEqual([at(13), at(33.5), at(74), at(154.5), at(275)]);
  });

  it('试探失败：再开，冷却翻倍（10 → 20 → 40 分钟），封顶 120 分钟', () => {
    const again = judge([fail(1), fail(2), fail(3), fail(14)], 15);
    expect(again).toMatchObject({ state: 'open', trips: 2, probeAt: at(34) });
    expect(again.reason).toContain('试探又失败');
    const third = judge([fail(1), fail(2), fail(3), fail(14), fail(35)], 36);
    expect(third).toMatchObject({ trips: 3, probeAt: at(75) });
    const outcomes = [fail(1), fail(2), fail(3)];
    let t = 3;
    for (const cooldown of [10, 20, 40, 80, 120, 120]) {
      t += cooldown;
      outcomes.push(fail(t));
    }
    expect(judge(outcomes, t + 1).probeAt).toBe(at(t + 120));
  });
});

describe('策略参数', () => {
  it('给了但不对的报错，不悄悄换成默认值', () => {
    const bad: [Partial<BreakerPolicy>, string][] = [
      [{ consecutiveFailures: 0 }, '熔断策略的 consecutiveFailures 不对：要不小于 1 的整数，给的是 0'],
      [{ minSamples: 2.5 }, 'minSamples 不对：要不小于 1 的整数，给的是 2.5'],
      [{ failureRate: 0 }, 'failureRate 不对：要在 0 到 1 之间（不含 0），给的是 0'],
      [{ jitterRatio: 1 }, 'jitterRatio 不对：要在 0 到 1 之间（不含 1），给的是 1'],
      [{ cooldownMinutes: -5 }, 'cooldownMinutes 不对：要大于 0 的数，给的是 -5'],
      [
        { cooldownMinutes: 30, maxCooldownMinutes: 20 },
        'maxCooldownMinutes（20）不能小于 cooldownMinutes（30）',
      ],
    ];
    for (const [policy, message] of bad) expect(() => judge([], 1, { policy })).toThrow(message);
    expect(judge([], 1, { policy: { consecutiveFailures: 1 } }).state).toBe('closed');
  });
});

describe('解冻错开、全红', () => {
  it('同一批一起熔断的路由，解冻时刻按路由编号确定性地错开 ±10%', () => {
    const seq = [fail(1), fail(2), fail(3)];
    const probe = (routeId: string) => judge(seq, 4, { routeId }).probeAt;
    expect(probe('route-a')).toBe(probe('route-a'));
    const times = ['route-a', 'route-b', 'route-c', 'route-d'].map((id) => Date.parse(probe(id) ?? ''));
    expect(new Set(times).size).toBe(4);
    for (const time of times) {
      expect(time).toBeGreaterThanOrEqual(Date.parse(at(3 + 9)));
      expect(time).toBeLessThanOrEqual(Date.parse(at(3 + 11)));
    }
    expect(jitterOf(undefined, 0.1)).toBe(0);
    for (const id of ['x', 'route-1', '很长的路由编号'.repeat(5)]) {
      expect(Math.abs(jitterOf(id, 0.1))).toBeLessThanOrEqual(0.1);
    }
  });

  it('候选路由全都熔断：判共用的一层坏了，不剔空候选，放最早到点的一条试探', () => {
    const early = judge([fail(1), fail(2), fail(3)], 7);
    const late = judge([fail(4), fail(5), fail(6)], 7);
    expect([early.state, early.probeAt, late.state, late.probeAt]).toEqual(['open', at(13), 'open', at(16)]);
    const all = whenAllOpen([
      { routeId: 'late', breaker: late },
      { routeId: 'early', breaker: early },
    ]);
    expect(all).toMatchObject({ allOpen: true, trialRouteId: 'early' });
    const closed = judge([], 7);
    expect(
      whenAllOpen([
        { routeId: 'a', breaker: early },
        { routeId: 'b', breaker: closed },
      ]),
    ).toEqual({
      allOpen: false,
    });
    // 只有一条候选时看不出是不是共用层的事。
    expect(whenAllOpen([{ routeId: 'a', breaker: early }])).toEqual({ allOpen: false });
  });
});
