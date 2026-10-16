// 模型强弱档（决定 0099）：重活先给强档、强档池超前 30% 以上让位、强档全被挡照旧往下派、中档不受影响、
// 按单号探索样本少的强档模型（可复现、比例按配置）、同档相邻的模型按池子消耗进度分流。
import type { ModelStrength } from '@fleet-dao/shared';
import { describe, expect, it } from 'vitest';
import {
  type ChooseRouteInput,
  chooseRoute,
  type ModelTierTrackFacts,
  type RouteFacts,
  resolveRoutingPolicy,
} from '../../src/routing/index.ts';
import { seedDraw } from '../../src/routing/rank.ts';
import { at, input, route, win } from './helpers.ts';

// 7 天窗还有 72 小时清零：按时间该用 1 − 72/168 ≈ 57%
const ELAPSED = 1 - 72 / 168;
const weekly = (used: number) => [
  win({ label: '5h', window: '5h', used: 0.2, resetsAt: at(3) }),
  win({ used, resetsAt: at(72) }),
];

// Mirasim 的 30 天窗（法国 10-16 16:34 的读数）：还剩 598 小时、用了 67.6%，按时间该用约 17%，超前约 51%
const MIRASIM_51 = [win({ label: '30d', window: 'other', used: 0.676, resetsAt: at(598) })];

const STRENGTH: Record<string, ModelStrength> = {
  'grok-4.7': 'standard',
  'cursor-auto': 'light',
  'sonnet-5.5': 'strong',
  'opus-5.5': 'strong',
};
/** 动手用途在法国的人排先后（节选）：grok 第一，强档排在后面。 */
const MODELS = ['grok-4.7', 'cursor-auto', 'sonnet-5.5', 'opus-5.5'];

const routesOf = (over: Record<string, Partial<RouteFacts>> = {}, strength = true) =>
  MODELS.map((m) =>
    route(m, {
      modelId: m,
      modelName: m,
      poolName: `池${m}`,
      ...(strength ? { strength: STRENGTH[m] } : {}),
      ...over[m],
    }),
  );

const row = (modelId: string, firstSegs: number, onePass: number): ModelTierTrackFacts => ({
  modelId,
  tier: 'heavyweight',
  firstSegs,
  onePass,
  sentBack: firstSegs - onePass,
  noDeliver: 0,
  notDone: 0,
  minutes: firstSegs * 40,
});

/** 法国库近 14 天主力档：grok 127 单一段过 24，强档只有三四单。 */
const HEAVY: ModelTierTrackFacts[] = [
  row('grok-4.7', 127, 24),
  row('cursor-auto', 7, 0),
  row('opus-5.5', 4, 2),
  row('sonnet-5.5', 3, 0),
];

const heavy = (routes: RouteFacts[], over: Partial<ChooseRouteInput> = {}) =>
  input(routes, { tier: 'heavyweight', modelTierTracks: HEAVY, ...over });

const dispatched = (r: ReturnType<typeof chooseRoute>) => {
  if (r.kind !== 'dispatch') throw new Error(`没派出去：${r.kind}：${'reason' in r ? r.reason : ''}`);
  return r;
};
const order = (r: ReturnType<typeof chooseRoute>) => r.verdicts.map((v) => v.routeId);

