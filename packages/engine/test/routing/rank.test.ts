// 排序与微调：按人排的顺序；钉住的不动；按消耗进度前后挪（总开关关掉时快清零提前）、战绩差后置、额度未知排后。
import { describe, expect, it } from 'vitest';
import {
  DEFAULT_ROUTING_POLICY,
  fastResetHit,
  poorRecord,
  type RouteFacts,
  resolveRoutingPolicy,
} from '../../src/routing/index.ts';
import { rank } from '../../src/routing/rank.ts';
import { at, entry, NOW, route, win } from './helpers.ts';

const P = { ...DEFAULT_ROUTING_POLICY };
/** 按进度排的总开关关掉：回到「快清零往前提」的老排法。 */
const OFF = { ...DEFAULT_ROUTING_POLICY, pace: { ...DEFAULT_ROUTING_POLICY.pace, enabled: false } };
const T = Date.parse(NOW);

function rows(routes: RouteFacts[], pinned: string[] = []) {
  return routes.map((r, i) => ({
    route: r,
    entry: entry(r.routeId, i, { pinned: pinned.includes(r.routeId) }),
  }));
}

function order(routes: RouteFacts[], pinned: string[] = [], stagePinned = false, policy = P): string[] {
  return rank(rows(routes, pinned), stagePinned, policy, T).map((x) => x.route.routeId);
}

const offOrder = (routes: RouteFacts[]) => order(routes, [], false, OFF);

/** 周窗离清零 (1 - elapsed) × 7 天、已用 used；5 小时窗用得很少。 */
const weekPace = (id: string, elapsed: number, used: number, extra: Partial<RouteFacts> = {}) =>
  route(id, {
    windows: [
      win({ label: '5h', window: '5h', used: 0.1, resetsAt: at(2) }),
      win({ label: 'credits:weekly', used, resetsAt: at((1 - elapsed) * 168) }),
    ],
    ...extra,
  });

/** Cursor 的桶：标签推不出窗口长度，按 30 天估；离清零 (1 - elapsed) × 30 天。 */
const cursorBucket = (id: string, elapsed: number, used: number, extra: Partial<RouteFacts> = {}) =>
  route(id, {
    poolName: `池${id}`,
    windows: [
      win({
        label: 'auto_percent',
        window: 'other',
        scope: 'auto',
        used,
        resetsAt: at((1 - elapsed) * 720),
      }),
    ],
    ...extra,
  });

