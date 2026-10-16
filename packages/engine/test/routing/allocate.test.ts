// 按池压力加权抽签（决定 0104，#2757）：能力下限硬过滤 → 按 ρ 加权抽签 → 质量作乘数。权重 = q × min(ρ, 4)²。
import { describe, expect, it } from 'vitest';
import { allocateWeights, routeRho, weightedPick } from '../../src/routing/allocate.ts';
import {
  type ChooseRouteInput,
  chooseRoute,
  type RouteFacts,
  resolveRoutingPolicy,
} from '../../src/routing/index.ts';
import { at, input, NOW, route, win } from './helpers.ts';

const NOW_MS = Date.parse(NOW);
const WEEK_H = 168;

/** 一个 7 天窗，ρ = 剩余比例 ÷ 剩余时间比例：剩余时间比例 timeLeft，按 rho 反推用了多少。 */
function rhoWindows(rho: number, timeLeft = 0.1) {
  return [
    win({ label: '5h', window: '5h', used: 0.2, resetsAt: at(3) }),
    win({ used: 1 - rho * timeLeft, resetsAt: at(timeLeft * WEEK_H) }),
  ];
}

const weighted = (routes: RouteFacts[], over: Partial<ChooseRouteInput> = {}) =>
  chooseRoute(input(routes, { ...over, policy: { ...over.policy, allocate: { mode: 'weighted' } } }));

const dispatched = (r: ReturnType<typeof chooseRoute>) => {
  if (r.kind !== 'dispatch') throw new Error(`没派出去：${r.kind}：${'reason' in r ? r.reason : ''}`);
  return r;
};

const al = resolveRoutingPolicy({}).allocate;

describe('ρ 怎么算', () => {
  it('取 5 小时窗以外最紧的窗口；读不到按中性 1', () => {
    expect(routeRho(route('a', { windows: rhoWindows(6.7) }), al, NOW_MS).rho).toBeCloseTo(6.7, 6);
    const unknown = routeRho(route('b', { quota: 'unknown', windows: [] }), al, NOW_MS);
    expect(unknown).toEqual({ rho: 1, from: 'neutral' });
    const stale = routeRho(route('c', { windows: [win({ staleSince: at(-2) })] }), al, NOW_MS);
    expect(stale.from).toBe('neutral');
  });

  it('默认是加权抽签，legacy 可切回', () => {
    expect(al).toEqual({ mode: 'weighted', rhoCap: 4, neutralRho: 1, minQuality: 0.05 });
    expect(resolveRoutingPolicy({ allocate: { mode: 'legacy' } }).allocate.mode).toBe('legacy');
    expect(() => resolveRoutingPolicy({ allocate: { mode: 'x' as never } })).toThrow();
  });
});

describe('能力下限照样硬挡', () => {
  it('轻档池 ρ=10（额度多到要作废）也不接主力档动手', () => {
    const routes = [
      route('flash', {
        modelId: 'deepseek-flash',
        modelName: 'deepseek-flash',
        family: 'deepseek',
        strength: 'light',
        windows: rhoWindows(10, 0.05),
      }),
      route('opus', { strength: 'strong', windows: rhoWindows(0.6, 0.5) }),
    ];
    for (let i = 0; i < 50; i += 1) {
      const r = dispatched(weighted(routes, { tier: 'heavyweight', allocateSeed: `T${i}:execute:1` }));
      expect(r.routeId).toBe('opus');
    }
  });
});