describe('重活先给强档', () => {
  it('主力档：强档的模型整体排在 grok 前面，理由写「重活先给强档」', () => {
    const r = dispatched(chooseRoute(heavy(routesOf())));
    expect(['opus-5.5', 'sonnet-5.5']).toContain(r.modelId);
    const ranked = order(r);
    expect(ranked.slice(0, 2).sort()).toEqual(['opus-5.5', 'sonnet-5.5']);
    expect(ranked.slice(2)).toEqual(['grok-4.7', 'cursor-auto']);
    expect(r.why).toContain(`重活先给强档：${r.modelId}`);
    // 档内仍按 #2403 的质量下界：opus 4 单过 2 比 sonnet 3 单过 0 高一截
    expect(ranked[0]).toBe('opus-5.5');
    // grok 人排在它前面：被挪到了强档后面，又够不上主力档动手的能力下限（#2725），理由写的是下限
    const grok = r.verdicts.find((v) => v.routeId === 'grok-4.7');
    expect(grok?.nudges.map((n) => n.text).join('\n')).toContain('标准档排在强档后面');
    expect(r.why).toContain('够不上能力下限');
  });

  it('强档都超前 35%：不让给标准档，仍派强档，理由写「强档都超前，照派」（#2724）', () => {
    const ahead = { windows: weekly(ELAPSED + 0.35) };
    const r = dispatched(chooseRoute(heavy(routesOf({ 'opus-5.5': ahead, 'sonnet-5.5': ahead }))));
    expect(['opus-5.5', 'sonnet-5.5']).toContain(r.modelId);
    expect(order(r).slice(0, 2).sort()).toEqual(['opus-5.5', 'sonnet-5.5']);
    expect(order(r).slice(2)).toEqual(['grok-4.7', 'cursor-auto']);
    expect(r.why).toContain('强档都超前，照派');
    expect(r.why).toContain('超前 35%');
    expect(r.why).not.toContain('让给标准档');
  });

  it('只有一个强档模型超前：它让给另一个强档，自己仍排在标准档前面（#2724）', () => {
    const r = dispatched(chooseRoute(heavy(routesOf({ 'opus-5.5': { windows: weekly(ELAPSED + 0.35) } }))));
    expect(r.modelId).toBe('sonnet-5.5');
    expect(order(r)).toEqual(['sonnet-5.5', 'opus-5.5', 'grok-4.7', 'cursor-auto']);
    const opus = r.verdicts.find((v) => v.routeId === 'opus-5.5');
    expect(opus?.nudges.map((n) => n.text).join('\n')).toContain('强档池超前 35%');
    expect(opus?.nudges.map((n) => n.text).join('\n')).toContain('让给强档 sonnet-5.5');
  });

  it('能派的路由超前 51%、同模型另一条被人关掉的路由持平：仍让位（#2724）', () => {
    // 法国 10-16：opus 唯一能派的 Mirasim 池超前约 51%，claude-solo 那条人关掉了、只超前 2%
    const routes = [
      ...routesOf({ 'opus-5.5': { poolName: 'Mirasim', windows: MIRASIM_51 } }),
      route('opus-solo', {
        modelId: 'opus-5.5',
        modelName: 'opus-5.5',
        poolName: 'solo',
        strength: 'strong',
        windows: weekly(ELAPSED + 0.02),
        blockers: ['switched-off'],
      }),
    ];
    const base = heavy(routes);
    const r = dispatched(
      chooseRoute({
        ...base,
        order: base.order.map((e) => (e.routeId === 'opus-solo' ? { ...e, enabled: false } : e)),
      }),
    );
    expect(r.modelId).toBe('sonnet-5.5');
    const opus = r.verdicts.find((v) => v.routeId === 'opus-5.5');
    expect(opus?.nudges.map((n) => n.kind)).toContain('strength-yield');
    expect(opus?.nudges.map((n) => n.text).join('\n')).toContain('Mirasim');
    expect(opus?.nudges.map((n) => n.text).join('\n')).toContain('超前 51%');
  });

  it('同上但强档只有 opus 一个：强档都超前，照派 opus，不让给标准档 grok（#2724）', () => {
    const routes = [
      route('grok-4.7', { modelId: 'grok-4.7', strength: 'standard', windows: weekly(ELAPSED + 0.19) }),
      route('opus-mirasim', {
        modelId: 'opus-5.5',
        strength: 'strong',
        poolName: 'Mirasim',
        windows: MIRASIM_51,
      }),
      route('opus-solo', {
        modelId: 'opus-5.5',
        strength: 'strong',
        windows: weekly(ELAPSED + 0.02),
        blockers: ['switched-off'],
      }),
    ];
    const base = heavy(routes, { modelTierTracks: [] });
    const r = dispatched(
      chooseRoute({
        ...base,
        order: base.order.map((e) => (e.routeId === 'opus-solo' ? { ...e, enabled: false } : e)),
      }),
    );
    expect(r.routeId).toBe('opus-mirasim');
    expect(r.why).toContain('强档都超前，照派');
    expect(r.why).toContain('超前 51%');
  });

  it('超前不到 30%（25%）不让位', () => {
    const ahead = { windows: weekly(ELAPSED + 0.25) };
    const r = dispatched(chooseRoute(heavy(routesOf({ 'opus-5.5': ahead, 'sonnet-5.5': ahead }))));
    expect(['opus-5.5', 'sonnet-5.5']).toContain(r.modelId);
  });

  it('强档全被挡、2 小时内好不了（一个额度用满、一个熔断 3 小时后到点）：下限降一档，往下派 grok（#2725）', () => {
    const r = dispatched(
      chooseRoute(
        heavy(
          routesOf({
            'opus-5.5': { quota: 'exhausted', blockers: ['quota-exhausted'] },
            'sonnet-5.5': {
              breaker: { state: 'open', admit: 'none', reason: '连败 3 次', probeAt: at(3) },
            },
          }),
        ),
      ),
    );
    expect(r.modelId).toBe('grok-4.7');
    expect(order(r).slice(0, 2).sort()).toEqual(['opus-5.5', 'sonnet-5.5']);
    expect(r.why).toContain('降一档到标准档');
  });

  it('强档一个额度用满、一个熔断 1 小时后到点：等强档，不降档（#2725）', () => {
    const r = chooseRoute(
      heavy(
        routesOf({
          'opus-5.5': { quota: 'exhausted', blockers: ['quota-exhausted'] },
          'sonnet-5.5': {
            breaker: { state: 'open', admit: 'none', reason: '连败 3 次', probeAt: at(1) },
          },
        }),
      ),
    );
    expect(r.kind).toBe('wait');
  });

  it('强档被人关掉（开关关着）：照旧往下派 grok', () => {
    const routes = routesOf();
    const base = heavy(routes);
    const r = dispatched(
      chooseRoute({
        ...base,
        order: base.order.map((e) =>
          e.routeId === 'opus-5.5' || e.routeId === 'sonnet-5.5' ? { ...e, enabled: false } : e,
        ),
      }),
    );
    expect(r.modelId).toBe('grok-4.7');
  });

  it('中档、快档不受影响：模型顺序照人排', () => {
    for (const tier of ['medium', 'fast'] as const) {
      const r = dispatched(chooseRoute(input(routesOf(), { tier, modelTierTracks: [] })));
      expect(r.modelId).toBe('grok-4.7');
      expect(order(r)).toEqual(MODELS);
      expect(r.why).not.toContain('先给强档');
    }
  });

  it('没标档：主力档不先给强档；没标档的都够不上能力下限，派不出（#2725 收尾）', () => {
    const r = chooseRoute(heavy(routesOf({}, false)));
    expect(r.kind).toBe('none');
    expect(r.kind === 'none' && r.reason).not.toContain('先给强档');
    expect(r.kind === 'none' && r.reason).toContain('没标强弱档，够不上能力下限');
    expect(r.verdicts.flatMap((v) => v.nudges.map((n) => n.kind))).not.toContain('strength-first');
  });

  it('不在动手的用途（验收）给了档也不先给强档；grok 是被验收的能力下限挡掉的（#2725）', () => {
    const r = dispatched(chooseRoute(heavy(routesOf(), { stage: 'verify' })));
    expect(r.modelId).toBe('sonnet-5.5');
    expect(r.why).not.toContain('先给强档');
    expect(r.why).toContain('够不上能力下限');
    // 快档的验收不设下限：照人排的派 grok
    expect(dispatched(chooseRoute(heavy(routesOf(), { stage: 'verify', tier: 'fast' }))).modelId).toBe(
      'grok-4.7',
    );
  });

  it('policy 把 strongFirstTiers 置空就关掉', () => {
    const r = dispatched(chooseRoute(heavy(routesOf(), { policy: { strength: { strongFirstTiers: [] } } })));
    expect(r.why).not.toContain('先给强档');
  });
});