describe('① 按消耗进度排同一模型的几个渠道（#2363）', () => {
  it('A 周窗已用 75%、过了 62%（超前），B 桶已用 13%、过了 98%（快作废）：B 排在 A 前面，理由写明两组数', () => {
    const a = weekPace('a', 0.62, 0.75);
    const b = cursorBucket('b', 0.98, 0.13);
    const ranked = rank(rows([a, b]), false, P, T);
    expect(ranked.map((x) => x.route.routeId)).toEqual(['b', 'a']);
    const textOf = (id: string) =>
      ranked
        .find((x) => x.route.routeId === id)
        ?.nudges.map((n) => n.text)
        .join('；') ?? '';
    expect(ranked[0]?.nudges.map((n) => n.kind)).toContain('pace-behind');
    expect(textOf('b')).toContain('按时间该用 98%、实际用了 13%');
    expect(textOf('b')).toContain('按 30 天算');
    expect(ranked[1]?.nudges.map((n) => n.kind)).toContain('pace-ahead');
    expect(textOf('a')).toContain('按时间该用 62%、实际用了 75%');
    expect(textOf('a')).toContain('往后放');
  });

  it('总开关关掉：回到老排法，桶不是周窗 / 月窗，不提，A 周窗不往后放', () => {
    expect(offOrder([weekPace('a', 0.62, 0.75), cursorBucket('b', 0.98, 0.13)])).toEqual(['a', 'b']);
  });

  it('超前 10% 以上的往后放；差不到 10% 的照人排', () => {
    expect(order([weekPace('a', 0.5, 0.65), route('b')])).toEqual(['b', 'a']);
    expect(order([weekPace('a', 0.5, 0.55), route('b')])).toEqual(['a', 'b']);
    expect(order([route('a'), weekPace('b', 0.5, 0.45)])).toEqual(['a', 'b']);
  });

  it('落后 10% 以上的都往前提，越早清零越前', () => {
    // b 落后 30%、两天多清零；c 落后 20%、一天多清零：c 在前
    expect(order([route('a'), weekPace('b', 0.6, 0.3), weekPace('c', 0.8, 0.6)])).toEqual(['c', 'b', 'a']);
  });

  it('Mirasim 30 天窗已用 66%、过了 19%：超前，排到照人排的后面', () => {
    const m = route('m', {
      windows: [win({ label: '30d', window: 'other', used: 0.66, resetsAt: at(0.81 * 720) })],
    });
    expect(order([m, route('b')])).toEqual(['b', 'm']);
  });

  it('5 小时窗只挡不排：5 小时窗超前不往后放，落后也不往前提', () => {
    const fiveOnly = (id: string, used: number) =>
      route(id, { windows: [win({ label: '5h', window: '5h', used, resetsAt: at(0.5) })] });
    expect(order([fiveOnly('a', 0.95), route('b')])).toEqual(['a', 'b']);
    expect(order([route('a'), fiveOnly('b', 0.1)])).toEqual(['a', 'b']);
  });

  it('5 小时窗快满的池不因周窗落后被顶到最前', () => {
    const r = route('b', {
      windows: [
        win({ label: '5h', window: '5h', used: 0.9, resetsAt: at(2) }),
        win({ used: 0.3, resetsAt: at(20) }),
      ],
    });
    expect(order([route('a'), r])).toEqual(['a', 'b']);
  });

  it('一个窗口超前、另一个落后：往后放（照这个速度清零前会用完）', () => {
    const r = route('a', {
      windows: [
        win({ used: 0.9, resetsAt: at(84) }),
        win({ label: 'plan_usd', window: 'month_usd', used: 0.1, resetsAt: at(24) }),
      ],
    });
    expect(order([r, route('b')])).toEqual(['b', 'a']);
  });

  it('额度未知照旧排在读到了的后面，哪怕超前的', () => {
    expect(order([route('a', { quota: 'unknown' }), weekPace('b', 0.5, 0.8)])).toEqual(['b', 'a']);
  });

  it('上游这次没报、读数过期的窗口不参与按进度排', () => {
    const r = cursorBucket('b', 0.98, 0.13);
    const stale = { ...r, windows: r.windows.map((w) => ({ ...w, staleSince: at(-1) })) };
    expect(order([route('a'), stale])).toEqual(['a', 'b']);
  });

  it('钉住的不按进度挪', () => {
    expect(order([weekPace('a', 0.5, 0.8), route('b')], ['a'])).toEqual(['a', 'b']);
  });

  it('policy.pace 认不出报错', () => {
    expect(() => resolveRoutingPolicy({ pace: { enabled: true, margin: 0 } })).toThrow(/pace\.margin/);
    expect(() =>
      resolveRoutingPolicy({ pace: { enabled: 'yes' as unknown as boolean, margin: 0.1 } }),
    ).toThrow(/pace\.enabled/);
  });
});

/** 周窗 h 小时后清零、已用 used 的路由。 */
const weekly = (id: string, hours: number, used: number, extra: Partial<RouteFacts> = {}) =>
  route(id, {
    windows: [
      win({ label: '5h', window: '5h', used: 0.1, resetsAt: at(2) }),
      win({ used, resetsAt: at(hours) }),
    ],
    ...extra,
  });

describe('按人排的顺序取', () => {
  it('没有任何微调时顺序不变', () => {
    expect(order([route('a'), route('b'), route('c')])).toEqual(['a', 'b', 'c']);
  });
});