describe('按权重抽签', () => {
  /** 1000 个种子抽下来，各池份额和权重之比差不到 5%。 */
  function shareOfA(rhoA: number, rhoB: number) {
    const routes = [
      route('a', { strength: 'strong', windows: rhoWindows(rhoA) }),
      route('b', { strength: 'strong', windows: rhoWindows(rhoB, 0.5) }),
    ];
    let a = 0;
    for (let i = 0; i < 1000; i += 1) {
      const r = dispatched(weighted(routes, { allocateSeed: `T${i}:execute:1` }));
      if (r.routeId === 'a') a += 1;
    }
    return a / 1000;
  }

  it('两池 ρ 6.7 与 0.39：份额按 min(ρ,4)² 之比（16 : 0.1521），差不到 5%', () => {
    const wa = 16;
    const wb = 0.39 * 0.39;
    expect(Math.abs(shareOfA(6.7, 0.39) - wa / (wa + wb))).toBeLessThan(0.05);
  });

  it('两池 ρ 2 与 1：份额 4 : 1，差不到 5%（低压力的池也分得到）', () => {
    const share = shareOfA(2, 1);
    expect(Math.abs(share - 0.8)).toBeLessThan(0.05);
    expect(share).toBeLessThan(1);
  });

  it('同一单同一段同一次选，抽到的不变', () => {
    const routes = [route('a', { windows: rhoWindows(2) }), route('b', { windows: rhoWindows(1.5, 0.5) })];
    const first = dispatched(weighted(routes, { allocateSeed: 'T7:execute:1' })).routeId;
    for (let i = 0; i < 5; i += 1) {
      expect(dispatched(weighted(routes, { allocateSeed: 'T7:execute:1' })).routeId).toBe(first);
    }
  });

  it('读不到额度的池按中性 ρ=1，不排最后：权重高过 ρ<1 的池', () => {
    const routes = [
      route('low', { windows: rhoWindows(0.5, 0.5) }),
      route('unknown', { quota: 'unknown', windows: [] }),
    ];
    const w = allocateWeights(routes, undefined, undefined, al, NOW_MS);
    expect(w[0]?.weight).toBeCloseTo(0.25, 6);
    expect(w[1]?.weight).toBe(1);
    // 没有抽签的数时取权重最大的：读不到的池压过 ρ 0.5 的池（legacy 会把它排到最后）
    expect(dispatched(weighted(routes)).routeId).toBe('unknown');
    // 抽签时它分到的份额是 1 / 1.25
    let unknown = 0;
    for (let i = 0; i < 1000; i += 1) {
      if (dispatched(weighted(routes, { allocateSeed: `U${i}:execute:1` })).routeId === 'unknown')
        unknown += 1;
    }
    expect(Math.abs(unknown / 1000 - 0.8)).toBeLessThan(0.05);
  });

  it('中档单不进 ρ<1 的强档池，人排第一、抽签落在它那段也不派', () => {
    const routes = [
      route('opus', { strength: 'strong', windows: rhoWindows(0.5, 0.5) }),
      route('grok', {
        modelId: 'grok-4.7',
        modelName: 'grok-4.7',
        family: 'grok',
        hostId: 'grok',
        strength: 'standard',
        windows: rhoWindows(0.5, 0.5),
      }),
    ];
    const r = dispatched(weighted(routes, { tier: 'medium', draw: 0 }));
    expect(r.routeId).toBe('grok');
    expect(r.why).toContain('中档单不进 ρ<1 的强档池（ρ 0.50，留给主力档）');
    // 强档池 ρ ≥ 1 时中档单照常能进
    const roomy = routes.map((x) => (x.routeId === 'opus' ? { ...x, windows: rhoWindows(3) } : x));
    expect(dispatched(weighted(roomy, { tier: 'medium', draw: 0 })).routeId).toBe('opus');
  });

  it('理由列出每个候选的权重和抽到的数', () => {
    const routes = [
      route('a', { poolName: '甲池', windows: rhoWindows(6.7) }),
      route('b', { poolName: '乙池', windows: rhoWindows(0.39, 0.5) }),
      route('c', { poolName: '丙池', quota: 'unknown', windows: [] }),
    ];
    const r = dispatched(weighted(routes, { draw: 0.5 }));
    expect(r.why).toContain('按池压力加权抽签');
    expect(r.why).toContain('候选权重 = q × min(ρ, 4)²');
    expect(r.why).toContain('16.00（q 1 × min(ρ 6.70, 4)²）');
    expect(r.why).toContain('0.15（q 1 × min(ρ 0.39, 4)²）');
    expect(r.why).toContain('1.00（q 1 × min(ρ 读不到按 1, 4)²）');
    expect(r.why).toContain('抽到 0.500');
  });

  it('权重全一样照人排的先后，不抽', () => {
    const routes = [route('a'), route('b')];
    expect(weightedPick(allocateWeights(routes, undefined, undefined, al, NOW_MS), 0.99)).toBe(0);
  });

  it('legacy：照旧的排法，额度未知排在读到了的后面', () => {
    const routes = [
      route('unknown', { quota: 'unknown', windows: [] }),
      route('low', { windows: rhoWindows(0.5, 0.5) }),
    ];
    expect(dispatched(chooseRoute(input(routes))).routeId).toBe('low');
  });
});