describe('探索', () => {
  const seeds = (n: number) => Array.from({ length: n }, (_, i) => `task-${i}`);
  const explored = (r: ReturnType<typeof chooseRoute>) =>
    r.kind === 'dispatch' && r.verdicts[0]?.nudges.some((n) => n.kind === 'explore') === true;

  it('同一张单（同一个种子）重算结果不变', () => {
    for (const seed of seeds(50)) {
      const a = chooseRoute(heavy(routesOf(), { exploreSeed: seed }));
      const b = chooseRoute(heavy(routesOf(), { exploreSeed: seed }));
      expect(a).toEqual(b);
    }
    expect(seedDraw('task-7')).toBe(seedDraw('task-7'));
    expect(seedDraw('task-7')).not.toBe(seedDraw('task-8'));
  });

  it('比例按配置：主力档约 20%、中档约 10%、快档约 5%', () => {
    const n = 2000;
    const rate = (tier: 'heavyweight' | 'medium' | 'fast') =>
      seeds(n).filter((seed) =>
        explored(
          chooseRoute(
            input(routesOf(), {
              tier,
              modelTierTracks: tier === 'heavyweight' ? HEAVY : [],
              exploreSeed: seed,
            }),
          ),
        ),
      ).length / n;
    expect(rate('heavyweight')).toBeGreaterThan(0.17);
    expect(rate('heavyweight')).toBeLessThan(0.23);
    expect(rate('medium')).toBeGreaterThan(0.08);
    expect(rate('medium')).toBeLessThan(0.12);
    expect(rate('fast')).toBeGreaterThan(0.035);
    expect(rate('fast')).toBeLessThan(0.065);
  });

  it('改配置就改比例；置 0 不探', () => {
    const n = 1000;
    const count = (ratio: number) =>
      seeds(n).filter((seed) =>
        explored(
          chooseRoute(
            input(routesOf(), {
              tier: 'medium',
              modelTierTracks: [],
              exploreSeed: seed,
              policy: { strength: { explore: { medium: ratio } } },
            }),
          ),
        ),
      ).length / n;
    expect(count(0.5)).toBeGreaterThan(0.45);
    expect(count(0.5)).toBeLessThan(0.55);
    expect(count(0)).toBe(0);
  });

  it('探到的是样本少于 minTasks 的强档模型，提到第一，理由写样本数', () => {
    const seed = seeds(500).find((s) => seedDraw(s) < 0.1) as string;
    const r = dispatched(
      chooseRoute(input(routesOf(), { tier: 'medium', modelTierTracks: [], exploreSeed: seed })),
    );
    expect(['opus-5.5', 'sonnet-5.5']).toContain(r.modelId);
    expect(r.why).toMatch(/探索：(opus|sonnet)-5\.5 中档活样本 0 单，少于 5/);
  });

  it('主力档：探到的强档样本数照分档战绩写（opus 4 单）', () => {
    // 两个强档都不到 5 单，draw / 0.2 落在前一半探第一个（按先给强档之后的先后：opus、sonnet）
    const first = seeds(2000).find((s) => seedDraw(s) < 0.1) as string;
    const r = dispatched(chooseRoute(heavy(routesOf(), { exploreSeed: first })));
    expect(r.modelId).toBe('opus-5.5');
    expect(r.why).toContain('探索：opus-5.5 重活样本 4 单，少于 5');
  });

  it('强档样本都够了、没有种子、战绩没读成：不探', () => {
    const seed = seeds(500).find((s) => seedDraw(s) < 0.05) as string;
    const enough = [row('grok-4.7', 127, 24), row('opus-5.5', 9, 5), row('sonnet-5.5', 8, 3)];
    const kinds = (r: ReturnType<typeof chooseRoute>) =>
      r.verdicts.flatMap((v) => v.nudges.map((n) => n.kind));
    expect(
      kinds(chooseRoute(heavy(routesOf(), { exploreSeed: seed, modelTierTracks: enough }))),
    ).not.toContain('explore');
    expect(kinds(chooseRoute(heavy(routesOf())))).not.toContain('explore');
    expect(kinds(chooseRoute(input(routesOf(), { tier: 'heavyweight', exploreSeed: seed })))).not.toContain(
      'explore',
    );
  });

  it('探到的强档被挡：照旧派能派的', () => {
    const seed = seeds(500).find((s) => seedDraw(s) < 0.1) as string;
    const r = dispatched(
      chooseRoute(
        input(
          routesOf({
            'opus-5.5': { quota: 'exhausted', blockers: ['quota-exhausted'] },
            'sonnet-5.5': { quota: 'exhausted', blockers: ['quota-exhausted'] },
          }),
          { tier: 'medium', modelTierTracks: [], exploreSeed: seed },
        ),
      ),
    );
    expect(r.modelId).toBe('grok-4.7');
  });
});

