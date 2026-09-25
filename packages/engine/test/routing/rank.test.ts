// 排序与微调：按人排的顺序；钉住的不动；快清零提前、战绩差后置、额度未知排后、备池排在主池后。
import { describe, expect, it } from 'vitest';
import {
  DEFAULT_ROUTING_POLICY,
  fastResetHit,
  poorRecord,
  type RouteFacts,
} from '../../src/routing/index.ts';
import { rank } from '../../src/routing/rank.ts';
import { at, entry, NOW, route, win } from './helpers.ts';

const P = { ...DEFAULT_ROUTING_POLICY };
const T = Date.parse(NOW);

function order(routes: RouteFacts[], pinned: string[] = [], stagePinned = false): string[] {
  const rows = routes.map((r, i) => ({
    route: r,
    entry: entry(r.routeId, i, { pinned: pinned.includes(r.routeId) }),
  }));
  return rank(rows, stagePinned, P, T).map((x) => x.route.routeId);
}

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

describe('① 快清零还没用完的往前提', () => {
  it('周窗 20 小时后清零、还剩 70%：提到最前', () => {
    expect(order([route('a'), weekly('b', 20, 0.3)])).toEqual(['b', 'a']);
  });

  it('周窗 30 小时后才清零：不提（不够「快」）', () => {
    expect(order([route('a'), weekly('b', 30, 0.3)])).toEqual(['a', 'b']);
  });

  it('快清零但只剩 20%：不提（剩得不多，自然会用完）', () => {
    expect(order([route('a'), weekly('b', 20, 0.8)])).toEqual(['a', 'b']);
  });

  it('不会把快用满的池顶到最前：周窗快清零、剩很多，但 5 小时窗已用 90%', () => {
    const almostFull = route('b', {
      windows: [
        win({ label: '5h', window: '5h', used: 0.9, resetsAt: at(2) }),
        win({ used: 0.3, resetsAt: at(20) }),
      ],
    });
    expect(fastResetHit(almostFull, P, T)).toBeNull();
    expect(order([route('a'), almostFull])).toEqual(['a', 'b']);
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
    expect(order([route('a'), weekly('b', 20, 0.3), weekly('c', 5, 0.3)])).toEqual(['c', 'b', 'a']);
  });

  it('读数是估算的照样提，理由里写「估算」', () => {
    const r = route('b', {
      windows: [
        win({ label: '5h', window: '5h', used: 0.1 }),
        win({ used: 0.3, resetsAt: at(20), reading: 'estimated' }),
      ],
    });
    const rows = [route('a'), r].map((x, i) => ({ route: x, entry: entry(x.routeId, i) }));
    const b = rank(rows, false, P, T)[0];
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

describe('④ 独享号是主池，拼车号是备池', () => {
  const backup = (id: string, extra: Partial<RouteFacts> = {}) => route(id, { poolRole: 'backup', ...extra });

  it('人把拼车排在前面：主池还是先用', () => {
    expect(order([backup('carpool'), route('solo')])).toEqual(['solo', 'carpool']);
  });

  it('拼车周额度快清零、还剩很多：提到主池前面（赶在清零前用掉）', () => {
    const c = backup('carpool', {
      windows: [win({ label: '5h', window: '5h', used: 0.1 }), win({ used: 0.3, resetsAt: at(20) })],
    });
    expect(order([route('solo'), c])).toEqual(['carpool', 'solo']);
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