describe('总开关关掉时的老排法：快清零还没用完的往前提', () => {
  it('周窗 20 小时后清零、还剩 70%：提到最前', () => {
    expect(offOrder([route('a'), weekly('b', 20, 0.3)])).toEqual(['b', 'a']);
  });

  it('周窗 30 小时后才清零：不提（不够「快」）', () => {
    expect(offOrder([route('a'), weekly('b', 30, 0.3)])).toEqual(['a', 'b']);
  });

  it('快清零但只剩 20%：不提（剩得不多，自然会用完）', () => {
    expect(offOrder([route('a'), weekly('b', 20, 0.8)])).toEqual(['a', 'b']);
  });

  it('不会把快用满的池顶到最前：周窗快清零、剩很多，但 5 小时窗已用 90%', () => {
    const almostFull = route('b', {
      windows: [
        win({ label: '5h', window: '5h', used: 0.9, resetsAt: at(2) }),
        win({ used: 0.3, resetsAt: at(20) }),
      ],
    });
    expect(fastResetHit(almostFull, P, T)).toBeNull();
    expect(offOrder([route('a'), almostFull])).toEqual(['a', 'b']);
  });

  it('其余窗口有一个没读成（算不出已用）也不提', () => {
    const r = route('b', {
      windows: [
        win({ label: '5h', window: '5h', used: null, resetsAt: at(2) }),
        win({ used: 0.3, resetsAt: at(20) }),
      ],
    });
    expect(fastResetHit(r, P, T)).toBeNull();
  });

  it('额度没读成的池不提（哪怕窗口看着快清零）', () => {
    expect(fastResetHit(weekly('b', 20, 0.3, { quota: 'unknown' }), P, T)).toBeNull();
  });

  it('只看周窗和按月窗：5 小时窗快清零不提', () => {
    const r = route('b', { windows: [win({ label: '5h', window: '5h', used: 0.1, resetsAt: at(0.5) })] });
    expect(fastResetHit(r, P, T)).toBeNull();
  });

  it('月账期 40 小时后结束、还剩 50%：提', () => {
    const r = route('b', {
      windows: [win({ label: 'cursor', window: 'month_usd', used: 0.5, resetsAt: at(40) })],
    });
    expect(fastResetHit(r, P, T)?.window.label).toBe('cursor');
  });

  it('两条都快清零：清零早的在前', () => {
    expect(offOrder([route('a'), weekly('b', 20, 0.3), weekly('c', 5, 0.3)])).toEqual(['c', 'b', 'a']);
  });

  it('读数是估算的照样提，理由里写「估算」', () => {
    const r = route('b', {
      windows: [
        win({ label: '5h', window: '5h', used: 0.1 }),
        win({ used: 0.3, resetsAt: at(20), reading: 'estimated' }),
      ],
    });
    const rows = [route('a'), r].map((x, i) => ({ route: x, entry: entry(x.routeId, i) }));
    const b = rank(rows, false, OFF, T)[0];
    expect(b?.nudges.map((n) => n.text).join()).toContain('估算');
  });
});

describe('② 战绩明显差的往后放，样本少不动', () => {
  it('10 次成 3 次：往后放', () => {
    const bad = route('a', { record: { samples: 10, successes: 3 } });
    expect(poorRecord(bad, P)).toBe(true);
    expect(order([bad, route('b')])).toEqual(['b', 'a']);
  });

  it('9 次成 0 次：样本少，不动', () => {
    const few = route('a', { record: { samples: 9, successes: 0 } });
    expect(poorRecord(few, P)).toBe(false);
    expect(order([few, route('b')])).toEqual(['a', 'b']);
  });

  it('10 次成 5 次：不算明显差', () => {
    expect(order([route('a', { record: { samples: 10, successes: 5 } }), route('b')])).toEqual(['a', 'b']);
  });

  it('从没跑过（没有战绩）：不动', () => {
    expect(order([route('a', { record: null }), route('b')])).toEqual(['a', 'b']);
  });
});

describe('③ 额度未知的排在读到了的后面', () => {
  it('人排第一但额度没读成：挪到读到了的后面', () => {
    expect(order([route('a', { quota: 'unknown' }), route('b'), route('c')])).toEqual(['b', 'c', 'a']);
  });

  it('几条额度未知的之间保持人排的顺序', () => {
    const u = (id: string) => route(id, { quota: 'unknown' });
    expect(order([u('a'), u('b'), route('c')])).toEqual(['c', 'a', 'b']);
  });
});