describe('同档分流', () => {
  // 两个同档模型 A（opus，池超前 30%）、B（sonnet，池落后 40%），人排 A 在前
  const pair = (strength: boolean) => [
    route('a', {
      modelId: 'opus-5.5',
      modelName: 'Opus 5.5',
      poolName: '池A',
      windows: weekly(ELAPSED + 0.3),
      ...(strength ? { strength: 'strong' as const } : {}),
    }),
    route('a2', {
      modelId: 'opus-5.5',
      modelName: 'Opus 5.5',
      poolName: '池A2',
      windows: weekly(ELAPSED + 0.3),
      ...(strength ? { strength: 'strong' as const } : {}),
    }),
    route('b', {
      modelId: 'sonnet-5.5',
      modelName: 'Sonnet 5.5',
      poolName: '池B',
      windows: weekly(ELAPSED - 0.4),
      ...(strength ? { strength: 'strong' as const } : {}),
    }),
  ];

  it('同档相邻：B 的渠道排在 A 的前面，理由写「与 opus-5.5 同档，opus-5.5 的池超前 30%，先用这条」', () => {
    const r = dispatched(chooseRoute(input(pair(true), { stage: 'verify' })));
    expect(r.routeId).toBe('b');
    expect(order(r)).toEqual(['b', 'a', 'a2']);
    expect(r.why).toContain('与 opus-5.5 同档（强档），opus-5.5 的池超前 30%，先用这条');
  });

  it('不标档：顺序不变（模型之间照人排）', () => {
    const r = dispatched(chooseRoute(input(pair(false), { stage: 'verify' })));
    expect(r.routeId).toBe('a');
    expect(order(r)).toEqual(['a', 'a2', 'b']);
  });

  it('不同档之间不分流', () => {
    const routes = pair(true).map((x) =>
      x.modelId === 'sonnet-5.5' ? { ...x, strength: 'standard' as const } : x,
    );
    const r = dispatched(chooseRoute(input(routes, { stage: 'verify' })));
    expect(r.routeId).toBe('a');
  });

  it('同档但不相邻（中间隔着别的档）：不分流', () => {
    const [a, a2, b] = pair(true) as [RouteFacts, RouteFacts, RouteFacts];
    const mid = route('m', { modelId: 'grok-4.7', modelName: 'Grok 4.7', strength: 'standard' });
    const r = dispatched(chooseRoute(input([a, a2, mid, b], { stage: 'verify' })));
    expect(r.routeId).toBe('a');
    expect(order(r)).toEqual(['a', 'a2', 'm', 'b']);
  });

  it('进度都在线内：照模型先后', () => {
    const routes = pair(true).map((x) => ({ ...x, windows: weekly(ELAPSED) }));
    const r = dispatched(chooseRoute(input(routes, { stage: 'verify' })));
    expect(order(r)).toEqual(['a', 'a2', 'b']);
  });

  it('policy.strength.pool 关掉：顺序不变', () => {
    const r = dispatched(
      chooseRoute(input(pair(true), { stage: 'verify', policy: { strength: { pool: false } } })),
    );
    expect(order(r)).toEqual(['a', 'a2', 'b']);
  });
});

