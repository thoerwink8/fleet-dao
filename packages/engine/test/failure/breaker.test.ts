// 路由熔断：开、半开、关；按真实流量算，探针绿盖不住真实流量红；断流等不算路由的账不进分母。
import { describe, expect, it } from 'vitest';
import { jitterOf, type RouteOutcome, routeBreaker, whenAllOpen } from '../../src/failure/index.ts';

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

describe('关着（正常派）', () => {
  it('没有结果、偶尔失败：照常派', () => {
    expect(routeBreaker([], { now: at(0) })).toMatchObject({ state: 'closed', admit: 'all', trips: 0 });
    const s = routeBreaker([fail(1), fail(2), ok(3), fail(4), fail(5)], { now: at(6) });
    expect({ state: s.state, streak: s.consecutiveFailures }).toEqual({ state: 'closed', streak: 2 });
    expect(s.window).toEqual({ samples: 5, failures: 4, failureRate: 0.8 });
  });

  it('断流、我们自己停的、账号池的事（neutral）不进分母，也不打断连败', () => {
    const many = Array.from({ length: 20 }, (_, i) => neutral(i));
    expect(routeBreaker([...many, fail(21), fail(22)], { now: at(23) }).state).toBe('closed');
    expect(routeBreaker([fail(1), neutral(2), fail(3), neutral(4), fail(5)], { now: at(6) }).state).toBe(
      'open',
    );
  });

  it('还没发生的结果（时刻在现在之后）不算', () => {
    expect(routeBreaker([fail(1), fail(2), fail(30)], { now: at(10) }).state).toBe('closed');
  });

  it('记录读坏了：报错，不把读不出的记录当成「没有失败」', () => {
    expect(() => routeBreaker([fail(1)], { now: 'bad' })).toThrow('现在的时刻认不出（bad）');
    expect(() => routeBreaker([fail(1), { at: '昨天', result: 'fail' }, fail(3)], { now: at(4) })).toThrow(
      '第 2 条结果的时刻认不出（昨天）',
    );
    const garbled = { at: at(2), result: 'boom' } as unknown as RouteOutcome;
    expect(() => routeBreaker([fail(1), garbled], { now: at(4) })).toThrow('第 2 条结果认不出（boom）');
  });
});

describe('打开（熔断）', () => {
  it('真实流量连续失败 3 次：熔断 10 分钟，到点前一个都不派', () => {
    const s = routeBreaker([ok(0), fail(1), fail(2), fail(3)], { now: at(5) });
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
    expect(routeBreaker(RATE_SEQ.slice(0, 9), { now: at(9.5) }).state).toBe('closed');
    const s = routeBreaker(RATE_SEQ, { now: at(11) });
    expect(s.state).toBe('open');
    expect(s.reason).toContain('6 小时内真实流量 10 次、失败 6 次（60%）');
    // 样本不够 8 次不按比率判。
    expect(routeBreaker([fail(1), ok(2), fail(3), ok(4), fail(5)], { now: at(6) }).state).toBe('closed');
  });

  it('探针绿盖不住真实流量红（windsurf-dao#1342）：探针的成功不清零连败，也不稀释失败率', () => {
    expect(routeBreaker([fail(1), fail(2), ok(2.5, 'probe'), fail(3)], { now: at(4) }).state).toBe('open');
    const probes = Array.from({ length: 50 }, (_, i) => ok(i * 0.2, 'probe'));
    expect(routeBreaker([...probes, ...RATE_SEQ], { now: at(11) }).state).toBe('open');
  });

  it('只有探针在跑、探针连着失败：一样熔断（不只算真实流量，也不只算探针）', () => {
    expect(routeBreaker([fail(1, 'probe'), fail(2, 'probe'), fail(3, 'probe')], { now: at(4) }).state).toBe(
      'open',
    );
  });

  it('冷却期间才结束的（开闸前就派出去的）不算试探', () => {
    const s = routeBreaker([fail(1), fail(2), fail(3), ok(5), ok(6)], { now: at(8) });
    expect(s.state).toBe('open');
  });
});

describe('半开（放一个试探）', () => {
  it('冷却到点：半开，只放一个试探', () => {
    const s = routeBreaker([fail(1), fail(2), fail(3)], { now: at(13) });
    expect(s).toMatchObject({ state: 'half_open', admit: 'trial', probeAt: at(13) });
    expect(s.reason).toContain('冷却到点');
  });

  it('试探成功：关上，熔断次数清零；恢复前的失败不再算', () => {
    const seq = [fail(1), fail(2), fail(3), ok(14)];
    const s = routeBreaker(seq, { now: at(15) });
    expect(s).toMatchObject({ state: 'closed', admit: 'all', trips: 0 });
    expect(s.reason).toContain('真实流量试探成功');
    expect(s.window.samples).toBe(0);
    // 恢复后再失败一次，不会因为恢复前的两次连成三连败。
    expect(routeBreaker([...seq, fail(16)], { now: at(17) }).state).toBe('closed');
  });

  it('探针试探成功也能关上', () => {
    expect(routeBreaker([fail(1), fail(2), fail(3), ok(14, 'probe')], { now: at(15) }).state).toBe('closed');
  });

  it('试探失败：再开，冷却翻倍（10 → 20 → 40 分钟），封顶 120 分钟', () => {
    const again = routeBreaker([fail(1), fail(2), fail(3), fail(14)], { now: at(15) });
    expect(again).toMatchObject({ state: 'open', trips: 2, probeAt: at(34) });
    expect(again.reason).toContain('试探又失败');
    const third = routeBreaker([fail(1), fail(2), fail(3), fail(14), fail(35)], { now: at(36) });
    expect(third).toMatchObject({ trips: 3, probeAt: at(75) });
    const outcomes = [fail(1), fail(2), fail(3)];
    let t = 3;
    for (const cooldown of [10, 20, 40, 80, 120, 120]) {
      t += cooldown;
      outcomes.push(fail(t));
    }
    const capped = routeBreaker(outcomes, { now: at(t + 1) });
    expect(capped.probeAt).toBe(at(t + 120));
  });
});

describe('解冻错开、全红', () => {
  it('同一批一起熔断的路由，解冻时刻按路由编号确定性地错开 ±10%', () => {
    const seq = [fail(1), fail(2), fail(3)];
    const probe = (routeId: string) => routeBreaker(seq, { now: at(4), routeId }).probeAt;
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
    const early = routeBreaker([fail(1), fail(2), fail(3)], { now: at(7) });
    const late = routeBreaker([fail(4), fail(5), fail(6)], { now: at(7) });
    expect([early.state, early.probeAt, late.state, late.probeAt]).toEqual(['open', at(13), 'open', at(16)]);
    const all = whenAllOpen([
      { routeId: 'late', breaker: late },
      { routeId: 'early', breaker: early },
    ]);
    expect(all).toMatchObject({ allOpen: true, trialRouteId: 'early' });
    const closed = routeBreaker([], { now: at(7) });
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