describe('拼车号、独享号不分主备（#59 删掉了「备池排在主池后面」）', () => {
  it('人把拼车排在前面：就先用拼车', () => {
    expect(order([route('carpool', { poolName: '拼车号' }), route('solo')])).toEqual(['carpool', 'solo']);
  });

  it('拼车周额度快清零、还剩很多：照快清零那条提到前面', () => {
    const c = route('carpool', {
      windows: [win({ label: '5h', window: '5h', used: 0.1 }), win({ used: 0.3, resetsAt: at(20) })],
    });
    expect(order([route('solo'), c])).toEqual(['carpool', 'solo']);
  });
});

describe('微调只在同一个模型的几个渠道之间生效，模型之间严格按用途里排的先后（#1089）', () => {
  const A = { modelId: 'model-a' };
  const B = { modelId: 'model-b' };

  it('第一个模型的渠道额度未知：第二个模型的渠道也不排到它前面', () => {
    expect(
      order([
        route('a1', { ...A, quota: 'unknown' }),
        route('a2', { ...A, quota: 'unknown' }),
        route('b1', B),
        route('b2', B),
      ]),
    ).toEqual(['a1', 'a2', 'b1', 'b2']);
  });

  it('第一个模型的渠道战绩差：第二个模型的渠道也不排到它前面', () => {
    const bad = { record: { samples: 10, successes: 0 } };
    expect(
      order([route('a1', { ...A, ...bad }), route('a2', { ...A, ...bad }), route('b1', B), route('b2', B)]),
    ).toEqual(['a1', 'a2', 'b1', 'b2']);
  });

  it('第二个模型的渠道周额度快清零：也不提到第一个模型前面', () => {
    expect(
      order([route('a1', A), route('a2', A), weekly('b1', 20, 0.3, B), weekly('b2', 5, 0.3, B)]),
    ).toEqual(['a1', 'a2', 'b2', 'b1']);
  });

  it('同一个模型内三条微调照旧生效，且各模型各排各的', () => {
    const bad = { record: { samples: 10, successes: 0 } };
    expect(
      order([
        route('a1', { ...A, quota: 'unknown' }),
        route('a2', { ...A, ...bad }),
        weekly('a3', 20, 0.3, A),
        route('a4', A),
        route('b1', { ...B, quota: 'unknown' }),
        route('b2', B),
      ]),
    ).toEqual(['a3', 'a4', 'a2', 'a1', 'b2', 'b1']);
  });

  it('钉住的在模型内留在原位，没钉住的只在本模型其余位置里重排', () => {
    expect(
      order(
        [route('a1', A), route('a2', { ...A, quota: 'unknown' }), route('a3', A), route('b1', B)],
        ['a1'],
      ),
    ).toEqual(['a1', 'a3', 'a2', 'b1']);
  });
});

describe('钉住的不参与任何微调', () => {
  it('钉住的战绩差也不往后放', () => {
    const bad = route('a', { record: { samples: 20, successes: 2 } });
    expect(order([bad, route('b')], ['a'])).toEqual(['a', 'b']);
  });

  it('钉住的额度未知也不挪', () => {
    expect(order([route('a', { quota: 'unknown' }), route('b')], ['a'])).toEqual(['a', 'b']);
  });

  it('钉住的快清零也不提；没钉住的也跳不过钉住的位置', () => {
    expect(order([route('a'), weekly('b', 20, 0.3)], ['b'])).toEqual(['a', 'b']);
    expect(order([route('a'), weekly('b', 20, 0.3)], ['a'])).toEqual(['a', 'b']);
  });

  it('钉住的留在原位，没钉住的在其余位置里重排', () => {
    const bad = route('b', { record: { samples: 10, successes: 0 } });
    expect(order([bad, route('p'), route('c')], ['p'])).toEqual(['c', 'p', 'b']);
  });

  it('整个阶段钉住：一律不动', () => {
    expect(order([route('a', { quota: 'unknown' }), weekly('b', 20, 0.3)], [], true)).toEqual(['a', 'b']);
  });
});