describe('输入和策略', () => {
  it('强弱档认不出、同一个模型给了两样：报输入错', () => {
    const bad = routesOf({ 'opus-5.5': { strength: 'mighty' as ModelStrength } });
    expect(() => chooseRoute(heavy(bad))).toThrow(/强弱档认不出/);
    const twice = [
      route('x1', { modelId: 'opus-5.5', strength: 'strong' }),
      route('x2', { modelId: 'opus-5.5', strength: 'light' }),
    ];
    expect(() => chooseRoute(input(twice))).toThrow(/强弱档不一样/);
  });

  it('策略越界报错，只给几项时其余取默认', () => {
    expect(() => resolveRoutingPolicy({ strength: { yieldAhead: 0 } })).toThrow(/strength.yieldAhead/);
    expect(() => resolveRoutingPolicy({ strength: { explore: { heavyweight: 1.5 } } })).toThrow(
      /strength.explore.heavyweight/,
    );
    expect(() => resolveRoutingPolicy({ strength: { strongFirstTiers: ['huge' as 'fast'] } })).toThrow(
      /strongFirstTiers/,
    );
    const p = resolveRoutingPolicy({ strength: { explore: { fast: 0 } } });
    expect(p.strength.explore).toEqual({ heavyweight: 0.2, medium: 0.1, fast: 0 });
    expect(p.strength.yieldAhead).toBe(0.3);
  });
});
